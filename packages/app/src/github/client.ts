// GitHub pull request, checks, and merge operations (main 10.3, 10.4, 11.1 to 11.3). A factory over GitHubAuth:
// every call mints (or reuses) an installation token scoped to the one repository and the smallest permission
// set that operation needs. Merge and revert may instead run with a user-to-server token so GitHub's audit log
// names a human (11.2, 11.3). fetch only. A token is never logged and never put in an error message.
//
// Required checks (#264) come from classic branch protection and from repository rulesets together (a
// branch protected by rulesets alone lists none under classic protection). They are matched by name
// and by the app that must report them, for exactly the sha asked about: the app either source names
// for the check (`checks[].app_id`, a ruleset's `integration_id`; a check no source pins matches by
// name, as GitHub does), and for `snapwing/review` always this App (`GitHubClientOptions.appId`). A
// check pinned to an app counts only from that app's check runs, never from a commit status or another
// app's run of the same name.

import { GitHubApiError } from './auth.ts';
import type { GitHubAuth, GitHubPermissions } from './auth.ts';

export { GitHubApiError } from './auth.ts';

/** The check run the review agent reports through (main 11.1). */
export const REVIEW_CHECK_NAME = 'snapwing/review';
const DEFAULT_RETRY_AFTER_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
/** GitHub lists at most this many files in a comparison; a list this long may be cut short. */
export const COMPARE_FILE_LIMIT = 300;

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
  /**
   * This App's id (`GITHUB_APP_ID`). `snapwing/review` counts as a required check only from this App's
   * check run on the sha asked about (#264); without the id it never counts.
   */
  appId?: number;
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
  /** `owner/name` of the head repository; null when it was deleted. A fork differs from `baseRepo`. */
  headRepo: string | null;
  /** `owner/name` of the repository the pull request targets. */
  baseRepo: string | null;
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
  /** A renamed file's old path (`previous_filename`). */
  previousFilename?: string;
}

/** The files one commit changes against a base, read for exactly that commit. */
export interface CompareFiles {
  files: PullRequestFile[];
  /** False when GitHub may have cut the list short (`COMPARE_FILE_LIMIT`). */
  complete: boolean;
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
  /** The app that reported a check run (`app.id`); absent for a commit status. */
  appId?: number;
}

export interface RequiredCheck {
  name: string;
  /** `pending` when nothing has reported under that name yet (from the app it must come from). */
  state: CheckState;
  /** `null` when nothing has reported (from that app). */
  source: CheckResult['source'] | null;
  /** The app that must report it; absent when any source may. */
  appId?: number;
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
  /** A user-to-server token. When set, the revert PR is opened (and audited) as that user instead of the app. */
  userToken?: string;
}

export interface RevertPullRequest {
  number: number;
  url: string;
  nodeId: string;
}

/** GitHub's relation of `head` to `base` (`GET /compare/{base}...{head}`). */
export type CommitComparisonStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface CommitComparison {
  status: CommitComparisonStatus;
  aheadBy: number;
  behindBy: number;
  /** `head` contains `base`: `ahead` or `identical`. */
  contains: boolean;
}

/** A pull request to open as the App (the fixer hand-off, #262). */
export interface CreatePullRequestInput {
  title: string;
  /** A branch of this repository. */
  head: string;
  base: string;
  body: string;
  draft?: boolean;
}

