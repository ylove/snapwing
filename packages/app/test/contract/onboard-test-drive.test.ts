// The onboarding test drive over the composed app on MSW: the step starts the real `snapwing serve`
// (`runServe`, the real `compose`, worker, projectors, and HTTP API on a free local port) from the
// config and `.env` in its working directory, and the test plays the installer in chat. On Slack the
// bot posts the sample in a channel it creates, the installer reacts to the bot's own post, taps
// Looks right and (at Ask) Fix it, and Jira's In Progress webhook starts the fixer, which opens a pull
// request in the sample repository through the fake agent. On Teams the installer posts the sample
// and reacts to it (a Graph change notification), with the level lifted to Fix now for the drive.
// The failure path is a fixer that fails; the stop paths are nobody reacting and Ctrl-C. Every path
// leaves no server running: serve's own promise has resolved and its port refuses connections.
//
// No keys and no network: Slack, Teams (Bot Connector and Graph), Jira, and GitHub are MSW; git
// remotes are local bare repositories, and the fake agent runs through the generic harness adapter.
// Runs on the dialect `SNAPWING_DB` selects.

import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel } from '@snapwing/pipeline/demo/run.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type JsonObject } from '../../src/onboard/interview/state.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import { createTestDriveStep, parseTeamsChannelLink, printable, sampleBug, type TestDriveDeps } from '../../src/onboard/steps/test-drive.ts';
import { compose, type TeamsInject } from '../../src/server/compose.ts';
import { runServe } from '../../src/server/serve.ts';
import { FakeGitHub, INSTALLATION_TOKEN } from '../fixtures/e2e/github.ts';
import { JiraWebhooks } from '../fixtures/e2e/jira.ts';
import {
  blockIds,
  BOT_USER,
  DEMO_LEVELS,
  DEMO_MAP,
  envFile,
  EXAMPLE_CONFIG,
  fakeSecrets,
  SLACK_API,
  slackSigned,
  slackWorld,
  TEAM_ID,
  WORKSPACE_DOMAIN,
  type SlackPostCall,
  type SlackWorld,
} from '../fixtures/e2e/world.ts';
import { pullState, slackSampleHandlers } from '../fixtures/onboard/drive.ts';

const HARNESS = fileURLToPath(new URL('../fixtures/e2e/fake-harness.mjs', import.meta.url));
/** The repository's test command for the regression proof: every `test/*.test.sh` must pass. */
const TEST_COMMAND = 'for t in test/*.test.sh; do sh "$t" || exit 1; done';
const WAIT_MS = 45_000;
const REPO = 'acme/admin';
const ISSUE = 'ADM-1';
const PR = 'https://github.com/acme/admin/pull/1';
const SAMPLE = sampleBug(REPO);

/** The fix the fake agent makes, and its regression test (fails on the seeded bug, passes after). */
const PLAN = {
  summary: 'append the usage rows to the CSV export',
  files: {
    'src/reports/csv-export.ts':
      "export function usageCsv(rows: UsageRow[]): string {\n  const header = 'account,seats,usage';\n  return [header, ...rows.map((r) => [r.account, r.seats, r.usage].join(','))].join('\\n');\n}\n",
    'test/csv-export.test.sh': "grep -q 'rows.map' src/reports/csv-export.ts\n",
  },
  test: 'test/csv-export.test.sh',
  reviewGate: false,
};

// Slack: the installer is the admin surface's engineer; the bot posts the sample.
const INSTALLER = 'U0ADMDEV';
const SAVED_CHANNEL = 'C0SANDBOX';
const CREATED_CHANNEL = 'C0TESTDRIVE';
const SAMPLE_TS = '1790900100.000100';

// Teams: the tenant of the Teams fixtures; Rae posts the sample and reacts to it.
const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const APP_PASSWORD = 'test-teams-app-password';
const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const TEAMS_CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const RAE_FROM = { id: '29:1rae-reporter-teams-id', name: 'Rae Reporter', aadObjectId: RAE };
const SERVICE_URL = 'https://smba.test/amer/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const POST_ID = '1790900200000';

const server = setupServer();
const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  // The test talks to serve on 127.0.0.1 for real; anything else unhandled is a failure.
  server.events.on('request:unhandled', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });
});
afterAll(() => server.close());

let tdb: TestDatabase;
let dir: string;
let github: FakeGitHub | undefined;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-test-drive-'));
  unhandled.length = 0;
});

