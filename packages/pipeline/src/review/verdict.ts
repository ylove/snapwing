// src/review/verdict.ts: the review agent's verdict contract (main 11.1, 14.5).
// The review agent writes JSON to SNAPWING_REVIEW_FILE. Nothing it wrote reaches a stage until
// parseReviewVerdict has built a fresh object holding only the known fields.
// checkConstraints is the mechanical half: it flags scope and forbidden-path violations from the diff
// file list so a model approval cannot override them (the review job turns a flag into request-changes).

import type { ImplementationRequest } from '../prompts/implementation-request.ts';

export type ReviewVerdictKind = 'approve' | 'request-changes' | 'escalate';

export const REVIEW_VERDICTS: readonly ReviewVerdictKind[] = Object.freeze(['approve', 'request-changes', 'escalate']);

/** Largest verdict file parseReviewVerdict accepts, in UTF-16 code units. */
export const MAX_VERDICT_LENGTH = 256 * 1024;

export interface ConstraintViolation {
  /** `scope`, `forbidden`, `tests`, or a short name the reviewer chose. */
  constraint: string;
  /** Repository-relative path, when the violation is about one file. */
  file?: string;
  note: string;
}

export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  reasons: string[];
  constraintViolations: ConstraintViolation[];
  regressionTest?: { path: string };
}

export type ReviewVerdictErrorCode = 'empty' | 'too-large' | 'not-json' | 'not-object' | 'unknown-verdict' | 'invalid-field';

export interface ReviewVerdictError {
  code: ReviewVerdictErrorCode;
  /** Human-readable, safe to log; never echoes more than a short prefix of the input. */
  message: string;
  field?: string;
}

export type ReviewVerdictParse = { ok: true; verdict: ReviewVerdict } | { ok: false; error: ReviewVerdictError };

/** Validates the verdict file: one JSON object. Unknown keys are dropped; failures are typed, never thrown. */
export function parseReviewVerdict(text: string): ReviewVerdictParse {
  if (text.length > MAX_VERDICT_LENGTH) {
    return fail('too-large', `verdict is ${text.length} characters; the limit is ${MAX_VERDICT_LENGTH}`);
  }
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  if (body === '') return fail('empty', 'verdict file is empty; expected one JSON object');

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return fail('not-json', `verdict is not JSON: ${preview(body)}`);
  }
  if (!isRecord(value)) return fail('not-object', `verdict is JSON but not an object: ${preview(body)}`);

  const kind = value['verdict'];
  if (typeof kind !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(kind)) {
    return fail('unknown-verdict', `verdict must be one of ${REVIEW_VERDICTS.join(', ')}; got ${describe(kind)}`, 'verdict');
  }

  const reasons = value['reasons'];
  if (!Array.isArray(reasons)) return fail('invalid-field', `reasons must be an array of strings; got ${describe(reasons)}`, 'reasons');
  const outReasons: string[] = [];
  for (const [i, r] of reasons.entries()) {
    if (typeof r !== 'string') return fail('invalid-field', `reasons[${i}] must be a string; got ${describe(r)}`, `reasons[${i}]`);
    outReasons.push(r);
  }
  if (kind !== 'approve' && outReasons.every((r) => r.trim() === '')) {
    return fail('invalid-field', `reasons must give at least one reason for ${kind}`, 'reasons');
  }

  const rawViolations = value['constraintViolations'] ?? [];
  if (!Array.isArray(rawViolations)) {
    return fail('invalid-field', `constraintViolations must be an array; got ${describe(rawViolations)}`, 'constraintViolations');
  }
  const violations: ConstraintViolation[] = [];
  for (const [i, raw] of rawViolations.entries()) {
    const at = `constraintViolations[${i}]`;
    if (!isRecord(raw)) return fail('invalid-field', `${at} must be an object; got ${describe(raw)}`, at);
    const constraint = raw['constraint'];
    if (typeof constraint !== 'string' || constraint.trim() === '') {
      return fail('invalid-field', `${at}.constraint must be a non-empty string; got ${describe(constraint)}`, `${at}.constraint`);
    }
    const note = raw['note'];
    if (typeof note !== 'string') return fail('invalid-field', `${at}.note must be a string; got ${describe(note)}`, `${at}.note`);
    const file = raw['file'];
    if (file !== undefined && file !== null && (typeof file !== 'string' || file.trim() === '')) {
      return fail('invalid-field', `${at}.file must be a non-empty string when given; got ${describe(file)}`, `${at}.file`);
    }
    violations.push(typeof file === 'string' ? { constraint, file, note } : { constraint, note });
  }

  const out: ReviewVerdict = { verdict: kind as ReviewVerdictKind, reasons: outReasons, constraintViolations: violations };
  const rt = value['regressionTest'];
  if (rt !== undefined && rt !== null) {
    if (!isRecord(rt)) return fail('invalid-field', `regressionTest must be an object; got ${describe(rt)}`, 'regressionTest');
    const path = rt['path'];
    if (typeof path !== 'string' || path.trim() === '') {
      return fail('invalid-field', `regressionTest.path must be a non-empty string; got ${describe(path)}`, 'regressionTest.path');
    }
    out.regressionTest = { path };
  }
  return { ok: true, verdict: out };
}

