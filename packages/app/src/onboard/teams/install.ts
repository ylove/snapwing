// The Teams bootstrap (main 14.4, 15.2, 22.4), shared by `pnpm teams:bootstrap` (`scripts/teams-bootstrap.ts`,
// a thin wrapper over this file) and the Teams onboarding step.
//   - `signInByDeviceCode`: the team owner signs in with the Microsoft device authorization grant (print a
//     code and an address, poll the token endpoint). The token comes back as a `SecretValue`.
//   - `installTeamsApp`: finds or publishes the package in the tenant catalog (uploading a newer version over
//     an older one), installs it in the team with the manifest's RSC permissions consented, then reads the
//     team's grants and reports `full` or `reduced`, the same words as kv `teams-mode:{teamId}`. When the
//     tenant forbids custom app upload or install, it returns the admin center steps instead of failing.
//   - `inspectTeamsInstall`: the read-only half (is it installed, which grants are missing, who else is named
//     Snapwing). Another app named Snapwing is a warning, never a stop.
//   - `runTeamsBootstrap`: idempotent checks for `pnpm teams:bootstrap`, one line each, never a secret.
// A token or the app password is never printed, logged, or put in an error message.

import { readFileSync } from 'node:fs';
import { assetPath } from '@snapwing/pipeline/util/assets.ts';
import { createBotTokenSource, createGraphTokenSource, MICROSOFT_LOGIN_HOST } from '../../adapters/teams/auth.ts';
import type { TeamsMode } from '../../adapters/teams/conversations.ts';
import {
  createTeamsGraph,
  GraphPermissionError,
  type GraphInstalledApp,
  type GraphTeamsApp,
  type TeamsGraph,
} from '../../adapters/teams/graph.ts';
import { TEAMS_MESSAGES_PATH, TEAMS_REQUIRED_RSC } from '../../adapters/teams/transport.ts';
import { SecretValue } from '../interview/io.ts';
import { updateEnvText } from '../jira/bootstrap.ts';
import { buildTeamsPackage } from './package.ts';

export const TEAMS_APP_NAME = 'Snapwing';
/** The app version in the package. Raise it whenever `manifests/teams/manifest.json` changes: Teams refuses a changed manifest at the same version. */
export const TEAMS_APP_VERSION = '1.0.0';
/** What the team owner consents to in the device code sign-in (delegated Graph permissions). */
export const OWNER_SIGN_IN_SCOPES: readonly string[] = [
  'AppCatalog.Submit',
  'TeamsAppInstallation.ReadWriteForTeam',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'TeamSettings.Read.All',
];

// ---------------------------------------------------------------------------------------------------------
// Device code sign-in
// ---------------------------------------------------------------------------------------------------------

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
}

export interface DeviceCodeOptions {
  tenantId: string;
  /** The app (client) id the owner signs in to; it must allow public client flows. */
  clientId: string;
  scopes?: readonly string[];
  /** Shows the installer the code and the address. */
  prompt: (p: DeviceCodePrompt) => void;
  fetch?: typeof fetch;
  loginHost?: string;
  /** Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Why a sign-in did not finish: Entra's error code only, never a token. */
export class DeviceCodeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`device code sign-in failed: ${code}`);
    this.name = 'DeviceCodeError';
    this.code = code;
  }
}

async function postForm(doFetch: typeof fetch, url: string, form: Record<string, string>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new DeviceCodeError('network');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { ok: res.ok, body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {} };
}