export interface GitHubClient {
  getPullRequest(number: number): Promise<PullRequest>;
  /** The repository's default branch. */
  getDefaultBranch(): Promise<string>;
  /** The open pull request from `head` (a branch of this repository) into `base`, if there is one. */
  findOpenPullRequest(head: string, base: string): Promise<PullRequest | undefined>;
  /** Opens a pull request from `head` (a branch of this repository) into `base`, as the App. */
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listPullRequestFiles(number: number): Promise<PullRequestFile[]>;
  /** The files `head` changes against its merge base with `base` (`GET /compare/{base}...{head}`), for exactly that commit. */
  compareFiles(base: string, head: string): Promise<CompareFiles>;
  requestReviewers(number: number, reviewers: { users?: readonly string[]; teams?: readonly string[] }): Promise<void>;
  createReview(number: number, input: CreateReviewInput): Promise<Review>;
  createCheckRun(input: CreateCheckRunInput): Promise<CheckRun>;
  updateCheckRun(checkRunId: number, input: UpdateCheckRunInput): Promise<CheckRun>;
  combinedStatus(sha: string, baseBranch: string): Promise<CombinedStatus>;
  /** Whether `head` contains `base`. A sha GitHub does not know (404) is not contained. */
  compareCommits(base: string, head: string): Promise<CommitComparison>;
  /** Squash merge pinned to `expectedHeadSha`. */
  mergePullRequest(number: number, input: MergeInput): Promise<MergeResult>;
  /** Comment, then close. */
  closePullRequest(number: number, comment: string): Promise<void>;
  markDraft(number: number): Promise<void>;
  addLabels(number: number, labels: readonly string[]): Promise<string[]>;
  deleteBranch(branch: string): Promise<void>;
  /** GraphQL `revertPullRequest`; the pull request must already be merged. With `userToken`, as that user. */
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
    headRepo: str(record(head?.repo)?.full_name) || null,
    baseRepo: str(record(base?.repo)?.full_name) || null,
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

function toFile(raw: unknown): PullRequestFile | undefined {
  const f = record(raw);
  if (f === undefined || typeof f.filename !== 'string') return undefined;
  return {
    filename: f.filename,
    status: str(f.status),
    additions: num(f.additions),
    deletions: num(f.deletions),
    changes: num(f.changes),
    ...(typeof f.previous_filename === 'string' && f.previous_filename !== '' ? { previousFilename: f.previous_filename } : {}),
  };
}

/** A positive app id, else undefined (branch protection writes `null` or `-1` for "any source"). */
function appIdOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The ref as a path: each `/`-separated part encoded, so `release/1.2` stays a ref GitHub reads. */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
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
/** No app has this id: a check pinned to it never counts (`snapwing/review` without `appId`). */
const NO_APP = -1;

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

  async function graphql(query: string, variables: Record<string, unknown>, permissions: GitHubPermissions, token?: string): Promise<Record<string, unknown>> {
    const res = await call({ method: 'POST', path: '/graphql', permissions, body: { query, variables }, ...(token === undefined ? {} : { token }) });
    const body = record(parseJson(res.text));
    const errors = list(body?.errors);
    if (errors.length > 0) {
      const first = record(errors[0]);
      const message = str(first?.message, 'GraphQL request failed');
      const type = str(first?.type);
      if (type === 'RATE_LIMITED') throw new GitHubRateLimitError(200, message, retryAfterMs(res.headers, now()));
      if (type === 'NOT_FOUND') throw new GitHubNotFoundError(message);
      // A user-to-server token whose user lacks access (a revert as that user) is refused like a REST 403.
      if (type === 'FORBIDDEN') throw new GitHubApiError(403, message);
      throw new GitHubValidationError(message, errors);
    }
    const data = record(body?.data);
    if (data === undefined) throw new GitHubApiError(502, 'GraphQL response had no data');
    return data;
  }

