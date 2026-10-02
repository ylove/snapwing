// `pnpm slack:test-users <reporter|engineer>` (main 14.4, 15.1): stores a Slack user token for one e2e test user.
//   pnpm slack:test-users reporter|engineer   user OAuth against the "Snapwing Test Driver" app, writes .env.live
//   pnpm slack:test-users --check             verifies both stored tokens, changes nothing
//   pnpm slack:test-users secrets             copies the test-user values into repository secrets with `gh`
// Reads SLACK_TEST_DRIVER_CLIENT_ID / SLACK_TEST_DRIVER_CLIENT_SECRET / SLACK_TEST_CHANNEL from .env.live (then the
// process environment). Never prints a token or the client secret. Slack is only ever called through `deps.fetch`.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upsertEnv } from './github-bootstrap.ts';
import { parseEnvFile } from './slack-bootstrap.ts';

export const ENV_FILE = '.env.live';
export const DEFAULT_PORT = 53682;
export const DEFAULT_SNAPWING_REPO = 'ylove/snapwing';
export const USER_SCOPES = ['chat:write', 'reactions:write', 'files:write', 'channels:history', 'channels:read'] as const;
export const ROLES = ['reporter', 'engineer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_KEYS: Readonly<Record<Role, { token: string; id: string }>> = {
  reporter: { token: 'SLACK_TEST_REPORTER_TOKEN', id: 'SLACK_TEST_REPORTER_ID' },
  engineer: { token: 'SLACK_TEST_ENGINEER_TOKEN', id: 'SLACK_TEST_ENGINEER_ID' },
};
/** Values `secrets` copies to repository secrets (same names). The driver client id and secret stay local. */
export const SECRET_NAMES: readonly string[] = [
  'SLACK_TEST_CHANNEL',
  ROLE_KEYS.reporter.token,
  ROLE_KEYS.reporter.id,
  ROLE_KEYS.engineer.token,
  ROLE_KEYS.engineer.id,
];

export const USAGE = 'usage: pnpm slack:test-users <reporter|engineer> [--port N] [--no-open] | --check | secrets [--repo owner/name]';

export interface Deps {
  fetch: typeof fetch;
  gh(args: readonly string[], input?: string): Promise<string>;
  /** Directory holding `.env.live`. */
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  log(line: string): void;
  openUrl(url: string): void;
  /** Default `https://slack.com/api`. */
  apiBase?: string;
  /** Default `https://slack.com/oauth/v2/authorize`. */
  authorizeUrl?: string;
}

export interface StoreOptions {
  port?: number;
  timeoutMs?: number;
}

const apiBase = (d: Deps): string => (d.apiBase ?? 'https://slack.com/api').replace(/\/+$/, '');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Remove anything token-shaped, and the known secret values, from text bound for output. */
function scrub(s: string, secrets: readonly (string | undefined)[]): string {
  let out = s.replace(/\s+/g, ' ').trim().replace(/xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, '[token]');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[token]');
  return out;
}

