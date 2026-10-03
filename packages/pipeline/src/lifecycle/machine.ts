// Lifecycle state machine as a pure reducer. Companion B 5.
//
// `incidents.status` is derived from the last state-changing event. The projector (#18) calls
// `nextStatus` for every event and logs when `isValidTransition` says the event did not fit.
//
// Data-driven: one transition table, no switch forest. Neither function throws or touches the clock,
// the database, or the event payload except to tell a gate hold from an environment hold.
//
// Choices where the B 5 diagram is loose (each is a row in `TRANSITIONS`, so changing one is a one-line edit):
// - "retry once" cannot be known from `(status, event)` alone, so the retry budget lives in the status:
//   the first `review-failed` or `ci-red` goes to `fixing`; the fixer's PR then runs through
//   `in-review-retry` and `ci-retry`, where a second failure goes to `escalated`.
//   The retry budget is shared by review and CI: one retry in total.
// - `claimed` moves to `human-fixing` when the claimer's Jira ticket moves (`jira-transitioned`);
//   `released` and `let-agent-take` hand a claim or human fix back to the agent (`fixing`).
// - `fixer-failed` escalates: the fixer budget or the fixer itself gave up.
// - `clarified` is the optional ask-back; it leaves the status where it is. An answer that names the
//   surface or component appends a second `resolved`, which `deduped` accepts and keeps (ADR 0015).
// - `stopped` behaves as `filed` (B 5: it "returns to filed"): same accepted events, same targets,
//   so a fixer start after a stop shows `fixing`, and a human PR shows `in-review`.
// - `fixer-done` and a repeated `fixer-started` are rows of `fixing` and `fixing-retry`, not
//   `NON_STATE_CHANGING`: they only mean something while a fixer can be running, so anywhere else they are
//   reported as not fitting. Both keep the status (the following `pr-opened` moves it). A second
//   `fixer-started` is the retry run after `review-failed` or `ci-red` (`fixing-retry`) or a restart after a
//   crash (`fixing`).
// - `escalated` is left by the next human or agent action (claim, fixer start, human PR, close).
// - `review-failed` after the review passed (`ci`, `mergeable`, `held`) is a human's Request changes
//   on the PR card (main 11.2, merge/actions.ts): it sends the PR back like a first review failure,
//   and from `ci-retry` it escalates like a second one (a fixer start then leaves `escalated`).

import type { EventType, IncidentEvent } from '../contracts/events.ts';

/** Every state in the B 5 diagram, plus the three retry states described above. */
export type LifecycleStatus =
  | 'captured'
  | 'assembling'
  | 'resolved'
  | 'deduped'
  | 'planned'
  | 'filed'
  | 'claimed'
  | 'human-fixing'
  | 'fixing'
  | 'fixing-retry'
  | 'in-review'
  | 'in-review-retry'
  | 'ci'
  | 'ci-retry'
  | 'mergeable'
  | 'held'
  | 'merged'
  | 'deployed:staging'
  | 'deployed:production'
  | 'reverted'
  | 'stopped'
  | 'escalated'
  | 'closed'
  | 'not-filed'
  | 'not-a-bug'
  | 'linked-to-existing';

export const LIFECYCLE_STATUSES = Object.freeze([
  'captured',
  'assembling',
  'resolved',
  'deduped',
  'planned',
  'filed',
  'claimed',
  'human-fixing',
  'fixing',
  'fixing-retry',
  'in-review',
  'in-review-retry',
  'ci',
  'ci-retry',
  'mergeable',
  'held',
  'merged',
  'deployed:staging',
  'deployed:production',
  'reverted',
  'stopped',
  'escalated',
  'closed',
  'not-filed',
  'not-a-bug',
  'linked-to-existing',
] as const satisfies readonly LifecycleStatus[]);

