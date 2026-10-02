import { describe, expect, it } from 'vitest';
import { APIConnectionError, APIError } from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import {
  ModelAuthError,
  ModelOutputError,
  ModelRateLimitError,
  ModelUnavailableError,
  ModelValidationError,
} from '../../src/models/errors.ts';
import { createOpenAIModel, openaiProvider, type OpenAIChatClient } from '../../src/models/openai/index.ts';
import { createModelRouter, withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest } from '../../src/ports/model.ts';

// Obvious fakes only; no network, no key.
const FAKE_KEY = 'fake-openai-key';

type Body = ChatCompletionCreateParamsNonStreaming;

function completion(content: string | null, extra: Partial<ChatCompletion['choices'][number]['message']> = {}, finish = 'stop'): ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5-test',
    choices: [
      { index: 0, finish_reason: finish as 'stop', logprobs: null, message: { role: 'assistant', content, refusal: null, ...extra } },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function fakeClient(reply: () => ChatCompletion | Error): { client: OpenAIChatClient; calls: Body[] } {
  const calls: Body[] = [];
  const client: OpenAIChatClient = {
    chat: {
      completions: {
        create: (body) => {
          calls.push(body);
          const out = reply();
          return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
        },
      },
    },
  };
  return { client, calls };
}

const SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['label'],
  properties: { label: { type: 'string' as const } },
};
const isLabel = (v: unknown): v is { label: string } =>
  typeof v === 'object' && v !== null && typeof (v as { label?: unknown }).label === 'string';

const classifyRequest: ClassifyRequest<{ label: string }> = {
  task: 'triage',
  system: 'sys',
  prompt: '<p>hi</p>',
  schemaName: 'label_result',
  schema: SCHEMA,
  validate: isLabel,
  maxTokens: 100,
  temperature: 0.2,
};

describe('openai complete', () => {
  it('sends system and user messages and returns text with usage', async () => {
    const { client, calls } = fakeClient(() => completion('hello'));
    const model = createOpenAIModel({ apiKey: FAKE_KEY, client, models: { triage: 'gpt-test' } });
    const result = await model.complete({ task: 'triage', system: 'sys', prompt: 'p', maxTokens: 50, temperature: 0 });
    expect(result).toEqual({ text: 'hello', model: 'openai/gpt-5-test', usage: { inputTokens: 11, outputTokens: 7 } });
    expect(calls).toEqual([
      {
        model: 'gpt-test',
        max_completion_tokens: 50,
        temperature: 0,
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'p' },
        ],
      },
    ]);
  });

  it('falls back to the default model for a task without a configured name', async () => {
    const { client, calls } = fakeClient(() => completion('x'));
    await createOpenAIModel({ apiKey: FAKE_KEY, client }).complete({ task: 'segmentation', system: 's', prompt: 'p' });
    expect(calls[0]?.model).toBe('gpt-5-mini');
    expect(calls[0]).not.toHaveProperty('max_completion_tokens');
  });
});

describe('openai classify', () => {
  it('maps to a strict json_schema response_format and returns the parsed object', async () => {
    const { client, calls } = fakeClient(() => completion('{"label":"bug"}'));
    const model = createOpenAIModel({ apiKey: FAKE_KEY, client });
    const result = await model.classify(classifyRequest);
    expect(result.value).toEqual({ label: 'bug' });
    expect(calls[0]?.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'label_result', schema: SCHEMA, strict: true },
    });
  });

  it('throws ModelOutputError for non-JSON, refusals, truncation, and empty answers', async () => {
    const cases: ChatCompletion[] = [
      completion('not json'),
      completion(null, { refusal: 'no' }),
      completion('{"label"', {}, 'length'),
      completion(''),
    ];
    for (const reply of cases) {
      const { client } = fakeClient(() => reply);
      await expect(createOpenAIModel({ apiKey: FAKE_KEY, client }).classify(classifyRequest)).rejects.toBeInstanceOf(ModelOutputError);
    }
  });

  it('works under withValidation: retries once with the error appended, then validates', async () => {
    const replies = ['{"label":1}', '{"label":"ok"}'];
    const { client, calls } = fakeClient(() => completion(replies.shift() ?? ''));
    const port = withValidation(createOpenAIModel({ apiKey: FAKE_KEY, client }));
    const result = await port.classify(classifyRequest);
    expect(result).toMatchObject({ value: { label: 'ok' }, attempts: 2 });
    expect(calls[1]?.messages[1]).toMatchObject({ content: expect.stringContaining('<validation-error') });
  });

  it('surfaces ModelValidationError after two unparseable answers', async () => {
    const { client } = fakeClient(() => completion('nope'));
    const port = withValidation(createOpenAIModel({ apiKey: FAKE_KEY, client }));
    await expect(port.classify(classifyRequest)).rejects.toBeInstanceOf(ModelValidationError);
  });
});

