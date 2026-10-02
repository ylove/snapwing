// GitHub pull request, checks, and merge operations (main 10.3, 10.4, 11.1 to 11.3). A factory over GitHubAuth:
// every call mints (or reuses) an installation token scoped to the one repository and the smallest permission
// set that operation needs. Merge may instead run with a user-to-server token so GitHub's audit log names a
// human (11.2). fetch only. A token is never logged and never put in an error message.

import { GitHubApiError } from './auth.ts';
import type { GitHubAuth, GitHubPermissions } from './auth.ts';

export { GitHubApiError } from './auth.ts';

/** The check run the review agent reports through (main 11.1). */
export const REVIEW_CHECK_NAME = 'snapwing/review';
const DEFAULT_RETRY_AFTER_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

/** 404: the repository, pull request, branch, check run, or file does not exist (or the token cannot see it). */
export class GitHubNotFoundError extends GitHubApiError {
  constructor(message: string) {
    super(404, message);
    this.name = 'GitHubNotFoundError';
  }
}

/** 409: the head moved since the caller looked (merge with a stale `sha`), or another ref conflict. */
export class GitHubHeadMovedError extends GitHubApiError {
  constructor(message: string) {
    super(409, message);
    this.name = 'GitHubHeadMovedError';
  }
}

/** 405: the pull request cannot be merged now (checks, reviews, conflicts, or protection). */
export class GitHubNotMergeableError extends GitHubApiError {
  constructor(message: string) {
    super(405, message);
    this.name = 'GitHubNotMergeableError';
  }
}

/** 422: GitHub rejected the payload. `details` carries GitHub's per-field error list when it sent one. */
export class GitHubValidationError extends GitHubApiError {
  readonly details: readonly unknown[];

  constructor(message: string, details: readonly unknown[] = []) {
    super(422, message);
    this.name = 'GitHubValidationError';
    this.details = details;
  }
}

/** 429, or 403 with a rate-limit signal (primary or secondary). Callers back off for `retryAfterMs`. */
export class GitHubRateLimitError extends GitHubApiError {
  readonly retryAfterMs: number;

  constructor(status: number, message: string, retryAfterMs: number) {
    super(status, message);
    this.name = 'GitHubRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GitHubClientOptions {
  /** `owner/name`. */
  repo: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Default `https://api.github.com`. */
  apiBase?: string;
}

export interface PullRequest {
  number: number;
  /** GraphQL node id, needed by draft and revert. */
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  /** `true`, `false`, or `null` while GitHub is still computing it. */
  mergeable: boolean | null;
  htmlUrl: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  authorLogin: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  requestedReviewers: string[];
  labels: string[];
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface CreateReviewInput {
  event: ReviewEvent;
  body: string;
  /** Pin the review to a head sha so it does not land on a newer push. */
  commitId?: string;
}

export interface Review {
  id: number;
  state: string;
  htmlUrl: string;
}

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';
export type CheckRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

export interface CreateCheckRunInput {
  headSha: string;
  /** Default `snapwing/review`. */
  name?: string;
  status: CheckRunStatus;
  /** Required by GitHub when `status` is `completed`. */
  conclusion?: CheckRunConclusion;
  output?: CheckRunOutput;
  detailsUrl?: string;
  externalId?: string;
}

export interface UpdateCheckRunInput {
  status?: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  output?: CheckRunOutput;
  detailsUrl?: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
}

export type CheckState = 'success' | 'pending' | 'failure';

export interface CheckResult {
  name: string;
  state: CheckState;
  source: 'check-run' | 'status';
}

export interface RequiredCheck {
  name: string;
  /** `pending` when nothing has reported under that name yet. */
  state: CheckState;
  /** `null` when nothing has reported. */
  source: CheckResult['source'] | null;
}

export interface CombinedStatus {
  sha: string;
  baseBranch: string;
  /** Over the required checks only: any failure is `failure`, else any pending or missing is `pending`, else `success`. Vacuously `success` when the branch requires none. */
  state: CheckState;
  required: RequiredCheck[];
  /** Everything reported for the sha, required or not (check runs and commit statuses). */
  all: CheckResult[];
}

export interface MergeInput {
  /** The head sha the caller verified; GitHub answers 409 if the head has moved. */
  expectedHeadSha: string;
  commitTitle?: string;
  commitMessage?: string;
  /** A user-to-server token. When set, the merge is performed (and audited) as that user instead of the app. */
  userToken?: string;
}

export interface MergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface RevertInput {
  title?: string;
  body?: string;
  draft?: boolean;
}

export interface RevertPullRequest {
  number: number;
  url: string;
  nodeId: string;
}

export interface GitHubClient {
  getPullRequest(number: number): Promise<PullRequest>;
  listPullRequestFiles(number: number): Promise<PullRequestFile[]>;
  requestReviewers(number: number, reviewers: { users?: readonly string[]; teams?: readonly string[] }): Promise<void>;
  createReview(number: number, input: CreateReviewInput): Promise<Review>;
  createCheckRun(input: CreateCheckRunInput): Promise<CheckRun>;
  updateCheckRun(checkRunId: number, input: UpdateCheckRunInput): Promise<CheckRun>;
  combinedStatus(sha: string, baseBranch: string): Promise<CombinedStatus>;
  /** Squash merge pinned to `expectedHeadSha`. */
  mergePullRequest(number: number, input: MergeInput): Promise<MergeResult>;
  /** Comment, then close. */
  closePullRequest(number: number, comment: string): Promise<void>;
  markDraft(number: number): Promise<void>;
  addLabels(number: number, labels: readonly string[]): Promise<string[]>;
  deleteBranch(branch: string): Promise<void>;
  /** GraphQL `revertPullRequest`; the pull request must already be merged. */
  openRevertPullRequest(number: number, input?: RevertInput): Promise<RevertPullRequest>;
}

export interface GitHubRequest {
  method: string;
  path: string;
  permissions: GitHubPermissions;
  body?: unknown;
  query?: Readonly<Record<string, string | number>>;
  accept?: string;
  /** Replaces the installation token for this call. */
  token?: string;
}

export interface GitHubResponse {
  status: number;
  headers: Headers;
  text: string;
}

export type GitHubTransport = (request: GitHubRequest) => Promise<GitHubResponse>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function retryAfterMs(headers: Headers, now: Date): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now.getTime());
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now.getTime());
  return DEFAULT_RETRY_AFTER_MS;
}

