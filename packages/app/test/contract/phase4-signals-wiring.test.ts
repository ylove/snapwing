// Signal side effects, escalation ladders, and active monitoring on the composed app (A 1.4,
// A 1.6, A 3, A 4.5, A 6.2), on MSW with the e2e world (fixtures/e2e/): the real `compose`,
// worker, projectors, and routes, Slack events and taps signed as Slack sends them.
//
// - Five reporters and the surface owner react 🔥 on the report: the reaction ladder reaches step 2
//   (priority Highest, the owner mentioned in the thread), and the Highest priority starts monitoring.
// - The reporter takes the 🐛 back within 60 s: the adapter's Stop stops it once; the handler records
//   the removal as that Stop and never stops a second time.
// - "works now" in the thread: the reporter alone is asked to close it, and Close closes it as
//   Cannot Reproduce through the Jira outbox.
// - A critical incident that stalls starts the `stalled-fix` ladder, whose first step mentions the
//   owner in the thread.
// - A handoff in the thread is taken by the named engineer's 👀 (reassigned through the Jira outbox),
//   and "also the footer is broken" gets the scope-change card, whose Yes files a linked incident.
//
// No keys and no network. Runs on the dialect `SNAPWING_DB` selects (pg-boss on Postgres).

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventType, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel, type Scenario } from '@snapwing/pipeline/demo/run.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionResult } from '@snapwing/pipeline/ports/model.ts';
import { SIGNAL_SCHEMA_NAME } from '@snapwing/pipeline/signals/llm.ts';
import { TEXT_SIGNAL_SCHEMA_NAME } from '@snapwing/pipeline/signals/text.ts';
import { outboxRowsOf } from '@snapwing/pipeline/state/outbox.ts';
import { jiraFieldBatchKey } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { RESOLUTION_BLOCK, SCOPE_CHANGE_BLOCK } from '../../src/adapters/slack/signals.ts';
import { FakeGitHub } from '../fixtures/e2e/github.ts';
import {
  blockIds,
  bootComposed,
  DEMO_LEVELS,
  DEMO_MAP,
  EXAMPLE_CONFIG,
  fakeSecrets,
  messageText,
  SLACK_API,
  slackSigned,
  slackWorld,
  type Booted,
  type SlackPostCall,
  type SlackWorld,
} from '../fixtures/e2e/world.ts';

const WAIT = { timeout: 20_000, interval: 25 };
const RECORDING = '01-level-0-ticket-only.json';
const ISSUE = 'HELP-1';
/** The help surface's owner in the demo map (`helpDev`). */
const OWNER = 'U0HELPDEV';

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
  dir = await mkdtemp(join(tmpdir(), 'snapwing-phase4-signals-'));
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

const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the harness was not expected to run at level 0')) };

/** The recording, plus "nothing here" from both signal passes for a reply no lexicon places. */
class SignalsModel implements ModelBackend {
  constructor(private readonly recorded: RecordedModel) {}
  complete(): Promise<CompletionResult> {
    return this.recorded.complete();
  }
  vision(): Promise<VisionResult> {
    return this.recorded.vision();
  }
  classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
    if (request.schemaName === SIGNAL_SCHEMA_NAME) return Promise.resolve({ value: { intent: 'none', confidence: 0 }, model: 'test/signals' });
    if (request.schemaName === TEXT_SIGNAL_SCHEMA_NAME) return Promise.resolve({ value: { kind: 'none', confidence: 0 }, model: 'test/signals' });
    return this.recorded.classify(request);
  }
}

interface World {
  booted: Booted;
  recording: Scenario;
  slack: SlackWorld;
  /** The channel's messages as Slack holds them; a reply a test posts is added. */
  messages: Record<string, unknown>[];
  jira: JiraWorld;
}

