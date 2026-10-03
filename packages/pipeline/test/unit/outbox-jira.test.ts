// #141: `outboxFor` as a registry, and the Jira rows B 7.2 asks for that the engine does not enqueue
// itself. The pure part folds a scripted log with `foldIncident` and asks the hook for each event's
// rows; the store part appends through the state port on the dialect SNAPWING_DB selects; the last
// part replays the `pnpm demo` level recordings and checks no row repeats one the engine enqueued.

import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { IncidentView, OutboxItem } from '../../src/contracts/state.ts';
import { runDemo, type DemoReport } from '../../src/demo/run.ts';
import { BUDGET_EXCEEDED, FIXER_FAILED_REASON_PREFIX } from '../../src/fixer/job.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { foldIncident } from '../../src/state/projections/incidents.ts';
import { outboxFor } from '../../src/state/projections/outbox.ts';
import { agentStatusLine, jiraFieldBatchKey } from '../../src/state/projections/outbox/jira.ts';
import { outboxRowId } from '../../src/state/projections/outbox/row.ts';
import { rebuild } from '../../src/state/rebuild.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ0000000000000000000001';
const INC = '01JZ00000000000000000000A1';
const KEY = 'WEB-1042';
const DANA: EventActor = { id: 'U-FAKE-DANA', role: 'engineer' };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// A scripted log, folded as the projector folds it --------------------------------------------------

type Draft<T extends EventType> = { type: T; payload: EventPayloads[T]; actor?: EventActor };

function draft<T extends EventType>(type: T, payload: EventPayloads[T], actor?: EventActor): Draft<T> {
  return { type, payload, ...(actor === undefined ? {} : { actor }) };
}

