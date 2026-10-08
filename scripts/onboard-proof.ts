// `pnpm onboard:proof`: the onboarding proof. The CLI is packed the way `pnpm pack:cli` packs it
// (scripts/pack-cli.mjs), and `npx -p <pipeline.tgz> -p <app.tgz> snapwing onboard` runs in an empty
// temporary directory against fresh sandboxes, with the terminal attached so the installer does the
// human steps (pasting tokens, approving installs, reacting in chat). Afterwards every item is checked
// and printed PASS or FAIL. `--teardown` removes what the run made.
//
//   pnpm onboard:proof [--platform slack|teams|both] [--dir <path>]
//       Packs the CLI, makes <tmp>/snapwing-onboard-proof-*/work (empty), runs the interview there, then
//       the checks. With --dir it picks up an earlier run in that directory (same packed CLI, same
//       state) instead, for a run that stopped waiting on someone. The platform defaults to slack.
//   pnpm onboard:proof --check [--dir <path>]
//       The checks only.
//   pnpm onboard:proof --teardown [--dir <path>] [--yes]
//       Lists every deletion, asks for confirmation (unless --yes), deletes, and lists what only a
//       person can remove. Without --dir, --check and --teardown use the newest proof directory.
//
// `.env.onboard` (repository root, gitignored) names the sandboxes. It holds names and ids only, never a
// secret: every token is pasted into the interview (hidden) and lands only in the run's own .env inside
// the temporary directory. Keys:
//   JIRA_SITE          the sandbox Jira Cloud site's host, such as acme-sandbox.atlassian.net (required)
//   JIRA_PROJECT       the sandbox Jira project key, such as SBX (required)
//   JIRA_EMAIL         the sandbox Jira admin account's email (optional; asked when absent)
//   GITHUB_OWNER       the user or organization that owns the sandbox repository and the new App (required)
//   GITHUB_OWNER_TYPE  user or org (optional; asked when absent)
//   GITHUB_REPO        the sandbox repository's name, without the owner (required)
//   SLACK_WORKSPACE    the sandbox Slack workspace's name, as Slack shows it (required for slack and both)
//   TEAMS_TENANT_ID    the sandbox Microsoft 365 tenant id (required for teams and both)
//   TEAMS_APP_ID       the sandbox Teams bot's app (client) id (required for teams and both)
//   TEAMS_TEAM         the sandbox team's name (required for teams and both)
// The phase 5 proof uses slack: there is no live Teams tenant in this build, so teams and both stop
// with a clear message until the TEAMS_ values exist. The names and ids are handed to the interview as
// scripted answers (`snapwing onboard --answers`), shown as they are used; a refused one is asked again.
//
// The interview runs with an environment of its own: PATH, HOME, the locale, and proxy settings only,
// plus an npm cache inside the proof directory. Nothing else from the shell (no token, no SNAPWING_ or
// npm_ setting) reaches it, so the run starts from nothing.
//
// The checks: the map and the config validate; `snapwing config check` (the packed CLI) passes; each
// platform's test drive pull request exists on the sandbox repository; the Jira fields exist on the
// sandbox site; the Slack app is installed in the sandbox workspace; the Teams app is installed in the
// sandbox team. Each check also confirms the run went to the sandbox named in .env.onboard.
//
// Teardown safety: it reads every id from the run's onboarding state and .env, and touches only what
// it can attribute to the run. A pull request is closed and its branch deleted only when this run's
// GitHub App opened it on the sandbox repository from a branch there (never the default branch). A
// Jira issue is deleted only when the run's test drive recorded its key and it carries the run's
// incident label (`snapwing-<incident>`) in a project the run connected. The Slack app is the app id
// the run recorded, deleted with `apps.manifest.delete` after `apps.manifest.export` shows it is
// Snapwing; that needs a fresh app configuration token, asked hidden (Enter leaves it for you). The
// Teams install and catalog entry are the ones whose external id is the run's bot, removed after a
// device code sign-in. The proof directory goes last, and only when everything before it worked.
// Anything it cannot attribute is left alone and listed. Never run from a test against real services.

import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateAppConfig } from '../packages/pipeline/src/config/app-config.ts';
import { stateOptionsFromEnv } from '../packages/pipeline/src/contracts/state.ts';
import { parseWorkspaceMap } from '../packages/pipeline/src/map/parse.ts';
import { parseDotenv } from '../packages/pipeline/src/providers/local/secrets.ts';
import { DEFAULT_SQLITE_PATH, openState } from '../packages/pipeline/src/state/db.ts';
import { StateStore } from '../packages/pipeline/src/state/store.ts';
import { createGraphTokenSource } from '../packages/app/src/adapters/teams/auth.ts';
import { createTeamsGraph, GRAPH_BASE_URL, type TeamsGraph } from '../packages/app/src/adapters/teams/graph.ts';
import { terminalPrompter, type Prompter } from '../packages/app/src/cli/prompt.ts';
import { signAppJwt } from '../packages/app/src/github/auth.ts';
import { incidentLabel } from '../packages/app/src/jira/projector/ops.ts';
import { call as githubCall, type GitHubDeps } from '../packages/app/src/onboard/github/api.ts';
import { SecretValue } from '../packages/app/src/onboard/interview/io.ts';
import { createKvOnboardingStore, type JsonObject, type JsonValue, type OnboardingState } from '../packages/app/src/onboard/interview/state.ts';
import { FIELD_SPECS } from '../packages/app/src/onboard/jira/bootstrap.ts';
import { APP_NAME as SLACK_APP_NAME, callSlack } from '../packages/app/src/onboard/slack/bootstrap.ts';
import { checkBotToken, DEFAULT_API_BASE as SLACK_API_BASE } from '../packages/app/src/onboard/slack/install.ts';
import { DeviceCodeError, inspectTeamsInstall, signInByDeviceCode } from '../packages/app/src/onboard/teams/install.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ONBOARD_ENV_FILE = '.env.onboard';
const PACK_SCRIPT = join(REPO_ROOT, 'scripts', 'pack-cli.mjs');
/** A proof directory is `<tmp>/<prefix><random>` holding `proof.json`; nothing else counts as one. */
export const PROOF_DIR_PREFIX = 'snapwing-onboard-proof-';
const MARKER_FILE = 'proof.json';
const MARKER_KIND = 'snapwing-onboard-proof';
const GITHUB_API = 'https://api.github.com';
const GITHUB_WEB = 'https://github.com';
const DEVELOPER_PORTAL = 'https://dev.teams.microsoft.com/bots';
/** What the device code sign-in asks for at teardown: removing an install and a catalog entry. */
export const TEARDOWN_TEAMS_SCOPES: readonly string[] = ['TeamsAppInstallation.ReadWriteForTeam', 'AppCatalog.ReadWrite.All', 'Team.ReadBasic.All'];

