// src/webhooks/github.ts: GitHub App webhooks (B 8, main 11, main 12) as one web-standard handler
// (ADR 0016) for `POST /webhooks/github`, the URL the App manifest registers
// (`manifests/github-app.json`: `${SNAPWING_PUBLIC_URL}/webhooks/github`).
//
// Per delivery, in order:
//   1. Signature. `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>` keyed with
//      `GITHUB_WEBHOOK_SECRET`, compared in constant time. Missing or wrong is 401, before the body is
//      trusted for anything.
//   2. Parse. A body that is not a JSON object is 400.
//   3. Mapping. The event (`X-GitHub-Event`) maps to an incident of this workspace whose `repo` is the
//      payload's repository, by pull request number (`incidents.pr_number`) or by the Jira key in the
//      branch name (`incidents.jira_key`). A repository or pull request no incident knows is
//      acknowledged and ignored.
//   4. Dedupe (B 8): `seenWebhook('github', X-GitHub-Delivery, 7 days)` (a SHA-256 of the body when the
//      header is absent). When there is something to append it runs in the same transaction as the
//      appends, so a delivery that fails is not marked seen. A duplicate is 200 and does nothing.
//
// What each event appends (source `github`, deploys `deploy`):
//   pull_request opened or reopened, by a person (not a bot, not the App) on a branch whose name
//     carries an incident's key: `pr-opened` with actor role `human`, once per pull request, and only
//     where the lifecycle takes it (B 5: filed, claimed, human-fixing, fixing, stopped, escalated). The
//     fixer's own pull request is reported by the fixer through the API (B 9), never from here.
//   pull_request closed and merged by anyone but the App: `merged` (actor role `human` when a person
//     merged it), once per pull request. The App's own merges are recorded by `merge.evaluate`
//     (merge/job.ts), which may still be appending when this delivery lands.
//   check_suite or check_run completed, or a status that is not pending, for the open pull request's
//     current head: `recordCiResult` (pipeline merge/ci.ts, #214), the one place that records CI for
//     the webhook, the review job, and `merge.evaluate` alike. Once every check the base branch
//     requires has completed it appends one `ci-green`, or `ci-red` with the failing check names, per
//     head sha, and only while the lifecycle awaits CI (`ci`, `ci-retry`; B 5 takes no result while
//     the review is still running); after `ci-red` it starts the fixer retry (main 10). After
//     `ci-green` this handler starts `merge.evaluate` with its singleton key (main 14.1). CI that
//     finished before the review passed is recorded by the review job when it appends
//     `review-passed`, so nothing waits for another check delivery. A base branch that requires no
//     checks is never green (`combinedStatus.state` is vacuously `success` then; only `required` is
//     read). The projection's status is checked before any GitHub call, since most check deliveries
//     arrive while nothing waits for them. The result is recorded before the delivery is marked seen,
//     so a delivery that fails is not marked seen; a redelivery finds its head recorded and appends
//     nothing.
//   deployment_status success: `deployed:staging` or `deployed:production`, by the environment name
//     (`environments`, case-insensitive; else GitHub's `production_environment` flag), for every merged
//     incident of the repository whose merge commit is the deployed sha or is contained in it (a later
//     commit on the base branch: `compareCommits`, #215, one call per distinct merge commit, none for
//     an incident that already took the event), once per incident and environment. A commit GitHub
//     does not know, or one that does not contain the merge, appends nothing.
//
// Responses: 200 `{ outcome }` (`processed`, `duplicate`, `ignored`), 400, 401; a failure is the
// server's 500. The response never echoes the body or the secret.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EventActor, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isExpectedSeqConflict, type IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { currentLevel, lastSeqOf, latest, newEvent } from '@snapwing/pipeline/fixer/job.ts';
import { isTerminalStatus, isValidTransition, LIFECYCLE_STATUSES, OWNS_ITS_KEY, type LifecycleStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import { AWAITING_CI, recordCiResult } from '@snapwing/pipeline/merge/ci.ts';
import { startMergeEvaluate, statusOf } from '@snapwing/pipeline/merge/job.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { WorkflowPort } from '@snapwing/pipeline/ports/workflow.ts';
import { FIND_INCIDENTS_MAX_LIMIT } from '@snapwing/pipeline/state/projections/index.ts';
import type { GitHubClient } from '../github/client.ts';
// The map, and so the incident, may write `github.com/owner/name`; payloads say `owner/name`.
import { sameRepo } from '../github/repo.ts';

export const GITHUB_WEBHOOK_PATH = '/webhooks/github';
/** The `seenWebhook` source. */
export const GITHUB_WEBHOOK_SOURCE = 'github';
/** B 8: seven days. */
export const GITHUB_WEBHOOK_TTL_SEC = 7 * 24 * 60 * 60;
export const GITHUB_WEBHOOK_SECRET_NAME = 'GITHUB_WEBHOOK_SECRET';
/** The login GitHub gives the App's bot user (`<app slug>[bot]`) when the slug is `snapwing`. */
export const DEFAULT_GITHUB_BOT_LOGIN = 'snapwing[bot]';
/** Environment names, compared case-insensitively, that count as staging and as production. */
export const DEFAULT_DEPLOY_ENVIRONMENTS: Readonly<Record<DeployStage, readonly string[]>> = Object.freeze({
  staging: Object.freeze(['staging']),
  production: Object.freeze(['production']),
});
const MAX_APPEND_ATTEMPTS = 8;

export type DeployStage = 'staging' | 'production';

/** The GitHub calls this handler makes, for one repository. The app's `GitHubClient` satisfies it. */
export type GitHubWebhookClient = Pick<GitHubClient, 'getPullRequest' | 'combinedStatus' | 'compareCommits'>;

export interface GitHubWebhookDeps {
  /** The install's workspace (single tenant), stamped on every event. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  clock: () => Date;
  /** `GITHUB_WEBHOOK_SECRET`, the App's webhook secret. Required: an unsigned delivery is never trusted. */
  secret: string;
  /** A client for one `owner/name` repository. */
  github: (repo: string) => GitHubWebhookClient;
  /** The App's bot login (`<app slug>[bot]`); its pull requests and merges are not a human's. Default `snapwing[bot]`. */
  botLogin?: string;
  /** Which environment names are staging and production. Default `DEFAULT_DEPLOY_ENVIRONMENTS`. */
  environments?: Partial<Record<DeployStage, readonly string[]>>;
}

export type GitHubWebhookOutcome = 'processed' | 'duplicate' | 'ignored';

/** The `POST /webhooks/github` handler. */
export function createGitHubWebhookRoute(deps: GitHubWebhookDeps): (req: Request) => Promise<Response> {
  if (deps.secret === '') throw new Error(`${GITHUB_WEBHOOK_SECRET_NAME} is required for ${GITHUB_WEBHOOK_PATH}`);
  return async (req) => {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (!authentic(req.headers.get('x-hub-signature-256'), raw, deps.secret)) return json(401, { error: 'unauthorized' });
    const body = parse(raw);
    if (body === undefined) return json(400, { error: 'invalid-json' });
    const delivery = req.headers.get('x-github-delivery')?.trim() ?? '';
    const key = delivery !== '' ? delivery : `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const event = req.headers.get('x-github-event')?.trim() ?? '';
    return json(200, { outcome: await handle(deps, event, body, key) });
  };
}

// Handling ---------------------------------------------------------------------------------------

/** One incident's share of a delivery: what to append, decided on the log read in the transaction. */
interface Step {
  incidentId: string;
  decide: (log: readonly IncidentEvent[]) => NewEvent[];
}

async function handle(deps: GitHubWebhookDeps, event: string, body: Record<string, unknown>, key: string): Promise<GitHubWebhookOutcome> {
  if (CHECK_EVENTS.includes(event)) return handleCheck(deps, event, body, key);
  const steps = await plan(deps, event, body);
  if (steps.length === 0) {
    return (await deps.state.seenWebhook(GITHUB_WEBHOOK_SOURCE, key, GITHUB_WEBHOOK_TTL_SEC)) ? 'duplicate' : 'ignored';
  }
  const appended = await commitDelivery(deps.state, key, steps);
  if (appended === undefined) return 'duplicate';
  return appended.length > 0 ? 'processed' : 'ignored';
}

async function plan(deps: GitHubWebhookDeps, event: string, body: Record<string, unknown>): Promise<Step[]> {
  const repo = str(rec(body['repository']), 'full_name');
  if (repo === undefined) return [];
  switch (event) {
    case 'pull_request':
      return pullRequestSteps(deps, repo, body);
    case 'deployment_status':
      return deploymentSteps(deps, repo, body);
    default:
      return [];
  }
}

/**
 * In one transaction: records the delivery, then per step reads the log, decides, and appends.
 * Undefined when the delivery was seen already (nothing written), else the steps that appended.
 * Retries the whole transaction on a seq conflict.
 */
async function commitDelivery(state: StatePort, key: string, steps: readonly Step[]): Promise<Step[] | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await state.transaction(async (tx) => {
        if (await tx.seenWebhook(GITHUB_WEBHOOK_SOURCE, key, GITHUB_WEBHOOK_TTL_SEC)) return undefined;
        const appended: Step[] = [];
        for (const step of steps) {
          const log = await tx.read(step.incidentId);
          const events = step.decide(log);
          if (events.length === 0) continue;
          await tx.append(step.incidentId, events, log.at(-1)?.seq ?? 0);
          appended.push(step);
        }
        return appended;
      });
    } catch (e) {
      if (!isExpectedSeqConflict(e) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
    }
  }
}

// pull_request -----------------------------------------------------------------------------------

async function pullRequestSteps(deps: GitHubWebhookDeps, repo: string, body: Record<string, unknown>): Promise<Step[]> {
  const action = str(body, 'action');
  const pr = rec(body['pull_request']);
  const number = int(pr['number']) ?? int(body['number']);
  const branch = str(rec(pr['head']), 'ref');
  if (number === undefined) return [];
  const bot = botLogin(deps);

  if ((action === 'opened' || action === 'reopened') && branch !== undefined) {
    const author = rec(pr['user']);
    const login = str(author, 'login');
    if (login === undefined || !isPerson(author, bot)) return [];
    const incident = await incidentByBranch(deps, repo, [branch]);
    if (incident === undefined) return [];
    const occurredAt = time(pr['created_at']) ?? deps.clock().toISOString();
    const actor: EventActor = { id: login, role: 'human' };
    return [
      {
        incidentId: incident.id,
        decide: (log) => {
          if (prOpenedSinceFiled(log, number)) return [];
          const e = at(newEvent(deps, incident.id, 'pr-opened', { prNumber: number, branch }, { actor, source: 'github' }), occurredAt);
          return fits(log, e) ? [e] : [];
        },
      },
    ];
  }

  if (action === 'closed' && pr['merged'] === true) {
    const mergedBy = rec(pr['merged_by']);
    const login = str(mergedBy, 'login');
    if (login !== undefined && sameLogin(login, bot)) return [];
    const sha = str(pr, 'merge_commit_sha');
    if (sha === undefined) return [];
    const incident = (await incidentByPr(deps, repo, number)) ?? (await incidentByBranch(deps, repo, branch === undefined ? [] : [branch]));
    if (incident === undefined) return [];
    const occurredAt = time(pr['merged_at']) ?? deps.clock().toISOString();
    const actor: EventActor | undefined = login !== undefined && isPerson(mergedBy, bot) ? { id: login, role: 'human' } : undefined;
    return [
      {
        incidentId: incident.id,
        decide: (log) => {
          const opened = latest(log, 'pr-opened');
          if (opened?.payload.prNumber !== number || isTerminalStatus(statusOf(log))) return [];
          if (log.some((e) => e.seq > opened.seq && e.type === 'merged' && e.payload.prNumber === number)) return [];
          const levelAtMergeTime = currentLevel(log) ?? incident.autonomyLevel ?? 0;
          const extra = { source: 'github' as const, ...(actor === undefined ? {} : { actor }) };
          return [at(newEvent(deps, incident.id, 'merged', { prNumber: number, mergeCommitSha: sha, levelAtMergeTime }, extra), occurredAt)];
        },
      },
    ];
  }
  return [];
}

/** A `pr-opened` for PR `number` since the latest `filed`. */
function prOpenedSinceFiled(log: readonly IncidentEvent[], number: number): boolean {
  const since = lastSeqOf(log, 'filed');
  return log.some((e) => e.seq > since && e.type === 'pr-opened' && e.payload.prNumber === number);
}

// check_suite, check_run, status -----------------------------------------------------------------

const CHECK_EVENTS: readonly string[] = ['check_suite', 'check_run', 'status'];

async function handleCheck(deps: GitHubWebhookDeps, event: string, body: Record<string, unknown>, key: string): Promise<GitHubWebhookOutcome> {
  const target = await checkTarget(deps, event, body);
  const result = target === undefined ? undefined : await recordCiResult(deps, target.incidentId, { headSha: target.headSha });
  const seen = await deps.state.seenWebhook(GITHUB_WEBHOOK_SOURCE, key, GITHUB_WEBHOOK_TTL_SEC);
  if (target !== undefined && result?.recorded === 'ci-green') await startMergeEvaluate(deps, target.incidentId);
  if (seen) return 'duplicate';
  return result !== undefined && result.recorded !== false ? 'processed' : 'ignored';
}

/** The incident awaiting CI that a completed check delivery is about, and the head it reports. */
async function checkTarget(deps: GitHubWebhookDeps, event: string, body: Record<string, unknown>): Promise<{ incidentId: string; headSha: string } | undefined> {
  const repo = str(rec(body['repository']), 'full_name');
  const head = checkHead(event, body);
  if (repo === undefined || head === undefined) return undefined;
  let incident: IncidentView | undefined;
  for (const n of head.prNumbers) {
    incident = await incidentByPr(deps, repo, n);
    if (incident !== undefined) break;
  }
  incident ??= await incidentByBranch(deps, repo, head.branches);
  // Before any GitHub call: most check deliveries arrive while nothing waits for them.
  if (incident === undefined || incident.prNumber === undefined || !AWAITING_CI.includes(incident.status)) return undefined;
  return { incidentId: incident.id, headSha: head.sha };
}

interface CheckHead {
  sha: string;
  prNumbers: number[];
  branches: string[];
}

/** The head sha a check delivery is about, once it is complete; undefined while it is still running. */
function checkHead(event: string, body: Record<string, unknown>): CheckHead | undefined {
  if (event === 'status') {
    const sha = str(body, 'sha');
    if (sha === undefined || str(body, 'state') === 'pending') return undefined;
    const branches = list(body['branches']).flatMap((b) => opt(str(rec(b), 'name')));
    return { sha, prNumbers: [], branches };
  }
  if (str(body, 'action') !== 'completed') return undefined;
  const subject = rec(body[event]);
  const suite = event === 'check_run' ? rec(subject['check_suite']) : subject;
  const sha = str(subject, 'head_sha');
  if (sha === undefined) return undefined;
  const prs = [...list(subject['pull_requests']), ...(event === 'check_run' ? list(suite['pull_requests']) : [])];
  const prNumbers = [...new Set(prs.flatMap((p) => opt(int(rec(p)['number']))))];
  const branches = [...new Set([...prs.flatMap((p) => opt(str(rec(rec(p)['head']), 'ref'))), ...opt(str(suite, 'head_branch'))])];
  return { sha, prNumbers, branches };
}

// deployment_status ------------------------------------------------------------------------------

async function deploymentSteps(deps: GitHubWebhookDeps, repo: string, body: Record<string, unknown>): Promise<Step[]> {
  const status = rec(body['deployment_status']);
  const deployment = rec(body['deployment']);
  if (str(status, 'state') !== 'success') return [];
  const sha = str(deployment, 'sha');
  const stage = deployStageOf(str(status, 'environment') ?? str(deployment, 'environment'), deployment['production_environment'] === true, deps.environments);
  if (sha === undefined || stage === undefined) return [];
  const deploymentId = int(deployment['id']);
  const occurredAt = time(status['updated_at']) ?? time(status['created_at']) ?? deps.clock().toISOString();
  const type = stage === 'staging' ? 'deployed:staging' : 'deployed:production';
  const later: readonly string[] = stage === 'staging' ? ['deployed:staging', 'deployed:production'] : ['deployed:production'];

  const candidates = await incidentsOf(deps, repo, ['merged', 'deployed:staging']);
  // Decided on the log read here (the transaction re-reads it): which merge commits could the deploy contain.
  const contained = new Map<string, boolean>();
  const steps: Step[] = [];
  for (const incident of candidates) {
    if (stage === 'staging' && incident.status === 'deployed:staging') continue;
    const merged = latest(await deps.state.read(incident.id), 'merged');
    const mergeSha = merged?.payload.mergeCommitSha;
    if (mergeSha === undefined || isTerminalStatus(incident.status)) continue;
    if (mergeSha !== sha && !contained.has(mergeSha)) contained.set(mergeSha, (await deps.github(repo).compareCommits(mergeSha, sha)).contains);
    if (mergeSha !== sha && contained.get(mergeSha) !== true) continue;
    steps.push({
      incidentId: incident.id,
      decide: (log) => {
        const m = latest(log, 'merged');
        if (m?.payload.mergeCommitSha !== mergeSha || isTerminalStatus(statusOf(log))) return [];
        if (log.some((e) => e.seq > m.seq && (later.includes(e.type) || e.type === 'reverted'))) return [];
        const payload = { commitSha: sha, ...(deploymentId === undefined ? {} : { deploymentId: String(deploymentId) }) };
        return [at(newEvent(deps, incident.id, type, payload, { source: 'deploy' }), occurredAt)];
      },
    });
  }
  return steps;
}

/**
 * The stage a deployment's environment is: by name (`environments`, case-insensitive), else GitHub's
 * `production_environment` flag. Shared with the deploy poll (reconcile/sources.ts).
 */
export function deployStageOf(environment: string | undefined, productionFlag: boolean, environments?: Partial<Record<DeployStage, readonly string[]>>): DeployStage | undefined {
  const name = environment?.trim().toLowerCase();
  if (name !== undefined) {
    for (const stage of ['production', 'staging'] as const) {
      const names = environments?.[stage] ?? DEFAULT_DEPLOY_ENVIRONMENTS[stage];
      if (names.some((n) => n.trim().toLowerCase() === name)) return stage;
    }
  }
  return productionFlag ? 'production' : undefined;
}

// Mapping ----------------------------------------------------------------------------------------

const ACTIVE_STATUSES: readonly LifecycleStatus[] = LIFECYCLE_STATUSES.filter((s) => !isTerminalStatus(s));

/** The workspace's incidents in `repo` (any of `statuses`), most recently updated first. */
async function incidentsOf(deps: GitHubWebhookDeps, repo: string, statuses: readonly LifecycleStatus[]): Promise<IncidentView[]> {
  const rows = await deps.state.findIncidents({ workspaceId: deps.workspaceId, status: statuses, limit: FIND_INCIDENTS_MAX_LIMIT });
  return rows.filter((r) => sameRepo(r.repo, repo));
}

/** The active incident whose pull request is `repo#number`. */
async function incidentByPr(deps: GitHubWebhookDeps, repo: string, number: number): Promise<IncidentView | undefined> {
  return (await incidentsOf(deps, repo, ACTIVE_STATUSES)).find((r) => r.prNumber === number);
}

/** The incident in `repo` whose Jira key one of `branches` carries (`fix/web-1042-total` names `WEB-1042`). */
async function incidentByBranch(deps: GitHubWebhookDeps, repo: string, branches: readonly string[]): Promise<IncidentView | undefined> {
  for (const key of new Set(branches.flatMap(issueKeys))) {
    const [found] = await deps.state.findIncidents({ workspaceId: deps.workspaceId, jiraKey: key, status: OWNS_ITS_KEY, limit: 1 });
    if (found !== undefined && sameRepo(found.repo, repo)) return found;
  }
  return undefined;
}

const ISSUE_KEY = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)(?![0-9])/g;

/** Jira-shaped keys in a branch name, upper-cased, in order. */
export function issueKeys(branch: string): string[] {
  return [...branch.matchAll(ISSUE_KEY)].flatMap((m) => opt(m[1]?.toUpperCase()));
}

// Lifecycle --------------------------------------------------------------------------------------

/** Whether `event` fits the status `log` folds to (B 5). */
function fits(log: readonly IncidentEvent[], event: NewEvent): boolean {
  const candidate = { ...event, seq: (log.at(-1)?.seq ?? 0) + 1, recordedAt: event.occurredAt } as unknown as IncidentEvent;
  return isValidTransition(statusOf(log), candidate);
}

function at<E extends NewEvent>(event: E, occurredAt: string): E {
  return { ...event, occurredAt };
}

// Actors -----------------------------------------------------------------------------------------

function botLogin(deps: GitHubWebhookDeps): string {
  const login = deps.botLogin?.trim() ?? '';
  return login === '' ? DEFAULT_GITHUB_BOT_LOGIN : login;
}

/** A GitHub user that is a person: not a bot account, and not the App. */
function isPerson(user: Record<string, unknown>, bot: string): boolean {
  const login = str(user, 'login');
  return login !== undefined && str(user, 'type') !== 'Bot' && !login.endsWith('[bot]') && !sameLogin(login, bot);
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Delivery ---------------------------------------------------------------------------------------

function authentic(signature: string | null, raw: Uint8Array, secret: string): boolean {
  if (signature === null) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const x = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  const y = Buffer.from(expected, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// Parsing (the body is untrusted; unknown keys are ignored) --------------------------------------

function parse(raw: Uint8Array): Record<string, unknown> | undefined {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** An own, non-empty string property. */
function str(o: Record<string, unknown>, k: string): string | undefined {
  if (!Object.hasOwn(o, k)) return undefined;
  const v = o[k];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/** An ISO 8601 instant, normalized; undefined for anything else. */
function time(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

function opt<T>(v: T | undefined): T[] {
  return v === undefined ? [] : [v];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
