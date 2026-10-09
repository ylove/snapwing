// The pinned status message as an Adaptive Card (main 12, 20.1). The copy, the emoji vocabulary, and the
// reporter rules are platform-neutral and live in the pipeline (`status/copy.ts`) so Slack, Teams, and the
// CLI say the same thing; they are re-exported here. This file only renders: plain parts escaped, each
// mention token an `<at>` with an entity keyed by the AAD object id.

import type { StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import { emojiFor, mentionToken } from '@snapwing/pipeline/status/copy.ts';
import { pinData } from '../../shared/pr-pin.ts';
import { actionSet, card, renderText, type AdaptiveCard, type MentionFor } from './elements.ts';

export {
  EMOJI_VOCABULARY,
  emojiFor,
  makeStatusUpdate,
  reporterViolations,
  STATUS_EMOJI,
  statusCopy,
  type StatusCopyContext,
} from '@snapwing/pipeline/status/copy.ts';

/** The pinned status message: one text block (emoji plus text), plus actions when the update carries them. */
export function buildStatusCard(
  incidentId: string,
  status: StatusUpdate,
  opts: { mentions?: MentionFor; reduced?: boolean } = {},
): AdaptiveCard {
  const emoji = emojiFor(status.stage);
  let neutral = status.text;
  if (status.mentionUserId !== undefined && !neutral.includes(mentionToken(status.mentionUserId))) {
    neutral = `${neutral} ${mentionToken(status.mentionUserId)}`;
  }
  const body = renderText(`${emoji} ${neutral}`, opts.mentions);
  const wanted = status.actions ?? [];
  const fallback = renderText(`${emoji} ${neutral}`, () => undefined).text.replace(/\\([\\*_`[\]])/g, '$1');
  return card(
    fallback,
    [body],
    wanted.length === 0
      ? []
      : actionSet(
          incidentId,
          // Revert carries the merge this message names, and acts on no later one (#264).
          wanted.map((a) => (a === 'stop' ? { title: 'Stop', verb: 'stop', style: 'destructive' as const } : { title: 'Revert', verb: 'revert', data: pinData(status.pin) })),
        ),
    opts,
  );
}