  /**
   * The base branch's required checks: each name, and the app branch protection says must report it
   * (`checks[].app_id`), absent when any source may. A name listed both ways keeps its app.
   */
  /** Classic branch protection's required checks: `contexts` (any source) and `checks[].app_id`. */
  async function classicRequiredChecks(baseBranch: string): Promise<{ name: string; appId?: number }[]> {
    try {
      const body = record(
        await json({
          method: 'GET',
          path: `${repoPath}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
          permissions: { administration: 'read' },
        }),
      );
      const contexts = list(body?.contexts).flatMap((c) => (typeof c === 'string' ? [{ name: c }] : []));
      const checks = list(body?.checks).flatMap((c) => {
        const check = record(c);
        const appId = appIdOf(check?.app_id);
        return typeof check?.context !== 'string' ? [] : [appId === undefined ? { name: check.context } : { name: check.context, appId }];
      });
      return [...contexts, ...checks];
    } catch (err) {
      // An unprotected branch (or one with no required-checks rule) answers 404: nothing is required.
      if (err instanceof GitHubNotFoundError) return [];
      throw err;
    }
  }

  /** Repository rulesets' required checks for the branch: each `required_status_checks` rule's `context` and `integration_id`. */
  async function rulesetRequiredChecks(baseBranch: string): Promise<{ name: string; appId?: number }[]> {
    try {
      const rules = await paginate(`${repoPath}/rules/branches/${encodeURIComponent(baseBranch)}`, { metadata: 'read' }, (page) => list(page));
      return rules.flatMap((r) => {
        const rule = record(r);
        if (rule?.type !== 'required_status_checks') return [];
        return list(record(rule.parameters)?.required_status_checks).flatMap((c) => {
          const check = record(c);
          const appId = appIdOf(check?.integration_id);
          return typeof check?.context !== 'string' ? [] : [appId === undefined ? { name: check.context } : { name: check.context, appId }];
        });
      });
    } catch (err) {
      // No rules for the branch: nothing is required by a ruleset.
      if (err instanceof GitHubNotFoundError) return [];
      throw err;
    }
  }

  /**
   * The base branch's required checks from classic branch protection and repository rulesets together,
   * one entry per name and app that must report it (#264). A name either source pins to an app counts
   * only from that app; pinned to two apps, both must report it. A name no source pins accepts any
   * source. `snapwing/review` is this App's own check: it is pinned to the App's id as well (to an id
   * no app has when `appId` is unknown, so it never counts).
   */
  async function requiredChecksOf(baseBranch: string): Promise<{ name: string; appId?: number }[]> {
    const [classic, rulesets] = await Promise.all([classicRequiredChecks(baseBranch), rulesetRequiredChecks(baseBranch)]);
    const pins = new Map<string, Set<number>>();
    for (const { name, appId } of [...classic, ...rulesets]) {
      const apps = pins.get(name) ?? new Set<number>();
      if (appId !== undefined) apps.add(appId);
      pins.set(name, apps);
    }
    pins.get(REVIEW_CHECK_NAME)?.add(options.appId ?? NO_APP);
    return [...pins.entries()].flatMap(([name, apps]) => (apps.size === 0 ? [{ name }] : [...apps].map((appId) => ({ name, appId }))));
  }

  async function fetchPullRequest(number: number): Promise<PullRequest> {
    return toPullRequest(await json({ method: 'GET', path: `${repoPath}/pulls/${number}`, permissions: prRead }));
  }

  return {
    getPullRequest: fetchPullRequest,

    async getDefaultBranch() {
      const body = record(await json({ method: 'GET', path: repoPath, permissions: { metadata: 'read' } }));
      const branch = str(body?.default_branch);
      if (branch === '') throw new GitHubApiError(502, 'repository response had no default branch');
      return branch;
    },

    async findOpenPullRequest(head, base) {
      const owner = options.repo.slice(0, options.repo.indexOf('/'));
      const found = list(await json({ method: 'GET', path: `${repoPath}/pulls`, permissions: prRead, query: { state: 'open', head: `${owner}:${head}`, base, per_page: 1 } }));
      return found.length === 0 ? undefined : toPullRequest(found[0]);
    },

    async createPullRequest(input) {
      const body = { title: input.title, head: input.head, base: input.base, body: input.body, ...(input.draft === undefined ? {} : { draft: input.draft }) };
      return toPullRequest(await json({ method: 'POST', path: `${repoPath}/pulls`, permissions: prWrite, body }));
    },

    async listPullRequestFiles(number) {
      const raw = await paginate(`${repoPath}/pulls/${number}/files`, prRead, (page) => list(page));
      return raw.flatMap((r) => toFile(r) ?? []);
    },

    async compareFiles(base, head) {
      // One page: GitHub puts the files (at most COMPARE_FILE_LIMIT) on the first page only.
      const body = record(await json({ method: 'GET', path: `${repoPath}/compare/${refPath(base)}...${refPath(head)}`, permissions: { contents: 'read' } }));
      const files = list(body?.files).flatMap((r) => toFile(r) ?? []);
      return { files, complete: files.length < COMPARE_FILE_LIMIT };
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
      const [requiredChecks, rawRuns, statusBody] = await Promise.all([
        requiredChecksOf(baseBranch),
        paginate(`${repoPath}/commits/${encodeURIComponent(sha)}/check-runs`, checksPermissions, (page) => list(record(page)?.check_runs)),
        json({ method: 'GET', path: `${repoPath}/commits/${encodeURIComponent(sha)}/status`, permissions: checksPermissions, query: { per_page: PAGE_SIZE } }),
      ]);
      // Only what was reported on exactly this sha.
      const runs = rawRuns.flatMap((r) => {
        const run = record(r);
        if (run === undefined || typeof run.name !== 'string') return [];
        return typeof run.head_sha === 'string' && run.head_sha !== sha ? [] : [run];
      });
      const statusFor = record(statusBody);
      const statuses = typeof statusFor?.sha === 'string' && statusFor.sha !== sha ? [] : list(statusFor?.statuses);
      const runResult = (run: Record<string, unknown>): CheckResult => {
        const appId = appIdOf(record(run.app)?.id);
        return { name: str(run.name), state: checkRunState(run), source: 'check-run', ...(appId === undefined ? {} : { appId }) };
      };
      // Several runs can share a name (reruns, or several apps); the highest id is the latest.
      const latestOf = (candidates: readonly Record<string, unknown>[]): Record<string, unknown> | undefined =>
        candidates.reduce<Record<string, unknown> | undefined>((l, r) => (l === undefined || num(r.id) > num(l.id) ? r : l), undefined);
      const all: CheckResult[] = [...new Set(runs.map((r) => str(r.name)))].flatMap((name) => {
        const latest = latestOf(runs.filter((r) => r.name === name));
        return latest === undefined ? [] : [runResult(latest)];
      });
      const reported: CheckResult[] = [];
      for (const s of statuses) {
        const status = record(s);
        if (status === undefined || typeof status.context !== 'string') continue;
        reported.push({ name: status.context, state: statusState(status.state), source: 'status' });
      }
      all.push(...reported);
      const required: RequiredCheck[] = requiredChecks.map(({ name, appId }) => {
        const pinned = appId !== undefined;
        const latest = latestOf(runs.filter((r) => r.name === name && (!pinned || appIdOf(record(r.app)?.id) === appId)));
        // An app-pinned check counts only from that app's check runs; otherwise a name reported both ways is as bad as its worst result.
        const results = [...(latest === undefined ? [] : [runResult(latest)]), ...(pinned ? [] : reported.filter((r) => r.name === name))];
        const worst = results.reduce<CheckResult | undefined>((w, r) => (w === undefined || WORST[r.state] > WORST[w.state] ? r : w), undefined);
        const app = appId === undefined || appId === NO_APP ? {} : { appId };
        return worst === undefined ? { name, state: 'pending', source: null, ...app } : { name, state: worst.state, source: worst.source, ...app };
      });
      const state = required.reduce<CheckState>((s, r) => (WORST[r.state] > WORST[s] ? r.state : s), 'success');
      return { sha, baseBranch, state, required, all };
    },

    async compareCommits(base, head) {
      let body: Record<string, unknown> | undefined;
      try {
        body = record(
          await json({
            method: 'GET',
            path: `${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
            permissions: { contents: 'read' },
            query: { per_page: 1 },
          }),
        );
      } catch (err) {
        if (err instanceof GitHubNotFoundError) return { status: 'diverged', aheadBy: 0, behindBy: 0, contains: false };
        throw err;
      }
      const status: CommitComparisonStatus = body?.status === 'ahead' || body?.status === 'behind' || body?.status === 'identical' ? body.status : 'diverged';
      return { status, aheadBy: num(body?.ahead_by), behindBy: num(body?.behind_by), contains: status === 'ahead' || status === 'identical' };
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

    // Issue-comment and label endpoints accept pull_requests: write for a PR; asking for issues: write too is refused (422) by an App without it.
    async closePullRequest(number, comment) {
      await call({ method: 'POST', path: `${repoPath}/issues/${number}/comments`, permissions: prWrite, body: { body: comment } });
      await call({ method: 'PATCH', path: `${repoPath}/pulls/${number}`, permissions: prWrite, body: { state: 'closed' } });
    },

    async markDraft(number) {
      const pr = await fetchPullRequest(number);
      if (pr.nodeId === '') throw new GitHubApiError(502, `pull request ${number} had no node_id`);
      await graphql('mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }', { id: pr.nodeId }, prWrite);
    },

    async addLabels(number, labels) {
      const body = await json({ method: 'POST', path: `${repoPath}/issues/${number}/labels`, permissions: prWrite, body: { labels: [...labels] } });
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
        input.userToken,
      );
      const revert = record(record(data.revertPullRequest)?.revertPullRequest);
      if (revert === undefined || typeof revert.number !== 'number') throw new GitHubApiError(502, 'revertPullRequest returned no pull request');
      return { number: revert.number, url: str(revert.url), nodeId: str(revert.id) };
    },
  };
}