/** Map a failed response to the typed error. */
export function githubErrorFor(status: number, message: string, headers: Headers, now: Date, details: readonly unknown[] = []): GitHubApiError {
  const limited = status === 429 || (status === 403 && (headers.get('retry-after') !== null || headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)));
  if (limited) return new GitHubRateLimitError(status, message, retryAfterMs(headers, now));
  if (status === 404) return new GitHubNotFoundError(message);
  if (status === 409) return new GitHubHeadMovedError(message);
  if (status === 405) return new GitHubNotMergeableError(message);
  if (status === 422) return new GitHubValidationError(message, details);
  return new GitHubApiError(status, message);
}

/** The shared request path: token, headers, error mapping. Used by the client and by `codeowners.ts`. */
export function createGitHubTransport(auth: GitHubAuth, options: GitHubClientOptions): GitHubTransport {
  const now = options.now ?? (() => new Date());
  const base = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  return async (request) => {
    const token = request.token ?? (await auth.installationToken({ repo: options.repo, permissions: request.permissions })).token;
    const query = request.query === undefined ? '' : `?${new URLSearchParams(Object.entries(request.query).map(([k, v]) => [k, String(v)])).toString()}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: request.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    // Resolved per call so a test that patches global fetch after construction is honored.
    const res = await (options.fetch ?? fetch)(`${base}${request.path}${query}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      const body = record(parseJson(text));
      const message = typeof body?.message === 'string' ? body.message : res.statusText || 'request failed';
      throw githubErrorFor(res.status, message, res.headers, now(), list(body?.errors));
    }
    return { status: res.status, headers: res.headers, text };
  };
}

function toPullRequest(raw: unknown): PullRequest {
  const pr = record(raw);
  if (pr === undefined || typeof pr.number !== 'number') throw new GitHubApiError(502, 'pull request response was not an object with a number');
  const head = record(pr.head);
  const base = record(pr.base);
  return {
    number: pr.number,
    nodeId: str(pr.node_id),
    title: str(pr.title),
    body: str(pr.body),
    state: pr.state === 'closed' ? 'closed' : 'open',
    draft: pr.draft === true,
    merged: pr.merged === true,
    mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
    htmlUrl: str(pr.html_url),
    headSha: str(head?.sha),
    headRef: str(head?.ref),
    baseRef: str(base?.ref),
    authorLogin: str(record(pr.user)?.login) || null,
    additions: num(pr.additions),
    deletions: num(pr.deletions),
    changedFiles: num(pr.changed_files),
    requestedReviewers: list(pr.requested_reviewers)
      .map((u) => str(record(u)?.login))
      .filter((l) => l !== ''),
    labels: list(pr.labels)
      .map((l) => str(record(l)?.name))
      .filter((n) => n !== ''),
  };
}

function toCheckRun(raw: unknown): CheckRun {
  const run = record(raw);
  if (run === undefined || typeof run.id !== 'number') throw new GitHubApiError(502, 'check run response had no id');
  return { id: run.id, name: str(run.name), status: str(run.status), conclusion: typeof run.conclusion === 'string' ? run.conclusion : null, htmlUrl: str(run.html_url) };
}

