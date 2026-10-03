import { describe, expect, it } from 'vitest';
import type { PlaybookSignals } from '../../src/config/playbook.ts';
import type { ClassifyRequest, ModelPort } from '../../src/ports/model.ts';
import {
  buildSignalRequest,
  classifyLlm,
  isSignalAnswer,
  loadSignalPrompt,
  parseSignalPrompt,
  type SignalMessage,
} from '../../src/signals/llm.ts';

const signals: Pick<PlaybookSignals, 'lexicon'> = { lexicon: { maxWords: 12, confidenceFloor: 0.7 } };

const message: SignalMessage = {
  id: 'm2', authorId: 'U-pat', text: 'hmm, honestly that is how the export is meant to behave', timestamp: '2026-10-01T14:05:00Z',
};
const thread: SignalMessage[] = [
  { id: 'm1', authorId: 'U-dana', text: 'export button is broken <again>', timestamp: '2026-10-01T14:00:00Z' },
];

/** A scripted model: answers classify with the given value and records the requests it saw. */
function scripted(answer: unknown): { model: ModelPort; seen: ClassifyRequest<unknown>[] } {
  const seen: ClassifyRequest<unknown>[] = [];
  const unused = (): never => {
    throw new Error('unexpected model call');
  };
  const model: ModelPort = {
    complete: unused,
    vision: unused,
    async classify<T>(request: ClassifyRequest<T>) {
      seen.push(request as ClassifyRequest<unknown>);
      if (!request.validate(answer)) throw new Error('scripted answer fails validation');
      return { value: answer, attempts: 1 as const, model: 'mock/scripted' };
    },
  };
  return { model, seen };
}

describe('classifyLlm', () => {
  const intents = ['trigger', 'escalate', 'claim', 'release', 'stop', 'accept', 'reject', 'watch', 'not-a-bug'] as const;
  for (const intent of intents) {
    it(`returns ${intent} with its confidence`, async () => {
      const { model } = scripted({ intent, confidence: 0.86 });
      expect(await classifyLlm(signals, message, thread, model)).toEqual({ intent, confidence: 0.86 });
    });
  }

  it('returns none when the model says none, whatever the confidence', async () => {
    const { model } = scripted({ intent: 'none', confidence: 0.95 });
    expect(await classifyLlm(signals, message, thread, model)).toEqual({ intent: 'none' });
  });

  it('drops an intent under the confidence floor and keeps one exactly at it', async () => {
    expect(await classifyLlm(signals, message, thread, scripted({ intent: 'claim', confidence: 0.69 }).model)).toEqual({ intent: 'none' });
    expect(await classifyLlm(signals, message, thread, scripted({ intent: 'claim', confidence: 0.7 }).model)).toEqual({
      intent: 'claim',
      confidence: 0.7,
    });
  });

  it('uses the playbook floor, not a fixed one', async () => {
    const strict = { lexicon: { maxWords: 12, confidenceFloor: 0.9 } };
    expect(await classifyLlm(strict, message, thread, scripted({ intent: 'stop', confidence: 0.85 }).model)).toEqual({ intent: 'none' });
  });

  it('ignores a confidence above 1', async () => {
    expect(await classifyLlm(signals, message, thread, scripted({ intent: 'stop', confidence: 7 }).model)).toEqual({ intent: 'none' });
  });

  it('sends task segmentation, schema signal, and the escaped message and thread', async () => {
    const { model, seen } = scripted({ intent: 'none', confidence: 0.9 });
    await classifyLlm(signals, message, thread, model);
    const request = seen[0];
    expect(request?.task).toBe('segmentation');
    expect(request?.schemaName).toBe('signal');
    expect(request?.temperature).toBe(0);
    expect(request?.prompt).toContain('<message id="m2"');
    expect(request?.prompt).toContain('export button is broken &lt;again&gt;');
    expect(request?.prompt).not.toContain('{{');
  });
});

describe('signal answers and prompt', () => {
  it('validates only the known intents with a numeric confidence', () => {
    expect(isSignalAnswer({ intent: 'watch', confidence: 0.8 })).toBe(true);
    expect(isSignalAnswer({ intent: 'maybe', confidence: 0.8 })).toBe(false);
    expect(isSignalAnswer({ intent: 'watch' })).toBe(false);
    expect(isSignalAnswer({ intent: 'watch', confidence: Number.NaN })).toBe(false);
    expect(isSignalAnswer(null)).toBe(false);
  });

  it('parses both elements from prompts/signals.xml and names every intent', async () => {
    const prompt = await loadSignalPrompt();
    for (const intent of ['trigger', 'escalate', 'claim', 'release', 'stop', 'accept', 'reject', 'watch', 'not-a-bug', 'none']) {
      expect(prompt.system).toContain(intent);
    }
    expect(buildSignalRequest(message, [], prompt).prompt).toContain('<thread>');
    expect(() => parseSignalPrompt('<signals-prompt/>')).toThrow();
  });
});