async function readEnvFile(d: Deps): Promise<string> {
  try {
    return await readFile(join(d.root, ENV_FILE), 'utf8');
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

async function mergedEnv(d: Deps): Promise<Record<string, string | undefined>> {
  return { ...d.env, ...parseEnvFile(await readEnvFile(d)) };
}

function need(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') throw new Error(`${key} is not set in ${ENV_FILE}`);
  return v;
}

async function slack(d: Deps, method: string, form: Record<string, string>, token?: string): Promise<Record<string, unknown>> {
  const res = await d.fetch(`${apiBase(d)}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`${method} returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error(`${method} returned an unexpected body`);
  if (body['ok'] !== true) throw new Error(`${method} failed: ${typeof body['error'] === 'string' ? body['error'] : 'unknown'}`);
  return body;
}

interface Identity {
  userId: string;
  teamId: string;
  user: string;
}

async function whoAmI(d: Deps, token: string): Promise<Identity> {
  const body = await slack(d, 'auth.test', {}, token);
  const userId = body['user_id'];
  const teamId = body['team_id'];
  if (typeof userId !== 'string' || typeof teamId !== 'string') throw new Error('auth.test returned no user_id or team_id');
  return { userId, teamId, user: typeof body['user'] === 'string' ? body['user'] : userId };
}

interface ChannelState {
  isMember: boolean;
  /** Undefined when Slack does not say which workspace the channel belongs to. */
  teams: string[] | undefined;
}

async function channelState(d: Deps, token: string, channel: string): Promise<ChannelState> {
  const body = await slack(d, 'conversations.info', { channel }, token);
  const ch = body['channel'];
  if (!isRecord(ch)) throw new Error('conversations.info returned no channel');
  const teams = new Set<string>();
  if (typeof ch['context_team_id'] === 'string') teams.add(ch['context_team_id']);
  if (Array.isArray(ch['shared_team_ids'])) for (const t of ch['shared_team_ids']) if (typeof t === 'string') teams.add(t);
  return { isMember: ch['is_member'] === true, teams: teams.size === 0 ? undefined : [...teams] };
}

function inWorkspace(state: ChannelState, teamId: string): boolean {
  return state.teams === undefined || state.teams.includes(teamId);
}

function otherRole(role: Role): Role {
  return role === 'reporter' ? 'engineer' : 'reporter';
}

// ---------------------------------------------------------------------------------------------------------------------
// store

export async function runStore(d: Deps, role: Role, options: StoreOptions = {}): Promise<{ role: Role; userId: string; inChannel: boolean }> {
  d.log(`Needs ${ENV_FILE} with SLACK_TEST_DRIVER_CLIENT_ID, SLACK_TEST_DRIVER_CLIENT_SECRET and SLACK_TEST_CHANNEL, and a browser signed in to Slack as the ${role}.`);
  const env = await mergedEnv(d);
  const clientId = need(env, 'SLACK_TEST_DRIVER_CLIENT_ID');
  const clientSecret = need(env, 'SLACK_TEST_DRIVER_CLIENT_SECRET');
  const channel = need(env, 'SLACK_TEST_CHANNEL');
  const secrets: string[] = [clientSecret];

  const state = randomBytes(16).toString('hex');
  let finish: (code: string) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let handled = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reply = (status: number, text: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Snapwing</title><p>${text}</p>`);
    };
    if (url.pathname !== '/callback' || req.method !== 'GET') return reply(404, 'Not found.');
    if (handled) return reply(409, 'Already handled.');
    if (url.searchParams.get('state') !== state) return reply(400, 'Bad state. Start again from the terminal.');
    handled = true;
    const code = url.searchParams.get('code') ?? '';
    if (url.searchParams.get('error') !== null || code === '') {
      reply(400, 'Slack did not authorize the app. See the terminal.');
      fail(new Error('Slack did not return a code (the Allow step was cancelled or denied)'));
      return;
    }
    reply(200, 'Authorized. Return to the terminal.');
    finish(code);
  });

  const port = options.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is in use; free it, or pass --port and add that redirect URL to the app`) : e),
    );
    server.listen(port, 'localhost', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local server has no port');
  const redirectUri = `http://localhost:${address.port}/callback`;
  const authorize = new URL(d.authorizeUrl ?? 'https://slack.com/oauth/v2/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('user_scope', USER_SCOPES.join(','));
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', state);

  const timer = setTimeout(() => fail(new Error('timed out waiting for Slack to redirect back')), options.timeoutMs ?? 5 * 60 * 1000);
  try {
    d.log(`Sign in as the ${role} and click Allow. Opening: ${authorize.toString()}`);
    d.openUrl(authorize.toString());
    const code = await done;
    const access = await slack(d, 'oauth.v2.access', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
    const authed = access['authed_user'];
    const token = isRecord(authed) ? authed['access_token'] : undefined;
    if (typeof token !== 'string' || token === '') throw new Error('oauth.v2.access returned no user token');
    secrets.push(token);

    const me = await whoAmI(d, token).catch((e: unknown) => {
      throw new Error(scrub(errorText(e), secrets));
    });
    const ch = await channelState(d, token, channel).catch((e: unknown) => {
      throw new Error(`could not read ${channel} as ${me.user}: ${scrub(errorText(e), secrets)}`);
    });
    if (!inWorkspace(ch, me.teamId)) {
      throw new Error(`${me.user} belongs to workspace ${me.teamId}, which does not own ${channel}; sign in to the test workspace (nothing was written)`);
    }
    const other = otherRole(role);
    if (env[ROLE_KEYS[other].id] === me.userId) {
      throw new Error(`${me.user} is already stored as the ${other}; sign in as a different Slack user for the ${role} (nothing was written)`);
    }
    await writeFile(
      join(d.root, ENV_FILE),
      upsertEnv(await readEnvFile(d), { [ROLE_KEYS[role].token]: token, [ROLE_KEYS[role].id]: me.userId }),
      { mode: 0o600 },
    );
    d.log(`Stored the ${role} (${me.user}, ${me.userId}) in ${ENV_FILE}: ${ROLE_KEYS[role].token}, ${ROLE_KEYS[role].id}.`);
    if (!ch.isMember) d.log(`warn ${me.user} is not in ${channel} yet; invite them to the channel before the e2e run.`);
    d.log(
      (env[ROLE_KEYS[other].token] ?? '') !== ''
        ? 'Next: run `pnpm slack:test-users --check`, then `pnpm slack:test-users secrets`.'
        : `Next: sign in to Slack as the ${other} and run \`pnpm slack:test-users ${other}\`.`,
    );
    return { role, userId: me.userId, inChannel: ch.isMember };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// check

export interface CheckResult {
  ok: boolean;
  lines: string[];
}

export async function runCheck(d: Deps): Promise<CheckResult> {
  const lines: string[] = [`Needs ${ENV_FILE} with SLACK_TEST_CHANNEL and both test users stored (nothing is changed).`];
  const env = await mergedEnv(d);
  const secrets = ROLES.map((r) => env[ROLE_KEYS[r].token]);
  let ok = true;
  const fail = (line: string): void => {
    ok = false;
    lines.push(`FAIL ${line}`);
  };
  const channel = env['SLACK_TEST_CHANNEL'] ?? '';
  if (channel === '') fail('SLACK_TEST_CHANNEL is not set');
  const ids: string[] = [];
  for (const role of ROLES) {
    const keys = ROLE_KEYS[role];
    const token = env[keys.token] ?? '';
    if (token === '') {
      fail(`${role}: ${keys.token} is not set; run \`pnpm slack:test-users ${role}\``);
      continue;
    }
    try {
      const me = await whoAmI(d, token);
      const storedId = env[keys.id] ?? '';
      if (storedId !== me.userId) {
        fail(`${role}: ${keys.id} is ${storedId === '' ? 'not set' : storedId} but the token belongs to ${me.userId}; rerun \`pnpm slack:test-users ${role}\``);
        continue;
      }
      ids.push(me.userId);
      if (channel === '') continue;
      const ch = await channelState(d, token, channel);
      if (!inWorkspace(ch, me.teamId)) fail(`${role}: ${me.user} is in workspace ${me.teamId}, not the workspace of ${channel}`);
      else if (!ch.isMember) fail(`${role}: ${me.user} is not a member of ${channel}; invite them`);
      else lines.push(`ok   ${role}: ${me.user} (${me.userId}) is a member of ${channel}`);
    } catch (e) {
      fail(`${role}: ${scrub(errorText(e), secrets)}`);
    }
  }
  if (ids.length === 2 && ids[0] === ids[1]) fail('reporter and engineer are the same Slack user; store a different user for one of them');
  lines.push(ok ? 'Next: run `pnpm slack:test-users secrets` to copy them to repository secrets.' : 'Next: fix the FAIL lines above, then rerun `pnpm slack:test-users --check`.');
  return { ok, lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// secrets

export async function runSecrets(d: Deps, repo: string = DEFAULT_SNAPWING_REPO): Promise<string[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo must be owner/name, got ${repo}`);
  d.log(`Needs ${ENV_FILE} with ${SECRET_NAMES.join(', ')}, and \`gh\` signed in with access to ${repo}.`);
  const env = await mergedEnv(d);
  const missing = SECRET_NAMES.filter((n) => (env[n] ?? '') === '');
  if (missing.length > 0) throw new Error(`${ENV_FILE} is missing ${missing.join(', ')}; run \`pnpm slack:test-users <role>\` first (nothing was set)`);
  const set: string[] = [];
  for (const name of SECRET_NAMES) {
    await d.gh(['secret', 'set', name, '--repo', repo], env[name] ?? '');
    set.push(name);
    d.log(`set ${name} on ${repo}`);
  }
  d.log('Next: run `pnpm test:e2e` locally, or push to let CI run the e2e tier.');
  return set;
}

// ---------------------------------------------------------------------------------------------------------------------
// cli

export interface ParsedArgs {
  command: 'store' | 'check' | 'secrets';
  role?: Role;
  repo?: string;
  port?: number;
  open: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { command: 'store', open: true };
  let positional: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const value = (): string => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === '--check') out.command = 'check';
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--port') out.port = Number(value());
    else if (arg === '--repo') out.repo = value();
    else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}\n${USAGE}`);
    else if (positional === undefined) positional = arg;
    else throw new Error(`unexpected argument ${arg}\n${USAGE}`);
  }
  if (out.command === 'check') return out;
  if (positional === 'secrets') return { ...out, command: 'secrets' };
  if (positional === 'reporter' || positional === 'engineer') return { ...out, role: positional };
  throw new Error(USAGE);
}

function realGh(args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout === '' ? stderr : stdout) : reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed (${code}): ${stderr.trim()}`))));
    child.stdin.end(input ?? '');
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(errorText(e));
    return 2;
  }
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    gh: realGh,
    root: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: process.env,
    log: (line) => console.log(line),
    openUrl: (url) => {
      if (args.open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => undefined);
    },
  };
  if (args.command === 'check') {
    const result = await runCheck(deps);
    for (const line of result.lines) console.log(line);
    return result.ok ? 0 : 1;
  }
  if (args.command === 'secrets') {
    await runSecrets(deps, args.repo);
    return 0;
  }
  await runStore(deps, args.role ?? 'reporter', args.port === undefined ? {} : { port: args.port });
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`FAIL ${scrub(errorText(e), [])}`);
      process.exit(1);
    },
  );
}
