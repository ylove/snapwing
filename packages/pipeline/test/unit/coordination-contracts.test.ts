// #313 (B 5, B 6.1 to 6.3): the coordination contracts the coordinator builds on. The six parent
// events pass the recorded-event validator and fold through the store, the `coordinate` job has its
// data guard and singleton key, the parent's lifecycle rows move it as B 6.3 says, and a single-repo
// incident's transitions are exactly what they were before those rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  isEventType,
  type EventPayloads,
  type EventType,
  type IncidentEvent,
  type NewEvent,
} from '../../src/contracts/events.ts';
import type { MergeGateResult } from '../../src/contracts/incident.ts';
import { JOB_NAMES, coordinateKey, isCoordinateData, type CoordinateData, type Job } from '../../src/contracts/jobs.ts';
import { seedRecordings, statusTrace, validateRecordedEvent, type Recording } from '../../src/demo/state.ts';
import { LIFECYCLE_STATUSES, isValidTransition, nextStatus, type LifecycleStatus } from '../../src/lifecycle/machine.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { rebuild, snapshotProjections } from '../../src/state/rebuild.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const COORDINATION = ['work-items-opened', 'fanout', 'child-progressed', 'contract-revised', 'fanin', 'merge-walk'] as const satisfies readonly EventType[];

const WS = '01K00000000000000000000001';
const PARENT = '01K0000000000000000000P313';
const WI1 = '01K0000000000000000000W001';
const WI2 = '01K0000000000000000000W002';
const CONTRACT = { artifactId: '01K0000000000000000000A313', version: 1 };
const HEAD1 = '1111111111111111111111111111111111111111';
const HEAD2 = '2222222222222222222222222222222222222222';
const MERGE1 = '3333333333333333333333333333333333333333';
const MERGE2 = '4444444444444444444444444444444444444444';

const OPENED: EventPayloads['work-items-opened'] = {
  workItems: [
    { workItemId: WI1, key: 'wi-1', repo: 'github.com/fake-org/shared-ui', surfaceId: 'shared-ui', dependsOn: [], produces: ['c-price-format-v2'], consumes: [] },
    { workItemId: WI2, key: 'wi-2', repo: 'github.com/fake-org/web', surfaceId: 'web', dependsOn: ['wi-1'], produces: [], consumes: ['c-price-format-v2'] },
  ],
  contracts: [{ id: 'c-price-format-v2', artifact: CONTRACT }],
  mergeOrder: ['wi-1', 'wi-2'],
  allOrNothing: true,
};

const GATE: MergeGateResult = {
  reviewVerdict: 'approve',
  ciGreen: true,
  riskGate: { passed: true, filesTouched: 5, diffLines: 80, forbiddenHits: [] },
  stopped: false,
  levelAtMergeTime: 3,
  decision: 'merge',
};

const MERGEABLE_SET: EventPayloads['fanin']['workItems'] = [
  { workItemId: WI1, key: 'wi-1', status: 'mergeable', prNumber: 212, headSha: HEAD1 },
  { workItemId: WI2, key: 'wi-2', status: 'mergeable', prNumber: 418, headSha: HEAD2 },
];

const progressed = (
  workItemId: string,
  key: string,
  event: EventType,
  workItemSeq: number,
  status: LifecycleStatus,
  extra: Partial<EventPayloads['child-progressed']> = {},
): EventPayloads['child-progressed'] => ({ workItemId, key, event, workItemSeq, status, ...extra });

const fanin = (decision: EventPayloads['fanin']['decision']): EventPayloads['fanin'] =>
  decision === 'degrade'
    ? {
        decision,
        workItems: [
          { workItemId: WI1, key: 'wi-1', status: 'escalated', reason: 'fixer failed: tests red' },
          { workItemId: WI2, key: 'wi-2', status: 'filed' },
        ],
        reason: 'wi-1 failed and the set is all or nothing',
        level: 2,
      }
    : { decision, workItems: MERGEABLE_SET, reason: decision === 'merge' ? 'every gate passed at level 3' : 'level 2: a person merges the set', level: decision === 'merge' ? 3 : 2, ...(decision === 'merge' ? { gate: GATE } : {}) };

