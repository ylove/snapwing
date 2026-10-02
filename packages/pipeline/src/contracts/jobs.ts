// Job contracts for the WorkflowPort (Companion B 1) and the durable timers (Companion B 5).
// Interface and helpers only; implementations live in pipeline/src/workflow/{inprocess,pgboss}.

/** Every durable job the workflow port knows how to run. */
export type JobName =
  // Pipeline work
  | 'incident.process'
  | 'fixer.run'
  | 'merge.evaluate'
  | 'reconcile'
  // Durable timers, one per row of the B 5 table (see TIMER_JOBS)
  | 'timer.wait-timeout'
  | 'timer.claim-nudge'
  | 'timer.claim-expiry'
  | 'timer.hold'
  | 'timer.stall'
  | 'timer.heartbeat'
  | 'timer.escalate'
  | 'timer.revert'
  | 'timer.fixer-budget';

export const JOB_NAMES: readonly JobName[] = [
  'incident.process',
  'fixer.run',
  'merge.evaluate',
  'reconcile',
  'timer.wait-timeout',
  'timer.claim-nudge',
  'timer.claim-expiry',
  'timer.hold',
  'timer.stall',
  'timer.heartbeat',
  'timer.escalate',
  'timer.revert',
  'timer.fixer-budget',
];

/**
 * Present on a delivery that follows `WorkflowPort.resume` or a park timeout (ADR 0012).
 * `result` is the value passed to `resume`, or `{ timedOut: true }` when the timeout fired first.
 */
export interface ResumeDelivery {
  result: unknown;
}

/** One delivery of a job to its handler. */
export interface Job<T = unknown> {
  /** Logical job id (ULID). Stable across retries and across park and resume. */
  id: string;
  name: JobName;
  data: T;
  /** 1 on the first delivery; incremented only by retries after a failed handler, never by a resume. */
  attempt: number;
  singletonKey?: string;
  resumed?: ResumeDelivery;
}

// Singleton keys ------------------------------------------------------------------------------

/**
 * Encodes one segment of a colon-separated key so that the joined key is unambiguous.
 * ULIDs, chat user ids, environment names, and commit SHAs pass through unchanged;
 * a colon or percent sign inside a segment is percent-encoded.
 */
export function keySegment(value: string | number): string {
  const s = String(value);
  if (s.length === 0) {
    throw new Error('key segment must not be empty');
  }
  return encodeURIComponent(s);
}

/** Inverse of keySegment. */
export function decodeKeySegment(segment: string): string {
  return decodeURIComponent(segment);
}

/** Parameters for each durable timer in the B 5 table, keyed by the key's prefix. */
export interface TimerParams {
  /** Interactive timeout: the park timeout of a `tap` wait. */
  tap: { eventId: string };
  'claim-nudge': { incidentId: string; userId: string };
  claim: { incidentId: string; userId: string };
  /** Environment hold nudge and expiry share one key; the job data says which phase fires. */
  hold: { incidentId: string; env: string };
  stall: { incidentId: string };
  heartbeat: { incidentId: string };
  escalate: { incidentId: string; step: string | number };
  revert: { incidentId: string };
  'fixer-budget': { incidentId: string };
}

export type TimerKind = keyof TimerParams;

/** The job each B 5 timer schedules. */
export const TIMER_JOBS: { readonly [K in TimerKind]: JobName } = {
  tap: 'timer.wait-timeout',
  'claim-nudge': 'timer.claim-nudge',
  claim: 'timer.claim-expiry',
  hold: 'timer.hold',
  stall: 'timer.stall',
  heartbeat: 'timer.heartbeat',
  escalate: 'timer.escalate',
  revert: 'timer.revert',
  'fixer-budget': 'timer.fixer-budget',
};

const TIMER_SEGMENTS: { readonly [K in TimerKind]: (p: TimerParams[K]) => readonly (string | number)[] } = {
  tap: (p) => [p.eventId],
  'claim-nudge': (p) => [p.incidentId, p.userId],
  claim: (p) => [p.incidentId, p.userId],
  hold: (p) => [p.incidentId, p.env],
  stall: (p) => [p.incidentId],
  heartbeat: (p) => [p.incidentId],
  escalate: (p) => [p.incidentId, p.step],
  revert: (p) => [p.incidentId],
  'fixer-budget': (p) => [p.incidentId],
};

/**
 * Builds the singleton key for a B 5 timer, for example `claim:{incident}:{user}`.
 * Scheduling with the same key replaces the pending timer rather than adding a second one.
 */
export function timerKey<K extends TimerKind>(kind: K, params: TimerParams[K]): string {
  const segments = (TIMER_SEGMENTS[kind] as (p: TimerParams[K]) => readonly (string | number)[])(params);
  return [kind, ...segments.map(keySegment)].join(':');
}
