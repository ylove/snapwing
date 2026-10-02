// src/merge/human.ts: human in the loop at levels 1 and 2 (main 11.2, main 16, main 20.2). The PR
// buttons themselves are actions.ts.
//
// `requestHumanReview(deps, incidentId)` runs when a PR is ready for a human: after `review-passed`
// for the open PR at level 1 or 2, and after a level 3 `held` (merge/job.ts degrades the incident to
// level 2 and the card is how the human path starts, main 11.3). Compose (#159) calls it from the
// code that appends those events. It re-reads everything and is safe to call again:
//
// 1. Reviewers (`resolveReviewers`): `CODEOWNERS` owners of the PR's touched paths (users, `@org/team`
//    teams, and emails the map knows), falling back, when no rule names an owner, to the map's people
//    who own the incident's surface (`people/owns`, the component's owners when it has any). A map
//    person's GitHub login is their linked identity's login, else their map `handle`.
// 2. Requests review from them on GitHub, skipping anyone already requested. GitHub refuses the whole
//    request (422) when one login is not a collaborator, so a 422 is retried one reviewer at a time
//    and the refused ones are reported, not thrown.
// 3. Posts the `pr-ready` card (contracts/adapters.ts) in the originating thread and in the surface's
//    bug channel (the map's first channel for the surface; skipped when it is the thread's channel).
//    `canMerge` is true when at least one requested reviewer has a linked identity: the buttons are
//    then on the card, and a tap by anyone else is refused (policy/authorize.ts, actions.ts).
// 4. Each requested reviewer the map knows who has no linked identity gets, privately, the `Open PR`
//    only card and the link to `/auth/github/start` (`IdentityLinks.linkUrl`, main 11.2 step 3).
//
// Each post is recorded in the cache under the trigger event's seq, so a retry posts nothing twice and
// a later review (after a retry run) posts a fresh card. A failed private prompt goes to `onError`
// and is not retried (the user may not be in the channel); a failed card post throws.

import type { IncidentEvent } from '../contracts/events.ts';
import type { PrReadyCard } from '../contracts/adapters.ts';
import { keySegment } from '../contracts/jobs.ts';
import { currentLevel, lastSeqOf, latest, stoppedSinceFiled } from '../fixer/job.ts';
import type { MapPerson, WorkspaceMap } from '../map/types.ts';
import type { CachePort } from '../ports/cache.ts';
import type { ChatPlatform, StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { repoFullName } from '../util/repo.ts';
import { httpStatus, reviewVerdict, type MergeRequiredCheck, type MergeResult } from './job.ts';

/** How long a posted-card record is kept (the card is posted once per trigger event). */
export const HUMAN_REVIEW_POSTED_TTL_SEC = 30 * 24 * 60 * 60;

// The GitHub side --------------------------------------------------------------------------------

/** The fields of a pull request the human path reads. The app's `PullRequest` has them all. */
export interface HumanPullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  htmlUrl: string;
  headSha: string;
  baseRef: string;
  authorLogin: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Logins of the users whose review is still requested. GitHub drops a user once they review. */
  requestedReviewers: readonly string[];
}

export interface HumanCombinedStatus {
  /** The checks the base branch requires. */
  required: readonly MergeRequiredCheck[];
  /** Everything reported for the sha; read only when the base branch requires nothing. */
  all?: readonly { state: 'success' | 'pending' | 'failure' }[];
}

/**
 * The GitHub operations of the human path, for one repository. The app's `GitHubClient`
 * (`app/src/github/client.ts`) satisfies it as is. Errors carry the HTTP `status`.
 */
export interface HumanGitHub {
  getPullRequest(number: number): Promise<HumanPullRequest>;
  listPullRequestFiles(number: number): Promise<readonly { filename: string }[]>;
  combinedStatus(sha: string, baseBranch: string): Promise<HumanCombinedStatus>;
  requestReviewers(number: number, reviewers: { users?: readonly string[]; teams?: readonly string[] }): Promise<void>;
  /** Squash merge pinned to `expectedHeadSha`; with `userToken`, performed (and audited) as that user. */
  mergePullRequest(number: number, input: { expectedHeadSha: string; userToken?: string }): Promise<MergeResult>;
}