const walk = (outcome: EventPayloads['merge-walk']['outcome']): EventPayloads['merge-walk'] => {
  switch (outcome) {
    case 'merged':
      return { workItemId: WI1, key: 'wi-1', outcome, prNumber: 212, mergeCommitSha: MERGE1 };
    case 'ci-green':
      return { workItemId: WI2, key: 'wi-2', outcome, prNumber: 418, headSha: HEAD2 };
    case 'ci-red':
      return { workItemId: WI2, key: 'wi-2', outcome, prNumber: 418, headSha: HEAD2, failingChecks: ['unit'], revertPrNumbers: [213] };
    case 'reverted':
      return { workItemId: WI1, key: 'wi-1', outcome, prNumber: 212, revertPrNumber: 213, reason: 'web CI red against the merged shared-ui' };
  }
};

type Coordination = (typeof COORDINATION)[number];
type Variant = { [K in Coordination]: readonly [label: string, type: K, payload: EventPayloads[K]] }[Coordination];

/** Every variant of every coordination payload, labelled. */
const VARIANTS: readonly Variant[] = [
  ['work-items-opened', 'work-items-opened', OPENED],
  ['work-items-opened with no contract', 'work-items-opened', { ...OPENED, contracts: [], allOrNothing: false }],
  ['fanout', 'fanout', { started: [WI1] }],
  ['fanout of two', 'fanout', { started: [WI1, WI2] }],
  ['child-progressed filed', 'child-progressed', progressed(WI1, 'wi-1', 'filed', 6, 'filed', { jiraKey: 'DEMO-314' })],
  ['child-progressed pr-opened', 'child-progressed', progressed(WI1, 'wi-1', 'pr-opened', 9, 'in-review', { prNumber: 212 })],
  ['child-progressed review-failed', 'child-progressed', progressed(WI2, 'wi-2', 'review-failed', 11, 'fixing-retry', { prNumber: 418, reason: 'missing test' })],
  ['child-progressed fixer-failed', 'child-progressed', progressed(WI1, 'wi-1', 'fixer-failed', 8, 'escalated', { reason: 'tests red' })],
  ['contract-revised', 'contract-revised', { contractId: 'c-price-format-v2', workItemId: WI1, key: 'wi-1', workItemSeq: 8, artifact: { ...CONTRACT, version: 2 } }],
  ['fanin merge', 'fanin', fanin('merge')],
  ['fanin human', 'fanin', fanin('human')],
  ['fanin degrade', 'fanin', fanin('degrade')],
  ['merge-walk merged', 'merge-walk', walk('merged')],
  ['merge-walk ci-green', 'merge-walk', walk('ci-green')],
  ['merge-walk ci-red', 'merge-walk', walk('ci-red')],
  ['merge-walk reverted', 'merge-walk', walk('reverted')],
];

let minute = 0;

/** A recorded event on `incidentId`, one minute after the previous one. */
function recorded<T extends EventType>(type: T, payload: EventPayloads[T], incidentId = PARENT): NewEvent<T> {
  minute += 1;
  const e = {
    workspaceId: WS,
    incidentId,
    v: 1,
    source: 'agent',
    occurredAt: new Date(Date.UTC(2026, 9, 12, 12, minute)).toISOString(),
    type,
    payload,
  };
  return e as NewEvent<T>;
}

/** The problems the validator finds in a recorded event of `type` carrying `payload` as written. */
function problems(type: EventType, payload: Record<string, unknown>): string {
  return validateRecordedEvent({ ...recorded('fanout', { started: [] }), type, payload }).join('; ');
}

