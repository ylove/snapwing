// src/harness/contract.ts: validators for untrusted harness output (main 14.5, docs/harness-generic.md).
// A harness is a third-party process. Nothing it prints reaches a stage, an event, or the API until it
// has passed through parseHarnessResult (stdout) or parseCheckpointLine (one stderr line). Both build a
// fresh object holding only the known fields, so unknown keys are dropped and never forwarded.

import type { HarnessCheckpoint, HarnessPhase, HarnessResult } from '../ports/harness.ts';

/** Checkpoint phases in the order a run moves through them (B 9). */
export const HARNESS_PHASES: readonly HarnessPhase[] = Object.freeze([
  'cloned',
  'branched',
  'implemented',
  'tested',
  'pushed',
  'pr-opened',
]);

/** Largest stdout payload parseHarnessResult accepts, in UTF-16 code units. */
export const MAX_RESULT_LENGTH = 1024 * 1024;

/** Largest stderr line parseCheckpointLine treats as a checkpoint candidate. */
export const MAX_CHECKPOINT_LINE_LENGTH = 64 * 1024;

export type HarnessContractErrorCode =
  | 'empty' // stdout was empty or whitespace
  | 'too-large' // over MAX_RESULT_LENGTH or MAX_CHECKPOINT_LINE_LENGTH
  | 'not-json' // stdout did not parse as JSON
  | 'not-object' // parsed, but not a JSON object
  | 'unknown-outcome' // `outcome` missing or not one of done, failed, stopped
  | 'unknown-phase' // `phase` or `atPhase` not one of HARNESS_PHASES
  | 'invalid-field'; // a known field is missing or has the wrong type

export interface HarnessContractError {
  code: HarnessContractErrorCode;
  /** Human-readable, safe to log; never echoes more than a short prefix of the input. */
  message: string;
  /** The offending field (`branch`, `testsAdded[2]`), when there is one. */
  field?: string;
}

export type HarnessResultParse = { ok: true; result: HarnessResult } | { ok: false; error: HarnessContractError };

/**
 * One stderr line: a checkpoint, noise to ignore (log output, blank lines, JSON without a `phase`
 * key), or a malformed checkpoint (a JSON object with a `phase` key that fails validation).
 */
export type CheckpointLineParse =
  | { kind: 'checkpoint'; checkpoint: HarnessCheckpoint }
  | { kind: 'noise' }
  | { kind: 'error'; error: HarnessContractError };

const OUTCOMES = new Set<string>(['done', 'failed', 'stopped']);

export function isHarnessPhase(v: unknown): v is HarnessPhase {
  return typeof v === 'string' && (HARNESS_PHASES as readonly string[]).includes(v);
}

/** Validates the generic harness stdout: exactly one JSON object matching HarnessResult. */
export function parseHarnessResult(stdout: string): HarnessResultParse {
  if (stdout.length > MAX_RESULT_LENGTH) {
    return fail('too-large', `result is ${stdout.length} characters; the limit is ${MAX_RESULT_LENGTH}`);
  }
  const text = stripBom(stdout).trim();
  if (text === '') return fail('empty', 'stdout is empty; expected one JSON object');

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('not-json', `stdout is not JSON: ${preview(text)}`);
  }
  if (!isRecord(value)) return fail('not-object', `stdout is JSON but not an object: ${preview(text)}`);

  const outcome = value['outcome'];
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    return fail('unknown-outcome', `outcome must be one of done, failed, stopped; got ${describe(outcome)}`, 'outcome');
  }

  try {
    switch (outcome) {
      case 'done':
        return { ok: true, result: parseDone(value) };
      case 'failed':
        return { ok: true, result: parseFailed(value) };
      default:
        return { ok: true, result: parseStopped(value) };
    }
  } catch (e) {
    if (e instanceof FieldError) return { ok: false, error: e.toContractError() };
    throw e;
  }
}

