// Slack interactivity (main 8.2, 15.1, 16; B 5 awaitInteractive). `block_actions` payloads as
// Slack sends them, over a real state store (SNAPWING_DB picks the dialect) and the real
// `stopIncident`; the orchestrator, the Web API client, the runner, and GitHub are recording fakes.

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { FixerDeps } from '@snapwing/pipeline/fixer/job.ts';
import { stopIncident } from '@snapwing/pipeline/fixer/stop.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createSlackAdapter, type SlackAdapter } from '../../src/adapters/slack/adapter.ts';
import { buildScopePreview } from '../../src/adapters/slack/cards/cards.ts';
import {
  JIRA_RESOLUTION_WONT_DO,
  createSlackInteractivity,
  observeReactionRemoval,
  type PrActionInput,
  type SlackInteractivity,
} from '../../src/adapters/slack/interactivity.ts';
import { createSlackDispatcher, type SlackActionPayload } from '../../src/adapters/slack/transport.ts';
import { ALREADY_ASKED_TEXT, NOT_A_BUG_REFUSED } from '../../src/adapters/shared/taps.ts';
import type { PostEphemeralArgs, PostMessageArgs, SlackWeb, UpdateMessageArgs } from '../../src/adapters/slack/web.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6INTERACT00000000000001';
const CHANNEL = 'C0WEBBUGS';
const THREAD = '1759395600.000100';
const CARD_TS = '1759395610.000200';
const REPORTER = 'U0SALESLEAD';
const ENGINEER = 'U0WEBDEV1'; // primary owner of web/nav in the example map
const OTHER_ENGINEER = 'U0MOBDEV';
const RUN = 'run-1';

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let web: ReturnType<typeof recordingWeb>;
let taps: TapInput[];
let tapOutcome: TapOutcome;
let cancelled: string[];
let closedPrs: number[];
let prCalls: { action: string; input: PrActionInput }[];
let linked: Set<string>;
let ix: SlackInteractivity;

function recordingWeb() {
  const calls = { post: [] as PostMessageArgs[], update: [] as UpdateMessageArgs[], ephemeral: [] as PostEphemeralArgs[] };
  const web: Pick<SlackWeb, 'postMessage' | 'updateMessage' | 'postEphemeral'> = {
    postMessage: (a) => (calls.post.push(a), Promise.resolve({ channel: a.channel, ts: '1759395700.000300' })),
    updateMessage: (a) => (calls.update.push(a), Promise.resolve({ channel: a.channel, ts: a.ts })),
    postEphemeral: (a) => (calls.ephemeral.push(a), Promise.resolve({ messageTs: '1759395701.000400' })),
  };
  return { web, calls };
}

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
  web = recordingWeb();
  taps = [];
  tapOutcome = { accepted: true, resumed: true };
  cancelled = [];
  closedPrs = [];
  prCalls = [];
  linked = new Set();
  const fixerDeps: FixerDeps = {
    workspaceId: WS,
    state,
    workflow: new InProcessWorkflow(state),
    runner: { runFixer: () => Promise.reject(new Error('not in this test')), cancel: (id) => (cancelled.push(id), Promise.resolve()) },
    github: { markIncomplete: () => Promise.resolve(), closePr: (pr) => (closedPrs.push(pr), Promise.resolve()) },
    config: { harness: { adapter: 'claude-code' } },
    clock: () => new Date(now),
  };
  const record = (action: string) => (input: PrActionInput) => (prCalls.push({ action, input }), Promise.resolve());
  ix = createSlackInteractivity({
    web: web.web,
    state,
    workspaceId: WS,
    orchestrator: { handleTap: (tap) => (taps.push(tap), Promise.resolve(tapOutcome)) },
    stopIncident: (input) => stopIncident(fixerDeps, input),
    prActions: { merge: record('merge'), requestChanges: record('request_changes'), revert: record('revert') },
    getMap: () => Promise.resolve(map),
    githubLinked: (user) => linked.has(user),
    botUserId: 'U0BOT',
    clock: () => new Date(now),
  });
});

afterEach(async () => {
  await tdb.drop();
});

