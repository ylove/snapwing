// src/merge/actions.ts: the PR buttons (main 11.2, main 16, main 20.2): Merge, Request changes,
// Stop, and Revert. `createPrActions` implements the Slack interactivity's `PrActions` (
// `app/src/adapters/slack/interactivity.ts`) plus `stop`; the CLI and other callers use it too.
//
// Every action authorizes again here (`authorize`, policy/authorize.ts), with the actor's role taken
// from the workspace map by their chat user id (never the role the caller passed) and the linked
// identity checked live, so a caller that skipped the check is still refused.
//
// - merge: only for an actor with a linked identity who is a reviewer of the PR: in GitHub's live
//   requested reviewers, or in the reviewers `resolveReviewers` (human.ts) resolves now (GitHub drops
//   a user from the requested list once they review). Performed with the actor's user-to-server token,
//   squash, pinned to the head it read, so GitHub's audit log names the human (main 16). Then `merged`
//   with the actor and the level in force (prefixed by `ci-green` while the log still waits for CI,
//   as merge/job.ts does). GitHub's own refusals come back as refusals: 405 (branch protection, e.g.
//   no approving review yet), 409 (the head moved), 403, and 401 (the link is dead).
// - request_changes: once per filed incident, sends the fixer back with the human's comment. The
//   comment is stored as a `review` artifact in the `ReviewVerdict` shape (the runner hands it to the
//   harness as `SNAPWING_PRIOR_REVIEW_FILE`), `review-failed { verdict: 'request-changes' }` is appended
//   with the actor and a reason starting `changes-requested:`, and `startFixer` runs the next attempt.
// - stop: `stopIncident` (fixer/stop.ts).
// - revert: `revert` (merge/revert.ts), which does not authorize itself.
//
// `humanMerge`, `humanRequestChanges`, `humanStop`, and `humanRevert` resolve to an outcome and never
// throw for a refusal. `createPrActions` wraps them for `PrActions`, whose methods resolve to void: a
// refusal rejects with `PrActionRefusedError` (carrying the outcome and a message for the user), so the
// Slack side never marks a card as merged when nothing was merged.

import type { ArtifactRef, EventActor, EventSource, IncidentEvent } from '../contracts/events.ts';
import type { IncidentView } from '../contracts/state.ts';
import { activeRun, appendDecided, currentLevel, lastSeqOf, latest, newEvent, startFixer, stoppedSinceFiled } from '../fixer/job.ts';
import type { StopInput, StopOutcome } from '../fixer/stop.ts';
import type { LifecycleStatus } from '../lifecycle/machine.ts';
import type { MapActorRole } from '../map/types.ts';
import { authorize, type DenyReason } from '../policy/authorize.ts';
import type { ReviewVerdict } from '../review/verdict.ts';
import { repoFullName } from '../util/repo.ts';
import { loadMap, resolveReviewers, sameLogin, type ChatUserRef, type HumanDeps } from './human.ts';
import { httpStatus, statusOf, type MergeResult } from './job.ts';
import type { RevertOptions, RevertOutcome, RevertRefusal } from './revert.ts';

/** Prefix of the `review-failed` reason that records a human's request for changes. */
export const HUMAN_CHANGES_REASON_PREFIX = 'changes-requested:';

/** Statuses in which a fixer run or an agent PR is active (Stop at level 1), as the Slack side reads them. */
const FIXER_ACTIVE: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['fixing', 'fixing-retry', 'in-review', 'in-review-retry', 'ci', 'ci-retry', 'mergeable', 'held']);

/** A PR button tap. Structurally the Slack interactivity's `PrActionInput`, plus what other callers add. */
export interface PrActionInput {
  incidentId: string;
  /** The tapper: their chat user id. The role is read from the map, not from here. */
  actor: EventActor;
  /** The PR the card showed; a tap on an older PR's card is refused. */
  prNumber?: number;
  repo?: string;
}

export interface HumanPrActionInput extends PrActionInput {
  /** Request changes: what the fixer should change. */
  comment?: string;
  /** Stop and Revert: why. */
  reason?: string;
  /** Where the tap came from. Default the chat platform. */
  source?: EventSource;
}

