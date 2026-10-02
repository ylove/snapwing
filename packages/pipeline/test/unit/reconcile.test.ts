// Reconciler (#139, B 8, B 10, B 11 "suppress the CI webhook"). Runs on the in-process workflow over
// the dialect `SNAPWING_DB` selects, with fake sources of truth standing in for GitHub and Jira. A
// "suppressed webhook" is an incident whose log never got the event the world says happened.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import {
  registerReconcileJob,
  runReconcile,
  type IssueStatus,
  type PrChecks,
  type PrRef,
  type PrState,
  type ReconcileDeps,
  type ReconcileSources,
  type ReconciledEventType,
} from '../../src/reconcile/job.ts';
import { readStoreMetrics } from '../../src/state/metrics.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6RECONINC00000000000001';
const INC2 = '01K6RECONINC00000000000002';
const PR = 418;
const HEAD = 'a'.repeat(40);
const MINUTE = 60_000;
const DANA = 'jira-account-fake-dana';

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

// Fakes -------------------------------------------------------------------------------------------

class FakeSources implements ReconcileSources {
  readonly calls: string[] = [];
  checks = new Map<number, PrChecks>();
  prs = new Map<number, PrState>();
  issues = new Map<string, IssueStatus | null>();
  /** Runs inside prChecks before it answers: a webhook landing while the reconciler asks. */
  duringChecks?: (pr: PrRef) => Promise<void>;
  failChecksFor = new Set<string>();

  async prChecks(pr: PrRef): Promise<PrChecks> {
    this.calls.push(`checks:${pr.incidentId}:${pr.prNumber}`);
    if (this.failChecksFor.has(pr.incidentId)) throw new Error('github unavailable');
    await this.duringChecks?.(pr);
    return this.checks.get(pr.prNumber) ?? { state: 'pending', headSha: HEAD };
  }

  prState(pr: PrRef): Promise<PrState> {
    this.calls.push(`pr:${pr.incidentId}:${pr.prNumber}`);
    return Promise.resolve(this.prs.get(pr.prNumber) ?? { state: 'open' });
  }

  issueStatus(key: string): Promise<IssueStatus | null> {
    this.calls.push(`issue:${key}`);
    return Promise.resolve(this.issues.has(key) ? (this.issues.get(key) ?? null) : { status: 'Backlog' });
  }
}

interface FollowUp {
  event: IncidentEvent<ReconciledEventType>;
  incident: IncidentView;
}

interface World {
  deps: ReconcileDeps;
  sources: FakeSources;
  followUps: FollowUp[];
}

function world(): World {
  const sources = new FakeSources();
  const followUps: FollowUp[] = [];
  const deps: ReconcileDeps = {
    state,
    workflow: wf,
    sources,
    followUp: (event, incident) => {
      followUps.push({ event, incident });
      return Promise.resolve();
    },
    clock: () => new Date(now),
  };
  return { deps, sources, followUps };
}

// Log builders ------------------------------------------------------------------------------------

