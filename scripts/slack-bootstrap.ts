// `pnpm slack:bootstrap` (main 14.4, 15.1, 22.4): idempotent, read-only checks of the Slack app.
//   1. the manifest in manifests/slack/manifest.yaml validates (apps.manifest.validate, SLACK_CONFIG_TOKEN)
//   2. the installed app has every manifest bot scope (auth.test x-oauth-scopes header, SLACK_BOT_TOKEN)
//   3. Socket Mode connects (apps.connections.open, SLACK_APP_TOKEN)
//   4. other bot users named Snapwing are listed as a warning (D6; never a hard stop)
// Reads .env.live (then the process environment), never prints a token, and exits non-zero with one
// line per failed check.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SLACK_SHORTCUT_CALLBACK_ID } from '../packages/app/src/adapters/slack/normalize.ts';

export const DEFAULT_MANIFEST_PATH = new URL('../manifests/slack/manifest.yaml', import.meta.url);
const DEFAULT_API_BASE = 'https://slack.com/api';
const APP_NAME = 'Snapwing';

export interface BootstrapOptions {
  manifestPath?: string | URL;
  /** Merged env: `.env.live` values over the process environment. */
  env: Readonly<Record<string, string | undefined>>;
  apiBase?: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** One line. Present on failure; may carry a note on success. */
  message?: string;
}

export interface BootstrapReport {
  ok: boolean;
  checks: CheckResult[];
  warnings: string[];
}

interface Manifest {
  display_information?: { name?: string };
  features?: { shortcuts?: { type?: string; callback_id?: string }[] };
  oauth_config?: { scopes?: { bot?: string[] } };
  settings?: { socket_mode_enabled?: boolean };
}

/** Parse KEY=VALUE lines (optional `export`, quotes, `#` comments). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    out[m[1] ?? ''] = value;
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Remove anything that looks like a Slack token from text bound for output. */
function scrub(s: string, secrets: readonly (string | undefined)[]): string {
  let out = oneLine(s).replace(/xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, '[token]');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[token]');
  return out;
}