export interface PrActionsDeps extends HumanDeps {
  /** `stopIncident` from fixer/stop.ts, bound to its FixerDeps. */
  stopIncident: (input: StopInput) => Promise<StopOutcome>;
  /** `revert` from merge/revert.ts, bound to its MergeDeps. */
  revert: (incidentId: string, actor: EventActor, opts?: RevertOptions) => Promise<RevertOutcome>;
}

export type PrActionKind = 'merge' | 'request_changes' | 'stop' | 'revert';

export type PrActionRefusal =
  | 'unknown-incident'
  | 'denied'
  | 'not-linked'
  | 'not-reviewer'
  | 'no-pr'
  | 'stale-pr'
  | 'no-repo'
  | 'not-open'
  | 'stopped'
  | 'merged'
  | 'head-moved'
  | 'not-mergeable'
  | 'forbidden'
  | 'fixer-running'
  | 'already-requested'
  | 'already-stopped'
  | 'terminal'
  | RevertRefusal;

export type PrActionRefused = {
  done: false;
  action: PrActionKind;
  reason: PrActionRefusal;
  /** For the person who tapped. */
  message: string;
  /** Set with `denied`. */
  deny?: DenyReason;
  /** Set with `not-linked`: where to link a GitHub account (`/auth/github/start`). */
  linkUrl?: string;
};

export type PrActionOutcome =
  | { done: true; action: 'merge'; prNumber: number; mergeCommitSha: string; githubLogin: string }
  | { done: true; action: 'request_changes'; prNumber: number; attempt: number; review: ArtifactRef }
  | { done: true; action: 'stop'; outcome: Extract<StopOutcome, { stopped: true }> }
  | { done: true; action: 'revert'; outcome: Extract<RevertOutcome, { reverted: true }> }
  | PrActionRefused;

/** A refused PR action, from `createPrActions`. */
export class PrActionRefusedError extends Error {
  constructor(readonly outcome: PrActionRefused) {
    super(outcome.message);
    this.name = 'PrActionRefusedError';
  }
}

/**
 * The Slack interactivity's `PrActions` exactly, plus `stop`. Each resolves when the action was
 * done and rejects with `PrActionRefusedError` when it was refused.
 */
export interface HumanPrActions {
  merge(input: HumanPrActionInput): Promise<void>;
  requestChanges(input: HumanPrActionInput): Promise<void>;
  stop(input: HumanPrActionInput): Promise<void>;
  revert(input: HumanPrActionInput): Promise<void>;
}

export function createPrActions(deps: PrActionsDeps): HumanPrActions {
  const orThrow = async (outcome: Promise<PrActionOutcome>): Promise<void> => {
    const result = await outcome;
    if (!result.done) throw new PrActionRefusedError(result);
  };
  return {
    merge: (input) => orThrow(humanMerge(deps, input)),
    requestChanges: (input) => orThrow(humanRequestChanges(deps, input)),
    stop: (input) => orThrow(humanStop(deps, input)),
    revert: (input) => orThrow(humanRevert(deps, input)),
  };
}

// Merge ------------------------------------------------------------------------------------------

