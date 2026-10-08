// Levels 1 and 2 end to end through the real app on MSW, on Teams (the Slack run is e2e-levels.test.ts):
// the pre-live proof that Teams composes the same way. An engineer's 🐛 on the reporter's channel message
// is found by the Graph diff (a change notification, the message read from MSW Graph), the scope and Fix it
// taps are `Action.Execute` invokes on the cards the app posted, the Jira projector files with custom
// fields, Jira's In Progress webhook starts the real local runner and generic harness adapter on the fake
// agent (fixtures/e2e/fake-harness.mjs), the review job approves the PR the fixer opened, and the one
// status message is posted in the thread and edited in place through every row. The same flow runs in
// reduced mode, where Graph refuses the subscription: the action command still files, a 🐛 starts nothing,
// and every card says so.
//
// No keys and no network: Bot Framework (OpenID with a local key, the token endpoint, the Connector),
// Graph, Jira, and GitHub are MSW; git remotes are local bare repositories (fixtures/e2e/github.ts). Teams
// stands alone here (no Slack secrets), so nothing but Teams can answer. Runs on the dialect `SNAPWING_DB`
// selects (pg-boss on Postgres).

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventType } from '@snapwing/pipeline/contracts/events.ts';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel, type Scenario } from '@snapwing/pipeline/demo/run.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createGitHubOAuth } from '../../src/github/oauth.ts';
import type { TeamsInject } from '../../src/server/compose.ts';
import { FakeGitHub, type GitHubPerson } from '../fixtures/e2e/github.ts';
import { JiraWebhooks } from '../fixtures/e2e/jira.ts';
import {
  actionCommand,
  activityRequest,
  activityText,
  cardOf,
  cardTap,
  channelMessage,
  graphMessage,
  messageChanged,
  TEAM,
  TEAMS_SECRETS,
  teamsWorld,
  verbsOf,
  type ConnectorCall,
  type TeamsPerson,
  type TeamsThread,
  type TeamsWorld,
} from '../fixtures/e2e/teams.ts';
import { JIRA_HOOK_SECRET, bootComposed, DEMO_LEVELS, DEMO_MAP, EXAMPLE_CONFIG, fakeSecrets, type Booted } from '../fixtures/e2e/world.ts';

const HARNESS = fileURLToPath(new URL('../fixtures/e2e/fake-harness.mjs', import.meta.url));
/** The repository's test command for the regression proof: every `test/*.test.sh` must pass. */
const TEST_COMMAND = 'for t in test/*.test.sh; do sh "$t" || exit 1; done';
const WAIT = { timeout: 20_000, interval: 25 };

const server = setupServer();
const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:unhandled', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });
});
afterAll(() => server.close());

let tdb: TestDatabase;
let dir: string;
let booted: Booted | undefined;
let github: FakeGitHub | undefined;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-e2e-teams-'));
  unhandled.length = 0;
});