export const USAGE = `Usage:
  pnpm onboard:proof [--platform slack|teams|both] [--dir <path>]
  pnpm onboard:proof --check [--dir <path>]
  pnpm onboard:proof --teardown [--dir <path>] [--yes]

Packs the CLI, runs \`snapwing onboard\` from the tarballs in an empty temporary directory against the
sandboxes named in ${ONBOARD_ENV_FILE} (names and ids only, no secrets; see the header of
scripts/onboard-proof.ts), with you at the keyboard, then checks each item and prints PASS or FAIL.

  --platform <p>  slack (default, the phase 5 proof), teams, or both; teams needs the TEAMS_ values
  --dir <path>    pick up the proof in this directory instead of making a new one
  --check         run the checks only
  --teardown      delete what the run made, after listing it and asking; lists what only you can remove
  --yes           with --teardown, do not ask for confirmation

Exit codes: 0 every check passed (or the teardown finished), 1 a check or deletion failed or a value is
missing, 2 or 3 the interview stopped (a question unanswered, or waiting on someone): rerun with --dir.`;

export type Platform = 'slack' | 'teams' | 'both';
const PLATFORMS: readonly Platform[] = ['slack', 'teams', 'both'];
const usesSlack = (p: Platform): boolean => p !== 'teams';
const usesTeams = (p: Platform): boolean => p !== 'slack';
const PLATFORM_NAMES: Readonly<Record<'slack' | 'teams', string>> = { slack: 'Slack', teams: 'Teams' };

// ---------------------------------------------------------------------------------------------------
// .env.onboard: the sandboxes
// ---------------------------------------------------------------------------------------------------

export interface TeamsSandbox {
  readonly tenantId: string;
  readonly appId: string;
  readonly team: string;
}

export interface Sandbox {
  /** The Jira Cloud site's host. */
  readonly jiraSite: string;
  readonly jiraProject: string;
  readonly jiraEmail?: string;
  readonly githubOwner: string;
  readonly githubOwnerType?: 'user' | 'org';
  /** The repository's name, without the owner. */
  readonly githubRepo: string;
  readonly slackWorkspace?: string;
  readonly teams?: TeamsSandbox;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Shapes of the tokens the interview asks for: none belongs in .env.onboard. */
const SECRET_SHAPE = /^(xox[a-z]-|xapp-|gh[pousr]_|github_pat_|sk-|ATATT|-----BEGIN)/;
const TEAMS_KEYS = ['TEAMS_TENANT_ID', 'TEAMS_APP_ID', 'TEAMS_TEAM'] as const;

/** `.env.onboard` as KEY=VALUE pairs; undefined when the file is absent. */
export async function readOnboardEnv(path: string): Promise<Map<string, string> | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return parseDotenv(text, ONBOARD_ENV_FILE);
}

/** A Jira site as a host: a bare name is `<name>.atlassian.net`; a pasted address loses its scheme and path. */
export function siteHost(text: string): string {
  let host = text.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '');
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) host = `${host}.atlassian.net`;
  return host;
}

/**
 * The sandboxes for `platform`, or what is missing or wrong. The Teams problem comes first: there is
 * no live Teams tenant in this build, so that is the usual reason `teams` and `both` stop.
 */
export function sandboxFrom(values: ReadonlyMap<string, string> | undefined, platform: Platform): { sandbox?: Sandbox; problems: string[] } {
  const get = (k: string): string | undefined => {
    const v = values?.get(k)?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const problems: string[] = [];
  if (usesTeams(platform)) {
    const absent = TEAMS_KEYS.filter((k) => get(k) === undefined);
    if (absent.length > 0) {
      problems.push(
        `--platform ${platform} needs the Teams sandbox, and ${ONBOARD_ENV_FILE} has no ${absent.join(', ')}. There is no live Teams tenant in this build: run the proof with --platform slack, or add the Teams sandbox's values first.`,
      );
    }
  }
  if (values === undefined) {
    problems.push(`${ONBOARD_ENV_FILE} was not found at the repository root. Create it with the sandbox names and ids listed in the header of scripts/onboard-proof.ts.`);
    return { problems };
  }
  const required = ['JIRA_SITE', 'JIRA_PROJECT', 'GITHUB_OWNER', 'GITHUB_REPO', ...(usesSlack(platform) ? ['SLACK_WORKSPACE'] : [])];
  const missing = required.filter((k) => get(k) === undefined);
  if (missing.length > 0) problems.push(`${ONBOARD_ENV_FILE} is missing ${missing.join(', ')} (see the header of scripts/onboard-proof.ts).`);
  for (const [k, v] of values) if (SECRET_SHAPE.test(v.trim())) problems.push(`${ONBOARD_ENV_FILE}: ${k} looks like a secret. The file holds names and ids only; paste tokens into the interview instead.`);
  const check = (key: string, ok: (v: string) => boolean, what: string): void => {
    const v = get(key);
    if (v !== undefined && !ok(v)) problems.push(`${ONBOARD_ENV_FILE}: ${key} should be ${what}.`);
  };
  check('JIRA_SITE', (v) => /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(siteHost(v)), 'a Jira Cloud site, such as acme-sandbox.atlassian.net');
  check('JIRA_PROJECT', (v) => /^[A-Z][A-Z0-9_]+$/.test(v), 'a project key, such as SBX');
  check('GITHUB_OWNER', (v) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(v), 'a GitHub user or organization login');
  check('GITHUB_OWNER_TYPE', (v) => v === 'user' || v === 'org', 'user or org');
  check('GITHUB_REPO', (v) => /^[A-Za-z0-9._-]+$/.test(v), "the repository's name without the owner");
  if (usesTeams(platform)) {
    check('TEAMS_TENANT_ID', (v) => GUID.test(v), 'a tenant id, such as 11111111-2222-3333-4444-555555555555');
    check('TEAMS_APP_ID', (v) => GUID.test(v), "the bot's app id, such as 11111111-2222-3333-4444-555555555555");
  }
  if (problems.length > 0) return { problems };
  const ownerType = get('GITHUB_OWNER_TYPE');
  const email = get('JIRA_EMAIL');
  const workspace = get('SLACK_WORKSPACE');
  const sandbox: Sandbox = {
    jiraSite: siteHost(get('JIRA_SITE') ?? ''),
    jiraProject: get('JIRA_PROJECT') ?? '',
    ...(email === undefined ? {} : { jiraEmail: email }),
    githubOwner: get('GITHUB_OWNER') ?? '',
    ...(ownerType === 'user' || ownerType === 'org' ? { githubOwnerType: ownerType } : {}),
    githubRepo: get('GITHUB_REPO') ?? '',
    ...(usesSlack(platform) && workspace !== undefined ? { slackWorkspace: workspace } : {}),
    ...(usesTeams(platform) ? { teams: { tenantId: get('TEAMS_TENANT_ID') ?? '', appId: get('TEAMS_APP_ID') ?? '', team: get('TEAMS_TEAM') ?? '' } } : {}),
  };
  return { sandbox, problems };
}

/** The sandbox's names and ids as scripted answers to `snapwing onboard --answers`. */
export function answersFor(sandbox: Sandbox): Record<string, string> {
  return {
    'jira.site': sandbox.jiraSite,
    ...(sandbox.jiraEmail === undefined ? {} : { 'jira.email': sandbox.jiraEmail }),
    'jira.projects': sandbox.jiraProject,
    ...(sandbox.githubOwnerType === undefined ? {} : { 'github.owner-type': sandbox.githubOwnerType }),
    'github.owner': sandbox.githubOwner,
    ...(sandbox.teams === undefined ? {} : { 'teams.app-id': sandbox.teams.appId, 'teams.tenant-id': sandbox.teams.tenantId }),
  };
}

const sandboxRepo = (s: Sandbox): string => `${s.githubOwner}/${s.githubRepo}`;

// ---------------------------------------------------------------------------------------------------
// The proof directory
// ---------------------------------------------------------------------------------------------------

export interface ProofMarker {
  readonly kind: typeof MARKER_KIND;
  readonly version: 1;
  readonly platform: Platform;
  readonly createdAt: string;
  readonly sandbox: Sandbox;
  readonly tarballs: { readonly pipeline: string; readonly app: string };
}

/** `root` holds the marker, the tarballs, the answers, and npm's cache; `work` is where the interview ran. */
export interface ProofDir {
  readonly root: string;
  readonly work: string;
  readonly marker: ProofMarker;
}

export class ProofError extends Error {
  override readonly name = 'ProofError';
}

export async function writeProofDir(root: string, marker: ProofMarker): Promise<ProofDir> {
  const work = join(root, 'work');
  await mkdir(work, { recursive: true });
  await writeFile(join(root, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return { root, work, marker };
}

export async function readProofDir(root: string): Promise<ProofDir> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, MARKER_FILE), 'utf8'));
  } catch {
    throw new ProofError(`${root} is not a proof directory (no readable ${MARKER_FILE})`);
  }
  const m = raw as Partial<ProofMarker> | null;
  if (m === null || typeof m !== 'object' || m.kind !== MARKER_KIND || m.version !== 1 || !PLATFORMS.includes(m.platform as Platform) || typeof m.sandbox !== 'object') {
    throw new ProofError(`${root} is not a proof directory (${MARKER_FILE} is not one this script wrote)`);
  }
  return { root, work: join(root, 'work'), marker: m as ProofMarker };
}

