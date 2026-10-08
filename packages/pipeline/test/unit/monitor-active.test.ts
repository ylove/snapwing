// Active monitoring for critical incidents (A 4.5, B 5 `heartbeat:{incident}` and
// `stall:{incident}`, B 8). Runs on the in-process workflow over the dialect `SNAPWING_DB` selects,
// with a fake clock, fake sources of truth (the reconciler's shape plus deploys), a fake chat side,
// and the real escalation ladders (monitor/ladder.ts) reading this module's `stalled` fact. The
// A 8 row "Stall: CI webhook suppressed in the fixture: heartbeat posts at 10 min, owner mentioned at
// 15 min" is the `A 8 stall row` scenario.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPlaybook, type Playbook, type PlaybookEscalation } from '../../src/config/playbook.ts';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { timerKey } from '../../src/contracts/jobs.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import {
  ciRuns,
  createActiveMonitor,
  heartbeatText,
  monitoringChange,
  pollKey,
  type ActiveMonitor,
  type DeployRef,
  type DeployState,
  type MonitorSources,
  type PolledEventType,
} from '../../src/monitor/active.ts';
import { createEscalationLadders, type EscalationPost } from '../../src/monitor/ladder.ts';
import type { Pager } from '../../src/monitor/pager.ts';
import { SecretNotFoundError, type SecretsPort } from '../../src/ports/secrets.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { Job, JobName, WaitKey, WorkflowPort } from '../../src/ports/workflow.ts';
import type { PrChecks, PrRef, PrState } from '../../src/reconcile/job.ts';
import { escalationState } from '../../src/signals/score.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-03T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6MONITORINC00000000000A';
const PR = 418;
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const MINUTE = 60_000;

/** The A 6.2 example `stalled-fix` ladder with its first step at the stall itself (A 8: owner at 15 min). */
const STALLED_FIX: PlaybookEscalation = {
  name: 'stalled-fix',
  steps: [
    { duration: 'PT0M', mention: 'owner' },
    { duration: 'PT30M', mention: '@U0ENGLEAD' },
  ],
  applyWhen: [{ monitored: true, stalled: true }],
};

const OUTAGE: PlaybookEscalation = {
  name: 'outage',
  steps: [{ duration: 'PT0M', mention: 'owner' }],
  applyWhen: [{ priority: 'Highest' }, { outage: true }],
};

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

class FakeSources implements MonitorSources {
  readonly calls: string[] = [];
  checks: PrChecks = { state: 'pending', headSha: HEAD };
  pr: PrState = { state: 'open' };
  deploys: DeployState[] = [];
  failChecks = false;

  prChecks(pr: PrRef): Promise<PrChecks> {
    this.calls.push(`checks:${String(pr.prNumber)}@${minutesOf(now)}`);
    return this.failChecks ? Promise.reject(new Error('github unavailable')) : Promise.resolve(this.checks);
  }

  prState(pr: PrRef): Promise<PrState> {
    this.calls.push(`pr:${String(pr.prNumber)}@${minutesOf(now)}`);
    return Promise.resolve(this.pr);
  }

  deployments(ref: DeployRef): Promise<DeployState[]> {
    this.calls.push(`deploy:${ref.mergeCommitSha.slice(0, 4)}@${minutesOf(now)}`);
    return Promise.resolve(this.deploys);
  }
}

class FakeChat {
  readonly posts: (EscalationPost & { at: number })[] = [];
  post(message: EscalationPost): Promise<void> {
    this.posts.push({ ...message, at: minutesOf(now) });
    return Promise.resolve();
  }
}

const pager: Pager = { trigger: () => Promise.resolve(), resolve: () => Promise.resolve() };
const secrets: SecretsPort = { get: (name) => Promise.reject(new SecretNotFoundError(name, 'the test')) };