// Compile-time: LIFECYCLE_STATUSES lists every member of LifecycleStatus.
type MissingStatuses = Exclude<LifecycleStatus, (typeof LIFECYCLE_STATUSES)[number]>;
const statusesComplete: [MissingStatuses] extends [never] ? true : MissingStatuses = true;
void statusesComplete;

/** The status of a new incident, set by its `captured` event. */
export const INITIAL_STATUS: LifecycleStatus = 'captured';

/** B 5: no event moves an incident out of these. */
export const TERMINAL_STATUSES: readonly LifecycleStatus[] = Object.freeze([
  'closed',
  'not-filed',
  'not-a-bug',
  'linked-to-existing',
] as const);

const TERMINAL_SET: ReadonlySet<LifecycleStatus> = new Set(TERMINAL_STATUSES);

export function isTerminalStatus(status: LifecycleStatus): boolean {
  return TERMINAL_SET.has(status);
}

type Target = LifecycleStatus | ((event: IncidentEvent) => LifecycleStatus);
type Row = Partial<Record<EventType, Target>>;

/** A gate hold parks a mergeable PR; an environment hold only touches the `claims` projection. */
const heldTarget: Target = (event) =>
  event.type === 'held' && event.payload.kind === 'gate' ? 'held' : 'mergeable';

/** Rows of the table, keyed by the status the incident is in. */
const TRANSITIONS: Readonly<Record<LifecycleStatus, Row>> = {
  captured: {
    'context-assembled': 'assembling',
    'resolution-signal': 'not-filed',
    'not-a-bug': 'not-a-bug',
  },
  assembling: {
    resolved: 'resolved',
    'resolution-signal': 'not-filed',
    'not-a-bug': 'not-a-bug',
  },
  resolved: {
    'dedupe-checked': 'deduped',
    'not-a-bug': 'not-a-bug',
  },
  deduped: {
    // A clarify answer that names the surface or component re-resolves (ADR 0015).
    resolved: 'deduped',
    planned: 'planned',
    'linked-to-existing': 'linked-to-existing',
    'not-a-bug': 'not-a-bug',
  },
  planned: {
    filed: 'filed',
    'not-a-bug': 'not-a-bug',
  },
  filed: {
    claimed: 'claimed',
    'fixer-started': 'fixing',
    'pr-opened': 'in-review',
    'not-a-bug': 'not-a-bug',
    closed: 'closed',
  },
  claimed: {
    'jira-transitioned': 'human-fixing',
    released: 'fixing',
    'let-agent-take': 'fixing',
    'pr-opened': 'in-review',
    // A 2.1: the claim card's Not a bug.
    'not-a-bug': 'not-a-bug',
    closed: 'closed',
  },
  'human-fixing': {
    'pr-opened': 'in-review',
    released: 'fixing',
    'let-agent-take': 'fixing',
    closed: 'closed',
  },
  fixing: {
    'fixer-started': 'fixing',
    'fixer-done': 'fixing',
    'pr-opened': 'in-review',
    'fixer-failed': 'escalated',
    closed: 'closed',
  },
  'fixing-retry': {
    'fixer-started': 'fixing-retry',
    'fixer-done': 'fixing-retry',
    'pr-opened': 'in-review-retry',
    'fixer-failed': 'escalated',
    closed: 'closed',
  },
  'in-review': {
    'review-passed': 'ci',
    'review-failed': 'fixing-retry',
    closed: 'closed',
  },
  'in-review-retry': {
    'review-passed': 'ci-retry',
    'review-failed': 'escalated',
    closed: 'closed',
  },
  ci: {
    'ci-green': 'mergeable',
    'ci-red': 'fixing-retry',
    'review-failed': 'fixing-retry',
    closed: 'closed',
  },
  'ci-retry': {
    'ci-green': 'mergeable',
    'ci-red': 'escalated',
    'review-failed': 'escalated',
    closed: 'closed',
  },
  mergeable: {
    merged: 'merged',
    held: heldTarget,
    'review-failed': 'fixing-retry',
    closed: 'closed',
  },
  held: {
    released: 'mergeable',
    merged: 'merged',
    'review-failed': 'fixing-retry',
    closed: 'closed',
  },
  merged: {
    'deployed:staging': 'deployed:staging',
    reverted: 'reverted',
    closed: 'closed',
  },
  'deployed:staging': {
    verified: 'deployed:staging',
    'deployed:production': 'deployed:production',
    reverted: 'reverted',
    closed: 'closed',
  },
  'deployed:production': {
    reverted: 'reverted',
    closed: 'closed',
  },
  reverted: {
    closed: 'closed',
  },
  // B 5: "stopped is not terminal; it returns to filed": it accepts what `filed` accepts and lands
  // where `filed` would, plus an explicit refile.
  stopped: {
    filed: 'filed',
    claimed: 'claimed',
    'fixer-started': 'fixing',
    'pr-opened': 'in-review',
    'not-a-bug': 'not-a-bug',
    closed: 'closed',
  },
  escalated: {
    claimed: 'claimed',
    'fixer-started': 'fixing',
    'pr-opened': 'in-review',
    closed: 'closed',
  },
  closed: {},
  'not-filed': {},
  'not-a-bug': {},
  'linked-to-existing': {},
};