// Log ---------------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

async function append(events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

/** Captured from a 🐛 reaction by the reporter on web/nav, planned at `level`. */
async function seedPlanned(level: 0 | 1 | 2 | 3): Promise<void> {
  await append([
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack-${CHANNEL}-${THREAD}-bug`,
      source: 'slack',
      reporter: { id: REPORTER, name: 'salesLead', role: 'reporter' },
      anchorText: 'the nav menu is gone on the pricing page',
      anchorId: THREAD,
      channelId: CHANNEL,
      rawPayloadSnapshot: { type: 'reaction_added', reaction: 'bug', ts: THREAD, reactors: [REPORTER, OTHER_ENGINEER] },
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'nav', repo: 'github.com/acme/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Nav menu missing on pricing page',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: '01K6REQUEST000000000000001', version: 1 },
    }),
  ]);
}

/** Filed at `level` with a fixer run going. */
async function seedFixing(level: 2 | 3): Promise<void> {
  await seedPlanned(level);
  await append([ev('filed', { jiraKey: 'WEB-1042' }), ev('fixer-started', { runId: RUN, harness: 'claude-code', attempt: 1 })]);
}

/** Filed at `level`, the fixer done, and PR 77 open. */
async function seedPrOpen(level: 1 | 2 | 3): Promise<void> {
  await seedPlanned(level);
  await append([
    ev('filed', { jiraKey: 'WEB-1042' }),
    ev('fixer-started', { runId: RUN, harness: 'claude-code', attempt: 1 }),
    ev('fixer-done', { prNumber: 77, branch: 'WEB-1042-nav', summary: 'Restore the nav', testsAdded: [] }),
    ev('pr-opened', { prNumber: 77, branch: 'WEB-1042-nav' }),
  ]);
}

async function types(): Promise<EventType[]> {
  return (await state.read(INC)).map((e) => e.type);
}

async function lastOf<T extends EventType>(type: T): Promise<IncidentEvent<T> | undefined> {
  return (await state.read(INC)).filter((e) => e.type === type).at(-1) as IncidentEvent<T> | undefined;
}

// Payloads ----------------------------------------------------------------------------------------

interface Button {
  actionId: string;
  label: string;
  style?: 'primary' | 'danger';
  /** Default the incident id alone. */
  value?: string;
}

function actionsBlock(blockId: string, buttons: Button[]): Record<string, unknown> {
  return {
    type: 'actions',
    block_id: blockId,
    elements: buttons.map((b) => ({
      type: 'button',
      ...(b.style === undefined ? {} : { style: b.style }),
      text: { type: 'plain_text', text: b.label },
      action_id: b.actionId,
      value: b.value ?? INC,
    })),
  };
}

const TRIAGE_L1: Button[] = [
  { actionId: 'approve_fix', label: 'Fix it', style: 'primary' },
  { actionId: 'ticket_only', label: 'Ticket only' },
  { actionId: 'dismiss', label: 'Not a bug', style: 'danger' },
];
const TRIAGE_L2: Button[] = [
  { actionId: 'stop', label: 'Stop', style: 'danger' },
  { actionId: 'dismiss', label: 'Not a bug' },
];
/** The head the PR card shows, and the merge commit the status message's Revert names (#264). */
const HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
const PR_READY: Button[] = [
  { actionId: 'merge', label: 'Merge', style: 'primary', value: `${INC}:77:${HEAD}` },
  { actionId: 'request_changes', label: 'Request changes', value: `${INC}:77:${HEAD}` },
  { actionId: 'stop', label: 'Stop', style: 'danger' },
];

function cardBlocks(blockId: string, buttons: Button[]): unknown[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text: '*Diagnosis:* Nav menu missing on pricing page' } }, actionsBlock(blockId, buttons)];
}

/** A `block_actions` payload as Slack delivers it for a tap on a card in the incident's thread. */
function blockActions(user: string, blockId: string, actionId: string, blocks: unknown[]): SlackActionPayload {
  const button = blocks
    .map((b) => b as { type?: string; block_id?: string; elements?: { action_id: string; text: { text: string }; value: string }[] })
    .filter((b) => b.type === 'actions' && b.block_id === blockId)
    .flatMap((b) => b.elements ?? [])
    .find((e) => e.action_id === actionId);
  return {
    type: 'block_actions',
    user: { id: user, username: user.toLowerCase(), team_id: 'T0ACME' },
    api_app_id: 'A0SNAPWING',
    token: 'verification-token-test',
    container: { type: 'message', message_ts: CARD_TS, channel_id: CHANNEL, is_ephemeral: false },
    trigger_id: '1.2.3',
    team: { id: 'T0ACME', domain: 'acme' },
    channel: { id: CHANNEL, name: 'web-bugs' },
    message: { type: 'message', user: 'U0BOT', ts: CARD_TS, thread_ts: THREAD, text: 'card', blocks },
    response_url: 'https://hooks.slack.com/actions/T0ACME/1/fake',
    actions: [
      {
        type: 'button',
        block_id: blockId,
        action_id: actionId,
        text: { type: 'plain_text', text: button?.text.text ?? actionId },
        value: button?.value ?? INC,
        action_ts: '1759395620.000500',
      },
    ],
  };
}

function tap(user: string, blockId: string, actionId: string, buttons: Button[]): SlackActionPayload {
  return blockActions(user, blockId, actionId, cardBlocks(blockId, buttons));
}

function reactionRemoved(user: string, reaction: string, removedAtMs: number): Record<string, unknown> {
  return {
    type: 'event_callback',
    team_id: 'T0ACME',
    event_id: 'Ev0REMOVED',
    event: {
      type: 'reaction_removed',
      user,
      reaction,
      item_user: REPORTER,
      item: { type: 'message', channel: CHANNEL, ts: THREAD },
      event_ts: (removedAtMs / 1000).toFixed(6),
    },
  };
}

// Card choices ------------------------------------------------------------------------------------

describe('card choices go to handleTap with the actor from the map', () => {
  const cases: { blockId: string; card: string; buttons: Button[]; actionId: string; label: string }[] = [
    { blockId: 'scope_actions', card: 'scope-preview', buttons: [{ actionId: 'looks-right', label: 'Looks right' }, { actionId: 'widen', label: 'Widen' }, { actionId: 'narrow', label: 'Narrow' }], actionId: 'looks-right', label: 'Looks right' },
    { blockId: 'scope_actions', card: 'scope-preview', buttons: [{ actionId: 'looks-right', label: 'Looks right' }, { actionId: 'widen', label: 'Widen' }, { actionId: 'narrow', label: 'Narrow' }], actionId: 'widen', label: 'Widen' },
    { blockId: 'scope_actions', card: 'scope-preview', buttons: [{ actionId: 'looks-right', label: 'Looks right' }, { actionId: 'widen', label: 'Widen' }, { actionId: 'narrow', label: 'Narrow' }], actionId: 'narrow', label: 'Narrow' },
    { blockId: 'dedupe_actions', card: 'dedupe', buttons: [{ actionId: 'link', label: 'Link this thread to WEB-9' }, { actionId: 'create-anyway', label: 'Create new anyway' }, { actionId: 'not-related', label: 'Not related' }], actionId: 'link', label: 'Link this thread to WEB-9' },
    { blockId: 'dedupe_actions', card: 'dedupe', buttons: [{ actionId: 'link', label: 'Link this thread to WEB-9' }, { actionId: 'create-anyway', label: 'Create new anyway' }, { actionId: 'not-related', label: 'Not related' }], actionId: 'create-anyway', label: 'Create new anyway' },
    { blockId: 'dedupe_actions', card: 'dedupe', buttons: [{ actionId: 'link', label: 'Link this thread to WEB-9' }, { actionId: 'create-anyway', label: 'Create new anyway' }, { actionId: 'not-related', label: 'Not related' }], actionId: 'not-related', label: 'Not related' },
    { blockId: 'clarify_actions', card: 'clarify', buttons: [{ actionId: 'Website', label: 'Website' }, { actionId: 'Mobile App', label: 'Mobile App' }], actionId: 'Mobile App', label: 'Mobile App' },
    { blockId: 'triage_actions', card: 'fix-preview', buttons: TRIAGE_L1, actionId: 'ticket_only', label: 'Ticket only' },
    { blockId: 'triage_actions', card: 'fix-preview', buttons: TRIAGE_L1, actionId: 'dismiss', label: 'Not a bug' },
  ];

  for (const c of cases) {
    it(`${c.card}: ${c.actionId}`, async () => {
      await seedPlanned(1);
      const out = await ix.handleAction(tap(REPORTER, c.blockId, c.actionId, c.buttons));
      expect(out).toEqual({ kind: 'tapped', card: c.card, choice: c.actionId, outcome: { accepted: true, resumed: true } });
      expect(taps).toEqual([{ eventId: INC, card: c.card, choice: c.actionId, actor: { id: REPORTER, role: 'reporter' } }]);
      // The card now says who chose what, in place of its buttons.
      expect(web.calls.update).toHaveLength(1);
      const update = web.calls.update[0];
      expect(update).toMatchObject({ channel: CHANNEL, ts: CARD_TS });
      expect(update?.blocks).toEqual([
        { type: 'section', text: { type: 'mrkdwn', text: '*Diagnosis:* Nav menu missing on pricing page' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `<@${REPORTER}> chose *${c.label}*.` }] },
      ]);
      expect(web.calls.ephemeral).toEqual([]);
    });
  }

  it('reads a card built by the card builders', async () => {
    const card = buildScopePreview(INC, { kind: 'scope-preview', summary: 'Reading 4 messages from the thread.' });
    const out = await ix.handleAction(blockActions(ENGINEER, 'scope_actions', 'looks-right', card.blocks));
    expect(out).toMatchObject({ kind: 'tapped', card: 'scope-preview', choice: 'looks-right' });
    expect(taps[0]?.actor).toEqual({ id: ENGINEER, role: 'engineer' });
    expect(web.calls.update[0]?.blocks?.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: `<@${ENGINEER}> chose *Looks right*.` }] });
  });

  it('an engineer taps Fix it at level 1', async () => {
    await seedPlanned(1);
    const out = await ix.handleAction(tap(ENGINEER, 'triage_actions', 'approve_fix', TRIAGE_L1));
    expect(out).toMatchObject({ kind: 'tapped', card: 'fix-preview', choice: 'approve_fix' });
    expect(taps).toEqual([{ eventId: INC, card: 'fix-preview', choice: 'approve_fix', actor: { id: ENGINEER, role: 'engineer' } }]);
  });

  it('a person outside the map is an unknown role', async () => {
    await seedPlanned(1);
    await ix.handleAction(tap('U0STRANGER', 'scope_actions', 'looks-right', [{ actionId: 'looks-right', label: 'Looks right' }]));
    expect(taps[0]?.actor).toEqual({ id: 'U0STRANGER', role: 'unknown' });
  });

  it('a tap on a card that is no longer waiting gets an ephemeral reply and leaves the card alone', async () => {
    await seedPlanned(1);
    tapOutcome = { accepted: false, reason: 'not-pending' };
    const out = await ix.handleAction(tap(REPORTER, 'dedupe_actions', 'create-anyway', [{ actionId: 'create-anyway', label: 'Create new anyway' }]));
    expect(out).toMatchObject({ kind: 'tapped', outcome: { accepted: false, reason: 'not-pending' } });
    expect(web.calls.update).toEqual([]);
    expect(web.calls.ephemeral).toEqual([{ channel: CHANNEL, user: REPORTER, text: 'This card already has an answer.', thread_ts: THREAD }]);
  });
});

// Authorization -----------------------------------------------------------------------------------

describe('authorization (main 8.2, 16)', () => {
  it('a reporter tapping Fix it asks the owner and the card is reposted mentioning the engineer', async () => {
    await seedPlanned(1);
    const out = await ix.handleAction(tap(REPORTER, 'triage_actions', 'approve_fix', TRIAGE_L1));
    expect(out).toEqual({ kind: 'denied', action: 'approve_fix', reason: 'engineer-required', askedOwner: ENGINEER });
    expect(taps).toEqual([]);
    expect(web.calls.ephemeral).toEqual([{ channel: CHANNEL, user: REPORTER, text: `I've asked <@${ENGINEER}> to approve.`, thread_ts: THREAD }]);
    expect(web.calls.post).toHaveLength(1);
    const repost = web.calls.post[0];
    expect(repost).toMatchObject({ channel: CHANNEL, thread_ts: THREAD });
    expect(repost?.text).toContain(`<@${ENGINEER}>`);
    expect(repost?.blocks?.[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: `<@${ENGINEER}>, <@${REPORTER}> asked for a fix. Tap *Fix it* to approve.` },
    });
    // The reposted card keeps the original buttons, so the engineer can tap Fix it on it.
    expect(repost?.blocks?.slice(1)).toEqual(cardBlocks('triage_actions', TRIAGE_L1));
    expect(web.calls.update).toEqual([]);
    expect(await types()).not.toContain('tapped');
  });

  it('asks the owner once per incident: a second Fix it from anyone who cannot approve reposts nothing (#272)', async () => {
    await seedPlanned(1);
    await ix.handleAction(tap(REPORTER, 'triage_actions', 'approve_fix', TRIAGE_L1));
    for (const who of [REPORTER, 'U0STRANGER']) {
      const again = await ix.handleAction(tap(who, 'triage_actions', 'approve_fix', TRIAGE_L1));
      expect(again).toEqual({ kind: 'denied', action: 'approve_fix', reason: 'engineer-required' });
      expect(web.calls.ephemeral.at(-1)).toEqual({ channel: CHANNEL, user: who, text: ALREADY_ASKED_TEXT, thread_ts: THREAD });
    }
    expect(web.calls.post).toHaveLength(1);
    expect(taps).toEqual([]);
    // An engineer's Fix it still goes through.
    expect(await ix.handleAction(tap(ENGINEER, 'triage_actions', 'approve_fix', TRIAGE_L1))).toMatchObject({ kind: 'tapped', choice: 'approve_fix' });
  });

  it('a handleTap refusal with askOwner is answered the same way', async () => {
    await seedPlanned(1);
    tapOutcome = { accepted: false, reason: 'engineer-required', askOwner: true };
    const out = await ix.handleAction(tap(REPORTER, 'clarify_actions', 'Website', [{ actionId: 'Website', label: 'Website' }]));
    expect(out).toMatchObject({ kind: 'denied', reason: 'engineer-required', askedOwner: ENGINEER });
    expect(web.calls.ephemeral[0]?.text).toBe(`I've asked <@${ENGINEER}> to approve.`);
  });

  it('a clarify option that reads like a routed verb stays a clarify answer', async () => {
    await seedPrOpen(2);
    linked.add(ENGINEER);
    const buttons = [{ actionId: 'stop', label: 'stop' }, { actionId: 'merge', label: 'merge' }];
    for (const option of ['stop', 'merge']) {
      taps.length = 0;
      await ix.handleAction(tap(ENGINEER, 'clarify_actions', option, buttons));
      expect(taps).toMatchObject([{ card: 'clarify', choice: option }]);
    }
    expect(cancelled).toEqual([]);
    expect(prCalls).toEqual([]);
    expect(await types()).not.toContain('stopped');
  });

  it('a merge without a linked GitHub identity is refused and never reaches PrActions', async () => {
    await seedPrOpen(2);
    const out = await ix.handleAction(tap(ENGINEER, 'pr_actions', 'merge', PR_READY));
    expect(out).toEqual({ kind: 'denied', action: 'merge', reason: 'linked-identity-required' });
    expect(prCalls).toEqual([]);
    expect(web.calls.ephemeral[0]?.text).toMatch(/Link your GitHub account/);
    expect(web.calls.update).toEqual([]);
  });

  it('a merge at level 3 by a human is refused: the agent merges', async () => {
    await seedPrOpen(3);
    linked.add(ENGINEER);
    const out = await ix.handleAction(tap(ENGINEER, 'pr_actions', 'merge', PR_READY));
    expect(out).toEqual({ kind: 'denied', action: 'merge', reason: 'agent-merges' });
    expect(prCalls).toEqual([]);
  });

  it('a linked human merges, reverts, and an engineer requests changes through PrActions, on the PR and commit each button carried (#264)', async () => {
    await seedPrOpen(2);
    linked.add(ENGINEER);
    expect(await ix.handleAction(tap(ENGINEER, 'pr_actions', 'merge', PR_READY))).toEqual({ kind: 'pr-action', action: 'merge', incidentId: INC });
    expect(await ix.handleAction(tap(ENGINEER, 'pr_actions', 'request_changes', PR_READY))).toMatchObject({ kind: 'pr-action', action: 'request_changes' });
    const revertButton = [{ actionId: 'revert', label: 'Revert', value: `${INC}:77:${MERGE_COMMIT}` }];
    expect(await ix.handleAction(tap(ENGINEER, 'status_actions', 'revert', revertButton))).toMatchObject({ kind: 'pr-action', action: 'revert' });
    const input = { incidentId: INC, actor: { id: ENGINEER, role: 'engineer' }, prNumber: 77, sha: HEAD, repo: 'github.com/acme/web' };
    expect(prCalls).toEqual([
      { action: 'merge', input },
      { action: 'request_changes', input },
      { action: 'revert', input: { ...input, sha: MERGE_COMMIT } },
    ]);
    expect(web.calls.update.map((u) => u.text)).toEqual([`<@${ENGINEER}> merged this.`, `<@${ENGINEER}> requested changes.`, `<@${ENGINEER}> reverted this.`]);
  });

  it("a button without the PR and commit its card showed never borrows the incident's current PR (#264)", async () => {
    await seedPrOpen(2);
    linked.add(ENGINEER);
    await ix.handleAction(tap(ENGINEER, 'pr_actions', 'merge', [{ actionId: 'merge', label: 'Merge' }]));
    // The PR actions get no PR and no commit, and refuse the tap as out of date.
    expect(prCalls).toEqual([{ action: 'merge', input: { incidentId: INC, actor: { id: ENGINEER, role: 'engineer' }, repo: 'github.com/acme/web' } }]);
  });

  it('a reporter cannot request changes, even when linked', async () => {
    await seedPrOpen(2);
    linked.add(REPORTER);
    expect(await ix.handleAction(tap(REPORTER, 'pr_actions', 'request_changes', PR_READY))).toEqual({
      kind: 'denied',
      action: 'request_changes',
      reason: 'engineer-required',
    });
    expect(prCalls).toEqual([]);
  });
});