/** Classifies one stderr line. Never throws; noise is the common case and is not an error. */
export function parseCheckpointLine(line: string): CheckpointLineParse {
  const text = stripBom(line).trim();
  if (!text.startsWith('{')) return NOISE;
  if (text.length > MAX_CHECKPOINT_LINE_LENGTH) {
    return {
      kind: 'error',
      error: { code: 'too-large', message: `line is ${text.length} characters; the limit is ${MAX_CHECKPOINT_LINE_LENGTH}` },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NOISE;
  }
  if (!isRecord(value) || !Object.hasOwn(value, 'phase')) return NOISE;

  const phase = value['phase'];
  if (!isHarnessPhase(phase)) {
    return {
      kind: 'error',
      error: { code: 'unknown-phase', message: `phase must be one of ${HARNESS_PHASES.join(', ')}; got ${describe(phase)}`, field: 'phase' },
    };
  }
  try {
    const detail = optionalString(value, 'detail');
    return { kind: 'checkpoint', checkpoint: detail === undefined ? { phase } : { phase, detail } };
  } catch (e) {
    if (e instanceof FieldError) return { kind: 'error', error: e.toContractError() };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------

const NOISE: CheckpointLineParse = Object.freeze({ kind: 'noise' as const });

class FieldError extends Error {
  readonly code: HarnessContractErrorCode;
  readonly field: string;

  constructor(code: HarnessContractErrorCode, field: string, message: string) {
    super(message);
    this.name = 'FieldError';
    this.code = code;
    this.field = field;
  }

  toContractError(): HarnessContractError {
    return { code: this.code, message: this.message, field: this.field };
  }
}

function parseDone(v: Record<string, unknown>): HarnessResult {
  const branch = requiredString(v, 'branch');
  const summary = requiredString(v, 'summary', { allowEmpty: true });
  const testsAdded = stringArray(v, 'testsAdded');
  const prNumber = optionalPositiveInt(v, 'prNumber');
  return prNumber === undefined
    ? { outcome: 'done', branch, summary, testsAdded }
    : { outcome: 'done', branch, prNumber, summary, testsAdded };
}

function parseFailed(v: Record<string, unknown>): HarnessResult {
  const reason = requiredString(v, 'reason');
  const attempts = nonNegativeInt(v, 'attempts');
  const partialBranch = optionalString(v, 'partialBranch', { allowEmpty: false });
  return partialBranch === undefined
    ? { outcome: 'failed', reason, attempts }
    : { outcome: 'failed', reason, partialBranch, attempts };
}

function parseStopped(v: Record<string, unknown>): HarnessResult {
  const atPhase = v['atPhase'];
  if (!isHarnessPhase(atPhase)) {
    throw new FieldError('unknown-phase', 'atPhase', `atPhase must be one of ${HARNESS_PHASES.join(', ')}; got ${describe(atPhase)}`);
  }
  return { outcome: 'stopped', atPhase };
}

function requiredString(v: Record<string, unknown>, field: string, opts: { allowEmpty?: boolean } = {}): string {
  const x = v[field];
  if (typeof x !== 'string') throw new FieldError('invalid-field', field, `${field} must be a string; got ${describe(x)}`);
  if (!opts.allowEmpty && x.trim() === '') throw new FieldError('invalid-field', field, `${field} must not be empty`);
  return x;
}

/** Absent and JSON `null` both mean "not given"; JSON has no undefined. */
function optionalString(v: Record<string, unknown>, field: string, opts: { allowEmpty?: boolean } = { allowEmpty: true }): string | undefined {
  const x = v[field];
  if (x === undefined || x === null) return undefined;
  return requiredString(v, field, opts);
}

function optionalPositiveInt(v: Record<string, unknown>, field: string): number | undefined {
  const x = v[field];
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 1) {
    throw new FieldError('invalid-field', field, `${field} must be a positive integer; got ${describe(x)}`);
  }
  return x;
}

function nonNegativeInt(v: Record<string, unknown>, field: string): number {
  const x = v[field];
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) {
    throw new FieldError('invalid-field', field, `${field} must be a non-negative integer; got ${describe(x)}`);
  }
  return x;
}

function stringArray(v: Record<string, unknown>, field: string): string[] {
  const x = v[field];
  if (!Array.isArray(x)) throw new FieldError('invalid-field', field, `${field} must be an array of strings; got ${describe(x)}`);
  const out: string[] = [];
  for (const [i, item] of x.entries()) {
    if (typeof item !== 'string') {
      throw new FieldError('invalid-field', `${field}[${i}]`, `${field}[${i}] must be a string; got ${describe(item)}`);
    }
    out.push(item);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(code: HarnessContractErrorCode, message: string, field?: string): HarnessResultParse {
  return { ok: false, error: field === undefined ? { code, message } : { code, message, field } };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function describe(x: unknown): string {
  if (x === undefined) return 'nothing';
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'an array';
  if (typeof x === 'string') return JSON.stringify(x.length > 40 ? `${x.slice(0, 40)}...` : x);
  if (typeof x === 'object') return 'an object';
  return `${typeof x} ${String(x)}`;
}

function preview(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}
