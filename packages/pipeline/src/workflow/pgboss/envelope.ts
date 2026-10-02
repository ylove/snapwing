// What PgBossWorkflow stores in a pg-boss job's `data` column. pg-boss issues a fresh row id (a
// uuid) for every row, so the logical `Job.id` (a ULID) travels in the payload and survives park,
// resume, and re-enqueue (ADR 0012, delivery). The scheduling policy (defaults, reserved keys, the
// wait-timeout job) is the in-process scheduler's, in ../inprocess/policy.ts.

import type { ResumeDelivery } from '../../contracts/jobs.ts';
import { CRON_KEY_PREFIX, MAX_RETRY_DELAY_MS, RETRY_DELAY_MS } from '../inprocess/policy.ts';

/**
 * Run time of a parked job's row. A parked job is a `created` pg-boss row that is never due; resume
 * moves its run time to now. pg-boss adds the queue's retention to it for `keep_until`, which stays
 * far inside the range of `timestamptz`.
 */
export const PARKED_UNTIL = new Date('9000-01-01T00:00:00.000Z');

/** The `data` of every pg-boss row this workflow writes. */
export interface Envelope {
  readonly v: 1;
  /** Logical job id. Absent only on rows a cron schedule created (see `cronJobId`). */
  readonly id?: string;
  /** The `input` given to start, schedule, or cron (`undefined` is stored as `null`). */
  readonly data: unknown;
  /** Attempt number of this row's first delivery; a row's retries add pg-boss `retry_count`. Default 1. */
  readonly attempt?: number;
  /** The logical singleton key, also kept on the row's `singleton_key`. */
  readonly singletonKey?: string;
  /** Set on a parked job's row. */
  readonly parked?: true;
  /** Set on a row re-enqueued by resume or a timeout. */
  readonly resumed?: ResumeDelivery;
}

export function envelope(fields: Omit<Envelope, 'v'>): Envelope {
  const out: { -readonly [K in keyof Envelope]: Envelope[K] } = { v: 1, data: fields.data ?? null };
  if (fields.id !== undefined) out.id = fields.id;
  if (fields.attempt !== undefined && fields.attempt !== 1) out.attempt = fields.attempt;
  if (fields.singletonKey !== undefined) out.singletonKey = fields.singletonKey;
  if (fields.parked === true) out.parked = true;
  if (fields.resumed !== undefined) out.resumed = fields.resumed;
  return out;
}

/** Reads a row's `data`. A row this workflow did not write is delivered as plain data. */
export function decodeEnvelope(raw: unknown): Envelope {
  if (typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 1 && 'data' in raw) {
    const r = raw as Record<string, unknown>;
    const fields: { -readonly [K in keyof Envelope]: Envelope[K] } = { v: 1, data: r['data'] };
    if (typeof r['id'] === 'string') fields.id = r['id'];
    if (typeof r['attempt'] === 'number') fields.attempt = r['attempt'];
    if (typeof r['singletonKey'] === 'string') fields.singletonKey = r['singletonKey'];
    if (r['parked'] === true) fields.parked = true;
    if (typeof r['resumed'] === 'object' && r['resumed'] !== null && 'result' in r['resumed']) {
      fields.resumed = { result: (r['resumed'] as { result: unknown }).result };
    }
    return fields;
  }
  return { v: 1, data: raw ?? null };
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Logical id for a row a cron schedule created, which carries no id of its own: a ULID whose time
 * part is the row's `created_on` and whose random part is the low 80 bits of the row's uuid. Stable
 * across the row's retries, so every delivery of one cron run has the same `Job.id`.
 */
export function cronJobId(rowId: string, createdOn: Date): string {
  const hex = rowId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TypeError(`not a uuid: ${rowId}`);
  }
  let time = Math.min(Math.max(Math.floor(createdOn.getTime()), 0), 2 ** 48 - 1);
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ALPHABET.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  let rand = BigInt(`0x${hex}`) & ((1n << 80n) - 1n);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart = ALPHABET.charAt(Number(rand & 31n)) + randPart;
    rand >>= 5n;
  }
  return timePart + randPart;
}

/** pg-boss `retryDelay`: the in-process scheduler's first retry delay, in seconds. */
export const RETRY_DELAY_SECONDS = RETRY_DELAY_MS / 1_000;
/** pg-boss `retryDelayMax`: the in-process scheduler's backoff ceiling, in seconds. */
export const MAX_RETRY_DELAY_SECONDS = MAX_RETRY_DELAY_MS / 1_000;

/** Same rule as the in-process scheduler: no empty key, and none under its reserved cron prefix. */
export function assertUserKey(key: string | undefined): void {
  if (key === undefined) {
    return;
  }
  if (key === '') {
    throw new Error('singletonKey must not be empty');
  }
  if (key.startsWith(CRON_KEY_PREFIX)) {
    throw new Error(`singletonKey ${JSON.stringify(key)} uses the reserved prefix ${CRON_KEY_PREFIX}`);
  }
}

/** Advisory lock key that serializes writers of one singleton key (shared with the in-process scheduler). */
export function singletonLockKey(key: string): string {
  return `snapwing.jobs:${key}`;
}

