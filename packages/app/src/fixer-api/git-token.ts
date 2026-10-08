// src/fixer-api/git-token.ts: a fresh git credential for a running fixer container (B 9,
// main 10.2, ADR 0017, docs/harness-generic.md sections 7 and 8).
//
// GitHub App installation tokens live one hour, and a fixer's wall clock budget may be longer, so a
// container is never handed one token for its whole run. `GET /fixer/{workItemId}/git-token`
// (routes.ts), authenticated with the run's fixer token like every other fixer call, answers with a
// token minted (or reused from the server's cache while it has more than five minutes left) for the
// incident's one repository with the fixer's scopes (`contents: write`, `pull_requests: write`, never
// `workflows`). Only the image's wrapper calls it, and it hands the token to git through a credential
// helper that writes it nowhere.
//
// Refused, minting nothing, when the incident has no log (404), is closed, or has no running fixer
// run (a stop, `fixer-done`, or `fixer-failed` follows the latest `fixer-started`; 409, exactly as a
// report is refused), or has no resolved repository (409 `no-repo`). A failure to mint is 502 with
// no detail. The token never appears in a log line or an error.

import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { decideReport, type FixerRefusal, type FixerTarget } from './reporter.ts';

/** What the fixer API mints a git token with: `owner/name` or the map's `github.com/owner/name`. */
export type GitTokenMinter = (repo: string) => Promise<{ token: string; expiresAt: string }>;

export interface FixerGitTokenDeps {
  state: Pick<StatePort, 'read' | 'getIncident'>;
  /** Mints an installation token for the repository with the fixer's scopes (compose.ts). */
  mint: GitTokenMinter;
}

export type FixerGitTokenRefusal = FixerRefusal | 'no-repo' | 'mint-failed';

export type FixerGitTokenResult = { ok: true; token: string; expiresAt: string } | { ok: false; code: FixerGitTokenRefusal };

/** Answers a verified fixer's request for a fresh git credential. */
export type FixerGitTokenSource = (target: FixerTarget) => Promise<FixerGitTokenResult>;

export function createFixerGitToken(deps: FixerGitTokenDeps): FixerGitTokenSource {
  return async (target) => {
    const events = await deps.state.read(target.incidentId);
    const d = decideReport(events);
    if (!d.ok) return d;
    const repo = (await deps.state.getIncident(target.incidentId))?.repo;
    if (repo === undefined || repo === '') return { ok: false, code: 'no-repo' };
    try {
      const { token, expiresAt } = await deps.mint(repo);
      return { ok: true, token, expiresAt };
    } catch {
      return { ok: false, code: 'mint-failed' };
    }
  };
}
