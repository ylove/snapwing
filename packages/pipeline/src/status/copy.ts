// Status message copy (main 12, 20.1), platform-neutral so Slack, Teams, and the CLI say the same
// thing. One pinned message edits in place. Reporter-facing text never carries a file path, a branch
// name, or the word "PR"; where main 12 shows "PR #418" the copy says "a fix" instead (20.1 wins over
// the table).
//
// The text is plain, with one markup: a mention token `<@ref>`, where `ref` is a chat user id or a
// map handle. Interpolated free text never contains `<` or `>`, so a token is the only angle bracket
// in the text. Each platform renders the text itself: `statusTextParts` splits it, the platform
// escapes the plain parts and turns each ref into its own mention (Slack `<@U..>`, a Teams `<at>`).
// Moved here from the Slack cards (#129, #142).

import type { StatusStage, StatusUpdate } from '../contracts/adapters.ts';

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

const STAGE_EMOJI: Readonly<Record<StatusStage, string>> = {
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

// Mentions --------------------------------------------------------------------------------------

const MENTION = /<@([^<>\s]+)>/g;

/** The neutral mention token for a chat user id or map handle. */
export function mentionToken(ref: string): string {
  return `<@${plain(ref).replace(/\s+/g, '')}>`;
}

/** One piece of a status text: plain text, or a mention of `ref`. */
export type StatusTextPart = { kind: 'text'; text: string } | { kind: 'mention'; ref: string };

/** `text` split into plain parts and mention tokens, in order; empty plain parts are dropped. */
export function statusTextParts(text: string): StatusTextPart[] {
  const parts: StatusTextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
    parts.push({ kind: 'mention', ref: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** Free text made safe to interpolate: no angle brackets, so it can never forge a mention token. */
function plain(text: string): string {
  return text.replace(/[<>]/g, '');
}

// Reporter rules (20.1) ---------------------------------------------------------------------------

/**
 * Problems that must not reach a reporter: a file path or file name, a branch name, the word "PR".
 * Tokens in angle brackets (`<@U1>`, Slack's `<https://...|label>`) are ignored. An empty list means
 * the text is safe.
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

// Copy --------------------------------------------------------------------------------------------

export interface StatusCopyContext {
  issueKey: string;
  /** Chat user id or map handle of the assignee or the requested reviewer. */
  ownerUserId?: string;
  /** Display name of the person who merged or stopped. */
  actorName?: string;
  /** Chat user id of the person who merged or stopped; mentioned instead of `actorName`. */
  actorUserId?: string;
  /** Chat user id of the reporter, asked to check on staging. */
  reporterUserId?: string;
  /** `merged`: the merge was autopilot. */
  automatic?: boolean;
  /** `held`: a plain-language reason. Anything with a path or "PR" is replaced by a generic one. */
  reason?: string;
  /** `failed`: whether a draft with what the fixer tried was kept. Default true. */
  draft?: boolean;
  /** Appended as a further sentence (the engine's notes on how an incident was filed). */
  note?: string;
}

function safeReason(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '' || reporterViolations(reason).length > 0) return 'a safety check';
  return plain(reason).trim().replace(/[.\s]+$/, '');
}

function body(stage: StatusStage, ctx: StatusCopyContext): string {
  const key = plain(ctx.issueKey);
  const owner = ctx.ownerUserId === undefined ? undefined : mentionToken(ctx.ownerUserId);
  const actor = ctx.actorUserId !== undefined ? mentionToken(ctx.actorUserId) : ctx.actorName !== undefined ? plain(ctx.actorName) : undefined;
  const by = actor === undefined ? '' : ` by ${actor}`;
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
      return ctx.automatic === true ? 'Merged automatically (review: approve, CI: green).' : `Merged${by}. Rolling out to staging.`;
    case 'held':
      return owner === undefined
        ? `Held for human review: ${safeReason(ctx.reason)}.`
        : `Held for human review: ${safeReason(ctx.reason)}. ${owner} requested.`;
    case 'stopped':
      return `Stopped${by}. Ticket back in Backlog.`;
    case 'failed': {
      const tried = ctx.draft === false ? "Couldn't produce a passing fix." : "Couldn't produce a passing fix. A draft with what it tried is saved.";
      return owner === undefined ? tried : `${tried} ${owner} pinged.`;
    }
    case 'staging':
      return ctx.reporterUserId === undefined ? 'Fix is on staging. Can you check?' : `Fix is on staging. ${mentionToken(ctx.reporterUserId)}, can you check?`;
    case 'production':
      return `Live. Closing ${key}.`;
    case 'clarified':
      return 'Thanks, that answered it. Moving ahead.';
    case 'reverted':
      return `Reverted. ${key} is open again.`;
  }
}

/** The text of one row of main 12, in the neutral form described in the file header. */
export function statusCopy(stage: StatusStage, ctx: StatusCopyContext): string {
  const text = body(stage, ctx);
  const note = ctx.note === undefined ? '' : plain(ctx.note).trim();
  return note === '' ? text : `${text} ${note}`;
}

/** A `StatusUpdate` for a stage: copy from `statusCopy`, buttons per main 12 (Stop while fixing, Revert after autopilot). */
export function makeStatusUpdate(stage: StatusStage, ctx: StatusCopyContext): StatusUpdate {
  const update: StatusUpdate = { issueKey: ctx.issueKey, stage, text: statusCopy(stage, ctx) };
  if (stage === 'fixing') update.actions = ['stop'];
  if (stage === 'merged' && ctx.automatic === true) update.actions = ['revert'];
  if (stage === 'staging' && ctx.reporterUserId !== undefined) update.mentionUserId = ctx.reporterUserId;
  return update;
}
