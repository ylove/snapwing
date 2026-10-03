import { describe, expect, it } from 'vitest';
import { defaultPlaybook, PLAYBOOK_INTENTS } from '../../src/config/playbook.ts';
import { classifyLexicon, classifyReaction } from '../../src/signals/classify.ts';
import { stem, tokenize } from '../../src/signals/lexicon.ts';

const { signals } = defaultPlaybook();

describe('reaction lookup', () => {
  it.each(PLAYBOOK_INTENTS.flatMap((intent) => signals.intents[intent].emoji.map((e) => [intent, e.slack, e.teams] as const)))(
    '%s: slack %s and teams %s classify',
    (intent, slack, teams) => {
      expect(classifyReaction(signals, 'slack', slack)).toEqual({ intent, confidence: 1 });
      expect(classifyReaction(signals, 'teams', teams)).toEqual({ intent, confidence: 1 });
    },
  );

  it('uses per-platform names and tolerates colons, case, and skin tones', () => {
    expect(classifyReaction(signals, 'teams', 'like').intent).toBe('accept');
    expect(classifyReaction(signals, 'slack', 'like').intent).toBe('none');
    expect(classifyReaction(signals, 'slack', ':+1::skin-tone-3:').intent).toBe('accept');
    expect(classifyReaction(signals, 'slack', 'EYES').intent).toBe('claim');
  });

  it('returns none for unknown names', () => {
    expect(classifyReaction(signals, 'slack', 'banana')).toEqual({ intent: 'none' });
  });

  it('honors a playbook override and channel scoping', () => {
    const custom = defaultPlaybook().signals;
    custom.intents.trigger.emoji = [{ slack: 'ladybug', teams: 'ladybug' }];
    custom.intents.stop.emoji.push({ slack: 'bug', teams: 'bug', channel: 'C1' });
    expect(classifyReaction(custom, 'slack', 'ladybug').intent).toBe('trigger');
    expect(classifyReaction(custom, 'slack', 'bug').intent).toBe('none');
    expect(classifyReaction(custom, 'slack', 'bug', { channel: ['C1', 'ops'] }).intent).toBe('stop');
    expect(classifyReaction(custom, 'slack', 'bug', { channel: 'C2' }).intent).toBe('none');
  });
});

describe('lexicon pass', () => {
  it.each(PLAYBOOK_INTENTS.flatMap((intent) => signals.intents[intent].phrases.map((p) => [intent, p] as const)))(
    '%s: "%s" and shouted or punctuated variants',
    (intent, phrase) => {
      expect(classifyLexicon(signals, phrase)).toEqual({ intent, confidence: 1 });
      expect(classifyLexicon(signals, `${phrase.toUpperCase()}!`)).toEqual({ intent, confidence: 1 });
      expect(classifyLexicon(signals, `  ok, ${phrase}...  `)).toEqual({ intent, confidence: 1 });
    },
  );

  it('A 8: "on it", "On it!", "ok on it" are claim; "on iteration 3" is not', () => {
    for (const t of ['on it', 'On it!', 'ok on it']) expect(classifyLexicon(signals, t)).toEqual({ intent: 'claim', confidence: 1 });
    expect(classifyLexicon(signals, 'on iteration 3')).toEqual({ intent: 'none' });
  });

  it('stems lightly: "looking into it" is claim, "I am checking" is claim', () => {
    expect(classifyLexicon(signals, 'looking into it').intent).toBe('claim');
    expect(classifyLexicon(signals, 'I am checking').intent).toBe('claim');
  });

  it('respects word boundaries', () => {
    expect(classifyLexicon(signals, 'stopwatch').intent).toBe('none');
    expect(classifyLexicon(signals, 'minefield').intent).toBe('none');
    expect(classifyLexicon(signals, 'waiter').intent).toBe('none');
  });

  it('handles curly apostrophes', () => {
    expect(classifyLexicon(signals, 'can’t right now').intent).toBe('release');
    expect(classifyLexicon(signals, 'That’s expected').intent).toBe('not-a-bug');
  });

  it('skips messages at or over lexicon.maxWords and empty ones', () => {
    const words = (n: number): string => ['on it', ...Array.from({ length: n - 2 }, () => 'x')].join(' ');
    expect(classifyLexicon(signals, words(11)).intent).toBe('claim');
    expect(classifyLexicon(signals, words(12)).intent).toBe('none');
    expect(classifyLexicon(signals, '')).toEqual({ intent: 'none' });
    expect(classifyLexicon(signals, '!!!')).toEqual({ intent: 'none' });
  });

  it('prefers the longest matching phrase and is deterministic', () => {
    const custom = defaultPlaybook().signals;
    custom.intents.release.phrases.push('wait for it');
    expect(classifyLexicon(custom, 'wait for it')).toEqual({ intent: 'release', confidence: 1 });
    expect(classifyLexicon(custom, 'wait')).toEqual({ intent: 'stop', confidence: 1 });
  });

  it('honors a playbook override of phrases and maxWords', () => {
    const custom = defaultPlaybook().signals;
    custom.intents.claim.phrases = ['peeking'];
    custom.lexicon.maxWords = 4;
    expect(classifyLexicon(custom, 'peeking now').intent).toBe('claim');
    expect(classifyLexicon(custom, 'on it').intent).toBe('none');
    expect(classifyLexicon(custom, 'peeking at it right now').intent).toBe('none');
  });
});

describe('tokenize and stem', () => {
  it('normalizes', () => {
    expect(tokenize("Don't  FIX this, yet!")).toEqual(['dont', 'fix', 'this', 'yet']);
    expect(stem('looking')).toBe('look');
    expect(stem('this')).toBe('this');
    expect(stem('it')).toBe('it');
  });
});
