// src/fixer-api/reporter.ts: the fixer reporting API (B 9) as in-process functions. The local runner
// calls these directly; `createFixerRoutes` (routes.ts) exposes the same five operations over HTTP
// for a fixer in a container. Fixers never touch the database (B 0 rule 4): this module is the only
// way their progress reaches the log.
//
// Every report is validated first (validate.ts; harness output is untrusted, unknown keys are
// dropped), then decided against a fresh read of the log and appended at that read's seq. A conflict
// re-reads and decides again (CONTEXT.md rule 1, `appendDecided` in pipeline/src/fixer/job.ts). A
// report is refused, appending nothing, when:
//   - the incident has no events (`unknown-incident`),
//   - the incident is in a terminal status, folded from the log (`incident-closed`),
//   - no run is going: the latest `fixer-started` is followed by `fixer-done`, `fixer-failed`, or
//     `stopped`, or there is none (`run-finished`),
//   - the report names a run (the fixer token's, #273) that is not the running one (`run-finished`).
// A `done` is also refused, appending nothing, when the pull request the hand-off opened fails
// verification against GitHub (`pr-mismatch`, verify-pr.ts).
//
//   checkpoint   appends `fixer-checkpoint { phase, detail }`. `pushed` and `pr-opened` are refused
//                (400): only the server pushes and opens pull requests, and it records them (#262).
//   artifact     stores the body as a new version of the incident's artifact of that kind (version 1
//                when there is none yet), then appends `fixer-artifact { kind, artifact }`. When the
//                append is refused after the store, the version stays unreferenced.
//   done         the fixer committed its work and left a bundle of the work branch; it names no
//                branch and no pull request (#262). The hand-off (`handoff`, handoff.ts) imports the
//                bundle, checks it, pushes the run's work branch, and opens (or finds) the pull
//                request as the App. A hand-off it refuses is `handoff-refused` with the reason, and
//                nothing is recorded; a stop during it is `run-finished`, and nothing is pushed after
//                the stop is seen. Then, still for that run, it appends the `pushed` and `pr-opened`
//                checkpoints, `fixer-done`, and `pr-opened` together, and calls `onDone`.
//   failed       appends `fixer-failed`, then calls `onFailed`. With a `partialBranch` the hand-off
//                pushes the partial work first, without a pull request, and the recorded
//                `partialBranch` is the run's work branch the server pushed (main 10.4's draft pull
//                request is opened from it); when the hand-off refuses, the failure is recorded
//                without one and its reason says why.
//   stop         reads only: `stop: true` when a `stopped` follows the latest `fixer-started`;
//                refused for an unknown or closed incident; otherwise `stop: false`. A finished run
//                is not refused here: polling is cheap and harmless, and a fixer whose run already
//                ended learns at its next report (`run-finished`). `fixer.run` mints the run id and
//                appends `fixer-started` before it calls `RunnerPort.runFixer` (pipeline/src/fixer/
//                job.ts), so a fixer's first report always finds its run.
//
// `onDone` and `onFailed` must be idempotent (compose.ts points `onDone` at `handleFixerDone` and
// then `startReview`, `onFailed` at `handleFixerFailed`, in pipeline/src/fixer/job.ts). An error they
// throw propagates after the event is durable; a retry of the same report is then refused as
// `run-finished`, and the reporter calls the hook again first, so a crash between the append and the
// hook heals on the fixer's retry.