/** Delegates to the real workflow and records the keys started, scheduled, and cancelled. */
class RecordingWorkflow implements WorkflowPort {
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  readonly scheduled: { key: string | undefined; at: number }[] = [];
  constructor(private readonly inner: WorkflowPort) {}
  start(name: JobName, input: unknown, opts: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean }): Promise<{ jobId: string }> {
    this.started.push(opts.singletonKey ?? name);
    return this.inner.start(name, input, opts);
  }
  schedule(name: JobName, input: unknown, runAt: Date, opts?: { singletonKey?: string }): Promise<{ jobId: string }> {
    this.scheduled.push({ key: opts?.singletonKey, at: minutesOf(runAt.getTime()) });
    return this.inner.schedule(name, input, runAt, opts);
  }
  cancel(singletonKey: string): Promise<void> {
    this.cancelled.push(singletonKey);
    return this.inner.cancel(singletonKey);
  }
  work(name: JobName, handler: (job: Job) => Promise<void>, opts?: { concurrency?: number }): void {
    this.inner.work(name, handler, opts);
  }
  park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void> {
    return this.inner.park(jobId, waitingOn, timeoutAt);
  }
  resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }> {
    return this.inner.resume(waitingOn, result);
  }
  cron(name: JobName, expression: string, input?: unknown): Promise<void> {
    return this.inner.cron(name, expression, input);
  }
}

interface World {
  monitor: ActiveMonitor;
  sources: FakeSources;
  chat: FakeChat;
  workflow: RecordingWorkflow;
  playbook: Playbook;
  followUps: { type: string; status: string }[];
  logs: string[];
}

function setup(opts: { critical?: string[]; escalations?: PlaybookEscalation[] } = {}): World {
  const sources = new FakeSources();
  const chat = new FakeChat();
  const workflow = new RecordingWorkflow(wf);
  const playbook = defaultPlaybook();
  playbook.monitor.critical = opts.critical ?? ['checkout'];
  playbook.escalations = opts.escalations ?? [STALLED_FIX];
  const followUps: World['followUps'] = [];
  const logs: string[] = [];
  const ladders = createEscalationLadders({
    workspaceId: WS,
    state,
    workflow,
    playbook: () => playbook,
    chat,
    pager,
    secrets,
    clock: () => new Date(now),
    outage: async (incident) => escalationState(await state.read(incident.id)).outage,
    stalled: (incident) => monitor.stalled(incident),
    log: (m) => logs.push(m),
  });
  const monitor = createActiveMonitor({
    workspaceId: WS,
    state,
    workflow,
    playbook: () => playbook,
    sources,
    chat,
    ladders,
    clock: () => new Date(now),
    followUp: (event: IncidentEvent<PolledEventType>, incident: IncidentView) => {
      followUps.push({ type: event.type, status: incident.status });
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
  });
  ladders.register();
  monitor.register();
  return { monitor, sources, chat, workflow, playbook, followUps, logs };
}

// Log builders ------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T], opts: { incidentId?: string; at?: number; source?: 'agent' | 'github' | 'jira' | 'fixer' } = {}): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: opts.incidentId ?? INC,
    type,
    v: 1,
    source: opts.source ?? 'agent',
    occurredAt: new Date(opts.at ?? now).toISOString(),
    payload,
  } as unknown as NewEvent<T>;
}

function filed(incidentId = INC, opts: { surface?: string; priority?: 'High' | 'Highest'; repo?: string; at?: number } = {}): NewEvent[] {
  const o = { incidentId, ...(opts.at === undefined ? {} : { at: opts.at }) };
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${incidentId}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
      anchorId: '1700000000.000100',
      threadId: '1700000000.000100',
    }, o),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }, o),
    ev('resolved', { surfaceId: opts.surface ?? 'checkout', componentId: 'checkout', repo: opts.repo ?? 'github.com/fake-org/web', ownerId: 'dana', resolvedBy: 'channel-explicit', confidence: 0.9 }, o),
    ev('dedupe-checked', { candidates: [], decision: 'none' }, o),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: opts.priority ?? 'High',
      labels: ['snapwing'],
      autonomyLevel: 3,
    }, o),
    ev('filed', { jiraKey: 'WEB-1042' }, o),
  ];
}

/** Fixed, reviewed, and waiting on CI for PR 418 since `at`. */
function toCi(incidentId = INC, at = now): NewEvent[] {
  return [
    ev('fixer-started', { runId: `${incidentId}-run`, harness: 'claude-code', attempt: 1 }, { incidentId, at }),
    ev('pr-opened', { prNumber: PR, branch: 'fix/WEB-1042' }, { incidentId, at, source: 'fixer' }),
    ev('review-passed', { prNumber: PR }, { incidentId, at }),
    ev('waiting-changed', { waitingOn: { kind: 'ci', who: 'required checks' } }, { incidentId, at }),
  ];
}