afterEach(async () => {
  await booted?.stop();
  booted = undefined;
  await github?.remove();
  github = undefined;
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

// The world ---------------------------------------------------------------------------------------

interface Plan {
  summary: string;
  files: Record<string, string>;
  test: string;
  hangAfterPr?: boolean;
  reviewGate?: boolean;
}

/** The fix and its regression test per recording: the test fails on the seeded bug and passes after. */
const FIXES: Readonly<Record<string, Omit<Plan, 'hangAfterPr' | 'reviewGate'>>> = {
  'acme/admin': {
    summary: 'append the usage rows to the CSV export',
    files: {
      'src/reports/csv-export.ts':
        "export function usageCsv(rows: UsageRow[]): string {\n  const header = 'account,seats,usage';\n  return [header, ...rows.map((r) => [r.account, r.seats, r.usage].join(','))].join('\\n');\n}\n",
      'test/csv-export.test.sh': "grep -q 'rows.map' src/reports/csv-export.ts\n",
    },
    test: 'test/csv-export.test.sh',
  },
  'acme/web': {
    summary: 'keep the order total when a coupon applies',
    files: {
      'src/checkout/coupon.ts': 'export function applyCoupon(cart: Cart, code: string): Cart {\n  const total = cart.total;\n  return { ...cart, code, total };\n}\n',
      'test/coupon.test.sh': "grep -q 'const total = cart.total' src/checkout/coupon.ts\n",
    },
    test: 'test/coupon.test.sh',
  },
};

/** A person of the recordings who may own a surface: the map's handle and the GitHub account they link. */
type Engineer = TeamsPerson & { handle?: string; github?: GitHubPerson };

/** The people of the recordings, by their Slack ids, with the Teams ids the map gives them. Fakes only. */
const PEOPLE: Readonly<Record<string, Engineer>> = {
  U0SALESLEAD: { aad: '6f1c2a3b-0000-4000-8000-00000000a001', botId: '29:1pat-reporter', name: 'Pat Sales' },
  U0SUPPORT: { aad: '6f1c2a3b-0000-4000-8000-00000000a002', botId: '29:1sam-support', name: 'Sam Support' },
  U0ADMDEV: {
    aad: '6f1c2a3b-0000-4000-8000-00000000e001',
    botId: '29:1ari-engineer',
    name: 'Ari Admin',
    handle: 'adminDev',
    github: { login: 'ari-acme', id: 7100001, token: 'test-user-token-ari', code: 'test-oauth-code-ari' },
  },
  U0WEBDEV: {
    aad: '6f1c2a3b-0000-4000-8000-00000000e002',
    botId: '29:1dana-engineer',
    name: 'Dana Web',
    handle: 'webDev',
    github: { login: 'dana-acme', id: 7100002, token: 'test-user-token-dana', code: 'test-oauth-code-dana' },
  },
};

/** The Teams channel of each recording's Slack channel: the same surface and level, on Teams. */
const CHANNELS: Readonly<Record<string, { id: string; name: string }>> = {
  C0ADMBUGS: { id: '19:adm0a7e9d2b4c1a8e6f@thread.tacv2', name: 'admin-bugs-teams' },
  C0WEBBUGS: { id: '19:web0a7e9d2b4c1a8e6f@thread.tacv2', name: 'web-bugs-teams' },
};

const person = (slackId: string): Engineer => {
  const found = PEOPLE[slackId];
  if (found === undefined) throw new Error(`no Teams person for ${slackId}`);
  return found;
};

/** The demo map, plus the recordings' surfaces' Teams channels and the people's Teams ids. */
async function writeMap(): Promise<string> {
  let xml = await readFile(DEMO_MAP, 'utf8');
  const channels = Object.entries(CHANNELS)
    .map(([slack, c]) => {
      const surface = new RegExp(`<channel id="${slack}"[^>]* surface="(\\w+)"`).exec(xml)?.[1];
      return `    <channel id="${c.id}" name="${c.name}" surface="${surface}" confidence="explicit" platform="teams" team="${TEAM}" />`;
    })
    .join('\n');
  // A Teams install's map names Teams channels for these surfaces: the PR card also goes to the surface's
  // first channel, and a Slack channel id there would be posted to through the Teams Connector.
  const surfaces = new Set([...channels.matchAll(/ surface="(\w+)"/g)].map((m) => m[1]));
  xml = xml.replace(/\s*<channel id="C0[^>]* surface="(\w+)"[^>]*\/>/g, (line, surface: string) => (surfaces.has(surface) ? '' : line));
  xml = xml.replace('  </channels>', `${channels}\n  </channels>`);
  for (const [slack, p] of Object.entries(PEOPLE)) {
    if (slack === 'U0SALESLEAD' || slack === 'U0SUPPORT') continue;
    xml = xml.replace(`<person slackId="${slack}"`, `<person slackId="${slack}" teamsId="${p.aad}"`);
  }
  xml = xml.replace(
    '  </people>',
    `    <person teamsId="${person('U0SALESLEAD').aad}" handle="pat" email="pat@example.com" role="reporter" />\n    <person teamsId="${person('U0SUPPORT').aad}" handle="sam" email="sam@example.com" role="reporter" />\n  </people>`,
  );
  const path = join(dir, 'workspace-context.xml');
  await writeFile(path, xml);
  return path;
}

interface World {
  booted: Booted;
  recording: Scenario;
  teams: TeamsWorld;
  inject: TeamsInject;
  thread: TeamsThread;
  jira: JiraWorld;
  jiraHooks: JiraWebhooks;
  github: FakeGitHub;
  repo: string;
  /** The world dir the fake harness reads plans from and writes pull requests to. */
  harnessDir: string;
  /** The reporter of the recording (the anchor's author). */
  reporter: TeamsPerson;
  /** The engineer who owns the surface. */
  owner: Engineer;
  /** The anchor's Graph message id. */
  anchor: string;
  /** Set once the scope card names it. */
  incidentId?: string;
}

interface WorldOptions {
  plan?: Partial<Plan>;
  /** Graph refuses the subscription, so the team runs in reduced mode. */
  reduced?: boolean;
}

/** A Graph message id for a recording's Slack timestamp: epoch milliseconds, as Teams numbers them. */
const graphId = (ts: string): string => String(Math.round(Number(ts) * 1000));

async function world(file: string, issueKey: string, options: WorldOptions = {}): Promise<World> {
  const recording = parseScenario(file, JSON.parse(await readFile(join(DEMO_LEVELS, file), 'utf8')));
  const channel = CHANNELS[recording.channel.id];
  if (channel === undefined) throw new Error(`${file}: no Teams channel for ${recording.channel.id}`);
  const reporter = person(recording.reporter.id);
  const anchor = graphId(recording.anchor);
  const thread: TeamsThread = { channel: channel.id, anchor, anchorAt: new Date(Number(anchor)).toISOString() };
  const everyone = Object.values(PEOPLE).map((p) => p.aad);
  const teams = teamsWorld(
    server,
    recording.messages.map((m) => graphMessage(graphId(m.ts), new Date(Number(graphId(m.ts))).toISOString(), m.text, person(m.user).aad)),
    { channel: channel.id, members: everyone, ...(options.reduced === true ? { subscriptionStatus: 403 } : {}) },
  );
  const jira = new JiraWorld(() => undefined);
  const jiraHooks = new JiraWebhooks(jira);
  const demoGitHub = new GitHubWorld(() => undefined);
  demoGitHub.addRepos(recording.github);
  const harnessDir = join(dir, 'harness');
  github = new FakeGitHub(harnessDir);
  github.people.push(...Object.values(PEOPLE).flatMap((p) => (p.github === undefined ? [] : [p.github])));
  const [repo] = Object.keys(recording.github);
  const fix = repo === undefined ? undefined : FIXES[repo];
  if (repo === undefined || fix === undefined) throw new Error(`${file}: no fix planned for its repository`);
  for (const [name, files] of Object.entries(recording.github)) await github.addRepo(name, files);
  await mkdir(join(harnessDir, 'plans'), { recursive: true });
  await mkdir(join(harnessDir, 'gates'), { recursive: true });
  await writeFile(join(harnessDir, 'plans', `${issueKey}.json`), JSON.stringify({ ...fix, reviewGate: true, ...options.plan }));
  // The first matching handler wins: the e2e Jira workflow over the demo one, the fake GitHub before the demo reads.
  server.use(...jiraHooks.handlers(), ...github.handlers(), ...jiraHandlers(jira), ...githubHandlers(demoGitHub));

  // Generated per run, never committed: the App JWT is signed for real.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const secrets: Record<string, string> = { ...fakeSecrets(), ...TEAMS_SECRETS, JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
  // Teams stands alone: nothing in this run may reach Slack.
  for (const name of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) delete secrets[name];
  // The example config with both harness roles on the fake agent through the generic adapter.
  const command = [process.execPath, HARNESS, harnessDir].map((a) => `&quot;${a}&quot;`).join(' ');
  const configXml = (await readFile(EXAMPLE_CONFIG, 'utf8')).replace(
    /<harness [\s\S]*?<\/harness>/,
    `<harness fixer="generic" review="generic"><generic id="fake-agent" command="${command}" timeout="PT2M"/></harness>`,
  );
  // The recording's answers, with the segmentation naming this thread's Graph ids.
  const model = new RecordedModel();
  const seg = recording.model['segmentation'] as { included: string[]; excluded: { id: string; reason: string }[]; resolutionMessageId: string };
  model.use(recording.name, {
    ...recording.model,
    segmentation: {
      included: seg.included.map(graphId),
      excluded: seg.excluded.map((e) => ({ ...e, id: graphId(e.id) })),
      resolutionMessageId: seg.resolutionMessageId === '' ? '' : graphId(seg.resolutionMessageId),
    },
  });
  let inject: TeamsInject | undefined;
  booted = await bootComposed({
    state: await tdb.open(),
    configXml,
    secrets,
    dir,
    env: { SNAPWING_MAP: await writeMap(), SNAPWING_WORKDIR_ROOT: join(dir, 'work'), SNAPWING_TEST_COMMAND: TEST_COMMAND },
    overrides: { model: withValidation(model), projectorPollMs: 25, gitRemoteUrl: github.remoteUrl, teamsInject: (fn) => (inject = fn) },
  });
  if (inject === undefined) throw new Error('compose did not hand over the Teams seam');
  return { booted, recording, teams, inject, thread, jira, jiraHooks, github, repo, harnessDir, reporter, owner: person(ownerOf(recording)), anchor };
}

/** The engineer who owns the recording's surface: the one its Fix it tap is recorded against. */
function ownerOf(recording: Scenario): string {
  const tap = recording.taps?.find((t) => t.choice === 'approve_fix');
  return tap?.by ?? (recording.channel.id === 'C0WEBBUGS' ? 'U0WEBDEV' : 'U0ADMDEV');
}

// Steps -------------------------------------------------------------------------------------------

/** Links an engineer's GitHub account through the composed OAuth routes, as at onboarding. */
async function linkGitHub(w: World, who: Engineer): Promise<void> {
  const gh = who.github;
  if (gh === undefined) throw new Error(`${who.name} has no GitHub account`);
  const workspaceId = await ensureInstallWorkspace(w.booted.state);
  const oauth = createGitHubOAuth({ state: w.booted.state, secrets: w.booted.secrets, workspaceId });
  const link = new URL(await oauth.linkUrl({ chat: 'teams', userId: who.aad }));
  const start = await w.booted.api.fetch(new Request(`http://snapwing.test${link.pathname}${link.search}`));
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location') ?? '');
  expect(authorize.origin).toBe('https://github.com');
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  // The user approves on GitHub, which redirects back with a code and the same state.
  const callback = new URL('http://snapwing.test/auth/github/callback');
  callback.searchParams.set('code', gh.code);
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  const done = await w.booted.api.fetch(new Request(callback, { headers: { cookie } }));
  expect(done.status).toBe(200);
  expect(await done.text()).toContain(`@${gh.login}`);
}

/** The reporter's message reaches the bot as RSC delivers it: it seeds the conversation and starts nothing. */
async function reporterPosts(w: World): Promise<void> {
  const text = w.recording.messages.find((m) => m.ts === w.recording.anchor)?.text ?? '';
  expect(await w.inject({ activity: channelMessage(w.thread, w.reporter, text) })).toEqual({ status: 200 });
  expect(w.teams.connector).toEqual([]);
}

/** The engineer reacts 🐛 to the anchor: Graph tells the app the message changed, and the app reads it. */
async function bugReaction(w: World): Promise<void> {
  w.teams.react(w.anchor, w.owner.aad, '🐛');
  expect(await w.inject({ notifications: [messageChanged(TEAM, w.thread.channel, w.anchor)] })).toEqual({ status: 202 });
}

/** The "Fix it from here" action command on the anchor, by the reporter, through the authenticated route. */
async function actionCommandByReporter(w: World): Promise<void> {
  const text = w.recording.messages.find((m) => m.ts === w.recording.anchor)?.text ?? '';
  const ack = await w.booted.api.fetch(activityRequest('http://snapwing.test', actionCommand(w.thread, w.reporter, text)));
  expect(ack.status).toBe(200);
  expect(await ack.json()).toEqual({ task: { type: 'message', value: 'On it, pulling context' } });
}

/** The latest reply in the thread whose card has an action with `verb`. */
async function card(w: World, verb: string): Promise<ConnectorCall> {
  return vi.waitFor(() => {
    const found = w.teams.connector.filter((c) => c.kind === 'reply' && verbsOf(c.body).includes(verb)).at(-1);
    if (found === undefined) throw new Error(`no ${verb} card yet (${w.booted.logged.join('; ')})`);
    return found;
  }, WAIT);
}

/** Taps `verb` on a card as `who`: an `Action.Execute` invoke carrying the card action's own data. */
async function tap(w: World, c: ConnectorCall, verb: string, who: TeamsPerson): Promise<void> {
  const action = cardOf(c.body)?.actions?.find((a) => a.verb === verb);
  if (action === undefined) throw new Error(`no ${verb} action on the card (has ${verbsOf(c.body).join(', ')})`);
  const answer = await w.inject({ activity: cardTap(w.thread, who, c.activityId, verb, action.data ?? {}) });
  expect(answer.status).toBe(200);
}

/** The incident the scope card names. */
function incidentOf(w: World, c: ConnectorCall): string {
  w.incidentId = cardOf(c.body)?.actions?.find((a) => a.verb === 'looks-right')?.data?.['incidentId'] ?? '';
  expect(w.incidentId).not.toBe('');
  return w.incidentId;
}

/** Every text the pinned status message showed: the post, then each edit of that same message. */
function statusTexts(w: World, statusId: string): string[] {
  return w.teams.connector.filter((c) => c.activityId === statusId && (c.kind === 'reply' || c.kind === 'update')).map((c) => activityText(c.body));
}

async function statusMessageId(w: World, incidentId: string): Promise<string> {
  return vi.waitFor(async () => {
    const id = (await w.booted.state.getIncident(incidentId))?.statusMsgId;
    if (id === undefined) throw new Error('no status message yet');
    return id;
  }, WAIT);
}

/** Waits until the status message's latest text contains `text`. */
async function statusShows(w: World, statusId: string, text: string): Promise<void> {
  await vi.waitFor(async () => {
    const texts = statusTexts(w, statusId);
    if (!(texts.at(-1) ?? '').includes(text)) throw new Error(`status shows "${texts.at(-1) ?? ''}", waiting for "${text}" (${await diagnose(w)})`);
  }, WAIT);
}

/** What went wrong, for a failed wait: logged errors and the failure events of the incident. */
async function diagnose(w: World): Promise<string> {
  const failures = w.incidentId === undefined ? [] : (await w.booted.state.read(w.incidentId)).filter((e) => /failed|held|stopped/.test(e.type));
  return [...w.booted.logged, ...w.booted.errors.map(String), ...failures.map((e) => `${e.type} ${JSON.stringify(e.payload)}`)].join('; ');
}

async function types(w: World, incidentId: string): Promise<EventType[]> {
  return (await w.booted.state.read(incidentId)).map((e) => e.type);
}

/** Sends the In Progress (or any queued) Jira webhook for `issueKey` to the composed route. */
async function deliverJira(w: World, issueKey: string): Promise<void> {
  await vi.waitFor(() => {
    if (!w.jiraHooks.queued.some((d) => d.issueKey === issueKey)) throw new Error(`no Jira transition of ${issueKey} yet`);
  }, WAIT);
  const statuses = await w.jiraHooks.deliver(issueKey, (body) =>
    w.booted.api.fetch(new Request(`http://snapwing.test/webhooks/jira?secret=${JIRA_HOOK_SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })),
  );
  expect(statuses.every((s) => s === 200)).toBe(true);
}

/** Releases the review agent for `issueKey` (it waits so the PR row is on screen first). */
async function openReviewGate(w: World, issueKey: string): Promise<void> {
  await writeFile(join(w.harnessDir, 'gates', `review-${issueKey}`), 'go');
}

/** Nothing went wrong anywhere along the way. */
function clean(w: World): void {
  expect(w.teams.unknown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(w.booted.errors).toEqual([]);
  expect(w.booted.logged).toEqual([]);
}

/** The distinct texts, in order, keeping the first of each run of repeats. */
function rows(texts: readonly string[]): string[] {
  return texts.filter((t, i) => i === 0 || t !== texts[i - 1]);
}

/** One status message, posted once in the thread and only ever edited after. */
async function postedOnce(w: World, incidentId: string, statusId: string): Promise<void> {
  expect((await types(w, incidentId)).filter((t) => t === 'status-message-posted')).toHaveLength(1);
  const post = w.teams.connector.filter((c) => c.kind === 'reply' && c.activityId === statusId);
  expect(post).toHaveLength(1);
  expect(post[0]?.conversation).toBe(`${w.thread.channel};messageid=${w.anchor}`);
  // Every edit of the status message edited that one message in the same conversation.
  const edits = w.teams.connector.filter((c) => c.kind === 'update' && c.activityId === statusId);
  expect(edits.length).toBeGreaterThan(0);
  expect(edits.every((c) => c.conversation === post[0]?.conversation)).toBe(true);
  // No other post in the thread ever carried a status line (the cards are not status posts).
  const log = await w.booted.state.read(incidentId);
  const statusPosts = log.filter((e) => e.type === 'bot-message-posted' && e.payload.role === 'status');
  expect(statusPosts).toHaveLength(1);
}

/** Filed in Jira with the custom fields, from the scope card through the issue and its status message. */
async function filed(w: World, issueKey: string, level: number, summary: string): Promise<string> {
  await vi.waitFor(() => expect(w.jira.issues.get(issueKey)?.custom['Agent Status']).toBeDefined(), WAIT);
  const issue = w.jira.issues.get(issueKey);
  expect(issue?.summary).toBe(summary);
  expect(issue?.custom['Autonomy Level']).toBe(level);
  expect(JSON.stringify(issue?.custom['Implementation Prompt'])).toContain('<implementation-request');
  expect(JSON.stringify(issue?.custom['Implementation Prompt'])).toContain(issueKey);
  expect(String(issue?.custom['Conversation Link'])).toContain(w.anchor);
  return statusMessageId(w, w.incidentId ?? '');
}

/** Jira's In Progress webhook, the fixer's PR, and the review: the status message through to "waiting on merge". */
async function fixToReview(w: World, issueKey: string, statusId: string): Promise<void> {
  await deliverJira(w, issueKey);
  await statusShows(w, statusId, 'Working on a fix now.');
  await statusShows(w, statusId, `A fix is up. Review requested from <at>${w.owner.handle}</at>.`);
  // The review job has read the PR from GitHub (the fake picks it up from the agent's write then).
  const pr = await vi.waitFor(() => {
    const found = w.github.pull(w.repo, 1);
    if (found === undefined) throw new Error('GitHub was not asked about the PR yet');
    return found;
  }, WAIT);
  expect(pr.state).toBe('open');
  await openReviewGate(w, issueKey);
  await statusShows(w, statusId, 'Review passed, waiting on merge.');
  const prCard = await card(w, 'merge');
  expect(activityText(prCard.body)).toContain(`PR #1 is ready** for ${issueKey} (review agent: approve, CI: green`);
  expect(verbsOf(prCard.body)).toEqual(['merge', 'request_changes', 'stop']);
  expect(prCard.conversation).toBe(`${w.thread.channel};messageid=${w.anchor}`);
  // The review agent's verdict reached GitHub as a COMMENT (the App cannot approve its own PR) and a green check.
  expect(pr.reviews.map((r) => r.event)).toEqual(['COMMENT']);
  expect(pr.reviews[0]?.body).toContain('Snapwing review agent: approve');
  expect(w.github.checkRuns.filter((r) => r.name === 'snapwing/review').map((r) => r.conclusion)).toEqual(['success']);
}

// Tests -------------------------------------------------------------------------------------------

describe('levels 1 and 2 end to end through the composed app, on Teams', () => {
  it('level 1: the reporter posts, an engineer reacts 🐛, scope and Fix it taps, Jira, the fixer through the API, review, every status row', async () => {
    const w = await world('02-level-1-fix-on-tap.json', 'ADM-1');
    await linkGitHub(w, w.owner);
    await reporterPosts(w);
    await bugReaction(w);

    // The Graph diff found the 🐛: the message was read from Graph, the scope preview posted in its thread.
    const scope = await card(w, 'looks-right');
    expect(w.teams.graph).toEqual(expect.arrayContaining([`message ${w.anchor}`]));
    expect(scope.conversation).toBe(`${w.thread.channel};messageid=${w.anchor}`);
    const incidentId = incidentOf(w, scope);
    expect((await w.booted.state.getIncident(incidentId))?.source).toBe('teams');
    await tap(w, scope, 'looks-right', w.owner);

    // Level 1: the fix preview offers Fix it to the engineer, who taps it.
    const preview = await card(w, 'approve_fix');
    expect(verbsOf(preview.body)).toEqual(['approve_fix', 'ticket_only', 'dismiss']);
    await tap(w, preview, 'approve_fix', w.owner);

    const statusId = await filed(w, 'ADM-1', 1, 'CSV usage export has a header row but no data');
    await statusShows(w, statusId, `Filed as ADM-1, assigned to <at>${w.owner.handle}</at>.`);
    await fixToReview(w, 'ADM-1', statusId);

    const log = await w.booted.state.read(incidentId);
    const phases = log.flatMap((e) => (e.type === 'fixer-checkpoint' ? [e.payload.phase] : []));
    expect(phases).toEqual(['cloned', 'branched', 'implemented', 'tested', 'pushed', 'pr-opened']);
    expect(log.filter((e) => e.source === 'fixer').map((e) => e.type)).toEqual([...phases.map(() => 'fixer-checkpoint'), 'fixer-done', 'pr-opened']);
    expect(rows(statusTexts(w, statusId))).toEqual([
      expect.stringContaining(`Filed as ADM-1, assigned to <at>${w.owner.handle}</at>.`),
      expect.stringContaining('Filed as ADM-1. Working on a fix now.'),
      expect.stringContaining(`A fix is up. Review requested from <at>${w.owner.handle}</at>.`),
      expect.stringContaining('Review passed, waiting on merge.'),
    ]);
    // Full mode: no card says it is reduced.
    for (const c of w.teams.connector.filter((x) => x.kind === 'reply' || x.kind === 'update')) expect(activityText(c.body)).not.toMatch(/reduced/i);
    await postedOnce(w, incidentId, statusId);
    expect(w.jiraHooks.transitions[0]).toMatch(/^ADM-1: .* -> In Progress$/);
    clean(w);
  }, 60_000);

  it('level 2: no Fix it tap, the informational card carries Stop, and the same path runs to review', async () => {
    const w = await world('03-level-2-fix-now.json', 'WEB-1');
    await linkGitHub(w, w.owner);
    await reporterPosts(w);
    await bugReaction(w);

    const scope = await card(w, 'looks-right');
    const incidentId = incidentOf(w, scope);
    await tap(w, scope, 'looks-right', w.owner);
    const clarify = await card(w, 'Checkout');
    expect(verbsOf(clarify.body)).toEqual(['Navigation', 'Checkout', 'Search']);
    await tap(w, clarify, 'Checkout', w.owner);

    // Level 2: the fix preview is informational, fixing now, with Stop and no Fix it.
    const preview = await card(w, 'dismiss');
    expect(activityText(preview.body)).toContain('Fixing now.');
    expect(verbsOf(preview.body)).toEqual(['stop', 'dismiss']);

    const statusId = await filed(w, 'WEB-1', 2, 'Order total disappears after applying a coupon');
    await statusShows(w, statusId, 'Filed as WEB-1. Working on a fix now.');
    const fixing = w.teams.connector.find((c) => c.activityId === statusId && activityText(c.body).includes('Working on a fix now'));
    expect(fixing === undefined ? [] : verbsOf(fixing.body)).toEqual(['stop']);

    await fixToReview(w, 'WEB-1', statusId);
    expect(rows(statusTexts(w, statusId))).toEqual([
      expect.stringContaining('Filed as WEB-1. Working on a fix now.'),
      expect.stringContaining(`A fix is up. Review requested from <at>${w.owner.handle}</at>.`),
      expect.stringContaining('Review passed, waiting on merge.'),
    ]);
    await postedOnce(w, incidentId, statusId);
    clean(w);
  }, 60_000);

  it('reduced mode: the action command still files, a 🐛 starts nothing, and every card says so', async () => {
    const w = await world('02-level-1-fix-on-tap.json', 'ADM-1', { reduced: true });
    await linkGitHub(w, w.owner);
    // Graph refuses the subscription (no RSC grant): the team's mode, as the subscriptions module sets it.
    await vi.waitFor(async () => {
      expect(await w.booted.composed.health?.()).toEqual([
        { id: 'teams', ok: true, mode: 'reduced', detail: expect.stringContaining(`team ${TEAM}`) },
      ]);
    }, WAIT);
    expect(w.teams.graph).toContain(`subscribe /teams/${TEAM}/channels/getAllMessages`);

    // The messaging endpoint still checks the token: an unsigned activity is refused.
    const unsigned = await w.booted.api.fetch(activityRequest('http://snapwing.test', actionCommand(w.thread, w.reporter, ''), null));
    expect(unsigned.status).toBe(401);

    // The refused subscription means Graph sends no notifications, so a 🐛 on a person's message is never seen:
    // nothing is read from Graph and nothing is posted.
    await reporterPosts(w);
    w.teams.react(w.anchor, w.owner.aad, '🐛');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(w.teams.graph.filter((g) => g.startsWith('message '))).toEqual([]);
    expect(w.teams.connector).toEqual([]);

    // The action command is the way in; the reporter's tap and the engineer's Fix it file it.
    await actionCommandByReporter(w);
    const scope = await card(w, 'looks-right');
    const incidentId = incidentOf(w, scope);
    await tap(w, scope, 'looks-right', w.reporter);
    const preview = await card(w, 'approve_fix');
    await tap(w, preview, 'approve_fix', w.owner);

    const statusId = await filed(w, 'ADM-1', 1, 'CSV usage export has a header row but no data');
    await fixToReview(w, 'ADM-1', statusId);
    // Every card the app posted in the team says it is reduced; the cards do not claim the emoji works.
    const posted = w.teams.connector.filter((c) => c.kind === 'reply' || c.kind === 'update');
    expect(posted.length).toBeGreaterThan(0);
    for (const c of posted) expect(activityText(c.body)).toContain('Reduced mode: I can only read the message you sent me.');
    await postedOnce(w, incidentId, statusId);
    clean(w);
  }, 60_000);
});
