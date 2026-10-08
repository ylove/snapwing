// Fixer job, budget timer, and Stop (main 10.1, main 10.4, B 5, B 9). Runs on the
// in-process workflow over the dialect `SNAPWING_DB` selects, with a fake RunnerPort (and once the
// local runner over a fake harness) and a fake FixerGitHub. The fixer API (B 9) is simulated by
// appending its events and calling the hooks it will call; `report` mirrors its rule that a report
// with no run going is refused as `run-finished`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { fixerRunKey, isFixerBudgetData, isFixerRunData } from '../../src/contracts/jobs.ts';
import {
  activeRun,
  appendDecided,
  BUDGET_EXCEEDED,
  handleFixerDone,
  handleFixerFailed,
  latest,
  registerFixerJobs,
  runFixerJob,
  startFixer,
  type FixerDeps,
  type FixerGitHub,
  type FixerGitHubContext,
} from '../../src/fixer/job.ts';
import { jiraCreateBatchKey } from '../../src/state/projections/outbox/jira.ts';
import { stopIncident } from '../../src/fixer/stop.ts';
import type { HarnessPort } from '../../src/ports/harness.ts';
import type { FixerJob, RunnerPort } from '../../src/ports/runner.ts';
import { buildImplementationRequest } from '../../src/prompts/implementation-request.ts';
import { createLocalRunner } from '../../src/providers/local/runner.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';
import { createBareRepo } from '../helpers/git.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6FIXERINC0000000000000A';
const REPO = 'fake-org/web';
const ENGINEER = { id: 'U-FAKE-DANA', role: 'engineer' } as const;
const MINUTE = 60_000;

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

class FakeRunner implements RunnerPort {
  readonly started: { runId: string; job: FixerJob }[] = [];
  readonly cancelled: string[] = [];
  /** Runs inside runFixer, after the run has started (a race hook, or the harness reporting). */
  onStart?: (job: FixerJob) => Promise<void>;
  /** When set, runFixer rejects with it and starts nothing. */
  failWith?: Error;

  async runFixer(job: FixerJob): Promise<{ runId: string }> {
    if (this.failWith !== undefined) throw this.failWith;
    this.started.push({ runId: job.runId, job });
    await this.onStart?.(job);
    return { runId: job.runId };
  }

  cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    return Promise.resolve();
  }
}

class FakeGitHub implements FixerGitHub {
  readonly incomplete: { branch: string; ctx: FixerGitHubContext }[] = [];
  readonly closed: { pr: number; comment: string; ctx: FixerGitHubContext }[] = [];

  markIncomplete(branch: string, ctx: FixerGitHubContext): Promise<void> {
    this.incomplete.push({ branch, ctx });
    return Promise.resolve();
  }

  closePr(pr: number, comment: string, ctx: FixerGitHubContext): Promise<void> {
    this.closed.push({ pr, comment, ctx });
    return Promise.resolve();
  }
}

interface World {
  deps: FixerDeps;
  runner: FakeRunner;
  github: FakeGitHub;
  request: { artifactId: string; version: number };
}

async function setup(opts: { level?: 0 | 1 | 2 | 3; wallClock?: string; unfiled?: boolean } = {}): Promise<World> {
  const runner = new FakeRunner();
  const github = new FakeGitHub();
  const deps: FixerDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    runner,
    github,
    config: { harness: { adapter: 'claude-code' }, ...(opts.wallClock === undefined ? {} : { wallClock: opts.wallClock }) },
    clock: () => new Date(now),
  };
  registerFixerJobs(deps);
  const put = await state.putArtifact({
    workspaceId: WS,
    incidentId: INC,
    kind: 'implementation-request',
    contentType: 'application/xml',
    body: '<implementation-request/>',
    createdBy: 'orchestrator',
  });
  const request = { artifactId: put.id, version: put.version };
  await append(...(opts.unfiled === true ? toFiled(opts.level ?? 3, request).slice(0, -1) : toFiled(opts.level ?? 3, request)));
  return { deps, runner, github, request };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' | 'github' = 'agent'): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source, occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

function toFiled(level: 0 | 1 | 2 | 3, request: { artifactId: string; version: number }): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: REPO, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: request,
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await log()).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function types(): Promise<EventType[]> {
  return (await log()).map((e) => e.type);
}