async function log(incidentId = INC): Promise<IncidentEvent[]> {
  return state.read(incidentId);
}

async function append(...events: NewEvent[]): Promise<void> {
  const incidentId = events[0]?.incidentId ?? INC;
  const last = (await log(incidentId)).at(-1)?.seq ?? 0;
  await state.append(incidentId, events, last);
}

async function types(incidentId = INC): Promise<string[]> {
  return (await log(incidentId)).map((e) => e.type);
}

async function ofType<T extends EventType>(type: T, incidentId = INC): Promise<IncidentEvent<T>[]> {
  return (await log(incidentId)).filter((e) => e.type === type) as unknown as IncidentEvent<T>[];
}

async function incident(incidentId = INC): Promise<IncidentView> {
  const v = await state.getIncident(incidentId);
  if (v === null) throw new Error('no incident');
  return v;
}

function minutesOf(ms: number): number {
  return Math.round(((ms - T0) / MINUTE) * 100) / 100;
}

/** Walks the fake clock minute by minute to `minutes` after T0, running every job due on the way. */
async function until(minutes: number): Promise<void> {
  while (now < T0 + minutes * MINUTE) {
    now = Math.min(now + MINUTE, T0 + minutes * MINUTE);
    await wf.drain();
  }
}

async function ladderSteps(): Promise<{ ladder: string; step: number; mentioned?: string }[]> {
  return (await log()).flatMap((e) =>
    e.type === 'escalation-ladder' && e.payload.phase === 'step' ? [{ ladder: e.payload.ladder, step: e.payload.step, ...(e.payload.mentioned === undefined ? {} : { mentioned: e.payload.mentioned }) }] : [],
  );
}

async function ladderPhases(): Promise<string[]> {
  return (await log()).flatMap((e) => (e.type === 'escalation-ladder' ? [`${e.payload.phase}:${e.payload.ladder}${e.payload.phase === 'stopped' ? `:${e.payload.reason}` : ''}`] : []));
}

/** Three earlier incidents in the same repo whose CI took 8, 9, and 10 minutes, and one elsewhere that took an hour. */
async function ciHistory(): Promise<void> {
  const past = T0 - 24 * 60 * MINUTE;
  for (const [i, minutes, repo] of [
    [1, 8, 'fake-org/web'],
    [2, 9, 'github.com/fake-org/web'],
    [3, 10, 'https://github.com/Fake-Org/web.git'],
    [4, 60, 'github.com/fake-org/api'],
  ] as const) {
    const id = `01K6MONITORHIST00000000000${String(i)}`;
    const start = past + i * 60 * MINUTE;
    await append(...filed(id, { surface: 'web', repo, at: start }), ...toCi(id, start), ev('ci-green', { prNumber: PR, headSha: HEAD }, { incidentId: id, at: start + minutes * MINUTE }));
  }
}

// Qualifying (pure) -------------------------------------------------------------------------------

