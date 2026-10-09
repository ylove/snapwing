// Phase 4 wiring on the composed app (A 2.2, A 2.3, A 2.4, A 4.4, A 4.6, A 5.3, A 6.4, main
// 11.3), on MSW with the e2e world (fixtures/e2e/): the real `compose`, worker, projectors, and
// routes, Slack events and taps signed as Slack sends them, local bare repositories behind a fake
// GitHub, and the fake agent behind the generic harness.
//
// - An engineer's 👀 while the fixer runs gets the mid-flight card; their Stop keeps the branch and
//   assigns them on the ticket.
// - An engineer's claim with no activity for `claims.expiry` gets the "still on it?" nudge.
// - An INSTRUCTIONS.md release-window rule holds a level 3 autopilot merge: level 2, the status says so.
// - Channel members land in kv and follow the membership events; a digest is a worker job; a
//   ux-friction Task row reaches Jira through the projector.
//
// No keys and no network. Runs on the dialect `SNAPWING_DB` selects (pg-boss on Postgres).

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel, type Scenario } from '@snapwing/pipeline/demo/run.ts';
import { INSTRUCTIONS_HOLD_SCHEMA_NAME, type InstructionsHoldAnswer } from '@snapwing/pipeline/merge/instructions.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionResult } from '@snapwing/pipeline/ports/model.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { channelMembersKey } from '@snapwing/pipeline/state/projections/notify-context.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { outboxRowsOf } from '@snapwing/pipeline/state/outbox.ts';
import { jiraFieldBatchKey } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { textToAdf } from '../../src/jira/projector/ops.ts';
import { FakeGitHub } from '../fixtures/e2e/github.ts';
import { JiraWebhooks } from '../fixtures/e2e/jira.ts';
import { JIRA_HOOK_SECRET,
  blockIds,
  bootComposed,
  DEMO_LEVELS,
  DEMO_MAP,
  EXAMPLE_CONFIG,
  fakeSecrets,
  messageText,
  slackSigned,
  slackWorld,
  type Booted,
  type SlackPostCall,
  type SlackWorld,
} from '../fixtures/e2e/world.ts';

const HARNESS = fileURLToPath(new URL('../fixtures/e2e/fake-harness.mjs', import.meta.url));
/** The repository's test command for the regression proof: every `test/*.test.sh` must pass. */
const TEST_COMMAND = 'for t in test/*.test.sh; do sh "$t" || exit 1; done';
/** Each wait is bounded on its effect; the generous bound only matters when the machine is loaded (#292). */
const WAIT = { timeout: 30_000, interval: 25 };
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

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
  dir = await mkdtemp(join(tmpdir(), 'snapwing-phase4-'));
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

/** The fix and its regression test per repository: the test fails on the seeded bug and passes after. */
const FIXES: Readonly<Record<string, { summary: string; files: Record<string, string>; test: string }>> = {
  'acme/web': {
    summary: 'keep the order total when a coupon applies',
    files: {
      'src/checkout/coupon.ts': 'export function applyCoupon(cart: Cart, code: string): Cart {\n  const total = cart.total;\n  return { ...cart, code, total };\n}\n',
      'test/coupon.test.sh': "grep -q 'const total = cart.total' src/checkout/coupon.ts\n",
    },
    test: 'test/coupon.test.sh',
  },
  'acme/mobile': {
    summary: 'read the saved notification setting',
    files: {
      'src/settings/notifications.ts': 'export function loadNotificationSettings(store: Store): Settings {\n  return { enabled: store.get("notifications") === "on" };\n}\n',
      'test/notifications.test.sh': "grep -q 'store.get' src/settings/notifications.ts\n",
    },
    test: 'test/notifications.test.sh',
  },
};

/** What the release-window instruction holds: the autopilot merge, never the fixer start (A 6.4). */
class InstructionsModel implements ModelBackend {
  readonly steps: string[] = [];
  constructor(private readonly recorded: RecordedModel) {}
  complete(): Promise<CompletionResult> {
    return this.recorded.complete();
  }
  vision(): Promise<VisionResult> {
    return this.recorded.vision();
  }
  classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
    if (request.schemaName !== INSTRUCTIONS_HOLD_SCHEMA_NAME) return this.recorded.classify(request);
    const step = /<instructions-check step="([^"]+)"/.exec(request.prompt)?.[1] ?? '';
    this.steps.push(step);
    const hold = step === 'merge' && request.system?.includes('release window') === true;
    const value: InstructionsHoldAnswer = hold
      ? { hold: true, instruction: 'During a release window, hold all autopilot merges until the window closes.', reason: 'the release window', mention: '' }
      : { hold: false, instruction: '', reason: '', mention: '' };
    return Promise.resolve({ value, model: 'test/instructions' });
  }
}