/** Signs the team owner in by the device authorization grant and returns the access token as a secret. */
export async function signInByDeviceCode(options: DeviceCodeOptions): Promise<SecretValue> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const host = (options.loginHost ?? MICROSOFT_LOGIN_HOST).replace(/\/+$/, '');
  const base = `${host}/${encodeURIComponent(options.tenantId)}/oauth2/v2.0`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const scope = (options.scopes ?? OWNER_SIGN_IN_SCOPES).map((s) => (s.includes('/') ? s : `https://graph.microsoft.com/${s}`)).join(' ');

  const start = await postForm(doFetch, `${base}/devicecode`, { client_id: options.clientId, scope });
  const deviceCode = start.body['device_code'];
  const userCode = start.body['user_code'];
  const uri = start.body['verification_uri'];
  if (!start.ok || typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof uri !== 'string') {
    throw new DeviceCodeError(typeof start.body['error'] === 'string' ? start.body['error'] : 'no_device_code');
  }
  const expiresIn = Number(start.body['expires_in']);
  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900;
  let intervalMs = (Number(start.body['interval']) > 0 ? Number(start.body['interval']) : 5) * 1000;
  const deadline = now() + lifetime * 1000;
  options.prompt({ userCode, verificationUri: uri, expiresIn: lifetime });

  while (now() < deadline) {
    await sleep(intervalMs);
    const poll = await postForm(doFetch, `${base}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: options.clientId,
      device_code: deviceCode,
    });
    const token = poll.body['access_token'];
    if (poll.ok && typeof token === 'string' && token !== '') return new SecretValue(token);
    const error = poll.body['error'];
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    throw new DeviceCodeError(typeof error === 'string' ? error : 'no_access_token');
  }
  throw new DeviceCodeError('expired_token');
}

// ---------------------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------------------

/** The RSC permissions the manifest declares: what the owner consents to at install. */
export function manifestRscPermissions(manifestPath: string | URL = assetPath('manifests/teams/manifest.json')): string[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    authorization?: { permissions?: { resourceSpecific?: { name?: string }[] } };
  };
  return (manifest.authorization?.permissions?.resourceSpecific ?? []).flatMap((p) => (typeof p.name === 'string' ? [p.name] : []));
}

/** The warning for other apps named Snapwing in the team. */
export function duplicateAppWarning(ids: readonly string[]): string {
  return `another app named ${TEAMS_APP_NAME} is installed in the team (${ids.join(', ')}); one install per team`;
}

const sameName = (a: string | null | undefined): boolean => (a ?? '').trim().toLowerCase() === TEAMS_APP_NAME.toLowerCase();

function isOurs(app: GraphInstalledApp, appId: string, teamsAppId: string | undefined): boolean {
  return app.teamsApp?.externalId === appId || (teamsAppId !== undefined && app.teamsApp?.id === teamsAppId);
}

export interface TeamsInspection {
  /** Our app is installed in the team. */
  installed: boolean;
  /** The manifest's RSC permissions the team has not granted this app. */
  missing: string[];
  /** The same words as kv `teams-mode:{teamId}`: `reduced` when the app is absent or a required grant is missing. */
  mode: TeamsMode;
  reason?: string;
  /** Ids of other apps named Snapwing in the team. */
  others: string[];
}

export interface InspectOptions {
  graph: Pick<TeamsGraph, 'installedApps' | 'rscGrants'>;
  appId: string;
  teamId: string;
  /** Known after a catalog lookup; lets a renamed install still count as ours. */
  teamsAppId?: string;
  /** Default the manifest's RSC permissions. */
  rsc?: readonly string[];
  /** Default {@link TEAMS_REQUIRED_RSC}: without these the team is `reduced`. */
  required?: readonly string[];
}

/** Read-only: is the app installed in the team, with which grants, and who else is named Snapwing. */
export async function inspectTeamsInstall(opts: InspectOptions): Promise<TeamsInspection> {
  const rsc = opts.rsc ?? manifestRscPermissions();
  const required = opts.required ?? TEAMS_REQUIRED_RSC;
  const apps = await opts.graph.installedApps(opts.teamId);
  const ours = apps.some((a) => isOurs(a, opts.appId, opts.teamsAppId));
  const others = apps
    .filter((a) => !isOurs(a, opts.appId, opts.teamsAppId) && (sameName(a.teamsApp?.displayName) || sameName(a.teamsAppDefinition?.displayName)))
    .map((a) => a.teamsApp?.id ?? a.id);
  if (!ours) return { installed: false, missing: [...rsc], mode: 'reduced', reason: 'the app is not installed in the team', others };
  let granted: Set<string>;
  try {
    granted = new Set((await opts.graph.rscGrants(opts.teamId)).filter((g) => g.clientAppId === opts.appId).map((g) => g.permission));
  } catch (e) {
    if (!(e instanceof GraphPermissionError)) throw e;
    return { installed: true, missing: [...rsc], mode: 'reduced', reason: `could not read the team's grants (${e.permission})`, others };
  }
  const missing = rsc.filter((p) => !granted.has(p));
  const lacking = required.filter((p) => !granted.has(p));
  return lacking.length === 0
    ? { installed: true, missing, mode: 'full', others }
    : { installed: true, missing, mode: 'reduced', reason: `missing grants: ${lacking.join(', ')}`, others };
}

