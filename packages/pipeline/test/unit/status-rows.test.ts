// The status loopback (main 12, 20.1). The neutral copy; `statusFor` row by row over a scripted
// log folded as the projector folds it; the `update-status` rows `outboxFor` gives for chat incidents;
// the subscriber through the state port; and a replay of the level 2 recording asserting the sequence
// of status texts.

import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StatusUpdate } from '../../src/contracts/adapters.ts';
import type { EventActor, EventPayloads, EventSource, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload } from '../../src/contracts/incident.ts';
import type { IncidentView, OutboxItem } from '../../src/contracts/state.ts';
import { loadRecordings } from '../../src/demo/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { foldIncident } from '../../src/state/projections/incidents.ts';
import { outboxFor } from '../../src/state/projections/outbox.ts';
import { statusBatchKey, statusTargets, UPDATE_STATUS_OP } from '../../src/state/projections/outbox/status.ts';
import {
  EMOJI_VOCABULARY,
  emojiFor,
  makeStatusUpdate,
  mentionToken,
  reporterViolations,
  statusCopy,
  statusTextParts,
} from '../../src/status/copy.ts';
import { statusFor } from '../../src/status/loopback.ts';
import { createStatusSubscriber } from '../../src/status/subscriber.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ0000000000000000000001';
const INC = '01JZ00000000000000000000A1';
const KEY = 'WEB-1042';
const REPORTER = 'U-FAKE-REPORTER';
const DANA: EventActor = { id: 'U-FAKE-DANA', role: 'engineer' };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// A scripted log, folded as the projector folds it --------------------------------------------------

type Draft<T extends EventType> = { type: T; payload: EventPayloads[T]; actor?: EventActor; source?: EventSource };

function draft<T extends EventType>(type: T, payload: EventPayloads[T], actor?: EventActor, source?: EventSource): Draft<T> {
  return { type, payload, ...(actor === undefined ? {} : { actor }), ...(source === undefined ? {} : { source }) };
}

type Level = 0 | 1 | 2 | 3;