interface SlackReply {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

async function callSlack(
  url: string,
  init: { token: string; form?: Record<string, string> },
): Promise<{ body: SlackReply; headers: Headers }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${init.token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(init.form ?? {}).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as SlackReply;
  return { body, headers: res.headers };
}

function loadManifest(path: string | URL): Manifest {
  const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest is not a mapping');
  return parsed as Manifest;
}

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapReport> {
  const env = opts.env;
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const secrets = [env['SLACK_CONFIG_TOKEN'], env['SLACK_BOT_TOKEN'], env['SLACK_APP_TOKEN']];
  const checks: CheckResult[] = [];
  const warnings: string[] = [];

  const run = async (name: string, fn: () => Promise<string | undefined>): Promise<void> => {
    try {
      const note = await fn();
      checks.push(note === undefined ? { name, ok: true } : { name, ok: true, message: note });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      checks.push({ name, ok: false, message: scrub(reason, secrets) });
    }
  };
  const need = (key: string): string => {
    const v = env[key];
    if (v === undefined || v === '') throw new Error(`${key} is not set`);
    return v;
  };

  let manifest: Manifest | undefined;
  let manifestJson = '';

  await run('manifest-file', async () => {
    manifest = loadManifest(opts.manifestPath ?? DEFAULT_MANIFEST_PATH);
    manifestJson = JSON.stringify(manifest);
    if (manifest.display_information?.name !== APP_NAME) throw new Error(`manifest display name must be ${APP_NAME}`);
    const shortcut = manifest.features?.shortcuts?.find((s) => s.type === 'message');
    if (shortcut?.callback_id !== SLACK_SHORTCUT_CALLBACK_ID) {
      throw new Error(`manifest message shortcut callback_id must be ${SLACK_SHORTCUT_CALLBACK_ID}`);
    }
    return undefined;
  });

  await run('manifest-validate', async () => {
    if (manifest === undefined) throw new Error('skipped, manifest file check failed');
    const { body } = await callSlack(`${base}/apps.manifest.validate`, {
      token: need('SLACK_CONFIG_TOKEN'),
      form: { manifest: manifestJson },
    });
    if (!body.ok) {
      const errors = Array.isArray(body['errors'])
        ? (body['errors'] as { message?: string; pointer?: string }[])
            .map((e) => `${e.pointer ?? ''} ${e.message ?? ''}`.trim())
            .join('; ')
        : '';
      throw new Error(`apps.manifest.validate rejected the manifest: ${body.error ?? 'unknown'}${errors ? ` (${errors})` : ''}`);
    }
    return undefined;
  });

  let ownUserId: string | undefined;
  await run('scopes', async () => {
    if (manifest === undefined) throw new Error('skipped, manifest file check failed');
    const { body, headers } = await callSlack(`${base}/auth.test`, { token: need('SLACK_BOT_TOKEN') });
    if (!body.ok) throw new Error(`auth.test failed: ${body.error ?? 'unknown'}`);
    if (typeof body['user_id'] === 'string') ownUserId = body['user_id'];
    const header = headers.get('x-oauth-scopes');
    if (header === null) throw new Error('auth.test returned no x-oauth-scopes header');
    const installed = new Set(header.split(',').map((s) => s.trim()).filter((s) => s !== ''));
    const missing = (manifest.oauth_config?.scopes?.bot ?? []).filter((s) => !installed.has(s));
    if (missing.length > 0) throw new Error(`installed app is missing scopes: ${missing.join(', ')}`);
    return undefined;
  });

  await run('socket-mode', async () => {
    const { body } = await callSlack(`${base}/apps.connections.open`, { token: need('SLACK_APP_TOKEN') });
    if (!body.ok) throw new Error(`apps.connections.open failed: ${body.error ?? 'unknown'}`);
    return undefined;
  });

  // D6: duplicate bots are a warning, never a failure.
  try {
    const botToken = need('SLACK_BOT_TOKEN');
    const found: string[] = [];
    let cursor = '';
    do {
      const { body } = await callSlack(`${base}/users.list`, {
        token: botToken,
        form: { limit: '200', ...(cursor ? { cursor } : {}) },
      });
      if (!body.ok) throw new Error(`users.list failed: ${body.error ?? 'unknown'}`);
      const members = Array.isArray(body['members']) ? (body['members'] as Record<string, unknown>[]) : [];
      for (const m of members) {
        if (m['is_bot'] !== true || m['deleted'] === true || m['id'] === ownUserId) continue;
        const profile = (m['profile'] ?? {}) as Record<string, unknown>;
        const names = [m['name'], m['real_name'], profile['display_name'], profile['real_name']];
        if (names.some((n) => typeof n === 'string' && n.toLowerCase() === APP_NAME.toLowerCase())) {
          found.push(String(m['id']));
        }
      }
      const meta = (body['response_metadata'] ?? {}) as Record<string, unknown>;
      cursor = typeof meta['next_cursor'] === 'string' ? meta['next_cursor'] : '';
    } while (cursor !== '');
    if (found.length > 0) {
      warnings.push(`another bot user named ${APP_NAME} already exists (${found.join(', ')}); one install per workspace`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`could not check for duplicate ${APP_NAME} bots: ${scrub(reason, secrets)}`);
  }

  return { ok: checks.every((c) => c.ok), checks, warnings };
}

export function formatReport(report: BootstrapReport): string[] {
  const lines: string[] = [];
  for (const c of report.checks) lines.push(c.ok ? `ok   ${c.name}` : `FAIL ${c.name}: ${c.message ?? 'failed'}`);
  for (const w of report.warnings) lines.push(`warn ${w}`);
  return lines;
}

async function main(): Promise<void> {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(readFileSync('.env.live', 'utf8'));
  } catch {
    // No .env.live: fall back to the process environment.
  }
  const report = await runBootstrap({ env: { ...process.env, ...fileEnv } });
  for (const line of formatReport(report)) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