async function lastOf<T extends EventType>(type: T): Promise<IncidentEvent<T> | undefined> {
  return latest(await log(), type);
}

/**
 * A fixer report as the fixer API (B 9) records it: appended while a run is going, refused as
 * `run-finished` when none is.
 */
async function report(phase: 'cloned' | 'branched', detail = ''): Promise<'accepted' | 'run-finished'> {
  const r = await appendDecided(state, INC, (events) =>
    activeRun(events) === undefined ? undefined : [ev('fixer-checkpoint', { phase, detail }, 'fixer')],
  );
  return r.appended ? 'accepted' : 'run-finished';
}

async function advance(ms: number): Promise<void> {
  now += ms;
  await wf.drain();
}

/** Starts the fixer and runs the job; returns the run id. */
async function started(w: World, attempt = 1): Promise<string> {
  await startFixer(w.deps, { incidentId: INC, attempt });
  await wf.drain();
  const run = w.runner.started.at(-1);
  if (run === undefined) throw new Error('the fixer did not start');
  return run.runId;
}

/** What the fixer API (B 9) appends for a `done` report, then the hook it calls. */
async function reportDone(w: World, prNumber: number): Promise<void> {
  await append(
    ev('fixer-done', { prNumber, branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: ['test/cart.test.ts'] }, 'fixer'),
    ev('pr-opened', { prNumber, branch: 'fix/WEB-1042' }, 'fixer'),
  );
  await handleFixerDone(w.deps, INC);
}

// Tests -------------------------------------------------------------------------------------------

