// Which lifecycle events change the pinned status message (main 12), and to what. Pure: a function
// of the event and the incident row after it folded (and, when the caller has it, the row before),
// so the outbox module (`state/projections/outbox/status.ts`) can call it inside the append
// transaction and a test can replay a recorded log through it.
//
// The rows of main 12, by event:
//
// - `filed`: "Filed as KEY, assigned to @owner." at levels 0 and 1; "Filed as KEY. Working on a fix
//   now." with Stop at levels 2 and 3. With an engineer's claim holding the fixer (A 2.1) at any
//   level: "Filed as KEY. @claimer is on it, so this is filed as ticket only." and no Stop.
// - `fixer-started`, when it moves the incident to `fixing` and the message does not already say so:
//   at level 1 after Fix it, or after a stop, an escalation, or a released claim. At levels 2 and 3
//   straight after `filed` the message already says it, so nothing changes.
// - `pr-opened` into `in-review`: "A fix is up. Review requested from @owner." The retry's PR
//   (`in-review-retry`) changes nothing: the message still says a fix is up.
// - `review-passed`: "Review passed, waiting on merge."
// - `merged`: "Merged by X. Rolling out to staging." by a human, or "Merged automatically" with
//   Revert when autopilot merged (level 3 at merge time).
// - `held` at a gate: "Held for human review: <reason>. @owner requested." An environment hold changes
//   nothing. A hold for the workspace instructions (A 6.4) reads "Holding for the release window per
//   workspace instructions. @owner requested."
// - `level-changed` that records the workspace instructions holding the fixer start (A 6.4,
//   merge/instructions.ts): "Filed as KEY. Holding for <reason> per workspace instructions. Over to
//   @named." with the person the instruction names, else the owner, and no Stop.
// - `stopped`: "Stopped by X. Ticket back in Backlog."
// - `fixer-failed`: "Couldn't produce a passing fix." with the draft line when the fixer pushed a
//   partial branch.
// - `deployed:staging`: "Fix is on staging. @reporter, can you check?"
// - `deployed:production`: "Live. Closing KEY."
// - `clarify-answered` after filing: "Thanks, that answered it. Moving ahead." (before filing there is
//   no status message; the clarify card is the conversation.)
// - `reverted`: "Reverted. KEY is open again."
//
// Every other event, and an event that did not fit the status it arrived in (the status was kept),
// changes nothing. There is no message before the incident has its own Jira key, and none for an
// incident linked to someone else's issue (the dedupe card said where it went).
//
// The owner is the Jira assignee the incidents row knows (`assigneeId`), else the resolved owner
// (`ownerRef`, main 4.4: the map handle the latest `resolved` named), else nobody is named. The
// assignee comes first because only a human sets it: `jira-assignee-changed` is appended by the
// Jira inbound sync for a human's edit and never for the agent's own write (B 7.3, the human wins),
// so the projection holds no engine-set assignee to rank below the resolved owner.
// The person who merged or stopped is mentioned when the event came from a chat platform (their id
// is a chat user id) and named otherwise (a GitHub login); an event without an actor names nobody.

import type { IncidentEvent } from '../contracts/events.ts';
import type { StatusUpdate } from '../contracts/adapters.ts';
import type { IncidentStatus, IncidentView } from '../contracts/state.ts';
import { parseFixerHoldReason } from '../merge/instructions.ts';
import { makeStatusUpdate, type StatusCopyContext } from './copy.ts';

/** The lowest autonomy level at which filing starts the fixer at once (main 12: Stop on filed at 2 and 3). */
const FIX_NOW_LEVEL = 2;

/** True when the row has a Jira key of its own, so a status message exists or is about to. */
function hasOwnIssue(incident: IncidentView | undefined): incident is IncidentView & { jiraKey: string } {
  return incident?.jiraKey !== undefined && incident.status !== 'linked-to-existing';
}