/** main 11.2 step 3: merge as the linked human who is a reviewer. */
export async function humanMerge(deps: PrActionsDeps, input: HumanPrActionInput): Promise<PrActionOutcome> {
  const action = 'merge';
  const ctx = await authorized(deps, action, input);
  if (!ctx.ok) return ctx.refused;
  const { log, incident, user, actor } = ctx;
  const pr = currentPr(action, log, input);
  if (typeof pr !== 'number') return pr;
  const mapRepo = incident?.repo;
  if (mapRepo === undefined || mapRepo === '') return refuse(action, 'no-repo');
  const repo = repoFullName(mapRepo);

  const token = await deps.identity.userToken(user);
  if (token === null) return refuse(action, 'not-linked', { linkUrl: await deps.identity.linkUrl(user) });

  const gh = deps.github(repo);
  const live = await gh.getPullRequest(pr);
  if (live.merged) return refuse(action, 'merged');
  if (live.state !== 'open') return refuse(action, 'not-open');
  if (!(await isReviewer(deps, repo, live, token.githubLogin, incident))) return refuse(action, 'not-reviewer');

  let merge: MergeResult;
  try {
    merge = await gh.mergePullRequest(pr, { expectedHeadSha: live.headSha, userToken: token.token });
  } catch (e) {
    const status = httpStatus(e);
    if (status === 409) return refuse(action, 'head-moved');
    if (status === 405) return refuse(action, 'not-mergeable', { detail: errorMessage(e) });
    if (status === 403) return refuse(action, 'forbidden');
    if (status === 401) return refuse(action, 'not-linked', { linkUrl: await deps.identity.linkUrl(user) });
    throw e;
  }
  if (!merge.merged) return refuse(action, 'not-mergeable', { detail: merge.message });

  // GitHub merged it: record it whatever the log now says (the webhook may record it first).
  const source = input.source ?? deps.chat;
  await appendDecided(deps.state, input.incidentId, (events) => {
    if (mergedSince(events, pr)) return undefined;
    const status = statusOf(events);
    const ciGreen = status === 'ci' || status === 'ci-retry' ? [newEvent(deps, input.incidentId, 'ci-green', { prNumber: pr, headSha: live.headSha }, { source: 'github' })] : [];
    const levelAtMergeTime = currentLevel(events) ?? incident?.autonomyLevel ?? 2;
    return [...ciGreen, newEvent(deps, input.incidentId, 'merged', { prNumber: pr, mergeCommitSha: merge.sha, levelAtMergeTime }, { actor, source })];
  });
  return { done: true, action, prNumber: pr, mergeCommitSha: merge.sha, githubLogin: token.githubLogin };
}

/** A requested reviewer on GitHub now, or one of the reviewers resolved from `CODEOWNERS` or the map. */
async function isReviewer(
  deps: PrActionsDeps,
  repo: string,
  pr: { number: number; authorLogin: string | null; requestedReviewers: readonly string[] },
  login: string,
  incident: IncidentView | null,
): Promise<boolean> {
  if (pr.requestedReviewers.some((r) => sameLogin(r, login))) return true;
  const files = await deps.github(repo).listPullRequestFiles(pr.number);
  const resolved = await resolveReviewers(deps, {
    repo,
    paths: files.map((f) => f.filename),
    ...(incident?.surfaceId === undefined ? {} : { surfaceId: incident.surfaceId }),
    ...(incident?.componentId === undefined ? {} : { componentId: incident.componentId }),
    authorLogin: pr.authorLogin,
  });
  return resolved.users.some((u) => sameLogin(u, login));
}

// Request changes --------------------------------------------------------------------------------

/** Sends the fixer back once with the human's comment (main 11.2, main 20.2). */
export async function humanRequestChanges(deps: PrActionsDeps, input: HumanPrActionInput): Promise<PrActionOutcome> {
  const action = 'request_changes';
  const ctx = await authorized(deps, action, input);
  if (!ctx.ok) return ctx.refused;
  const { log, actor } = ctx;
  const pr = currentPr(action, log, input);
  if (typeof pr !== 'number') return pr;
  const early = refuseChanges(log, pr);
  if (early !== undefined) return refuse(action, early);

  const comment = input.comment?.trim() ?? '';
  const verdict: ReviewVerdict = {
    verdict: 'request-changes',
    reasons: [comment === '' ? `Changes requested by ${actor.id} with no comment; ask them what to change before guessing.` : comment],
    constraintViolations: [],
  };
  const put = await deps.state.putArtifact({
    workspaceId: deps.workspaceId,
    incidentId: input.incidentId,
    kind: 'review',
    contentType: 'application/json',
    body: JSON.stringify(verdict),
    createdBy: actor.id,
  });
  const review: ArtifactRef = { artifactId: put.id, version: put.version };

  let refused: PrActionRefusal = 'already-requested';
  let attempt = 2;
  const source = input.source ?? deps.chat;
  const appended = await appendDecided(deps.state, input.incidentId, (events) => {
    const latestPr = latest(events, 'pr-opened')?.payload.prNumber;
    const again = latestPr !== pr ? 'stale-pr' : refuseChanges(events, pr);
    if (again !== undefined) {
      refused = again;
      return undefined;
    }
    attempt = nextAttempt(events);
    const reason = `${HUMAN_CHANGES_REASON_PREFIX} by ${actor.id}${comment === '' ? '' : `: ${comment}`}`;
    return [newEvent(deps, input.incidentId, 'review-failed', { prNumber: pr, verdict: 'request-changes', reason, review }, { actor, source })];
  });
  if (!appended.appended) return refuse(action, refused);
  await startFixer(deps, { incidentId: input.incidentId, attempt, reviewArtifact: review });
  return { done: true, action, prNumber: pr, attempt, review };
}