interface World {
  booted: Booted;
  recording: Scenario;
  slack: SlackWorld;
  jira: JiraWorld;
  jiraHooks: JiraWebhooks;
  github: FakeGitHub;
  repo: string;
  model: InstructionsModel;
}

interface WorldOptions {
  /** The fake agent's plan beyond the repository's fix. */
  plan?: { hangAfterCommit?: boolean; reviewGate?: boolean };
  /** A `playbook.xml` to load (`SNAPWING_PLAYBOOK`). */
  playbook?: string;
  /** An `INSTRUCTIONS.md` to load (`SNAPWING_INSTRUCTIONS`). */
  instructions?: string;
  /** The recording channel's members for `conversations.members`. */
  members?: readonly string[];
}

async function world(file: string, issueKey: string, options: WorldOptions = {}): Promise<World> {
  const recording = parseScenario(file, JSON.parse(await readFile(join(DEMO_LEVELS, file), 'utf8')));
  const channel = recording.channel.id;
  const slack = slackWorld(server, channel, recording.messages.map((m) => ({ type: 'message', ...m })), options.members === undefined ? {} : { members: options.members });
  const jira = new JiraWorld(() => undefined);
  const jiraHooks = new JiraWebhooks(jira);
  const demoGitHub = new GitHubWorld(() => undefined);
  demoGitHub.addRepos(recording.github);
  const harnessDir = join(dir, 'harness');
  github = new FakeGitHub(harnessDir);
  const [repo] = Object.keys(recording.github);
  if (repo === undefined) throw new Error(`${file}: no repository`);
  for (const [name, files] of Object.entries(recording.github)) await github.addRepo(name, files);
  await mkdir(join(harnessDir, 'plans'), { recursive: true });
  await mkdir(join(harnessDir, 'gates'), { recursive: true });
  const fix = FIXES[repo];
  if (fix !== undefined) await writeFile(join(harnessDir, 'plans', `${issueKey}.json`), JSON.stringify({ ...fix, reviewGate: false, ...options.plan }));
  // The first matching handler wins: the e2e Jira workflow over the demo one, the fake GitHub before the demo reads.
  server.use(
    ...jiraHooks.handlers(),
    ...github.handlers(),
    ...jiraHandlers(jira),
    ...githubHandlers(demoGitHub),
  );

  // Generated per run, never committed: the App JWT is signed for real.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const secrets = { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
  const command = [process.execPath, HARNESS, harnessDir].map((a) => `&quot;${a}&quot;`).join(' ');
  const configXml = (await readFile(EXAMPLE_CONFIG, 'utf8')).replace(
    /<harness [\s\S]*?<\/harness>/,
    `<harness fixer="generic" review="generic"><generic id="fake-agent" command="${command}" timeout="PT2M"/></harness>`,
  );
  const env: Record<string, string> = { SNAPWING_MAP: DEMO_MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work'), SNAPWING_TEST_COMMAND: TEST_COMMAND };
  // Absent files: no playbook (the defaults) and no instructions, whatever the working directory holds.
  env['SNAPWING_PLAYBOOK'] = join(dir, 'playbook.xml');
  env['SNAPWING_INSTRUCTIONS'] = join(dir, 'INSTRUCTIONS.md');
  if (options.playbook !== undefined) await writeFile(env['SNAPWING_PLAYBOOK'], options.playbook);
  if (options.instructions !== undefined) await writeFile(env['SNAPWING_INSTRUCTIONS'], options.instructions);
  const recorded = new RecordedModel();
  recorded.use(recording.name, recording.model);
  const model = new InstructionsModel(recorded);
  booted = await bootComposed({
    state: await tdb.open(),
    configXml,
    secrets,
    dir,
    env,
    overrides: { model: withValidation(model), projectorPollMs: 25, gitRemoteUrl: github.remoteUrl },
  });
  return { booted, recording, slack, jira, jiraHooks, github, repo, model };
}

// Steps -------------------------------------------------------------------------------------------

/** "Fix it from here" on the recording's anchor message, as the reporter. */
async function shortcut(w: World): Promise<void> {
  const { recording } = w;
  const response = await w.booted.interact({
    type: 'message_action',
    callback_id: 'fix_it_from_here',
    team: { domain: 'acme-test' },
    channel: { id: recording.channel.id, name: recording.channel.name },
    user: { id: recording.reporter.id, name: recording.reporter.name },
    message_ts: recording.anchor,
    message: recording.messages.find((m) => m.ts === recording.anchor),
  });
  expect(response.status).toBe(200);
}

/** The latest message posted with an actions block whose id is `blockId` or starts with `blockId:`. */
async function card(w: World, blockId: string): Promise<SlackPostCall> {
  return vi.waitFor(() => {
    const found = w.slack.calls.filter((c) => c.method === 'chat.postMessage' && blockIds(c.body).some((id) => id === blockId || id.startsWith(`${blockId}:`))).at(-1);
    if (found === undefined) throw new Error(`no ${blockId} card yet (${w.booted.logged.join('; ')})`);
    return found;
  }, WAIT);
}

function actionsBlock(c: SlackPostCall, blockId: string): { block_id: string; elements: { action_id: string; value: string; text: { text: string } }[] } {
  const blocks = c.body['blocks'] as { block_id?: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
  const block = blocks.find((b) => b.block_id === blockId || b.block_id?.startsWith(`${blockId}:`) === true);
  return { block_id: block?.block_id ?? '', elements: block?.elements ?? [] };
}

/** Taps `actionId` on a card as `userId`: a `block_actions` payload like Slack's. */
async function tap(w: World, c: SlackPostCall, blockId: string, actionId: string, userId: string): Promise<void> {
  const block = actionsBlock(c, blockId);
  const button = block.elements.find((b) => b.action_id === actionId);
  if (button === undefined) throw new Error(`no ${actionId} button on the ${blockId} card`);
  const channel = String(c.body['channel']);
  const response = await w.booted.interact({
    type: 'block_actions',
    user: { id: userId },
    channel: { id: channel },
    container: { type: 'message', channel_id: channel, message_ts: c.ts },
    message: { ts: c.ts, thread_ts: w.recording.anchor, blocks: c.body['blocks'] },
    actions: [{ action_id: actionId, block_id: block.block_id, value: button.value, text: { type: 'plain_text', text: button.text.text } }],
  });
  expect(response.status).toBe(200);
}

/** An Events API delivery to the composed `/slack/events`, signed. */
async function slackEvent(w: World, eventId: string, event: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ type: 'event_callback', team_id: 'T0001', event_id: eventId, event_time: Math.floor(Date.now() / 1000), event });
  const res = await w.booted.api.fetch(new Request('http://snapwing.test/slack/events', { method: 'POST', headers: slackSigned(body), body }));
  expect(res.status).toBe(200);
}