describe('monitoringChange', () => {
  const at = (seq: number, type: EventType, payload: unknown): IncidentEvent =>
    ({ workspaceId: WS, incidentId: INC, seq, type, v: 1, source: 'agent', occurredAt: new Date(T0).toISOString(), recordedAt: new Date(T0).toISOString(), payload }) as unknown as IncidentEvent;
  const off = { monitored: false };

  it('qualifies at Highest, an outage score, or a critical surface, in that order', () => {
    const outage = [at(1, 'escalated', { intent: 'trigger', step: 3, action: 'post', score: 8, outage: true })];
    expect(monitoringChange({ ...off, priority: 'Highest', surfaceId: 'checkout' }, outage, ['checkout'])).toEqual({ started: 'priority' });
    expect(monitoringChange({ ...off, priority: 'High', surfaceId: 'checkout' }, outage, ['checkout'])).toEqual({ started: 'outage-score' });
    expect(monitoringChange({ ...off, priority: 'High', surfaceId: 'checkout' }, [], ['checkout'])).toEqual({ started: 'critical-surface' });
    expect(monitoringChange({ ...off, priority: 'highest' }, [], [])).toEqual({ started: 'priority' });
    expect(monitoringChange({ ...off, priority: 'High', surfaceId: 'web' }, [], ['checkout'])).toBeUndefined();
  });

  it('stops on a human downgrade after the run started, and not on one before it', () => {
    const started = [at(1, 'planned', { priority: 'Highest' }), at(2, 'monitoring-started', { qualifiedBy: 'priority' })];
    const downgraded = [...started, at(3, 'jira-priority-changed', { jiraKey: 'WEB-1', to: 'High' })];
    expect(monitoringChange({ monitored: true, priority: 'High', surfaceId: 'checkout' }, downgraded, ['checkout'])).toEqual({ stopped: 'downgraded' });
    // A custom priority off Highest is a downgrade too; a raise is not.
    const custom = [...started, at(3, 'jira-priority-changed', { jiraKey: 'WEB-1', from: 'Highest', to: 'P1 - Sev' })];
    expect(monitoringChange({ monitored: true, priority: 'P1 - Sev', surfaceId: 'checkout' }, custom, ['checkout'])).toEqual({ stopped: 'downgraded' });
    const before = [at(1, 'jira-priority-changed', { jiraKey: 'WEB-1', from: 'High', to: 'Low' }), at(2, 'monitoring-started', { qualifiedBy: 'critical-surface' })];
    expect(monitoringChange({ monitored: true, priority: 'Low', surfaceId: 'checkout' }, before, ['checkout'])).toBeUndefined();
  });

  it('stops as disqualified when nothing qualifies it any more', () => {
    const started = [at(1, 'monitoring-started', { qualifiedBy: 'critical-surface' })];
    expect(monitoringChange({ monitored: true, priority: 'High', surfaceId: 'checkout' }, started, [])).toEqual({ stopped: 'disqualified' });
  });
});

describe('heartbeat copy', () => {
  it('reads like A 4.5', () => {
    expect(heartbeatText('ci', 12 * MINUTE, 9 * MINUTE)).toBe('Still in CI, 12 minutes; typical for this repo is 9. Watching.');
    expect(heartbeatText('ci', 1 * MINUTE)).toBe('Still in CI, 1 minute. Watching.');
    expect(heartbeatText('ci', 75 * MINUTE, 9 * MINUTE)).toBe('Still in CI, 1 hour 15 minutes; typical for this repo is 9 minutes. Watching.');
    expect(heartbeatText('fixing', 120 * MINUTE)).toBe('Still working on a fix, 2 hours. Watching.');
    expect(heartbeatText('in-review', 10 * MINUTE)).not.toMatch(/\bPR\b/);
  });

  it('times CI from review-passed to the next result', () => {
    const at = (seq: number, type: EventType, minute: number): IncidentEvent =>
      ({ seq, type, occurredAt: new Date(T0 + minute * MINUTE).toISOString(), payload: {} }) as unknown as IncidentEvent;
    expect(ciRuns([at(1, 'review-passed', 0), at(2, 'ci-red', 7), at(3, 'review-passed', 20), at(4, 'ci-green', 31), at(5, 'ci-green', 40)]).map((r) => r.ms / MINUTE)).toEqual([7, 11]);
  });
});

// The module on the workflow ------------------------------------------------------------------------