function ev<T extends EventType>(incidentId: string, type: T, payload: EventPayloads[T], source: 'agent' | 'github' | 'jira' | 'fixer' = 'agent'): NewEvent<T> {
  return { workspaceId: WS, incidentId, type, v: 1, source, occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

function filed(incidentId: string, level: 0 | 1 | 2 | 3, key: string): NewEvent[] {
  return [
    ev(incidentId, 'captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${incidentId}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev(incidentId, 'context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev(incidentId, 'resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev(incidentId, 'dedupe-checked', { candidates: [], decision: 'none' }),
    ev(incidentId, 'planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: '01K6REQUEST0000000000000001', version: 1 },
    }),
    ev(incidentId, 'filed', { jiraKey: key }),
  ];
}

/** Filed at level 2, fixed, reviewed, and now in `ci`, waiting on CI for PR 418. */
function inCi(incidentId: string, key = 'WEB-1042', pr = PR): NewEvent[] {
  return [
    ...filed(incidentId, 2, key),
    ev(incidentId, 'fixer-started', { runId: `${incidentId}-run`, harness: 'claude-code', attempt: 1 }),
    ev(incidentId, 'pr-opened', { prNumber: pr, branch: `fix/${key}` }, 'fixer'),
    ev(incidentId, 'review-passed', { prNumber: pr }),
    ev(incidentId, 'waiting-changed', { waitingOn: { kind: 'ci', who: 'required checks' } }),
  ];
}

async function log(incidentId = INC): Promise<IncidentEvent[]> {
  return state.read(incidentId);
}

async function append(incidentId: string, ...events: NewEvent[]): Promise<void> {
  const last = (await log(incidentId)).at(-1)?.seq ?? 0;
  await state.append(incidentId, events, last);
}

async function ofType<T extends EventType>(type: T, incidentId = INC): Promise<IncidentEvent<T>[]> {
  return (await log(incidentId)).filter((e) => e.type === type) as unknown as IncidentEvent<T>[];
}

async function status(incidentId = INC): Promise<IncidentView['status'] | undefined> {
  return (await state.getIncident(incidentId))?.status;
}

async function advance(ms: number): Promise<void> {
  now += ms;
  await wf.drain();
}

// Tests ---------------------------------------------------------------------------------------------

describe('reconcile cron (B 8)', () => {
  it('a suppressed CI webhook yields ci-green once, after the wait passes 30 minutes; later runs are no-ops', async () => {
    const w = world();
    await registerReconcileJob(w.deps);
    await append(INC, ...inCi(INC));
    w.sources.checks.set(PR, { state: 'green', headSha: HEAD, completedAt: new Date(T0 + 5 * MINUTE).toISOString() });

    // 09:15 and 09:30: the wait is 15 and exactly 30 minutes old, not older. Nobody is asked.
    await advance(15 * MINUTE);
    await advance(15 * MINUTE);
    expect(w.sources.calls).toEqual([]);
    expect(await ofType('ci-green')).toHaveLength(0);

    // 09:45: stale. The reconciler asks and emits the event the webhook would have.
    await advance(15 * MINUTE);
    const green = await ofType('ci-green');
    expect(green).toHaveLength(1);
    expect(green[0]).toMatchObject({
      source: 'agent',
      occurredAt: new Date(T0 + 5 * MINUTE).toISOString(),
      payload: { prNumber: PR, headSha: HEAD, reconciled: true },
    });
    expect(green[0]?.actor).toBeUndefined();
    expect(await status()).toBe('mergeable');
    expect(w.followUps).toHaveLength(1);
    expect(w.followUps[0]?.event.type).toBe('ci-green');
    expect(w.followUps[0]?.event.seq).toBe(green[0]?.seq);
    expect(w.followUps[0]?.incident.status).toBe('mergeable');

    // 10:00 and 10:15: the status change cleared the wait; nothing more is emitted.
    await advance(15 * MINUTE);
    await advance(15 * MINUTE);
    expect(await ofType('ci-green')).toHaveLength(1);
    expect(w.followUps).toHaveLength(1);
  });

  it('leaves a fresh waiting_on alone, including a stale wait that was just renewed', async () => {
    const w = world();
    await append(INC, ...inCi(INC));
    w.sources.checks.set(PR, { state: 'green', headSha: HEAD });
    now = T0 + 25 * MINUTE;
    expect(await runReconcile(w.deps)).toEqual({ checked: [], emitted: [], failures: [] });

    now = T0 + 40 * MINUTE;
    await append(INC, ev(INC, 'waiting-changed', { waitingOn: { kind: 'ci', who: 'required checks' } }));
    now = T0 + 45 * MINUTE;
    expect(await runReconcile(w.deps)).toEqual({ checked: [], emitted: [], failures: [] });
    expect(w.sources.calls).toEqual([]);
    expect(await ofType('ci-green')).toHaveLength(0);
  });

  it('emits ci-red with the failing checks, and nothing while checks are pending', async () => {
    const w = world();
    await append(INC, ...inCi(INC));
    now = T0 + 31 * MINUTE;
    await runReconcile(w.deps);
    expect(w.sources.calls).toEqual([`checks:${INC}:${PR}`, `pr:${INC}:${PR}`, 'issue:WEB-1042']);
    expect(await ofType('ci-red')).toHaveLength(0);

    w.sources.checks.set(PR, { state: 'red', headSha: HEAD, failingChecks: ['unit', 'lint'] });
    const report = await runReconcile(w.deps);
    expect(report.emitted.map((e) => e.type)).toEqual(['ci-red']);
    expect((await ofType('ci-red'))[0]?.payload).toEqual({ prNumber: PR, headSha: HEAD, failingChecks: ['unit', 'lint'], reconciled: true });
    expect(await status()).toBe('fixing-retry');
  });

  it('never emits an event the log already has for that PR head, even one that lands mid-run', async () => {
    const w = world();
    await append(INC, ...inCi(INC));
    w.sources.checks.set(PR, { state: 'green', headSha: HEAD });
    // The webhook arrives while the reconciler is asking GitHub.
    w.sources.duringChecks = async () => {
      await append(INC, ev(INC, 'ci-green', { prNumber: PR, headSha: HEAD }, 'github'));
    };
    now = T0 + 31 * MINUTE;
    const report = await runReconcile(w.deps);
    expect(report.checked).toEqual([INC]);
    expect(report.emitted).toEqual([]);
    expect(await ofType('ci-green')).toHaveLength(1);
    expect((await ofType('ci-green'))[0]?.source).toBe('github');
    expect(w.followUps).toEqual([]);
  });

  it('emits a missed merge with the level in force, after any missed CI result', async () => {
    const w = world();
    await append(INC, ...inCi(INC));
    w.sources.checks.set(PR, { state: 'green', headSha: HEAD });
    w.sources.prs.set(PR, { state: 'merged', mergeCommitSha: 'b'.repeat(40), mergedAt: new Date(T0 + 20 * MINUTE).toISOString() });
    now = T0 + 31 * MINUTE;
    const report = await runReconcile(w.deps);
    expect(report.emitted.map((e) => e.type)).toEqual(['ci-green', 'merged']);
    expect((await ofType('merged'))[0]).toMatchObject({
      source: 'agent',
      occurredAt: new Date(T0 + 20 * MINUTE).toISOString(),
      payload: { prNumber: PR, mergeCommitSha: 'b'.repeat(40), levelAtMergeTime: 2, reconciled: true },
    });
    expect(await status()).toBe('merged');
    expect(w.followUps.map((f) => [f.event.type, f.incident.status])).toEqual([
      ['ci-green', 'merged'],
      ['merged', 'merged'],
    ]);

    // Merged incidents are not asked about their PR again, and the log already has both events.
    await append(INC, ev(INC, 'waiting-changed', { waitingOn: { kind: 'deploy', who: 'staging' } }));
    now = T0 + 70 * MINUTE;
    w.sources.calls.length = 0;
    expect((await runReconcile(w.deps)).emitted).toEqual([]);
    expect(w.sources.calls).toEqual(['issue:WEB-1042']);
  });

  it('emits a missed human Jira transition once, idempotent across runs', async () => {
    const w = world();
    await append(INC, ...filed(INC, 1, 'WEB-7'), ev(INC, 'waiting-changed', { waitingOn: { kind: 'human', who: 'U-FAKE-OWNER' } }));
    const at = new Date(T0 + 10 * MINUTE).toISOString();
    w.sources.issues.set('WEB-7', { status: 'In Progress', lastTransition: { from: 'Backlog', to: 'In Progress', at, byAgent: false, actorId: DANA } });

    now = T0 + 31 * MINUTE;
    const first = await runReconcile(w.deps);
    expect(first.emitted.map((e) => e.type)).toEqual(['jira-transitioned']);
    const moved = await ofType('jira-transitioned');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      source: 'agent',
      actor: { id: DANA, role: 'human' },
      occurredAt: at,
      payload: { jiraKey: 'WEB-7', from: 'Backlog', to: 'In Progress', reconciled: true },
    });
    expect(w.followUps.map((f) => f.event.type)).toEqual(['jira-transitioned']);

    // The transition does not change the lifecycle status, so the wait is still stale: the log answers.
    now = T0 + 46 * MINUTE;
    const second = await runReconcile(w.deps);
    expect(second.checked).toEqual([INC]);
    expect(second.emitted).toEqual([]);
    expect(await ofType('jira-transitioned')).toHaveLength(1);
    expect(w.followUps).toHaveLength(1);
  });

  it("ignores the agent's own transitions and transitions the webhook already delivered", async () => {
    const w = world();
    await append(INC, ...filed(INC, 1, 'WEB-7'), ev(INC, 'waiting-changed', { waitingOn: { kind: 'human' } }));
    await append(INC2, ...filed(INC2, 1, 'WEB-8'), ev(INC2, 'jira-transitioned', { jiraKey: 'WEB-8', from: 'Backlog', to: 'In Progress' }, 'jira'));
    await append(INC2, ev(INC2, 'waiting-changed', { waitingOn: { kind: 'human' } }));
    const at = new Date(T0).toISOString();
    w.sources.issues.set('WEB-7', { status: 'In Progress', lastTransition: { from: 'Backlog', to: 'In Progress', at, byAgent: true } });
    w.sources.issues.set('WEB-8', { status: 'In Progress', lastTransition: { from: 'Backlog', to: 'In Progress', at, byAgent: false, actorId: DANA } });
    now = T0 + 31 * MINUTE;
    const report = await runReconcile(w.deps);
    expect(report.checked).toEqual([INC, INC2]);
    expect(report.emitted).toEqual([]);
    expect(await ofType('jira-transitioned', INC)).toHaveLength(0);
    expect(await ofType('jira-transitioned', INC2)).toHaveLength(1);
  });

  it('a failing source skips only its incident; the job reports the failure', async () => {
    const w = world();
    await registerReconcileJob(w.deps);
    await append(INC, ...inCi(INC));
    await append(INC2, ...inCi(INC2, 'WEB-1043', 419));
    w.sources.checks.set(419, { state: 'green', headSha: HEAD });
    w.sources.failChecksFor.add(INC);
    now = T0 + 44 * MINUTE;
    await advance(MINUTE);
    expect(await ofType('ci-green', INC)).toHaveLength(0);
    expect(await ofType('ci-green', INC2)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect(String((errors[0] as AggregateError).message)).toContain(`${INC} (source)`);
    errors.length = 0;
  });
});

describe('reconciler corrections metric (B 10)', () => {
  it('counts reconciled events recorded in the last hour, not webhook ones', async () => {
    const w = world();
    await append(INC, ...inCi(INC));
    await append(INC2, ...inCi(INC2, 'WEB-1043', 419), ev(INC2, 'ci-green', { prNumber: 419, headSha: HEAD }, 'github'));
    expect((await readStoreMetrics(state)).reconcilerCorrectionsLastHour).toBe(0);

    w.sources.checks.set(PR, { state: 'green', headSha: HEAD });
    now = T0 + 31 * MINUTE;
    await runReconcile(w.deps);
    expect((await readStoreMetrics(state)).reconcilerCorrectionsLastHour).toBe(1);

    now = T0 + 92 * MINUTE;
    expect((await readStoreMetrics(state)).reconcilerCorrectionsLastHour).toBe(0);
  });
});