function checkRunState(run: Record<string, unknown>): CheckState {
  if (run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped' ? 'success' : 'failure';
}

function statusState(state: unknown): CheckState {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  return 'failure';
}

const WORST: Record<CheckState, number> = { success: 0, pending: 1, failure: 2 };

export function createGitHubClient(auth: GitHubAuth, options: GitHubClientOptions): GitHubClient {
  const repoPath = `/repos/${options.repo}`;
  const now = options.now ?? (() => new Date());
  const call = createGitHubTransport(auth, options);
  const prRead: GitHubPermissions = { pull_requests: 'read' };
  const prWrite: GitHubPermissions = { pull_requests: 'write' };

  async function json(request: GitHubRequest): Promise<unknown> {
    return parseJson((await call(request)).text);
  }

  async function paginate(path: string, permissions: GitHubPermissions, pick: (page: unknown) => unknown[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = pick(await json({ method: 'GET', path, permissions, query: { per_page: PAGE_SIZE, page } }));
      out.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
    return out;
  }

  async function graphql(query: string, variables: Record<string, unknown>, permissions: GitHubPermissions): Promise<Record<string, unknown>> {
    const res = await call({ method: 'POST', path: '/graphql', permissions, body: { query, variables } });
    const body = record(parseJson(res.text));
    const errors = list(body?.errors);
    if (errors.length > 0) {
      const first = record(errors[0]);
      const message = str(first?.message, 'GraphQL request failed');
      const type = str(first?.type);
      if (type === 'RATE_LIMITED') throw new GitHubRateLimitError(200, message, retryAfterMs(res.headers, now()));
      if (type === 'NOT_FOUND') throw new GitHubNotFoundError(message);
      throw new GitHubValidationError(message, errors);
    }
    const data = record(body?.data);
    if (data === undefined) throw new GitHubApiError(502, 'GraphQL response had no data');
    return data;
  }

  async function requiredCheckNames(baseBranch: string): Promise<string[]> {
    try {
      const body = record(
        await json({
          method: 'GET',
          path: `${repoPath}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
          permissions: { administration: 'read' },
        }),
      );
      const names = new Set<string>();
      for (const c of list(body?.contexts)) if (typeof c === 'string') names.add(c);
      for (const c of list(body?.checks)) {
        const context = record(c)?.context;
        if (typeof context === 'string') names.add(context);
      }
      return [...names];
    } catch (err) {
      // An unprotected branch (or one with no required-checks rule) answers 404: nothing is required.
      if (err instanceof GitHubNotFoundError) return [];
      throw err;
    }
  }

  async function fetchPullRequest(number: number): Promise<PullRequest> {
    return toPullRequest(await json({ method: 'GET', path: `${repoPath}/pulls/${number}`, permissions: prRead }));
  }

  return {
    getPullRequest: fetchPullRequest,

    async listPullRequestFiles(number) {
      const raw = await paginate(`${repoPath}/pulls/${number}/files`, prRead, (page) => list(page));
      const files: PullRequestFile[] = [];
      for (const r of raw) {
        const f = record(r);
        if (f === undefined || typeof f.filename !== 'string') continue;
        files.push({ filename: f.filename, status: str(f.status), additions: num(f.additions), deletions: num(f.deletions), changes: num(f.changes) });
      }
      return files;
    },

    async requestReviewers(number, reviewers) {
      await call({
        method: 'POST',
        path: `${repoPath}/pulls/${number}/requested_reviewers`,
        permissions: prWrite,
        body: { reviewers: [...(reviewers.users ?? [])], team_reviewers: [...(reviewers.teams ?? [])] },
      });
    },

    async createReview(number, input) {
      const body = record(
        await json({
          method: 'POST',
          path: `${repoPath}/pulls/${number}/reviews`,
          permissions: prWrite,
          body: { event: input.event, body: input.body, ...(input.commitId === undefined ? {} : { commit_id: input.commitId }) },
        }),
      );
      return { id: num(body?.id), state: str(body?.state), htmlUrl: str(body?.html_url) };
    },

    async createCheckRun(input) {
      return toCheckRun(
        await json({
          method: 'POST',
          path: `${repoPath}/check-runs`,
          permissions: { checks: 'write' },
          body: {
            name: input.name ?? REVIEW_CHECK_NAME,
            head_sha: input.headSha,
            status: input.status,
            ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
            ...(input.output === undefined ? {} : { output: input.output }),
            ...(input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl }),
            ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
          },
        }),
      );
    },

    async updateCheckRun(checkRunId, input) {
      return toCheckRun(
        await json({
          method: 'PATCH',
          path: `${repoPath}/check-runs/${checkRunId}`,
          permissions: { checks: 'write' },
          body: {
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
            ...(input.output === undefined ? {} : { output: input.output }),
            ...(input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl }),
          },
        }),
      );
    },

    async combinedStatus(sha, baseBranch) {
      const checksPermissions: GitHubPermissions = { checks: 'read', statuses: 'read' };
      const [requiredNames, runs, statusBody] = await Promise.all([
        requiredCheckNames(baseBranch),
        paginate(`${repoPath}/commits/${encodeURIComponent(sha)}/check-runs`, checksPermissions, (page) => list(record(page)?.check_runs)),
        json({ method: 'GET', path: `${repoPath}/commits/${encodeURIComponent(sha)}/status`, permissions: checksPermissions, query: { per_page: PAGE_SIZE } }),
      ]);
      // Several runs can share a name (reruns); the highest id is the latest.
      const latestRuns = new Map<string, Record<string, unknown>>();
      for (const r of runs) {
        const run = record(r);
        if (run === undefined || typeof run.name !== 'string') continue;
        const prior = latestRuns.get(run.name);
        if (prior === undefined || num(run.id) > num(prior.id)) latestRuns.set(run.name, run);
      }
      const all: CheckResult[] = [...latestRuns.entries()].map(([name, run]) => ({ name, state: checkRunState(run), source: 'check-run' as const }));
      for (const s of list(record(statusBody)?.statuses)) {
        const status = record(s);
        if (status === undefined || typeof status.context !== 'string') continue;
        all.push({ name: status.context, state: statusState(status.state), source: 'status' });
      }
      const required: RequiredCheck[] = requiredNames.map((name) => {
        // A name reported both ways is as bad as its worst result.
        const worst = all.filter((r) => r.name === name).reduce<CheckResult | undefined>((w, r) => (w === undefined || WORST[r.state] > WORST[w.state] ? r : w), undefined);
        return worst === undefined ? { name, state: 'pending', source: null } : { name, state: worst.state, source: worst.source };
      });
      const state = required.reduce<CheckState>((s, r) => (WORST[r.state] > WORST[s] ? r.state : s), 'success');
      return { sha, baseBranch, state, required, all };
    },

    async mergePullRequest(number, input) {
      const body = record(
        await json({
          method: 'PUT',
          path: `${repoPath}/pulls/${number}/merge`,
          permissions: { contents: 'write', pull_requests: 'write' },
          ...(input.userToken === undefined ? {} : { token: input.userToken }),
          body: {
            merge_method: 'squash',
            sha: input.expectedHeadSha,
            ...(input.commitTitle === undefined ? {} : { commit_title: input.commitTitle }),
            ...(input.commitMessage === undefined ? {} : { commit_message: input.commitMessage }),
          },
        }),
      );
      return { merged: body?.merged === true, sha: str(body?.sha), message: str(body?.message) };
    },

    async closePullRequest(number, comment) {
      await call({ method: 'POST', path: `${repoPath}/issues/${number}/comments`, permissions: { pull_requests: 'write', issues: 'write' }, body: { body: comment } });
      await call({ method: 'PATCH', path: `${repoPath}/pulls/${number}`, permissions: prWrite, body: { state: 'closed' } });
    },

    async markDraft(number) {
      const pr = await fetchPullRequest(number);
      if (pr.nodeId === '') throw new GitHubApiError(502, `pull request ${number} had no node_id`);
      await graphql('mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }', { id: pr.nodeId }, prWrite);
    },

    async addLabels(number, labels) {
      const body = await json({ method: 'POST', path: `${repoPath}/issues/${number}/labels`, permissions: { issues: 'write', pull_requests: 'write' }, body: { labels: [...labels] } });
      return list(body)
        .map((l) => str(record(l)?.name))
        .filter((n) => n !== '');
    },

    async deleteBranch(branch) {
      const ref = branch.split('/').map(encodeURIComponent).join('/');
      await call({ method: 'DELETE', path: `${repoPath}/git/refs/heads/${ref}`, permissions: { contents: 'write' } });
    },

    async openRevertPullRequest(number, input = {}) {
      const pr = await fetchPullRequest(number);
      if (pr.nodeId === '') throw new GitHubApiError(502, `pull request ${number} had no node_id`);
      const data = await graphql(
        'mutation($input: RevertPullRequestInput!) { revertPullRequest(input: $input) { revertPullRequest { id number url } } }',
        {
          input: {
            pullRequestId: pr.nodeId,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.draft === undefined ? {} : { draft: input.draft }),
          },
        },
        { contents: 'write', pull_requests: 'write' },
      );
      const revert = record(record(data.revertPullRequest)?.revertPullRequest);
      if (revert === undefined || typeof revert.number !== 'number') throw new GitHubApiError(502, 'revertPullRequest returned no pull request');
      return { number: revert.number, url: str(revert.url), nodeId: str(revert.id) };
    },
  };
}