export interface InstallOptions {
  /** Graph with the team owner's token (see {@link signInByDeviceCode}). */
  graph: TeamsGraph;
  appId: string;
  publicUrl: string;
  /** The team's group id. */
  teamId: string;
  /** Default {@link TEAMS_APP_VERSION}. */
  version?: string;
  /** Default the manifest's RSC permissions. */
  rsc?: readonly string[];
}

export type CatalogOutcome = 'published' | 'updated' | 'current' | 'unavailable';
export type InstallOutcome = 'installed' | 'already' | 'not-installed';

export interface TeamsInstallResult {
  /** Catalog id of the app, when known. */
  teamsAppId?: string;
  catalog: CatalogOutcome;
  install: InstallOutcome;
  mode: TeamsMode;
  reason?: string;
  /** The manifest's RSC permissions the team has not granted. */
  missing: string[];
  warnings: string[];
  /** Admin center steps to print when the tenant forbids upload or install; empty otherwise. */
  adminSteps: string[];
  /** The package, only when `adminSteps` asks for an upload. */
  packageZip?: Uint8Array;
}

/** Numeric compare of the dotted part of a semver; a missing part is 0. Prerelease tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => (v.split(/[-+]/)[0] ?? '').split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x?.length ?? 0, y?.length ?? 0); i++) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** What to tell the installer when the tenant does not allow the app to be uploaded or installed by a person. */
export function adminCenterSteps(opts: { uploadNeeded: boolean; teamId: string; packageFile?: string }): string[] {
  const steps: string[] = [];
  if (opts.uploadNeeded) {
    steps.push(
      `Open the Teams admin center (admin.teams.microsoft.com), Teams apps, Manage apps, Actions, Upload new app, and upload ${opts.packageFile ?? 'the Snapwing app package'}.`,
    );
  }
  steps.push(
    `In Teams, open the team, Manage team, Apps, add ${TEAMS_APP_NAME}, and accept the permissions it asks for (team id ${opts.teamId}).`,
    'Run this again; it continues from there.',
  );
  return steps;
}