import type { ArtifactRef, EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { activeRun, appendDecided, latest, newEvent } from '@snapwing/pipeline/fixer/job.ts';
import { INITIAL_STATUS, isTerminalStatus, nextStatus, type LifecycleStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { FixerHandoff } from './handoff.ts';
import type { PullRequestVerifier } from './verify-pr.ts';
import {
  parseArtifactInput,
  parseCheckpointInput,
  parseDoneInput,
  parseFailedInput,
  type FixerInputError,
  type Parsed,
} from './validate.ts';

/** Who is reporting: the claims of a verified fixer token, or the local runner's own run. */
export interface FixerTarget {
  workItemId: string;
  incidentId: string;
  /** The run the fixer token was issued for (#273): reports for any other run are refused. */
  runId?: string;
}

export type FixerRefusal = 'unknown-incident' | 'incident-closed' | 'run-finished' | 'pr-mismatch';

export type FixerReportResult =
  | { ok: true; seq: number; runId: string }
  | { ok: false; code: 'invalid'; error: FixerInputError }
  | { ok: false; code: FixerRefusal };

/** A `done`'s result: also refused when the hand-off refuses the fixer's work (409, with the reason). */
export type FixerDoneResult = FixerReportResult | { ok: false; code: 'handoff-refused'; reason: string };

export type FixerArtifactResult =
  | { ok: true; seq: number; runId: string; artifact: ArtifactRef }
  | { ok: false; code: 'invalid'; error: FixerInputError }
  | { ok: false; code: FixerRefusal };

export type FixerStopResult = { ok: true; stop: boolean } | { ok: false; code: FixerRefusal };

/** What `onDone` and `onFailed` receive, once the event is in the log. */
export interface FixerHookContext {
  workItemId: string;
  incidentId: string;
  runId: string;
  /** Seq of the `fixer-done` or `fixer-failed` event. */
  seq: number;
}

export interface FixerReporterDeps {
  state: StatePort;
  clock: () => Date;
  /** Imports, checks, and pushes a run's handed-back work, and opens its pull request (handoff.ts). */
  handoff: FixerHandoff;
  /** Checks the pull request the hand-off opened before `pr-opened` is recorded (#267). */
  verifyPullRequest: PullRequestVerifier;
  onDone?: (ctx: FixerHookContext) => Promise<void>;
  onFailed?: (ctx: FixerHookContext) => Promise<void>;
}

export interface FixerReporter {
  checkpoint(target: FixerTarget, input: unknown): Promise<FixerReportResult>;
  artifact(target: FixerTarget, input: unknown): Promise<FixerArtifactResult>;
  done(target: FixerTarget, input: unknown): Promise<FixerDoneResult>;
  failed(target: FixerTarget, input: unknown): Promise<FixerReportResult>;
  stop(target: FixerTarget): Promise<FixerStopResult>;
}

type Decision = { ok: true; run: IncidentEvent<'fixer-started'>; workspaceId: string } | { ok: false; code: FixerRefusal };

/** Whether a fixer may report on this log right now, for `runId` when it names one. */
export function decideReport(events: readonly IncidentEvent[], runId?: string): Decision {
  const first = events[0];
  if (first === undefined) return { ok: false, code: 'unknown-incident' };
  if (isTerminalStatus(statusOf(events))) return { ok: false, code: 'incident-closed' };
  const run = activeRun(events);
  if (run === undefined || (runId !== undefined && run.payload.runId !== runId)) return { ok: false, code: 'run-finished' };
  return { ok: true, run, workspaceId: first.workspaceId };
}

/** True when a `stopped` follows the latest `fixer-started` (B 9 stop poll). */
export function stopPending(events: readonly IncidentEvent[]): boolean {
  const run = latest(events, 'fixer-started');
  return run !== undefined && events.some((e) => e.seq > run.seq && e.type === 'stopped');
}

/**
 * The work branches the server pushed for earlier runs of this incident (their `pr-opened`, or a
 * `fixer-failed` with the partial branch it kept): a retry may rewrite its own branch, nothing else.
 */
export function pushedBranches(events: readonly IncidentEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.source !== 'fixer') continue;
    if (e.type === 'pr-opened') out.add(e.payload.branch);
    if (e.type === 'fixer-failed' && e.payload.partialBranch !== undefined) out.add(e.payload.partialBranch);
  }
  return [...out];
}

/** Longest refusal reason carried into a recorded failure. */
const MAX_NOTE = 500;

