// The six A 8 rows on Teams, through the real app on MSW (the Slack run is e2e/companion-a.test.ts, live):
// claim hold, staging verification, escalation by five reactors, status pull from the personal chat,
// the user-side check from a staging screenshot, and a stall with its heartbeat and owner mention.
// Each row boots its own composed app over the Teams e2e world (fixtures/e2e/teams.ts): Bot Framework
// (OpenID with a local key, the token endpoint, the Connector), Graph over the test channel, the fake
// Jira with its webhooks, the fake GitHub over local bare repositories, and the fake agent behind the
// generic harness (fixtures/e2e/fake-harness.mjs). A reaction is a change to the Graph message followed
// by its change notification, a reaction on the bot's own message is a Bot Framework `messageReaction`,
// and a tap is an `Action.Execute` invoke on the card the app posted, all handed in through the e2e seam.
//
// Where Teams cannot do what Slack does, the row asserts what the Teams adapter does instead, and says so:
//
// - No pins: the status message is a reply in the thread, posted once and edited in place.
// - No bot reaction on the report: a trigger reaction is acknowledged in the reactor's personal chat
//   ("On it, pulling context"), and the bot's first word in the thread is the scope preview.
// - Reaction names: Graph reports `reactionType`s (the emoji itself, or a legacy type such as `like`),
//   which the adapter maps to the playbook's `teams` names (`bug`, `eyes`, `fire`, `like` for 👍).
// - Reactions: Teams sends one change notification per changed message and the adapter diffs the
//   reactions it reads from Graph, so five reactors are five changes to one message (Slack sends one
//   `reaction_added` each). A reaction on the bot's own message also arrives from Bot Framework.
// - Mentions: `<at>handle</at>` with a mention entity, not Slack's `<@user>`.
// - Direct messages: the status question goes to the bot's personal chat, and the answer is sent there.
// - Screenshots: an inline image in the channel message (a Graph hosted content), not a file upload.
//
// The models are fakes with fixed answers (the vision answer only for the committed staging screenshot).
// Jira and pull request comments are batched for 60 s (B 7.1), so a row reads them from the outbox rows
// the projectors will send rather than wait. The stall row's playbook shortens `monitor.heartbeat` and
// `monitor.stallAfter` to seconds, as the other monitoring contract tests do. No keys and no network.
// Runs on the dialect `SNAPWING_DB` selects (pg-boss on Postgres).

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventType, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { ImageReading } from '@snapwing/pipeline/contracts/incident.ts';
import type { IncidentView, OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import { stallAnchor } from '@snapwing/pipeline/monitor/active.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionRequest, VisionResult } from '@snapwing/pipeline/ports/model.ts';
import { SIGNAL_SCHEMA_NAME } from '@snapwing/pipeline/signals/llm.ts';
import { TEXT_SIGNAL_SCHEMA_NAME } from '@snapwing/pipeline/signals/text.ts';
import { outboxRowsOf } from '@snapwing/pipeline/state/outbox.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { reporterViolations } from '@snapwing/pipeline/status/copy.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createGitHubOAuth } from '../../src/github/oauth.ts';
import type { TeamsInject } from '../../src/server/compose.ts';
import { BOT_LOGIN, CI_CHECK, FakeGitHub, type GitHubPerson } from '../fixtures/e2e/github.ts';
import { JiraWebhooks } from '../fixtures/e2e/jira.ts';
import {
  activityText,
  botMessageReaction,
  cardOf,
  cardTap,
  channelMessage,
  GRAPH,
  graphMessage,
  messageChanged,
  personalMessage,
  TEAM,
  TEAMS_SECRETS,
  teamsWorld,
  verbsOf,
  type ConnectorCall,
  type GraphChannelMessage,
  type TeamsPerson,
  type TeamsThread,
  type TeamsWorld,
} from '../fixtures/e2e/teams.ts';
import { JIRA_HOOK_SECRET, bootComposed, EXAMPLE_CONFIG, fakeSecrets, githubSigned, type Booted } from '../fixtures/e2e/world.ts';

const HARNESS = fileURLToPath(new URL('../fixtures/e2e/fake-harness.mjs', import.meta.url));
/** The live run's staging screenshot: a cart page whose URL bar shows `staging.`. */
const SCREENSHOT = fileURLToPath(new URL('../e2e/helpers/staging-cart.png', import.meta.url));
const WEBHOOK_FIXTURES = new URL('../fixtures/github-webhooks/', import.meta.url);
/** The repository's test command for the regression proof: every `test/*.test.sh` must pass. */
const TEST_COMMAND = 'for t in test/*.test.sh; do sh "$t" || exit 1; done';
const WAIT = { timeout: 30_000, interval: 25 };
const SECOND = 1_000;

const REPO = 'acme/storefront';
const PROJECT = 'SHOP';
const ISSUE = `${PROJECT}-1`;
const CHANNEL = '19:shop0a7e9d2b4c1a8e6f@thread.tacv2';
/** The reporter's personal chat with the bot. */
const PERSONAL_CHAT = 'a:1personal-chat-e2e-reporter';
/**
 * The stall row's playbook: A 6.2's heartbeat and stall durations, shortened to seconds. The poll keeps
 * A 4.5's default minute, so it runs once, when monitoring starts, and never inside the row: a poll that
 * re-arms the heartbeat in the moment it falls due, before its job runs, pushes it a whole period, which
 * a loaded machine hits with a one-second poll.
 */
const POLL = 60 * SECOND;
const HEARTBEAT = 3 * SECOND;
/** Longer than any quiet stretch before CI (the fixer's clone, the review's run) on a loaded machine. */
const STALL_AFTER = 15 * SECOND;
/** How late a timer may land on a loaded machine (the live row allows 45 s). */
const LATE = 15 * SECOND;

/** A person of the map: their Teams ids, handle, and, for the engineer, the Jira and GitHub accounts. */
type Person = TeamsPerson & { handle: string; email?: string; github?: GitHubPerson };

