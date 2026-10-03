// Reaction lookup and the lexicon pass (Companion A 1.2). Pure and deterministic.
import { PLAYBOOK_INTENTS, type PlaybookSignals } from '../config/playbook.ts';
import type { Intent } from '../contracts/signals.ts';
import { compileLexicon, matchLexicon } from './lexicon.ts';

export type Classification = { intent: Exclude<Intent, 'none'>; confidence: 1 } | { intent: 'none' };

const NONE: Classification = { intent: 'none' };

/** Slack names (colons, `::skin-tone-N` suffixes) and Teams names compare case-insensitively. */
export function normalizeEmojiName(name: string): string {
  return name.trim().replace(/^:+|:+$/g, '').replace(/::skin-tone-\d(-\d)?$/i, '').toLowerCase();
}

export interface ReactionContext {
  /** Channel id and/or name where the reaction landed; matches `<emoji channel="...">` scoping. */
  channel?: string | readonly string[];
}

/** Look a reaction up in the playbook's per-platform emoji names. A channel-scoped emoji beats an unscoped one in its channel. */
export function classifyReaction(
  signals: Pick<PlaybookSignals, 'intents'>,
  platform: 'slack' | 'teams',
  name: string,
  context: ReactionContext = {},
): Classification {
  const want = normalizeEmojiName(name);
  const channels = ([] as string[]).concat(context.channel ?? []).map((c) => c.toLowerCase());
  let unscoped: Classification = NONE;
  for (const intent of PLAYBOOK_INTENTS) {
    for (const e of signals.intents[intent].emoji) {
      if (normalizeEmojiName(e[platform]) !== want) continue;
      if (e.channel === undefined) {
        if (unscoped.intent === 'none') unscoped = { intent, confidence: 1 };
      } else if (channels.includes(e.channel.toLowerCase())) {
        return { intent, confidence: 1 };
      }
    }
  }
  return unscoped;
}

/**
 * The lexicon pass: messages of fewer than `lexicon.maxWords` words that contain a phrase of an intent
 * as whole words (case-insensitive, punctuation stripped, lightly stemmed). Longest phrase wins.
 */
export function classifyLexicon(signals: Pick<PlaybookSignals, 'intents' | 'lexicon'>, text: string): Classification {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0 || words.length >= signals.lexicon.maxWords) return NONE;
  const intent = matchLexicon(compileLexicon(signals), text);
  return intent === undefined ? NONE : { intent, confidence: 1 };
}
