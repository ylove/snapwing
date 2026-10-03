// The Slack side of `requestHumanReview` (main 11.2, main 20.2): a `PrReadyChat` that posts the
// `pr-ready` card, and the private link prompt for a reviewer who has not linked their GitHub account.
// Both post in the originating thread, except in a direct message, where threads do not apply (as the
// status projector does).
//
// With `state`, each posted card is recorded as `bot-message-posted { role: 'pr' }` (A 1.3, #287),
// best effort: the card is out, so a failure goes to `onError`. The ephemeral prompt is not recorded.

import type { PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { ChatTarget, PrReadyChat } from '@snapwing/pipeline/merge/human.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import { esc, section } from './cards/blocks.ts';
import { buildPrReady } from './cards/cards.ts';
import { isDirectMessageChannel } from './status-projector.ts';
import type { SlackWeb } from './web.ts';

export interface SlackPrReadyChatOptions {
  web: Pick<SlackWeb, 'postMessage' | 'postEphemeral'>;
  /** Records each posted card as `bot-message-posted` (A 1.3). Absent: nothing is recorded. */
  state?: Pick<StatePort, 'read' | 'append'>;
  /** A record that failed. Default: ignored. */
  onError?: (error: unknown) => void;
}

/** The thread to post in: the target's, none in a direct message. */
function threadOf(target: ChatTarget): { thread_ts?: string } {
  return target.threadId === undefined || target.threadId === '' || isDirectMessageChannel(target.channel) ? {} : { thread_ts: target.threadId };
}

export function createSlackPrReadyChat(options: SlackPrReadyChatOptions): PrReadyChat {
  const { web } = options;
  return {
    async postPrReady(target, incidentId: string, card: PrReadyCard, opts) {
      const message = buildPrReady(incidentId, card, { canMerge: opts.canMerge });
      const posted = await web.postMessage({ channel: target.channel, text: message.text, blocks: message.blocks, ...threadOf(target) });
      if (options.state !== undefined) {
        const ref = { platform: 'slack', channel: posted.channel, messageId: posted.ts, role: 'pr' } as const;
        await recordBotMessage(options.state, incidentId, ref).catch(options.onError ?? (() => undefined));
      }
    },
    async postLinkPrompt(userId, target, incidentId, card, linkUrl) {
      const message = buildPrReady(incidentId, card, { canMerge: false });
      const prompt = section(`<${esc(linkUrl)}|Link your GitHub account> to merge from here.`);
      await web.postEphemeral({
        channel: target.channel,
        user: userId,
        text: message.text,
        blocks: [...message.blocks, prompt],
        ...threadOf(target),
      });
    },
  };
}