const ENGINEER: Person = {
  aad: '6f1c2a3b-0000-4000-8000-00000000e0e1',
  botId: '29:1e2e-engineer',
  name: 'E2E Engineer',
  handle: 'e2eEngineer',
  email: 'engineer@example.com',
  github: { login: 'e2e-engineer', id: 7200001, token: 'test-user-token-engineer', code: 'test-oauth-code-engineer' },
};
const REPORTER: Person = { aad: '6f1c2a3b-0000-4000-8000-00000000c0a1', botId: '29:1e2e-reporter', name: 'E2E Reporter', handle: 'e2eReporter' };
/** The escalation row's three other reactors: mapped people the run acts as through Graph. */
const FIRE: readonly Person[] = [1, 2, 3].map((i) => ({
  aad: `6f1c2a3b-0000-4000-8000-00000000f00${String(i)}`,
  botId: `29:1e2e-fire-${String(i)}`,
  name: `E2E Fire ${String(i)}`,
  handle: `e2eFire${String(i)}`,
}));
const JIRA_ENGINEER = { accountId: 'jira-account-e2e-engineer', emailAddress: ENGINEER.email ?? '', displayName: ENGINEER.name };

/** The seeded bug and its fix: the regression test fails on `/ 1000` and passes on `/ 100`. */
const SEEDED = { 'src/cart/discount.ts': 'export function applyDiscount(total: number, percent: number): number {\n  return total - total * (percent / 1000);\n}\n' };
const FIX = {
  summary: 'apply the coupon percent as a percent',
  files: {
    'src/cart/discount.ts': 'export function applyDiscount(total: number, percent: number): number {\n  return total - total * (percent / 100);\n}\n',
    'test/discount.test.sh': "grep -q 'percent / 100)' src/cart/discount.ts\n",
  },
  test: 'test/discount.test.sh',
};

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
  dir = await mkdtemp(join(tmpdir(), 'snapwing-e2e-teams-a-'));
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

/** The bug the reporter posts (the live run's fixture bug). */
const BUG_REPORT =
  'The cart discount is wrong on the storefront: a 10% coupon on a $20.00 cart only takes 20 cents off, so the cart total shows $19.80 instead of $18.00.';

/** The fixed model answers: the pipeline's tasks, and "nothing here" from both signal passes. */
const ANSWERS: Readonly<Record<string, unknown>> = {
  scout: { confidence: 'high', files: [{ path: 'src/cart/discount.ts', note: 'applyDiscount divides the percent by 1000.' }] },
  triage: {
    action: 'create_issue',
    issueType: 'Bug',
    summary: 'Cart coupon discount is ten times too small',
    description: 'A 10% coupon on a $20.00 cart takes 20 cents off instead of $2.00, so the total shows $19.80 instead of $18.00.',
    priority: 'Medium',
    labels: ['cart'],
  },
};

/** What the vision pass reads in the staging screenshot (A 5.1): the URL bar names the test site. */
const STAGING_READING: ImageReading = {
  surfaceSignals: { urlBar: 'https://staging.storefront.example.test/cart', chrome: 'web' },
  environmentHint: 'staging',
  plainDescription: 'the cart shows a $19.80 total after a 10% coupon on $20.00',
  uiElements: ['cart total', 'coupon field'],
  sensitive: false,
  userSideIndicators: [{ kind: 'wrong-environment', evidence: 'URL bar shows staging.storefront.example.test', confidence: 0.92 }],
};

class RowModel implements ModelBackend {
  /** The tasks asked, in order. */
  readonly asked: string[] = [];
  constructor(
    private readonly segmentation: () => unknown,
    private readonly screenshot?: string,
  ) {}
  complete(): Promise<CompletionResult> {
    return Promise.reject(new Error('the rows record no free-text completions'));
  }
  vision(request: VisionRequest): Promise<VisionResult> {
    this.asked.push('vision');
    // Only the committed screenshot reads as staging; the vision pass never sees anything else here.
    if (this.screenshot === undefined || request.images.some((i) => i.data !== this.screenshot)) return Promise.reject(new Error('an image the row did not post'));
    return Promise.resolve({ readings: request.images.map(() => STAGING_READING), model: 'test/vision' });
  }
  classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
    this.asked.push(request.task);
    if (request.schemaName === SIGNAL_SCHEMA_NAME) return Promise.resolve({ value: { intent: 'none', confidence: 0 }, model: 'test/signals' });
    if (request.schemaName === TEXT_SIGNAL_SCHEMA_NAME) return Promise.resolve({ value: { kind: 'none', confidence: 0 }, model: 'test/signals' });
    if (request.task === 'segmentation') return Promise.resolve({ value: this.segmentation(), model: 'test/recorded' });
    if (!(request.task in ANSWERS)) return Promise.reject(new Error(`no answer for task ${request.task}`));
    return Promise.resolve({ value: ANSWERS[request.task], model: 'test/recorded' });
  }
}

interface RowOptions {
  level: 0 | 1 | 2 | 3;
  playbook?: string;
  /** The anchor carries the staging screenshot inline. */
  screenshot?: boolean;
}

/**
 * The test map on Teams: the channel on the storefront surface, the engineer owning it (with their Jira
 * account's email), the reporter, and the escalation row's three other reactors. "The cart" is not a
 * surface term, so "the cart thing" is matched against incident summaries (A 4.3).
 */