describe(`fixer job (${TEST_DIALECT})`, () => {
  it('happy path: one job per incident, the latest request, fixer-started, a budget timer that fixer-done cancels', async () => {
    const w = await setup();
    // A second version of the request, as a re-plan would write: the fixer gets the latest.
    const v2 = await state.putArtifact({
      id: w.request.artifactId,
      workspaceId: WS,
      incidentId: INC,
      kind: 'implementation-request',
      contentType: 'application/xml',
      body: '<implementation-request v="2"/>',
      createdBy: 'orchestrator',
    });

    const a = await startFixer(w.deps, { incidentId: INC, attempt: 1 });
    const b = await startFixer(w.deps, { incidentId: INC, attempt: 1 });
    expect(b.jobId).toBe(a.jobId);
    await wf.drain();

    expect(w.runner.started).toHaveLength(1);
    const fs = await lastOf('fixer-started');
    const runId = fs?.payload.runId ?? '';
    expect(runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(w.runner.started[0]?.job).toEqual({
      runId,
      workItem: { id: INC, issueKey: 'WEB-1042', repo: REPO },
      implementationRequestArtifactId: w.request.artifactId,
      implementationRequestVersion: v2.version,
      harness: { adapter: 'claude-code' },
      budget: { wallClock: 'PT30M', attempts: 3 },
    });
    expect(v2.version).toBe(2);
    expect(fs?.payload).toEqual({ runId, harness: 'claude-code', attempt: 1 });
    expect((await state.getIncident(INC))?.status).toBe('fixing');

    // The budget has not run out at 29 minutes.
    await advance(29 * MINUTE);
    expect(await types()).not.toContain('fixer-failed');

    await reportDone(w, 87);
    await advance(2 * MINUTE);
    expect(await types()).not.toContain('fixer-failed');
    expect(w.runner.cancelled).toEqual([]);
    expect(await types()).not.toContain('level-changed');

    // Starting attempt 1 again (a second In Progress transition) runs nothing.
    await startFixer(w.deps, { incidentId: INC, attempt: 1 });
    await wf.drain();
    expect(w.runner.started).toHaveLength(1);
  });

  it('budget expiry: the timer cancels the run, appends fixer-failed budget-exceeded, and degrades to level 2', async () => {
    const w = await setup({ level: 3 });
    const runId = await started(w);

    await advance(30 * MINUTE);

    expect(w.runner.cancelled).toEqual([runId]);
    const failed = await lastOf('fixer-failed');
    expect(failed?.payload).toEqual({ reason: BUDGET_EXCEEDED, attempts: 1 });
    expect((await lastOf('level-changed'))?.payload).toEqual({ from: 3, to: 2, reason: `fixer-failed: ${BUDGET_EXCEEDED}` });
    expect((await state.getIncident(INC))?.autonomyLevel).toBe(2);
    expect(w.github.incomplete).toEqual([]);
    const tail = (await types()).slice(-3);
    expect(tail).toEqual(['fixer-started', 'fixer-failed', 'level-changed']);
  });

  it('budget expiry after a push marks the branch incomplete; a configured wall clock sets the timer', async () => {
    const w = await setup({ level: 2, wallClock: 'PT10M' });
    await started(w);
    await append(
      ev('fixer-checkpoint', { phase: 'cloned', detail: '' }, 'fixer'),
      ev('fixer-checkpoint', { phase: 'branched', detail: 'fix/WEB-1042' }, 'fixer'),
      ev('fixer-checkpoint', { phase: 'pushed', detail: '' }, 'fixer'),
    );

    await advance(9 * MINUTE);
    expect(await types()).not.toContain('fixer-failed');
    await advance(1 * MINUTE);

    expect((await lastOf('fixer-failed'))?.payload).toEqual({ reason: BUDGET_EXCEEDED, partialBranch: 'fix/WEB-1042', attempts: 1 });
    expect(w.github.incomplete).toEqual([{ branch: 'fix/WEB-1042', ctx: { incidentId: INC, repo: REPO, issueKey: 'WEB-1042' } }]);
    // Already at level 2: the event still records why a human owns it now.
    expect((await lastOf('level-changed'))?.payload).toEqual({ from: 2, to: 2, reason: `fixer-failed: ${BUDGET_EXCEEDED}` });
  });

  it('a stale budget timer for an earlier run does nothing', async () => {
    const w = await setup();
    await started(w);
    const before = await types();
    // The timer handler is keyed by run; a different run id finds nothing to cancel.
    await wf.schedule('timer.fixer-budget', { incidentId: INC, runId: 'run-old' }, new Date(now), { singletonKey: 'test:stale' });
    await wf.drain();
    expect(await types()).toEqual(before);
    expect(w.runner.cancelled).toEqual([]);
  });

  it('stop before start: a queued fixer.run is cancelled, and a start after the stop appends nothing', async () => {
    const w = await setup();
    await startFixer(w.deps, { incidentId: INC, attempt: 1 });

    const outcome = await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER, source: 'slack' });
    expect(outcome).toEqual({ stopped: true });
    await wf.drain();
    expect(w.runner.started).toEqual([]);

    const afterStop = await types();
    expect(afterStop.at(-1)).toBe('stopped');
    const stopped = await lastOf('stopped');
    expect(stopped?.actor).toEqual(ENGINEER);
    expect(stopped?.source).toBe('slack');

    await startFixer(w.deps, { incidentId: INC, attempt: 1 });
    await wf.drain();
    expect(await runFixerJob(w.deps, { incidentId: INC, attempt: 1 })).toEqual({ started: false, reason: 'stopped' });
    expect(w.runner.started).toEqual([]);
    expect(await types()).toEqual(afterStop);
  });

  it('a stop that lands while the runner is starting cancels the new run once the runner knows it', async () => {
    const w = await setup();
    w.runner.onStart = async () => {
      await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER });
    };
    expect(await runFixerJob(w.deps, { incidentId: INC, attempt: 1 })).toEqual({ started: false, reason: 'stopped' });

    const runId = w.runner.started[0]?.runId;
    // The stop's own cancel came before runFixer returned (a real runner did not know the id yet),
    // so the fixer job cancels again; cancel is idempotent.
    expect(w.runner.cancelled).toEqual([runId, runId]);
    expect((await types()).slice(-2)).toEqual(['fixer-started', 'stopped']);
    const afterStop = await types();
    await advance(31 * MINUTE);
    expect(await types()).toEqual(afterStop);
  });

  it('a report from inside runFixer is accepted: fixer-started is already in the log', async () => {
    const w = await setup();
    const outcomes: string[] = [];
    w.runner.onStart = async (job) => {
      const run = activeRun(await log());
      expect(run?.payload.runId).toBe(job.runId);
      outcomes.push(await report('cloned'));
    };
    const outcome = await runFixerJob(w.deps, { incidentId: INC, attempt: 1 });

    expect(outcome).toEqual({ started: true, runId: w.runner.started[0]?.runId });
    expect(outcomes).toEqual(['accepted']);
    expect((await types()).slice(-2)).toEqual(['fixer-started', 'fixer-checkpoint']);
    expect(w.runner.cancelled).toEqual([]);
  });

  it('with the local runner, a harness that reports its first checkpoint at once has it accepted', async () => {
    const w = await setup();
    // The local runner parses the request for its handoff, so this test's request must be a real one.
    await state.putArtifact({
      id: w.request.artifactId,
      workspaceId: WS,
      incidentId: INC,
      kind: 'implementation-request',
      contentType: 'application/xml',
      body: buildImplementationRequest({
        issue: 'WEB-1042',
        intent: 'Guard the null cart',
        evidence: [{ kind: 'report', source: 'slack', text: 'checkout crashes' }],
        constraints: { scope: 'checkout', tests: { required: true, text: 'add a test' }, forbidden: [] },
        handoff: { mode: 'auto', autonomy: 3 },
      }),
      createdBy: 'orchestrator',
    });
    const origin = await createBareRepo();
    const workdirRoot = await mkdtemp(join(tmpdir(), 'snapwing-fixer-job-'));
    const outcomes: string[] = [];
    // The runner reports `cloned` itself; the harness begins at `branched`.
    const harness: HarnessPort = {
      async run(_workItem, _request, _workdir, opts) {
        await opts.onCheckpoint?.({ phase: 'branched', detail: 'fix/WEB-1042' });
        return { outcome: 'done', branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: [] };
      },
    };
    const local = createLocalRunner({
      resolveHarness: () => harness,
      artifacts: state,
      workdirRoot,
      git: { token: async () => 'test-git-token-not-real', remoteUrl: () => origin.url },
      onCheckpoint: async (_run, c) => {
        outcomes.push(await report(c.phase === 'branched' ? 'branched' : 'cloned', c.detail));
      },
    });
    try {
      const outcome = await runFixerJob({ ...w.deps, runner: local }, { incidentId: INC, attempt: 1 });
      if (!outcome.started) throw new Error(`expected a start, got ${outcome.reason}`);
      expect((await local.wait(outcome.runId)).outcome).toBe('done');
      expect(outcomes).toEqual(['accepted', 'accepted']);
      expect((await lastOf('fixer-started'))?.payload.runId).toBe(outcome.runId);
      expect((await types()).slice(-3)).toEqual(['fixer-started', 'fixer-checkpoint', 'fixer-checkpoint']);
    } finally {
      await rm(workdirRoot, { recursive: true, force: true });
      await origin.remove();
    }
  });

  it('a runner that cannot start: fixer-failed with the error, then the failure path', async () => {
    const w = await setup({ level: 3 });
    w.runner.failWith = new Error('no <generic id="nope"> harness template in the config');
    expect(await runFixerJob(w.deps, { incidentId: INC, attempt: 1 })).toEqual({ started: false, reason: 'runner-failed' });

    expect((await types()).slice(-3)).toEqual(['fixer-started', 'fixer-failed', 'level-changed']);
    expect((await lastOf('fixer-failed'))?.payload).toEqual({
      reason: 'runner-error: no <generic id="nope"> harness template in the config',
      attempts: 0,
    });
    expect((await lastOf('level-changed'))?.payload).toMatchObject({ from: 3, to: 2 });
    expect(w.github.incomplete).toEqual([]);

    // The budget timer is gone, and the attempt counts as run.
    const afterFail = await types();
    await advance(31 * MINUTE);
    expect(await types()).toEqual(afterFail);
    expect(w.runner.cancelled).toEqual([]);
    expect(await runFixerJob(w.deps, { incidentId: INC, attempt: 1 })).toEqual({ started: false, reason: 'attempt-done' });
  });

  it('stop mid-run: appends stopped, cancels the run and its budget timer, and a second stop is a no-op', async () => {
    const w = await setup();
    const runId = await started(w);

    const outcome = await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER, reason: 'wrong repo' });
    expect(outcome).toEqual({ stopped: true, cancelledRun: runId });
    expect(w.runner.cancelled).toEqual([runId]);
    expect((await lastOf('stopped'))?.payload).toEqual({ reason: 'wrong repo' });
    expect((await state.getIncident(INC))?.status).toBe('stopped');
    expect(w.github.closed).toEqual([]);

    const afterStop = await types();
    expect(await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER })).toEqual({ stopped: false, reason: 'already-stopped' });
    await advance(31 * MINUTE);
    expect(await types()).toEqual(afterStop);
    expect(w.runner.cancelled).toEqual([runId]);
  });

  it('stop before filing drops the queued create-issue row so nothing is filed', async () => {
    const w = await setup({ unfiled: true });
    const now0 = new Date(now).toISOString();
    await state.enqueueOutbox({
      id: '01K6CREATE0000000000000001',
      workspaceId: WS,
      target: 'jira',
      incidentId: INC,
      op: 'create-issue',
      payload: {},
      batchKey: jiraCreateBatchKey(INC),
      attempts: 0,
      nextAttempt: now0,
      createdAt: now0,
    });

    expect(await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER })).toEqual({ stopped: true });
    expect(await state.drainOutbox('jira', 10)).toEqual([]);
  });

  it('stop before filing keeps a create-issue row that was already sent; its later filed is tracked', async () => {
    const w = await setup({ unfiled: true });
    const now0 = new Date(now).toISOString();
    await state.enqueueOutbox({
      id: '01K6CREATE0000000000000002',
      workspaceId: WS,
      target: 'jira',
      incidentId: INC,
      op: 'create-issue',
      payload: {},
      batchKey: jiraCreateBatchKey(INC),
      attempts: 0,
      nextAttempt: now0,
      createdAt: now0,
    });
    await state.ackOutbox(['01K6CREATE0000000000000002']); // sent: past the point of no return

    expect(await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER })).toEqual({ stopped: true });
    await append(ev('filed', { jiraKey: 'WEB-1042' }, 'agent'));
    expect((await types()).slice(-2)).toEqual(['stopped', 'filed']);
    expect((await state.getIncident(INC))?.jiraKey).toBe('WEB-1042');
  });

  it('stop with an open PR closes it with a comment; the second stop does not close it again', async () => {
    const w = await setup();
    await started(w);
    await reportDone(w, 87);

    const outcome = await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER });
    expect(outcome).toEqual({ stopped: true, closedPr: 87 });
    expect(w.github.closed).toHaveLength(1);
    expect(w.github.closed[0]).toMatchObject({ pr: 87, ctx: { incidentId: INC, repo: REPO, issueKey: 'WEB-1042' } });
    expect(w.github.closed[0]?.comment).toContain('WEB-1042');
    expect(w.github.closed[0]?.comment).toContain(ENGINEER.id);
    expect(w.runner.cancelled).toEqual([]);

    await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER });
    expect(w.github.closed).toHaveLength(1);
  });

  it('stop mid-run after the fixer opened its PR but before done closes the PR its checkpoint names', async () => {
    const w = await setup();
    const runId = await started(w);
    await append(ev('fixer-checkpoint', { phase: 'pushed', detail: '' }, 'fixer'), ev('fixer-checkpoint', { phase: 'pr-opened', detail: '#88' }, 'fixer'));

    expect(await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER })).toEqual({ stopped: true, cancelledRun: runId, closedPr: 88 });
    expect(w.github.closed).toHaveLength(1);
    expect(w.github.closed[0]).toMatchObject({ pr: 88, ctx: { incidentId: INC, repo: REPO, issueKey: 'WEB-1042' } });
    expect(w.runner.cancelled).toEqual([runId]);
  });

  it('stop mid-run ignores a pr-opened checkpoint whose detail names no PR number', async () => {
    const w = await setup();
    const runId = await started(w);
    await append(ev('fixer-checkpoint', { phase: 'pr-opened', detail: 'https://example.com/pull/x' }, 'fixer'));

    expect(await stopIncident(w.deps, { incidentId: INC, actor: ENGINEER })).toEqual({ stopped: true, cancelledRun: runId });
    expect(w.github.closed).toEqual([]);
  });

  it('failure with a partial branch: draft PR through markIncomplete, level-changed, budget timer cancelled, idempotent', async () => {
    const w = await setup({ level: 3 });
    await started(w);
    await append(ev('fixer-failed', { reason: 'tests still red', partialBranch: 'fix/WEB-1042', attempts: 3 }, 'fixer'));

    const outcome = await handleFixerFailed(w.deps, INC);
    expect(outcome).toEqual({ handled: true, markedIncomplete: 'fix/WEB-1042', level: { from: 3, to: 2 } });
    expect(w.github.incomplete).toEqual([{ branch: 'fix/WEB-1042', ctx: { incidentId: INC, repo: REPO, issueKey: 'WEB-1042' } }]);
    expect((await lastOf('level-changed'))?.payload).toEqual({ from: 3, to: 2, reason: 'fixer-failed: tests still red' });

    // A second call (a redelivered hook) does nothing; the budget timer is gone.
    expect(await handleFixerFailed(w.deps, INC)).toEqual({ handled: false });
    const afterFail = await types();
    await advance(31 * MINUTE);
    expect(await types()).toEqual(afterFail);
    expect(w.github.incomplete).toHaveLength(1);
    expect(w.runner.cancelled).toEqual([]);
  });

  it('failure without a partial branch degrades without a draft PR', async () => {
    const w = await setup({ level: 3 });
    await started(w);
    await append(ev('fixer-failed', { reason: 'could not reproduce', attempts: 1 }, 'fixer'));

    expect(await handleFixerFailed(w.deps, INC)).toEqual({ handled: true, level: { from: 3, to: 2 } });
    expect(w.github.incomplete).toEqual([]);
    expect((await types()).slice(-2)).toEqual(['fixer-failed', 'level-changed']);
  });

  it('retry with a review artifact: attempt 2 hands the review to the runner', async () => {
    const w = await setup({ level: 2 });
    await started(w);
    await reportDone(w, 87);
    const review = await state.putArtifact({
      workspaceId: WS,
      incidentId: INC,
      kind: 'review',
      contentType: 'application/json',
      body: '{"verdict":"request-changes"}',
      createdBy: 'review-agent',
    });
    const reviewRef = { artifactId: review.id, version: review.version };
    await append(ev('review-failed', { prNumber: 87, verdict: 'request-changes', reason: 'no regression test', review: reviewRef }));

    await startFixer(w.deps, { incidentId: INC, attempt: 2, reviewArtifact: reviewRef });
    await wf.drain();

    expect(w.runner.started).toHaveLength(2);
    expect(w.runner.started[1]?.job.review).toEqual(reviewRef);
    expect(w.runner.started[1]?.job.implementationRequestArtifactId).toBe(w.request.artifactId);
    const run2 = w.runner.started[1]?.runId;
    expect(run2).not.toBe(w.runner.started[0]?.runId);
    expect((await lastOf('fixer-started'))?.payload).toEqual({ runId: run2, harness: 'claude-code', attempt: 2 });

    // The second run gets its own budget.
    await advance(30 * MINUTE);
    expect(w.runner.cancelled).toEqual([run2]);
    expect((await lastOf('fixer-failed'))?.payload.reason).toBe(BUDGET_EXCEEDED);
  });

  it('job data validators and the singleton key', () => {
    expect(fixerRunKey(INC)).toBe(`fixer:${INC}`);
    expect(isFixerRunData({ incidentId: INC, attempt: 1 })).toBe(true);
    expect(isFixerRunData({ incidentId: INC, attempt: 2, reviewArtifact: { artifactId: 'a', version: 1 } })).toBe(true);
    expect(isFixerRunData({ incidentId: INC, attempt: 0 })).toBe(false);
    expect(isFixerRunData({ incidentId: INC, attempt: 2, reviewArtifact: { artifactId: 'a' } })).toBe(false);
    expect(isFixerBudgetData({ incidentId: INC, runId: 'run-1' })).toBe(true);
    expect(isFixerBudgetData({ incidentId: INC })).toBe(false);
  });

  it('refuses without appending when a run is still going', async () => {
    const w = await setup();
    await started(w);
    const before = await types();
    expect(await runFixerJob(w.deps, { incidentId: INC, attempt: 2 })).toEqual({ started: false, reason: 'running' });
    expect(await types()).toEqual(before);
  });
});