describe('starting and stopping', () => {
  it('starts at Highest priority with `monitoring-started` and arms the poll, heartbeat, and stall timers once', async () => {
    const w = setup({ critical: [] });
    await append(...filed(INC, { priority: 'Highest' }));
    expect(await w.monitor.evaluate(INC)).toEqual({ started: 'priority' });
    expect(await w.monitor.evaluate(INC)).toBeUndefined();
    expect((await ofType('monitoring-started')).map((e) => e.payload)).toEqual([{ qualifiedBy: 'priority' }]);
    expect((await incident()).monitored).toBe(true);
    expect(w.workflow.started).toContain(pollKey(INC));
    const keys = w.workflow.scheduled.map((s) => s.key);
    expect(keys).toContain(timerKey('heartbeat', { incidentId: INC }));
    expect(keys).toContain(timerKey('stall', { incidentId: INC }));
    // The second evaluate re-armed the same times.
    expect(w.workflow.scheduled.filter((s) => s.key === timerKey('heartbeat', { incidentId: INC })).map((s) => s.at)).toEqual([10, 10]);
    expect(w.workflow.scheduled.filter((s) => s.key === timerKey('stall', { incidentId: INC })).map((s) => s.at)).toEqual([15, 15]);
  });

  it('starts on a critical surface and on an outage score; not otherwise', async () => {
    const w = setup({ critical: ['checkout'] });
    await append(...filed(INC));
    expect(await w.monitor.evaluate(INC)).toEqual({ started: 'critical-surface' });

    const other = '01K6MONITORINC00000000000B';
    await append(...filed(other, { surface: 'web' }));
    expect(await w.monitor.evaluate(other)).toBeUndefined();
    await append(ev('escalated', { intent: 'trigger', step: 3, action: 'post', score: 8, reactors: 5, outage: true }, { incidentId: other }));
    expect(await w.monitor.evaluate(other)).toEqual({ started: 'outage-score' });
  });

  it("arms the timers for the reaction ladder's own outage start without a second event", async () => {
    const w = setup({ critical: [] });
    await append(...filed(INC), ev('escalated', { intent: 'trigger', step: 3, action: 'post', score: 8, reactors: 5, outage: true }), ev('monitoring-started', { qualifiedBy: 'outage-score' }));
    expect(await w.monitor.evaluate(INC)).toBeUndefined();
    expect(await ofType('monitoring-started')).toHaveLength(1);
    expect(w.workflow.started).toContain(pollKey(INC));
  });

  it('a human downgrade stops it within one poll; a critical surface alone does not restart it; a raise to Highest does', async () => {
    const w = setup({ critical: ['checkout'] });
    await append(...filed(INC, { priority: 'Highest' }), ...toCi());
    await w.monitor.evaluate(INC);
    await until(3);

    await append(ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'Highest', to: 'High' }, { source: 'jira' }));
    await until(4);
    expect((await ofType('monitoring-stopped')).map((e) => e.payload)).toEqual([{ reason: 'downgraded' }]);
    expect((await incident()).monitored).toBe(false);
    expect(w.workflow.cancelled).toEqual(expect.arrayContaining([pollKey(INC), timerKey('heartbeat', { incidentId: INC }), timerKey('stall', { incidentId: INC })]));
    const polls = w.sources.calls.length;
    await until(30);
    expect(w.sources.calls).toHaveLength(polls);
    expect(w.chat.posts).toEqual([]);

    expect(await w.monitor.evaluate(INC)).toBeUndefined();
    await append(ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'High', to: 'Highest' }, { source: 'jira' }));
    expect(await w.monitor.evaluate(INC)).toEqual({ started: 'priority' });
  });

  it('a close stops it with no event and cancels the timers', async () => {
    const w = setup();
    await append(...filed(INC), ...toCi());
    await w.monitor.evaluate(INC);
    await until(2);
    await append(ev('closed', { reason: 'done' }));
    await until(3);
    expect((await incident()).monitored).toBe(false);
    expect(await ofType('monitoring-stopped')).toEqual([]);
    expect(w.workflow.cancelled).toContain(timerKey('heartbeat', { incidentId: INC }));
    const polls = w.sources.calls.length;
    await until(40);
    expect(w.sources.calls).toHaveLength(polls);
    expect(w.chat.posts).toEqual([]);
  });

  it('the playbook dropping the critical surface disqualifies it', async () => {
    const w = setup({ critical: ['checkout'] });
    await append(...filed(INC));
    await w.monitor.evaluate(INC);
    w.playbook.monitor.critical = [];
    await until(1);
    expect((await ofType('monitoring-stopped')).map((e) => e.payload)).toEqual([{ reason: 'disqualified' }]);
  });
});

