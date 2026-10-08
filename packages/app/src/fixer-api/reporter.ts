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
//     `stopped`, or there is none (`run-finished`).
//
//   checkpoint   appends `fixer-checkpoint { phase, detail }`.
//   artifact     stores the body as a new version of the incident's artifact of that kind (version 1
//                when there is none yet), then appends `fixer-artifact { kind, artifact }`. When the
//                append is refused after the store, the version stays unreferenced.
//   done         appends `fixer-done` and `pr-opened` together, then calls `onDone`.
//   failed       appends `fixer-failed`, then calls `onFailed`.
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
}

export type FixerRefusal = 'unknown-incident' | 'incident-closed' | 'run-finished';

export type FixerReportResult =
  | { ok: true; seq: number; runId: string }
  | { ok: false; code: 'invalid'; error: FixerInputError }
  | { ok: false; code: FixerRefusal };

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
  onDone?: (ctx: FixerHookContext) => Promise<void>;
  onFailed?: (ctx: FixerHookContext) => Promise<void>;
}

export interface FixerReporter {
  checkpoint(target: FixerTarget, input: unknown): Promise<FixerReportResult>;
  artifact(target: FixerTarget, input: unknown): Promise<FixerArtifactResult>;
  done(target: FixerTarget, input: unknown): Promise<FixerReportResult>;
  failed(target: FixerTarget, input: unknown): Promise<FixerReportResult>;
  stop(target: FixerTarget): Promise<FixerStopResult>;
}

type Decision = { ok: true; run: IncidentEvent<'fixer-started'>; workspaceId: string } | { ok: false; code: FixerRefusal };

/** Whether a fixer may report on this log right now. */
export function decideReport(events: readonly IncidentEvent[]): Decision {
  const first = events[0];
  if (first === undefined) return { ok: false, code: 'unknown-incident' };
  if (isTerminalStatus(statusOf(events))) return { ok: false, code: 'incident-closed' };
  const run = activeRun(events);
  if (run === undefined) return { ok: false, code: 'run-finished' };
  return { ok: true, run, workspaceId: first.workspaceId };
}

/** True when a `stopped` follows the latest `fixer-started` (B 9 stop poll). */
export function stopPending(events: readonly IncidentEvent[]): boolean {
  const run = latest(events, 'fixer-started');
  return run !== undefined && events.some((e) => e.seq > run.seq && e.type === 'stopped');
}

export function createFixerReporter(deps: FixerReporterDeps): FixerReporter {
  const { state, clock } = deps;

  /** Validates, then appends what `build` returns for the running run, re-deciding on a conflict. */
  async function report<T>(
    target: FixerTarget,
    parsed: Parsed<T>,
    build: (value: T, d: Extract<Decision, { ok: true }>) => NewEvent[],
  ): Promise<{ ok: true; seq: number; runId: string; before: IncidentEvent[] } | Exclude<FixerReportResult, { ok: true }>> {
    if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error };
    let refusal: FixerRefusal = 'run-finished';
    let runId = '';
    const appended = await appendDecided(state, target.incidentId, (events) => {
      const d = decideReport(events);
      if (!d.ok) {
        refusal = d.code;
        return undefined;
      }
      runId = d.run.payload.runId;
      return build(parsed.value, d);
    });
    if (!appended.appended) return { ok: false, code: refusal };
    return { ok: true, seq: appended.seq, runId, before: appended.before };
  }

  function event<T extends EventType>(d: { workspaceId: string }, target: FixerTarget, type: T, payload: EventPayloads[T]): NewEvent {
    return newEvent({ workspaceId: d.workspaceId, clock }, target.incidentId, type, payload, { source: 'fixer' });
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
    if (run === undefined) return;
    const end = events.find((e) => e.seq > run.seq && (e.type === 'fixer-done' || e.type === 'fixer-failed' || e.type === 'stopped'));
    if (end?.type === type) await hook({ workItemId: target.workItemId, incidentId: target.incidentId, runId: run.payload.runId, seq: end.seq });
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
      const d = decideReport(before);
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
      const r = await report(target, parseDoneInput(input), (value, d) => [
        event(d, target, 'fixer-done', value),
        event(d, target, 'pr-opened', { prNumber: value.prNumber, branch: value.branch }),
      ]);
      if (!r.ok) {
        if (r.code === 'run-finished') await healDuplicate(target, 'fixer-done', deps.onDone);
        return r;
      }
      // `seq` is the last event appended (`pr-opened`); `fixer-done` is the one before it.
      const ctx: FixerHookContext = { workItemId: target.workItemId, incidentId: target.incidentId, runId: r.runId, seq: r.seq - 1 };
      await deps.onDone?.(ctx);
      return { ok: true, seq: r.seq, runId: r.runId };
    },

    async failed(target, input) {
      const r = await report(target, parseFailedInput(input), (value, d) => [event(d, target, 'fixer-failed', value)]);
      if (!r.ok) {
        if (r.code === 'run-finished') await healDuplicate(target, 'fixer-failed', deps.onFailed);
        return r;
      }
      await deps.onFailed?.({ workItemId: target.workItemId, incidentId: target.incidentId, runId: r.runId, seq: r.seq });
      return { ok: true, seq: r.seq, runId: r.runId };
    },

    async stop(target) {
      const events = await state.read(target.incidentId);
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