/** The newest proof directory under `base`, or undefined. */
export async function newestProofDir(base = tmpdir()): Promise<string | undefined> {
  let newest: { path: string; at: number } | undefined;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (!name.startsWith(PROOF_DIR_PREFIX)) continue;
    const path = join(base, name);
    const at = await stat(join(path, MARKER_FILE)).then((s) => s.mtimeMs, () => undefined);
    if (at !== undefined && (newest === undefined || at > newest.at)) newest = { path, at };
  }
  return newest?.path;
}

// ---------------------------------------------------------------------------------------------------
// What the run left: the onboarding state and .env
// ---------------------------------------------------------------------------------------------------

export interface ProofDeps {
  readonly fetch: typeof fetch;
  /** One line of output; every line goes through the run's secrets redaction first. */
  readonly say: (line: string) => void;
  readonly prompter: Prompter;
  readonly now: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The environment the interview ran with: it says where the state store is (default `snapwing.sqlite` in the work directory). */
  readonly stateEnv: Readonly<Record<string, string | undefined>>;
  /** `snapwing config check` in the work directory, from the packed CLI. */
  readonly configCheck: (proof: ProofDir) => Promise<{ code: number; output: string }>;
  readonly slackApi?: string;
  readonly githubApi?: string;
  readonly githubWeb?: string;
  readonly graphBaseUrl?: string;
  readonly loginHost?: string;
}

/** What one run left behind, read once. */
interface Run {
  readonly proof: ProofDir;
  readonly state: OnboardingState | undefined;
  readonly env: ReadonlyMap<string, string>;
  data(step: string): JsonObject | undefined;
  /** `say` with every secret value from the run's .env redacted. */
  say(line: string): void;
  /** Adds a value to redact from output (a token asked at teardown). */
  secret(value: string): void;
}

const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ENCRYPTION_KEY)/;

async function readOnboardingState(work: string, env: Readonly<Record<string, string | undefined>>): Promise<OnboardingState | undefined> {
  const options = stateOptionsFromEnv(env);
  if (options.dialect === 'sqlite') {
    options.url = resolve(work, env['SNAPWING_SQLITE_PATH']?.trim() || DEFAULT_SQLITE_PATH);
    if (!existsSync(options.url)) return undefined;
  }
  const opened = await openState(options);
  try {
    if (!(opened instanceof StateStore)) throw new ProofError('the onboarding state needs the store openState returned');
    return await createKvOnboardingStore(opened).load();
  } finally {
    await opened.close();
  }
}

async function loadRun(proof: ProofDir, deps: ProofDeps): Promise<Run> {
  const state = await readOnboardingState(proof.work, deps.stateEnv);
  let env = new Map<string, string>();
  try {
    env = parseDotenv(await readFile(join(proof.work, '.env'), 'utf8'), '.env');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const secrets = [...env].filter(([k, v]) => SECRET_KEY.test(k) && v.length >= 6).map(([, v]) => v);
  const redact = (line: string): string => secrets.reduce((out, s) => out.split(s).join('[secret]'), line);
  return {
    proof,
    state,
    env,
    data: (step) => state?.steps[step]?.data,
    say: (line) => deps.say(redact(line)),
    secret: (value) => {
      if (value.length >= 6) secrets.push(value);
    },
  };
}

const text = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const obj = (v: JsonValue | undefined): JsonObject | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined);
const list = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? (v as readonly JsonValue[]) : []);
const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Drive {
  readonly platform: string;
  readonly incident?: string;
  readonly jiraKey?: string;
  readonly pr?: string;
}

function drivesOf(run: Run): Drive[] {
  return list(run.data('test-drive')?.['drives']).flatMap((d) => {
    const o = obj(d);
    const platform = text(o?.['platform']);
    if (o === undefined || platform === undefined) return [];
    const incident = text(o['incident']);
    const jiraKey = text(o['jiraKey']);
    const pr = text(o['pr']);
    return [{ platform, ...(incident === undefined ? {} : { incident }), ...(jiraKey === undefined ? {} : { jiraKey }), ...(pr === undefined ? {} : { pr }) }];
  });
}

/** `owner/repo` and the number from a pull request's web address. */
export function parsePullUrl(url: string, web = GITHUB_WEB): { repo: string; number: number } | undefined {
  const m = new RegExp(`^${web.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([A-Za-z0-9-]+/[A-Za-z0-9._-]+)/pull/(\\d+)$`).exec(url.trim());
  return m?.[1] === undefined || m[2] === undefined ? undefined : { repo: m[1], number: Number(m[2]) };
}