/** Only `type` and the payload matter to the reducer; the rest is filler. */
function ev<T extends EventType>(type: T, payload?: EventPayloads[T]): IncidentEvent {
  return {
    workspaceId: WS,
    incidentId: PARENT,
    seq: 1,
    v: 1,
    source: 'agent',
    occurredAt: '2026-10-12T12:00:00.000Z',
    recordedAt: '2026-10-12T12:00:00.000Z',
    type,
    payload: payload ?? {},
  } as unknown as IncidentEvent;
}

describe('coordination events (B 6.1 to 6.3)', () => {
  it('are in the event catalog', () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining([...COORDINATION]));
    for (const t of COORDINATION) expect(isEventType(t)).toBe(true);
  });

  it('has a variant here for every coordination type and every decision and walk outcome', () => {
    expect(new Set(VARIANTS.map(([, type]) => type))).toEqual(new Set(COORDINATION));
    const decisions = VARIANTS.flatMap(([, type, p]) => (type === 'fanin' ? [(p as EventPayloads['fanin']).decision] : []));
    const outcomes = VARIANTS.flatMap(([, type, p]) => (type === 'merge-walk' ? [(p as EventPayloads['merge-walk']).outcome] : []));
    expect(decisions.sort()).toEqual(['degrade', 'human', 'merge']);
    expect(outcomes.sort()).toEqual(['ci-green', 'ci-red', 'merged', 'reverted']);
  });

  it.each(VARIANTS.map(([label, type, payload]) => [label, recorded(type, payload)] as const))(
    '%s passes the recorded-event validator',
    (_label, event) => {
      expect(validateRecordedEvent(JSON.parse(JSON.stringify(event)))).toEqual([]);
    },
  );

  it('rejects a fanin decision, a walk outcome, or a mirrored status or event outside its set', () => {
    expect(problems('fanin', { ...fanin('merge'), decision: 'partial' })).toContain('decision must be one of merge, human, degrade');
    expect(problems('merge-walk', { ...walk('merged'), outcome: 'skipped' })).toContain('outcome must be one of merged, ci-green, ci-red, reverted');
    expect(problems('child-progressed', { ...progressed(WI1, 'wi-1', 'pr-opened', 9, 'in-review'), status: 'pr-open' })).toContain('status must be one of');
    expect(problems('child-progressed', { ...progressed(WI1, 'wi-1', 'pr-opened', 9, 'in-review'), event: 'pr-merged' })).toContain('event must be one of');
  });

  it('rejects a payload missing a required key, with a wrong kind, or with an unknown key', () => {
    expect(problems('fanout', {})).toContain('fanout payload is missing started');
    expect(problems('work-items-opened', { ...OPENED, allOrNothing: 'yes' })).toContain('allOrNothing must be a boolean');
    expect(problems('contract-revised', { contractId: 'c-price-format-v2', workItemId: WI1, key: 'wi-1', workItemSeq: 8 })).toContain('missing artifact');
    expect(problems('merge-walk', { ...walk('merged'), prNumber: '212' })).toContain('prNumber must be a number');
    expect(problems('fanin', { ...fanin('human'), level: undefined })).toContain('missing level');
    expect(problems('child-progressed', { ...progressed(WI1, 'wi-1', 'filed', 6, 'filed'), parentId: PARENT })).toContain('unknown key parentId');
  });
});