/**
 * The status message `event` sets, or undefined when it does not change the message. `before` is the
 * incident row before the event folded; without it, an event that names a status counts as moving
 * there (a replay that only keeps the latest row may then repeat an update, which edits the message
 * to the same text). `holdClaimerId` is the engineer whose claim holds the fixer when `filed` arrives (A 2.1):
 * filing is then ticket only, so the first post says so, with no Stop.
 */
export function statusFor(event: IncidentEvent, incident: IncidentView, before?: IncidentView, holdClaimerId?: string): StatusUpdate | undefined {
  if (!hasOwnIssue(incident)) return undefined;
  const issueKey = incident.jiraKey;
  const ownerRef = incident.assigneeId ?? incident.ownerRef;
  const owner = ownerRef === undefined ? {} : { ownerUserId: ownerRef };
  const moved = (...to: IncidentStatus[]): boolean => to.includes(incident.status) && (before === undefined || before.status !== incident.status);
  const level = incident.autonomyLevel ?? 0;
  const ctx = (extra: Omit<StatusCopyContext, 'issueKey'> = {}): StatusCopyContext => ({ issueKey, ...extra });

  switch (event.type) {
    case 'filed':
      if (!moved('filed')) return undefined;
      if (holdClaimerId !== undefined) {
        return makeStatusUpdate('filed', ctx({ ...(level >= FIX_NOW_LEVEL ? {} : owner), claimerUserId: holdClaimerId }));
      }
      return level >= FIX_NOW_LEVEL ? makeStatusUpdate('fixing', ctx()) : makeStatusUpdate('filed', ctx(owner));
    case 'fixer-started':
      if (!moved('fixing')) return undefined;
      if (before?.status === 'filed' && level >= FIX_NOW_LEVEL) return undefined;
      return makeStatusUpdate('fixing', ctx());
    case 'pr-opened':
      return moved('in-review') ? makeStatusUpdate('pr-open', ctx(owner)) : undefined;
    case 'review-passed':
      return moved('ci', 'ci-retry') ? makeStatusUpdate('review-passed', ctx()) : undefined;
    case 'merged':
      if (!moved('merged')) return undefined;
      return event.payload.levelAtMergeTime === 3 ? makeStatusUpdate('merged', ctx({ automatic: true })) : makeStatusUpdate('merged', ctx(actorOf(event)));
    case 'held':
      if (event.payload.kind !== 'gate' || !moved('held')) return undefined;
      return makeStatusUpdate('held', ctx({ ...owner, reason: event.payload.reason }));
    case 'level-changed': {
      const held = parseFixerHoldReason(event.payload.reason);
      if (held === undefined) return undefined;
      return makeStatusUpdate('filed', ctx({ ...(held.mention === undefined ? owner : { ownerUserId: held.mention }), instructionsHold: held.status }));
    }
    case 'stopped':
      return moved('stopped') ? makeStatusUpdate('stopped', ctx(actorOf(event))) : undefined;
    case 'fixer-failed':
      if (!moved('escalated')) return undefined;
      return makeStatusUpdate('failed', ctx({ ...owner, draft: event.payload.partialBranch !== undefined }));
    case 'deployed:staging':
      if (!moved('deployed:staging')) return undefined;
      return makeStatusUpdate('staging', ctx(incident.reporterId === undefined ? {} : { reporterUserId: incident.reporterId }));
    case 'deployed:production':
      return moved('deployed:production') ? makeStatusUpdate('production', ctx()) : undefined;
    case 'clarify-answered':
      // Only once a message exists: `before` filed under the same key.
      return before === undefined || hasOwnIssue(before) ? makeStatusUpdate('clarified', ctx()) : undefined;
    case 'reverted':
      return moved('reverted') ? makeStatusUpdate('reverted', ctx()) : undefined;
    default:
      return undefined;
  }
}

/** Who merged or stopped: mentioned when the event came from chat, named otherwise. */
function actorOf(event: IncidentEvent): Pick<StatusCopyContext, 'actorUserId' | 'actorName'> {
  if (event.actor === undefined) return {};
  return event.source === 'slack' || event.source === 'teams' ? { actorUserId: event.actor.id } : { actorName: event.actor.id };
}