// ---------------------------------------------------------------------------------------------
// Mechanical constraint check.

/**
 * Flags changed files that match a `<forbidden>` path and changed files outside the request's
 * `<scope>`. Both elements are prose, so the check reads the path-like tokens in them (`src/cart`,
 * `src/promo/**`, `package.json`, `.github/workflows`) and ignores the rest: a constraint that names
 * no path ("Do not modify pricing rules") cannot be checked mechanically and flags nothing.
 *
 * - A token is a directory prefix, an exact file, or a glob (`*` within a segment, `**` across segments).
 * - When the request requires tests, test files (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`)
 *   are allowed outside scope; a forbidden token still applies to them.
 * - A parent request has no constraints of its own; its scope is the union of its work items' scopes.
 * - Paths are compared repository-relative with `/` separators, case-sensitively.
 */
export function checkConstraints(diffFiles: readonly string[], request: ImplementationRequest): ConstraintViolation[] {
  const scopeTexts: string[] = [];
  const forbiddenTexts: string[] = [];
  let testsRequired = false;
  if (request.kind === 'parent') {
    for (const wi of request.workItems) scopeTexts.push(wi.scope);
  } else {
    scopeTexts.push(request.constraints.scope);
    forbiddenTexts.push(...request.constraints.forbidden);
    testsRequired = request.constraints.tests.required;
  }

  const scope = scopeTexts.flatMap(pathTokens);
  const forbidden = forbiddenTexts.flatMap(pathTokens);
  const violations: ConstraintViolation[] = [];

  for (const raw of diffFiles) {
    const file = normalizePath(raw);
    const hit = forbidden.find((t) => matchesToken(file, t));
    if (hit !== undefined) {
      violations.push({ constraint: 'forbidden', file, note: `touches ${hit}, which the request forbids` });
      continue;
    }
    if (scope.length === 0) continue;
    if (scope.some((t) => matchesToken(file, t))) continue;
    if (testsRequired && isTestFile(file)) continue;
    violations.push({ constraint: 'scope', file, note: `outside the request scope (${scope.join(', ')})` });
  }
  return violations;
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Path-like tokens in a prose constraint: anything with a `/` or `*`, or a `name.ext` file name. */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[\s,;()"'`]+/)) {
    const token = word.replace(/^\.\/+/, '').replace(/[.:]+$/, '');
    if (token === '' || token.startsWith('http')) continue;
    const looksLikePath = token.includes('/') || token.includes('*') || /^\.?[A-Za-z0-9_-][\w.-]*\.[A-Za-z][A-Za-z0-9]+$/.test(token);
    if (!looksLikePath) continue;
    // "and/or" style slashes between plain words are prose, not paths.
    if (/^(and|or|if|to)\/(and|or|if|to)$/i.test(token)) continue;
    out.push(token.replace(/\/+$/, ''));
  }
  return out;
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

function matchesToken(file: string, token: string): boolean {
  if (token.includes('*')) return globToRegExp(token).test(file);
  return file === token || file.startsWith(`${token}/`);
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        i++;
        if (glob.charAt(i + 1) === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A glob that matches a directory also covers what is under it, as a plain directory token does.
  return new RegExp(`^${re}(?:/.*)?$`);
}

// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(code: ReviewVerdictErrorCode, message: string, field?: string): ReviewVerdictParse {
  return { ok: false, error: field === undefined ? { code, message } : { code, message, field } };
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