function refuseChanges(log: readonly IncidentEvent[], pr: number): PrActionRefusal | undefined {
  if (stoppedSinceFiled(log)) return 'stopped';
  if (mergedSince(log, pr)) return 'merged';
  if (activeRun(log) !== undefined) return 'fixer-running';
  const since = lastSeqOf(log, 'filed');
  const asked = log.some((e) => e.seq > since && e.type === 'review-failed' && e.payload.reason.startsWith(HUMAN_CHANGES_REASON_PREFIX));
  return asked ? 'already-requested' : undefined;
}

/** One more than the highest fixer attempt since the latest `filed` (at least 2: this is a retry). */
function nextAttempt(log: readonly IncidentEvent[]): number {
  const since = lastSeqOf(log, 'filed');
  let max = 1;
  for (const e of log) if (e.seq > since && e.type === 'fixer-started') max = Math.max(max, e.payload.attempt);
  return max + 1;
}

// Stop and Revert --------------------------------------------------------------------------------

/** The Stop button (main 10.4). */
export async function humanStop(deps: PrActionsDeps, input: HumanPrActionInput): Promise<PrActionOutcome> {
  const action = 'stop';
  const ctx = await authorized(deps, action, input);
  if (!ctx.ok) return ctx.refused;
  const outcome = await deps.stopIncident({
    incidentId: input.incidentId,
    actor: ctx.actor,
    source: input.source ?? deps.chat,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (!outcome.stopped) return refuse(action, outcome.reason);
  return { done: true, action, outcome };
}

/** The Revert button (main 11.3). `revert` does not authorize, so this does first. */
export async function humanRevert(deps: PrActionsDeps, input: HumanPrActionInput): Promise<PrActionOutcome> {
  const action = 'revert';
  const ctx = await authorized(deps, action, input);
  if (!ctx.ok) return ctx.refused;
  const outcome = await deps.revert(input.incidentId, ctx.actor, {
    source: input.source ?? deps.chat,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (!outcome.reverted) return refuse(action, outcome.reason);
  return { done: true, action, outcome };
}

// Shared -----------------------------------------------------------------------------------------

type Authorized =
  | { ok: true; log: IncidentEvent[]; incident: IncidentView | null; user: ChatUserRef; actor: EventActor }
  | { ok: false; refused: PrActionRefused };

/** Reads the incident and authorizes `action` for the actor (main 16). */
async function authorized(deps: PrActionsDeps, action: PrActionKind, input: HumanPrActionInput): Promise<Authorized> {
  const [log, incident, map] = await Promise.all([deps.state.read(input.incidentId), deps.state.getIncident(input.incidentId), loadMap(deps.map)]);
  if (log.length === 0) return { ok: false, refused: refuse(action, 'unknown-incident') };
  const user: ChatUserRef = { chat: deps.chat, userId: input.actor.id };
  const person = map.people.find((p) => (deps.chat === 'slack' ? p.slackId : p.teamsId) === input.actor.id);
  const role: MapActorRole = person?.role ?? 'unknown';
  const actor: EventActor = { id: input.actor.id, role, ...(input.actor.name === undefined ? {} : { name: input.actor.name }) };
  const needsLink = action === 'merge' || action === 'revert';
  const githubLinked = needsLink ? await deps.identity.isLinked(user) : false;
  const level = currentLevel(log) ?? incident?.autonomyLevel ?? 1;
  const decision = authorize(action, { kind: 'human', role, githubLinked }, { level, fixerActive: FIXER_ACTIVE.has(statusOf(log)) });
  if (decision.allowed) return { ok: true, log, incident, user, actor };
  if (decision.reason === 'linked-identity-required') {
    return { ok: false, refused: refuse(action, 'not-linked', { deny: decision.reason, linkUrl: await deps.identity.linkUrl(user) }) };
  }
  return { ok: false, refused: { ...refuse(action, 'denied', { deny: decision.reason }), message: DENY_MESSAGES[decision.reason] } };
}

/** The incident's open PR, or the refusal: none, stopped, merged, or the tap names an older PR. */
function currentPr(action: PrActionKind, log: readonly IncidentEvent[], input: PrActionInput): number | PrActionRefused {
  const opened = latest(log, 'pr-opened');
  if (opened === undefined) return refuse(action, 'no-pr');
  const pr = opened.payload.prNumber;
  if (input.prNumber !== undefined && input.prNumber !== pr) return refuse(action, 'stale-pr');
  if (stoppedSinceFiled(log)) return refuse(action, 'stopped');
  if (mergedSince(log, pr)) return refuse(action, 'merged');
  return pr;
}

/** A `merged` for PR `pr` after its latest `pr-opened`. */
function mergedSince(events: readonly IncidentEvent[], pr: number): boolean {
  const since = lastSeqOf(events, 'pr-opened');
  return events.some((e) => e.seq > since && e.type === 'merged' && e.payload.prNumber === pr);
}

const MESSAGES: Readonly<Record<PrActionRefusal, string>> = {
  'unknown-incident': 'This incident no longer exists.',
  denied: 'You cannot do that on this incident.',
  'not-linked': 'Link your GitHub account to Snapwing first; this button acts as you on GitHub.',
  'not-reviewer': 'Only a requested reviewer of this pull request can merge it from here.',
  'no-pr': 'There is no pull request for this incident yet.',
  'stale-pr': 'This card is for an older pull request.',
  'no-repo': 'This incident has no repository.',
  'not-open': 'This pull request is closed.',
  stopped: 'This incident was stopped.',
  merged: 'This pull request is already merged.',
  'head-moved': 'The pull request changed since it was checked; look at the new commits and try again.',
  'not-mergeable': 'GitHub would not merge this pull request.',
  forbidden: 'GitHub says your account cannot merge this pull request.',
  'fixer-running': 'The fixer is already working on this incident.',
  'already-requested': 'Changes were already requested once; take it from here on GitHub.',
  'already-stopped': 'This incident is already stopped.',
  terminal: 'This incident is already closed.',
  'not-merged': 'Nothing was merged, so there is nothing to revert.',
  'not-autopilot': 'Only an autopilot merge can be reverted from here; open a revert on GitHub.',
  'already-reverted': 'This merge was already reverted.',
  'window-closed': 'The revert window has closed; open a revert on GitHub.',
};

const DENY_MESSAGES: Readonly<Record<DenyReason, string>> = {
  'engineer-required': 'Only an engineer on this surface can do that.',
  'linked-identity-required': MESSAGES['not-linked'],
  'agent-merges': 'At this level the agent merges once every gate passes.',
  'level-disallows': 'That is not available at this autonomy level.',
  'nothing-to-stop': 'Nothing is running for this incident yet.',
};

function refuse(action: PrActionKind, reason: PrActionRefusal, extra: { deny?: DenyReason; linkUrl?: string; detail?: string } = {}): PrActionRefused {
  const detail = extra.detail?.trim() ?? '';
  return {
    done: false,
    action,
    reason,
    message: detail === '' ? MESSAGES[reason] : `${MESSAGES[reason]} ${detail}`,
    ...(extra.deny === undefined ? {} : { deny: extra.deny }),
    ...(extra.linkUrl === undefined ? {} : { linkUrl: extra.linkUrl }),
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