/** The captured-to-planned prefix at `level` from `source`, resolving `owner` when given; `filed` is left to the test. */
function prefix(level: Level, source: 'slack' | 'cli' = 'slack', owner?: string): Draft<EventType>[] {
  return [
    draft('captured', {
      kind: 'incident',
      idempotencyKey: `${source}:${INC}`,
      source,
      reporter: { id: REPORTER, name: 'Test Reporter', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    draft('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 2, excludedCount: 0 }),
    draft('resolved', {
      surfaceId: 'web',
      componentId: 'checkout',
      repo: 'fake-org/web',
      ...(owner === undefined ? {} : { ownerId: owner }),
      resolvedBy: 'channel-explicit',
      confidence: 0.9,
    }),
    draft('dedupe-checked', { candidates: [], decision: 'none' }),
    draft('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
    }),
  ];
}

class Script {
  view: IncidentView | undefined;
  seq = 0;

  /** Folds `d` as the next event and returns the chat rows the hook gives for it. */
  push<T extends EventType>(d: Draft<T>, holdClaimerId?: string): OutboxItem[] {
    this.seq += 1;
    const at = new Date(Date.parse('2026-10-01T09:00:00.000Z') + this.seq * 60_000).toISOString();
    const event = {
      workspaceId: WS,
      incidentId: INC,
      seq: this.seq,
      v: 1,
      type: d.type,
      source: d.source ?? (d.actor === undefined ? 'agent' : 'slack'),
      ...(d.actor === undefined ? {} : { actor: d.actor }),
      occurredAt: at,
      recordedAt: at,
      payload: d.payload,
    } as unknown as IncidentEvent;
    const before = this.view;
    const fold = foldIncident(before, event);
    if (fold.view === undefined) throw new Error(`no row after ${d.type}`);
    this.view = fold.view;
    return outboxFor(event, { before, after: fold.view, valid: fold.valid, ...(holdClaimerId === undefined ? {} : { holdClaimerId }) }).filter((r) => r.target !== 'jira');
  }

  /** The status update `d` sets, asserting it is at most one row. */
  status<T extends EventType>(d: Draft<T>): StatusUpdate | undefined {
    const rows = this.push(d);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0]?.payload['status'] as StatusUpdate | undefined;
  }

  all(drafts: readonly Draft<EventType>[]): OutboxItem[] {
    return drafts.flatMap((d) => this.push(d));
  }
}

/** Filed at `level`, with the resolved `owner` when given: returns the script and the status `filed` set. */
function filed(level: Level, source: 'slack' | 'cli' = 'slack', owner?: string): { s: Script; status: StatusUpdate | undefined } {
  const s = new Script();
  expect(s.all(prefix(level, source, owner))).toEqual([]);
  return { s, status: s.status(draft('filed', { jiraKey: KEY })) };
}

const started = (attempt = 1) => draft('fixer-started', { runId: `run-${String(attempt)}`, harness: 'claude-code', attempt });
const prOpened = () => draft('pr-opened', { prNumber: 418, branch: 'fix/WEB-1042' }, undefined, 'github');

/** `s` driven from filed at `level` (with the resolved `owner` when given) to a mergeable PR. */
function mergeable(level: Level = 2, owner?: string): Script {
  const { s } = filed(level, 'slack', owner);
  s.all([started(), prOpened(), draft('review-passed', { prNumber: 418 }), draft('ci-green', { prNumber: 418, headSha: 'abc' })]);
  return s;
}

// Copy --------------------------------------------------------------------------------------------

describe('neutral status copy', () => {
  it('writes mentions as tokens and keeps free text from forging one', () => {
    expect(statusCopy('filed', { issueKey: KEY, ownerUserId: 'webDev1' })).toBe(`Filed as ${KEY}, assigned to <@webDev1>.`);
    expect(statusCopy('stopped', { issueKey: KEY, actorName: 'Marcus <@U0ADMIN>' })).toBe('Stopped by Marcus @U0ADMIN. Ticket back in Backlog.');
    expect(statusCopy('stopped', { issueKey: KEY, actorUserId: 'U0MARCUS', actorName: 'Marcus' })).toBe('Stopped by <@U0MARCUS>. Ticket back in Backlog.');
    expect(statusCopy('stopped', { issueKey: KEY })).toBe('Stopped. Ticket back in Backlog.');
    expect(statusCopy('merged', { issueKey: KEY })).toBe('Merged. Rolling out to staging.');
    expect(statusCopy('filed', { issueKey: KEY, note: 'Nobody tapped Fix it within 24 hours, so this is filed as ticket only.' })).toBe(
      `Filed as ${KEY}. Nobody tapped Fix it within 24 hours, so this is filed as ticket only.`,
    );
    expect(statusCopy('failed', { issueKey: KEY, draft: false })).toBe("Couldn't produce a passing fix.");
    expect(mentionToken('U 1<x>')).toBe('<@U1x>');
  });

  it('splits a text into plain parts and mentions for each platform to render', () => {
    expect(statusTextParts('Fix is on staging. <@U0PAT>, can you check?')).toEqual([
      { kind: 'text', text: 'Fix is on staging. ' },
      { kind: 'mention', ref: 'U0PAT' },
      { kind: 'text', text: ', can you check?' },
    ]);
    expect(statusTextParts('<@a><@b>')).toEqual([
      { kind: 'mention', ref: 'a' },
      { kind: 'mention', ref: 'b' },
    ]);
    expect(statusTextParts('')).toEqual([]);
  });

  it('gives Stop while fixing and Revert after autopilot, and every stage an emoji from the vocabulary', () => {
    expect(makeStatusUpdate('fixing', { issueKey: KEY }).actions).toEqual(['stop']);
    expect(makeStatusUpdate('merged', { issueKey: KEY, automatic: true }).actions).toEqual(['revert']);
    expect(makeStatusUpdate('merged', { issueKey: KEY }).actions).toBeUndefined();
    expect(makeStatusUpdate('staging', { issueKey: KEY, reporterUserId: 'U0PAT' }).mentionUserId).toBe('U0PAT');
    for (const stage of ['filed', 'clarified', 'fixing', 'pr-open', 'review-passed', 'held', 'merged', 'stopped', 'failed', 'staging', 'production', 'reverted'] as const) {
      expect(EMOJI_VOCABULARY).toContain(emojiFor(stage));
    }
  });
});

// statusFor, row by row -------------------------------------------------------------------------------

describe('statusFor: one row of main 12 per event', () => {
  it('filed at levels 0 and 1 names the ticket; at 2 and 3 it says a fix is under way, with Stop', () => {
    for (const level of [0, 1] as const) {
      expect(filed(level).status, `level ${String(level)}`).toEqual({ issueKey: KEY, stage: 'filed', text: `Filed as ${KEY}.` });
    }
    for (const level of [2, 3] as const) {
      expect(filed(level).status, `level ${String(level)}`).toEqual({ issueKey: KEY, stage: 'fixing', text: `Filed as ${KEY}. Working on a fix now.`, actions: ['stop'] });
    }
  });

  it('a fixer start changes the message only when it did not already say a fix is under way', () => {
    expect(filed(2).s.status(started())).toBeUndefined();
    expect(filed(1).s.status(started())?.actions).toEqual(['stop']);
    const { s } = filed(2);
    s.all([started(), draft('stopped', {}, DANA)]);
    expect(s.status(started(2))).toEqual({ issueKey: KEY, stage: 'fixing', text: `Filed as ${KEY}. Working on a fix now.`, actions: ['stop'] });
  });

  it('PR opened asks the assignee for review; the retry PR changes nothing', () => {
    const { s } = filed(2);
    s.all([draft('jira-assignee-changed', { jiraKey: KEY, to: 'webDev1' }), started()]);
    expect(s.status(prOpened())).toEqual({ issueKey: KEY, stage: 'pr-open', text: 'A fix is up. Review requested from <@webDev1>.' });
    expect(s.status(draft('review-failed', { prNumber: 418, verdict: 'request-changes', reason: 'needs a test' }))).toBeUndefined();
    expect(s.status(started(2))).toBeUndefined();
    expect(s.status(prOpened())).toBeUndefined();
    expect(s.status(draft('review-passed', { prNumber: 418 }))?.text).toBe('Review passed, waiting on merge.');
  });

  it('review passed waits on merge; CI green changes nothing', () => {
    const { s } = filed(2);
    s.all([started(), prOpened()]);
    expect(s.status(draft('review-passed', { prNumber: 418 }))).toEqual({ issueKey: KEY, stage: 'review-passed', text: 'Review passed, waiting on merge.' });
    expect(s.status(draft('ci-green', { prNumber: 418, headSha: 'abc' }))).toBeUndefined();
  });

  it('merged by a human names them (a chat user is mentioned); autopilot offers Revert, naming the merge it undoes (#264)', () => {
    const merged = (levelAtMergeTime: Level) => ({ prNumber: 418, mergeCommitSha: 'def', levelAtMergeTime });
    expect(mergeable().status(draft('merged', merged(2), { id: 'dana-gh', role: 'human' }, 'github'))?.text).toBe('Merged by dana-gh. Rolling out to staging.');
    expect(mergeable().status(draft('merged', merged(2), DANA, 'slack'))?.text).toBe(`Merged by <@${DANA.id}>. Rolling out to staging.`);
    expect(mergeable().status(draft('merged', merged(2), undefined, 'github'))?.text).toBe('Merged. Rolling out to staging.');
    expect(mergeable(3).status(draft('merged', merged(3), undefined, 'github'))).toEqual({
      issueKey: KEY,
      stage: 'merged',
      text: 'Merged automatically (review: approve, CI: green).',
      actions: ['revert'],
      pin: { prNumber: 418, sha: 'def' },
    });
  });

  it('a gate hold asks for a human with a plain reason; an environment hold changes nothing', () => {
    const s = mergeable();
    s.push(draft('jira-assignee-changed', { jiraKey: KEY, to: 'webDev1' }));
    expect(s.status(draft('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-02T00:00:00.000Z' }))).toBeUndefined();
    expect(s.status(draft('held', { kind: 'gate', reason: 'risk gate (touched infra/terraform.tf)' }))).toEqual({
      issueKey: KEY,
      stage: 'held',
      text: 'Held for human review: a safety check. <@webDev1> requested.',
    });
    expect(mergeable().status(draft('held', { kind: 'gate', reason: 'risk gate (touched infrastructure).' }))?.text).toBe('Held for human review: risk gate (touched infrastructure).');
  });

  it('stopped names who stopped it; a second stop changes nothing', () => {
    const { s } = filed(2);
    s.push(started());
    expect(s.status(draft('stopped', { reason: 'wrong repo' }, DANA))).toEqual({ issueKey: KEY, stage: 'stopped', text: `Stopped by <@${DANA.id}>. Ticket back in Backlog.` });
    expect(s.status(draft('stopped', {}, DANA))).toBeUndefined();
  });

  it('fixer failed pings the assignee, and mentions the draft only when one was pushed', () => {
    const { s } = filed(2);
    s.all([draft('jira-assignee-changed', { jiraKey: KEY, to: 'webDev1' }), started()]);
    expect(s.status(draft('fixer-failed', { reason: 'tests never passed', partialBranch: 'fix/WEB-1042', attempts: 2 }, undefined, 'fixer'))).toEqual({
      issueKey: KEY,
      stage: 'failed',
      text: "Couldn't produce a passing fix. A draft with what it tried is saved. <@webDev1> pinged.",
    });
    const other = filed(2).s;
    other.push(started());
    expect(other.status(draft('fixer-failed', { reason: 'no idea', attempts: 1 }, undefined, 'fixer'))?.text).toBe("Couldn't produce a passing fix.");
  });

  it('staging asks the reporter to check; production closes; a revert reopens', () => {
    const s = mergeable();
    s.push(draft('merged', { prNumber: 418, mergeCommitSha: 'def', levelAtMergeTime: 2 }, undefined, 'github'));
    expect(s.status(draft('deployed:staging', { commitSha: 'def' }, undefined, 'deploy'))).toEqual({
      issueKey: KEY,
      stage: 'staging',
      text: `Fix is on staging. <@${REPORTER}>, can you check?`,
      mentionUserId: REPORTER,
    });
    expect(s.status(draft('verified', { env: 'staging' }, undefined, 'deploy'))).toBeUndefined();
    expect(s.status(draft('deployed:production', { commitSha: 'def' }, undefined, 'deploy'))).toEqual({ issueKey: KEY, stage: 'production', text: `Live. Closing ${KEY}.` });
    expect(s.status(draft('reverted', { prNumber: 418 }))).toEqual({ issueKey: KEY, stage: 'reverted', text: `Reverted. ${KEY} is open again.` });
    expect(s.status(draft('closed', {}))).toBeUndefined();
  });

  it('a clarification answered after filing moves ahead; before filing there is no message', () => {
    const before = new Script();
    before.all(prefix(0).slice(0, 4));
    expect(before.status(draft('clarified', { audience: 'reporter', question: 'Which page?', timedOut: false }))).toBeUndefined();
    expect(before.status(draft('clarify-answered', { questionSeq: 5, answer: 'Checkout' }, { id: REPORTER, role: 'reporter' }))).toBeUndefined();

    const { s } = filed(0);
    s.push(draft('clarified', { audience: 'reporter', question: 'Which browser?', timedOut: false }));
    expect(s.status(draft('clarify-answered', { questionSeq: 7, answer: 'Safari' }, { id: REPORTER, role: 'reporter' }))).toEqual({
      issueKey: KEY,
      stage: 'clarified',
      text: 'Thanks, that answered it. Moving ahead.',
    });
  });

  it('other events, and incidents linked to an existing issue, change nothing', () => {
    const { s } = filed(2);
    for (const d of [
      draft('status-message-posted', { messageId: '1790000000.000200' }),
      draft('waiting-changed', { waitingOn: { kind: 'ci' } }),
      draft('fixer-checkpoint', { phase: 'branched', detail: 'fix/WEB-1042' }, undefined, 'fixer'),
      draft('level-changed', { from: 2, to: 1, reason: 'owner lowered it' }),
      draft('jira-priority-changed', { jiraKey: KEY, to: 'Highest' }),
    ] as Draft<EventType>[]) {
      expect(s.status(d), d.type).toBeUndefined();
    }
    const linked = new Script();
    linked.all(prefix(2).slice(0, 4));
    expect(linked.push(draft('linked-to-existing', { issueKey: 'WEB-7' }))).toEqual([]);
    expect(statusFor({ type: 'filed' } as IncidentEvent, { ...(linked.view as IncidentView) })).toBeUndefined();
  });

  it('names the resolved owner before anyone is assigned in Jira', () => {
    expect(filed(0, 'slack', 'webDev1').status).toEqual({ issueKey: KEY, stage: 'filed', text: `Filed as ${KEY}, assigned to <@webDev1>.` });
    expect(filed(1, 'slack', 'webDev1').status?.text).toBe(`Filed as ${KEY}, assigned to <@webDev1>.`);

    const review = filed(2, 'slack', 'webDev1').s;
    review.push(started());
    expect(review.status(prOpened())?.text).toBe('A fix is up. Review requested from <@webDev1>.');

    expect(mergeable(2, 'webDev1').status(draft('held', { kind: 'gate', reason: 'risk gate (touched infrastructure)' }))).toEqual({
      issueKey: KEY,
      stage: 'held',
      text: 'Held for human review: risk gate (touched infrastructure). <@webDev1> requested.',
    });

    const failing = filed(2, 'slack', 'webDev1').s;
    failing.push(started());
    expect(failing.status(draft('fixer-failed', { reason: 'tests never passed', attempts: 2 }, undefined, 'fixer'))?.text).toBe(
      "Couldn't produce a passing fix. <@webDev1> pinged.",
    );
  });

  it('a human reassignment in Jira wins over the resolved owner; unassigning falls back to it (B 7.3)', () => {
    const jiraHuman: EventActor = { id: 'jira-account-pat', role: 'human' };
    const { s } = filed(0, 'slack', 'webDev1');
    s.all([draft('jira-assignee-changed', { jiraKey: KEY, to: 'dana' }, jiraHuman, 'jira'), started()]);
    expect(s.status(prOpened())?.text).toBe('A fix is up. Review requested from <@dana>.');

    const held = mergeable(2, 'webDev1');
    held.push(draft('jira-assignee-changed', { jiraKey: KEY, to: 'dana' }, jiraHuman, 'jira'));
    held.push(draft('jira-assignee-changed', { jiraKey: KEY, from: 'dana' }, jiraHuman, 'jira'));
    expect(held.status(draft('held', { kind: 'gate', reason: 'risk gate (touched infrastructure)' }))?.text).toBe(
      'Held for human review: risk gate (touched infrastructure). <@webDev1> requested.',
    );
  });

  it('a later resolution without an owner falls back to the assignee, then to no name', () => {
    const { s } = filed(0, 'slack', 'webDev1');
    s.all([draft('resolved', { surfaceId: 'web', resolvedBy: 'clarify', confidence: 0.9 }), started()]);
    expect(s.status(prOpened())?.text).toBe('A fix is up. Review requested.');

    const assigned = filed(0, 'slack', 'webDev1').s;
    assigned.all([draft('resolved', { surfaceId: 'web', resolvedBy: 'clarify', confidence: 0.9 }), draft('jira-assignee-changed', { jiraKey: KEY, to: 'dana' }), started()]);
    expect(assigned.status(prOpened())?.text).toBe('A fix is up. Review requested from <@dana>.');
  });

  it('every text it writes is safe for a reporter (20.1)', () => {
    const s = mergeable();
    const texts: string[] = [];
    const keep = (u: StatusUpdate | undefined) => {
      if (u !== undefined) texts.push(u.text);
    };
    keep(s.status(draft('held', { kind: 'gate', reason: 'PR touches CI config' })));
    keep(s.status(draft('released', { scope: 'hold', env: 'gate', reason: 'requested' })));
    keep(s.status(draft('merged', { prNumber: 418, mergeCommitSha: 'def', levelAtMergeTime: 2 }, { id: 'dana-gh', role: 'human' }, 'github')));
    keep(s.status(draft('deployed:staging', { commitSha: 'def' }, undefined, 'deploy')));
    keep(s.status(draft('deployed:production', { commitSha: 'def' }, undefined, 'deploy')));
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(reporterViolations(t), t).toEqual([]);
  });
});

// The rows --------------------------------------------------------------------------------------------

describe('update-status rows', () => {
  it('one row per chat target, op update-status, batch key status:{incident}, ids from the event', () => {
    const s = new Script();
    s.all(prefix(2));
    const rows = s.push(draft('filed', { jiraKey: KEY }));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ workspaceId: WS, target: 'slack', incidentId: INC, op: UPDATE_STATUS_OP, batchKey: `status:${INC}`, attempts: 0 });
    expect(row?.id).toMatch(ULID);
    expect(row?.createdAt).toBe(row?.nextAttempt);
    expect(statusBatchKey(INC)).toBe(`status:${INC}`);
  });

  it('a claim hold at filing makes the first post the ticket-only line, with no Stop, at every level', () => {
    for (const level of [0, 1, 2, 3] as const) {
      const s = new Script();
      s.all(prefix(level));
      const [row] = s.push(draft('filed', { jiraKey: KEY }), 'U-FAKE-DANA');
      const status = row?.payload['status'] as StatusUpdate;
      expect(status.stage, `level ${String(level)}`).toBe('filed');
      expect(status.text, `level ${String(level)}`).toBe(`Filed as ${KEY}. <@U-FAKE-DANA> is on it, so this is filed as ticket only.`);
      expect(status.actions, `level ${String(level)}`).toBeUndefined();
    }
  });

  it('an incident with no chat thread gets no rows, though statusFor still knows the text', () => {
    const { s, status } = filed(2, 'cli');
    expect(status).toBeUndefined();
    expect(statusTargets('cli')).toEqual([]);
    expect(statusTargets('raycast')).toEqual([]);
    expect(statusTargets('slack')).toEqual(['slack']);
    expect(statusFor({ type: 'filed', payload: { jiraKey: KEY } } as IncidentEvent, s.view as IncidentView)?.stage).toBe('fixing');
  });
});