// Stop --------------------------------------------------------------------------------------------

describe('stop and dismiss at levels 2 and 3 (main 8.2, 10.4)', () => {
  it('Stop at level 3 calls stopIncident: stopped is appended and the run cancelled', async () => {
    await seedFixing(3);
    const out = await ix.handleAction(tap(REPORTER, 'triage_actions', 'stop', TRIAGE_L2));
    expect(out).toEqual({ kind: 'stopped', incidentId: INC, outcome: { stopped: true, cancelledRun: RUN } });
    const stopped = await lastOf('stopped');
    expect(stopped?.actor).toEqual({ id: REPORTER, role: 'reporter' });
    expect(stopped?.source).toBe('slack');
    expect(cancelled).toEqual([RUN]);
    expect(taps).toEqual([]);
    expect(web.calls.update[0]?.text).toBe(`<@${REPORTER}> stopped this.`);
  });

  it('Stop on the PR card closes the open PR', async () => {
    await seedPrOpen(2);
    const out = await ix.handleAction(tap(ENGINEER, 'pr_actions', 'stop', PR_READY));
    expect(out).toMatchObject({ kind: 'stopped', outcome: { stopped: true, closedPr: 77 } });
    expect(closedPrs).toEqual([77]);
  });

  it('Not a bug at level 2 is a Stop plus a Won\'t Do close through the outbox', async () => {
    await seedFixing(2);
    const out = await ix.handleAction(tap(REPORTER, 'triage_actions', 'dismiss', TRIAGE_L2));
    expect(out).toEqual({ kind: 'stopped', incidentId: INC, outcome: { stopped: true, cancelledRun: RUN }, wontDo: true });
    expect((await types()).slice(-2)).toEqual(['stopped', 'not-a-bug']);
    const notABug = await lastOf('not-a-bug');
    expect(notABug?.actor).toEqual({ id: REPORTER, role: 'reporter' });
    expect((await state.getIncident(INC))?.status).toBe('not-a-bug');
    const rows = await state.drainOutbox('jira', 100);
    const transitions = rows.filter((r) => r.op === 'transition').map((r) => r.payload);
    expect(transitions).toContainEqual({ issueKey: 'WEB-1042', to: 'done', resolution: JIRA_RESOLUTION_WONT_DO });
    expect(taps).toEqual([]);
    expect(web.calls.update[0]?.text).toBe(`<@${REPORTER}> marked this *Not a bug*.`);
  });

  it('Not a bug takes an engineer or the reporter, at every level and on the claim card (#272)', async () => {
    await seedFixing(2);
    const out = await ix.handleAction(tap('U0STRANGER', 'triage_actions', 'dismiss', TRIAGE_L2));
    expect(out).toEqual({ kind: 'denied', action: 'dismiss', reason: 'engineer-required' });
    expect(web.calls.ephemeral.at(-1)?.text).toBe(NOT_A_BUG_REFUSED);
    expect(await types()).not.toContain('stopped');
    expect(await ix.handleAction(tap(ENGINEER, 'triage_actions', 'dismiss', TRIAGE_L2))).toMatchObject({ kind: 'stopped', wontDo: true });
  });

  it('Not a bug at level 1 and on the claim card is refused to someone else, before it reaches the engine (#272)', async () => {
    await seedPlanned(1);
    expect(await ix.handleAction(tap('U0STRANGER', 'triage_actions', 'dismiss', TRIAGE_L1))).toMatchObject({ kind: 'denied', reason: 'engineer-required' });
    const claim = [{ actionId: 'let-agent-take', label: 'Let the agent take it' }, { actionId: 'dismiss', label: 'Not a bug' }];
    expect(await ix.handleAction(tap('U0STRANGER', 'claim_actions', 'dismiss', claim))).toMatchObject({ kind: 'denied', reason: 'engineer-required' });
    expect(taps).toEqual([]);
    expect(await ix.handleAction(tap(REPORTER, 'claim_actions', 'dismiss', claim))).toMatchObject({ kind: 'tapped', card: 'claimed', choice: 'dismiss' });
  });

  it('a second Not a bug after the first appends nothing more', async () => {
    await seedFixing(3);
    await ix.handleAction(tap(REPORTER, 'triage_actions', 'dismiss', TRIAGE_L2));
    const before = await types();
    const out = await ix.handleAction(tap(REPORTER, 'triage_actions', 'dismiss', TRIAGE_L2));
    expect(out).toMatchObject({ kind: 'stopped', outcome: { stopped: false, reason: 'terminal' } });
    expect(await types()).toEqual(before);
  });

  it('Stop at level 1 with nothing running is refused', async () => {
    await seedPlanned(1);
    const out = await ix.handleAction(tap(ENGINEER, 'status_actions', 'stop', [{ actionId: 'stop', label: 'Stop' }]));
    expect(out).toEqual({ kind: 'denied', action: 'stop', reason: 'nothing-to-stop' });
    expect(await types()).not.toContain('stopped');
    expect(web.calls.ephemeral[0]?.text).toBe('Nothing is running for this incident yet.');
  });
});

