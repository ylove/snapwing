// src/ports/workflow.ts (B 1). Storage and resume semantics: ADR 0012.

import type { Job, JobName } from '../contracts/jobs.ts';
import { decodeKeySegment, keySegment, timerKey } from '../contracts/jobs.ts';

export type { Job, JobName } from '../contracts/jobs.ts';

export interface WorkflowPort {
  // Durable jobs
  start(name: JobName, input: unknown, opts: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean }): Promise<{ jobId: string }>;
  schedule(name: JobName, input: unknown, runAt: Date, opts?: { singletonKey?: string }): Promise<{ jobId: string }>;
  cancel(singletonKey: string): Promise<void>;
  work(name: JobName, handler: (job: Job) => Promise<void>, opts?: { concurrency?: number }): void;

  // Parking and resuming (awaitInteractive, waiting on children, waiting on CI)
  park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void>;
  resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }>;

  // Recurring
  cron(name: JobName, expression: string, input?: unknown): Promise<void>;
}

export type WaitKey = { kind: 'tap'; eventId: string } | { kind: 'children'; parentId: string }
                    | { kind: 'ci'; prId: string } | { kind: 'deploy'; env: string; sha: string }
                    | { kind: 'verification'; incidentId: string };

export type WaitKind = WaitKey['kind'];

/** The result a parked job receives when its timeout fires before any resume (ADR 0012). */
export interface TimedOut {
  readonly timedOut: true;
}

export const TIMED_OUT: TimedOut = Object.freeze({ timedOut: true as const });

export function isTimedOut(result: unknown): result is TimedOut {
  return typeof result === 'object' && result !== null && (result as { timedOut?: unknown }).timedOut === true;
}

/**
 * Canonical string for a WaitKey, stored in `job_waits.wait_key` (ADR 0012).
 * Shape: `{kind}:{segment}[:{segment}]`, segments in a fixed order and encoded by keySegment,
 * so two equal WaitKeys always give the same string and two different ones never do.
 */
export function waitKeyString(k: WaitKey): string {
  switch (k.kind) {
    case 'tap':
      return join(k.kind, k.eventId);
    case 'children':
      return join(k.kind, k.parentId);
    case 'ci':
      return join(k.kind, k.prId);
    case 'deploy':
      return join(k.kind, k.env, k.sha);
    case 'verification':
      return join(k.kind, k.incidentId);
  }
}

/** Inverse of waitKeyString. Throws on a string that waitKeyString could not have produced. */
export function parseWaitKey(s: string): WaitKey {
  const [kind, ...rest] = s.split(':');
  const parts = rest.map(decodeKeySegment);
  const arity: Record<WaitKind, number> = { tap: 1, children: 1, ci: 1, deploy: 2, verification: 1 };
  if (kind === undefined || !(kind in arity) || parts.length !== arity[kind as WaitKind] || parts.some((p) => p === '')) {
    throw new Error(`not a canonical wait key: ${s}`);
  }
  const [a = '', b = ''] = parts;
  switch (kind as WaitKind) {
    case 'tap':
      return { kind: 'tap', eventId: a };
    case 'children':
      return { kind: 'children', parentId: a };
    case 'ci':
      return { kind: 'ci', prId: a };
    case 'deploy':
      return { kind: 'deploy', env: a, sha: b };
    case 'verification':
      return { kind: 'verification', incidentId: a };
  }
}

/**
 * Singleton key of the `timer.wait-timeout` job that `park` schedules when given a timeoutAt.
 * A `tap` wait uses the B 5 interactive timeout key `tap:{eventId}`; every other wait is keyed by
 * the parked job, `wait-timeout:{jobId}`, since several jobs may wait on the same key.
 */
export function waitTimeoutKey(jobId: string, waitingOn: WaitKey): string {
  return waitingOn.kind === 'tap' ? timerKey('tap', { eventId: waitingOn.eventId }) : join('wait-timeout', jobId);
}

function join(prefix: string, ...segments: string[]): string {
  return [prefix, ...segments.map(keySegment)].join(':');
}
