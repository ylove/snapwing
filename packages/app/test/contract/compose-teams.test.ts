// Teams in the composed app on MSW: with the Teams secrets `compose` mounts the Bot Framework and Graph
// routes, puts the Teams adapter and context source in the engine, registers the Teams chat surface,
// starts the Teams status projector and the Graph subscriptions, and reports Teams' mode in `/healthz`;
// without them nothing Teams starts and the Slack install is as it was. The Bot Framework JWT is the
// real check against a locally generated key served as the JWKS (as in the transport's own test); the
// token endpoint, the Bot Connector, and Graph are MSW, and the activities are the Teams fixtures. An
// unhandled request fails the test, so no Microsoft endpoint is ever called. Runs on the dialect
// `SNAPWING_DB` selects.

import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import { DEMO_GITHUB_TOKEN, GITHUB_API, GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel } from '@snapwing/pipeline/demo/run.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { teamsUserKey } from '../../src/adapters/teams/chat-surface.ts';
import { teamsModeKey } from '../../src/adapters/teams/conversations.ts';
import { compose, MissingSecretsError, teamsClientState, type Composed, type ComposeOverrides, type TeamsInject } from '../../src/server/compose.ts';
import { LOCAL_RUNNER_WARNING, runServe } from '../../src/server/serve.ts';
import { bootComposed, BOT_USER, DEMO_LEVELS, DEMO_MAP, envFile, EXAMPLE_CONFIG, fakeSecrets, slackWorld, WORKSPACE_DOMAIN, type Booted } from '../fixtures/e2e/world.ts';

const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the harness was not expected to run')) };

// The tenant of the Teams fixtures.
const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const APP_PASSWORD = 'test-teams-app-password';
const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001';
const RAE_TEAMS_ID = '29:1rae-reporter-teams-id';
const SERVICE_URL = 'https://smba.test/amer/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const ACCESS_TOKEN = 'test-teams-access-token';
const SLACK_CHANNEL = 'C0HELPBUGS';

/** The channel thread of the capture: three Graph messages, the middle one the anchor. */
const CHATTER = '1790845080000';
const ANCHOR = '1790845200000';
const FOLLOW_UP = '1790845320000';
const ANCHOR_AT = '2026-10-08T09:02:00.000Z';
/** A later reply in the anchor's thread that names a second issue. */
const SECOND = '1790845500000';
const SECOND_AT = '2026-10-08T09:05:00.000Z';

const TEAMS_SECRETS = { TEAMS_APP_ID: APP_ID, TEAMS_APP_PASSWORD: APP_PASSWORD, TEAMS_TENANT_ID: TENANT };

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

// The Bot Framework's signing key and a token for an activity ----------------------------------------