// Reaction removal --------------------------------------------------------------------------------

describe('reaction_removed within 60 s is a Stop for that trigger (main 15.1)', () => {
  it('the reporter removing the trigger emoji 30 s after the trigger stops the incident', async () => {
    await seedFixing(3);
    const out = await ix.handleEvent(reactionRemoved(REPORTER, 'bug', T0 + 30_000));
    expect(out).toEqual({ kind: 'stopped', incidentId: INC, outcome: { stopped: true, cancelledRun: RUN } });
    expect((await lastOf('stopped'))?.payload).toEqual({ reason: 'trigger reaction removed' });
  });

  it('a skin tone variant matches, and so does another recorded reactor', async () => {
    await seedFixing(3);
    const out = await ix.handleEvent(reactionRemoved(OTHER_ENGINEER, 'bug::skin-tone-3', T0 + 59_000));
    expect(out).toMatchObject({ kind: 'stopped', outcome: { stopped: true } });
  });

  it('a removal after 60 s is ignored', async () => {
    await seedFixing(3);
    const out = await ix.handleEvent(reactionRemoved(REPORTER, 'bug', T0 + 61_000));
    expect(out).toEqual({ kind: 'ignored', reason: 'no-trigger-in-window' });
    expect(await types()).not.toContain('stopped');
    expect(cancelled).toEqual([]);
  });

  it('another emoji, another person, or the bot does not stop it', async () => {
    await seedFixing(3);
    expect(await ix.handleEvent(reactionRemoved(REPORTER, 'fire', T0 + 10_000))).toEqual({ kind: 'ignored', reason: 'no-trigger-in-window' });
    expect(await ix.handleEvent(reactionRemoved(ENGINEER, 'bug', T0 + 10_000))).toEqual({ kind: 'ignored', reason: 'not-a-trigger-reactor' });
    expect(await ix.handleEvent(reactionRemoved('U0BOT', 'bug', T0 + 10_000))).toEqual({ kind: 'ignored', reason: 'own-reaction' });
    expect(await types()).not.toContain('stopped');
  });

  it('reaches onEvent through the transport when the adapter is wrapped', async () => {
    await seedFixing(3);
    const seen: Promise<unknown>[] = [];
    const adapter: SlackAdapter = createSlackAdapter({
      web: {} as SlackWeb,
      signingSecret: 'signing-secret-test',
      botUserId: 'U0BOT',
      getMap: () => Promise.resolve(map),
    });
    const wrapped = observeReactionRemoval(adapter, { onEvent: (body) => {
      const p = ix.handleEvent(body);
      seen.push(p);
      return p;
    } });
    const dispatcher = createSlackDispatcher({ adapter: wrapped, handleInbound: () => Promise.reject(new Error('not an incident')), onAction: (p) => ix.onAction(p) });
    const res = await dispatcher.dispatch({ transport: 'socket', payload: reactionRemoved(REPORTER, 'bug', T0 + 5_000) });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(await seen[0]).toMatchObject({ kind: 'stopped', incidentId: INC });
  });
});

