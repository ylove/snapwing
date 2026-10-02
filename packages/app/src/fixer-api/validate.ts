// src/fixer-api/validate.ts: validators for the four fixer reports (B 9). What a fixer sends is
// harness output and therefore untrusted (main 14.5): each validator takes `unknown`, checks every
// known field's type and size, and builds a fresh object from the known fields only, so unknown keys
// are dropped and never reach an event. Error messages name the field and never echo its value.

import type { FixerCheckpointPayload, FixerDonePayload, FixerFailedPayload } from '@snapwing/pipeline/contracts/events.ts';
import type { ArtifactContentType } from '@snapwing/pipeline/contracts/state.ts';
import { HARNESS_PHASES, isHarnessPhase } from '@snapwing/pipeline/harness/contract.ts';

export const MAX_DETAIL_LENGTH = 4096;
export const MAX_REASON_LENGTH = 4096;
export const MAX_SUMMARY_LENGTH = 16 * 1024;
export const MAX_ARTIFACT_BODY_LENGTH = 1024 * 1024;
export const MAX_BRANCH_LENGTH = 255;
export const MAX_TESTS_ADDED = 500;
export const MAX_PATH_LENGTH = 1024;
export const MAX_ATTEMPTS = 1000;

export type FixerArtifactKind = 'diagnosis' | 'contract';
const ARTIFACT_KINDS: readonly FixerArtifactKind[] = ['diagnosis', 'contract'];
const CONTENT_TYPES: readonly ArtifactContentType[] = ['application/xml', 'application/json'];

/** `POST /fixer/{id}/artifact`, validated. The body becomes an artifact version before the event. */
export interface FixerArtifactInput {
  kind: FixerArtifactKind;
  body: string;
  /** Default `application/xml`. */
  contentType: ArtifactContentType;
}

export interface FixerInputError {
  /** The offending field, or `body` for the request as a whole. */
  field: string;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: FixerInputError };

export function parseCheckpointInput(input: unknown): Parsed<FixerCheckpointPayload> {
  return run(input, (v) => {
    const phase = v['phase'];
    if (!isHarnessPhase(phase)) throw new FieldError('phase', `must be one of ${HARNESS_PHASES.join(', ')}`);
    return { phase, detail: optionalString(v, 'detail', MAX_DETAIL_LENGTH) ?? '' };
  });
}

export function parseArtifactInput(input: unknown): Parsed<FixerArtifactInput> {
  return run(input, (v) => {
    const kind = v['kind'];
    if (typeof kind !== 'string' || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
      throw new FieldError('kind', `must be one of ${ARTIFACT_KINDS.join(', ')}`);
    }
    const body = requiredString(v, 'body', MAX_ARTIFACT_BODY_LENGTH);
    const contentType = optionalString(v, 'contentType', 64) ?? 'application/xml';
    if (!(CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new FieldError('contentType', `must be one of ${CONTENT_TYPES.join(', ')}`);
    }
    return { kind: kind as FixerArtifactKind, body, contentType: contentType as ArtifactContentType };
  });
}

export function parseDoneInput(input: unknown): Parsed<FixerDonePayload> {
  return run(input, (v) => {
    const prNumber = v['prNumber'];
    if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber < 1) {
      throw new FieldError('prNumber', 'must be a positive integer');
    }
    const branch = branchName(v, 'branch');
    if (branch === undefined) throw new FieldError('branch', 'is required');
    const summary = optionalString(v, 'summary', MAX_SUMMARY_LENGTH) ?? '';
    return { prNumber, branch, summary, testsAdded: testsAdded(v) };
  });
}

export function parseFailedInput(input: unknown): Parsed<FixerFailedPayload> {
  return run(input, (v) => {
    const reason = requiredString(v, 'reason', MAX_REASON_LENGTH);
    const attempts = v['attempts'];
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > MAX_ATTEMPTS) {
      throw new FieldError('attempts', `must be an integer from 0 to ${MAX_ATTEMPTS}`);
    }
    const partialBranch = branchName(v, 'partialBranch');
    return { reason, attempts, ...(partialBranch === undefined ? {} : { partialBranch }) };
  });
}

// Private ----------------------------------------------------------------------------------------

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'FieldError';
  }
}

function run<T>(input: unknown, build: (v: Record<string, unknown>) => T): Parsed<T> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: { field: 'body', message: 'must be a JSON object' } };
  }
  try {
    return { ok: true, value: build(input as Record<string, unknown>) };
  } catch (e) {
    if (e instanceof FieldError) return { ok: false, error: { field: e.field, message: `${e.field} ${e.message}` } };
    throw e;
  }
}

function own(v: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(v, key) ? v[key] : undefined;
}

function requiredString(v: Record<string, unknown>, key: string, max: number): string {
  const s = optionalString(v, key, max);
  if (s === undefined || s.trim() === '') throw new FieldError(key, 'is required');
  return s;
}

/** Absent and null both mean absent. */
function optionalString(v: Record<string, unknown>, key: string, max: number): string | undefined {
  const s = own(v, key);
  if (s === undefined || s === null) return undefined;
  if (typeof s !== 'string') throw new FieldError(key, 'must be a string');
  if (s.length > max) throw new FieldError(key, `must be at most ${max} characters`);
  return s;
}

/**
 * A branch name, checked loosely against git's rules (no whitespace, control characters, `~^:?*[\`,
 * or `..`), since it reaches GitHub calls (main 10.4's `fixer-incomplete` draft PR).
 */
function branchName(v: Record<string, unknown>, key: string): string | undefined {
  const s = optionalString(v, key, MAX_BRANCH_LENGTH);
  if (s === undefined || s === '') return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(s) || s.includes('..') || s.startsWith('-') || s.startsWith('/') || s.endsWith('/')) {
    throw new FieldError(key, 'is not a valid branch name');
  }
  return s;
}

function testsAdded(v: Record<string, unknown>): string[] {
  const list = own(v, 'testsAdded');
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new FieldError('testsAdded', 'must be an array of file paths');
  if (list.length > MAX_TESTS_ADDED) throw new FieldError('testsAdded', `must have at most ${MAX_TESTS_ADDED} entries`);
  return list.map((p: unknown, i) => {
    if (typeof p !== 'string' || p.trim() === '' || p.length > MAX_PATH_LENGTH) {
      throw new FieldError(`testsAdded[${i}]`, `must be a file path of at most ${MAX_PATH_LENGTH} characters`);
    }
    return p;
  });
}