describe('polling (B 8 sources every monitor.interval)', () => {
  it('asks every interval and appends a missed CI result once, as the reconciler would', async () => {
    const w = setup();
    await append(...filed(INC), ...toCi());
    await w.monitor.evaluate(INC);
    // `evaluate` starts the first poll now.
    await wf.drain();
    await until(3);
    expect(w.sources.calls.filter((c) => c.startsWith('checks'))).toEqual(['checks:418@0', 'checks:418@1', 'checks:418@2', 'checks:418@3']);

    w.sources.checks = { state: 'green', headSha: HEAD, completedAt: new Date(T0 + 3.5 * MINUTE).toISOString() };
    await until(5);
    const green = await ofType('ci-green');
    expect(green).toHaveLength(1);
    expect(green[0]).toMatchObject({ source: 'agent', occurredAt: new Date(T0 + 3.5 * MINUTE).toISOString(), payload: { prNumber: PR, headSha: HEAD, reconciled: true } });
    expect((await incident()).status).toBe('mergeable');
    expect(w.followUps).toEqual([{ type: 'ci-green', status: 'mergeable' }]);
  });

  it('appends merged, then the deploys the lifecycle takes, staging before production', async () => {
    const w = setup();
    await append(...filed(INC), ...toCi(), ev('ci-green', { prNumber: PR, headSha: HEAD }, { source: 'github' }));
    await w.monitor.evaluate(INC);
    w.sources.pr = { state: 'merged', mergeCommitSha: MERGE };
    // Production alone: B 5 takes no production deploy straight from merged.
    w.sources.deploys = [{ stage: 'production', commitSha: MERGE }];
    await until(2);
    expect((await incident()).status).toBe('merged');
    expect(await ofType('deployed:production')).toEqual([]);

    w.sources.deploys = [
      { stage: 'staging', commitSha: MERGE, deploymentId: '77', deployedAt: new Date(T0 + 2.5 * MINUTE).toISOString() },
      { stage: 'production', commitSha: MERGE },
    ];
    await until(4);
    expect((await types()).filter((t) => t.startsWith('deployed') || t === 'merged')).toEqual(['merged', 'deployed:staging', 'deployed:production']);
    expect((await ofType('deployed:staging'))[0]).toMatchObject({ occurredAt: new Date(T0 + 2.5 * MINUTE).toISOString(), payload: { commitSha: MERGE, deploymentId: '77' } });
    expect((await incident()).status).toBe('deployed:production');
    expect(w.followUps.map((f) => f.type)).toEqual(['merged', 'deployed:staging', 'deployed:production']);
  });

  it('a failing source does not end the chain', async () => {
    const w = setup();
    await append(...filed(INC), ...toCi());
    await w.monitor.evaluate(INC);
    w.sources.failChecks = true;
    await until(2);
    w.sources.failChecks = false;
    w.sources.checks = { state: 'red', headSha: HEAD, failingChecks: ['unit'] };
    await until(3);
    expect((await ofType('ci-red')).map((e) => e.payload)).toEqual([{ prNumber: PR, headSha: HEAD, failingChecks: ['unit'], reconciled: true }]);
    expect(w.logs.some((m) => m.includes('github unavailable'))).toBe(true);
  });
});

