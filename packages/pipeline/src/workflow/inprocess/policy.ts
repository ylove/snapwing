// Scheduling policy for the in-process WorkflowPort (B 2, B 5, ADR 0012), kept apart from the SQL so
// another WorkflowPort implementation can mirror the same defaults and keys.

import type { JobName } from '../../contracts/jobs.ts';
import { keySegment } from '../../contracts/jobs.ts';

/** `start` without `retryLimit`, and every `schedule` and `cron` job: no retries (the jobs table default). */
export const DEFAULT_RETRY_LIMIT = 0;
/** `work` without `concurrency`. */
export const DEFAULT_CONCURRENCY = 1;
/** Delay before the first retry; also the fixed delay when `retryBackoff` is off. */
export const RETRY_DELAY_MS = 1_000;
/** Ceiling for exponential backoff. */
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
/** Concurrency of the built-in `timer.wait-timeout` worker. */
export const WAIT_TIMEOUT_CONCURRENCY = 4;

/** The job `park` schedules for a timeout. The scheduler runs it itself; `work` refuses it. */
export const WAIT_TIMEOUT_JOB: JobName = 'timer.wait-timeout';

/**
 * Milliseconds to wait before the next attempt, given how many retries already ran (0 before the
 * first retry). With backoff: 1 s, 2 s, 4 s, and so on up to one hour. Without: 1 s every time.
 */
export function retryDelayMs(retriesSoFar: number, backoff: boolean): number {
  if (!backoff) {
    return RETRY_DELAY_MS;
  }
  return Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** Math.min(retriesSoFar, 32));
}

/**
 * Reserved prefix for cron schedule rows. A schedule is one row keyed `cron:{name}`; user singleton
 * keys may not start with it.
 */
export const CRON_KEY_PREFIX = 'cron:';

export function cronKey(name: JobName): string {
  return CRON_KEY_PREFIX + keySegment(name);
}

/** Payload of a `timer.wait-timeout` job: the parked job and the wait it times out. */
export interface WaitTimeoutData {
  jobId: string;
  /** `waitKeyString(waitingOn)`; a timer left over from an earlier park on another key is a no-op. */
  waitKey: string;
}

export function isWaitTimeoutData(x: unknown): x is WaitTimeoutData {
  if (typeof x !== 'object' || x === null) {
    return false;
  }
  const r = x as Record<string, unknown>;
  return typeof r['jobId'] === 'string' && typeof r['waitKey'] === 'string';
}

/** Payload of a cron schedule row. */
export interface CronRowData {
  expression: string;
  input: unknown;
}