/** The captured-to-planned prefix at `level`; `filed` is left to the test. */
function prefix(level: 0 | 1 | 2 | 3 = 2, repo = 'fake-org/web'): Draft<EventType>[] {
  return [
    draft('captured', {
      kind: 'incident',
      idempotencyKey: `slack:T-FAKE:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    draft('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 2, excludedCount: 0 }),
    draft('resolved', { surfaceId: 'web', componentId: 'checkout', repo, resolvedBy: 'channel-explicit', confidence: 0.9 }),
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
  readonly events: IncidentEvent[] = [];

  /** Folds `d` as the next event and returns the Jira rows the hook gives for it (chat rows are #142's). */
  push<T extends EventType>(d: Draft<T>): OutboxItem[] {
    this.seq += 1;
    const at = new Date(Date.parse('2026-10-01T09:00:00.000Z') + this.seq * 60_000).toISOString();
    const event = {
      workspaceId: WS,
      incidentId: INC,
      seq: this.seq,
      v: 1,
      type: d.type,
      source: d.actor === undefined ? 'agent' : 'slack',
      ...(d.actor === undefined ? {} : { actor: d.actor }),
      occurredAt: at,
      recordedAt: at,
      payload: d.payload,
    } as unknown as IncidentEvent;
    this.events.push(event);
    const before = this.view;
    const fold = foldIncident(before, event);
    if (fold.view === undefined) throw new Error(`no row after ${d.type}`);
    this.view = fold.view;
    return outboxFor(event, { before, after: fold.view, valid: fold.valid }).filter((r) => r.target === 'jira');
  }

  all(drafts: readonly Draft<EventType>[]): OutboxItem[] {
    return drafts.flatMap((d) => this.push(d));
  }
}

/** Filed at `level`, with the rows for everything up to and including `filed`. */
function filed(level: 0 | 1 | 2 | 3 = 2): { s: Script; rows: OutboxItem[] } {
  const s = new Script();
  const rows = s.all([...prefix(level), draft('filed', { jiraKey: KEY })]);
  return { s, rows };
}

/** The parts of a row a test compares. */
function shape(r: OutboxItem): { op: string; payload: Record<string, unknown>; batchKey?: string } {
  return { op: r.op, payload: r.payload, ...(r.batchKey === undefined ? {} : { batchKey: r.batchKey }) };
}

const status = (line: string) => ({ op: 'update-fields', payload: { issueKey: KEY, customFields: { 'Agent Status': line } }, batchKey: `field:${INC}:agent-status` });
const transition = (to: string) => ({ op: 'transition', payload: { issueKey: KEY, to }, batchKey: `field:${INC}:status` });
const label = (name: string) => ({ op: 'add-labels', payload: { issueKey: KEY, labels: [name] } });
const comment = (text: string) => ({ op: 'add-comment', payload: { issueKey: KEY, text }, batchKey: `comment:${INC}` });
const level = (n: number) => ({ op: 'update-fields', payload: { issueKey: KEY, customFields: { 'Autonomy Level': n } }, batchKey: `field:${INC}:autonomy-level` });

/** captured through ci with PR #418 open, from `filed`. */
function toCi(s: Script): void {
  s.all([
    draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }),
    draft('pr-opened', { prNumber: 418, branch: 'snapwing/web-1042' }),
    draft('review-passed', { prNumber: 418 }),
  ]);
}

// Tests -------------------------------------------------------------------------------------------

describe('outboxFor: Jira rows (B 7.2)', () => {
  it('writes nothing before the issue exists, then the first Agent Status line on filed', () => {
    const { s, rows } = filed();
    expect(rows.map(shape)).toEqual([status('filed')]);
    const [row] = rows;
    expect(row).toMatchObject({ workspaceId: WS, incidentId: INC, target: 'jira', attempts: 0 });
    const filedEvent = s.events[s.events.length - 1];
    expect(row?.createdAt).toBe(filedEvent?.recordedAt);
    expect(row?.nextAttempt).toBe(filedEvent?.recordedAt);
    expect(row?.id).toMatch(ULID);
  });

  it('is deterministic: the same log gives the same rows, ids included, and ids sort in row order', () => {
    const run = (): OutboxItem[] => {
      const { s, rows } = filed();
      return [...rows, ...s.push(draft('stopped', { reason: 'wrong repo' }, DANA))];
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first).toHaveLength(4);
    expect(new Set(first.map((r) => r.id)).size).toBe(first.length);
    expect(first.map((r) => r.id)).toEqual([...first.map((r) => r.id)].sort());
  });

  it('updates Agent Status on every status change and on a new PR or wait, and not when the line is the same', () => {
    const { s } = filed();
    expect(s.push(draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 })).map(shape)).toEqual([status('fixing')]);
    expect(s.push(draft('fixer-checkpoint', { phase: 'cloned', detail: 'cloned fake-org/web' }))).toEqual([]);
    expect(s.push(draft('pr-opened', { prNumber: 418, branch: 'snapwing/web-1042' })).map(shape)).toEqual([status('in-review · PR #418')]);
    expect(s.push(draft('review-passed', { prNumber: 418 })).map(shape)).toEqual([status('ci · PR #418 · CI running')]);
    expect(s.push(draft('waiting-changed', { waitingOn: { kind: 'ci', who: 'build' } })).map(shape)).toEqual([status('ci · PR #418 · CI running · waiting on ci')]);
    expect(s.push(draft('waiting-changed', { waitingOn: { kind: 'ci', who: 'lint' } }))).toEqual([]);
    expect(s.push(draft('ci-green', { prNumber: 418, headSha: 'abc123' })).map(shape)).toEqual([status('mergeable · PR #418')]);
  });

  it('agentStatusLine is one line led by the status, so JQL can filter on it', () => {
    const { s } = filed();
    toCi(s);
    s.push(draft('waiting-changed', { waitingOn: { kind: 'ci' } }));
    const line = s.view === undefined ? '' : agentStatusLine(s.view);
    expect(line).toBe('ci · PR #418 · CI running · waiting on ci');
    expect(line).not.toMatch(/\n/);
  });

  it('labels human-claimed on claimed, and a misfit claim adds no label', () => {
    const { s } = filed();
    expect(s.push(draft('claimed', { claimerId: DANA.id, expiresAt: '2026-10-01T14:00:00Z' }, DANA)).map(shape)).toEqual([status('claimed'), label('human-claimed')]);
    s.push(draft('closed', {}));
    expect(s.push(draft('claimed', { claimerId: DANA.id, expiresAt: '2026-10-01T18:00:00Z' }, DANA))).toEqual([]);
  });

  it('labels needs-clarification on an ask-back after filing; before filing the create payload carries it', () => {
    const s = new Script();
    const ask = draft('clarified', { audience: 'reporter', question: 'Which page?', timedOut: false });
    const early = s.all([...prefix().slice(0, 4), ask, ...prefix().slice(4), draft('filed', { jiraKey: KEY })]);
    expect(early.map(shape)).toEqual([status('filed')]);
    expect(s.push({ ...ask, payload: { ...ask.payload, audience: 'engineer' } }).map(shape)).toEqual([label('needs-clarification')]);
  });

  it('labels prompt-failed when a filed issue is planned again without an implementation request', () => {
    const { s } = filed();
    const [, , , , planned] = prefix();
    if (planned?.type !== 'planned') throw new Error('prefix changed');
    const { implementationRequest: _dropped, ...rest } = planned.payload as EventPayloads['planned'];
    expect(s.push(draft('planned', rest)).map(shape)).toEqual([label('prompt-failed')]);
    expect(s.push(draft('planned', planned.payload as EventPayloads['planned']))).toEqual([]);
  });

  it('on fixer-failed: Agent Status, the fixer-failed label, and a degradation comment', () => {
    const { s } = filed();
    s.push(draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }));
    expect(s.push(draft('fixer-failed', { reason: 'tests kept failing.', attempts: 3 })).map(shape)).toEqual([
      status('escalated'),
      label('fixer-failed'),
      comment('The fixer gave up after 3 attempts: tests kept failing. A human takes it from here.'),
    ]);
  });

  it('a budget failure and the degrade fixer/job.ts records after it give one comment, not two', () => {
    const { s } = filed(3);
    s.push(draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }));
    expect(s.push(draft('fixer-failed', { reason: BUDGET_EXCEEDED, attempts: 1 })).map(shape)).toEqual([
      status('escalated'),
      label('fixer-failed'),
      comment('The fixer gave up after 1 attempt: it ran out of its time budget. A human takes it from here.'),
    ]);
    expect(s.push(draft('level-changed', { from: 3, to: 2, reason: `${FIXER_FAILED_REASON_PREFIX} ${BUDGET_EXCEEDED}` })).map(shape)).toEqual([level(2)]);
  });

  it('merged moves the issue to In Review below level 3 and to Done on autopilot; closed moves it to Done', () => {
    for (const [lvl, to] of [
      [2, 'in-review'],
      [3, 'done'],
    ] as const) {
      const { s } = filed(lvl);
      toCi(s);
      s.push(draft('ci-green', { prNumber: 418, headSha: 'abc123' }));
      const merge: ReturnType<typeof shape>[] = [transition(to), status('merged · PR #418')];
      if (lvl === 3) merge.push(comment('Merged PR #418 (https://github.com/fake-org/web/pull/418) on autopilot. Ticket done.'));
      expect(s.push(draft('merged', { prNumber: 418, mergeCommitSha: 'def456', levelAtMergeTime: lvl })).map(shape)).toEqual(merge);
      expect(s.push(draft('closed', {})).map(shape)).toEqual([transition('done'), status('closed · PR #418')]);
    }
  });

  it('links the PR as owner/name whether the map wrote owner/name or github.com/owner/name', () => {
    for (const repo of ['fake-org/web', 'github.com/fake-org/web', 'https://github.com/fake-org/web']) {
      const s = new Script();
      s.all([...prefix(3, repo), draft('filed', { jiraKey: KEY })]);
      toCi(s);
      s.push(draft('ci-green', { prNumber: 418, headSha: 'abc123' }));
      const rows = s.push(draft('merged', { prNumber: 418, mergeCommitSha: 'def456', levelAtMergeTime: 3 })).map(shape);
      expect(rows).toContainEqual(comment('Merged PR #418 (https://github.com/fake-org/web/pull/418) on autopilot. Ticket done.'));
    }
  });

  it('a merged or closed event that does not fit the status transitions nothing', () => {
    const { s } = filed();
    expect(s.push(draft('merged', { prNumber: 418, mergeCommitSha: 'def456', levelAtMergeTime: 3 }))).toEqual([]);
    s.push(draft('closed', {}));
    expect(s.push(draft('closed', {}))).toEqual([]);
  });

  it('reverted reopens the issue with a comment linking the revert PR', () => {
    for (const [lvl, to] of [
      [3, 'in-progress'],
      [2, 'in-progress'],
      [0, 'backlog'],
    ] as const) {
      const { s } = filed(lvl);
      toCi(s);
      s.push(draft('ci-green', { prNumber: 418, headSha: 'abc123' }));
      s.push(draft('merged', { prNumber: 418, mergeCommitSha: 'def456', levelAtMergeTime: lvl }));
      expect(s.push(draft('reverted', { prNumber: 418, revertPrNumber: 431, reason: 'broke checkout' })).map(shape)).toEqual([
        transition(to),
        status('reverted · PR #418'),
        comment('Revert PR #431 (https://github.com/fake-org/web/pull/431) of PR #418 reopens this ticket: broke checkout.'),
      ]);
    }
  });

  it('a revert without a revert PR number still reopens, and names no link', () => {
    const { s } = filed(2);
    toCi(s);
    s.push(draft('ci-green', { prNumber: 418, headSha: 'abc123' }));
    s.push(draft('merged', { prNumber: 418, mergeCommitSha: 'def456', levelAtMergeTime: 2 }));
    expect(s.push(draft('reverted', { prNumber: 418 })).map(shape)).toEqual([
      transition('in-progress'),
      status('reverted · PR #418'),
      comment('A revert of PR #418 reopens this ticket.'),
    ]);
    expect(s.push(draft('reverted', { prNumber: 418 }))).toEqual([]); // already reverted
  });

  it('names a stopper or a degrader by display name when the event carries one, else by user id', () => {
    const named: EventActor = { ...DANA, name: 'Dana Fake' };
    const a = filed().s;
    expect(a.push(draft('stopped', { reason: 'wrong repo' }, named)).map(shape)).toContainEqual(comment('Stopped by Dana Fake: wrong repo. Ticket back in the backlog.'));
    const b = filed(3).s;
    expect(b.push(draft('level-changed', { from: 3, to: 2, reason: 'a gate failed' }, named)).map(shape)).toContainEqual(
      comment('Autonomy level lowered by Dana Fake from 3 to 2: a gate failed.'),
    );
    const c = filed(3).s;
    expect(c.push(draft('level-changed', { from: 3, to: 2, reason: 'a gate failed' }, DANA)).map(shape)).toContainEqual(
      comment(`Autonomy level lowered by ${DANA.id} from 3 to 2: a gate failed.`),
    );
  });

  it('stopped moves the issue to Backlog with a comment naming who stopped it', () => {
    const { s } = filed();
    s.push(draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }));
    expect(s.push(draft('stopped', { reason: 'wrong repo' }, DANA)).map(shape)).toEqual([
      transition('backlog'),
      status('stopped'),
      comment(`Stopped by ${DANA.id}: wrong repo. Ticket back in the backlog.`),
    ]);
    expect(s.push(draft('stopped', {}))).toEqual([]); // already stopped: the status did not move
    expect(s.push(draft('fixer-started', { runId: 'run-2', harness: 'claude-code', attempt: 1 })).map(shape)).toEqual([status('fixing')]);
    expect(s.push(draft('stopped', {})).map(shape)).toEqual([transition('backlog'), status('stopped'), comment('Stopped. Ticket back in the backlog.')]);
  });

  it('writes Autonomy Level when the level changes after filing, with a comment when it went down', () => {
    const { s } = filed(3);
    expect(s.push(draft('level-changed', { from: 3, to: 2, reason: 'a gate failed' })).map(shape)).toEqual([level(2), comment('Autonomy level lowered from 3 to 2: a gate failed.')]);
    expect(s.push(draft('level-changed', { from: 2, to: 3, reason: 'owner raised it' })).map(shape)).toEqual([level(3)]);
    expect(s.push(draft('level-changed', { from: 3, to: 3, reason: 'no change' }))).toEqual([]);
  });

  it('comments when a merge is held at a gate, and not for an environment hold', () => {
    const { s } = filed();
    toCi(s);
    s.push(draft('ci-green', { prNumber: 418, headSha: 'abc123' }));
    expect(s.push(draft('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-01T14:00:00Z' }))).toEqual([]);
    expect(s.push(draft('held', { kind: 'gate', reason: 'diff over the size limit' })).map(shape)).toEqual([status('held · PR #418'), comment('Merge held at a gate: diff over the size limit.')]);
  });

  it('writes nothing to an issue the incident was only linked to', () => {
    const s = new Script();
    const rows = s.all([
      ...prefix().slice(0, 4),
      draft('dedupe-decided', { decision: 'link', issueKey: 'WEB-41' }, DANA),
      draft('linked-to-existing', { issueKey: 'WEB-41' }),
      draft('level-changed', { from: 2, to: 0, reason: 'linked' }),
      draft('comment', { intent: 'watch', platform: 'slack', signalSource: 'reaction', confidence: 1, raw: 'eyes' }, DANA),
    ]);
    expect(rows).toEqual([]);
  });

  it('never enqueues a create-issue or an In Progress transition, which the engine owns', () => {
    const { s, rows } = filed(3);
    toCi(s);
    const more = s.all([
      draft('claimed', { claimerId: DANA.id, expiresAt: '2026-10-01T14:00:00Z' }, DANA),
      draft('ci-green', { prNumber: 418, headSha: 'abc123' }),
      draft('merged', { prNumber: 418, mergeCommitSha: 'def456', levelAtMergeTime: 3 }),
      draft('closed', {}),
    ]);
    for (const r of [...rows, ...more]) {
      expect(r.op).not.toBe('create-issue');
      expect(r.op === 'transition' && r.payload['to'] === 'in-progress').toBe(false);
    }
  });

  it('keys each field write by its field, one field per row', () => {
    const { s, rows } = filed(3);
    const all = [...rows, ...s.push(draft('level-changed', { from: 3, to: 1, reason: 'claimed' }))];
    for (const r of all.filter((x) => x.op === 'update-fields')) {
      const fields = Object.keys(r.payload['customFields'] as Record<string, unknown>);
      expect(fields).toHaveLength(1);
      expect(r.batchKey).toBe(jiraFieldBatchKey(INC, fields[0] as 'Agent Status' | 'Autonomy Level'));
    }
  });

  it('outboxRowId is a ULID from recordedAt, and distinct per incident, seq, target, and index', () => {
    const { s } = filed();
    const [e] = s.events;
    if (e === undefined) throw new Error('no events');
    const id = outboxRowId(e, 'jira', 0);
    expect(id).toMatch(ULID);
    expect(id.slice(0, 10)).toBe(outboxRowId({ ...e, seq: 99 }, 'slack', 3).slice(0, 10));
    const ids = [outboxRowId(e, 'jira', 1), outboxRowId(e, 'slack', 0), outboxRowId({ ...e, seq: 2 }, 'jira', 0), outboxRowId({ ...e, incidentId: '01JZ00000000000000000000B1' }, 'jira', 0)];
    expect(new Set([id, ...ids]).size).toBe(5);
    expect(() => outboxRowId({ ...e, recordedAt: 'not a time' }, 'jira', 0)).toThrow(RangeError);
  });
});

// Through the state port --------------------------------------------------------------------------

describe(`outboxFor through append and rebuild (${TEST_DIALECT})`, () => {
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

  function events(drafts: readonly Draft<EventType>[]): NewEvent[] {
    return drafts.map(
      (d) =>
        ({
          workspaceId: WS,
          incidentId: INC,
          type: d.type,
          v: 1,
          source: d.actor === undefined ? 'agent' : 'slack',
          ...(d.actor === undefined ? {} : { actor: d.actor }),
          occurredAt: now.toISOString(),
          payload: d.payload,
        }) as unknown as NewEvent,
    );
  }

  it('an append enqueues the rows in its transaction; a rebuild enqueues nothing (#89)', async () => {
    await state.append(INC, events([...prefix(2), draft('filed', { jiraKey: KEY })]), 0);
    now = new Date('2026-10-01T12:05:00.000Z');
    await state.append(INC, events([draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }), draft('stopped', { reason: 'wrong repo' }, DANA)]), 6);
    const rows = await state.drainOutbox('jira', 50);
    expect(rows.map(shape)).toEqual([
      status('filed'),
      status('fixing'),
      transition('backlog'),
      status('stopped'),
      comment(`Stopped by ${DANA.id}: wrong repo. Ticket back in the backlog.`),
    ]);
    expect(rows.every((r) => ULID.test(r.id))).toBe(true);

    expect(await rebuild(state, { all: true })).toEqual({ incidents: 1, events: 8 });
    expect(await state.drainOutbox('jira', 50)).toEqual(rows);
  });
});

// The pnpm demo level recordings ------------------------------------------------------------------

describe('pnpm demo level recordings', () => {
  const DIR = fileURLToPath(new URL('../../../../demo/levels', import.meta.url));
  let report: DemoReport;
  let err = '';

  beforeAll(async () => {
    const lines: string[] = [];
    report = await runDemo({ env: { SNAPWING_DB: process.env['SNAPWING_DB'], DATABASE_URL: process.env['DATABASE_URL'] }, stdout: () => {}, stderr: (l) => lines.push(l) }, { dir: DIR });
    err = lines.join('\n');
  }, 120_000);

  it('replay with the lifecycle rows and no row duplicating one the engine enqueued', () => {
    expect(err).toBe('');
    expect(report.code).toBe(0);
    const levels = report.scenarios.filter((s) => s.level !== undefined && s.status === 'filed');
    expect(levels.map((s) => s.level)).toEqual([0, 1, 2, 3]);
    for (const s of levels) {
      const ops = s.outbox.map((r) => `${r.op}${r.to === undefined ? '' : ` ${r.to}`}`);
      expect(ops.filter((o) => o === 'create-issue'), s.name).toHaveLength(1);
      expect(ops.filter((o) => o.startsWith('transition')), s.name).toEqual(s.level === 0 ? [] : ['transition In Progress']);
      // Every other row is a field write the engine never makes, and no write repeats the one before it.
      const derived = s.outbox.filter((r) => r.op !== 'create-issue' && r.op !== 'transition');
      expect(derived.length, s.name).toBeGreaterThan(0);
      expect(derived.every((r) => r.op === 'update-fields' && r.field === 'Agent Status'), s.name).toBe(true);
      const values = derived.map((r) => r.value);
      expect(values.every((v, i) => i === 0 || v !== values[i - 1]), s.name).toBe(true);
    }
    const linked = report.scenarios.find((s) => s.status === 'linked-to-existing');
    expect(linked?.outbox.map((r) => r.op)).toEqual(['add-comment']);
  });
});
