import { describe, expect, it } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { ModelAuthError, ModelOutputError, ModelRateLimitError, ModelUnavailableError } from '../../src/models/errors.ts';
import { createGoogleModel, googleProviderFactory } from '../../src/models/google/index.ts';
import type { GoogleGenAiClient, GoogleGenerateParams } from '../../src/models/google/index.ts';
import { createModelRouter } from '../../src/models/router.ts';
import type { ClassifyRequest, ModelTask } from '../../src/ports/model.ts';

const MODELS: Record<ModelTask, string> = {
  triage: 'gemini-test-pro',
  segmentation: 'gemini-test-flash',
  vision: 'gemini-test-pro',
  clarify: 'gemini-test-flash',
  scout: 'gemini-test-pro',
  review: 'gemini-test-pro',
};

function reply(text: string, usage = { promptTokenCount: 11, candidatesTokenCount: 7 }): GenerateContentResponse {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage } as GenerateContentResponse;
}

function fakeClient(respond: (p: GoogleGenerateParams) => GenerateContentResponse | Error): { client: GoogleGenAiClient; calls: GoogleGenerateParams[] } {
  const calls: GoogleGenerateParams[] = [];
  const client: GoogleGenAiClient = {
    models: {
      generateContent: async (params) => {
        calls.push(params);
        const out = respond(params);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
  return { client, calls };
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status, name: 'ApiError' });
}

const build = (client: GoogleGenAiClient) => createGoogleModel({ apiKey: 'test-key-not-real', models: MODELS, client });

const classifyReq: ClassifyRequest<unknown> = {
  task: 'triage',
  system: 'You triage.',
  prompt: '<incident>total is blank</incident>',
  maxTokens: 300,
  temperature: 0,
  schemaName: 'severity',
  schema: {
    type: 'object',
    properties: { severity: { type: 'string', enum: ['low', 'high'] }, note: { type: ['string', 'null'] } },
    required: ['severity'],
    additionalProperties: false,
  },
  validate: (_v): _v is unknown => true,
};

describe('google adapter: complete', () => {
  it('sends system instruction, prompt, and limits; returns text, model, usage', async () => {
    const { client, calls } = fakeClient(() => reply('Which page?'));
    const result = await build(client).complete({ task: 'clarify', system: 'Ask one question.', prompt: 'hi', maxTokens: 50, temperature: 0.2 });
    expect(calls).toEqual([
      {
        model: 'gemini-test-flash',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { systemInstruction: 'Ask one question.', maxOutputTokens: 50, temperature: 0.2 },
      },
    ]);
    expect(result).toEqual({ text: 'Which page?', model: 'google/gemini-test-flash', usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it('omits unset limits and usage', async () => {
    const { client, calls } = fakeClient(() => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }) as GenerateContentResponse);
    const result = await build(client).complete({ task: 'review', system: 's', prompt: 'p' });
    expect(calls[0]?.config).toEqual({ systemInstruction: 's' });
    expect(result.usage).toBeUndefined();
  });
});

describe('google adapter: classify', () => {
  it('requests JSON with a Gemini responseSchema and returns the parsed object unvalidated', async () => {
    const { client, calls } = fakeClient(() => reply('{"severity":"high","note":null}'));
    const result = await build(client).classify(classifyReq);
    expect(result.value).toEqual({ severity: 'high', note: null });
    expect(result.model).toBe('google/gemini-test-pro');
    const config = calls[0]?.config;
    expect(config?.responseMimeType).toBe('application/json');
    expect(config?.systemInstruction).toBe('You triage.');
    expect(config?.responseSchema).toEqual({
      type: 'OBJECT',
      properties: {
        severity: { type: 'STRING', enum: ['low', 'high'] },
        note: { type: 'STRING', nullable: true },
      },
      propertyOrdering: ['severity', 'note'],
      required: ['severity'],
    });
  });

  it('throws ModelOutputError carrying the raw text when the answer is not JSON', async () => {
    const { client } = fakeClient(() => reply('not json'));
    const err = await build(client).classify(classifyReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelOutputError);
    expect((err as ModelOutputError).raw).toBe('not json');
  });

  it('throws ModelOutputError when the prompt is blocked or no candidates come back', async () => {
    const blocked = fakeClient(() => ({ promptFeedback: { blockReason: 'SAFETY' } }) as GenerateContentResponse);
    await expect(build(blocked.client).classify(classifyReq)).rejects.toBeInstanceOf(ModelOutputError);
    const empty = fakeClient(() => ({ candidates: [] }) as unknown as GenerateContentResponse);
    await expect(build(empty.client).classify(classifyReq)).rejects.toBeInstanceOf(ModelOutputError);
  });

  it('is retried once by the router with the validation error appended', async () => {
    const answers = ['{"severity":"nope"}', '{"severity":"low"}'];
    const { client, calls } = fakeClient(() => reply(answers.shift() ?? ''));
    const router = createModelRouter({ rows: [] }, { google: () => build(client) }, { GOOGLE_API_KEY: 'test-key-not-real' });
    const result = await router.classify<{ severity: string }>({
      ...classifyReq,
      validate: (v): v is { severity: string } => (v as { severity?: string }).severity === 'low',
    });
    expect(result).toMatchObject({ value: { severity: 'low' }, attempts: 2 });
    expect(JSON.stringify(calls[1]?.contents)).toContain('validation-error');
  });
});

describe('google adapter: vision', () => {
  const visionReq = {
    task: 'vision' as const,
    system: 'Read the screenshots.',
    prompt: 'One reading per image.',
    images: [
      { mimeType: 'image/png' as const, data: 'QUJD', ref: 'a' },
      { mimeType: 'image/jpeg' as const, data: 'REVG' },
    ],
  };
  const readings = [
    {
      errorText: 'Total is required',
      surfaceSignals: { urlBar: 'https://staging.example.test/cart', pageTitle: null, chrome: 'web' },
      uiElements: ['Total', 'Pay'],
      environmentHint: 'staging',
      plainDescription: 'The total field is blank.',
      sensitive: false,
    },
    { errorText: null, surfaceSignals: {}, uiElements: [], plainDescription: 'A login page.', sensitive: true },
  ];

  it('sends images as inlineData parts before the prompt and parses ImageReadings', async () => {
    const { client, calls } = fakeClient(() => reply(JSON.stringify(readings)));
    const result = await build(client).vision(visionReq);
    expect(calls[0]?.model).toBe('gemini-test-pro');
    expect(calls[0]?.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
          { inlineData: { mimeType: 'image/jpeg', data: 'REVG' } },
          { text: 'One reading per image.' },
        ],
      },
    ]);
    expect(calls[0]?.config.responseMimeType).toBe('application/json');
    expect(calls[0]?.config.responseSchema).toMatchObject({ type: 'ARRAY', items: { type: 'OBJECT' } });
    expect(result.readings).toEqual([
      {
        errorText: 'Total is required',
        surfaceSignals: { urlBar: 'https://staging.example.test/cart', chrome: 'web' },
        uiElements: ['Total', 'Pay'],
        environmentHint: 'staging',
        plainDescription: 'The total field is blank.',
        sensitive: false,
      },
      { surfaceSignals: {}, uiElements: [], plainDescription: 'A login page.', sensitive: true },
    ]);
    expect(result.model).toBe('google/gemini-test-pro');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it('throws ModelOutputError on a wrong reading count or a malformed reading', async () => {
    const short = fakeClient(() => reply(JSON.stringify(readings.slice(0, 1))));
    await expect(build(short.client).vision(visionReq)).rejects.toBeInstanceOf(ModelOutputError);
    const bad = fakeClient(() => reply(JSON.stringify([{ plainDescription: 1 }, readings[1]])));
    await expect(build(bad.client).vision(visionReq)).rejects.toBeInstanceOf(ModelOutputError);
  });
});

describe('google adapter: error mapping', () => {
  const run = (e: Error) => build(fakeClient(() => e).client).complete({ task: 'clarify', system: 's', prompt: 'p' }).catch((x: unknown) => x);

  it('maps 429 to ModelRateLimitError with retry-after from the RetryInfo detail', async () => {
    const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' }] } });
    const err = await run(apiError(429, body));
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect((err as ModelRateLimitError).retryAfterMs).toBe(31000);
  });

  it('maps 429 without a hint to ModelRateLimitError with undefined retryAfterMs', async () => {
    const err = await run(apiError(429, 'slow down'));
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect((err as ModelRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('reads a retry-after header on the error when present', async () => {
    const err = await run(Object.assign(apiError(429, 'x'), { headers: { 'retry-after': '5' } }));
    expect((err as ModelRateLimitError).retryAfterMs).toBe(5000);
  });

  it('maps 401, 403, and an invalid-key 400 to ModelAuthError', async () => {
    expect(await run(apiError(401, 'no'))).toBeInstanceOf(ModelAuthError);
    expect(await run(apiError(403, 'no'))).toBeInstanceOf(ModelAuthError);
    expect(await run(apiError(400, 'API key not valid. Please pass a valid API key.'))).toBeInstanceOf(ModelAuthError);
  });

  it('maps 5xx, 408, and network failures to ModelUnavailableError', async () => {
    expect(await run(apiError(503, 'overloaded'))).toBeInstanceOf(ModelUnavailableError);
    expect(await run(apiError(500, 'oops'))).toBeInstanceOf(ModelUnavailableError);
    expect(await run(apiError(408, 'timeout'))).toBeInstanceOf(ModelUnavailableError);
    expect(await run(new TypeError('fetch failed'))).toBeInstanceOf(ModelUnavailableError);
  });

  it('passes other errors through unchanged', async () => {
    const other = apiError(400, 'bad request');
    expect(await run(other)).toBe(other);
  });

  it('keeps the original error as cause', async () => {
    const original = apiError(503, 'overloaded');
    expect(((await run(original)) as Error).cause).toBe(original);
  });
});

describe('google provider factory', () => {
  it('builds a backend for the route and refuses without a key', () => {
    const route = { task: 'triage', provider: 'google', model: 'gemini-test-pro', source: 'row' } as const;
    expect(googleProviderFactory(route, { GOOGLE_API_KEY: 'test-key-not-real' }).classify).toBeTypeOf('function');
    expect(() => googleProviderFactory(route, {})).toThrow(ModelAuthError);
  });

  it('createGoogleModel rejects an empty key', () => {
    expect(() => createGoogleModel({ apiKey: ' ', models: MODELS })).toThrow(ModelAuthError);
  });
});