describe('the coordinate job (B 6.3)', () => {
  it('is a job name', () => {
    expect(JOB_NAMES).toContain('coordinate');
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });

  it('is keyed coordinate:{parentId}', () => {
    expect(coordinateKey(PARENT)).toBe(`coordinate:${PARENT}`);
    expect(coordinateKey('eu:parent')).toBe('coordinate:eu%3Aparent');
    expect(() => coordinateKey('')).toThrow();
  });

  it('carries the parent id only, and its guard says so', () => {
    const job: Job<CoordinateData> = { id: '01K0000000000000000000J313', name: 'coordinate', data: { parentId: PARENT }, attempt: 1, singletonKey: coordinateKey(PARENT) };
    expect(isCoordinateData(job.data)).toBe(true);
    for (const bad of [undefined, null, 'x', [], {}, { parentId: '' }, { parentId: 7 }, { incidentId: PARENT }]) {
      expect(isCoordinateData(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

type Row = [from: LifecycleStatus, event: IncidentEvent, to: LifecycleStatus];

const fanout = ev('fanout', { started: [WI1] });

const PARENT_ROWS: Row[] = [
  // B 6.3 step 1: the first fan-out starts the fix; later ones keep it going
  ['filed', fanout, 'fixing'],
  ['stopped', fanout, 'fixing'],
  ['fixing', fanout, 'fixing'],
  // B 6.3 step 3: one gate for the set
  ['fixing', ev('fanin', fanin('merge')), 'mergeable'],
  ['fixing', ev('fanin', fanin('human')), 'mergeable'],
  ['fixing', ev('fanin', fanin('degrade')), 'escalated'],
  ['mergeable', ev('fanin', fanin('human')), 'mergeable'],
  ['mergeable', ev('fanin', fanin('degrade')), 'escalated'],
  // B 6.3 step 4: the walk keeps the status until a red CI escalates
  ['mergeable', ev('merge-walk', walk('merged')), 'mergeable'],
  ['mergeable', ev('merge-walk', walk('ci-green')), 'mergeable'],
  ['mergeable', ev('merge-walk', walk('reverted')), 'mergeable'],
  ['mergeable', ev('merge-walk', walk('ci-red')), 'escalated'],
  ['held', ev('merge-walk', walk('merged')), 'held'],
  ['held', ev('merge-walk', walk('ci-green')), 'held'],
  ['held', ev('merge-walk', walk('ci-red')), 'escalated'],
  ['escalated', ev('merge-walk', walk('reverted')), 'escalated'],
  // The parent's own `merged` after the last walk step uses the existing rows
  ['mergeable', ev('merged', { prNumber: 418, mergeCommitSha: MERGE2, levelAtMergeTime: 3 }), 'merged'],
  ['held', ev('merged', { prNumber: 418, mergeCommitSha: MERGE2, levelAtMergeTime: 2 }), 'merged'],
];

const PARENT_INVALID: Row[] = [
  ['captured', fanout, 'captured'],
  ['planned', fanout, 'planned'],
  ['in-review', fanout, 'in-review'],
  ['mergeable', fanout, 'mergeable'],
  ['closed', fanout, 'closed'],
  ['filed', ev('fanin', fanin('merge')), 'filed'],
  ['in-review', ev('fanin', fanin('merge')), 'in-review'],
  ['escalated', ev('fanin', fanin('merge')), 'escalated'],
  ['fixing', ev('merge-walk', walk('merged')), 'fixing'],
  ['merged', ev('merge-walk', walk('merged')), 'merged'],
  ['closed', ev('merge-walk', walk('reverted')), 'closed'],
];

describe('parent lifecycle rows (B 5, B 6.3)', () => {
  it.each(PARENT_ROWS.map((r, i) => [i, r[0], r[1].type, r[2], r] as const))('row %i: %s + %s -> %s', (_i, from, _type, to, row) => {
    expect(isValidTransition(from, row[1])).toBe(true);
    expect(nextStatus(from, row[1])).toBe(to);
  });

  it.each(PARENT_INVALID.map((r, i) => [i, r[0], r[1].type, r] as const))('invalid %i: %s + %s keeps the status and is not valid', (_i, from, _type, row) => {
    expect(isValidTransition(from, row[1])).toBe(false);
    expect(nextStatus(from, row[1])).toBe(from);
  });

  it.each([
    ['work-items-opened', ev('work-items-opened', OPENED)],
    ['child-progressed', ev('child-progressed', progressed(WI1, 'wi-1', 'ci-green', 12, 'mergeable', { prNumber: 212 }))],
    ['contract-revised', ev('contract-revised', { contractId: 'c-price-format-v2', workItemId: WI1, key: 'wi-1', workItemSeq: 8, artifact: { ...CONTRACT, version: 2 } })],
  ] as const)('%s is valid and keeps the status in every status', (_type, event) => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(isValidTransition(status, event), status).toBe(true);
      expect(nextStatus(status, event), status).toBe(status);
    }
  });
});

// A single-repo incident's log never holds a coordination event. The tables below are the machine as
// it stood before the parent rows, generated from it: for each status, every event its row accepts
// with the status it leads to; the events in KEEPS_EVERYWHERE are valid and keep the status everywhere.
// Any other single-repo event is invalid where its status has no entry for it.

const KEEPS_EVERYWHERE: readonly EventType[] = [
  'clarified', 'escalated', 'held', 'comment', 'level-changed', 'tapped', 'scope-changed', 'dedupe-decided',
  'clarify-answered', 'corrected', 'status-message-posted', 'waiting-changed', 'monitoring-started',
  'monitoring-stopped', 'jira-priority-changed', 'jira-assignee-changed', 'fixer-checkpoint', 'fixer-artifact',
  'bot-message-posted', 'escalation-ladder', 'text-signal',
];

const SINGLE_REPO: Readonly<Record<LifecycleStatus, Readonly<Partial<Record<EventType, LifecycleStatus>>>>> = {
  captured: { captured: 'captured', 'context-assembled': 'assembling', stopped: 'stopped', 'resolution-signal': 'not-filed', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'captured' },
  assembling: { resolved: 'resolved', stopped: 'stopped', 'resolution-signal': 'not-filed', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'assembling' },
  resolved: { 'dedupe-checked': 'deduped', stopped: 'stopped', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'resolved' },
  deduped: { resolved: 'deduped', planned: 'planned', stopped: 'stopped', 'linked-to-existing': 'linked-to-existing', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'deduped', 'user-side': 'not-filed', 'capture-cancelled': 'not-filed' },
  planned: { filed: 'filed', stopped: 'stopped', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'planned' },
  filed: { claimed: 'claimed', 'fixer-started': 'fixing', 'pr-opened': 'in-review', closed: 'closed', stopped: 'stopped', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'filed' },
  claimed: { 'pr-opened': 'in-review', closed: 'closed', stopped: 'stopped', released: 'fixing', 'not-a-bug': 'not-a-bug', 'let-agent-take': 'fixing', 'jira-transitioned': 'human-fixing' },
  'human-fixing': { 'pr-opened': 'in-review', closed: 'closed', stopped: 'stopped', released: 'fixing', 'let-agent-take': 'fixing', 'jira-transitioned': 'human-fixing' },
  fixing: { 'fixer-started': 'fixing', 'pr-opened': 'in-review', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'fixing', 'fixer-done': 'fixing', 'fixer-failed': 'escalated' },
  'fixing-retry': { 'fixer-started': 'fixing-retry', 'pr-opened': 'in-review-retry', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'fixing-retry', 'fixer-done': 'fixing-retry', 'fixer-failed': 'escalated' },
  'in-review': { 'review-passed': 'ci', 'review-failed': 'fixing-retry', merged: 'merged', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'in-review' },
  'in-review-retry': { 'review-passed': 'ci-retry', 'review-failed': 'escalated', merged: 'merged', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'in-review-retry' },
  ci: { 'review-passed': 'ci', 'review-failed': 'fixing-retry', 'ci-green': 'mergeable', 'ci-red': 'fixing-retry', merged: 'merged', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'ci' },
  'ci-retry': { 'review-passed': 'ci-retry', 'review-failed': 'escalated', 'ci-green': 'mergeable', 'ci-red': 'escalated', merged: 'merged', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'ci-retry' },
  mergeable: { 'review-passed': 'ci-retry', 'review-failed': 'fixing-retry', merged: 'merged', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'mergeable' },
  held: { 'review-passed': 'held', 'review-failed': 'fixing-retry', merged: 'merged', closed: 'closed', stopped: 'stopped', released: 'mergeable', 'jira-transitioned': 'held' },
  merged: { 'deployed:staging': 'deployed:staging', closed: 'closed', stopped: 'stopped', reverted: 'reverted', 'jira-transitioned': 'merged' },
  'deployed:staging': { 'fixer-started': 'fixing', verified: 'deployed:staging', 'deployed:production': 'deployed:production', closed: 'closed', stopped: 'stopped', reverted: 'reverted', 'jira-transitioned': 'deployed:staging' },
  'deployed:production': { closed: 'closed', stopped: 'stopped', reverted: 'reverted', 'jira-transitioned': 'deployed:production' },
  reverted: { closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'reverted' },
  stopped: { filed: 'filed', claimed: 'claimed', 'fixer-started': 'fixing', 'pr-opened': 'in-review', closed: 'closed', stopped: 'stopped', 'not-a-bug': 'not-a-bug', 'jira-transitioned': 'stopped' },
  escalated: { claimed: 'claimed', 'fixer-started': 'fixing', 'pr-opened': 'in-review', merged: 'merged', closed: 'closed', stopped: 'stopped', 'jira-transitioned': 'escalated' },
  closed: { 'jira-transitioned': 'closed' },
  'not-filed': { 'jira-transitioned': 'not-filed' },
  'not-a-bug': { 'jira-transitioned': 'not-a-bug' },
  'linked-to-existing': { 'jira-transitioned': 'linked-to-existing' },
};

const SINGLE_REPO_EVENTS: readonly EventType[] = [
  ...new Set<EventType>([...KEEPS_EVERYWHERE, ...Object.values(SINGLE_REPO).flatMap((row) => Object.keys(row) as EventType[])]),
];

describe('a single-repo incident (and a work item) runs on the rows it had', () => {
  it('names every event it can hold, and no coordination event', () => {
    for (const t of SINGLE_REPO_EVENTS) expect(isEventType(t), t).toBe(true);
    expect(SINGLE_REPO_EVENTS.filter((t) => (COORDINATION as readonly string[]).includes(t))).toEqual([]);
    expect(Object.keys(SINGLE_REPO).sort()).toEqual([...LIFECYCLE_STATUSES].sort());
  });

  it('has every transition it had, and no other', () => {
    const actual: Partial<Record<LifecycleStatus, Partial<Record<EventType, LifecycleStatus>>>> = {};
    for (const status of LIFECYCLE_STATUSES) {
      const row: Partial<Record<EventType, LifecycleStatus>> = {};
      for (const type of SINGLE_REPO_EVENTS) {
        const event = ev(type);
        if (KEEPS_EVERYWHERE.includes(type)) {
          expect(isValidTransition(status, event), `${status} + ${type}`).toBe(true);
          expect(nextStatus(status, event), `${status} + ${type}`).toBe(status);
        } else if (isValidTransition(status, event)) {
          row[type] = nextStatus(status, event);
        } else {
          expect(nextStatus(status, event), `${status} + ${type}`).toBe(status);
        }
      }
      actual[status] = row;
    }
    expect(actual).toEqual(SINGLE_REPO);
  });

  it('still parks a mergeable PR on a gate hold and leaves an environment hold alone', () => {
    expect(nextStatus('mergeable', ev('held', { kind: 'gate', reason: 'risk gate' }))).toBe('held');
    expect(nextStatus('mergeable', ev('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-12T14:00:00.000Z' }))).toBe('mergeable');
  });
});

// Whole parent logs through the store: they validate, fold to the status the rows give, and rebuild
// to the same projections.

const PARENT_DONE = PARENT;
const PARENT_RED = '01K0000000000000000000R313';
const PARENT_DEGRADED = '01K0000000000000000000D313';

function intake(incidentId: string, jiraKey: string, level: 0 | 1 | 2 | 3): NewEvent[] {
  return [
    recorded(
      'captured',
      {
        kind: 'incident',
        idempotencyKey: `slack:C-FAKE-WEB:${incidentId}`,
        source: 'slack',
        reporter: { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' },
        anchorText: 'Cart prices show NaN after the price format change',
        anchorId: '1790000400.000100',
        channelId: 'C-FAKE-WEB',
      },
      incidentId,
    ),
    recorded('context-assembled', { bundle: { artifactId: '01K0000000000000000000B313', version: 1 }, includedCount: 4, excludedCount: 0 }, incidentId),
    recorded('resolved', { surfaceId: 'web', repo: 'github.com/fake-org/web', resolvedBy: 'vocabulary', confidence: 0.9 }, incidentId),
    recorded('dedupe-checked', { candidates: [], decision: 'none' }, incidentId),
    recorded(
      'planned',
      { action: 'create_issue', projectKey: 'DEMO', issueType: 'Bug', summary: 'Cart prices show NaN', priority: 'High', labels: ['snapwing'], autonomyLevel: level },
      incidentId,
    ),
    recorded('filed', { jiraKey }, incidentId),
    recorded('work-items-opened', OPENED, incidentId),
    recorded('child-progressed', progressed(WI1, 'wi-1', 'filed', 6, 'filed', { jiraKey: `${jiraKey}-1` }), incidentId),
    recorded('child-progressed', progressed(WI2, 'wi-2', 'filed', 6, 'filed', { jiraKey: `${jiraKey}-2` }), incidentId),
  ];
}

function bothMergeable(incidentId: string): NewEvent[] {
  return [
    recorded('fanout', { started: [WI1] }, incidentId),
    recorded('child-progressed', progressed(WI1, 'wi-1', 'fixer-started', 7, 'fixing'), incidentId),
    recorded('contract-revised', { contractId: 'c-price-format-v2', workItemId: WI1, key: 'wi-1', workItemSeq: 8, artifact: { ...CONTRACT, version: 2 } }, incidentId),
    recorded('child-progressed', progressed(WI1, 'wi-1', 'pr-opened', 10, 'in-review', { prNumber: 212 }), incidentId),
    recorded('fanout', { started: [WI2] }, incidentId),
    recorded('child-progressed', progressed(WI2, 'wi-2', 'fixer-started', 7, 'fixing'), incidentId),
    recorded('child-progressed', progressed(WI1, 'wi-1', 'review-passed', 11, 'ci', { prNumber: 212 }), incidentId),
    recorded('child-progressed', progressed(WI1, 'wi-1', 'ci-green', 12, 'mergeable', { prNumber: 212 }), incidentId),
    recorded('child-progressed', progressed(WI2, 'wi-2', 'pr-opened', 9, 'in-review', { prNumber: 418 }), incidentId),
    recorded('child-progressed', progressed(WI2, 'wi-2', 'review-passed', 10, 'ci', { prNumber: 418 }), incidentId),
    recorded('child-progressed', progressed(WI2, 'wi-2', 'ci-green', 11, 'mergeable', { prNumber: 418 }), incidentId),
    recorded('fanin', fanin('merge'), incidentId),
  ];
}

const RECORDINGS: Recording[] = [
  {
    file: 'parent-merged-and-closed',
    incidentId: PARENT_DONE,
    events: [
      ...intake(PARENT_DONE, 'DEMO-313', 3),
      ...bothMergeable(PARENT_DONE),
      recorded('merge-walk', walk('merged'), PARENT_DONE),
      recorded('child-progressed', progressed(WI1, 'wi-1', 'merged', 13, 'merged', { prNumber: 212 }), PARENT_DONE),
      recorded('merge-walk', walk('ci-green'), PARENT_DONE),
      recorded('merge-walk', { workItemId: WI2, key: 'wi-2', outcome: 'merged', prNumber: 418, mergeCommitSha: MERGE2 }, PARENT_DONE),
      recorded('child-progressed', progressed(WI2, 'wi-2', 'merged', 12, 'merged', { prNumber: 418 }), PARENT_DONE),
      recorded('merged', { prNumber: 418, mergeCommitSha: MERGE2, levelAtMergeTime: 3 }, PARENT_DONE),
      recorded('deployed:staging', { commitSha: MERGE2 }, PARENT_DONE),
      recorded('deployed:production', { commitSha: MERGE2 }, PARENT_DONE),
      recorded('closed', { reason: 'every work item closed' }, PARENT_DONE),
    ],
  },
  {
    file: 'parent-red-mid-walk',
    incidentId: PARENT_RED,
    events: [
      ...intake(PARENT_RED, 'DEMO-413', 3),
      ...bothMergeable(PARENT_RED),
      recorded('merge-walk', walk('merged'), PARENT_RED),
      recorded('merge-walk', walk('ci-red'), PARENT_RED),
      recorded('merge-walk', walk('reverted'), PARENT_RED),
      recorded('level-changed', { from: 3, to: 2, reason: 'web CI red against the merged shared-ui' }, PARENT_RED),
    ],
  },
  {
    file: 'parent-degraded',
    incidentId: PARENT_DEGRADED,
    events: [
      ...intake(PARENT_DEGRADED, 'DEMO-513', 3),
      recorded('fanout', { started: [WI1] }, PARENT_DEGRADED),
      recorded('child-progressed', progressed(WI1, 'wi-1', 'fixer-failed', 8, 'escalated', { reason: 'tests red' }), PARENT_DEGRADED),
      recorded('fanin', fanin('degrade'), PARENT_DEGRADED),
      recorded('level-changed', { from: 3, to: 2, reason: 'wi-1 failed and the set is all or nothing' }, PARENT_DEGRADED),
    ],
  },
];

const EXPECTED: Readonly<Record<string, { path: string; status: LifecycleStatus }>> = {
  'parent-merged-and-closed': {
    path: 'captured > assembling > resolved > deduped > planned > filed > fixing > mergeable > merged > deployed:staging > deployed:production > closed',
    status: 'closed',
  },
  'parent-red-mid-walk': { path: 'captured > assembling > resolved > deduped > planned > filed > fixing > mergeable > escalated', status: 'escalated' },
  'parent-degraded': { path: 'captured > assembling > resolved > deduped > planned > filed > fixing > escalated', status: 'escalated' },
};

describe('parent logs through the store', () => {
  let tdb: TestDatabase;
  let state: OpenedState;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    state = await tdb.open();
    await seedRecordings(state, RECORDINGS);
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('validates every event of every recording', () => {
    for (const r of RECORDINGS) {
      for (const e of r.events) expect(validateRecordedEvent(JSON.parse(JSON.stringify(e))), `${r.file} ${e.type}`).toEqual([]);
    }
  });

  it.each(RECORDINGS.map((r) => [r.file, r] as const))('%s folds to the status its rows give, every event fitting', async (file, r) => {
    const { path, invalid } = statusTrace(await state.read(r.incidentId));
    expect(invalid).toEqual([]);
    expect(path.join(' > ')).toBe(EXPECTED[file]!.path);
    const view = await state.getIncident(r.incidentId);
    expect(view?.status).toBe(EXPECTED[file]!.status);
    expect(view?.lastSeq).toBe(r.events.length);
  });

  it('rebuilds to the same projections', async () => {
    const before = await snapshotProjections(state);
    await rebuild(state, { all: true });
    expect(await snapshotProjections(state)).toBe(before);
  });
});