/** `user` reacts `name` on the recording's anchor, now. */
async function react(w: World, eventId: string, user: string, name: string): Promise<void> {
  await slackEvent(w, eventId, {
    type: 'reaction_added',
    user,
    reaction: name,
    item_user: w.recording.reporter.id,
    item: { type: 'message', channel: w.recording.channel.id, ts: w.recording.anchor },
    event_ts: (Date.now() / 1000).toFixed(6),
  });
}

async function incidentOf(w: World): Promise<string> {
  const scope = await card(w, 'scope_actions');
  return actionsBlock(scope, 'scope_actions').elements[0]?.value ?? '';
}

function statusTexts(w: World, statusTs: string): string[] {
  return w.slack.calls.filter((c) => (c.method === 'chat.postMessage' || c.method === 'chat.update') && c.ts === statusTs).map((c) => messageText(c.body));
}

async function statusMessageTs(w: World, incidentId: string): Promise<string> {
  return vi.waitFor(async () => {
    const ts = (await w.booted.state.getIncident(incidentId))?.statusMsgId;
    if (ts === undefined) throw new Error('no status message yet');
    return ts;
  }, WAIT);
}

async function statusShows(w: World, statusTs: string, text: string, incidentId: string): Promise<void> {
  await vi.waitFor(async () => {
    const last = statusTexts(w, statusTs).at(-1) ?? '';
    if (!last.includes(text)) throw new Error(`status shows "${last}", waiting for "${text}" (${await diagnose(w, incidentId)})`);
  }, WAIT);
}