async function world(options: { playbook?: string; reactionsGet?: boolean; scopeCardDelayMs?: number } = {}): Promise<World> {
  const recording = parseScenario(RECORDING, JSON.parse(await readFile(join(DEMO_LEVELS, RECORDING), 'utf8')));
  const channel = recording.channel.id;
  const messages: Record<string, unknown>[] = recording.messages.map((m) => ({ type: 'message', ...m }));
  const scopeDelay = options.scopeCardDelayMs ?? 0;
  const slack = slackWorld(server, channel, messages, { postReplyDelayMs: (body) => (blockIds(body).some((id) => id.startsWith(`${SCOPE_CHANGE_BLOCK}:`)) ? scopeDelay : 0) });
  const jira = new JiraWorld(() => undefined);
  const demoGitHub = new GitHubWorld(() => undefined);
  demoGitHub.addRepos(recording.github);
  github = new FakeGitHub(join(dir, 'github'));
  for (const [name, files] of Object.entries(recording.github)) await github.addRepo(name, files);
  server.use(...github.handlers(), ...jiraHandlers(jira), ...githubHandlers(demoGitHub));
  if (options.reactionsGet === true) {
    // The trigger path reads the reactors of a 🐛 (min reactors, main 4.1).
    const anchor = recording.messages.find((m) => m.ts === recording.anchor);
    server.use(
      http.get(`${SLACK_API}/reactions.get`, () =>
        HttpResponse.json({ ok: true, type: 'message', channel, message: { ...anchor, type: 'message', reactions: [{ name: 'bug', count: 1, users: [recording.reporter.id] }] } }),
      ),
    );
  }

  // Generated per run, never committed: the App JWT is signed for real.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const secrets = { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
  // Absent files: no playbook (the defaults) and no instructions, whatever the working directory holds.
  const env: Record<string, string> = {
    SNAPWING_MAP: DEMO_MAP,
    SNAPWING_WORKDIR_ROOT: join(dir, 'work'),
    SNAPWING_PLAYBOOK: join(dir, 'playbook.xml'),
    SNAPWING_INSTRUCTIONS: join(dir, 'INSTRUCTIONS.md'),
  };
  if (options.playbook !== undefined) await writeFile(env['SNAPWING_PLAYBOOK'] ?? '', options.playbook);
  const model = new RecordedModel();
  model.use(recording.name, recording.model);
  booted = await bootComposed({
    state: await tdb.open(),
    configXml: await readFile(EXAMPLE_CONFIG, 'utf8'),
    secrets,
    dir,
    env,
    overrides: { model: withValidation(new SignalsModel(model)), resolveHarness: () => idleHarness, projectorPollMs: 25, gitRemoteUrl: github.remoteUrl },
  });
  return { booted, recording, slack, jira, messages };
}

// Steps -------------------------------------------------------------------------------------------

/** `vi.waitFor` with what the app logged and the workers' errors, so a timeout says why. */
async function within<T>(w: World, check: () => T | Promise<T>): Promise<T> {
  try {
    return await vi.waitFor(check, WAIT);
  } catch (e) {
    const why = `logged: ${w.booted.logged.join('; ') || 'nothing'}; errors: ${w.booted.errors.map(String).join('; ') || 'none'}`;
    throw new Error(`${e instanceof Error ? e.message : String(e)} (${why})`, { cause: e });
  }
}

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

/** The latest call of `method` with an actions block whose id is `blockId` or starts with `blockId:`. */
async function card(w: World, blockId: string, method = 'chat.postMessage'): Promise<SlackPostCall> {
  return within(w, () => {
    const found = w.slack.calls.filter((c) => c.method === method && blockIds(c.body).some((id) => id === blockId || id.startsWith(`${blockId}:`))).at(-1);
    if (found === undefined) throw new Error(`no ${blockId} card yet`);
    return found;
  });
}

interface Button {
  action_id: string;
  value: string;
  text: { text: string };
}

function actionsBlock(c: SlackPostCall, blockId: string): { block_id: string; elements: Button[] } {
  const blocks = c.body['blocks'] as { block_id?: string; elements?: Button[] }[];
  const block = blocks.find((b) => b.block_id === blockId || b.block_id?.startsWith(`${blockId}:`) === true);
  return { block_id: block?.block_id ?? '', elements: block?.elements ?? [] };
}

