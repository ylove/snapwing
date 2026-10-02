// Resolution signals (main 5.4): a message that means "do not file", such as "nvm, works now". The model
// names the message; this module decides whether the claim stands. A signal only counts when the message
// is in the pile, is not the anchor, and was sent after the anchor.

import type { ContextBundle, SourceMessage } from '../contracts/incident.ts';

export type ResolutionSignal = NonNullable<ContextBundle['resolutionSignal']>;

function isAfter(message: SourceMessage, anchor: SourceMessage): boolean {
  const t = Date.parse(message.timestamp);
  const a = Date.parse(anchor.timestamp);
  // Same-instant messages order by id, as collectWindow does.
  return t > a || (t === a && message.id.localeCompare(anchor.id) > 0);
}

/**
 * Check the model's claimed resolution message against the pile. Returns the signal, or undefined when
 * the id is empty, unknown, the anchor itself, or not after the anchor (the same words before the anchor
 * are the reporter's own context, not a retraction).
 */
export function acceptResolutionSignal(
  claimedId: string | undefined,
  pile: readonly SourceMessage[],
  anchor: SourceMessage,
): ResolutionSignal | undefined {
  if (claimedId === undefined || claimedId === '' || claimedId === anchor.id) return undefined;
  const message = pile.find((m) => m.id === claimedId);
  if (message === undefined || !isAfter(message, anchor)) return undefined;
  return { messageId: message.id, text: message.text };
}
