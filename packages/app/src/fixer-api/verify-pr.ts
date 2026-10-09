// src/fixer-api/verify-pr.ts: checks the pull request a fixer reports as its own (hardening, #267).
//
// A fixer's `done` names a pull request number and a branch. Both come from the harness, which is
// untrusted, so before `pr-opened` is recorded the pull request is read from GitHub and must be:
//   - on the run's work branch (the plan's `handoff/@branch`, else `fix/<issue key>`), the same
//     branch the fixer reported;
//   - against the requested base (`handoff/@base`, else the repository's default branch);
//   - from the incident's own repository (not a fork);
//   - authored by the App.
// A pull request GitHub does not know is refused too. Any other GitHub error propagates, so the
// fixer's report fails the way other fixer API errors do and is retried.

import type { FixerDonePayload } from '@snapwing/pipeline/contracts/events.ts';
import { latest } from '@snapwing/pipeline/fixer/job.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { parseImplementationRequest } from '@snapwing/pipeline/prompts/implementation-request.ts';
import { GitHubNotFoundError, type GitHubClient } from '../github/client.ts';
import { repoFullName, sameRepo } from '../github/repo.ts';
import type { FixerTarget } from './reporter.ts';

export type PullRequestVerdict = { ok: true } | { ok: false; reason: string };

export type PullRequestVerifier = (target: FixerTarget, report: Pick<FixerDonePayload, 'prNumber' | 'branch'>) => Promise<PullRequestVerdict>;

export interface PullRequestVerifierDeps {
  state: Pick<StatePort, 'read' | 'getIncident' | 'getArtifact'>;
  github: (repo: string) => Pick<GitHubClient, 'getPullRequest' | 'getDefaultBranch'>;
  /** The App's bot login (`<app slug>[bot]`). */
  botLogin: string;
}

export function createPullRequestVerifier(deps: PullRequestVerifierDeps): PullRequestVerifier {
  return async (target, report) => {
    const refuse = (reason: string): PullRequestVerdict => ({ ok: false, reason });
    const [log, incident] = await Promise.all([deps.state.read(target.incidentId), deps.state.getIncident(target.incidentId)]);
    const repoName = incident?.repo;
    if (repoName === undefined || repoName === '') return refuse('the incident has no repository');
    const repo = repoFullName(repoName);
    const ref = latest(log, 'planned')?.payload.implementationRequest;
    if (ref === undefined) return refuse('the incident has no implementation request');
    const artifact = await deps.state.getArtifact(ref.artifactId);
    const { handoff } = parseImplementationRequest(artifact.body);
    const issueKey = incident?.jiraKey ?? latest(log, 'filed')?.payload.jiraKey;
    const workBranch = handoff.branch ?? (issueKey === undefined ? undefined : `fix/${issueKey}`);
    if (workBranch === undefined) return refuse('the run has no work branch');
    if (report.branch !== workBranch) return refuse("the reported branch is not the run's work branch");

    const gh = deps.github(repo);
    let pr;
    try {
      pr = await gh.getPullRequest(report.prNumber);
    } catch (e) {
      if (e instanceof GitHubNotFoundError) return refuse('the pull request does not exist');
      throw e;
    }
    if (pr.headRef !== workBranch) return refuse("the pull request is not on the run's work branch");
    if (pr.headRepo === null || !sameRepo(pr.headRepo, repo) || (pr.baseRepo !== null && !sameRepo(pr.baseRepo, repo))) {
      return refuse("the pull request is not from the incident's repository");
    }
    const base = handoff.base ?? (await gh.getDefaultBranch());
    if (pr.baseRef !== base) return refuse('the pull request does not target the requested base');
    if (pr.authorLogin === null || pr.authorLogin.toLowerCase() !== deps.botLogin.toLowerCase()) return refuse('the pull request was not opened by the App');
    return { ok: true };
  };
}