async function diagnose(w: World, incidentId: string): Promise<string> {
  const failures = (await w.booted.state.read(incidentId)).filter((e) => /failed|held|stopped/.test(e.type));
  return [...w.booted.logged, ...w.booted.errors.map(String), ...failures.map((e) => `${e.type} ${JSON.stringify(e.payload)}`)].join('; ');
}

/** Sends the queued Jira webhooks for `issueKey` (the In Progress transition starts the fixer). */
async function deliverJira(w: World, issueKey: string): Promise<void> {
  await vi.waitFor(() => {
    if (!w.jiraHooks.queued.some((d) => d.issueKey === issueKey)) throw new Error(`no Jira transition of ${issueKey} yet`);
  }, WAIT);
  const statuses = await w.jiraHooks.deliver(issueKey, (body) =>
    w.booted.api.fetch(new Request(`http://snapwing.test/webhooks/jira?secret=${JIRA_HOOK_SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })),
  );
  expect(statuses.every((s) => s === 200)).toBe(true);
}

function clean(w: World): void {
  expect(w.slack.unknown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(w.booted.errors).toEqual([]);
  expect(w.booted.logged).toEqual([]);
}

// Tests -------------------------------------------------------------------------------------------

describe('phase 4 wiring on the composed app', () => {
  it('A 2.2: an engineer claims while the fixer runs, taps Stop, nothing is pushed, and gets the ticket', async () => {
    const w = await world('03-level-2-fix-now.json', 'WEB-1', { plan: { hangAfterCommit: true } });
    await shortcut(w);
    const incidentId = await incidentOf(w);
    await tap(w, await card(w, 'scope_actions'), 'scope_actions', 'looks-right', w.recording.reporter.id);
    await tap(w, await card(w, 'clarify_actions'), 'clarify_actions', 'Checkout', w.recording.reporter.id);
    const statusTs = await statusMessageTs(w, incidentId);
    await statusShows(w, statusTs, 'Filed as WEB-1. Working on a fix now.', incidentId);
    await deliverJira(w, 'WEB-1');

    // The fixer committed its fix on the branch and keeps working.
    await vi.waitFor(async () => {
      const log = await w.booted.state.read(incidentId);
      expect(log.some((e) => e.type === 'fixer-checkpoint' && e.payload.phase === 'tested')).toBe(true);
    }, WAIT);
    const runId = (await w.booted.state.read(incidentId)).flatMap((e) => (e.type === 'fixer-started' ? [e.payload.runId] : []))[0] ?? '';

    // The owning engineer claims with 👀 on the report: the card, in the thread, offers the choice.
    await react(w, 'Ev0MIDFLIGHT1', 'U0WEBDEV', 'eyes');
    const offer = await card(w, 'midflight_actions');
    expect(offer.body['thread_ts']).toBe(w.recording.anchor);
    expect(actionsBlock(offer, 'midflight_actions').block_id).toBe(`midflight_actions:${runId}:U0WEBDEV`);
    expect(actionsBlock(offer, 'midflight_actions').elements.map((b) => b.text.text)).toEqual(['Let it finish', "Stop it, I'll take over"]);
    expect(messageText(offer.body)).toContain('<@U0WEBDEV>, the fixer started on this');
    expect(messageText(offer.body)).toContain('and is on `fix/WEB-1`');
    expect(messageText(offer.body)).toContain('No answer in 10 minutes means *Let it finish*.');

    await tap(w, offer, 'midflight_actions', 'stop_it', 'U0WEBDEV');
    await vi.waitFor(async () => expect((await w.booted.state.getIncident(incidentId))?.status).toBe('stopped'), WAIT);
    // The card says who stopped it; the run was cancelled before it handed anything back.
    await vi.waitFor(() => {
      const edit = w.slack.calls.find((c) => c.method === 'chat.update' && c.ts === offer.ts);
      expect(edit === undefined ? '' : messageText(edit.body)).toContain('<@U0WEBDEV> stopped the fixer before it pushed anything. <@U0WEBDEV> has the ticket.');
    }, WAIT);
    const log = await w.booted.state.read(incidentId);
    expect(log.filter((e) => e.type === 'fixer-started')).toHaveLength(1);
    expect(log.find((e): e is IncidentEvent<'stopped'> => e.type === 'stopped')?.payload.reason).toBe('U0WEBDEV took over');

    // A stopped run pushes nothing (#262): no work branch on GitHub, no pull request.
    const bare = w.github.repos.get(w.repo);
    expect(execFileSync('git', ['ls-remote', '--heads', bare?.url ?? '', 'fix/WEB-1'], { env: GIT_ENV, encoding: 'utf8' })).toBe('');
    expect(w.github.pulls.size).toBe(0);

    // The claimer is the assignee: the `update-fields` row, by the map's email, queued with the Stop.
    // (The projector sends it after the claim's attribution comment, whose 60 s batch window holds the lane, B 7.1.)
    const stoppedAt = Date.parse(log.find((e) => e.type === 'stopped')?.occurredAt ?? '');
    const assignRows = (await outboxRowsOf(w.booted.state.ctx, incidentId, 'update-fields')).filter((r) => r.batchKey === jiraFieldBatchKey(incidentId, 'assignee'));
    expect(assignRows.filter((r) => Date.parse(r.createdAt) >= stoppedAt).map((r) => r.payload)).toEqual([{ issueKey: 'WEB-1', fields: { assignee: { email: 'dana@example.com' } } }]);
    clean(w);
  }, 120_000);

  it('A 2.4: a held claim with no activity for claims.expiry gets the nudge in the thread', async () => {
    const playbook = '<playbook xmlns="urn:snapwing:playbook:v1" version="1"><claims expiry="PT2S" holdExpiry="PT2H" midFlightGrace="PT10M" businessHoursOnly="false"/></playbook>';
    const w = await world('01-level-0-ticket-only.json', 'HELP-1', { playbook });
    await shortcut(w);
    const incidentId = await incidentOf(w);
    await tap(w, await card(w, 'scope_actions'), 'scope_actions', 'looks-right', w.recording.reporter.id);
    await vi.waitFor(async () => expect((await w.booted.state.getIncident(incidentId))?.jiraKey).toBe('HELP-1'), WAIT);

    await react(w, 'Ev0CLAIM0001', 'U0HELPDEV', 'eyes');
    await vi.waitFor(async () => expect((await w.booted.state.read(incidentId)).some((e) => e.type === 'claimed')).toBe(true), WAIT);
    // Two seconds of silence: the nudge mentions the claimer in the incident's thread.
    const nudge = await vi.waitFor(() => {
      const found = w.slack.calls.find((c) => c.method === 'chat.postMessage' && String(c.body['text']).includes('still on HELP-1?'));
      if (found === undefined) throw new Error(`no nudge yet (${w.booted.logged.join('; ')})`);
      return found;
    }, WAIT);
    expect(nudge.body).toMatchObject({ channel: w.recording.channel.id, thread_ts: w.recording.anchor, text: '<@U0HELPDEV>, still on HELP-1? React 👀 to keep it, or I can take it.' });
    // Recorded, so a 👀 on the nudge itself resolves to the incident (and counts as activity).
    await vi.waitFor(async () => {
      const posted = (await w.booted.state.read(incidentId)).filter((e) => e.type === 'bot-message-posted' && e.payload.messageId === nudge.ts);
      expect(posted.map((e) => (e as IncidentEvent<'bot-message-posted'>).payload.role)).toEqual(['other']);
    }, WAIT);
    clean(w);
  }, 120_000);

  it('A 6.4: an INSTRUCTIONS.md release window holds the autopilot merge at level 2 with the status sentence', async () => {
    const instructions = '# Workspace instructions\n\n- A release window is open until Friday. During a release window, hold all autopilot merges until the window closes.\n';
    const w = await world('04-level-3-autopilot.json', 'APP-1', { instructions });
    await shortcut(w);
    const incidentId = await incidentOf(w);
    await tap(w, await card(w, 'scope_actions'), 'scope_actions', 'looks-right', w.recording.reporter.id);
    await vi.waitFor(() => expect(w.jira.issues.get('APP-1')?.custom['Autonomy Level']).toBe(3), WAIT);
    const statusTs = await statusMessageTs(w, incidentId);
    await deliverJira(w, 'APP-1');

    // The fixer start was checked and went ahead: wait for the fixer's PR (the clone, run and push take
    // the longest under load), so the status wait below is bounded on the merge check alone (#292).
    await vi.waitFor(async () => {
      const log = await w.booted.state.read(incidentId);
      if (!log.some((e) => e.type === 'fixer-checkpoint' && e.payload.phase === 'pr-opened')) throw new Error(`no PR yet (${await diagnose(w, incidentId)})`);
    }, WAIT);
    // The merge was checked and held.
    await statusShows(w, statusTs, 'Holding for the release window per workspace instructions', incidentId);
    expect(w.model.steps).toEqual(['fixer-start', 'merge']);
    const log = await w.booted.state.read(incidentId);
    const held = log.find((e): e is IncidentEvent<'held'> => e.type === 'held');
    expect(held?.payload).toMatchObject({ kind: 'gate', reason: 'Holding for the release window per workspace instructions' });
    expect(log.filter((e): e is IncidentEvent<'level-changed'> => e.type === 'level-changed').map((e) => [e.payload.from, e.payload.to])).toEqual([[3, 2]]);
    expect(log.some((e) => e.type === 'merged')).toBe(false);
    expect(w.github.pull(w.repo, 1)?.merged).toBe(false);
    // Level 2 from here: the PR card goes to a person (who links GitHub to get Merge, main 11.2).
    const prCard = await card(w, 'pr_actions');
    expect(messageText(prCard.body)).toContain('APP-1');
    clean(w);
  }, 120_000);

  it('A 4.4, 4.6, 5.3: channel members in kv follow the membership events; a digest is a worker job; a ux-friction Task reaches Jira', async () => {
    const playbook = '<playbook xmlns="urn:snapwing:playbook:v1" version="1"><notifications><digest to="#web-bugs" cron="0 9 * * 1-5"/></notifications></playbook>';
    const w = await world('03-level-2-fix-now.json', 'WEB-1', { playbook, members: ['U0SALESLEAD', 'U0WEBDEV'] });
    const cache = createKvCache(w.booted.state);
    const key = channelMembersKey(w.recording.channel.id);
    await vi.waitFor(async () => expect(JSON.parse((await cache.get(key)) ?? 'null')).toEqual(['U0SALESLEAD', 'U0WEBDEV']), WAIT);
    await slackEvent(w, 'Ev0JOIN00001', { type: 'member_joined_channel', user: 'U0NEWBIE', channel: w.recording.channel.id, channel_type: 'C', event_ts: (Date.now() / 1000).toFixed(6) });
    await vi.waitFor(async () => expect(JSON.parse((await cache.get(key)) ?? 'null')).toEqual(['U0NEWBIE', 'U0SALESLEAD', 'U0WEBDEV']), WAIT);
    await slackEvent(w, 'Ev0LEFT00001', { type: 'member_left_channel', user: 'U0SALESLEAD', channel: w.recording.channel.id, channel_type: 'C', event_ts: (Date.now() / 1000).toFixed(6) });
    await vi.waitFor(async () => expect(JSON.parse((await cache.get(key)) ?? 'null')).toEqual(['U0NEWBIE', 'U0WEBDEV']), WAIT);

    // The playbook's digest is registered with the worker, next to the phase 4 timers.
    expect(w.booted.composed.jobs.map((j) => j.name)).toEqual(expect.arrayContaining(['digest.0', 'timer.mid-flight', 'timer.hold', 'timer.claim-nudge', 'timer.claim-expiry']));

    // The row the ux-friction filer enqueues: a Task with no incident, created once by the Jira projector.
    const workspaceId = await ensureInstallWorkspace(w.booted.state);
    const at = new Date().toISOString();
    const summary = '3 reporters landed on a test environment instead of the live site on Website';
    await w.booted.state.enqueueOutbox({
      id: ulid(),
      workspaceId,
      target: 'jira',
      op: 'create-task',
      payload: { fields: { project: { key: 'WEB' }, issuetype: { name: 'Task' }, summary, description: textToAdf('Three people made the same mistake.'), labels: ['ux-friction'] } },
      attempts: 0,
      nextAttempt: at,
      createdAt: at,
    });
    await vi.waitFor(() => {
      const task = [...w.jira.issues.values()].find((i) => i.summary === summary);
      expect(task?.labels).toEqual(['ux-friction', expect.stringMatching(/^snapwing-task-/)]);
    }, WAIT);
    clean(w);
  }, 120_000);
});
