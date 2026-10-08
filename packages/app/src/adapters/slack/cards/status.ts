// The pinned status message in Block Kit (main 12, 20.1). The copy, the emoji vocabulary, and the
// reporter rules are platform-neutral and live in the pipeline (`status/copy.ts`) so Teams and
// the CLI say the same thing; they are re-exported here for existing callers. This file only renders:
// it escapes the plain parts of the neutral text for mrkdwn and turns each mention token into a Slack
// mention.

import type { StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import { emojiFor, mentionToken, statusTextParts } from '@snapwing/pipeline/status/copy.ts';
import { actions, esc, mention, section, type SlackBlock, type SlackMessage } from './blocks.ts';

export {
  EMOJI_VOCABULARY,
  emojiFor,
  makeStatusUpdate,
  reporterViolations,
  STATUS_EMOJI,
  statusCopy,
  type StatusCopyContext,
} from '@snapwing/pipeline/status/copy.ts';

/**
 * Maps a mention ref (a chat user id or a map handle) to a Slack user id; undefined renders the ref
 * as plain `@ref` text. The default treats every ref as a Slack user id.
 */
export type SlackUserFor = (ref: string) => string | undefined;

/** The neutral status text as mrkdwn: plain parts escaped, mention tokens as Slack mentions. */
export function statusMrkdwn(text: string, userFor: SlackUserFor = (ref) => ref): string {
  return statusTextParts(text)
    .map((p) => {
      if (p.kind === 'text') return esc(p.text);
      const user = userFor(p.ref);
      return user === undefined ? esc(`@${p.ref}`) : mention(user);
    })
    .join('');
}

/** The pinned status message: one section (emoji plus text), plus buttons when the update carries actions. */
export function buildStatusMessage(incidentId: string, status: StatusUpdate, userFor?: SlackUserFor): SlackMessage {
  const emoji = emojiFor(status.stage);
  let neutral = status.text;
  if (status.mentionUserId !== undefined && !neutral.includes(mentionToken(status.mentionUserId))) {
    neutral = `${neutral} ${mentionToken(status.mentionUserId)}`;
  }
  const text = statusMrkdwn(neutral, userFor);
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
