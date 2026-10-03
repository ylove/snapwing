// `pnpm jira:bootstrap` (main 14.4, B 7.2): idempotent setup of the Jira project the live tier uses.
//   default run (needs only JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY):
//     0. refuse a team-managed project (`style: next-gen`) up front: its screens are not in the REST API
//        (HTTP 400 "Screen with id ... does not exist"), so the run asks for a company-managed one
//     1. find-or-create the custom fields Implementation Prompt, Conversation Link, Autonomy Level,
//        Agent Status, and put them on the project's screens
//     2. write their ids into .env.live (JIRA_FIELD_*), preserving every other line
//     3. map the logical lifecycle targets (backlog, in-progress, in-review, done) to the project's
//        statuses by category, as the projector does (#268), with the <jira><status/></jira> overrides of
//        snapwing.config.xml (`--config <path>`, default snapwing.config.xml, when it exists); print the
//        mapping, or exit non-zero naming the project's statuses
//   `pnpm jira:bootstrap webhook` (also needs SNAPWING_PUBLIC_URL): register the webhook at
//     $SNAPWING_PUBLIC_URL/webhooks/jira for jira:issue_updated and comment_created, filtered to the project,
//     through the admin API (/rest/webhooks/1.0/webhook). With JIRA_WEBHOOK_SECRET set the URL carries
//     `?secret=<secret>` (the inbound route's check for unsigned REST webhooks); the secret is never printed.
//   `--dry-run` prints the plan and writes nothing (no Jira writes, no .env.live write).
// Reads .env.live (then the process environment), never prints a secret, one line per check.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadAppConfig } from '../packages/pipeline/src/config/app-config.ts';
import {
  describeJiraStatuses,
  describeJiraStatusMapping,
  resolveJiraStatuses,
  type JiraStatusOverrides,
} from '../packages/pipeline/src/jira/statuses.ts';
import { createJiraClientFromSecrets, JiraNotFoundError, type JiraClient, type JiraField } from '../packages/app/src/jira/client/index.ts';

export const REQUIRED_ENV = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'] as const;
export const DEFAULT_CONFIG_PATH = 'snapwing.config.xml';
export const WEBHOOK_EVENTS = ['jira:issue_updated', 'comment_created'] as const;
export const WEBHOOK_PATH = '/webhooks/jira';
/**
 * The admin webhook API. `/rest/api/3/webhook` answers 403 "Only Connect and OAuth 2.0 apps can use this
 * operation" to an API token (checked against a live site, #155), so Snapwing uses this one.
 */
export const WEBHOOK_API = '/rest/webhooks/1.0/webhook';
export const WEBHOOK_FILTER_KEY = 'issue-related-events-section';
export const WEBHOOK_NAME = 'Snapwing';
const CF = 'com.atlassian.jira.plugin.system.customfieldtypes';

export interface FieldSpec {
  name: string;
  envKey: string;
  type: string;
  searcherKey: string;
  description: string;
}

export const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'Implementation Prompt', envKey: 'JIRA_FIELD_IMPL_PROMPT', type: `${CF}:textarea`, searcherKey: `${CF}:textsearcher`, description: 'Snapwing: the implementation request handed to the coding agent.' },
  { name: 'Conversation Link', envKey: 'JIRA_FIELD_CONVERSATION', type: `${CF}:url`, searcherKey: `${CF}:exacttextsearcher`, description: 'Snapwing: deep link to the conversation that raised this issue.' },
  { name: 'Autonomy Level', envKey: 'JIRA_FIELD_AUTONOMY', type: `${CF}:float`, searcherKey: `${CF}:exactnumber`, description: 'Snapwing: autonomy level 0 to 3 for this issue.' },
  { name: 'Agent Status', envKey: 'JIRA_FIELD_AGENT_STATUS', type: `${CF}:textfield`, searcherKey: `${CF}:textsearcher`, description: 'Snapwing: one-line agent status, filterable in JQL.' },
];

export interface BootstrapOptions {
  /** Merged env: `.env.live` values over the process environment. */
  env: Readonly<Record<string, string | undefined>>;
  mode?: 'fields' | 'webhook';
  dryRun?: boolean;
  /** Path of the env file to update. Defaults to `.env.live`. */
  envFilePath?: string;
  /** snapwing.config.xml, read for its `<jira>` status overrides when the file exists. Defaults to `snapwing.config.xml`. */
  configPath?: string;
  /** The webhook's name in Jira; the live tier uses its own so it never touches the real one. Defaults to `Snapwing`. */
  webhookName?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** One line. */
  message?: string;
}