/** `CODEOWNERS` resolution for one repository; the app's `createCodeownersResolver` satisfies it. */
export interface CodeownersLookup {
  /** `owners`: the union across `paths` of `@user`, `@org/team`, and email owners. */
  codeownersFor(paths: readonly string[]): Promise<{ owners: readonly string[] }>;
}

// The identity side ------------------------------------------------------------------------------

/** A chat user, as the app's GitHub OAuth (`app/src/github/oauth.ts`) keys links. */
export interface ChatUserRef {
  chat: ChatPlatform;
  userId: string;
}

/**
 * Linked GitHub identities (main 11.2, ADR 0007). The app's `GitHubOAuth` satisfies it as is. The
 * token is a user-to-server token: never logged, never stored by this module.
 */
export interface IdentityLinks {
  /** The private link that starts `/auth/github/start` for this user. */
  linkUrl(user: ChatUserRef): Promise<string>;
  getLinkedIdentity(user: ChatUserRef): Promise<{ githubLogin: string } | null>;
  /** True when the link is usable (its token is current or can be refreshed). */
  isLinked(user: ChatUserRef): Promise<boolean>;
  /** A fresh user-to-server token, or null when not linked or the link is dead. */
  userToken(user: ChatUserRef): Promise<{ token: string; githubLogin: string } | null>;
}

// The chat side ----------------------------------------------------------------------------------

/** Where a card goes: a channel, and the thread in it when there is one. */
export interface ChatTarget {
  channel: string;
  /** The originating thread. The chat side drops it where threads do not apply (a direct message). */
  threadId?: string;
}

/** Posts the `pr-ready` card (main 11.2). The Slack side builds it with `buildPrReady` (#129). */
export interface PrReadyChat {
  /** Posts the card; with `canMerge` false it offers `Open PR` only. */
  postPrReady(target: ChatTarget, incidentId: string, card: PrReadyCard, opts: { canMerge: boolean }): Promise<void>;
  /** Shows one user, privately, the `Open PR` only card and `linkUrl` to link their GitHub account. */
  postLinkPrompt(userId: string, target: ChatTarget, incidentId: string, card: PrReadyCard, linkUrl: string): Promise<void>;
}

// Dependencies -----------------------------------------------------------------------------------

/** What reviewer resolution reads from the workspace map. */
export type HumanMap = Pick<WorkspaceMap, 'people' | 'channels'>;

/** The loaded map, or a getter that returns the current one. */
export type HumanMapSource = HumanMap | (() => Promise<HumanMap>);

/** Shared by `requestHumanReview` and the PR actions (actions.ts). */
export interface HumanDeps {
  /** The install's workspace (single tenant), stamped on every event. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  /** The chat platform of the map people's ids and of the linked identities. */
  chat: ChatPlatform;
  /** A client for one `owner/name` repository. */
  github: (repo: string) => HumanGitHub;
  codeowners: (repo: string) => CodeownersLookup;
  identity: IdentityLinks;
  map: HumanMapSource;
  clock: () => Date;
}

export interface HumanReviewDeps extends HumanDeps {
  chatOut: PrReadyChat;
  /** Records which cards were posted, so a retry posts nothing twice. */
  cache: CachePort;
  /** A private link prompt that failed (logged; not retried). */
  onError?: (error: unknown) => void;
}

// Reviewer resolution ----------------------------------------------------------------------------

/** A map person among the reviewers. */
export interface ReviewerPerson {
  handle: string;
  /** Their user id on `HumanDeps.chat`, when the map has one. */
  chatUserId?: string;
  /** Their linked identity's login, else their map handle. */
  login: string;
  /** True when they have a usable linked identity. */
  linked: boolean;
}

export interface ResolvedReviewers {
  /** `codeowners` when a rule named an owner for a touched path, else `map` (the surface's owners). */
  source: 'codeowners' | 'map';
  /** GitHub logins to request, without `@`, deduplicated case-insensitively, the PR author left out. */
  users: string[];
  /** Team slugs to request (the part after `@org/`). */
  teams: string[];
  /** The map people among `users`, in `users` order. */
  people: ReviewerPerson[];
}