// ---------------------------------------------------------------------------------------------------
// GitHub, Jira, Slack, Graph: the few calls the checks and the teardown make
// ---------------------------------------------------------------------------------------------------

function githubDeps(deps: ProofDeps): GitHubDeps {
  return { fetch: deps.fetch, log: () => undefined, openUrl: () => undefined, now: deps.now, apiBase: deps.githubApi ?? GITHUB_API };
}

/** An installation token for the run's GitHub App, from the App's own credentials in the run's .env. */
async function installationToken(run: Run, deps: ProofDeps): Promise<string> {
  const appId = run.env.get('GITHUB_APP_ID');
  const pem = run.env.get('GITHUB_APP_PRIVATE_KEY');
  const installation = run.env.get('GITHUB_INSTALLATION_ID') ?? text(run.data('github')?.['installationId']);
  if (appId === undefined || pem === undefined || installation === undefined) throw new Error("the run's .env has no GitHub App credentials or installation");
  const r = await githubCall(githubDeps(deps), signAppJwt(appId, pem, deps.now()), 'POST', `/app/installations/${encodeURIComponent(installation)}/access_tokens`, {});
  const token = obj(r.body as JsonValue)?.['token'];
  if (r.status !== 201 || typeof token !== 'string') throw new Error(`GitHub would not give the App an installation token (HTTP ${r.status})`);
  run.secret(token);
  return token;
}

const refPath = (ref: string): string => ref.split('/').map(encodeURIComponent).join('/');

interface Jira {
  readonly base: string;
  readonly host: string;
  get(path: string): Promise<{ status: number; body: unknown }>;
  del(path: string): Promise<number>;
}

function jiraOf(run: Run, deps: ProofDeps): Jira {
  const base = run.env.get('JIRA_BASE_URL')?.replace(/\/+$/, '');
  const email = run.env.get('JIRA_EMAIL');
  const token = run.env.get('JIRA_API_TOKEN');
  if (base === undefined || email === undefined || token === undefined) throw new Error("the run's .env has no Jira login");
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const headers = { Authorization: auth, Accept: 'application/json' };
  return {
    base,
    host: new URL(base).hostname.toLowerCase(),
    async get(path) {
      const res = await deps.fetch(`${base}${path}`, { headers });
      return { status: res.status, body: res.ok ? await res.json() : undefined };
    },
    async del(path) {
      return (await deps.fetch(`${base}${path}`, { method: 'DELETE', headers })).status;
    },
  };
}

async function graphDelete(deps: ProofDeps, token: string, path: string): Promise<number> {
  const base = (deps.graphBaseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '');
  return (await deps.fetch(`${base}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status;
}

// ---------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------

export interface CheckLine {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function check(name: string, fn: () => Promise<string>): Promise<CheckLine> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: reason(e) };
  }
}

/** A file in the work directory by the name the state gives; never outside it. */
function inWork(proof: ProofDir, name: string): string {
  const path = resolve(proof.work, name);
  const rel = relative(proof.work, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error(`${name} is outside the working directory`);
  return path;
}

async function checkFiles(run: Run): Promise<string> {
  const mapName = text(run.data('finish')?.['map']) ?? 'workspace-context.xml';
  let mapXml: string;
  let configXml: string;
  try {
    mapXml = await readFile(inWork(run.proof, mapName), 'utf8');
  } catch {
    throw new Error(`the run wrote no ${mapName}`);
  }
  try {
    configXml = await readFile(inWork(run.proof, 'snapwing.config.xml'), 'utf8');
  } catch {
    throw new Error('the run wrote no snapwing.config.xml');
  }
  const map = await parseWorkspaceMap(mapXml).catch((e: unknown) => {
    throw new Error(`${mapName} does not validate: ${reason(e)}`);
  });
  const config = await validateAppConfig(configXml);
  if (!config.valid) throw new Error(`snapwing.config.xml does not validate: ${JSON.stringify(config)}`);
  return `${mapName} (${map.surfaces.length} products, ${map.channels.length} channels) and snapwing.config.xml`;
}

async function checkConfigCommand(run: Run, deps: ProofDeps): Promise<string> {
  const { code, output } = await deps.configCheck(run.proof);
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (code !== 0) throw new Error(`exit ${code}: ${lines.filter((l) => !l.startsWith('ok:')).slice(0, 3).join(' | ') || 'no output'}`);
  return lines.at(-1) ?? 'exit 0';
}

async function checkPull(run: Run, deps: ProofDeps, platform: 'slack' | 'teams', token: () => Promise<string>): Promise<string> {
  const drive = drivesOf(run).find((d) => d.platform === platform);
  if (drive?.pr === undefined) throw new Error(`the test drive recorded no pull request on ${PLATFORM_NAMES[platform]} (test drive: ${run.state?.steps['test-drive']?.status ?? 'not started'})`);
  const pull = parsePullUrl(drive.pr, deps.githubWeb);
  if (pull === undefined) throw new Error(`the test drive recorded ${drive.pr}, which is not a pull request address`);
  const repo = sandboxRepo(run.proof.marker.sandbox);
  if (!same(pull.repo, repo)) throw new Error(`the pull request is on ${pull.repo}, not the sandbox repository ${repo}`);
  const r = await githubCall(githubDeps(deps), await token(), 'GET', `/repos/${pull.repo}/pulls/${pull.number}`);
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for ${pull.repo}#${pull.number}`);
  return `${PLATFORM_NAMES[platform]}: ${pull.repo}#${pull.number} (${text(obj(r.body as JsonValue)?.['state']) ?? 'unknown state'})`;
}

async function checkJiraFields(run: Run, deps: ProofDeps): Promise<string> {
  const jira = jiraOf(run, deps);
  const { sandbox } = run.proof.marker;
  if (jira.host !== sandbox.jiraSite) throw new Error(`the run connected ${jira.host}, not the sandbox site ${sandbox.jiraSite}`);
  const projects = list(run.data('jira')?.['projects']).filter((p): p is string => typeof p === 'string');
  if (!projects.includes(sandbox.jiraProject)) throw new Error(`the run connected ${projects.join(', ') || 'no project'}, not the sandbox project ${sandbox.jiraProject}`);
  const r = await jira.get('/rest/api/3/field');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`Jira answered ${r.status} for its fields`);
  const names = new Set((r.body as { name?: unknown; custom?: unknown }[]).filter((f) => f.custom === true).map((f) => String(f.name)));
  const missing = FIELD_SPECS.map((f) => f.name).filter((n) => !names.has(n));
  if (missing.length > 0) throw new Error(`${sandbox.jiraSite} has no ${missing.join(', ')}`);
  return `${sandbox.jiraSite}: ${FIELD_SPECS.map((f) => f.name).join(', ')}`;
}

