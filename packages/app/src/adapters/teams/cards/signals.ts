// Text-signal cards (A 3) as Adaptive Cards: the resolution question and the scope-change card. The
// message each is about rides in the action `data` as `messageId` (Slack carries it in the block id).

import type { ResolutionPrompt, ScopeChangeCard } from '@snapwing/pipeline/signals/text.ts';
import { actionSet, card, compose, free, type AdaptiveCard, type MentionFor } from './elements.ts';

interface Opts {
  mentions?: MentionFor;
  reduced?: boolean;
}

/** "Close WEB-1042 as Cannot Reproduce?" with **Close it** and **Keep it open**; only its asker should see it. */
export function buildResolutionPrompt(incidentId: string, prompt: Pick<ResolutionPrompt, 'text' | 'messageId'>, opts: Opts = {}): AdaptiveCard {
  return card(
    prompt.text,
    [compose([free(prompt.text)], opts.mentions)],
    actionSet(
      incidentId,
      [
        { title: 'Close it', verb: 'close', style: 'positive' },
        { title: 'Keep it open', verb: 'keep-open' },
      ],
      { messageId: prompt.messageId },
    ),
    opts,
  );
}

/** "Sounds like a second issue on the app. File it separately?" with **Yes** and **It's the same bug**. */
export function buildScopeChangeCard(incidentId: string, c: ScopeChangeCard, opts: Opts = {}): AdaptiveCard {
  return card(
    c.text,
    [compose([free(c.text)], opts.mentions)],
    actionSet(
      incidentId,
      c.choices.map((choice) => ({ title: choice.label, verb: choice.id })),
      { messageId: c.messageId },
    ),
    opts,
  );
}
