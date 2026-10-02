// Status message copy (main 12, 20.1). One pinned message edits in place. Reporter-facing text never
// carries a file path, a branch name, or the word "PR"; where main 12 shows "PR #418" the copy says
// "a fix" instead (20.1 wins over the table).

import type { StatusStage, StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import { actions, esc, mention, section, type SlackBlock, type SlackMessage } from './blocks.ts';

/** The fixed visual vocabulary (20.1): filed, fixing, in review, live, stopped, reverted. */
export const STATUS_EMOJI = {
  filed: '\u{1F41B}',
  fixing: '\u{1F527}',
  review: '\u{1F50D}',
  live: '✅',
  stopped: '⏸️',
  reverted: '↩️',
} as const;

export const EMOJI_VOCABULARY: readonly string[] = Object.values(STATUS_EMOJI);

const STAGE_EMOJI: Record<StatusStage, string> = {
  filed: STATUS_EMOJI.filed,
  clarified: STATUS_EMOJI.filed,
  fixing: STATUS_EMOJI.fixing,
  'pr-open': STATUS_EMOJI.review,
  'review-passed': STATUS_EMOJI.review,
  held: STATUS_EMOJI.review,
  merged: STATUS_EMOJI.live,
  staging: STATUS_EMOJI.live,
  production: STATUS_EMOJI.live,
  stopped: STATUS_EMOJI.stopped,
  failed: STATUS_EMOJI.stopped,
  reverted: STATUS_EMOJI.reverted,
};

export function emojiFor(stage: StatusStage): string {
  return STAGE_EMOJI[stage];
}

/**
 * Problems that must not reach a reporter: a file path or file name, a branch name, the word "PR".
 * Slack tokens (`<@U1>`, `<https://...|label>`) are ignored. An empty list means the text is safe.
 */
export function reporterViolations(text: string): string[] {
  const bare = text.replace(/<[^>]*>/g, ' ');
  const found: string[] = [];
  if (/\bPRs?\b/i.test(bare) || /\bpull requests?\b/i.test(bare)) found.push('pull request wording');
  if (/[\w.-]+\/[\w./-]*/.test(bare) || /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|rb|css|json|xml|ya?ml|md)\b/i.test(bare)) {
    found.push('file path or branch name');
  }
  return found;
}

export interface StatusCopyContext {
  issueKey: string;
  /** Chat user id of the assignee or the requested reviewer. */
  ownerUserId?: string;
  /** Display name of the person who merged or stopped. */
  actorName?: string;
  /** Chat user id of the reporter, asked to check on staging. */
  reporterUserId?: string;
  /** `merged`: the merge was autopilot. */
  automatic?: boolean;
  /** `held`: a plain-language reason. Anything with a path or "PR" is replaced by a generic one. */
  reason?: string;
}

function safeReason(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '' || reporterViolations(reason).length > 0) return 'a safety check';
  return reason.trim().replace(/[.\s]+$/, '');
}

/** The text of one row of main 12. Mrkdwn: names are escaped, user ids become mentions. */
export function statusCopy(stage: StatusStage, ctx: StatusCopyContext): string {
  const key = esc(ctx.issueKey);
  const owner = ctx.ownerUserId === undefined ? undefined : mention(ctx.ownerUserId);
  const actor = ctx.actorName === undefined ? 'someone' : esc(ctx.actorName);
  switch (stage) {
    case 'filed':
      return owner === undefined ? `Filed as ${key}.` : `Filed as ${key}, assigned to ${owner}.`;
    case 'fixing':
      return `Filed as ${key}. Working on a fix now.`;
    case 'pr-open':
      return owner === undefined ? 'A fix is up. Review requested.' : `A fix is up. Review requested from ${owner}.`;
    case 'review-passed':
      return 'Review passed, waiting on merge.';
    case 'merged':
      return ctx.automatic === true
        ? 'Merged automatically (review: approve, CI: green).'
        : `Merged by ${actor}. Rolling out to staging.`;
    case 'held':
      return owner === undefined
        ? `Held for human review: ${esc(safeReason(ctx.reason))}.`
        : `Held for human review: ${esc(safeReason(ctx.reason))}. ${owner} requested.`;
    case 'stopped':
      return `Stopped by ${actor}. Ticket back in Backlog.`;
    case 'failed':
      return owner === undefined
        ? "Couldn't produce a passing fix. A draft with what it tried is saved."
        : `Couldn't produce a passing fix. A draft with what it tried is saved. ${owner} pinged.`;
    case 'staging':
      return ctx.reporterUserId === undefined
        ? 'Fix is on staging. Can you check?'
        : `Fix is on staging. ${mention(ctx.reporterUserId)}, can you check?`;
    case 'production':
      return `Live. Closing ${key}.`;
    case 'clarified':
      return 'Thanks, that answered it. Moving ahead.';
    case 'reverted':
      return `Reverted. ${key} is open again.`;
  }
}

/** A `StatusUpdate` for a stage: copy from `statusCopy`, buttons per main 12 (Stop while fixing, Revert after autopilot). */
export function makeStatusUpdate(stage: StatusStage, ctx: StatusCopyContext): StatusUpdate {
  const update: StatusUpdate = { issueKey: ctx.issueKey, stage, text: statusCopy(stage, ctx) };
  if (stage === 'fixing') update.actions = ['stop'];
  if (stage === 'merged' && ctx.automatic === true) update.actions = ['revert'];
  if (stage === 'staging' && ctx.reporterUserId !== undefined) update.mentionUserId = ctx.reporterUserId;
  return update;
}

/** The pinned status message: one section (emoji plus text), plus buttons when the update carries actions. */
export function buildStatusMessage(incidentId: string, status: StatusUpdate): SlackMessage {
  const emoji = emojiFor(status.stage);
  let text = status.text;
  if (status.mentionUserId !== undefined && !text.includes(mention(status.mentionUserId))) {
    text = `${text} ${mention(status.mentionUserId)}`;
  }
  const blocks: SlackBlock[] = [section(`${emoji} ${text}`)];
  const wanted = status.actions ?? [];
  if (wanted.length > 0) {
    blocks.push(
      actions(
        'status_actions',
        wanted.map((a) =>
          a === 'stop'
            ? { label: 'Stop', actionId: 'stop', value: incidentId, style: 'danger' as const }
            : { label: 'Revert', actionId: 'revert', value: incidentId },
        ),
      ),
    );
  }
  return { text: `${emoji} ${text}`, blocks };
}