function workspaceMap(level: number): string {
  const person = (p: Person, role: string, inner = ''): string =>
    `    <person teamsId="${p.aad}" handle="${p.handle}"${p.email === undefined ? '' : ` email="${p.email}"`} role="${role}"${inner === '' ? ' />' : `>\n${inner}\n    </person>`}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="acme" updated="2026-10-08T00:00:00Z">
  <surfaces>
    <surface id="storefront" label="Storefront">
      <repo>github.com/${REPO}</repo>
      <jira project="${PROJECT}" defaultIssueType="Bug" />
    </surface>
  </surfaces>
  <channels>
    <channel id="${CHANNEL}" name="storefront-bugs" surface="storefront" confidence="explicit" platform="teams" team="${TEAM}" />
  </channels>
  <triggers>
    <messageAction label="Fix it from here" />
    <emoji slack="bug" teams="bug" />
  </triggers>
  <vocabulary>
    <term surface="storefront">the storefront</term>
  </vocabulary>
  <people>
${person(ENGINEER, 'engineer', '      <owns surface="storefront" />')}
${person(REPORTER, 'reporter')}
${FIRE.map((p) => person(p, 'reporter')).join('\n')}
  </people>
  <policies>
    <askBack maxQuestionsPerIncident="1" suppressWhenReportersAtLeast="3" />
    <autonomy default="0">
      <level id="0" name="ticket-only" fixer="never" merge="none" />
      <level id="1" name="fix-on-tap" fixer="on-tap" merge="human" />
      <level id="2" name="fix-now" fixer="immediate" merge="human" />
      <level id="3" name="autopilot" fixer="immediate" merge="agent" requires="review-agent ci-green risk-gate" />
      <overrides>
        <surface ref="storefront" level="${String(level)}" />
      </overrides>
    </autonomy>
    <riskGate maxFilesTouched="6" maxDiffLines="300">
      <forbiddenPath>.github/**</forbiddenPath>
    </riskGate>
  </policies>
</workspace>
`;
}

interface World {
  booted: Booted;
  teams: TeamsWorld;
  inject: TeamsInject;
  thread: TeamsThread;
  jira: JiraWorld;
  jiraHooks: JiraWebhooks;
  github: FakeGitHub;
  model: RowModel;
  /** Set once the store holds the row's incident. */
  incidentId?: string;
}

async function world(o: RowOptions): Promise<World> {
  const at = new Date();
  const anchor = String(at.getTime());
  const thread: TeamsThread = { channel: CHANNEL, anchor, anchorAt: at.toISOString() };
  const png = await readFile(SCREENSHOT);
  const hosted = 'aW1nLXN0YWdpbmctY2FydA';
  const image = `<img src="${GRAPH}/teams/${TEAM}/channels/${CHANNEL}/messages/${anchor}/hostedContents/${hosted}/$value" alt="image" width="400" height="250">`;
  const anchorMessage: GraphChannelMessage = graphMessage(anchor, thread.anchorAt, BUG_REPORT, REPORTER.aad);
  if (o.screenshot === true) anchorMessage['body'] = { contentType: 'html', content: `<p>${BUG_REPORT} See the screenshot.</p><p>${image}</p>` };
  const teams = teamsWorld(server, [anchorMessage], {
    channel: CHANNEL,
    members: [ENGINEER, REPORTER, ...FIRE].map((p) => p.aad),
    ...(o.screenshot === true ? { hostedContents: { [hosted]: new Uint8Array(png) } } : {}),
  });
  const jira = new JiraWorld(() => undefined);
  const jiraHooks = new JiraWebhooks(jira);
  jiraHooks.people.push(JIRA_ENGINEER);
  const demoGitHub = new GitHubWorld(() => undefined);
  demoGitHub.addRepos({ [REPO]: SEEDED });
  const harnessDir = join(dir, 'harness');
  github = new FakeGitHub(harnessDir);
  if (ENGINEER.github !== undefined) github.people.push(ENGINEER.github);
  await github.addRepo(REPO, SEEDED);
  await mkdir(join(harnessDir, 'plans'), { recursive: true });
  await mkdir(join(harnessDir, 'gates'), { recursive: true });
  // The review runs straight away: no row holds it.
  await writeFile(join(harnessDir, 'plans', `${ISSUE}.json`), JSON.stringify({ ...FIX, reviewGate: false }));
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
  const mapPath = join(dir, 'workspace-context.xml');
  await writeFile(mapPath, workspaceMap(o.level));
  // Absent files mean the defaults: no playbook, no instructions, whatever the working directory holds.
  const playbookPath = join(dir, 'playbook.xml');
  if (o.playbook !== undefined) await writeFile(playbookPath, o.playbook);
  const model = new RowModel(
    () => ({ included: [anchor], excluded: [], resolutionMessageId: '' }),
    o.screenshot === true ? png.toString('base64') : undefined,
  );
  let inject: TeamsInject | undefined;
  booted = await bootComposed({
    state: await tdb.open(),
    configXml,
    secrets,
    dir,
    env: {
      SNAPWING_MAP: mapPath,
      SNAPWING_WORKDIR_ROOT: join(dir, 'work'),
      SNAPWING_TEST_COMMAND: TEST_COMMAND,
      SNAPWING_PLAYBOOK: playbookPath,
      SNAPWING_INSTRUCTIONS: join(dir, 'INSTRUCTIONS.md'),
    },
    overrides: { model: withValidation(model), projectorPollMs: 25, gitRemoteUrl: github.remoteUrl, teamsInject: (fn) => (inject = fn) },
  });
  if (inject === undefined) throw new Error('compose did not hand over the Teams seam');
  return { booted, teams, inject, thread, jira, jiraHooks, github, model };
}

// Steps -------------------------------------------------------------------------------------------

/** `vi.waitFor` with what the app logged, the workers' errors, and the incident's failures, so a timeout says why. */
async function within<T>(w: World, check: () => T | Promise<T>, timeout = WAIT.timeout): Promise<T> {
  try {
    return await vi.waitFor(check, { ...WAIT, timeout });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} (${await diagnose(w)})`, { cause: e });
  }
}

async function diagnose(w: World): Promise<string> {
  const incident = await incidentOf(w).catch(() => undefined);
  const log = incident === undefined ? [] : await w.booted.state.read(incident.id);
  const notable = log.filter((e) => /failed|held|stopped|escalat|level-changed/.test(e.type)).map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`);
  return [
    `status ${incident?.status ?? 'none'}; events ${log.map((e) => e.type).join(', ') || 'none'}`,
    ...notable,
    `logged: ${w.booted.logged.join('; ') || 'nothing'}`,
    `errors: ${w.booted.errors.map(String).join('; ') || 'none'}`,
  ].join(' / ');
}

/** The row's incident (the first one the store holds), once there is one. */
async function incidentOf(w: World): Promise<IncidentView | undefined> {
  if (w.incidentId === undefined) {
    const [first] = await w.booted.state.findIncidents({ limit: 5 });
    if (first === undefined) return undefined;
    w.incidentId = first.id;
  }
  return (await w.booted.state.getIncident(w.incidentId)) ?? undefined;
}

