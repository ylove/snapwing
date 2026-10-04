// The Teams side of `requestHumanReview` (main 11.2, main 20.2): a `PrReadyChat` that posts the `pr-ready`
// Adaptive Card, and the private link prompt for a reviewer who has not linked their GitHub account.
// Mirrors `adapters/slack/pr-ready.ts`.
//
// Teams has no ephemeral messages (main 15.2), so the link prompt goes to the reviewer's personal chat
// with the bot. It needs the app installed for that person; without it the prompt cannot be delivered
// there, and the thread gets a mention that says so. The link itself never goes in the thread: it starts
// the OAuth flow for that one person, and the thread is public.
//
// With `state`, each posted card is recorded as `bot-message-posted { role: 'pr' }` (A 1.3, #287), best
// effort: the card is out, so a failure goes to `onError`. The personal-chat prompt is not recorded.

import type { PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { ChatTarget, PrReadyChat } from '@snapwing/pipeline/merge/human.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import type { ChatPosted } from '../../server/chat.ts';
import { buildPrReady } from './cards/cards.ts';
import { action, assertLimits, type AdaptiveCard, type MentionFor } from './cards/elements.ts';
import type { TeamsOutgoingActivity } from './connector.ts';

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

/** An Adaptive Card as a message activity, its fallback text as the notification text. */
export function cardMessage(card: AdaptiveCard): TeamsOutgoingActivity {
  return { type: 'message', text: card.fallbackText, attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: card }] };
}

/** How the chat surface delivers: where a thread is, how a person is reached, what a card needs. */
export interface TeamsDelivery {
  /** Posts in `target`'s thread (a channel) or its chat, and says where it landed. */
  post(target: ChatTarget, activity: TeamsOutgoingActivity): Promise<ChatPosted>;
  /** Posts in a person's personal chat; false when it cannot be delivered there (no personal install). */
  postPersonal(userId: string, activity: TeamsOutgoingActivity): Promise<boolean>;
  /** Plain text in `target`'s thread; `<at>userId</at>` or `<at>handle</at>` becomes a real mention. */
  postText(target: ChatTarget, text: string): Promise<ChatPosted>;
  /** The mentions and reduced-mode banner for a card posted at `target`. */
  cardOptions(target: ChatTarget): Promise<{ mentions: MentionFor; reduced: boolean }>;
}

export interface TeamsPrReadyChatOptions {
  delivery: TeamsDelivery;
  /** Records each posted card as `bot-message-posted` (A 1.3). Absent: nothing is recorded. */
  state?: Pick<StatePort, 'read' | 'append'>;
  /** A record that failed. Default: ignored. */
  onError?: (error: unknown) => void;
}

export const LINK_PROMPT_LABEL = 'Link your GitHub account';

/** Said in the thread when the reviewer's personal chat is not open to the bot. */
export const NO_PERSONAL_CHAT_TEXT =
  "I can't message you directly yet. Add Snapwing as a personal app in Teams and I'll send your GitHub link there, so you can merge from here.";

export function createTeamsPrReadyChat(options: TeamsPrReadyChatOptions): PrReadyChat {
  const { delivery } = options;
  return {
    async postPrReady(target, incidentId: string, card: PrReadyCard, opts) {
      const built = buildPrReady(incidentId, card, { canMerge: opts.canMerge, ...(await delivery.cardOptions(target)) });
      const posted = await delivery.post(target, cardMessage(built));
      if (options.state !== undefined) {
        const ref = { platform: 'teams', channel: posted.channel, messageId: posted.messageId, role: 'pr' } as const;
        await recordBotMessage(options.state, incidentId, ref).catch(options.onError ?? (() => undefined));
      }
    },
    async postLinkPrompt(userId, target, incidentId, card, linkUrl) {
      const built = buildPrReady(incidentId, card, { canMerge: false, ...(await delivery.cardOptions(target)) });
      const prompt: AdaptiveCard = {
        ...built,
        actions: [...(built.actions ?? []), action(incidentId, { title: LINK_PROMPT_LABEL, verb: 'link_github', url: linkUrl })],
      };
      assertLimits(prompt);
      if (await delivery.postPersonal(userId, cardMessage(prompt))) return;
      await delivery.postText(target, `<at>${userId}</at> ${NO_PERSONAL_CHAT_TEXT}`);
    },
  };
}