export interface ResolveReviewersInput {
  repo: string;
  /** The PR's touched paths. */
  paths: readonly string[];
  surfaceId?: string;
  componentId?: string;
  /** GitHub refuses a review request to the PR's author. */
  authorLogin?: string | null;
}

/** main 11.2 step 1: `CODEOWNERS` for the touched paths, falling back to the map's `people/owns`. */
export async function resolveReviewers(deps: Pick<HumanDeps, 'chat' | 'codeowners' | 'identity' | 'map'>, input: ResolveReviewersInput): Promise<ResolvedReviewers> {
  const map = await loadMap(deps.map);
  const people = await Promise.all(map.people.map((p) => personRef(deps, p)));
  const { owners } = input.paths.length === 0 ? { owners: [] } : await deps.codeowners(input.repo).codeownersFor(input.paths);

  const users: string[] = [];
  const teams: string[] = [];
  for (const raw of owners) {
    const owner = raw.trim();
    if (owner.startsWith('@')) {
      const name = owner.slice(1);
      const slash = name.indexOf('/');
      if (slash === -1) users.push(name);
      else if (slash < name.length - 1) teams.push(name.slice(slash + 1));
    } else if (owner.includes('@')) {
      // An email owner: request the map person with that email, when the map knows them.
      const at = map.people.findIndex((p) => p.email !== undefined && p.email.toLowerCase() === owner.toLowerCase());
      const ref = at === -1 ? undefined : people[at];
      if (ref !== undefined) users.push(ref.login);
    }
  }

  let source: ResolvedReviewers['source'] = 'codeowners';
  if (users.length === 0 && teams.length === 0) {
    source = 'map';
    const surfaceId = input.surfaceId;
    if (surfaceId !== undefined) {
      const owning = map.people.flatMap((p, i) => {
        const ref = people[i];
        return ref !== undefined && p.owns.some((o) => o.surface === surfaceId) ? [{ person: p, ref }] : [];
      });
      // The component's owners when it has any, else everyone who owns the surface.
      const component = input.componentId;
      const forComponent = component === undefined ? [] : owning.filter(({ person }) => person.owns.some((o) => o.surface === surfaceId && o.component === component));
      for (const { ref } of forComponent.length > 0 ? forComponent : owning) users.push(ref.login);
    }
  }

  const author = input.authorLogin?.toLowerCase();
  const seen = new Set<string>();
  const outUsers = users.filter((u) => {
    const key = u.toLowerCase();
    if (u === '' || key === author || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const outTeams = [...new Set(teams)];
  const reviewerPeople = outUsers.flatMap((login) => people.filter((p) => sameLogin(p.login, login)));
  return { source, users: outUsers, teams: outTeams, people: reviewerPeople };
}

async function personRef(deps: Pick<HumanDeps, 'chat' | 'identity'>, person: MapPerson): Promise<ReviewerPerson> {
  const chatUserId = deps.chat === 'slack' ? person.slackId : person.teamsId;
  const handle = person.handle.replace(/^@/, '');
  if (chatUserId === undefined || chatUserId === '') return { handle, login: handle, linked: false };
  const user = { chat: deps.chat, userId: chatUserId };
  const [identity, linked] = await Promise.all([deps.identity.getLinkedIdentity(user), deps.identity.isLinked(user)]);
  return { handle, chatUserId, login: identity?.githubLogin ?? handle, linked: identity !== null && linked };
}

/** GitHub logins compare case-insensitively. */
export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// When a PR is ready for a human -----------------------------------------------------------------

export type HumanReviewSkip = 'no-pr' | 'stopped' | 'merged' | 'not-reviewed' | 'review-failed' | 'level' | 'no-repo' | 'not-open';

export type HumanReviewTrigger =
  | { ready: true; prNumber: number; on: 'review-passed' | 'held'; seq: number }
  | { ready: false; reason: HumanReviewSkip };

/**
 * Whether the open PR waits for a human: a `review-passed` for it (since the latest fixer run) at level
 * 1 or 2, or a gate `held` since it opened and since the latest fixer run (a level 3 merge that
 * degraded). `seq` is the trigger event's.
 */
export function humanReviewTrigger(log: readonly IncidentEvent[]): HumanReviewTrigger {
  const opened = latest(log, 'pr-opened');
  if (opened === undefined) return { ready: false, reason: 'no-pr' };
  const prNumber = opened.payload.prNumber;
  if (stoppedSinceFiled(log)) return { ready: false, reason: 'stopped' };
  if (log.some((e) => e.seq > opened.seq && e.type === 'merged' && e.payload.prNumber === prNumber)) return { ready: false, reason: 'merged' };
  const since = lastSeqOf(log, 'fixer-started');
  // A hold before a later fixer run (a human asked for changes) is superseded by that run's review.
  const held = latest(log, 'held');
  if (held !== undefined && held.payload.kind === 'gate' && held.seq > Math.max(opened.seq, since)) return { ready: true, prNumber, on: 'held', seq: held.seq };
  let review: IncidentEvent | undefined;
  for (const e of log) {
    if (e.seq > since && (e.type === 'review-passed' || e.type === 'review-failed') && e.payload.prNumber === prNumber) review = e;
  }
  if (review === undefined) return { ready: false, reason: 'not-reviewed' };
  if (review.type !== 'review-passed') return { ready: false, reason: 'review-failed' };
  const level = currentLevel(log);
  if (level !== 1 && level !== 2) return { ready: false, reason: 'level' };
  return { ready: true, prNumber, on: 'review-passed', seq: review.seq };
}

export type HumanReviewOutcome =
  | { requested: false; reason: HumanReviewSkip }
  | {
      requested: true;
      prNumber: number;
      reviewers: ResolvedReviewers;
      /** Logins and teams GitHub refused (not collaborators), when any. */
      refused: string[];
      card: PrReadyCard;
      canMerge: boolean;
      /** Channels the card was posted to by this call. */
      posted: string[];
      /** Chat users sent the link prompt by this call. */
      linkPrompts: string[];
    };

/** main 11.2 steps 1 to 3: request review, post the card, prompt unlinked reviewers to link. */
export async function requestHumanReview(deps: HumanReviewDeps, incidentId: string): Promise<HumanReviewOutcome> {
  const log = await deps.state.read(incidentId);
  const trigger = humanReviewTrigger(log);
  if (!trigger.ready) return { requested: false, reason: trigger.reason };
  const { prNumber } = trigger;
  const incident = await deps.state.getIncident(incidentId);
  const mapRepo = incident?.repo;
  if (mapRepo === undefined || mapRepo === '') return { requested: false, reason: 'no-repo' };
  const repo = repoFullName(mapRepo);

  const gh = deps.github(repo);
  const pr = await gh.getPullRequest(prNumber);
  if (pr.state !== 'open' || pr.merged) return { requested: false, reason: 'not-open' };
  const [files, status, verdict, map] = await Promise.all([
    gh.listPullRequestFiles(prNumber),
    gh.combinedStatus(pr.headSha, pr.baseRef),
    reviewVerdict(deps.state, log, prNumber),
    loadMap(deps.map),
  ]);
  const reviewers = await resolveReviewers(deps, {
    repo,
    paths: files.map((f) => f.filename),
    ...(incident?.surfaceId === undefined ? {} : { surfaceId: incident.surfaceId }),
    ...(incident?.componentId === undefined ? {} : { componentId: incident.componentId }),
    authorLogin: pr.authorLogin,
  });

  const refused = await requestOnGitHub(gh, prNumber, pr.requestedReviewers, reviewers);

  const card: PrReadyCard = {
    kind: 'pr-ready',
    prNumber,
    prUrl: pr.htmlUrl,
    issueKey: incident?.jiraKey ?? latest(log, 'filed')?.payload.jiraKey ?? '',
    reviewVerdict: verdict ?? 'escalate',
    ciState: ciState(status),
    filesChanged: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    reviewerUserIds: unique(reviewers.people.flatMap((p) => (p.chatUserId === undefined ? [] : [p.chatUserId]))),
  };
  const canMerge = reviewers.people.some((p) => p.linked && p.chatUserId !== undefined);

  const targets: ChatTarget[] = [];
  const thread = threadTarget(log, incident?.channelId, incident?.anchorId);
  if (thread !== undefined) targets.push(thread);
  const bug = incident?.surfaceId === undefined ? undefined : map.channels.find((c) => c.surface === incident.surfaceId);
  if (bug !== undefined && bug.id !== thread?.channel) targets.push({ channel: bug.id });

  const posted: string[] = [];
  for (const target of targets) {
    const key = postedKey(incidentId, trigger.seq, `card:${target.channel}`);
    if ((await deps.cache.get(key)) !== null) continue;
    await deps.chatOut.postPrReady(target, incidentId, card, { canMerge });
    await deps.cache.set(key, deps.clock().toISOString(), HUMAN_REVIEW_POSTED_TTL_SEC);
    posted.push(target.channel);
  }

  const linkPrompts: string[] = [];
  const promptTarget = targets[0];
  if (promptTarget !== undefined) {
    for (const person of reviewers.people) {
      const userId = person.chatUserId;
      if (person.linked || userId === undefined || linkPrompts.includes(userId)) continue;
      const key = postedKey(incidentId, trigger.seq, `link:${userId}`);
      if ((await deps.cache.get(key)) !== null) continue;
      try {
        const url = await deps.identity.linkUrl({ chat: deps.chat, userId });
        await deps.chatOut.postLinkPrompt(userId, promptTarget, incidentId, card, url);
        linkPrompts.push(userId);
      } catch (e) {
        deps.onError?.(e);
      }
      // Recorded either way: a prompt that failed once (the user is not in the channel) is not retried.
      await deps.cache.set(key, deps.clock().toISOString(), HUMAN_REVIEW_POSTED_TTL_SEC);
    }
  }

  return { requested: true, prNumber, reviewers, refused, card, canMerge, posted, linkPrompts };
}

/** Requests review from whoever is not requested yet; on a 422 retries one at a time. Returns the refused. */
async function requestOnGitHub(gh: HumanGitHub, prNumber: number, already: readonly string[], reviewers: ResolvedReviewers): Promise<string[]> {
  const users = reviewers.users.filter((u) => !already.some((a) => sameLogin(a, u)));
  const teams = reviewers.teams;
  if (users.length === 0 && teams.length === 0) return [];
  try {
    await gh.requestReviewers(prNumber, { ...(users.length === 0 ? {} : { users }), ...(teams.length === 0 ? {} : { teams }) });
    return [];
  } catch (e) {
    if (httpStatus(e) !== 422) throw e;
  }
  const refused: string[] = [];
  const one = async (label: string, reviewer: { users?: readonly string[]; teams?: readonly string[] }): Promise<void> => {
    try {
      await gh.requestReviewers(prNumber, reviewer);
    } catch (e) {
      if (httpStatus(e) !== 422) throw e;
      refused.push(label);
    }
  };
  for (const u of users) await one(u, { users: [u] });
  for (const t of teams) await one(`team:${t}`, { teams: [t] });
  return refused;
}

/** The card's CI state: the required checks, or everything reported when the base requires none. */
export function ciState(status: HumanCombinedStatus): PrReadyCard['ciState'] {
  const states = status.required.length > 0 ? status.required.map((c) => (c.source === null ? 'pending' : c.state)) : (status.all ?? []).map((c) => c.state);
  if (states.some((s) => s === 'failure')) return 'red';
  if (states.length > 0 && states.every((s) => s === 'success')) return 'green';
  return 'pending';
}

/** The originating thread: the captured thread, else the anchor message (as the status message does). */
function threadTarget(log: readonly IncidentEvent[], channelId: string | undefined, anchorId: string | undefined): ChatTarget | undefined {
  if (channelId === undefined || channelId === '') return undefined;
  const captured = latest(log, 'captured');
  const threadId = captured?.payload.threadId ?? anchorId;
  return threadId === undefined || threadId === '' ? { channel: channelId } : { channel: channelId, threadId };
}

function postedKey(incidentId: string, seq: number, what: string): string {
  return `human-review:${keySegment(incidentId)}:${String(seq)}:${keySegment(what)}`;
}

export async function loadMap(source: HumanMapSource): Promise<HumanMap> {
  return typeof source === 'function' ? source() : source;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