describe('heartbeat and stall', () => {
  it('A 8 stall row: CI webhook suppressed, heartbeat posts at 10 min, owner mentioned at 15 min', async () => {
    await ciHistory();
    const w = setup({ critical: ['checkout'] });
    // In CI since two minutes before monitoring starts; the CI webhook never arrives (checks stay pending).
    await append(...filed(INC, { at: T0 - 5 * MINUTE }), ...toCi(INC, T0 - 2 * MINUTE));
    expect(await w.monitor.evaluate(INC)).toEqual({ started: 'critical-surface' });

    await until(9);
    expect(w.chat.posts).toEqual([]);
    await until(10);
    expect(w.chat.posts).toHaveLength(1);
    expect(w.chat.posts[0]).toMatchObject({
      at: 10,
      ladder: 'heartbeat',
      step: 1,
      where: { kind: 'thread', channel: 'C-FAKE', threadId: '1700000000.000100' },
      text: 'Still in CI, 12 minutes; typical for this repo is 9. Watching.',
    });
    expect(await ladderSteps()).toEqual([]);

    await until(14);
    expect(await w.monitor.stalled({ id: INC })).toBe(false);
    await until(15);
    expect(await w.monitor.stalled({ id: INC })).toBe(true);
    expect(await ladderSteps()).toEqual([{ ladder: 'stalled-fix', step: 1, mentioned: 'dana' }]);
    expect(w.chat.posts.at(-1)).toMatchObject({ at: 15, ladder: 'stalled-fix', mention: 'dana' });

    // Heartbeats go on while stalled.
    await until(20);
    expect(w.chat.posts.at(-1)).toMatchObject({ at: 20, ladder: 'heartbeat', step: 2, text: 'Still in CI, 22 minutes; typical for this repo is 9. Watching.' });

    // CI finishes; the poll records it, which is progress: the ladder stops at the next poll.
    w.sources.checks = { state: 'green', headSha: HEAD, completedAt: new Date(T0 + 21 * MINUTE).toISOString() };
    await until(23);
    expect(await ladderPhases()).toEqual(['started:stalled-fix', 'step:stalled-fix', 'stopped:stalled-fix:no-longer-applies']);
    // The stage changed at 21 (when the poll learned it): no heartbeat until 31.
    await until(30);
    expect(w.chat.posts.filter((p) => p.ladder === 'heartbeat')).toHaveLength(2);
    await until(31);
    expect(w.chat.posts.at(-1)).toMatchObject({ at: 31, ladder: 'heartbeat', text: 'Still waiting to merge, 10 minutes. Watching.' });
  });

  it("signals and the ladders' own records are not progress; a fixer report is", async () => {
    const w = setup();
    await append(...filed(INC), ev('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }));
    await w.monitor.evaluate(INC);
    await until(10);
    await append(
      ev('comment', { intent: 'trigger', effect: 'counted' } as unknown as EventPayloads['comment']),
      ev('escalation-ladder', { phase: 'started', ladder: 'outage' }),
      ev('waiting-changed', { waitingOn: { kind: 'human', who: 'U-FAKE' } }),
    );
    await until(15);
    expect(await ladderSteps()).toEqual([{ ladder: 'stalled-fix', step: 1, mentioned: 'dana' }]);

    // A second incident: a fixer checkpoint at 10 moves the stall to 25.
    const other = '01K6MONITORINC00000000000C';
    now = T0 + 15 * MINUTE;
    await append(...filed(other), ev('fixer-started', { runId: 'run-2', harness: 'claude-code', attempt: 1 }, { incidentId: other }));
    await w.monitor.evaluate(other);
    await until(25);
    await append(ev('fixer-checkpoint', { runId: 'run-2', phase: 'tests' } as unknown as EventPayloads['fixer-checkpoint'], { incidentId: other, source: 'fixer' }));
    await until(39);
    expect(await w.monitor.stalled({ id: other })).toBe(false);
    await until(40);
    expect(await w.monitor.stalled({ id: other })).toBe(true);
  });

  it('a stage change restarts the heartbeat count', async () => {
    const w = setup();
    await append(...filed(INC), ev('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }));
    await w.monitor.evaluate(INC);
    await until(8);
    await append(ev('pr-opened', { prNumber: PR, branch: 'fix/WEB-1042' }, { source: 'fixer' }));
    await until(17);
    expect(w.chat.posts.filter((p) => p.ladder === 'heartbeat')).toEqual([]);
    await until(18);
    expect(w.chat.posts.filter((p) => p.ladder === 'heartbeat').map((p) => [p.at, p.text])).toEqual([[18, 'Still in review, 10 minutes. Watching.']]);
  });

  it('a human downgrade stops the stalled-fix ladder', async () => {
    const w = setup({ critical: [], escalations: [STALLED_FIX, OUTAGE] });
    await append(...filed(INC, { priority: 'Highest' }), ...toCi());
    await w.monitor.evaluate(INC);
    await until(16);
    expect((await ladderPhases()).filter((p) => p.includes('stalled-fix'))).toEqual(['started:stalled-fix', 'step:stalled-fix']);
    await append(ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'Highest', to: 'Medium' }, { source: 'jira' }));
    await until(17);
    expect(await ladderPhases()).toContain('stopped:stalled-fix:no-longer-applies');
    expect(await ladderPhases()).toContain('stopped:outage:no-longer-applies');
    expect((await incident()).monitored).toBe(false);
  });
});
