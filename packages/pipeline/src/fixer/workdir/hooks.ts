// src/fixer/workdir/hooks.ts: the scripts of a fixer checkout, and the rules the server checks a
// fixer's work against before it pushes it (main 10.2, 16, #262).
//
// Every script is POSIX sh and holds no secret. The askpass script is for the runner's own git
// processes on the host (the clone, never the harness) and reads the token from their environment.
// The commit-msg hook holds only the issue key, which validateWorkdirNames has restricted to
// characters that need no shell quoting beyond single quotes.
//
// The commit-msg hook is a guardrail against an honest mistake, not a security boundary: a harness can
// pass `--no-verify` or edit the config. The boundary is that a fixer holds no GitHub credential at all
// and never pushes: the server checks every commit and path it hands back (`messageNamesKey`,
// `isProtectedPath`) and pushes the work itself (app/src/fixer-api/handoff.ts). The hook only makes
// the common mistake fail inside the run instead of at the hand-off.

/**
 * Paths a fixer's work must not touch (main 10.2: "Modify CI config or branch protection: No"), as
 * regular expressions over repository-relative paths. CI config is `.github/workflows/**`; a
 * CODEOWNERS file drives required reviews (GitHub reads three places; one anywhere is refused);
 * `.github/settings.yml` is the Probot Settings file, which manages branch protection.
 */
export const PROTECTED_PATH_PATTERNS: readonly string[] = Object.freeze([
  '^\\.github/workflows/',
  '(^|/)CODEOWNERS$',
  '^\\.github/settings\\.ya?ml$',
]);

/** True when a repository-relative path matches one of PROTECTED_PATH_PATTERNS. */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((p) => new RegExp(p).test(path));
}

/** The username GitHub expects with an installation token over HTTPS. */
export const TOKEN_USERNAME = 'x-access-token';
/** The environment variable the askpass script reads the token from. */
export const TOKEN_ENV = 'SNAPWING_GIT_TOKEN';

/**
 * GIT_ASKPASS program: git runs it with the prompt as `$1` and reads the answer from stdout. It
 * answers the username prompt with TOKEN_USERNAME and every other prompt with `$SNAPWING_GIT_TOKEN`.
 */
export function askpassScript(): string {
  return [
    '#!/bin/sh',
    '# Snapwing GIT_ASKPASS: the token comes from the environment, never from a file.',
    'case "$1" in',
    `  Username*) printf '%s\\n' '${TOKEN_USERNAME}' ;;`,
    `  *) printf '%s\\n' "$${TOKEN_ENV}" ;;`,
    'esac',
    '',
  ].join('\n');
}

/** Single-quotes a value for sh. Callers pass validated names; this is the second line of defense. */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Escapes a literal for a regular expression (POSIX extended and JavaScript alike). */
function ere(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The issue key as a whole token: WEB-10 does not satisfy WEB-1042. */
function keyPattern(issueKey: string): string {
  return `(^|[^A-Za-z0-9_-])${ere(issueKey)}([^0-9]|$)`;
}

/**
 * True when `message` names `issueKey` as a whole token, on any line: the rule the commit-msg hook
 * applies inside the run and the server applies to every commit a fixer hands back.
 */
export function messageNamesKey(message: string, issueKey: string): boolean {
  return new RegExp(keyPattern(issueKey), 'm').test(message);
}

/**
 * commit-msg hook: rejects a message that does not name the issue key as a whole token (so WEB-10
 * does not satisfy WEB-1042). Comment lines are ignored.
 */
export function commitMsgHook(issueKey: string): string {
  return [
    '#!/bin/sh',
    '# Snapwing commit-msg hook (main 10.2): every commit message names the issue key.',
    `key=${q(issueKey)}`,
    `if grep -v '^#' "$1" | grep -Eq ${q(keyPattern(issueKey))}; then exit 0; fi`,
    'echo "snapwing: commit message must contain the issue key $key" >&2',
    'exit 1',
    '',
  ].join('\n');
}