describe('openai vision', () => {
  const reading = {
    errorText: 'Boom',
    surfaceSignals: { urlBar: 'https://app.example/x', pageTitle: null, chrome: 'web' },
    uiElements: ['Save'],
    environmentHint: null,
    plainDescription: 'the total field is blank',
    sensitive: false,
  };
  const request = {
    task: 'vision' as const,
    system: 'sys',
    prompt: 'read these',
    images: [
      { mimeType: 'image/png' as const, data: 'AAAA', ref: 'a' },
      { mimeType: 'image/jpeg' as const, data: 'BBBB' },
    ],
  };

  it('sends base64 image_url parts and parses into ImageReading, dropping nulls', async () => {
    const { client, calls } = fakeClient(() => completion(JSON.stringify({ readings: [reading, reading] })));
    const result = await createOpenAIModel({ apiKey: FAKE_KEY, client }).vision(request);
    expect(calls[0]?.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'read these' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
      ],
    });
    expect(calls[0]?.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(result.readings).toHaveLength(2);
    expect(result.readings[0]).toEqual({
      errorText: 'Boom',
      surfaceSignals: { urlBar: 'https://app.example/x', chrome: 'web' },
      uiElements: ['Save'],
      plainDescription: 'the total field is blank',
      sensitive: false,
    });
  });

  it('throws ModelOutputError when the reading count or shape is wrong', async () => {
    for (const body of [{ readings: [reading] }, { readings: [{ ...reading, sensitive: 'no' }, reading] }, { other: 1 }]) {
      const { client } = fakeClient(() => completion(JSON.stringify(body)));
      await expect(createOpenAIModel({ apiKey: FAKE_KEY, client }).vision(request)).rejects.toBeInstanceOf(ModelOutputError);
    }
  });
});

describe('openai error mapping', () => {
  const run = (err: Error) => {
    const { client } = fakeClient(() => err);
    return createOpenAIModel({ apiKey: FAKE_KEY, client }).complete({ task: 'triage', system: 's', prompt: 'p' });
  };
  const apiError = (status: number, headers: Record<string, string> = {}) =>
    APIError.generate(status, { message: `status ${status}` }, `status ${status}`, new Headers(headers));

  it('maps 429 to ModelRateLimitError with retry-after in ms', async () => {
    const err = await run(apiError(429, { 'retry-after': '3' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect((err as ModelRateLimitError).retryAfterMs).toBe(3000);
  });

  it('prefers retry-after-ms and leaves retryAfterMs unset when absent', async () => {
    const a = await run(apiError(429, { 'retry-after-ms': '250', 'retry-after': '9' })).catch((e: unknown) => e);
    expect((a as ModelRateLimitError).retryAfterMs).toBe(250);
    const b = await run(apiError(429)).catch((e: unknown) => e);
    expect(b).toBeInstanceOf(ModelRateLimitError);
    expect((b as ModelRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('maps 401 and 403 to ModelAuthError', async () => {
    await expect(run(apiError(401))).rejects.toBeInstanceOf(ModelAuthError);
    await expect(run(apiError(403))).rejects.toBeInstanceOf(ModelAuthError);
  });

  it('maps 5xx and connection failures to ModelUnavailableError', async () => {
    await expect(run(apiError(500))).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(run(apiError(503))).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(run(new APIConnectionError({ message: 'down' }))).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('rethrows other errors untouched', async () => {
    const odd = new Error('odd');
    await expect(run(odd)).rejects.toBe(odd);
    await expect(run(apiError(400))).rejects.toBeInstanceOf(APIError);
  });

  it('throws ModelAuthError when no key is configured', async () => {
    const model = createOpenAIModel({ apiKey: undefined });
    await expect(model.complete({ task: 'triage', system: 's', prompt: 'p' })).rejects.toBeInstanceOf(ModelAuthError);
  });
});

describe('openaiProvider', () => {
  it('registers with the router and builds from the route and env key', () => {
    const router = createModelRouter(
      { defaultProvider: 'openai', rows: [{ task: 'triage', provider: 'openai', name: 'gpt-custom' }] },
      { openai: openaiProvider },
      { OPENAI_API_KEY: FAKE_KEY },
    );
    expect(router.routes.triage).toMatchObject({ provider: 'openai', model: 'gpt-custom' });
  });
});