export interface BootstrapReport {
  ok: boolean;
  mode: 'fields' | 'webhook';
  dryRun: boolean;
  checks: CheckResult[];
  warnings: string[];
  /** Full output: the first line says what the run needs, the last line says what to do next. */
  lines: string[];
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

/** Set KEY=value lines, replacing an existing assignment in place and appending the rest. Every other line is kept byte for byte. */
export function updateEnvText(text: string, updates: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(updates));
  const lines = text === '' ? [] : text.split('\n');
  const out = lines.map((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(line);
    const key = m?.[2];
    if (m && key !== undefined && pending.has(key)) {
      const value = pending.get(key) ?? '';
      pending.delete(key);
      return `${m[1]}${key}${m[3]}${value}`;
    }
    return line;
  });
  if (pending.size > 0) {
    if (out.length > 0 && out[out.length - 1] === '') out.pop();
    for (const [k, v] of pending) out.push(`${k}=${v}`);
    out.push('');
  }
  return out.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const NEXT_WEBHOOK =
  'next: once the tunnel is up, set SNAPWING_PUBLIC_URL in .env.live and run pnpm jira:bootstrap webhook';
const NEXT_AFTER_WEBHOOK = 'next: the Jira side is ready; continue with the remaining steps of issue #2';
const NEXT_FIX = 'next: fix the FAIL lines above, then run the same command again (it is safe to re-run)';

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapReport> {
  const env = opts.env;
  const mode = opts.mode ?? 'fields';
  const dryRun = opts.dryRun === true;
  const envFilePath = opts.envFilePath ?? '.env.live';
  const checks: CheckResult[] = [];
  const warnings: string[] = [];
  const plan: string[] = [];

  const required: string[] = mode === 'webhook' ? [...REQUIRED_ENV, 'SNAPWING_PUBLIC_URL'] : [...REQUIRED_ENV];
  const header = `needs: ${required.join(', ')} in .env.live${dryRun ? ' (dry run: nothing will be written)' : ''}`;

  const email = env['JIRA_EMAIL'] ?? '';
  const apiToken = env['JIRA_API_TOKEN'] ?? '';
  const secrets = [email, apiToken, env['JIRA_WEBHOOK_SECRET'] ?? '', Buffer.from(`${email}:${apiToken}`).toString('base64')].filter((s) => s.length > 3);
  const scrub = (s: string): string => {
    let out = oneLine(s);
    for (const secret of secrets) out = out.split(secret).join('[secret]');
    return out;
  };
  const finish = (): BootstrapReport => {
    const ok = checks.every((c) => c.ok);
    const lines = [header];
    for (const c of checks) {
      lines.push(c.ok ? `ok   ${c.name}${c.message ? `: ${c.message}` : ''}` : `FAIL ${c.name}: ${c.message ?? 'failed'}`);
    }
    for (const p of plan) lines.push(`plan ${p}`);
    for (const w of warnings) lines.push(`warn ${w}`);
    lines.push(!ok ? NEXT_FIX : mode === 'webhook' ? NEXT_AFTER_WEBHOOK : NEXT_WEBHOOK);
    return { ok, mode, dryRun, checks, warnings, lines };
  };

  const missing = required.filter((k) => (env[k] ?? '') === '');
  if (missing.length > 0) {
    checks.push({ name: 'env', ok: false, message: `missing ${missing.join(', ')}; add them to .env.live (issue #2 step 4 lists them)` });
    return finish();
  }
  const baseUrl = (env['JIRA_BASE_URL'] ?? '').replace(/\/+$/, '');
  const projectKey = env['JIRA_PROJECT_KEY'] ?? '';
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));

  const client: JiraClient = await createJiraClientFromSecrets(
    { get: (name) => Promise.resolve(env[name] ?? '') },
    opts.fetch ? { fetch: opts.fetch } : {},
  );

  // The client does not cover screens or webhooks; these calls share its auth.
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  async function raw(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authorization, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`jira request failed: ${method} ${path}`);
    }
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' (check JIRA_EMAIL and JIRA_API_TOKEN, and that the account is a site admin)'
          : res.status === 404
            ? ' (check JIRA_BASE_URL and JIRA_PROJECT_KEY)'
            : '';
      throw new Error(`jira ${method} ${path} returned HTTP ${res.status}${hint}`);
    }
    const text = await res.text();
    return text === '' ? {} : (JSON.parse(text) as unknown);
  }

  const run = async (name: string, fn: () => Promise<string | undefined>): Promise<void> => {
    try {
      const note = await fn();
      checks.push(note === undefined ? { name, ok: true } : { name, ok: true, message: note });
    } catch (err) {
      checks.push({ name, ok: false, message: scrub(err instanceof Error ? err.message : String(err)) });
    }
  };

  await run('credentials', async () => {
    const me = await client.myself();
    return `authenticated as ${me.displayName ?? 'the Jira account'}`;
  });
  if (!checks.every((c) => c.ok)) return finish();

  if (mode === 'webhook') {
    const publicUrl = (env['SNAPWING_PUBLIC_URL'] ?? '').replace(/\/+$/, '');
    const url = `${publicUrl}${WEBHOOK_PATH}`;
    const jqlFilter = `project = ${projectKey}`;
    await run('webhook', async () => {
      if (!/^https:\/\//.test(publicUrl)) throw new Error('SNAPWING_PUBLIC_URL must be an https URL (Jira only delivers to https)');
      const secret = env['JIRA_WEBHOOK_SECRET'] ?? '';
      // REST-registered webhooks are not signed, so the inbound route takes the secret as ?secret= (#143).
      const fullUrl = secret === '' ? url : `${url}?secret=${encodeURIComponent(secret)}`;
      const shown = secret === '' ? url : `${url} (with ?secret)`;
      const webhookName = opts.webhookName ?? WEBHOOK_NAME;
      const list = await raw('GET', WEBHOOK_API);
      const all = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
      // The admin API lists each webhook's URL, so an identical one is left alone and any other one of ours is replaced.
      const ours = all.filter((w) => w['name'] === webhookName && asRecord(w['filters'])[WEBHOOK_FILTER_KEY] === jqlFilter && typeof w['id'] === 'number');
      const same = ours.find((w) => w['url'] === fullUrl && w['enabled'] !== false);
      const stale = ours.filter((w) => w !== same).map((w) => w['id'] as number);
      if (dryRun) {
        if (same) plan.push(`keep the webhook already registered for ${shown}`);
        else {
          if (stale.length > 0) plan.push(`replace ${stale.length} existing Snapwing webhook(s) filtered to ${jqlFilter}`);
          plan.push(`register webhook ${shown} for ${WEBHOOK_EVENTS.join(', ')} filtered to ${jqlFilter}`);
        }
        return 'plan only';
      }
      for (const id of stale) await raw('DELETE', `${WEBHOOK_API}/${String(id)}`);
      if (same) return `already registered ${shown}`;
      await raw('POST', WEBHOOK_API, {
        name: webhookName,
        url: fullUrl,
        events: [...WEBHOOK_EVENTS],
        filters: { [WEBHOOK_FILTER_KEY]: jqlFilter },
        excludeBody: false,
      });
      return `${stale.length > 0 ? 'replaced' : 'registered'} ${shown}`;
    });
    return finish();
  }

  // ---- project ----------------------------------------------------------------------------------
  await run('project', async () => {
    const project = await client.getProject(projectKey).catch((err: unknown) => {
      throw err instanceof JiraNotFoundError ? new Error(`no project ${projectKey} (check JIRA_PROJECT_KEY)`) : err;
    });
    if (project.style === 'next-gen' || project.simplified === true) {
      throw new Error(`${projectKey} is a team-managed project, which Snapwing cannot set up; create a company-managed project and set JIRA_PROJECT_KEY to its key`);
    }
    return `${projectKey} is company-managed`;
  });
  if (!checks.every((c) => c.ok)) return finish();

  // ---- fields ---------------------------------------------------------------------------------
  const ids: Record<string, string> = {};
  await run('fields', async () => {
    const existing: JiraField[] = await client.listFields();
    const notes: string[] = [];
    for (const spec of FIELD_SPECS) {
      const found = existing.filter((f) => f.custom && f.name === spec.name);
      const sameType = found.find((f) => f.schema?.custom === spec.type);
      if (found.length > 0 && !sameType) {
        throw new Error(
          `custom field "${spec.name}" exists with a different type (${found[0]?.schema?.custom ?? 'unknown'}); rename or delete it in Jira so Snapwing can create it as ${spec.type.split(':')[1]}`,
        );
      }
      if (sameType) {
        ids[spec.envKey] = sameType.id;
        notes.push(`${spec.name} found`);
      } else if (dryRun) {
        plan.push(`create custom field ${spec.name} (${spec.type.split(':')[1]})`);
        notes.push(`${spec.name} would be created`);
      } else {
        const created = await client.createField({ name: spec.name, description: spec.description, type: spec.type, searcherKey: spec.searcherKey });
        ids[spec.envKey] = created.id;
        notes.push(`${spec.name} created`);
      }
    }
    return notes.join(', ');
  });

  await run('screens', async () => {
    const screens: { id: number; name: string }[] = [];
    for (let startAt = 0; ; ) {
      const page = asRecord(await raw('GET', `/rest/api/3/screens?maxResults=100&startAt=${startAt}`));
      const values = Array.isArray(page['values']) ? (page['values'] as Record<string, unknown>[]) : [];
      for (const v of values) if (typeof v['id'] === 'number' && typeof v['name'] === 'string') screens.push({ id: v['id'], name: v['name'] });
      startAt += values.length;
      if (page['isLast'] === true || values.length === 0) break;
    }
    const prefix = `${projectKey.toLowerCase()}:`;
    const mine = screens.filter((s) => s.name.toLowerCase().startsWith(prefix) || s.name === 'Default Issue Screen');
    if (mine.length === 0) {
      warnings.push(`no screens found for project ${projectKey}; add the four custom fields to its screens by hand`);
      return 'no project screens found';
    }
    let added = 0;
    for (const screen of mine) {
      const tabs = await raw('GET', `/rest/api/3/screens/${screen.id}/tabs`);
      const tabList = Array.isArray(tabs) ? (tabs as Record<string, unknown>[]) : [];
      const firstTab = tabList[0]?.['id'];
      if (typeof firstTab !== 'number') continue;
      const onScreen = new Set<string>();
      for (const t of tabList) {
        const fields = await raw('GET', `/rest/api/3/screens/${screen.id}/tabs/${String(t['id'])}/fields`);
        for (const f of Array.isArray(fields) ? (fields as Record<string, unknown>[]) : []) {
          if (typeof f['id'] === 'string') onScreen.add(f['id']);
        }
      }
      for (const spec of FIELD_SPECS) {
        const id = ids[spec.envKey];
        if (id !== undefined && onScreen.has(id)) continue;
        if (dryRun) {
          plan.push(`add ${spec.name} to screen "${screen.name}"`);
        } else if (id !== undefined) {
          await raw('POST', `/rest/api/3/screens/${screen.id}/tabs/${String(firstTab)}/fields`, { fieldId: id });
          added += 1;
        }
      }
    }
    return dryRun ? `${mine.length} screen(s) inspected` : `${mine.length} screen(s) inspected, ${added} field placement(s) added`;
  });

  await run('env-file', async () => {
    const before = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
    const current = parseEnvFile(before);
    const changed = Object.entries(ids).filter(([k, v]) => current[k] !== v);
    if (changed.length === 0) return Object.keys(ids).length === 0 ? 'nothing to write yet' : 'already up to date';
    if (dryRun) {
      for (const [k, v] of changed) plan.push(`write ${k}=${v} to ${envFilePath}`);
      return `${changed.length} line(s) would change`;
    }
    writeFileSync(envFilePath, updateEnvText(before, ids));
    return `wrote ${changed.map(([k]) => k).join(', ')}`;
  });

  let overrides: JiraStatusOverrides = {};
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  if (existsSync(configPath)) {
    await run('config', async () => {
      overrides = loadAppConfig(readFileSync(configPath, 'utf8')).jira.statuses;
      const named = Object.keys(overrides);
      return named.length === 0 ? `${configPath} names no Jira status` : `${configPath} names the status for ${named.join(', ')}`;
    });
  }

  await run('workflow', async () => {
    const statuses = await client.projectStatuses(projectKey);
    const mapping = resolveJiraStatuses(statuses, overrides);
    if (mapping.problems.length > 0) {
      throw new Error(
        `cannot map ${mapping.problems.join('; ')}; ${projectKey}'s statuses: ${describeJiraStatuses(statuses)}; add a status in Project settings, Workflow, or name one with <jira><status logical="..." name="..."/></jira> in ${configPath}`,
      );
    }
    return describeJiraStatusMapping(mapping);
  });

  return finish();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const mode = args.includes('webhook') ? 'webhook' : 'fields';
  const at = args.indexOf('--config');
  const configPath = at === -1 ? undefined : args[at + 1];
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(readFileSync('.env.live', 'utf8'));
  } catch {
    // No .env.live: the missing-values line says what to add.
  }
  const report = await runBootstrap({ env: { ...process.env, ...fileEnv }, mode, dryRun, ...(configPath === undefined ? {} : { configPath }) });
  for (const line of report.lines) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