/** Taps `actionId` as `userId`: a `block_actions` payload like Slack's (an ephemeral has no message). */
async function tap(w: World, c: SlackPostCall, blockId: string, actionId: string, userId: string, ephemeral = false): Promise<void> {
  const block = actionsBlock(c, blockId);
  const button = block.elements.find((b) => b.action_id === actionId);
  if (button === undefined) throw new Error(`no ${actionId} button on the ${blockId} card`);
  const channel = String(c.body['channel']);
  const response = await w.booted.interact({
    type: 'block_actions',
    user: { id: userId },
    channel: { id: channel },
    container: ephemeral ? { type: 'message', channel_id: channel, is_ephemeral: true } : { type: 'message', channel_id: channel, message_ts: c.ts },
    ...(ephemeral ? {} : { message: { ts: c.ts, thread_ts: w.recording.anchor, blocks: c.body['blocks'] } }),
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

const nowTs = (): string => (Date.now() / 1000).toFixed(6);

/** `user` adds (or removes) the reaction `name` on the recording's anchor, at `eventTs` (default now). */
async function react(w: World, eventId: string, user: string, name: string, opts: { removed?: boolean; eventTs?: string } = {}): Promise<void> {
  await slackEvent(w, eventId, {
    type: opts.removed === true ? 'reaction_removed' : 'reaction_added',
    user,
    reaction: name,
    item_user: w.recording.reporter.id,
    item: { type: 'message', channel: w.recording.channel.id, ts: w.recording.anchor },
    event_ts: opts.eventTs ?? nowTs(),
  });
}

/** `user` replies `text` in the anchor's thread. */
async function reply(w: World, eventId: string, user: string, text: string): Promise<string> {
  const ts = nowTs();
  w.messages.push({ type: 'message', user, text, ts, thread_ts: w.recording.anchor });
  await slackEvent(w, eventId, { type: 'message', channel: w.recording.channel.id, channel_type: 'channel', user, text, ts, thread_ts: w.recording.anchor, event_ts: ts });
  return ts;
}

/** The level 0 report, scoped and filed as HELP-1. */
async function filedIncident(w: World): Promise<string> {
  await shortcut(w);
  const scope = await card(w, 'scope_actions');
  const incidentId = actionsBlock(scope, 'scope_actions').elements[0]?.value ?? '';
  await tap(w, scope, 'scope_actions', 'looks-right', w.recording.reporter.id);
  await within(w, async () => expect((await w.booted.state.getIncident(incidentId))?.jiraKey).toBe(ISSUE));
  return incidentId;
}

async function events<T extends EventType>(w: World, incidentId: string, type: T): Promise<IncidentEvent<T>[]> {
  return (await w.booted.state.read(incidentId)).filter((e) => e.type === type) as unknown as IncidentEvent<T>[];
}

/** The ephemeral texts shown to `user`, oldest first. */
function ephemeralsTo(w: World, user: string): string[] {
  return w.slack.calls.filter((c) => c.method === 'chat.postEphemeral' && c.body['user'] === user).map((c) => messageText(c.body));
}

function threadPosts(w: World): SlackPostCall[] {
  return w.slack.calls.filter((c) => c.method === 'chat.postMessage' && c.body['thread_ts'] === w.recording.anchor);
}

function clean(w: World): void {
  expect(w.slack.unknown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(w.booted.errors).toEqual([]);
  expect(w.booted.logged).toEqual([]);
}

// Tests -------------------------------------------------------------------------------------------

describe('signal side effects, escalation ladders, and active monitoring on the composed app', () => {
  it('A 1.4: five reporters and the owner react 🔥: step 2 raises the priority to Highest and mentions the owner', async () => {
    const w = await world();
    const incidentId = await filedIncident(w);

    for (const [i, user] of ['U0FIRE1', 'U0FIRE2', 'U0FIRE3', 'U0FIRE4', 'U0FIRE5', OWNER].entries()) {
      // Inside the counting window, which runs from the recorded report (A 1.4, `weights.window` PT2H).
      await react(w, `Ev0FIRE${String(i)}`, user, 'fire', { eventTs: (Number(w.recording.anchor) + 60 + i).toFixed(6) });
      // One at a time, as people react: each counted signal walks the ladder.
      await within(w, async () => expect((await events(w, incidentId, 'comment')).filter((c) => c.payload.intent === 'escalate')).toHaveLength(i + 1));
    }

    // Steps 1 (score 3) and 2 (score 5); the owner's 2.0 brings the score to 7, short of the outage step.
    await within(w, async () => expect((await events(w, incidentId, 'escalated')).map((e) => e.payload.step)).toEqual([1, 2]));
    const steps = (await events(w, incidentId, 'escalated')).map((e) => e.payload);
    expect(steps[0]).toMatchObject({ step: 1, priority: 'High', note: true });
    expect(steps[1]).toMatchObject({ step: 2, priority: 'Highest', mentionOwner: true, suppressAskBack: true });
    expect((await w.booted.state.getIncident(incidentId))?.priority).toBe('Highest');

    // The owner is mentioned in the incident's thread.
    const mention = await within(w, () => {
      const found = threadPosts(w).find((c) => messageText(c.body).includes('Priority raised to Highest'));
      if (found === undefined) throw new Error(`no step 2 post yet`);
      return found;
    });
    expect(messageText(mention.body)).toBe(`<@${OWNER}> 5 people are reporting this. Priority raised to Highest.`);
    expect(threadPosts(w).some((c) => messageText(c.body) === '3 people are reporting this. Priority raised to High.')).toBe(true);

    // The filed issue's priority goes through the outbox, a human's edit in Jira wins (B 7.3).
    const rows = (await outboxRowsOf(w.booted.state.ctx, incidentId, 'update-fields')).filter((r) => r.batchKey === jiraFieldBatchKey(incidentId, 'priority'));
    expect(rows.map((r) => r.payload)).toContainEqual({ issueKey: ISSUE, fields: { priority: { name: 'Highest' } } });

    // Highest qualifies the incident for active monitoring (A 4.5), started by the worker.
    await within(w, async () => expect((await events(w, incidentId, 'monitoring-started')).map((e) => e.payload)).toEqual([{ qualifiedBy: 'priority' }]));
    expect((await w.booted.state.getIncident(incidentId))?.monitored).toBe(true);
    expect(w.booted.composed.jobs.map((j) => j.name)).toEqual(expect.arrayContaining(['monitor.poll', 'timer.heartbeat', 'timer.stall', 'timer.escalate']));
    clean(w);
  }, 60_000);

  it('A 1.6: the 🐛 taken back within 60 s stops through the adapter only', async () => {
    const w = await world({ reactionsGet: true });
    const reporter = w.recording.reporter.id;
    await react(w, 'Ev0BUG00001', reporter, 'bug');
    // The trigger creates the incident, and the 🐛 is adopted as its first trigger signal.
    const incidentId = await within(w, async () => {
      const [incident] = await w.booted.state.findIncidents({ limit: 5 });
      if (incident === undefined) throw new Error('no incident yet');
      expect((await events(w, incident.id, 'comment')).map((c) => [c.payload.intent, c.payload.signalSource])).toEqual([['trigger', 'reaction']]);
      return incident.id;
    });

    await react(w, 'Ev0BUG00002', reporter, 'bug', { removed: true });
    await within(w, async () => expect((await w.booted.state.getIncident(incidentId))?.status).toBe('stopped'));
    const removal = await within(w, async () => {
      const found = (await events(w, incidentId, 'comment')).find((c) => c.payload.signalSource === 'reaction-removed');
      if (found === undefined) throw new Error('no removal recorded yet');
      return found;
    });
    expect(removal.payload).toMatchObject({ intent: 'trigger', effect: 'stop' });
    // One Stop, the adapter's; the handler's plan said `viaAdapter` and appended nothing more.
    const stopped = await events(w, incidentId, 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.actor?.id).toBe(reporter);
    clean(w);
  }, 60_000);

  it('A 3: "works now" in the thread asks the reporter alone, and Close closes it as Cannot Reproduce', async () => {
    const w = await world();
    const incidentId = await filedIncident(w);
    const reporter = w.recording.reporter.id;

    const said = await reply(w, 'Ev0WORKS0001', reporter, 'nvm, works now');
    const prompt = await card(w, RESOLUTION_BLOCK, 'chat.postEphemeral');
    expect(prompt.body).toMatchObject({ channel: w.recording.channel.id, user: reporter, thread_ts: w.recording.anchor, text: `Close ${ISSUE} as Cannot Reproduce?` });
    expect(actionsBlock(prompt, RESOLUTION_BLOCK).block_id).toBe(`${RESOLUTION_BLOCK}:${said}`);
    expect(actionsBlock(prompt, RESOLUTION_BLOCK).elements.map((b) => b.text.text)).toEqual(['Close it', 'Keep it open']);
    // Nothing in the thread: the question is the reporter's alone.
    expect(threadPosts(w).some((c) => messageText(c.body).includes('Cannot Reproduce'))).toBe(false);

    await tap(w, prompt, RESOLUTION_BLOCK, 'close', reporter, true);
    await within(w, async () => expect((await w.booted.state.getIncident(incidentId))?.status).toBe('closed'));
    const steps = (await events(w, incidentId, 'text-signal')).map((e) => [e.payload.kind, e.payload.phase, e.payload.resolution]);
    expect(steps).toEqual([
      ['resolution', 'asked', 'Cannot Reproduce'],
      ['resolution', 'confirmed', 'Cannot Reproduce'],
    ]);
    // The close carries its resolution to Jira through the outbox, with a comment saying why.
    const transitions = (await outboxRowsOf(w.booted.state.ctx, incidentId, 'transition')).map((r) => r.payload);
    expect(transitions).toContainEqual({ issueKey: ISSUE, to: 'done', resolution: 'Cannot Reproduce' });
    const comments = (await outboxRowsOf(w.booted.state.ctx, incidentId, 'add-comment')).map((r) => String(r.payload['text']));
    expect(comments).toContain('Closed as Cannot Reproduce. @supportLead confirmed it in the thread: "nvm, works now".');
    await within(w, () => expect(w.slack.calls.some((c) => c.method === 'chat.postEphemeral' && c.body['text'] === `Closed ${ISSUE}.`)).toBe(true));
    clean(w);
  }, 60_000);

  it('A 4.5, 6.2: a critical incident with no progress stalls and starts the stalled-fix ladder, whose first step mentions the owner', async () => {
    const playbook = [
      '<playbook xmlns="urn:snapwing:playbook:v1" version="1">',
      '<monitor interval="PT1S" heartbeat="PT1H" stallAfter="PT2S"><critical surface="help"/></monitor>',
      '<escalation name="stalled-fix"><after duration="PT0S" mention="owner"/><after duration="PT45M" mention="@U0ADMDEV"/><applyWhen monitored="true" stalled="true"/></escalation>',
      '</playbook>',
    ].join('');
    const w = await world({ playbook });
    const incidentId = await filedIncident(w);

    // The critical surface starts monitoring; two quiet seconds after filing, the stall starts the ladder.
    await within(w, async () => expect((await events(w, incidentId, 'monitoring-started')).map((e) => e.payload.qualifiedBy)).toContain('critical-surface'));
    const step = await within(w, () => {
      const found = threadPosts(w).find((c) => messageText(c.body).includes('Escalating (stalled-fix, step 1 of 2)'));
      if (found === undefined) throw new Error(`no stalled-fix step yet`);
      return found;
    });
    expect(step.body['channel']).toBe(w.recording.channel.id);
    expect(messageText(step.body)).toMatch(new RegExp(`^<@${OWNER}> Escalating \\(stalled-fix, step 1 of 2\\): ${ISSUE} `));
    await within(w, async () => {
      const ladder = (await events(w, incidentId, 'escalation-ladder')).map((e) => e.payload);
      expect(ladder).toEqual(expect.arrayContaining([{ phase: 'started', ladder: 'stalled-fix' }, expect.objectContaining({ phase: 'step', ladder: 'stalled-fix', step: 1, mentioned: 'helpDev', posted: true })]));
    });
    // A ladder step is the agent's own record: no `escalated`, and the status does not move.
    expect(await events(w, incidentId, 'escalated')).toEqual([]);
    expect((await w.booted.state.getIncident(incidentId))?.status).toBe('filed');
    clean(w);
  }, 60_000);

  it('A 3: the named engineer takes a handoff with 👀, and Yes on the scope-change card files the second issue', async () => {
    const w = await world();
    const incidentId = await filedIncident(w);
    const reporter = w.recording.reporter.id;

    await reply(w, 'Ev0HANDOFF01', reporter, `<@${OWNER}> can you take this?`);
    await within(w, async () => expect((await events(w, incidentId, 'text-signal')).map((e) => [e.payload.kind, e.payload.phase, e.payload.to])).toEqual([['handoff', 'asked', OWNER]]));
    await react(w, 'Ev0HANDOFF02', OWNER, 'eyes');
    await within(w, async () => {
      const taken = (await events(w, incidentId, 'text-signal')).filter((e) => e.payload.kind === 'handoff' && e.payload.phase === 'accepted');
      expect(taken.map((e) => [e.payload.to, e.payload.via])).toEqual([[OWNER, 'reaction']]);
    });
    // Reassigned on the ticket by the map's email (the row the projector resolves).
    const assignees = (await outboxRowsOf(w.booted.state.ctx, incidentId, 'update-fields')).filter((r) => r.batchKey === jiraFieldBatchKey(incidentId, 'assignee'));
    expect(assignees.map((r) => r.payload)).toContainEqual({ issueKey: ISSUE, fields: { assignee: { email: 'hana@example.com' } } });

    const said = await reply(w, 'Ev0SCOPE0001', reporter, 'also the footer is broken');
    const scope = await card(w, SCOPE_CHANGE_BLOCK);
    expect(scope.body).toMatchObject({ channel: w.recording.channel.id, thread_ts: w.recording.anchor, text: 'Sounds like a second issue. File it separately?' });
    expect(actionsBlock(scope, SCOPE_CHANGE_BLOCK)).toMatchObject({ block_id: `${SCOPE_CHANGE_BLOCK}:${said}` });
    expect(actionsBlock(scope, SCOPE_CHANGE_BLOCK).elements.map((b) => b.text.text)).toEqual(['Yes', "It's the same bug"]);

    await tap(w, scope, SCOPE_CHANGE_BLOCK, 'yes', reporter);
    // The second issue is its own incident, anchored on the message that described it.
    const linked = await within(w, async () => {
      const other = (await w.booted.state.findIncidents({ limit: 5 })).find((i) => i.id !== incidentId);
      if (other === undefined) throw new Error(`no linked incident yet (said to ${reporter}: ${ephemeralsTo(w, reporter).join(' | ') || 'nothing'})`);
      expect(other).toMatchObject({ anchorId: said, channelId: w.recording.channel.id, reporterId: reporter });
      return other.id;
    });
    const split = (await events(w, incidentId, 'text-signal')).filter((e) => e.payload.kind === 'scope-change').map((e) => [e.payload.phase, e.payload.linkedIncidentId]);
    expect(split).toEqual([
      ['proposed', undefined],
      ['split', linked],
    ]);
    await within(w, () => {
      const edit = w.slack.calls.find((c) => c.method === 'chat.update' && c.ts === scope.ts);
      expect(edit === undefined ? '' : messageText(edit.body)).toContain(`<@${reporter}> chose *Yes, file it separately*.`);
    });
    const proposed = (await events(w, incidentId, 'text-signal')).filter((e) => e.payload.kind === 'scope-change' && e.payload.phase === 'proposed');
    expect(proposed.map((e) => e.payload.cardMessageId)).toEqual([scope.ts]);
    // The tap was taken, never refused.
    expect(ephemeralsTo(w, reporter).filter((t) => t.includes('already has an answer'))).toEqual([]);
    clean(w);
  }, 60_000);

  it('A 3: a tap on the scope-change card that lands before its proposal is recorded waits for it', async () => {
    // Slack's answer to the card's post is held 1.5 s, so the app records the proposal that much after
    // the card is visible; the tap comes straight away.
    const w = await world({ scopeCardDelayMs: 1500 });
    const incidentId = await filedIncident(w);
    const reporter = w.recording.reporter.id;
    const said = await reply(w, 'Ev0SCOPE0354', reporter, 'also the footer is broken');
    const scope = await card(w, SCOPE_CHANGE_BLOCK);
    expect((await events(w, incidentId, 'text-signal')).filter((e) => e.payload.kind === 'scope-change')).toEqual([]);
    await tap(w, scope, SCOPE_CHANGE_BLOCK, 'same-bug', reporter);
    await within(w, async () => {
      const phases = (await events(w, incidentId, 'text-signal')).filter((e) => e.payload.kind === 'scope-change' && e.payload.messageId === said).map((e) => e.payload.phase);
      expect(phases).toEqual(['proposed', 'same']);
    });
    await within(w, () => {
      const edit = w.slack.calls.find((c) => c.method === 'chat.update' && c.ts === scope.ts);
      expect(edit === undefined ? '' : messageText(edit.body)).toContain(`<@${reporter}> chose *It's the same bug*.`);
    });
    // No refusal was posted.
    expect(ephemeralsTo(w, reporter).filter((t) => t.includes('already has an answer'))).toEqual([]);
    clean(w);
  }, 60_000);
});