export function createFixerReporter(deps: FixerReporterDeps): FixerReporter {
  const { state, clock } = deps;

  /**
   * Validates, then appends what `build` returns for the running run, re-deciding on a conflict.
   * `build` may return undefined to append nothing (`run-finished`).
   */
  async function report<T>(
    target: FixerTarget,
    parsed: Parsed<T>,
    build: (value: T, d: Extract<Decision, { ok: true }>) => NewEvent[] | undefined,
  ): Promise<{ ok: true; seq: number; runId: string; before: IncidentEvent[] } | Exclude<FixerReportResult, { ok: true }>> {
    if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error };
    let refusal: FixerRefusal = 'run-finished';
    let runId = '';
    const appended = await appendDecided(state, target.incidentId, (events) => {
      const d = decideReport(events, target.runId);
      if (!d.ok) {
        refusal = d.code;
        return undefined;
      }
      refusal = 'run-finished';
      runId = d.run.payload.runId;
      return build(parsed.value, d);
    });
    if (!appended.appended) return { ok: false, code: refusal };
    return { ok: true, seq: appended.seq, runId, before: appended.before };
  }

  function event<T extends EventType>(d: { workspaceId: string }, target: FixerTarget, type: T, payload: EventPayloads[T]): NewEvent {
    return newEvent({ workspaceId: d.workspaceId, clock }, target.incidentId, type, payload, { source: 'fixer' });
  }

  /** True while `runId` is still the incident's running run, with no stop and no end after it. */
  async function running(target: FixerTarget, runId: string): Promise<boolean> {
    const d = decideReport(await state.read(target.incidentId), target.runId);
    return d.ok && d.run.payload.runId === runId;
  }

  /**
   * A refused `done` or `failed` whose run already ended with that same report: the earlier call
   * appended it, so run the idempotent hook again in case that call died before it.
   */
  async function healDuplicate(
    target: FixerTarget,
    type: 'fixer-done' | 'fixer-failed',
    hook: ((ctx: FixerHookContext) => Promise<void>) | undefined,
  ): Promise<void> {
    if (hook === undefined) return;
    const events = await state.read(target.incidentId);
    const run = latest(events, 'fixer-started');
    if (run === undefined || (target.runId !== undefined && run.payload.runId !== target.runId)) return;
    const end = events.find((e) => e.seq > run.seq && (e.type === 'fixer-done' || e.type === 'fixer-failed' || e.type === 'stopped'));
    if (end?.type === type) await hook({ workItemId: target.workItemId, incidentId: target.incidentId, runId: run.payload.runId, seq: end.seq });
  }

  /** The running run a `done` or `failed` is about, or the refusal (healing a duplicate report first). */
  async function runOf(
    target: FixerTarget,
    type: 'fixer-done' | 'fixer-failed',
    hook: ((ctx: FixerHookContext) => Promise<void>) | undefined,
  ): Promise<{ ok: true; runId: string; events: IncidentEvent[] } | { ok: false; code: FixerRefusal }> {
    const events = await state.read(target.incidentId);
    const d = decideReport(events, target.runId);
    if (d.ok) return { ok: true, runId: d.run.payload.runId, events };
    if (d.code === 'run-finished') await healDuplicate(target, type, hook);
    return d;
  }

  return {
    async checkpoint(target, input) {
      const r = await report(target, parseCheckpointInput(input), (value, d) => [event(d, target, 'fixer-checkpoint', value)]);
      return r.ok ? { ok: true, seq: r.seq, runId: r.runId } : r;
    },

    async artifact(target, input) {
      const parsed = parseArtifactInput(input);
      if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error };
      const before = await state.read(target.incidentId);
      const d = decideReport(before, target.runId);
      if (!d.ok) return d;

      const { kind, body, contentType } = parsed.value;
      const previous = lastArtifactOf(before, kind);
      const put = await state.putArtifact({
        ...(previous === undefined ? {} : { id: previous.artifactId }),
        workspaceId: d.workspaceId,
        incidentId: target.incidentId,
        kind,
        contentType,
        body,
        createdBy: `fixer:${d.run.payload.runId}`,
      });
      const artifact: ArtifactRef = { artifactId: put.id, version: put.version };
      const r = await report(target, parsed, (_value, now) => [event(now, target, 'fixer-artifact', { kind, artifact })]);
      return r.ok ? { ok: true, seq: r.seq, runId: r.runId, artifact } : r;
    },

    async done(target, input) {
      const parsed = parseDoneInput(input);
      if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error };
      const run = await runOf(target, 'fixer-done', deps.onDone);
      if (!run.ok) return run;
      const { runId } = run;
      const { summary, testsAdded } = parsed.value;
      const h = await deps.handoff({ target, runId, outcome: 'done', summary, testsAdded, pushedBefore: pushedBranches(run.events), running: () => running(target, runId) });
      if (!h.ok) return h.code === 'stopped' ? { ok: false, code: 'run-finished' } : { ok: false, code: 'handoff-refused', reason: h.reason };
      const prNumber = h.prNumber;
      if (prNumber === undefined) throw new Error('fixer done: the hand-off opened no pull request');
      // The App opened it from the run's work branch into the base, so this holds unless GitHub disagrees.
      if (!(await deps.verifyPullRequest(target, { prNumber, branch: h.branch })).ok) return { ok: false, code: 'pr-mismatch' };
      const r = await report(target, parsed, (value, d) =>
        d.run.payload.runId !== runId
          ? undefined
          : [
              event(d, target, 'fixer-checkpoint', { phase: 'pushed', detail: `${h.branch}@${h.sha.slice(0, 12)}` }),
              event(d, target, 'fixer-checkpoint', { phase: 'pr-opened', detail: `#${prNumber}` }),
              event(d, target, 'fixer-done', { prNumber, branch: h.branch, summary: value.summary, testsAdded: value.testsAdded }),
              event(d, target, 'pr-opened', { prNumber, branch: h.branch }),
            ],
      );
      if (!r.ok) return r;
      // `seq` is the last event appended (`pr-opened`); `fixer-done` is the one before it.
      const ctx: FixerHookContext = { workItemId: target.workItemId, incidentId: target.incidentId, runId: r.runId, seq: r.seq - 1 };
      await deps.onDone?.(ctx);
      return { ok: true, seq: r.seq, runId: r.runId };
    },

    async failed(target, input) {
      const parsed = parseFailedInput(input);
      if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error };
      const run = await runOf(target, 'fixer-failed', deps.onFailed);
      if (!run.ok) return run;
      const { runId } = run;
      const { partialBranch, ...failure } = parsed.value;
      let kept: { branch: string; sha: string } | undefined;
      if (partialBranch !== undefined) {
        const h = await deps.handoff({ target, runId, outcome: 'failed', summary: failure.reason, testsAdded: [], pushedBefore: pushedBranches(run.events), running: () => running(target, runId) });
        if (h.ok) kept = h;
        else if (h.code === 'stopped') return { ok: false, code: 'run-finished' };
        else failure.reason = `${failure.reason} (the partial work was not kept: ${h.reason.slice(0, MAX_NOTE)})`;
      }
      const r = await report(target, parsed, (_value, d) =>
        d.run.payload.runId !== runId
          ? undefined
          : [
              ...(kept === undefined ? [] : [event(d, target, 'fixer-checkpoint', { phase: 'pushed', detail: `${kept.branch}@${kept.sha.slice(0, 12)}` })]),
              event(d, target, 'fixer-failed', { ...failure, ...(kept === undefined ? {} : { partialBranch: kept.branch }) }),
            ],
      );
      if (!r.ok) return r;
      await deps.onFailed?.({ workItemId: target.workItemId, incidentId: target.incidentId, runId: r.runId, seq: r.seq });
      return { ok: true, seq: r.seq, runId: r.runId };
    },

    async stop(target) {
      const events = await state.read(target.incidentId);
      // A token of an earlier run learns that its run is over.
      if (target.runId !== undefined && latest(events, 'fixer-started')?.payload.runId !== target.runId && events.length > 0) return { ok: false, code: 'run-finished' };
      if (stopPending(events)) return { ok: true, stop: true };
      const d = decideReport(events);
      return d.ok || d.code === 'run-finished' ? { ok: true, stop: false } : d;
    },
  };
}

// Private ----------------------------------------------------------------------------------------

function statusOf(events: readonly IncidentEvent[]): LifecycleStatus {
  return events.reduce<LifecycleStatus>((status, e) => nextStatus(status, e), INITIAL_STATUS);
}

function lastArtifactOf(events: readonly IncidentEvent[], kind: 'diagnosis' | 'contract'): ArtifactRef | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'fixer-artifact' && e.payload.kind === kind) return e.payload.artifact;
  }
  return undefined;
}