afterEach(async () => {
  await github?.remove();
  github = undefined;
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

function dbEnv(): Record<string, string> {
  return tdb.dialect === 'postgres'
    ? { SNAPWING_DB: 'postgres', DATABASE_URL: tdb.options.url ?? '' }
    : { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: tdb.options.url ?? '' };
}

// The world ---------------------------------------------------------------------------------------

interface World {
  jira: JiraWorld;
  jiraHooks: JiraWebhooks;
  github: FakeGitHub;
  model: RecordedModel;
  /** The written map, as the drive found it. */
  mapXml: string;
  /** The `.env` values serve reads. */
  secrets: Record<string, string>;
}

/** Jira, GitHub (the admin repository of the level 1 recording), the fake agent, and the working directory's files. */
async function world(options: { anchor: string; teams?: boolean; plan?: boolean }): Promise<World> {
  const recording = parseScenario('02-level-1-fix-on-tap.json', JSON.parse(await readFile(join(DEMO_LEVELS, '02-level-1-fix-on-tap.json'), 'utf8')));
  const jira = new JiraWorld(() => undefined);
  const jiraHooks = new JiraWebhooks(jira);
  const demoGitHub = new GitHubWorld(() => undefined);
  demoGitHub.addRepos(recording.github);
  const harnessDir = join(dir, 'harness');
  github = new FakeGitHub(harnessDir);
  for (const [name, files] of Object.entries(recording.github)) await github.addRepo(name, files);
  await mkdir(join(harnessDir, 'plans'), { recursive: true });
  await mkdir(join(harnessDir, 'gates'), { recursive: true });
  if (options.plan !== false) await writeFile(join(harnessDir, 'plans', `${ISSUE}.json`), JSON.stringify(PLAN));
  server.use(...jiraHooks.handlers(), ...github.handlers(), ...jiraHandlers(jira), ...githubHandlers(demoGitHub));

  // The model reads the sample's thread: the sample is the one message, then the recording's triage.
  const model = new RecordedModel();
  model.use('test drive', { ...recording.model, segmentation: { included: [options.anchor], excluded: [], resolutionMessageId: '' } });

  // The example config with both harness roles on the fake agent, as the runtime step would leave it.
  const command = [process.execPath, HARNESS, harnessDir].map((a) => `&quot;${a}&quot;`).join(' ');
  const configXml = (await readFile(EXAMPLE_CONFIG, 'utf8')).replace(
    /<harness [\s\S]*?<\/harness>/,
    `<harness fixer="generic" review="generic"><generic id="fake-agent" command="${command}" timeout="PT2M"/></harness>`,
  );
  await writeFile(join(dir, 'snapwing.config.xml'), configXml);

  // The demo map; on Teams, plus a Teams channel (on another product) and Rae.
  let mapXml = await readFile(DEMO_MAP, 'utf8');
  if (options.teams === true) {
    mapXml = mapXml
      .replace('  </channels>', `    <channel id="${TEAMS_CHANNEL}" name="snapwing-sandbox" surface="help" confidence="explicit" platform="teams" team="${TEAM}" />\n  </channels>`)
      .replace('  </people>', `    <person teamsId="${RAE}" handle="rae" email="rae@example.com" role="reporter" />\n  </people>`);
  }
  await writeFile(join(dir, 'workspace-context.xml'), mapXml);

  // Generated per run, never committed: the App JWT is signed for real.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const secrets: Record<string, string> = { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
  if (options.teams === true) {
    delete secrets['SLACK_BOT_TOKEN'];
    delete secrets['SLACK_SIGNING_SECRET'];
    Object.assign(secrets, { TEAMS_APP_ID: APP_ID, TEAMS_APP_PASSWORD: APP_PASSWORD, TEAMS_TENANT_ID: TENANT, TEAMS_SERVICE_URL: SERVICE_URL });
  }
  await writeFile(join(dir, '.env'), envFile(secrets));
  return { jira, jiraHooks, github, model, mapXml, secrets };
}

// Slack -------------------------------------------------------------------------------------------

interface SlackDrive {
  world: SlackWorld;
  /** The sample posts the bot made (top-level, no blocks). */
  samples: Record<string, unknown>[];
  /** Names passed to `conversations.create`. */
  created: string[];
}

/** The Slack Web API over the sandbox `channel`: the sample post lands in its history, `reactions.get` reads it back. */
function slackDrive(channel: string, scopes: string): SlackDrive {
  const messages: Record<string, unknown>[] = [];
  const samples: Record<string, unknown>[] = [];
  const created: string[] = [];
  const world = slackWorld(server, channel, messages);
  const authorized = (request: Request): boolean => request.headers.get('authorization') === 'Bearer xoxb-test';
  server.use(
    http.post(`${SLACK_API}/auth.test`, ({ request }) =>
      authorized(request)
        ? HttpResponse.json({ ok: true, user_id: BOT_USER, team_id: TEAM_ID, url: `https://${WORKSPACE_DOMAIN}.slack.com/` }, { headers: { 'x-oauth-scopes': scopes } })
        : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
    http.post(`${SLACK_API}/conversations.create`, async ({ request }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      const body = (await request.json()) as { name?: string };
      created.push(String(body.name));
      return HttpResponse.json({ ok: true, channel: { id: CREATED_CHANNEL, name: body.name } });
    }),
    ...slackSampleHandlers(channel, messages, samples, { token: 'xoxb-test', ts: SAMPLE_TS, reactor: INSTALLER }),
  );
  return { world, samples, created };
}

function buttons(c: SlackPostCall, blockId: string): { action_id: string; value: string; text: { text: string } }[] {
  const blocks = c.body['blocks'] as { block_id?: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
  return blocks.find((b) => b.block_id === blockId)?.elements ?? [];
}

// The drive and the installer around it -----------------------------------------------------------

interface Drive {
  result: InterviewResult;
  lines: string[];
  /** Serve's exit code, once the step returned. */
  exit: number;
  /** The API's base URL while it ran. */
  url: string;
}

interface Installer {
  /** Resolves with serve's base URL once it is ready. */
  url: Promise<string>;
  /** True once the step has returned: the installer stops waiting for cards. */
  done(): boolean;
  lines: string[];
}

/** Waits for `find` to return something, while the step still runs. */
async function until<T>(installer: Installer, what: string, find: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = await find();
    if (found !== undefined) return found;
    if (installer.done()) throw new Error(`the step returned before ${what} (${installer.lines.join(' | ')})`);
    if (Date.now() > deadline) throw new Error(`no ${what} yet (${installer.lines.join(' | ')})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const stub = (id: string, data: JsonObject | undefined): OnboardStep => ({
  id,
  title: id,
  needs: [],
  run: () => Promise.resolve(data === undefined ? { status: 'skipped', reason: 'not used' } : { status: 'done', data }),
});

/**
 * Runs the interview to the test drive: the earlier steps are stand-ins that return what the real ones
 * save. `answers` are the drive's, keyed by question id; any other question has no answer. `play` is
 * the installer in chat, run alongside.
 */
async function drive(
  w: World,
  options: { teams?: boolean; answers: Record<string, string | string[]>; interrupts?: EventEmitter; waitMs?: TestDriveDeps['waitMs']; teamsInject?: (inject: TeamsInject) => void },
  play: (installer: Installer) => Promise<void>,
): Promise<Drive> {
  const lines: string[] = [];
  const raw = new Map<string, string>();
  let finished = false;
  let markUrl: (url: string) => void = () => undefined;
  const url = new Promise<string>((r) => (markUrl = r));
  const served: Promise<number>[] = [];
  const step = createTestDriveStep({
    serve: (args, io, deps) => {
      const run = runServe(args, io, { ...deps, onReady: (info) => (info.url === undefined ? undefined : markUrl(info.url), deps.onReady?.(info)) });
      served.push(run);
      return run;
    },
    compose: (deps) =>
      compose({
        ...deps,
        overrides: {
          model: withValidation(w.model),
          projectorPollMs: 25,
          gitRemoteUrl: w.github.remoteUrl,
          ...(options.teamsInject === undefined ? {} : { teamsInject: options.teamsInject }),
        },
      }),
    interrupts: options.interrupts ?? new EventEmitter(),
    pollMs: 25,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  const answers = new Map(Object.entries(options.answers).map(([k, v]) => [`test-drive.${k}`, Array.isArray(v) ? v : [v]]));
  const io = createTerminalIO({ prompter: { line: () => Promise.resolve(undefined), hidden: () => Promise.resolve(undefined) }, say: (l) => lines.push(l), answers });
  const steps: OnboardStep[] = [
    stub('slack', options.teams === true ? undefined : { installed: true, botUserId: BOT_USER, channels: [{ id: SAVED_CHANNEL, name: 'snapwing-sandbox', private: false }] }),
    stub('teams', options.teams === true ? { tenant: TENANT } : undefined),
    stub('jira', { site: JIRA_BASE, projects: ['ADM'], webhook: 'registered' }),
    stub('github', { repos: [REPO, 'acme/web'] }),
    stub('finish', { map: 'workspace-context.xml', written: true }),
    step,
  ];
  const installer: Installer = { url, done: () => finished, lines };
  const playing = play(installer).then(
    () => undefined,
    (e: unknown) => e,
  );
  const result = await runInterview({
    steps,
    store: createKvOnboardingStore({ kvGet: (k) => Promise.resolve(raw.get(k)), kvSet: (k, v) => Promise.resolve(void raw.set(k, v)) }),
    io,
    workdir: dir,
    env: { ...dbEnv(), PORT: '0', HOST: '127.0.0.1', SNAPWING_WORKDIR_ROOT: join(dir, 'work'), SNAPWING_TEST_COMMAND: TEST_COMMAND },
  }).finally(() => (finished = true));
  const failure = await playing;
  if (failure !== undefined) throw failure;
  expect(served).toHaveLength(1);
  const exit = await (served[0] as Promise<number>);
  return { result, lines, exit, url: await Promise.race([url, Promise.resolve('')]) };
}

/** Nothing is left running: serve returned and its port refuses connections. */
async function stopped(d: Drive): Promise<void> {
  expect(d.exit).toBe(0);
  expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await expect(fetch(`${d.url}/healthz`)).rejects.toThrow();
}

/** The written map and the config cache still hold the written map, not the drive's copy. */
async function mapUntouched(w: World): Promise<void> {
  expect(await readFile(join(dir, 'workspace-context.xml'), 'utf8')).toBe(w.mapXml);
  const state = await tdb.open();
  expect((await state.getConfigVersion('map')).body).toBe(w.mapXml);
}

/** The drive's record holds no secret value, and nothing in it was scrubbed as one. */
function noSecrets(w: World, d: Drive): void {
  const record = JSON.stringify(d.result.state.steps['test-drive']);
  expect(record).not.toContain('[secret]');
  for (const [name, value] of Object.entries(w.secrets)) {
    if (/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|API_KEY/.test(name)) expect(record.includes(value), name).toBe(false);
  }
}

/** The installer in Slack: reacts to the sample, taps Looks right, and (at Ask) Fix it; Jira reports In Progress. */
async function slackInstaller(installer: Installer, w: World, slack: SlackDrive, channel: string, options: { fixIt: boolean; react?: boolean }): Promise<void> {
  const url = await installer.url;
  await until(installer, 'sample post', () => slack.samples[0]);
  if (options.react === false) return;
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM_ID,
    api_app_id: 'A0SNAPWING',
    event_id: 'Ev0TESTDRIVE1',
    event_time: Math.floor(Date.now() / 1000),
    event: { type: 'reaction_added', user: INSTALLER, reaction: 'bug', item: { type: 'message', channel, ts: SAMPLE_TS }, item_user: BOT_USER, event_ts: '1790900160.000200' },
  });
  expect((await fetch(`${url}/slack/events`, { method: 'POST', headers: slackSigned(body), body })).status).toBe(200);

  const card = (blockId: string): Promise<SlackPostCall> =>
    until(installer, `${blockId} card`, () => slack.world.calls.filter((c) => c.method === 'chat.postMessage' && blockIds(c.body).includes(blockId)).at(-1));
  const tap = async (c: SlackPostCall, blockId: string, actionId: string): Promise<void> => {
    const button = buttons(c, blockId).find((b) => b.action_id === actionId);
    if (button === undefined) throw new Error(`no ${actionId} button on the ${blockId} card`);
    const payload = {
      type: 'block_actions',
      user: { id: INSTALLER },
      channel: { id: channel },
      container: { type: 'message', channel_id: channel, message_ts: c.ts },
      message: { ts: c.ts, thread_ts: SAMPLE_TS, blocks: c.body['blocks'] },
      actions: [{ action_id: actionId, block_id: blockId, value: button.value, text: { type: 'plain_text', text: button.text.text } }],
    };
    const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    expect((await fetch(`${url}/slack/interactivity`, { method: 'POST', headers: slackSigned(form, 'application/x-www-form-urlencoded'), body: form })).status).toBe(200);
  };
  await tap(await card('scope_actions'), 'scope_actions', 'looks-right');
  if (options.fixIt) await tap(await card('triage_actions'), 'triage_actions', 'approve_fix');
  await deliverJira(installer, w, url);
}

/** Jira's webhook for the In Progress transition the agent made. */
async function deliverJira(installer: Installer, w: World, url: string): Promise<void> {
  await until(installer, 'In Progress transition', () => (w.jiraHooks.queued.some((q) => q.issueKey === ISSUE) ? true : undefined));
  const statuses = await w.jiraHooks.deliver(ISSUE, (body) => fetch(`${url}/webhooks/jira`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  expect(statuses.every((s) => s === 200)).toBe(true);
}

/** Each line, in this order, among the drive's lines. */
function inOrder(lines: readonly string[], expected: readonly string[]): void {
  let at = -1;
  for (const want of expected) {
    const found = lines.findIndex((l, i) => i > at && l.includes(want));
    expect(found, `"${want}" after line ${at} in:\n${lines.join('\n')}`).toBeGreaterThan(at);
    at = found;
  }
}

// Teams -------------------------------------------------------------------------------------------

interface ConnectorCall {
  kind: 'personal' | 'send' | 'reply' | 'update';
  conversation: string;
  activityId: string;
  body: Record<string, unknown>;
}

function teamsFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** The token endpoint, the Bot Connector, and Graph, with Rae's post of the sample and her bug reaction on it. */
function teamsWorld(): { connector: ConnectorCall[] } {
  const connector: ConnectorCall[] = [];
  let n = 0;
  const id = (params: Record<string, unknown>, key: string): string => decodeURIComponent(String(params[key]));
  const json = async (request: Request): Promise<Record<string, unknown>> => (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const at = new Date().toISOString();
  const post = {
    id: POST_ID,
    replyToId: null,
    messageType: 'message',
    createdDateTime: at,
    lastModifiedDateTime: at,
    deletedDateTime: null,
    from: { application: null, device: null, user: { id: RAE, displayName: 'Rae Reporter', userIdentityType: 'aadUser' } },
    body: { contentType: 'html', content: `<p>${SAMPLE}</p>` },
    attachments: [],
    mentions: [],
    reactions: [{ reactionType: '🐛', createdDateTime: at, user: { application: null, device: null, user: { id: RAE, userIdentityType: 'aadUser' } } }],
  };
  server.use(
    http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, () => HttpResponse.json(teamsFixture('openid/token-response.json'))),
    http.post(`${SERVICE_URL}v3/conversations`, async ({ request }) => {
      connector.push({ kind: 'personal', conversation: '', activityId: '', body: await json(request) });
      return HttpResponse.json({ id: 'a:1personal-chat-rae' });
    }),
    http.post(`${SERVICE_URL}v3/conversations/:conversation/activities`, async ({ request, params }) => {
      const activityId = `teams-act-${String(++n)}`;
      connector.push({ kind: 'send', conversation: id(params, 'conversation'), activityId, body: await json(request) });
      return HttpResponse.json({ id: activityId });
    }),
    http.post(`${SERVICE_URL}v3/conversations/:conversation/activities/:activity`, async ({ request, params }) => {
      const activityId = `teams-act-${String(++n)}`;
      connector.push({ kind: 'reply', conversation: id(params, 'conversation'), activityId, body: await json(request) });
      return HttpResponse.json({ id: activityId });
    }),
    http.put(`${SERVICE_URL}v3/conversations/:conversation/activities/:activity`, async ({ request, params }) => {
      connector.push({ kind: 'update', conversation: id(params, 'conversation'), activityId: id(params, 'activity'), body: await json(request) });
      return HttpResponse.json({ id: id(params, 'activity') });
    }),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages`, () => HttpResponse.json({ value: [post] })),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message`, ({ params }) =>
      id(params, 'message') === POST_ID ? HttpResponse.json(post) : HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 }),
    ),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message/replies`, () => HttpResponse.json({ value: [] })),
    // Everyone is a tenant member (the guest cap); no mail or name, so the map's stand in.
    http.get(`${GRAPH}/users/:user`, ({ params }) => HttpResponse.json({ id: params['user'], userType: 'Member' })),
    http.get(`${GRAPH}/teams/:team/channels/:channel/members`, () => HttpResponse.json({ value: [{ id: `member-${RAE}`, userId: RAE, roles: [] }] })),
    http.post(`${GRAPH}/subscriptions`, async ({ request }) => {
      const body = await json(request);
      return HttpResponse.json({ ...teamsFixture('graph/subscription.json'), resource: body['resource'], expirationDateTime: body['expirationDateTime'], clientState: body['clientState'] }, { status: 201 });
    }),
  );
  return { connector };
}

function cardOf(body: Record<string, unknown>): { actions?: { verb?: string; data?: Record<string, string> }[] } | undefined {
  const attachments = Array.isArray(body['attachments']) ? (body['attachments'] as { content?: unknown }[]) : [];
  return attachments[0]?.content as { actions?: { verb?: string; data?: Record<string, string> }[] } | undefined;
}

/** A tap on a card in the sample's thread, by Rae. */
function teamsTap(cardActivityId: string, verb: string, data: Record<string, string>): Record<string, unknown> {
  const base = teamsFixture('activities/action-fetch-task.json');
  return {
    type: 'invoke',
    name: 'adaptiveCard/action',
    id: `tap-${verb}`,
    timestamp: new Date().toISOString(),
    channelId: 'msteams',
    serviceUrl: SERVICE_URL,
    from: RAE_FROM,
    recipient: base['recipient'],
    conversation: { ...(base['conversation'] as object), id: `${TEAMS_CHANNEL};messageid=${POST_ID}` },
    channelData: base['channelData'],
    replyToId: cardActivityId,
    value: { action: { type: 'Action.Execute', verb, data } },
  };
}

// Tests -------------------------------------------------------------------------------------------

describe('the test drive on Slack', () => {
  it('creates the sandbox where allowed, posts the sample as the bot, and follows a reaction on it to an opened pull request at Ask', async () => {
    const w = await world({ anchor: SAMPLE_TS });
    const slack = slackDrive(CREATED_CHANNEL, 'chat:write,channels:read,channels:join,channels:manage,reactions:read');
    const d = await drive(w, { answers: { repo: REPO, 'slack-channel': 'create', level: 'keep' } }, (installer) =>
      slackInstaller(installer, w, slack, CREATED_CHANNEL, { fixIt: true }),
    );

    expect(d.result.outcome, d.lines.join('\n')).toBe('complete');
    const record = d.result.state.steps['test-drive'];
    expect(record?.status).toBe('done');
    expect(record?.data).toEqual({
      repo: REPO,
      surface: 'admin',
      level: 1,
      lifted: false,
      drives: [{ platform: 'slack', channel: CREATED_CHANNEL, channelName: 'snapwing-test-drive', incident: expect.any(String), jiraKey: ISSUE, pr: PR }],
    });
    // The channel was created (the token has channels:manage), and the bot posted the sample in it.
    expect(slack.created).toEqual(['snapwing-test-drive']);
    expect(slack.samples).toEqual([expect.objectContaining({ channel: CREATED_CHANNEL, text: SAMPLE })]);
    // The pull request is in the sample repository.
    expect(await pullState(REPO, 1, INSTALLATION_TOKEN)).toBe('open');
    expect(w.jira.issues.get(ISSUE)?.custom['Autonomy Level']).toBe(1);
    inOrder(d.lines, [
      'Created #snapwing-test-drive.',
      'Starting Snapwing here for the drive. It stops again when the drive ends.',
      'Snapwing is running.',
      'Snapwing posted a sample bug in #snapwing-test-drive. React to it with :bug:.',
      'Saw the reaction. Snapwing is reading the conversation.',
      'Snapwing posted what it read as a card in the thread. Tap Looks right on it.',
      'It is about B2B Admin Portal; the fix goes to acme/admin.',
      'Planned "CSV usage export has a header row but no data" at Ask.',
      'Tap Fix it on the card in the thread to start the fix.',
      'Got Fix it.',
      `Filed ${ISSUE} in Jira.`,
      'Snapwing started the fix.',
      'Cloned the repository.',
      'Made a branch.',
      'Made the change.',
      'Ran the tests.',
      'Pushed the branch.',
      'Opening the pull request.',
      `The test drive passed on Slack: the pull request is open at ${PR}`,
      'Stopping Snapwing.',
      'Snapwing is stopped again. Run `snapwing serve` to keep it running.',
    ]);
    // An engineer reacted, so nobody else was asked to tap Fix it.
    expect(d.lines.some((l) => l.includes('Fix it takes an engineer'))).toBe(false);
    await stopped(d);
    await mapUntouched(w);
    noSecrets(w, d);
    expect(slack.world.unknown).toEqual([]);
    expect(unhandled).toEqual([]);
  }, 120_000);
});

describe('the test drive on Teams', () => {
  it('asks the installer to post the sample, lifts Ask to Fix now for the drive only, and follows the reaction to an opened pull request', async () => {
    const w = await world({ anchor: POST_ID, teams: true });
    const teams = teamsWorld();
    let inject: TeamsInject | undefined;
    const d = await drive(w, { teams: true, answers: { repo: REPO, 'teams-channel': TEAMS_CHANNEL, level: 'lift' }, teamsInject: (fn) => (inject = fn) }, async (installer) => {
      const url = await installer.url;
      await until(installer, 'the ask to post the sample', () => (installer.lines.some((l) => l.includes('post this message as yourself')) ? true : undefined));
      // Rae posts the sample and reacts with the bug: Graph tells Snapwing the message changed.
      if (inject === undefined) throw new Error('compose did not hand over the Teams seam');
      const seam = inject;
      await seam({
        notifications: [
          { subscriptionId: 'sub-1', changeType: 'updated', resource: `teams('${TEAM}')/channels('${TEAMS_CHANNEL}')/messages('${POST_ID}')`, teamId: TEAM, channelId: TEAMS_CHANNEL, messageId: POST_ID },
        ],
      });
      const scope = await until(installer, 'scope card', () => teams.connector.find((c) => c.kind === 'reply' && (cardOf(c.body)?.actions ?? []).some((a) => a.verb === 'looks-right')));
      expect(scope.conversation).toBe(`${TEAMS_CHANNEL};messageid=${POST_ID}`);
      const incidentId = cardOf(scope.body)?.actions?.find((a) => a.verb === 'looks-right')?.data?.['incidentId'] ?? '';
      expect(await seam({ activity: teamsTap(scope.activityId, 'looks-right', { incidentId }) })).toMatchObject({ status: 200 });
      await deliverJira(installer, w, url);
    });

    expect(d.result.outcome, d.lines.join('\n')).toBe('complete');
    expect(d.result.state.steps['test-drive']?.data).toEqual({
      repo: REPO,
      surface: 'admin',
      level: 2,
      lifted: true,
      drives: [{ platform: 'teams', channel: TEAMS_CHANNEL, channelName: 'snapwing-sandbox', incident: expect.any(String), jiraKey: ISSUE, pr: PR }],
    });
    expect(await pullState(REPO, 1, INSTALLATION_TOKEN)).toBe('open');
    // Lifted for the drive only: the ticket ran at Fix now, the written map still says Ask.
    expect(w.jira.issues.get(ISSUE)?.custom['Autonomy Level']).toBe(2);
    const written = await parseWorkspaceMap(await readFile(join(dir, 'workspace-context.xml'), 'utf8'));
    expect(written.policies.autonomy.overrides).toContainEqual(expect.objectContaining({ kind: 'surface', ref: 'admin', level: 1 }));
    expect(written.channels.find((c) => c.id === TEAMS_CHANNEL)?.surface).toBe('help');
    inOrder(d.lines, [
      'Starting Snapwing here for the drive, with B2B Admin Portal at Fix now for the drive only.',
      'In snapwing-sandbox on Teams, post this message as yourself, then react to your post with 🐛 (bug):',
      `  ${SAMPLE}`,
      "Teams does not let Snapwing count a reaction on its own post, so the sample has to be yours.",
      'Saw the reaction. Snapwing is reading the conversation.',
      'Snapwing posted what it read as a card in the thread. Tap Looks right on it.',
      'Planned "CSV usage export has a header row but no data" at Fix now.',
      `Filed ${ISSUE} in Jira.`,
      'Snapwing started the fix.',
      `The test drive passed on Teams: the pull request is open at ${PR}`,
    ]);
    expect(d.lines.some((l) => l.includes('Tap Fix it'))).toBe(false);
    await stopped(d);
    await mapUntouched(w);
    noSecrets(w, d);
    expect(unhandled).toEqual([]);
  }, 120_000);
});

describe('the test drive when it does not pass', () => {
  it('names the stage and the fix when the fix fails, and stops the server', async () => {
    // No plan for the fake agent: the fixer fails after the ticket is filed.
    const w = await world({ anchor: SAMPLE_TS, plan: false });
    const slack = slackDrive(SAVED_CHANNEL, 'chat:write,channels:read,channels:join');
    const d = await drive(w, { answers: { repo: REPO, 'slack-channel': SAVED_CHANNEL, level: 'lift' } }, (installer) =>
      slackInstaller(installer, w, slack, SAVED_CHANNEL, { fixIt: false }),
    );

    expect(d.result.outcome, d.lines.join('\n')).toBe('waiting');
    const record = d.result.state.steps['test-drive'];
    expect(record?.status).toBe('blocked');
    expect(record?.blocked).toMatchObject({ on: 'you, fixing what stopped the test drive', link: 'snapwing onboard --step test-drive' });
    expect(record?.blocked?.reason).toMatch(/^the drive stopped at making the fix and opening the pull request on Slack: the fix failed: /);
    expect(record?.data).toMatchObject({ repo: REPO, level: 2, lifted: true, drives: [], stoppedAt: 'fix' });
    // Without channels:manage there was no channel to create; the saved one was used.
    expect(slack.created).toEqual([]);
    expect(slack.samples).toEqual([expect.objectContaining({ channel: SAVED_CHANNEL })]);
    inOrder(d.lines, [
      'Snapwing posted a sample bug in #snapwing-sandbox. React to it with :bug:.',
      'Planned "CSV usage export has a header row but no data" at Fix now.',
      `Filed ${ISSUE} in Jira.`,
      'Snapwing started the fix.',
      'The test drive stopped at making the fix and opening the pull request on Slack.',
      'What happened: the fix failed: ',
      `What to do: \`snapwing trace ${ISSUE}\` shows every step it took. Check that the GitHub App can push to acme/admin (\`snapwing onboard --step github\`) and that the model keys work (\`snapwing onboard --step runtime\`), then run \`snapwing onboard --step test-drive\`.`,
      'Stopping Snapwing.',
    ]);
    expect(d.lines.some((l) => l.includes('The test drive passed'))).toBe(false);
    await stopped(d);
    await mapUntouched(w);
    expect(unhandled).toEqual([]);
  }, 120_000);

  it('stops when the installer stops waiting for a reaction, and names what to check', async () => {
    const w = await world({ anchor: SAMPLE_TS });
    const slack = slackDrive(SAVED_CHANNEL, 'chat:write');
    const d = await drive(w, { answers: { repo: REPO, 'slack-channel': SAVED_CHANNEL, level: 'keep', 'keep-waiting': 'stop' }, waitMs: { capture: 200 } }, (installer) =>
      slackInstaller(installer, w, slack, SAVED_CHANNEL, { fixIt: false, react: false }),
    );
    expect(d.result.outcome, d.lines.join('\n')).toBe('waiting');
    expect(d.result.state.steps['test-drive']?.blocked?.reason).toBe('the drive stopped at seeing your reaction on Slack: no reaction to the sample reached Snapwing (you stopped waiting)');
    inOrder(d.lines, [
      'Still waiting on seeing your reaction. Keep waiting?',
      'The test drive stopped at seeing your reaction on Slack.',
      'What to do: React to the sample in #snapwing-sandbox with :bug:. If you did, Snapwing is not getting Slack\'s events: check that SLACK_APP_TOKEN is in your .env file',
    ]);
    await stopped(d);
    expect(unhandled).toEqual([]);
  }, 60_000);

  it('stops the server on Ctrl-C and leaves the step to resume', async () => {
    const w = await world({ anchor: SAMPLE_TS });
    const slack = slackDrive(SAVED_CHANNEL, 'chat:write');
    const interrupts = new EventEmitter();
    const d = await drive(w, { answers: { repo: REPO, 'slack-channel': SAVED_CHANNEL, level: 'keep' }, interrupts }, async (installer) => {
      await until(installer, 'sample post', () => slack.samples[0]);
      interrupts.emit('SIGINT');
    });
    expect(d.result.outcome).toBe('aborted');
    expect(d.result.unanswered).toBe('test-drive.drive');
    expect(d.result.state.steps['test-drive']?.status).toBe('running');
    expect(interrupts.listenerCount('SIGINT')).toBe(0);
    await stopped(d);
    await mapUntouched(w);
  }, 60_000);
});

describe('test drive helpers', () => {
  it('reads a Teams channel link and refuses anything else', () => {
    const link = `https://teams.microsoft.com/l/channel/${encodeURIComponent(TEAMS_CHANNEL)}/snapwing-sandbox?groupId=${TEAM}&tenantId=${TENANT}`;
    expect(parseTeamsChannelLink(link)).toEqual({ id: TEAMS_CHANNEL, name: 'snapwing-sandbox', teamId: TEAM });
    expect(parseTeamsChannelLink(link.replace('https:', 'http:'))).toBeUndefined();
    expect(parseTeamsChannelLink(link.replace('teams.microsoft.com', 'teams.example.com'))).toBeUndefined();
    expect(parseTeamsChannelLink(link.replace(`groupId=${TEAM}`, 'groupId=../../etc'))).toBeUndefined();
    expect(parseTeamsChannelLink('not a link')).toBeUndefined();
  });

  it('prints untrusted text on one line without control characters', () => {
    expect(printable('ok\u001b[31m red\u0007\nnext\u202eline')).toBe('ok [31m red next line');
    expect(printable('x'.repeat(300), 20)).toBe(`${'x'.repeat(17)}...`);
  });
});