/** B 5 "at any state": legal in every non-terminal status; `stopped` and `escalated` set the status. */
const FROM_ANY_ACTIVE: Row = {
  stopped: 'stopped',
  escalated: 'escalated',
};

/**
 * Events that never change the status and are valid in every status, terminal included: comments and
 * signals, level changes, corrections, Jira field edits, fixer progress reports, and environment holds
 * (`held` with `kind: 'environment'` is handled by the `mergeable` row; elsewhere it is also a no-op).
 */
const NON_STATE_CHANGING: ReadonlySet<EventType> = new Set<EventType>([
  'comment',
  'level-changed',
  'corrected',
  'jira-priority-changed',
  'jira-assignee-changed',
  'jira-transitioned',
  'fixer-checkpoint',
  'fixer-artifact',
  'held',
  'clarified',
  'tapped',
  // A 4.3, A 4.5: status message, waiting-on, and monitoring bookkeeping (ADR 0014).
  'status-message-posted',
  'waiting-changed',
  'monitoring-started',
  'monitoring-stopped',
  // Decisions on cards (ADR 0015): what a person chose, never a correction.
  'scope-changed',
  'dedupe-decided',
  'clarify-answered',
]);

export interface TransitionResult {
  valid: boolean;
  next: LifecycleStatus;
}

function resolveTransition(current: LifecycleStatus, event: IncidentEvent): TransitionResult {
  // A new incident starts at INITIAL_STATUS; its `captured` event is a valid no-op there only.
  if (event.type === 'captured') {
    return { valid: current === INITIAL_STATUS, next: current };
  }
  const row = TRANSITIONS[current][event.type];
  if (row !== undefined) {
    return { valid: true, next: typeof row === 'function' ? row(event) : row };
  }
  if (NON_STATE_CHANGING.has(event.type)) {
    return { valid: true, next: current };
  }
  if (!isTerminalStatus(current)) {
    const any = FROM_ANY_ACTIVE[event.type];
    if (any !== undefined) {
      return { valid: true, next: typeof any === 'function' ? any(event) : any };
    }
  }
  return { valid: false, next: current };
}

/**
 * The status after `event`. Pure and total: an event that does not change the status, or does not fit
 * the current status, returns `current`. Use `isValidTransition` to tell the two apart.
 */
export function nextStatus(current: LifecycleStatus, event: IncidentEvent): LifecycleStatus {
  return resolveTransition(current, event).next;
}

/** False when `event` has no meaning in `current` (the caller logs it; the status stays put). */
export function isValidTransition(current: LifecycleStatus, event: IncidentEvent): boolean {
  return resolveTransition(current, event).valid;
}