// Transport ---------------------------------------------------------------------------------------

describe('through the transport', () => {
  it('a block_actions payload is answered at once and handled by onAction', async () => {
    await seedPlanned(1);
    const dispatcher = createSlackDispatcher({
      adapter: createSlackAdapter({ web: {} as SlackWeb, signingSecret: 'signing-secret-test', botUserId: 'U0BOT', getMap: () => Promise.resolve(map) }),
      handleInbound: () => Promise.reject(new Error('not an incident')),
      onAction: (p) => ix.onAction(p),
    });
    const res = await dispatcher.dispatch({ transport: 'socket', payload: tap(ENGINEER, 'scope_actions', 'looks-right', [{ actionId: 'looks-right', label: 'Looks right' }]) });
    expect(res.status).toBe(200);
    await dispatcher.idle();
    expect(taps).toHaveLength(1);
  });

  it('ignores other interactivity, link buttons, and unknown blocks', async () => {
    expect(await ix.handleAction({ type: 'view_submission', user: { id: REPORTER } })).toEqual({ kind: 'ignored', reason: 'not-block-actions' });
    expect(await ix.handleAction(tap(ENGINEER, 'pr_actions', 'open_pr', [{ actionId: 'open_pr', label: 'Open PR' }]))).toEqual({ kind: 'ignored', reason: 'link-button' });
    expect(await ix.handleAction(tap(ENGINEER, 'other_actions', 'looks-right', [{ actionId: 'looks-right', label: 'Looks right' }]))).toEqual({ kind: 'ignored', reason: 'unknown-block' });
    expect(taps).toEqual([]);
  });
});