async function events<T extends EventType>(w: World, type: T): Promise<IncidentEvent<T>[]> {
  const incident = await incidentOf(w);
  if (incident === undefined) return [];
  return (await w.booted.state.read(incident.id)).filter((e) => e.type === type) as unknown as IncidentEvent<T>[];
}

async function logOf(w: World): Promise<IncidentEvent[]> {
  const incident = await incidentOf(w);
  return incident === undefined ? [] : w.booted.state.read(incident.id);
}

/** The reporter's message reaches the bot as RSC delivers it: it seeds the conversation and starts nothing. */
async function reporterPosts(w: World): Promise<void> {
  // The anchor's Graph body (with its inline image, if any) inside the one paragraph `channelMessage` adds.
  const body = String((w.teams.messages[0]?.['body'] as { content?: string } | undefined)?.content ?? BUG_REPORT).replace(/^<p>|<\/p>$/g, '');
  expect(await w.inject({ activity: channelMessage(w.thread, REPORTER, body) })).toEqual({ status: 200 });
  expect(w.teams.connector).toEqual([]);
}

/**
 * `who` reacts to the anchor with `emoji`: Graph's message gains the reaction, and Graph tells the app the
 * message changed (one notification per change; the app reads the message and diffs its reactions).
 */
async function reactOnAnchor(w: World, who: Person, emoji: string): Promise<void> {
  w.teams.react(w.thread.anchor, who.aad, emoji);
  expect(await w.inject({ notifications: [messageChanged(TEAM, w.thread.channel, w.thread.anchor)] })).toEqual({ status: 202 });
}

/** The reporter posts; a moment later the engineer reacts 🐛. */
async function reportAndTrigger(w: World): Promise<void> {
  await reporterPosts(w);
  await reactOnAnchor(w, ENGINEER, '🐛');
}

/** Every card the app posted in the thread, as it reads now (a post, then its latest edit). */
function cards(w: World): ConnectorCall[] {
  const latest = new Map<string, ConnectorCall>();
  for (const c of w.teams.connector) {
    if (c.kind === 'reply' || c.kind === 'update') latest.set(c.activityId, c);
  }
  return [...latest.values()];
}

/** Thread posts, oldest first (replies only: a post, never an edit). */
function threadPosts(w: World): ConnectorCall[] {
  return w.teams.connector.filter((c) => c.kind === 'reply' && c.conversation === `${w.thread.channel};messageid=${w.thread.anchor}`);
}

/** Which verb a card gets, and as whom; `undefined` leaves it; a string fails the row with that reason. */
type Choice = (verbs: string[], c: ConnectorCall) => { verb: string; as: Person } | string | undefined;

const isClarify = (c: ConnectorCall): boolean => (cardOf(c.body)?.actions ?? []).some((a) => a.data?.['card'] === 'clarify');

/**
 * The engineer's answers before filing, as on Slack: the scope preview (Looks right), a dedupe card
 * (Create new anyway), an ask-back card (its first option). The fix preview is never tapped.
 */
const DEFAULT_CHOICES: Readonly<Record<string, Choice>> = {
  scope: (v) => (v.includes('looks-right') ? { verb: 'looks-right', as: ENGINEER } : undefined),
  dedupe: (v) => (v.includes('create-anyway') ? { verb: 'create-anyway', as: ENGINEER } : undefined),
  clarify: (v, c) => (isClarify(c) && v[0] !== undefined ? { verb: v[0], as: ENGINEER } : undefined),
};

/** Taps `verb` on a card as `who`: an `Action.Execute` invoke carrying the card action's own data. */
async function tap(w: World, c: ConnectorCall, verb: string, who: Person): Promise<void> {
  const action = cardOf(c.body)?.actions?.find((a) => a.verb === verb);
  if (action === undefined) throw new Error(`no ${verb} action on the card (has ${verbsOf(c.body).join(', ')})`);
  const answer = await w.inject({ activity: cardTap(w.thread, who, c.activityId, verb, action.data ?? {}) });
  expect(answer.status).toBe(200);
}

/** Answers the row's cards with `choices` until `done` gives a value. */
async function answerCardsUntil<T>(w: World, choices: Readonly<Record<string, Choice>>, done: () => Promise<T | undefined>): Promise<T> {
  const tapped = new Set<string>();
  return within(w, async () => {
    const got = await done();
    if (got !== undefined) return got;
    for (const c of cards(w)) {
      const verbs = verbsOf(c.body);
      if (verbs.length === 0 || tapped.has(c.activityId)) continue;
      for (const choose of Object.values(choices)) {
        const choice = choose(verbs, c);
        if (choice === undefined) continue;
        if (typeof choice === 'string') throw new Error(`${choice} (card: ${activityText(c.body).slice(0, 300)})`);
        tapped.add(c.activityId);
        await tap(w, c, choice.verb, choice.as);
        break;
      }
    }
    throw new Error(`not yet (cards: ${cards(w).map((c) => `[${verbsOf(c.body).join(' ')}] ${activityText(c.body).slice(0, 80)}`).join(' | ') || 'none'})`);
  });
}

/** Answers the cards until the incident is filed in Jira; resolves with its key. */
async function untilFiled(w: World, choices: Readonly<Record<string, Choice>> = DEFAULT_CHOICES): Promise<string> {
  return answerCardsUntil(w, choices, async () => (await incidentOf(w))?.jiraKey);
}

/** Waits for the lifecycle to reach `status`. */
async function untilStatus(w: World, status: IncidentView['status'], timeout = WAIT.timeout): Promise<IncidentView> {
  return within(
    w,
    async () => {
      const incident = await incidentOf(w);
      if (incident?.status !== status) throw new Error(`status ${incident?.status ?? 'none'}, waiting for ${status}`);
      return incident;
    },
    timeout,
  );
}