// Through the state port --------------------------------------------------------------------------

describe(`status rows and the subscriber through the state port (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let state: OpenedState;
  let now = new Date('2026-10-01T12:00:00.000Z');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    state = await tdb.open({ now: () => now });
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('subscribing records the reporter in the thread and enqueues the note after the filed row; nothing posts', async () => {
    const level = 1;
    const events = [...prefix(level), draft('filed', { jiraKey: KEY })].map((d) => ({
      workspaceId: WS,
      incidentId: INC,
      type: d.type,
      v: 1,
      source: 'agent',
      occurredAt: now.toISOString(),
      payload: d.payload,
    })) as unknown as Parameters<OpenedState['append']>[1];
    const { seq } = await state.append(INC, events, 0);

    const payload: CanonicalIncidentPayload = {
      eventId: INC,
      idempotencyKey: `slack:${INC}`,
      source: 'slack',
      reporter: { id: REPORTER, name: 'Test Reporter', role: 'reporter' },
      anchorText: 'Checkout says 500',
      context: { channelId: 'C-FAKE', rawPayloadSnapshot: {} },
      timestamp: now.toISOString(),
    };
    const later = new Date(now.getTime() + 1000);
    now = later;
    const subscriber = createStatusSubscriber({ workspaceId: WS, clock: () => later });
    const note = 'Nobody tapped Fix it within 24 hours, so this is filed as ticket only.';
    const subscription = await subscriber.subscribe(payload, KEY, note);
    // As the engine's after-filed step writes it: the subscription's events and rows with its own, in one transaction.
    await state.transaction(async (tx) => {
      for (const row of subscription.outbox) await tx.enqueueOutbox(row);
      return tx.append(INC, [...subscription.events], seq);
    });

    expect(await state.getSubscriptions(INC)).toEqual([
      { workspaceId: WS, userId: REPORTER, scopeKind: 'incident', scopeId: INC, channel: 'thread', platform: 'slack', createdAt: later.toISOString() },
    ]);
    const rows = await state.drainOutbox('slack', 50);
    expect(rows.map((r) => (r.payload['status'] as StatusUpdate).text)).toEqual([`Filed as ${KEY}.`, `Filed as ${KEY}. ${note}`]);
    expect(new Set(rows.map((r) => r.batchKey))).toEqual(new Set([`status:${INC}`]));
    expect(rows.every((r) => r.op === UPDATE_STATUS_OP && ULID.test(r.id))).toBe(true);

    // Without a note, only the subscription; from a channel with no thread, nothing.
    expect((await subscriber.subscribe(payload, KEY)).outbox).toEqual([]);
    expect(await subscriber.subscribe({ ...payload, source: 'cli' }, KEY, note)).toEqual({ events: [], outbox: [] });
  });

  it("an engineer's claim before filing, at level 2: the first post drained is the ticket-only line, with no actions", async () => {
    const inc = '01JZ00000000000000000000A2';
    const at = now.toISOString();
    const events = [
      ...prefix(2).map((d) => ({ ...d, idempotencyKey: undefined })),
      draft('claimed', { claimerId: DANA.id, expiresAt: '2026-10-02T12:00:00.000Z' }, DANA, 'slack'),
      draft('filed', { jiraKey: 'WEB-1043' }),
    ].map((d) => ({
      workspaceId: WS,
      incidentId: inc,
      type: d.type,
      v: 1,
      source: d.source ?? 'agent',
      ...(d.actor === undefined ? {} : { actor: d.actor }),
      occurredAt: at,
      payload: d.type === 'captured' ? { ...d.payload, idempotencyKey: `slack:${inc}` } : d.payload,
    })) as unknown as Parameters<OpenedState['append']>[1];
    await state.append(inc, events, 0);

    const rows = (await state.drainOutbox('slack', 50)).filter((r) => r.incidentId === inc && r.op === UPDATE_STATUS_OP);
    expect(rows).toHaveLength(1);
    const status = rows[0]?.payload['status'] as StatusUpdate;
    expect(status.text).toBe(`Filed as WEB-1043. <@${DANA.id}> is on it, so this is filed as ticket only.`);
    expect(status.actions).toBeUndefined();
  });
});

// The level 2 recording ---------------------------------------------------------------------------

describe('replay of the level 2 recording', () => {
  it('sets the status message through filed, a fix, review, merge, and staging, in order', async () => {
    const dir = fileURLToPath(new URL('../../../../demo/state', import.meta.url));
    const recording = (await loadRecordings(dir)).find((r) => r.file.startsWith('03-level-2'));
    if (recording === undefined) throw new Error('no level 2 recording');
    let view: IncidentView | undefined;
    const updates: StatusUpdate[] = [];
    recording.events.forEach((e, i) => {
      const event = { ...e, seq: i + 1, recordedAt: e.occurredAt } as IncidentEvent;
      const before = view;
      const fold = foldIncident(before, event);
      view = fold.view;
      if (view === undefined) return;
      for (const row of outboxFor(event, { before, after: view, valid: fold.valid })) {
        if (row.target === 'slack') updates.push(row.payload['status'] as StatusUpdate);
      }
    });
    expect(updates.map((u) => [u.stage, u.text, u.actions ?? []])).toEqual([
      ['fixing', 'Filed as DEMO-3. Working on a fix now.', ['stop']],
      ['pr-open', 'A fix is up. Review requested from <@webDev1>.', []],
      ['review-passed', 'Review passed, waiting on merge.', []],
      ['merged', 'Merged. Rolling out to staging.', []],
      ['staging', 'Fix is on staging. <@U-FAKE-REPORTER>, can you check?', []],
    ]);
    for (const u of updates) expect(reporterViolations(u.text), u.text).toEqual([]);
  });
});