/** Publishes or updates the package in the tenant catalog, installs it in the team, and reports the mode. */
export async function installTeamsApp(opts: InstallOptions): Promise<TeamsInstallResult> {
  const version = opts.version ?? TEAMS_APP_VERSION;
  const rsc = opts.rsc ?? manifestRscPermissions();
  const graph = opts.graph;
  const zip = buildTeamsPackage({ appId: opts.appId, publicUrl: opts.publicUrl, version });
  let uploadBlocked = false;
  let catalog: CatalogOutcome = 'unavailable';
  let teamsAppId: string | undefined;

  // The catalog: find our app by its external id, then publish, update, or leave it.
  let found: GraphTeamsApp | undefined;
  let lookupDenied = false;
  try {
    found = (await graph.catalogApps({ externalId: opts.appId }))[0];
  } catch (e) {
    if (!(e instanceof GraphPermissionError)) throw e;
    lookupDenied = true;
  }
  try {
    if (found === undefined && !lookupDenied) {
      teamsAppId = (await graph.publishApp(zip)).id;
      catalog = 'published';
    } else if (found !== undefined) {
      teamsAppId = found.id;
      const versions = await graph.appVersions(found.id);
      if (versions.every((v) => compareVersions(v, version) < 0)) {
        await graph.updateApp(found.id, zip);
        catalog = 'updated';
      } else {
        catalog = 'current';
      }
    } else {
      uploadBlocked = true;
    }
  } catch (e) {
    if (!(e instanceof GraphPermissionError)) throw e;
    uploadBlocked = true;
  }

  // The install: skip when it is already there, and never fail on a tenant that forbids it.
  const known = teamsAppId === undefined ? {} : { teamsAppId };
  let install: InstallOutcome = 'not-installed';
  let installBlocked = false;
  const before = await inspectTeamsInstall({ graph, appId: opts.appId, teamId: opts.teamId, rsc, ...known });
  if (before.installed) {
    install = 'already';
  } else if (teamsAppId !== undefined) {
    try {
      await graph.installApp(opts.teamId, teamsAppId, { rscPermissions: [...rsc] });
      install = 'installed';
    } catch (e) {
      if (!(e instanceof GraphPermissionError)) throw e;
      installBlocked = true;
    }
  }

  const after = install === 'not-installed' ? before : await inspectTeamsInstall({ graph, appId: opts.appId, teamId: opts.teamId, rsc, ...known });
  const warnings = after.others.length > 0 ? [duplicateAppWarning(after.others)] : [];
  const needsAdmin = uploadBlocked || installBlocked || (!after.installed && teamsAppId === undefined);
  return {
    ...known,
    catalog,
    install: after.installed ? install : 'not-installed',
    mode: after.mode,
    ...(after.reason === undefined ? {} : { reason: after.reason }),
    missing: after.missing,
    warnings,
    adminSteps: needsAdmin ? adminCenterSteps({ uploadNeeded: teamsAppId === undefined, teamId: opts.teamId }) : [],
    ...(needsAdmin && teamsAppId === undefined ? { packageZip: zip } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// `pnpm teams:bootstrap`
// ---------------------------------------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  /** One line. Present on failure; may carry a note on success. */
  message?: string;
}

export interface TeamsBootstrapReport {
  ok: boolean;
  checks: CheckResult[];
  warnings: string[];
  /** The mode the team would run in, when the install check ran. */
  mode?: { mode: TeamsMode; reason?: string };
  /** The values written to the env file. */
  wrote: Record<string, string>;
}

export interface TeamsBootstrapOptions {
  /** Merged env: `.env.live` values over the process environment. */
  env: Readonly<Record<string, string | undefined>>;
  /** The env file's text (empty when there is none) and where to put the updated text. */
  readEnvFile?: () => string;
  writeEnvFile?: (text: string) => void;
  fetch?: typeof fetch;
  loginHost?: string;
  graphBaseUrl?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Remove the app password and anything that looks like a bearer token from text bound for output. */
export function scrub(s: string, secrets: readonly (string | undefined)[]): string {
  let out = oneLine(s).replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '[token]');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[token]');
  return out;
}

export async function runTeamsBootstrap(opts: TeamsBootstrapOptions): Promise<TeamsBootstrapReport> {
  const env = opts.env;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const secrets = [env['TEAMS_APP_PASSWORD']];
  const checks: CheckResult[] = [];
  const warnings: string[] = [];
  const wrote: Record<string, string> = {};
  let mode: TeamsBootstrapReport['mode'];

  const run = async (name: string, fn: () => Promise<string | undefined>): Promise<void> => {
    try {
      const note = await fn();
      checks.push(note === undefined ? { name, ok: true } : { name, ok: true, message: note });
    } catch (err) {
      checks.push({ name, ok: false, message: scrub(err instanceof Error ? err.message : String(err), secrets) });
    }
  };
  const need = (key: string): string => {
    const v = env[key]?.trim();
    if (v === undefined || v === '') throw new Error(`${key} is not set`);
    return v;
  };
  const credentials = () => ({
    appId: need('TEAMS_APP_ID'),
    password: need('TEAMS_APP_PASSWORD'),
    tenantId: need('TEAMS_TENANT_ID'),
    fetch: doFetch,
    ...(opts.loginHost === undefined ? {} : { loginHost: opts.loginHost }),
  });

  await run('bot-token', async () => {
    await createBotTokenSource(credentials()).token();
    const serviceUrl = env['TEAMS_SERVICE_URL']?.trim();
    if (serviceUrl && !serviceUrl.startsWith('https://')) throw new Error('TEAMS_SERVICE_URL must be an https address');
    return undefined;
  });

  let graph: TeamsGraph | undefined;
  await run('graph-token', async () => {
    const tokens = createGraphTokenSource(credentials());
    await tokens.token();
    graph = createTeamsGraph({
      token: () => tokens.token(),
      fetch: doFetch,
      ...(opts.graphBaseUrl === undefined ? {} : { baseUrl: opts.graphBaseUrl }),
    });
    return undefined;
  });

  await run('endpoint', async () => {
    const publicUrl = (env['TEAMS_PUBLIC_URL']?.trim() || need('SNAPWING_PUBLIC_URL')).replace(/\/+$/, '');
    const url = `${publicUrl}${TEAMS_MESSAGES_PATH}`;
    let status: number;
    try {
      status = (await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status;
    } catch {
      throw new Error(`${url} did not answer`);
    }
    if (status !== 401) throw new Error(`${url} answered ${status} to an unauthenticated POST; it must answer 401`);
    return undefined;
  });

  let teamId: string | undefined;
  let channelId: string | undefined;
  await run('test-team', async () => {
    if (graph === undefined) throw new Error('skipped, no Graph token');
    const teams = await graph.teams();
    const wanted = env['TEAMS_TEST_TEAM_ID']?.trim();
    if (wanted) {
      if (!teams.some((t) => t.id === wanted)) throw new Error(`TEAMS_TEST_TEAM_ID ${wanted} is not a team in the tenant`);
      teamId = wanted;
    } else if (teams.length === 1 && teams[0] !== undefined) {
      teamId = teams[0].id;
    } else {
      throw new Error(`set TEAMS_TEST_TEAM_ID in .env.live; the tenant has ${teams.length} teams`);
    }
    const channels = await graph.channels(teamId);
    const wantedChannel = env['TEAMS_TEST_CHANNEL_ID']?.trim();
    if (wantedChannel) {
      if (!channels.some((c) => c.id === wantedChannel)) throw new Error(`TEAMS_TEST_CHANNEL_ID ${wantedChannel} is not a channel of the team`);
      channelId = wantedChannel;
    } else {
      channelId = (channels.find((c) => (c.displayName ?? '').toLowerCase() === 'general') ?? channels[0])?.id;
      if (channelId === undefined) throw new Error('the test team has no channels');
    }
    return undefined;
  });

  await run('installed', async () => {
    if (graph === undefined || teamId === undefined) throw new Error('skipped, no test team');
    const result = await inspectTeamsInstall({ graph, appId: need('TEAMS_APP_ID'), teamId });
    if (result.others.length > 0) warnings.push(duplicateAppWarning(result.others));
    mode = { mode: result.mode, ...(result.reason === undefined ? {} : { reason: result.reason }) };
    if (!result.installed) throw new Error(`${TEAMS_APP_NAME} is not installed in the test team; run pnpm teams:bootstrap --install`);
    if (result.missing.length > 0) throw new Error(`the install is missing grants: ${result.missing.join(', ')}`);
    return undefined;
  });

  await run('env', async () => {
    if (teamId === undefined || channelId === undefined) throw new Error('skipped, no test team');
    const values = { TEAMS_TEST_TEAM_ID: teamId, TEAMS_TEST_CHANNEL_ID: channelId };
    const before = opts.readEnvFile?.() ?? '';
    const after = updateEnvText(before, values);
    if (after === before) return undefined;
    if (opts.writeEnvFile === undefined) throw new Error('no env file to write');
    opts.writeEnvFile(after);
    Object.assign(wrote, values);
    return `wrote ${Object.keys(values).join(', ')}`;
  });

  return { ok: checks.every((c) => c.ok), checks, warnings, ...(mode === undefined ? {} : { mode }), wrote };
}

export function formatReport(report: TeamsBootstrapReport): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(c.ok ? (c.message === undefined ? `ok   ${c.name}` : `ok   ${c.name}: ${c.message}`) : `FAIL ${c.name}: ${c.message ?? 'failed'}`);
  }
  if (report.mode !== undefined) lines.push(`mode ${report.mode.mode}${report.mode.reason === undefined ? '' : ` (${report.mode.reason})`}`);
  for (const w of report.warnings) lines.push(`warn ${w}`);
  return lines;
}