/** Sends the In Progress (or any queued) Jira webhook for `issueKey` to the composed route. */
async function deliverJira(w: World, issueKey: string): Promise<void> {
  await within(w, () => {
    if (!w.jiraHooks.queued.some((d) => d.issueKey === issueKey)) throw new Error(`no Jira transition of ${issueKey} yet`);
  });
  const statuses = await w.jiraHooks.deliver(issueKey, (body) =>
    w.booted.api.fetch(new Request(`http://snapwing.test/webhooks/jira?secret=${JIRA_HOOK_SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })),
  );
  expect(statuses.every((s) => s === 200)).toBe(true);
}

/** Links the engineer's GitHub account through the composed OAuth routes, as at onboarding. */
async function linkGitHub(w: World, who: Person): Promise<void> {
  const gh = who.github;
  if (gh === undefined) throw new Error(`${who.name} has no GitHub account`);
  const workspaceId = await ensureInstallWorkspace(w.booted.state);
  const oauth = createGitHubOAuth({ state: w.booted.state, secrets: w.booted.secrets, workspaceId });
  const link = new URL(await oauth.linkUrl({ chat: 'teams', userId: who.aad }));
  const start = await w.booted.api.fetch(new Request(`http://snapwing.test${link.pathname}${link.search}`));
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location') ?? '');
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const callback = new URL('http://snapwing.test/auth/github/callback');
  callback.searchParams.set('code', gh.code);
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  const done = await w.booted.api.fetch(new Request(callback, { headers: { cookie } }));
  expect(done.status).toBe(200);
}

/** A deploy of `sha` to `environment`: GitHub's `deployment_status` delivery, as the deploy system's status lands. */
async function deploy(w: World, sha: string, environment: 'staging' | 'production'): Promise<void> {
  const payload = JSON.parse(await readFile(new URL('deployment-status-success.json', WEBHOOK_FIXTURES), 'utf8')) as Record<string, unknown>;
  const [owner, name] = REPO.split('/');
  payload['repository'] = { ...(payload['repository'] as object), name, full_name: REPO, owner: { login: owner, type: 'Organization' } };
  payload['deployment_status'] = { ...(payload['deployment_status'] as object), environment, state: 'success' };
  payload['deployment'] = { ...(payload['deployment'] as object), sha, environment, production_environment: environment === 'production' };
  const body = JSON.stringify(payload);
  const response = await w.booted.api.fetch(
    new Request('http://snapwing.test/webhooks/github', { method: 'POST', headers: githubSigned('deployment_status', body, 'test-webhook-secret', `delivery-deploy-${environment}-${Date.now()}`), body }),
  );
  expect(response.status).toBe(200);
}

/** The outbox rows of `op` for `target` the incident queued (Jira and pull request comments wait 60 s, B 7.1). */
async function outbox(w: World, target: OutboxItem['target'], op: string): Promise<OutboxItem[]> {
  const incident = await incidentOf(w);
  if (incident === undefined) return [];
  return (await outboxRowsOf(w.booted.state.ctx, incident.id, op)).filter((r) => r.target === target);
}

/** Nothing went wrong anywhere along the way. */
function clean(w: World): void {
  expect(w.teams.unknown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(w.booted.errors).toEqual([]);
  expect(w.booted.logged).toEqual([]);
}

const mention = (p: Person): string => `<at>${p.handle}</at>`;

// Tests -------------------------------------------------------------------------------------------

describe('the A 8 rows on Teams, through the composed app', () => {
  it('claim hold: 👀 from the engineer within 30 s at level 2 files the ticket assigned to them, with the scout comment and no fixer', async () => {
    const w = await world({ level: 2 });
    await reportAndTrigger(w);
    // Teams' `👀` reactionType is the playbook's `eyes` (claim).
    await reactOnAnchor(w, ENGINEER, '👀');
    expect(Date.now() - Date.parse(w.thread.anchorAt), 'the claim lands within 30 s of the report').toBeLessThan(30 * SECOND);

    const key = await untilFiled(w);
    expect(key).toBe(ISSUE);
    await within(w, async () => {
      const claimed = await events(w, 'claimed');
      expect(claimed.map((e) => e.actor?.id)).toContain(ENGINEER.aad);
      // Graph's reaction types come down to the playbook's `teams` names: 🐛 is `bug`, 👀 is `eyes`.
      expect((await events(w, 'comment')).map((e) => [e.payload.intent, e.payload.raw, e.payload.platform])).toEqual(
        expect.arrayContaining([
          ['trigger', 'bug', 'teams'],
          ['claim', 'eyes', 'teams'],
        ]),
      );
    });

    // The claim card in place of the fix preview: filed and assigned to the engineer, mentioned as Teams does.
    const card = await within(w, () => {
      const found = cards(w).find((c) => verbsOf(c.body).includes('let-agent-take'));
      if (found === undefined) throw new Error('no claim card yet');
      return found;
    });
    expect(activityText(card.body)).toContain(`Filed as **${key}** and assigned to ${mention(ENGINEER)}`);
    expect(verbsOf(card.body)).toEqual(['let-agent-take', 'dismiss']);
    expect(card.conversation).toBe(`${CHANNEL};messageid=${w.thread.anchor}`);
    // The status message, which names the claimer by handle, ends on ticket only with no Stop.
    await within(w, async () => {
      const id = (await incidentOf(w))?.statusMsgId;
      if (id === undefined) throw new Error('no status message yet');
      const now = cards(w).find((c) => c.activityId === id);
      expect(activityText(now?.body ?? {})).toContain(`Filed as ${key}. @${ENGINEER.handle} is on it, so this is filed as ticket only.`);
      expect(verbsOf(now?.body ?? {})).toEqual([]);
    });
    // By then the level 2 fix preview (Stop, Not a bug) would have gone out: it never did.
    expect(w.teams.connector.some((c) => verbsOf(c.body).join(' ') === 'stop dismiss')).toBe(false);

    // Teams cannot react on the report: the trigger is acknowledged in the reactor's personal chat instead
    // (sent after the reaction is handled, not awaited by it).
    await within(w, () => {
      const opened = w.teams.connector.filter((c) => c.kind === 'personal');
      expect(opened.map((c) => JSON.stringify(c.body['members']))).toEqual([expect.stringContaining(ENGINEER.aad)]);
      expect(w.teams.connector.filter((c) => c.kind === 'send').map((c) => [c.conversation, c.body['text']])).toEqual([['a:1personal-chat', 'On it, pulling context']]);
    });

    // On the ticket: labeled human-claimed, assigned to the engineer's Jira account (found by the map's email).
    await within(w, () => {
      expect(w.jira.issues.get(key)?.summary).toBe('Cart coupon discount is ten times too small');
      expect(w.jira.issues.get(key)?.labels).toContain('human-claimed');
      expect(w.jiraHooks.assignees.get(key)).toBe(JIRA_ENGINEER.accountId);
    });

    // The read-only scout's diagnosis, for the human who took it (queued for the ticket's comment batch).
    const scout = await within(w, async () => {
      const found = (await outbox(w, 'jira', 'add-comment')).map((r) => String(r.payload['text'])).find((t) => t.includes('read-only scout'));
      if (found === undefined) throw new Error('no scout comment queued yet');
      return found;
    });
    expect(scout).toContain(`@${ENGINEER.handle} is on this`);
    expect(scout).toContain('src/cart/discount.ts');

    // No fixer: nothing asked to move the ticket to In Progress, nothing started, no pull request.
    expect((await outbox(w, 'jira', 'transition')).map((r) => r.payload['to'])).not.toContain('in-progress');
    expect(w.jiraHooks.transitions.filter((t) => t.endsWith('-> In Progress'))).toEqual([]);
    expect(await events(w, 'fixer-started')).toEqual([]);
    expect(['claimed', 'filed']).toContain((await incidentOf(w))?.status);
    expect(w.github.pulls.size).toBe(0);
    clean(w);
  }, 60_000);

  it('staging verification: the reporter 👍 on the staging check is verified on the ticket and the PR, and production follows at level 3', async () => {
    const w = await world({ level: 3 });
    await reportAndTrigger(w);
    const key = await untilFiled(w);

    // Autopilot: Jira's In Progress webhook starts the fixer; its PR, the review, the required checks, the agent's merge.
    await deliverJira(w, key);
    await untilStatus(w, 'merged');
    const [merged] = await events(w, 'merged');
    expect(merged?.payload.levelAtMergeTime).toBe(3);
    const mergeSha = merged?.payload.mergeCommitSha ?? '';
    const pr = w.github.pull(REPO, merged?.payload.prNumber ?? 0);
    expect(pr).toMatchObject({ merged: true, mergedBy: BOT_LOGIN, base: 'main' });
    // The head branch is deleted after the merge is recorded.
    await within(w, () => expect(w.github.deletedBranches).toEqual([`${REPO}:${pr?.head ?? ''}`]));

    // The deploy system puts the merge commit on staging; GitHub tells the App.
    await deploy(w, mergeSha, 'staging');
    await untilStatus(w, 'deployed:staging');

    // The staging check, mentioning the reporter as Teams does, recorded with its role so a reaction on it resolves.
    const check = await within(w, async () => {
      const found = (await events(w, 'bot-message-posted')).find((e) => e.payload.role === 'staging-check');
      if (found === undefined) throw new Error('no staging check yet');
      const shown = threadPosts(w).find((c) => c.activityId === found.payload.messageId);
      expect(activityText(shown?.body ?? {})).toContain(mention(REPORTER));
      return found;
    });
    expect(check.payload).toMatchObject({ platform: 'teams', channel: CHANNEL });

    // The reporter's 👍 is the verification: Teams' `like`, on the bot's own message, which Bot Framework reports.
    expect(await w.inject({ activity: botMessageReaction(w.thread, REPORTER, check.payload.messageId, 'like') })).toEqual({ status: 200 });
    const verified = await within(w, async () => {
      const found = (await events(w, 'verified'))[0];
      if (found === undefined) throw new Error('not verified yet');
      const comment = (await events(w, 'comment')).find((e) => e.payload.effect === 'verify');
      expect(comment?.payload).toMatchObject({ intent: 'accept', platform: 'teams', raw: 'like' });
      return found;
    });
    expect(verified.payload.env).toBe('staging');
    expect(verified.actor?.id).toBe(REPORTER.aad);

    // The attribution on the ticket (`@name`) and on the pull request (bold, as the reporter has no linked GitHub login).
    await within(w, async () => {
      const onJira = (await outbox(w, 'jira', 'add-comment')).map((r) => String(r.payload['text']));
      expect(onJira).toContainEqual(expect.stringMatching(new RegExp(`^@${REPORTER.handle} verified on staging at \\d{1,2}:\\d{2}`)));
      const onPr = (await outbox(w, 'github', 'add-comment')).map((r) => String(r.payload['text']));
      expect(onPr).toContainEqual(expect.stringMatching(new RegExp(`^\\*\\*${REPORTER.handle}\\*\\* verified on staging at \\d{1,2}:\\d{2}`)));
    });

    // Production proceeds at level 3: nothing holds the deploy, and the level never dropped.
    await deploy(w, mergeSha, 'production');
    const done = await untilStatus(w, 'deployed:production');
    expect(done.autonomyLevel).toBe(3);
    const log = await logOf(w);
    expect(log.filter((e) => e.type === 'level-changed' || e.type === 'held')).toEqual([]);
    expect(log.map((e) => e.type).indexOf('verified')).toBeLessThan(log.map((e) => e.type).indexOf('deployed:production'));
    // Teams cannot pin: the status message is one reply in the thread, edited in place through every stage,
    // the production row included (the status projector drains after the event).
    const statusId = done.statusMsgId ?? '';
    await within(w, () => expect(activityText(cards(w).find((c) => c.activityId === statusId)?.body ?? {})).toContain(`Live. Closing ${key}.`));
    expect(threadPosts(w).filter((c) => c.activityId === statusId)).toHaveLength(1);
    expect(w.teams.connector.filter((c) => c.kind === 'update' && c.activityId === statusId).length).toBeGreaterThan(0);
    clean(w);
  }, 60_000);

  it('escalation: five distinct people react 🔥, then the 🐛: priority Highest, the owner mentioned, ask-back suppressed, monitoring on', async () => {
    const w = await world({ level: 0 });
    await reporterPosts(w);
    // Five people react 🔥 before anyone files it. Teams notifies one change to the message at a time and
    // the app diffs the reactions Graph lists, so each reactor is one change (Slack sends a `reaction_added` each).
    for (const p of [REPORTER, ENGINEER, ...FIRE]) await reactOnAnchor(w, p, '🔥');
    // Nothing is filed yet: the reactions wait for an incident, which the trigger now creates.
    expect(await w.booted.state.findIncidents({ limit: 5 })).toEqual([]);
    await reactOnAnchor(w, ENGINEER, '🐛');

    // Counted the moment the incident exists: steps 1 and 2 before any card is answered.
    const steps = await within(w, async () => {
      const got = await events(w, 'escalated');
      if (!got.some((e) => e.payload.step === 2)) throw new Error(`steps ${got.map((e) => e.payload.step).join(', ') || 'none'}`);
      return got;
    });
    expect(steps.map((e) => e.payload.step)).toEqual([1, 2]);
    expect(steps[1]?.payload).toMatchObject({ step: 2, priority: 'Highest', mentionOwner: true, suppressAskBack: true, reactors: 5 });
    await within(w, async () => {
      const escalate = (await events(w, 'comment')).filter((e) => e.payload.intent === 'escalate');
      expect(new Set(escalate.map((e) => e.actor?.id))).toEqual(new Set([REPORTER.aad, ENGINEER.aad, ...FIRE.map((p) => p.aad)]));
      expect(new Set(escalate.map((e) => e.payload.raw))).toEqual(new Set(['fire']));
    });

    // No question card: it is an incident, not a question.
    const key = await untilFiled(w, { ...DEFAULT_CHOICES, clarify: (_v, c) => (isClarify(c) ? 'an ask-back card was posted although step 2 suppresses it' : undefined) });
    expect(await events(w, 'clarified')).toEqual([]);

    // The owner is mentioned in the thread, as a Teams mention (`<at>` with its entity).
    const post = await within(w, () => {
      const found = threadPosts(w).find((c) => activityText(c.body).includes('Priority raised to Highest'));
      if (found === undefined) throw new Error('no step 2 post yet');
      return found;
    });
    // Steps 1 and 2 fire together at adoption, so one post carries both: the count, then the new priority.
    expect(activityText(post.body)).toBe(`${mention(ENGINEER)} 5 people are reporting this. Priority raised to Highest.`);
    expect(JSON.stringify(post.body)).toContain(ENGINEER.aad);

    // Highest on the incident and on the ticket.
    expect(key).toBe(ISSUE);
    await within(w, async () => {
      expect((await incidentOf(w))?.priority).toBe('Highest');
      const priorities = [
        ...(await outbox(w, 'jira', 'create-issue')).map((r) => (r.payload['fields'] as { priority?: { name?: string } } | undefined)?.priority?.name),
        ...(await outbox(w, 'jira', 'update-fields')).map((r) => (r.payload['fields'] as { priority?: { name?: string } } | undefined)?.priority?.name),
      ].filter((p) => p !== undefined);
      expect(priorities.at(-1)).toBe('Highest');
    });

    // Highest qualifies the incident for active monitoring (A 4.5).
    const started = await within(w, async () => {
      const found = (await events(w, 'monitoring-started'))[0];
      if (found === undefined) throw new Error('monitoring has not started');
      expect((await incidentOf(w))?.monitored).toBe(true);
      return found;
    });
    expect(started.payload.qualifiedBy).toBe('priority');
    clean(w);
  }, 60_000);

  it('status pull: "where are we with the cart thing" in the reporter\'s personal chat names the incident, reporter-shaped, under 1 s', async () => {
    const w = await world({ level: 0 });
    await reportAndTrigger(w);
    const key = await untilFiled(w);
    await within(w, async () => expect((await incidentOf(w))?.statusMsgId).toBeDefined());

    // Teams has no DM with a bot the way Slack does: the question goes to the bot's personal chat.
    const sentBefore = w.teams.connector.length;
    const handedIn = Date.now();
    expect(await w.inject({ activity: personalMessage(REPORTER, PERSONAL_CHAT, 'where are we with the cart thing?', String(handedIn)) })).toEqual({ status: 200 });
    const reply = await within(w, () => {
      const found = w.teams.connector.slice(sentBefore).find((c) => c.kind === 'send' && c.conversation === PERSONAL_CHAT);
      if (found === undefined) throw new Error('no answer in the personal chat yet');
      return found;
    });

    // Timed from the moment the activity reached the app to the Connector taking the answer.
    const serverMs = reply.at - handedIn;
    console.info(`teams companion A: status answer in ${String(serverMs)} ms at the server`);
    expect(serverMs).toBeGreaterThanOrEqual(0);
    expect(serverMs).toBeLessThan(SECOND);

    // The right incident, in the reporter's shape: plain language, the next step, no timeline, no buttons.
    const text = activityText(reply.body);
    expect(text).toMatch(new RegExp(`^\\**${key}\\b`));
    expect(text).toContain('Next: ');
    expect(text).toMatch(/Nothing needed from you right now\.$|Waiting on you: /);
    expect(text).not.toContain('\n');
    expect(text).not.toContain(' · ');
    expect(reporterViolations(text)).toEqual([]);
    expect(verbsOf(reply.body)).toEqual([]);
    // Asked, not reported: the question opened no incident of its own, and nothing else was sent there.
    expect(await w.booted.state.findIncidents({ limit: 5 })).toHaveLength(1);
    expect(w.teams.connector.slice(sentBefore).filter((c) => c.conversation === PERSONAL_CHAT)).toHaveLength(1);
    clean(w);
  }, 60_000);

  it('user-side check: a screenshot of staging. is asked about before filing; That fixed it files nothing and logs user-side', async () => {
    // The screenshot is an inline image in the report (a Graph hosted content), where Slack has a file upload.
    const w = await world({ level: 2, screenshot: true });
    await reportAndTrigger(w);

    // The check is the one question: the reporter taps That fixed it. A gap question instead fails.
    const choices: Record<string, Choice> = {
      ...DEFAULT_CHOICES,
      clarify: (v, c) => {
        if (!isClarify(c)) return undefined;
        return v.includes('That fixed it') ? { verb: 'That fixed it', as: REPORTER } : `no user-side check, a gap question instead (verbs ${v.join(', ')})`;
      },
    };
    const sided = await answerCardsUntil(w, choices, async () => (await events(w, 'user-side'))[0]);
    expect(sided.payload.kind).toBe('wrong-environment');
    expect(sided.payload.evidence).toMatch(/staging/i);
    expect(sided.actor?.id).toBe(REPORTER.aad);
    // The image was read from Graph, and the vision pass saw the committed screenshot.
    expect(w.teams.graph).toContainEqual(expect.stringMatching(/^hosted /));
    expect(w.model.asked).toContain('vision');

    // Asked before filing, as a user-side check, and nothing filed after.
    const asked = await events(w, 'clarified');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload.userSide?.kind).toBe('wrong-environment');
    const note = await within(w, () => {
      const found = threadPosts(w).find((c) => activityText(c.body).startsWith('Great, no bug then.'));
      if (found === undefined) throw new Error('no thread note yet');
      return found;
    });
    expect(activityText(note.body)).not.toContain(REPORTER.handle);
    expect(JSON.stringify(note.body)).not.toContain(REPORTER.aad);
    const log = await logOf(w);
    expect(log.filter((e) => e.type === 'planned' || e.type === 'filed')).toEqual([]);
    expect((await incidentOf(w))?.jiraKey).toBeUndefined();
    expect(await outbox(w, 'jira', 'create-issue')).toEqual([]);
    expect(w.jira.issues.size).toBe(0);
    clean(w);
  }, 60_000);

  it('stall: CI that never reports gets the heartbeat after monitor.heartbeat and the owner mention after monitor.stallAfter', async () => {
    const playbook = [
      '<playbook xmlns="urn:snapwing:playbook:v1" version="1">',
      `<monitor interval="PT${String(POLL / SECOND)}S" heartbeat="PT${String(HEARTBEAT / SECOND)}S" stallAfter="PT${String(STALL_AFTER / SECOND)}S"><critical surface="storefront"/></monitor>`,
      '<escalation name="stalled-fix"><after duration="PT0S" mention="owner"/><applyWhen monitored="true" stalled="true"/></escalation>',
      '</playbook>',
    ].join('');
    const w = await world({ level: 2, playbook });
    // The required `ci/test` check is never reported, by webhook or to any read of the head's checks.
    w.github.silent.add(CI_CHECK);
    await linkGitHub(w, ENGINEER);
    await reportAndTrigger(w);
    const key = await untilFiled(w);
    const started = await within(w, async () => {
      const found = (await events(w, 'monitoring-started'))[0];
      if (found === undefined) throw new Error('monitoring has not started');
      return found;
    });
    expect(started.payload.qualifiedBy).toBe('critical-surface');

    // The fix is reviewed and waits on CI that never answers.
    await deliverJira(w, key);
    await untilStatus(w, 'ci');
    const passed = (await events(w, 'review-passed')).at(-1);
    const inCi = Math.max(Date.parse(passed?.occurredAt ?? ''), Date.parse(passed?.recordedAt ?? ''));

    // The heartbeat, one `monitor.heartbeat` into CI, posted in the thread.
    const heartbeat = await within(
      w,
      () => {
        const found = threadPosts(w).find((c) => activityText(c.body).startsWith('Still in CI,'));
        if (found === undefined) throw new Error(`no heartbeat yet (thread: ${threadPosts(w).map((c) => activityText(c.body).slice(0, 60)).join(' | ')})`);
        return found;
      },
      HEARTBEAT + LATE + 15 * SECOND,
    );
    expect(activityText(heartbeat.body)).toMatch(/^Still in CI, \d+ minutes?\b.*Watching\.$/);
    expect(heartbeat.at - inCi).toBeGreaterThanOrEqual(HEARTBEAT - 100);
    expect(heartbeat.at - inCi).toBeLessThan(HEARTBEAT + LATE);

    // The stall: `monitor.stallAfter` after the last progress, plus the PT0S first step, mentions the owner.
    const step = await within(
      w,
      async () => {
        const found = (await events(w, 'escalation-ladder')).find((e) => e.payload.phase === 'step' && e.payload.ladder === 'stalled-fix');
        if (found === undefined) throw new Error('no stalled-fix step yet');
        return found;
      },
      STALL_AFTER + LATE + 15 * SECOND,
    );
    const log = await logOf(w);
    const ladderStart = (await events(w, 'escalation-ladder')).find((e) => e.payload.phase === 'started' && e.payload.ladder === 'stalled-fix');
    expect(ladderStart).toBeDefined();
    const anchor = stallAnchor(log.filter((e) => e.seq < (ladderStart?.seq ?? 0))) ?? 0;
    expect(anchor).toBeGreaterThanOrEqual(inCi);
    const stalledAt = Date.parse(step.occurredAt);
    expect(stalledAt - anchor).toBeGreaterThanOrEqual(STALL_AFTER - SECOND);
    expect(stalledAt - anchor).toBeLessThan(STALL_AFTER + LATE);
    expect(step.payload).toMatchObject({ phase: 'step', ladder: 'stalled-fix', step: 1, mentioned: ENGINEER.handle, posted: true });
    const mentioned = await within(w, () => {
      const found = threadPosts(w).find((c) => activityText(c.body).includes('Escalating (stalled-fix, step 1 of 1)'));
      if (found === undefined) throw new Error('no owner mention yet');
      return found;
    });
    expect(activityText(mentioned.body)).toMatch(new RegExp(`^${mention(ENGINEER)} Escalating \\(stalled-fix, step 1 of 1\\): ${key} `));
    expect(JSON.stringify(mentioned.body)).toContain(ENGINEER.aad);

    // Still waiting on the silent check: the app read the head's checks once the review passed, and no CI
    // result arrived.
    expect(w.github.calls.filter((c) => new RegExp(`^GET /repos/${REPO}/commits/[0-9a-f]{40}/check-runs$`).test(c)).length).toBeGreaterThan(0);
    expect((await incidentOf(w))?.status).toBe('ci');
    expect(log.filter((e) => e.type === 'ci-green' || e.type === 'ci-red')).toEqual([]);
    clean(w);
  }, 120_000);
});