const KID = 'compose-teams-key';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwt(): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64({ iss: 'https://api.botframework.com', aud: APP_ID, nbf: now - 60, exp: now + 3600, serviceUrl: SERVICE_URL });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signing.privateKey).toString('base64url')}`;
}

/** A request to the messaging endpoint, with a valid token unless `authorization` says otherwise. */
function activityRequest(base: string, activity: unknown, authorization: string | null = `Bearer ${jwt()}`): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request(`${base}/teams/messages`, { method: 'POST', headers, body: JSON.stringify(activity) });
}

// Activities: the fixtures, pointed at the capture's thread ------------------------------------------

const RAE_FROM = { id: RAE_TEAMS_ID, name: 'Rae Reporter', aadObjectId: RAE };
const ANCHOR_TEXT = 'The refund policy article on the help center still says 14 days, it should be 30';

/** "Fix it from here" on the anchor, by Rae: the action command fixture on this thread. */
function actionCommand(): Record<string, unknown> {
  const activity = fixture('activities/action-fetch-task.json');
  const value = activity['value'] as Record<string, unknown>;
  const message = value['messagePayload'] as Record<string, unknown>;
  const conversation = activity['conversation'] as Record<string, unknown>;
  delete message['linkToMessage'];
  return {
    ...activity,
    timestamp: ANCHOR_AT,
    from: RAE_FROM,
    conversation: { ...conversation, id: `${CHANNEL};messageid=${ANCHOR}` },
    value: {
      ...value,
      messagePayload: {
        ...message,
        id: ANCHOR,
        createdDateTime: ANCHOR_AT,
        from: { user: { id: RAE, displayName: 'Rae Reporter', userIdentityType: 'aadUser' }, application: null },
        body: { contentType: 'html', content: `<p>${ANCHOR_TEXT}</p>` },
        mentions: [],
      },
    },
  };
}

/** A tap on a card in the capture's thread, by Rae. */
function cardTap(cardActivityId: string, verb: string, data: Record<string, string>): Record<string, unknown> {
  const command = actionCommand();
  return {
    type: 'invoke',
    name: 'adaptiveCard/action',
    id: `tap-${verb}`,
    timestamp: new Date().toISOString(),
    channelId: 'msteams',
    serviceUrl: SERVICE_URL,
    from: RAE_FROM,
    recipient: command['recipient'],
    conversation: command['conversation'],
    channelData: command['channelData'],
    replyToId: cardActivityId,
    value: { action: { type: 'Action.Execute', verb, data } },
  };
}

// The Teams side of the world ------------------------------------------------------------------------

interface ConnectorCall {
  kind: 'personal' | 'send' | 'reply' | 'update';
  conversation: string;
  /** The activity replied to or edited; for a post, the id the Connector gave it. */
  activityId: string;
  body: Record<string, unknown>;
}

interface TeamsWorld {
  connector: ConnectorCall[];
  graph: string[];
  /** Token requests, by scope. */
  scopes: string[];
}

function graphMessage(id: string, at: string, text: string, user: string): Record<string, unknown> {
  return {
    id,
    replyToId: null,
    messageType: 'message',
    createdDateTime: at,
    lastModifiedDateTime: null,
    deletedDateTime: null,
    from: { application: null, device: null, user: { id: user, displayName: null, userIdentityType: 'aadUser' } },
    body: { contentType: 'html', content: `<p>${text}</p>` },
    attachments: [],
    mentions: [],
    reactions: [],
  };
}

const THREAD = [
  graphMessage(CHATTER, '2026-10-08T09:00:00.000Z', 'Morning all, fresh coffee in the kitchen', RAE),
  graphMessage(ANCHOR, ANCHOR_AT, ANCHOR_TEXT, RAE),
  graphMessage(FOLLOW_UP, '2026-10-08T09:04:00.000Z', 'Customers keep quoting the 14 days back to us on calls', SAM),
];

/** The card an outgoing activity carries. */
function cardOf(body: Record<string, unknown>): { actions?: { verb?: string; data?: Record<string, string> }[]; body?: unknown[] } | undefined {
  const attachments = Array.isArray(body['attachments']) ? (body['attachments'] as { content?: unknown }[]) : [];
  return attachments[0]?.content as { actions?: { verb?: string; data?: Record<string, string> }[] } | undefined;
}

const server = setupServer();
const unhandled: string[] = [];
const microsoft: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:start', ({ request }) => {
    const host = new URL(request.url).hostname;
    if (host.endsWith('microsoft.com') || host.endsWith('microsoftonline.com') || host.endsWith('botframework.com') || host === 'smba.test' || host.endsWith('trafficmanager.net')) {
      microsoft.push(`${request.method} ${host}`);
    }
  });
  server.events.on('request:unhandled', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });
});
afterAll(() => server.close());

/** The Bot Framework keys, the token endpoint, the Connector at the fixtures' serviceUrl, and Graph. */
function teamsWorld(options: { subscriptionStatus?: number } = {}): TeamsWorld {
  const world: TeamsWorld = { connector: [], graph: [], scopes: [] };
  let n = 0;
  const authorized = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${ACCESS_TOKEN}`;
  const denied = (): Response => HttpResponse.json({ error: { code: 'Unauthorized', message: 'no token' } }, { status: 401 });
  const id = (params: Record<string, unknown>, key: string): string => decodeURIComponent(String(params[key]));
  const json = async (request: Request): Promise<Record<string, unknown>> => (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { n: modulus, e } = signing.publicKey.export({ format: 'jwk' });
  server.use(
    http.get(METADATA_URL, () => HttpResponse.json(fixture('openid/openidconfiguration.json'))),
    http.get(JWKS_URL, () => HttpResponse.json({ keys: [{ kty: 'RSA', use: 'sig', kid: KID, n: modulus, e, endorsements: ['msteams'] }] })),
    http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      world.scopes.push(form.get('scope') ?? '');
      if (form.get('client_id') !== APP_ID || form.get('client_secret') !== APP_PASSWORD) return HttpResponse.json(fixture('openid/token-error.json'), { status: 401 });
      return HttpResponse.json(fixture('openid/token-response.json'));
    }),
    // The Bot Connector.
    http.post(`${SERVICE_URL}v3/conversations`, async ({ request }) => {
      if (!authorized(request)) return denied();
      world.connector.push({ kind: 'personal', conversation: '', activityId: '', body: await json(request) });
      return HttpResponse.json({ id: 'a:1personal-chat-rae' });
    }),
    http.post(`${SERVICE_URL}v3/conversations/:conversation/activities`, async ({ request, params }) => {
      if (!authorized(request)) return denied();
      const activityId = `teams-act-${String(++n)}`;
      world.connector.push({ kind: 'send', conversation: id(params, 'conversation'), activityId, body: await json(request) });
      return HttpResponse.json({ id: activityId });
    }),
    http.post(`${SERVICE_URL}v3/conversations/:conversation/activities/:activity`, async ({ request, params }) => {
      if (!authorized(request)) return denied();
      const activityId = `teams-act-${String(++n)}`;
      world.connector.push({ kind: 'reply', conversation: id(params, 'conversation'), activityId, body: await json(request) });
      return HttpResponse.json({ id: activityId });
    }),
    http.put(`${SERVICE_URL}v3/conversations/:conversation/activities/:activity`, async ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.connector.push({ kind: 'update', conversation: id(params, 'conversation'), activityId: id(params, 'activity'), body: await json(request) });
      return HttpResponse.json({ id: id(params, 'activity') });
    }),
    // Graph: the thread, its replies, users (no User.Read.All: the map's email stands in), members, subscriptions.
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`messages ${id(params, 'channel')}`);
      return HttpResponse.json({ value: [...THREAD].reverse() });
    }),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`message ${id(params, 'message')}`);
      const found = THREAD.find((m) => m['id'] === id(params, 'message'));
      return found === undefined ? HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 }) : HttpResponse.json(found);
    }),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message/replies/:reply`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`reply ${id(params, 'reply')}`);
      return id(params, 'reply') === SECOND
        ? HttpResponse.json({ ...graphMessage(SECOND, SECOND_AT, 'also the footer is broken', RAE), replyToId: id(params, 'message') })
        : HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 });
    }),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message/replies`, ({ request }) => (authorized(request) ? HttpResponse.json({ value: [] }) : denied())),
    http.get(`${GRAPH}/users/:user`, () => HttpResponse.json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }, { status: 403 })),
    http.get(`${GRAPH}/teams/:team/channels/:channel/members`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`members ${id(params, 'channel')}`);
      return HttpResponse.json({ value: [RAE, SAM].map((userId) => ({ id: `member-${userId}`, userId, roles: [] })) });
    }),
    http.post(`${GRAPH}/subscriptions`, async ({ request }) => {
      if (!authorized(request)) return denied();
      const body = await json(request);
      world.graph.push(`subscribe ${String(body['resource'])}`);
      const status = options.subscriptionStatus ?? 201;
      if (status !== 201) return HttpResponse.json({ error: { code: 'Forbidden', message: 'RSC grant missing' } }, { status });
      return HttpResponse.json({ ...fixture('graph/subscription.json'), resource: body['resource'], expirationDateTime: body['expirationDateTime'], clientState: body['clientState'] }, { status: 201 });
    }),
  );
  return world;
}

