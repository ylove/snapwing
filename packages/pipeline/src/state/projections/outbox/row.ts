// Building outbox rows from an event, for the per-target modules in this directory. Pure: the id,
// `createdAt`, and `nextAttempt` come from the event, so the same event always implies the same rows
// (B 4; rebuild never calls this, #89, but a test or `jira reproject` may).

import { createHash } from 'node:crypto';
import type { IncidentEvent } from '../../../contracts/events.ts';
import { OUTBOX_TARGETS, type OutboxItem, type OutboxOp, type OutboxTarget } from '../../../contracts/state.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;

/** `value` as `len` Crockford base32 digits, most significant first. Throws when it does not fit. */
function base32(value: number, len: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 32 ** len) {
    throw new RangeError(`outbox row id: ${String(value)} does not fit ${String(len)} base32 digits`);
  }
  let out = '';
  let v = value;
  for (let i = 0; i < len; i++) {
    out = ALPHABET.charAt(v % 32) + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/**
 * A ULID derived from the event: the time part is `recordedAt`; the 16 random digits are 6 from a
 * hash of the incident id, then the seq (7), the target (1), and the row's index among the event's
 * rows for that target (2). Rows from one event therefore sort in the order the module returned them,
 * which is the order the drain sends rows with the same `createdAt` (outbox.ts orders by id next).
 */
export function outboxRowId(event: IncidentEvent, target: OutboxTarget, index: number): string {
  const time = Date.parse(event.recordedAt);
  if (!Number.isFinite(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`outbox row id: event ${event.incidentId}#${String(event.seq)} has no usable recordedAt (${event.recordedAt})`);
  }
  const digest = createHash('sha256').update(event.incidentId).digest();
  const incident = Array.from(digest.subarray(0, 6), (b) => ALPHABET.charAt(b & 31)).join('');
  return base32(time, 10) + incident + base32(event.seq, 7) + base32(OUTBOX_TARGETS.indexOf(target), 1) + base32(index, 2);
}

/** What a target module decides for one row; `rowsFor` fills in the rest. */
export interface RowSpec {
  op: OutboxOp;
  payload: Record<string, unknown>;
  batchKey?: string;
}

/** The outbox items for `specs`, in order, with ids and times from `event`. */
export function rowsFor(event: IncidentEvent, target: OutboxTarget, specs: readonly RowSpec[]): OutboxItem[] {
  return specs.map((spec, index) => ({
    id: outboxRowId(event, target, index),
    workspaceId: event.workspaceId,
    target,
    incidentId: event.incidentId,
    op: spec.op,
    payload: spec.payload,
    ...(spec.batchKey === undefined ? {} : { batchKey: spec.batchKey }),
    attempts: 0,
    nextAttempt: event.recordedAt,
    createdAt: event.recordedAt,
  }));
}