async function checkSlackApp(run: Run, deps: ProofDeps): Promise<string> {
  const appId = text(run.data('slack')?.['appId']);
  if (appId === undefined) throw new Error('the run recorded no Slack app');
  const token = run.env.get('SLACK_BOT_TOKEN');
  if (token === undefined) throw new Error(`the Slack app ${appId} has no bot token in the run's .env (not installed yet)`);
  const bot = await checkBotToken((deps.slackApi ?? SLACK_API_BASE).replace(/\/$/, ''), new SecretValue(token));
  if (bot.status !== 'ok') throw new Error(`Slack ${bot.status === 'rejected' ? 'refused' : 'did not answer for'} the bot token of app ${appId}`);
  const workspace = run.proof.marker.sandbox.slackWorkspace;
  if (workspace !== undefined && !same(bot.value.team, workspace)) throw new Error(`the app is installed in ${bot.value.team}, not the sandbox workspace ${workspace}`);
  return `app ${appId}, installed in ${bot.value.team}`;
}

async function checkTeamsInstall(run: Run, deps: ProofDeps): Promise<string> {
  const sandbox = run.proof.marker.sandbox.teams;
  const data = run.data('teams');
  const appId = run.env.get('TEAMS_APP_ID');
  const tenantId = run.env.get('TEAMS_TENANT_ID');
  const password = run.env.get('TEAMS_APP_PASSWORD');
  if (sandbox === undefined) throw new Error('the proof has no Teams sandbox');
  if (data === undefined || appId === undefined || tenantId === undefined || password === undefined) throw new Error('the run recorded no Teams bot');
  if (!same(tenantId, sandbox.tenantId) || !same(appId, sandbox.appId)) throw new Error('the run connected a Teams bot or tenant other than the sandbox one');
  const team = list(data['teams']).map(obj).find((t) => same(text(t?.['name']), sandbox.team));
  const teamId = text(team?.['id']);
  if (teamId === undefined) throw new Error(`the run did not install the app in the sandbox team ${sandbox.team}`);
  const tokens = createGraphTokenSource({ appId, password, tenantId, fetch: deps.fetch, ...(deps.loginHost === undefined ? {} : { loginHost: deps.loginHost }) });
  const graph = createTeamsGraph({ token: () => tokens.token(), fetch: deps.fetch, ...(deps.graphBaseUrl === undefined ? {} : { baseUrl: deps.graphBaseUrl }) });
  const seen = await inspectTeamsInstall({ graph, appId, teamId });
  if (!seen.installed) throw new Error(`the app is not installed in ${sandbox.team}`);
  return `${sandbox.team}, ${seen.mode} mode${seen.reason === undefined ? '' : ` (${seen.reason})`}`;
}