// The app around it ----------------------------------------------------------------------------------

let tdb: TestDatabase;
let dir: string;
let booted: Booted | undefined;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-compose-teams-'));
  unhandled.length = 0;
  microsoft.length = 0;
});

afterEach(async () => {
  await booted?.stop();
  booted = undefined;
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

/** The demo map, plus the capture's Teams channel on the help surface and the people's Teams ids. */
async function writeMap(): Promise<string> {
  const xml = (await readFile(DEMO_MAP, 'utf8'))
    .replace('  </channels>', `    <channel id="${CHANNEL}" name="help-bugs-teams" surface="help" confidence="explicit" platform="teams" team="${TEAM}" />\n  </channels>`)
    .replace('<person slackId="U0HELPDEV"', `<person slackId="U0HELPDEV" teamsId="${SAM}"`)
    .replace('  </people>', `    <person teamsId="${RAE}" handle="rae" email="rae@example.com" role="reporter" />\n  </people>`);
  const path = join(dir, 'workspace-context.xml');
  await writeFile(path, xml);
  return path;
}

async function env(): Promise<Record<string, string>> {
  return { SNAPWING_MAP: await writeMap(), SNAPWING_WORKDIR_ROOT: join(dir, 'work'), SNAPWING_PLAYBOOK: join(dir, 'playbook.xml'), SNAPWING_INSTRUCTIONS: join(dir, 'INSTRUCTIONS.md') };
}

/** `compose` alone (nothing started): what it builds for these secrets. */
async function composeOnly(secrets: Record<string, string>, overrides: ComposeOverrides = {}): Promise<Composed> {
  const file = join(dir, 'direct.env');
  await writeFile(file, envFile(secrets));
  const state = await tdb.open();
  return compose({
    config: loadAppConfig(await readFile(EXAMPLE_CONFIG, 'utf8')),
    secrets: createEnvFileSecrets({ path: file, fallbackEnv: {} }),
    state,
    workflow: new InProcessWorkflow(state),
    env: await env(),
    overrides: { resolveHarness: () => idleHarness, slackBotUserId: BOT_USER, slackWorkspaceDomain: WORKSPACE_DOMAIN, ...overrides },
  });
}

const names = (services: Composed['apiServices']): string[] => (services ?? []).map((s) => s.name);
const paths = (c: Composed): string[] => c.routes.map((r) => `${r.method} ${r.path}`);
const TEAMS_ROUTES = ['POST /teams/messages', 'POST /teams/notifications', 'POST /teams/lifecycle'];

// Tests ----------------------------------------------------------------------------------------------

describe('compose with Teams under snapwing serve', () => {
  it('mounts the Teams routes and services next to Slack, and reports Teams in /healthz and /metrics', async () => {
    slackWorld(server, SLACK_CHANNEL, []);
    // Graph refuses the subscription (no RSC grant): the team runs in reduced mode.
    const teams = teamsWorld({ subscriptionStatus: 403 });
    const secrets: Record<string, string> = { ...fakeSecrets(), ...TEAMS_SECRETS, TEAMS_PUBLIC_URL: 'https://teams-tunnel.example.com/' };
    const file = join(dir, 'serve.env');
    await writeFile(file, envFile(secrets));
    const out: string[] = [];
    const err: string[] = [];
    const signals = new EventEmitter();
    let markReady!: (info: { url?: string }) => void;
    const ready = new Promise<{ url?: string }>((r) => (markReady = r));
    const code = runServe(
      ['--port', '0', '--host', '127.0.0.1', '--config', EXAMPLE_CONFIG],
      { env: { ...dbEnv(), ...(await env()), SNAPWING_ENV_FILE: file }, stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
      { signals, onReady: markReady, compose: (deps) => compose({ ...deps, overrides: { resolveHarness: () => idleHarness } }) },
    );
    void code.then(() => markReady({}));
    const { url } = await ready;
    expect(err).toEqual([`snapwing serve: ${LOCAL_RUNNER_WARNING}`]);
    const log = out.join('\n');
    expect(log).toContain('composed: slack http, teams http, runner local');
    expect(log).toContain("teams: the bot's messaging endpoint is https://teams-tunnel.example.com/teams/messages");
    for (const service of ['slack http transport', 'teams http transport', 'slack status projector', 'teams status projector', 'teams subscriptions', 'channel members refresh']) {
      expect(log).toContain(`${service} started`);
    }

    // /healthz: Slack full; Teams reduced once the subscription is refused, naming the team and why.
    await vi.waitFor(
      async () => {
        const health = (await (await fetch(`${url}/healthz`)).json()) as { ok: boolean; platforms?: unknown[] };
        expect(health).toEqual({
          ok: true,
          platforms: [
            { id: 'slack', ok: true, mode: 'full' },
            { id: 'teams', ok: true, mode: 'reduced', detail: `reduced in 1 of 1 team: team ${TEAM} (missing ChannelMessage.Read.Group)` },
          ],
        });
      },
      { timeout: 10_000, interval: 50 },
    );
    // The subscription went to TEAMS_PUBLIC_URL with the derived clientState.
    expect(teams.graph).toContain(`subscribe /teams/${TEAM}/channels/getAllMessages`);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('snapwing_teams_drain_paused_seconds{workspace=');
    expect(metrics).toContain('snapwing_outbox_parked_rows{target="teams"');
    expect(metrics.match(/^# TYPE snapwing_outbox_parked_rows /gm)).toHaveLength(1);

    // The messaging endpoint checks the token first; the Graph routes answer the handshake and check clientState.
    expect((await fetch(activityRequest(url ?? '', fixture('activities/personal-text.json'), null))).status).toBe(401);
    expect((await fetch(activityRequest(url ?? '', fixture('activities/personal-text.json'), 'Bearer not-a-jwt'))).status).toBe(401);
    const handshake = await fetch(`${url}/teams/notifications?validationToken=hello%20graph`, { method: 'POST' });
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toBe('hello graph');
    const notification = (clientState: string) => ({ value: [{ subscriptionId: 'sub-1', changeType: 'updated', clientState, resource: `teams('${TEAM}')/channels('${CHANNEL}')/messages('${CHATTER}')` }] });
    const post = (body: unknown) => fetch(`${url}/teams/notifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(notification('guessed-state'))).status).toBe(403);
    expect((await post(notification(teamsClientState(secrets['SNAPWING_ENCRYPTION_KEY'] ?? '')))).status).toBe(202);

    signals.emit('SIGTERM');
    expect(await code).toBe(0);
    expect(err).toEqual([`snapwing serve: ${LOCAL_RUNNER_WARNING}`]);
    expect(teams.scopes).toContain('https://graph.microsoft.com/.default');
    expect(unhandled).toEqual([]);
  }, 60_000);
});

/** The composed app with Slack and Teams on the capture's recording and the Jira and GitHub worlds. */
async function bootCapture(overrides: ComposeOverrides = {}) {
    const recording = parseScenario('01-level-0-ticket-only.json', JSON.parse(await readFile(join(DEMO_LEVELS, '01-level-0-ticket-only.json'), 'utf8')));
    const slack = slackWorld(server, SLACK_CHANNEL, []);
    const teams = teamsWorld();
    const jiraWorld = new JiraWorld(() => undefined);
    const githubWorld = new GitHubWorld(() => undefined);
    githubWorld.addRepos(recording.github);
    server.use(
      ...jiraHandlers(jiraWorld),
      ...githubHandlers(githubWorld),
      http.post(`${GITHUB_API}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ token: DEMO_GITHUB_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 }),
      ),
    );
    // The recording's answers, with the segmentation naming this thread's Graph ids.
    const model = new RecordedModel();
    model.use('teams level 0', {
      ...recording.model,
      segmentation: { included: [ANCHOR, FOLLOW_UP], excluded: [{ id: CHATTER, reason: 'unrelated chatter' }], resolutionMessageId: '' },
    });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const secrets = { ...fakeSecrets(), ...TEAMS_SECRETS, JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
    booted = await bootComposed({
      state: await tdb.open(),
      configXml: await readFile(EXAMPLE_CONFIG, 'utf8'),
      secrets,
      dir,
      env: await env(),
      overrides: { ...overrides, model: withValidation(model), resolveHarness: () => idleHarness, slackBotUserId: BOT_USER, slackWorkspaceDomain: WORKSPACE_DOMAIN, projectorPollMs: 25 },
    });
    const b = booted;
    return { b, slack, teams, jiraWorld };
}

describe('one Teams capture through the composed app', () => {
  it('runs the action command to a filed issue: the engine files it, a tap reaches the interactivity, and the status message drains to Teams', async () => {
    const { b, slack, teams, jiraWorld } = await bootCapture();
    const { state, logged, errors } = b;
    expect(paths(b.composed)).toEqual(expect.arrayContaining(TEAMS_ROUTES));
    expect(b.composed.deps?.chat.platforms).toEqual(['slack', 'teams']);

    // "Fix it from here" on the anchor: authenticated, captured, answered with the invoke's task message.
    const ack = await b.api.fetch(activityRequest('http://snapwing.test', actionCommand()));
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ task: { type: 'message', value: 'On it, pulling context' } });
    // The authenticated activity remembered its sender, so their personal chat opens with the `29:` id.
    expect(JSON.parse((await createKvCache(state).get(teamsUserKey(RAE))) ?? '{}')).toMatchObject({ aadObjectId: RAE, teamsUserId: RAE_TEAMS_ID, serviceUrl: SERVICE_URL, tenantId: TENANT });

    // The scope preview, read from Graph around the anchor and posted in the anchor's thread.
    const scopeCard = await vi.waitFor(
      () => {
        const found = teams.connector.find((c) => c.kind === 'reply' && (cardOf(c.body)?.actions ?? []).some((a) => a.verb === 'looks-right'));
        if (found === undefined) throw new Error(`no scope card yet (${logged.join('; ')})`);
        return found;
      },
      { timeout: 20_000, interval: 25 },
    );
    expect(scopeCard.conversation).toBe(`${CHANNEL};messageid=${ANCHOR}`);
    expect(teams.graph).toEqual(expect.arrayContaining([`message ${ANCHOR}`, `messages ${CHANNEL}`]));
    const incidentId = cardOf(scopeCard.body)?.actions?.find((a) => a.verb === 'looks-right')?.data?.['incidentId'] ?? '';
    expect((await state.getIncident(incidentId))?.source).toBe('teams');

    // Looks right, tapped by the reporter: the interactivity answers with the card, edited for everyone.
    const tap = await b.api.fetch(activityRequest('http://snapwing.test', cardTap(scopeCard.activityId, 'looks-right', { incidentId })));
    expect(tap.status).toBe(200);
    expect(await tap.json()).toMatchObject({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: { type: 'AdaptiveCard' } });
    expect(teams.connector.some((c) => c.kind === 'update' && c.activityId === scopeCard.activityId)).toBe(true);

    // Filed by the Jira projector; the status message posted once in the thread by the Teams status projector, then edited.
    await vi.waitFor(
      async () => {
        const view = await state.getIncident(incidentId);
        expect(view?.status).toBe('filed');
        expect(view?.statusMsgId).toBeDefined();
        expect(jiraWorld.issues.get('HELP-1')?.custom['Agent Status']).toBe('filed · waiting on human');
        expect(await state.drainOutbox('teams', 10)).toEqual([]);
        expect(await state.drainOutbox('jira', 10)).toEqual([]);
      },
      { timeout: 30_000, interval: 50 },
    );
    const log = await state.read(incidentId);
    expect(log.filter((e) => e.type === 'status-message-posted')).toHaveLength(1);
    const statusMsgId = (await state.getIncident(incidentId))?.statusMsgId;
    const statusPost = teams.connector.find((c) => c.activityId === statusMsgId && c.kind === 'reply');
    expect(statusPost?.conversation).toBe(`${CHANNEL};messageid=${ANCHOR}`);
    expect(log).toContainEqual(expect.objectContaining({ type: 'bot-message-posted', payload: { platform: 'teams', channel: CHANNEL, messageId: statusMsgId, role: 'status' } }));
    // Every later copy edited that one message (or the scope card, once): nothing else was posted as a status.
    const edits = teams.connector.filter((c) => c.kind === 'update');
    expect(edits.every((c) => c.activityId === statusMsgId || c.activityId === scopeCard.activityId)).toBe(true);
    expect(JSON.stringify(edits.filter((c) => c.activityId === statusMsgId).at(-1)?.body ?? statusPost?.body)).toContain('HELP-1');

    // Slack, configured alongside, saw nothing of the Teams incident.
    expect(slack.calls.filter((c) => c.method === 'chat.postMessage' || c.method === 'chat.update')).toEqual([]);
    expect(slack.unknown).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(errors).toEqual([]);
    expect(logged).toEqual([]);
  }, 60_000);

  it('files the second issue of a scope change: Yes on the card makes a Teams incident anchored on the reply, linked from the first', async () => {
    let inject: TeamsInject | undefined;
    const { b, teams } = await bootCapture({ teamsInject: (fn) => (inject = fn) });
    const { state, logged } = b;
    if (inject === undefined) throw new Error('compose did not hand over the Teams seam');
    const waitFor = <T,>(read: () => T | undefined, what: string): Promise<T> =>
      vi.waitFor(
        () => {
          const found = read();
          if (found === undefined) throw new Error(`no ${what} yet (${logged.join('; ')})`);
          return found;
        },
        { timeout: 20_000, interval: 25 },
      );
    const cardWith = (verb: string) => teams.connector.find((c) => c.kind === 'reply' && (cardOf(c.body)?.actions ?? []).some((a) => a.verb === verb));

    // Filed as before: the action command, then Looks right.
    expect((await b.api.fetch(activityRequest('http://snapwing.test', actionCommand()))).status).toBe(200);
    const preview = await waitFor(() => cardWith('looks-right'), 'scope preview');
    const incidentId = cardOf(preview.body)?.actions?.find((a) => a.verb === 'looks-right')?.data?.['incidentId'] ?? '';
    expect((await b.api.fetch(activityRequest('http://snapwing.test', cardTap(preview.activityId, 'looks-right', { incidentId })))).status).toBe(200);
    await vi.waitFor(async () => expect((await state.getIncident(incidentId))?.status).toBe('filed'), { timeout: 30_000, interval: 50 });

    // A reply in the thread that names another issue: the scope-change card, then Yes.
    const reply = { ...actionCommand(), type: 'message', id: SECOND, text: 'also the footer is broken', timestamp: SECOND_AT, value: undefined, name: undefined };
    expect(await inject({ activity: reply })).toEqual({ status: 200 });
    const scopeCard = await waitFor(() => cardWith('yes'), 'scope-change card');
    const data = cardOf(scopeCard.body)?.actions?.find((a) => a.verb === 'yes')?.data ?? {};
    const yes = await b.api.fetch(activityRequest('http://snapwing.test', cardTap(scopeCard.activityId, 'yes', data)));
    expect(yes.status).toBe(200);

    // The second incident: Teams, anchored on the reply, reported by its author, named by the scope-split event.
    const other = await vi.waitFor(
      async () => {
        const found = (await state.findIncidents({ limit: 5 })).find((i) => i.id !== incidentId);
        if (found === undefined) throw new Error(`no linked incident yet (${logged.join('; ')})`);
        return found;
      },
      { timeout: 20_000, interval: 25 },
    );
    expect(other).toMatchObject({ source: 'teams', anchorId: SECOND, channelId: CHANNEL, reporterId: RAE });
    const split = (await state.read(incidentId)).filter((e) => e.type === 'text-signal' && (e.payload as { kind?: string }).kind === 'scope-change');
    expect(split.map((e) => [(e.payload as { phase?: string }).phase, (e.payload as { linkedIncidentId?: string }).linkedIncidentId])).toEqual([
      ['proposed', undefined],
      ['split', other.id],
    ]);
    // The same message through Fix it dedupes onto it: no third incident.
    const again = { ...actionCommand() };
    const value = again['value'] as Record<string, unknown>;
    const message = value['messagePayload'] as Record<string, unknown>;
    again['value'] = { ...value, messagePayload: { ...message, id: SECOND, replyToId: ANCHOR } };
    expect((await b.api.fetch(activityRequest('http://snapwing.test', again))).status).toBe(200);
    await vi.waitFor(async () => expect((await state.findIncidents({ limit: 5 })).map((i) => i.id).sort()).toEqual([incidentId, other.id].sort()), { timeout: 5_000, interval: 25 });
    expect(unhandled).toEqual([]);
  }, 60_000);
});

describe('compose with and without Teams', () => {
  it('leaves Teams off without its secrets, and Slack exactly as it was', async () => {
    const withoutTeams = await composeOnly(fakeSecrets());
    expect(paths(withoutTeams).filter((p) => p.includes('/teams/'))).toEqual([]);
    expect([...names(withoutTeams.apiServices), ...names(withoutTeams.workerServices)].filter((n) => n.startsWith('teams'))).toEqual([]);
    expect(withoutTeams.deps?.chat.platforms).toEqual(['slack']);
    expect(await withoutTeams.health?.()).toEqual([{ id: 'slack', ok: true, mode: 'full' }]);
    expect(await withoutTeams.metrics?.()).not.toContain('teams');
    expect(microsoft).toEqual([]);

    // With Teams, Slack's routes and services are the same ones, with Teams' added.
    teamsWorld();
    const withTeams = await composeOnly({ ...fakeSecrets(), ...TEAMS_SECRETS });
    expect(paths(withTeams).filter((p) => !TEAMS_ROUTES.includes(p))).toEqual(paths(withoutTeams));
    expect(names(withTeams.apiServices).filter((n) => n !== 'teams http transport')).toEqual(names(withoutTeams.apiServices));
    expect(names(withTeams.workerServices).filter((n) => n !== 'teams status projector' && n !== 'teams subscriptions')).toEqual(names(withoutTeams.workerServices));
    expect(withTeams.deps?.chat.platforms).toEqual(['slack', 'teams']);
  });

  it('requires the whole Teams group once any of it is set, and names it when no chat platform is', async () => {
    await expect(composeOnly({ ...fakeSecrets(), TEAMS_APP_ID: APP_ID })).rejects.toThrow('missing secrets: TEAMS_APP_PASSWORD, TEAMS_TENANT_ID');
    await expect(composeOnly({ ...fakeSecrets(), TEAMS_PUBLIC_URL: 'https://teams-tunnel.example.com' })).rejects.toThrow('missing secrets: TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_TENANT_ID');
    const noChat = fakeSecrets();
    for (const name of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) delete noChat[name];
    await expect(composeOnly(noChat)).rejects.toThrow(MissingSecretsError);
    await expect(composeOnly(noChat)).rejects.toThrow('Teams needs TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_TENANT_ID');
    expect(microsoft).toEqual([]);
  });

  it('boots on Teams alone, and its e2e seam hands an activity past authentication', async () => {
    const teams = teamsWorld();
    const noSlack: Record<string, string> = { ...fakeSecrets(), ...TEAMS_SECRETS };
    for (const name of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) delete noSlack[name];
    let inject: TeamsInject | undefined;
    const composed = await composeOnly(noSlack, { teamsInject: (fn) => (inject = fn) });
    expect(composed.deps?.chat.platforms).toEqual(['teams']);
    expect(paths(composed).filter((p) => p.includes('/slack/'))).toEqual([]);
    expect(paths(composed)).toEqual(expect.arrayContaining(TEAMS_ROUTES));
    // No team's mode is known yet: the map's one Teams team is full until something says otherwise.
    expect(await composed.health?.()).toEqual([{ id: 'teams', ok: true, mode: 'full' }]);

    // `queue` in Rae's personal chat, with no token at all: the seam treats it as authenticated.
    const queue = { ...fixture('activities/personal-text.json'), text: 'queue' };
    if (inject === undefined) throw new Error('compose did not hand over the Teams seam');
    expect(await inject({ activity: queue })).toEqual({ status: 200 });
    const sent = teams.connector.filter((c) => c.kind === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.conversation).toBe('a:1personal-chat-rae');
    expect(JSON.stringify(sent[0]?.body)).toContain('Your reports');
    // The HTTP route still refuses the same activity without a token.
    const route = composed.routes.find((r) => r.path === '/teams/messages');
    expect((await route?.handler(activityRequest('http://snapwing.test', queue, null), { params: {} }))?.status).toBe(401);

    // A team the subscriptions marked reduced shows in /healthz with the reason.
    const state = await tdb.open();
    if (!(state instanceof StateStore)) throw new Error('expected the StateStore');
    await createKvCache(state).set(teamsModeKey(TEAM), JSON.stringify({ mode: 'reduced', since: new Date().toISOString(), retryAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'metered API not enabled' }));
    expect(await composed.health?.()).toEqual([{ id: 'teams', ok: true, mode: 'reduced', detail: `reduced in 1 of 1 team: team ${TEAM} (metered API not enabled)` }]);
    expect(unhandled).toEqual([]);
  });
});

function dbEnv(): Record<string, string> {
  return tdb.dialect === 'postgres'
    ? { SNAPWING_DB: 'postgres', DATABASE_URL: tdb.options.url ?? '' }
    : { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: tdb.options.url ?? '' };
}
