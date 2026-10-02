// src/fixer/workdir/hooks.ts: the shell scripts a prepared fixer checkout carries (main 10.2, 16).
//
// Every script is POSIX sh and holds no secret: the askpass script reads the token from the
// environment of the git process that runs it, and the hooks hold only the issue key, the branch,
// and the base, which validateWorkdirNames has restricted to characters that need no shell quoting
// beyond single quotes.
//
// The hooks are mechanical guardrails against an honest mistake, not a security boundary: a harness
// can pass `--no-verify` or edit the config. The boundary is the installation token's scope and the
// base's branch protection (main 10.2). They exist so the common mistakes (a commit without the key,
// a push to the base, an edit to CI) fail loudly inside the run instead of on GitHub.

/**
 * Paths a fixer push must not touch (main 10.2: "Modify CI config or branch protection: No"), as
 * POSIX extended regular expressions over repository-relative paths. CI config is
 * `.github/workflows/**`; CODEOWNERS (in any of the three places GitHub reads it) drives required
 * reviews; `.github/settings.yml` is the Probot Settings file, which manages branch protection.
 */
export const PROTECTED_PATH_PATTERNS: readonly string[] = Object.freeze([
  '^\\.github/workflows/',
  '^(\\.github/|docs/)?CODEOWNERS$',
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

/** Escapes a literal for a POSIX extended regular expression. */
function ere(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * commit-msg hook: rejects a message that does not name the issue key as a whole token (so WEB-10
 * does not satisfy WEB-1042). Comment lines are ignored.
 */
export function commitMsgHook(issueKey: string): string {
  const pattern = `(^|[^A-Za-z0-9_-])${ere(issueKey)}([^0-9]|$)`;
  return [
    '#!/bin/sh',
    '# Snapwing commit-msg hook (main 10.2): every commit message names the issue key.',
    `key=${q(issueKey)}`,
    `if grep -v '^#' "$1" | grep -Eq ${q(pattern)}; then exit 0; fi`,
    'echo "snapwing: commit message must contain the issue key $key" >&2',
    'exit 1',
    '',
  ].join('\n');
}

export interface PrePushHookInput {
  branch: string;
  base: string;
  /** The base commit the branch was cut from; the diff floor when the base's remote ref is gone. */
  baseSha: string;
}

/**
 * pre-push hook: git feeds it `<local ref> <local sha> <remote ref> <remote sha>` lines. It rejects
 * a push to any ref but the work branch (so the base, other branches, and tags), a deletion, and a
 * push whose branch differs from the base in a protected path. The diff is the branch against its
 * merge base with the base (what the pull request would show), with renames split so moving a
 * workflow out counts too.
 */
export function prePushHook(input: PrePushHookInput): string {
  return [
    '#!/bin/sh',
    '# Snapwing pre-push hook (main 10.2): one branch, no pushes to the base, no CI or protection edits.',
    `branch=${q(input.branch)}`,
    `base=${q(input.base)}`,
    `base_sha=${q(input.baseSha)}`,
    `protected=${q(PROTECTED_PATH_PATTERNS.join('|'))}`,
    'status=0',
    'while read -r local_ref local_sha remote_ref remote_sha; do',
    '  [ -z "$local_ref" ] && continue',
    '  if [ "$remote_ref" != "refs/heads/$branch" ]; then',
    '    if [ "$remote_ref" = "refs/heads/$base" ]; then',
    '      echo "snapwing: pushing to the base branch $base is not allowed" >&2',
    '    else',
    '      echo "snapwing: only the work branch $branch may be pushed, not $remote_ref" >&2',
    '    fi',
    '    status=1',
    '    continue',
    '  fi',
    '  case "$local_sha" in',
    '    *[!0]*) ;;',
    '    *) echo "snapwing: deleting the work branch is not allowed" >&2; status=1; continue ;;',
    '  esac',
    '  floor=$(git rev-parse -q --verify "refs/remotes/origin/$base^{commit}" 2>/dev/null || echo "$base_sha")',
    '  from=$(git merge-base "$floor" "$local_sha" 2>/dev/null || echo "$base_sha")',
    '  if ! files=$(git diff --name-only --no-renames "$from" "$local_sha"); then',
    '    echo "snapwing: could not diff $local_sha against the base; refusing the push" >&2',
    '    status=1',
    '    continue',
    '  fi',
    `  hits=$(printf '%s\\n' "$files" | grep -E "$protected")`,
    '  if [ -n "$hits" ]; then',
    '    echo "snapwing: the fixer may not change CI config, CODEOWNERS, or branch protection files:" >&2',
    '    echo "$hits" | sed "s/^/  /" >&2',
    '    status=1',
    '  fi',
    'done',
    'exit $status',
    '',
  ].join('\n');
}