/** Every check for the proof's platform, in order. */
export async function runChecks(proof: ProofDir, deps: ProofDeps): Promise<CheckLine[]> {
  const run = await loadRun(proof, deps);
  const { platform } = proof.marker;
  let token: Promise<string> | undefined;
  const githubToken = (): Promise<string> => (token ??= installationToken(run, deps));
  const lines: CheckLine[] = [
    await check('map and config validate', () => checkFiles(run)),
    await check('snapwing config check passes', () => checkConfigCommand(run, deps)),
  ];
  for (const p of ['slack', 'teams'] as const) {
    if (p === 'slack' ? usesSlack(platform) : usesTeams(platform)) lines.push(await check("the test drive's PR exists on the sandbox repository", () => checkPull(run, deps, p, githubToken)));
  }
  lines.push(await check('the Jira fields exist on the sandbox site', () => checkJiraFields(run, deps)));
  if (usesSlack(platform)) lines.push(await check('the Slack app exists', () => checkSlackApp(run, deps)));
  if (usesTeams(platform)) lines.push(await check('the Teams install exists', () => checkTeamsInstall(run, deps)));
  for (const l of lines) run.say(`${l.ok ? 'PASS' : 'FAIL'}  ${l.name}: ${l.detail}`);
  const failed = lines.filter((l) => !l.ok).length;
  run.say(failed === 0 ? `All ${lines.length} checks passed.` : `${failed} of ${lines.length} checks failed.`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------------------------------

export interface TeardownStep {
  readonly what: string;
  run(): Promise<void>;
}

export interface TeardownPlan {
  /** In the order they run; the proof directory last. */
  readonly steps: TeardownStep[];
  /** What only a person can remove, and where. */
  readonly byHand: string[];
  /** What the run touched but the teardown leaves, and why. */
  readonly leftAlone: string[];
}

interface PullView {
  readonly number: number;
  readonly state: string;
  readonly author: string;
  readonly headRef: string;
  readonly headRepo: string;
  readonly defaultBranch: string;
}

function pullView(body: unknown): PullView | undefined {
  const o = obj(body as JsonValue);
  const head = obj(o?.['head']);
  const baseRepo = obj(obj(o?.['base'])?.['repo']);
  const n = o?.['number'];
  if (o === undefined || head === undefined || typeof n !== 'number') return undefined;
  return {
    number: n,
    state: text(o['merged_at']) !== undefined ? 'merged' : (text(o['state']) ?? 'unknown'),
    author: text(obj(o['user'])?.['login']) ?? '',
    headRef: text(head['ref']) ?? '',
    headRepo: text(obj(head['repo'])?.['full_name']) ?? '',
    defaultBranch: text(baseRepo?.['default_branch']) ?? 'main',
  };
}

async function planGitHub(run: Run, deps: ProofDeps, plan: TeardownPlan): Promise<void> {
  const github = run.data('github');
  const slug = text(github?.['slug']) ?? run.env.get('GITHUB_APP_SLUG');
  const owner = text(github?.['owner']);
  if (slug !== undefined) {
    const settings = text(github?.['ownerType']) === 'org' && owner !== undefined ? `${GITHUB_WEB}/organizations/${owner}/settings/apps/${slug}` : `${GITHUB_WEB}/settings/apps/${slug}`;
    plan.byHand.push(`The GitHub App ${slug}: GitHub has no API to delete an App. Open ${settings}, then Advanced, then Delete GitHub App.`);
  }
  const repo = sandboxRepo(run.proof.marker.sandbox);
  const recorded = drivesOf(run).flatMap((d) => (d.pr === undefined ? [] : [{ url: d.pr, pull: parsePullUrl(d.pr, deps.githubWeb) }]));
  for (const r of recorded) if (r.pull === undefined || !same(r.pull.repo, repo)) plan.leftAlone.push(`${r.url}: not on the sandbox repository ${repo}.`);
  if (slug === undefined) {
    if (recorded.length > 0) plan.leftAlone.push("The test drive's pull requests: the run recorded no GitHub App, so none can be attributed to it.");
    return;
  }
  let token: string;
  try {
    token = await installationToken(run, deps);
  } catch (e) {
    plan.leftAlone.push(`The pull requests on ${repo}: ${reason(e)}.`);
    return;
  }
  const d = githubDeps(deps);
  const bot = `${slug}[bot]`;
  const pulls = new Map<number, PullView>();
  const open = await githubCall(d, token, 'GET', `/repos/${repo}/pulls?state=open&per_page=100`);
  for (const p of Array.isArray(open.body) ? open.body : []) {
    const v = pullView(p);
    if (v !== undefined && same(v.author, bot)) pulls.set(v.number, v);
  }
  for (const r of recorded) {
    if (r.pull === undefined || !same(r.pull.repo, repo) || pulls.has(r.pull.number)) continue;
    const got = await githubCall(d, token, 'GET', `/repos/${repo}/pulls/${r.pull.number}`);
    const v = got.status === 200 ? pullView(got.body) : undefined;
    if (v === undefined) plan.leftAlone.push(`${repo}#${r.pull.number}: GitHub answered ${got.status}; nothing to close.`);
    else if (!same(v.author, bot)) plan.leftAlone.push(`${repo}#${v.number}: opened by ${v.author}, not this run's App ${bot}.`);
    else pulls.set(v.number, v);
  }
  for (const v of [...pulls.values()].sort((a, b) => a.number - b.number)) {
    if (v.state === 'open') {
      plan.steps.push({
        what: `close pull request ${repo}#${v.number} (opened by ${bot})`,
        run: async () => {
          const r = await githubCall(d, token, 'PATCH', `/repos/${repo}/pulls/${v.number}`, { state: 'closed' });
          if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`);
        },
      });
    }
    if (!same(v.headRepo, repo) || v.headRef === '' || v.headRef === v.defaultBranch) {
      plan.leftAlone.push(`The branch of ${repo}#${v.number} (${v.headRef || 'none'}): not a branch the run made on ${repo}.`);
      continue;
    }
    const ref = await githubCall(d, token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(v.headRef)}`);
    if (ref.status !== 200) continue;
    plan.steps.push({
      what: `delete branch ${v.headRef} on ${repo} (the head of #${v.number})`,
      run: async () => {
        const r = await githubCall(d, token, 'DELETE', `/repos/${repo}/git/refs/heads/${refPath(v.headRef)}`);
        if (r.status !== 204 && r.status !== 422) throw new Error(`GitHub answered ${r.status}`);
      },
    });
  }
}

async function planJira(run: Run, deps: ProofDeps, plan: TeardownPlan): Promise<void> {
  const drives = drivesOf(run).filter((d) => d.jiraKey !== undefined);
  const { sandbox } = run.proof.marker;
  if (run.data('jira')?.['webhook'] === 'registered') {
    plan.leftAlone.push(`The Jira webhook named Snapwing on ${sandbox.jiraSite}: remove it under Settings, System, WebHooks if you no longer need it.`);
  }
  if (run.data('jira') !== undefined) {
    plan.leftAlone.push(`The Snapwing fields on ${sandbox.jiraSite} (${FIELD_SPECS.map((f) => f.name).join(', ')}): the next proof reuses them, so they stay.`);
  }
  if (drives.length === 0) return;
  let jira: Jira;
  try {
    jira = jiraOf(run, deps);
  } catch (e) {
    plan.leftAlone.push(`The test drive's Jira issues: ${reason(e)}.`);
    return;
  }
  if (jira.host !== sandbox.jiraSite) {
    plan.leftAlone.push(`The test drive's Jira issues: the run connected ${jira.host}, not the sandbox site ${sandbox.jiraSite}.`);
    return;
  }
  const projects = list(run.data('jira')?.['projects']).filter((p): p is string => typeof p === 'string');
  for (const d of drives) {
    const key = d.jiraKey ?? '';
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) {
      plan.leftAlone.push(`Jira issue ${key}: not an issue key.`);
      continue;
    }
    const got = await jira.get(`/rest/api/3/issue/${key}?fields=summary,labels,project`);
    if (got.status === 404) continue;
    const fields = obj(obj(got.body as JsonValue)?.['fields']);
    if (got.status !== 200 || fields === undefined) {
      plan.leftAlone.push(`Jira issue ${key}: Jira answered ${got.status}.`);
      continue;
    }
    const labels = list(fields['labels']).filter((l): l is string => typeof l === 'string');
    const project = text(obj(fields['project'])?.['key']);
    const label = d.incident === undefined ? undefined : incidentLabel(d.incident);
    if (label === undefined || !labels.includes(label) || project === undefined || !projects.includes(project)) {
      plan.leftAlone.push(`Jira issue ${key}: it does not carry the run's label ${label ?? '(no incident recorded)'} in a project the run connected.`);
      continue;
    }
    const summary = (text(fields['summary']) ?? '').replace(/[\p{Cc}]/gu, ' ').slice(0, 80);
    plan.steps.push({
      what: `delete Jira issue ${key} on ${sandbox.jiraSite} (${summary})`,
      run: async () => {
        const status = await jira.del(`/rest/api/3/issue/${key}`);
        if (status !== 204 && status !== 404) throw new Error(`Jira answered ${status}${status === 403 ? ' (the account needs the Delete Issues permission)' : ''}`);
      },
    });
  }
}

async function planSlack(run: Run, deps: ProofDeps, plan: TeardownPlan): Promise<void> {
  const appId = text(run.data('slack')?.['appId']);
  if (appId === undefined) return;
  const byHand = `The Slack app ${appId}: open https://api.slack.com/apps/${encodeURIComponent(appId)}/general and choose Delete App.`;
  if (!/^A[A-Z0-9]+$/.test(appId)) {
    plan.leftAlone.push(`The Slack app ${appId}: not a Slack app id.`);
    return;
  }
  run.say(`To delete the Slack app ${appId}, Slack needs a fresh app configuration token: open https://api.slack.com/apps, scroll to "Your App Configuration Tokens", and generate one for the sandbox workspace.`);
  const answer = (await deps.prompter.hidden('Paste the configuration token (it will not show), or press Enter to delete the app by hand: '))?.trim();
  if (answer === undefined || answer === '') {
    plan.byHand.push(byHand);
    return;
  }
  run.secret(answer);
  const api = (deps.slackApi ?? SLACK_API_BASE).replace(/\/$/, '');
  let name: unknown;
  try {
    const { body } = await callSlack(`${api}/apps.manifest.export`, { token: answer, form: { app_id: appId } });
    if (!body.ok) throw new Error(`Slack answered ${body.error ?? 'unknown'} to apps.manifest.export`);
    name = obj(obj(body['manifest'] as JsonValue)?.['display_information'])?.['name'];
  } catch (e) {
    plan.byHand.push(`${byHand} (${reason(e)})`);
    return;
  }
  if (name !== SLACK_APP_NAME) {
    plan.leftAlone.push(`The Slack app ${appId}: its manifest names it ${String(name)}, not ${SLACK_APP_NAME}.`);
    return;
  }
  plan.steps.push({
    what: `delete the Slack app ${appId} (${SLACK_APP_NAME}) with apps.manifest.delete`,
    run: async () => {
      const { body } = await callSlack(`${api}/apps.manifest.delete`, { token: answer, form: { app_id: appId } });
      if (!body.ok) throw new Error(`Slack answered ${body.error ?? 'unknown'}`);
    },
  });
}

async function planTeams(run: Run, deps: ProofDeps, plan: TeardownPlan): Promise<void> {
  const data = run.data('teams');
  const appId = text(data?.['appId']) ?? run.env.get('TEAMS_APP_ID');
  const tenantId = text(data?.['tenantId']) ?? run.env.get('TEAMS_TENANT_ID');
  if (data === undefined || appId === undefined || tenantId === undefined) return;
  plan.byHand.push(`The Teams bot registration ${appId}, if no later proof needs it: delete it in the Teams Developer Portal, ${DEVELOPER_PORTAL} (Microsoft has no API for it without an Azure subscription).`);
  const teams = list(data['teams']).map(obj).flatMap((t) => (text(t?.['id']) === undefined ? [] : [{ id: text(t?.['id']) ?? '', name: text(t?.['name']) ?? text(t?.['id']) ?? '' }]));
  run.say('To remove the Teams install and the catalog entry, a Teams admin of the sandbox tenant signs in next.');
  let token: SecretValue;
  try {
    token = await signInByDeviceCode({
      tenantId,
      clientId: appId,
      scopes: TEARDOWN_TEAMS_SCOPES,
      prompt: (p) => run.say(`Sign in as a Teams admin: open ${p.verificationUri} and enter the code ${p.userCode} (valid ${Math.round(p.expiresIn / 60)} minutes).`),
      fetch: deps.fetch,
      ...(deps.loginHost === undefined ? {} : { loginHost: deps.loginHost }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  } catch (e) {
    const why = e instanceof DeviceCodeError ? e.code : reason(e);
    plan.byHand.push(`The Teams app in ${teams.map((t) => t.name).join(', ') || 'the sandbox team'} and in the tenant's catalog (the sign-in did not finish: ${why}): remove it in the Teams admin center, https://admin.teams.microsoft.com, under Teams apps, Manage apps.`);
    return;
  }
  run.secret(token.reveal());
  const graph: TeamsGraph = createTeamsGraph({ token: token.reveal(), fetch: deps.fetch, ...(deps.graphBaseUrl === undefined ? {} : { baseUrl: deps.graphBaseUrl }) });
  for (const team of teams) {
    for (const app of (await graph.installedApps(team.id)).filter((a) => a.teamsApp?.externalId === appId)) {
      plan.steps.push({
        what: `remove the Teams app install ${app.id} from ${team.name}`,
        run: async () => {
          const status = await graphDelete(deps, token.reveal(), `/teams/${encodeURIComponent(team.id)}/installedApps/${encodeURIComponent(app.id)}`);
          if (status !== 204 && status !== 200 && status !== 404) throw new Error(`Graph answered ${status}`);
        },
      });
    }
  }
  for (const entry of (await graph.catalogApps({ externalId: appId })).filter((a) => a.externalId === appId)) {
    plan.steps.push({
      what: `delete the Teams catalog entry ${entry.id} (${entry.displayName ?? 'unnamed'}, the run's bot ${appId})`,
      run: async () => {
        const status = await graphDelete(deps, token.reveal(), `/appCatalogs/teamsApps/${encodeURIComponent(entry.id)}`);
        if (status !== 204 && status !== 200 && status !== 404) throw new Error(`Graph answered ${status}`);
      },
    });
  }
}

async function planFor(run: Run, deps: ProofDeps): Promise<TeardownPlan> {
  const plan: TeardownPlan = { steps: [], byHand: [], leftAlone: [] };
  await planGitHub(run, deps, plan);
  await planJira(run, deps, plan);
  await planSlack(run, deps, plan);
  await planTeams(run, deps, plan);
  const { root } = run.proof;
  plan.steps.push({
    what: `delete the proof directory ${root} (the run's .env, state, map and config, and the packed CLI)`,
    run: () => rm(root, { recursive: true, force: true }),
  });
  return plan;
}

/** Everything the teardown would do, read from the run; nothing is deleted here. */
export async function planTeardown(proof: ProofDir, deps: ProofDeps): Promise<TeardownPlan> {
  return planFor(await loadRun(proof, deps), deps);
}

/** Lists every deletion, asks unless `yes`, deletes in order, and lists what is left. 0 when every deletion worked. */
export async function runTeardown(proof: ProofDir, deps: ProofDeps, options: { yes: boolean }): Promise<number> {
  const run = await loadRun(proof, deps);
  const plan = await planFor(run, deps);
  run.say(`Teardown of ${proof.root} will:`);
  plan.steps.forEach((s, i) => run.say(`  ${i + 1}. ${s.what}`));
  if (plan.leftAlone.length > 0) {
    run.say('Left alone:');
    for (const l of plan.leftAlone) run.say(`  - ${l}`);
  }
  if (!options.yes) {
    const n = plan.steps.length;
    const answer = (await deps.prompter.line(`Go ahead with ${n === 1 ? 'this step' : `these ${n} steps`}? Type yes to go on: `))?.trim().toLowerCase();
    if (answer !== 'yes' && answer !== 'y') {
      run.say(answer === undefined ? 'Nothing was deleted: there was no terminal to confirm on. Pass --yes to go ahead without asking.' : 'Nothing was deleted.');
      return 1;
    }
  }
  let failed = 0;
  for (const s of plan.steps) {
    if (failed > 0 && s === plan.steps.at(-1)) {
      run.say(`kept ${proof.root}: a deletion failed, and a rerun of --teardown reads its ids from there`);
      break;
    }
    try {
      await s.run();
      run.say(`done  ${s.what}`);
    } catch (e) {
      failed += 1;
      run.say(`FAIL  ${s.what}: ${reason(e)}`);
    }
  }
  if (plan.byHand.length > 0) {
    run.say('Only you can remove these:');
    for (const l of plan.byHand) run.say(`  - ${l}`);
  }
  run.say(failed === 0 ? 'Teardown finished.' : `Teardown finished with ${failed} failed deletion${failed === 1 ? '' : 's'}.`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------
// The run: pack, onboard in an empty directory, check
// ---------------------------------------------------------------------------------------------------

/** What the shell may pass to the interview: nothing that could carry a token or a Snapwing setting. */
const KEPT_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|TERM_PROGRAM|LANG|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|SYSTEMROOT|SystemRoot|APPDATA|LOCALAPPDATA|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS)$/;

/** The environment `npx` and the interview get: the kept variables and an npm cache inside the proof directory. */
export function proofEnv(root: string, from: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && KEPT_ENV.test(k)) env[k] = v;
  return {
    ...env,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
  };
}

function capture(cmd: string, args: readonly string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
  });
}

const npxArgs = (marker: ProofMarker, ...args: string[]): string[] => ['--yes', '-p', marker.tarballs.pipeline, '-p', marker.tarballs.app, 'snapwing', ...args];

/** `snapwing config check` from the packed CLI, in the work directory. */
async function packedConfigCheck(proof: ProofDir): Promise<{ code: number; output: string }> {
  const r = await capture('npx', npxArgs(proof.marker, 'config', 'check'), proof.work, proofEnv(proof.root));
  return { code: r.code, output: `${r.stdout}\n${r.stderr}` };
}

/** Runs `snapwing onboard` with the terminal attached; Ctrl-C goes to the interview, which saves and stops. */
function attachedOnboard(proof: ProofDir, answers: string): Promise<number> {
  return new Promise((done) => {
    const ignore = (): void => undefined;
    process.on('SIGINT', ignore);
    const child = spawn('npx', npxArgs(proof.marker, 'onboard', '--answers', answers), { cwd: proof.work, env: proofEnv(proof.root), stdio: 'inherit' });
    const finish = (code: number): void => {
      process.off('SIGINT', ignore);
      done(code);
    };
    child.on('error', () => finish(1));
    child.on('exit', (code, signal) => finish(code ?? (signal === null ? 1 : 130)));
  });
}

/** The controlling terminal, opened at once so a missing one is no answer rather than a late error. */
function openTty(): Readable | undefined {
  try {
    return createReadStream('/dev/tty', { fd: openSync('/dev/tty', 'r') });
  } catch {
    return undefined;
  }
}

function defaultDeps(): ProofDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    say: (line) => console.log(line),
    prompter: terminalPrompter({ stdin: process.stdin, stderr: process.stderr, openTty }),
    now: () => new Date(),
    stateEnv: {},
    configCheck: packedConfigCheck,
  };
}

export interface MainDeps {
  /** Where `.env.onboard` is read; default the repository root. */
  readonly onboardEnvPath?: string;
  /** Output; default stdout for lines and stderr for problems. */
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly proof?: Partial<ProofDeps>;
}

async function proofDirFor(dir: string | undefined, err: (line: string) => void): Promise<ProofDir | undefined> {
  const root = dir === undefined ? await newestProofDir() : resolve(dir);
  if (root === undefined) {
    err(`onboard:proof: no proof directory under ${tmpdir()}; pass --dir <path>.`);
    return undefined;
  }
  try {
    return await readProofDir(root);
  } catch (e) {
    err(`onboard:proof: ${reason(e)}`);
    return undefined;
  }
}

export async function main(argv: readonly string[], mainDeps: MainDeps = {}): Promise<number> {
  const out = mainDeps.out ?? ((l: string) => console.log(l));
  const err = mainDeps.err ?? ((l: string) => console.error(l));
  let values: { platform?: string | undefined; dir?: string | undefined; check?: boolean | undefined; teardown?: boolean | undefined; yes?: boolean | undefined; help?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv].filter((a) => a !== '--'),
      allowPositionals: false,
      options: { platform: { type: 'string' }, dir: { type: 'string' }, check: { type: 'boolean' }, teardown: { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (e) {
    err(`onboard:proof: ${reason(e)}\n${USAGE}`);
    return 1;
  }
  if (values.help === true) {
    out(USAGE);
    return 0;
  }
  if (values.platform !== undefined && !PLATFORMS.includes(values.platform as Platform)) {
    err(`onboard:proof: --platform must be slack, teams, or both\n${USAGE}`);
    return 1;
  }
  if (values.check === true && values.teardown === true) {
    err(`onboard:proof: --check and --teardown do not go together\n${USAGE}`);
    return 1;
  }
  const deps: ProofDeps = { ...defaultDeps(), say: out, ...mainDeps.proof };

  if (values.teardown === true || values.check === true) {
    const proof = await proofDirFor(values.dir, err);
    if (proof === undefined) return 1;
    out(`Proof directory: ${proof.root} (${proof.marker.platform}, made ${proof.marker.createdAt})`);
    if (values.teardown === true) return runTeardown(proof, deps, { yes: values.yes === true });
    return (await runChecks(proof, deps)).every((l) => l.ok) ? 0 : 1;
  }

  // ---- the run --------------------------------------------------------------------------------------
  let proof: ProofDir;
  if (values.dir !== undefined) {
    const found = await proofDirFor(values.dir, err);
    if (found === undefined) return 1;
    if (values.platform !== undefined && values.platform !== found.marker.platform) {
      err(`onboard:proof: ${found.root} is a ${found.marker.platform} proof; leave out --platform or make a new one.`);
      return 1;
    }
    proof = found;
    out(`Picking up the proof in ${proof.root} (${proof.marker.platform}), with the CLI packed then.`);
  } else {
    const platform = (values.platform ?? 'slack') as Platform;
    const { sandbox, problems } = sandboxFrom(await readOnboardEnv(mainDeps.onboardEnvPath ?? join(REPO_ROOT, ONBOARD_ENV_FILE)), platform);
    if (sandbox === undefined) {
      for (const p of problems) err(`onboard:proof: ${p}`);
      return 1;
    }
    const root = await mkdtemp(join(tmpdir(), PROOF_DIR_PREFIX));
    out(`Packing the CLI (scripts/pack-cli.mjs) into ${join(root, 'tarballs')}...`);
    const packed = await capture('node', [PACK_SCRIPT, '--out', join(root, 'tarballs'), '--json'], REPO_ROOT, proofEnv(root));
    if (packed.code !== 0) {
      err(`onboard:proof: packing failed: ${packed.stderr.trim() || `exit ${packed.code}`}`);
      return 1;
    }
    const tarballs = JSON.parse(packed.stdout) as { pipeline: string; app: string };
    proof = await writeProofDir(root, { kind: MARKER_KIND, version: 1, platform, createdAt: new Date().toISOString(), sandbox, tarballs });
    out(`Proof directory: ${root}`);
  }
  const { sandbox, platform } = proof.marker;
  const answers = join(proof.root, 'answers.json');
  await writeFile(answers, `${JSON.stringify(answersFor(sandbox), null, 2)}\n`, { mode: 0o600 });
  out(`Sandboxes: Jira ${sandbox.jiraSite} (${sandbox.jiraProject}), GitHub ${sandboxRepo(sandbox)}${sandbox.slackWorkspace === undefined ? '' : `, Slack ${sandbox.slackWorkspace}`}${sandbox.teams === undefined ? '' : `, Teams ${sandbox.teams.team}`}.`);
  out(`Running snapwing onboard from the packed CLI in ${proof.work}. Answer at the keyboard; the sandbox names and ids are filled in from ${ONBOARD_ENV_FILE}.`);
  const code = await attachedOnboard(proof, answers);
  if (code !== 0) {
    out(`snapwing onboard stopped with exit ${code}. Once whatever it waits on is done, pick it up with: pnpm onboard:proof --dir ${proof.root}`);
    out(`To remove what it made so far: pnpm onboard:proof --teardown --dir ${proof.root}`);
    return code;
  }
  out(`Onboarding finished. Checking the ${platform} proof:`);
  const ok = (await runChecks(proof, deps)).every((l) => l.ok);
  out(`When you are done: pnpm onboard:proof --teardown --dir ${proof.root}`);
  return ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`onboard:proof: ${reason(e)}`);
      process.exit(1);
    },
  );
}
