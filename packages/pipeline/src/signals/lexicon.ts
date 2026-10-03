// Phrase lexicon for the lexicon pass (Companion A 1.2): normalize, light stemming, word-boundary match.
import { PLAYBOOK_INTENTS, type PlaybookIntent, type PlaybookSignals } from '../config/playbook.ts';

/** Light stemming: "looking" and "looks" both reduce to "look". Short words are left alone. */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Lowercase, drop apostrophes, turn every other non-letter-or-digit run into a word break, then stem. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map(stem);
}

export interface LexiconEntry {
  intent: PlaybookIntent;
  tokens: string[];
}

/** Every phrase of every intent, tokenized. Longest phrases first; ties keep intent order. */
export function compileLexicon(signals: Pick<PlaybookSignals, 'intents'>): LexiconEntry[] {
  const entries: LexiconEntry[] = [];
  for (const intent of PLAYBOOK_INTENTS) {
    for (const phrase of signals.intents[intent].phrases) {
      const tokens = tokenize(phrase);
      if (tokens.length > 0) entries.push({ intent, tokens });
    }
  }
  return entries.sort((a, b) => b.tokens.length - a.tokens.length);
}

function containsRun(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return true;
  }
  return false;
}

/** The intent of the first (longest) phrase found as a whole-word run in `text`, if any. */
export function matchLexicon(entries: LexiconEntry[], text: string): PlaybookIntent | undefined {
  const tokens = tokenize(text);
  return entries.find((e) => containsRun(tokens, e.tokens))?.intent;
}
