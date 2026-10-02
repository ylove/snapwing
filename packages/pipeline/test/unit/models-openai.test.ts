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
import {
  createOpenAIModel,
  ModelSchemaError,
  openaiProvider,
  stripAddedNulls,
  toStrictSchema,
  type OpenAIChatClient,
} from '../../src/models/openai/index.ts';
import { createModelRouter, withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest, JsonSchema } from '../../src/ports/model.ts';

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

describe('openai strict schema transform', () => {
  it('passes an already-strict schema through unchanged', () => {
    expect(toStrictSchema(SCHEMA)).toEqual(SCHEMA);
    expect(toStrictSchema(toStrictSchema(SCHEMA))).toEqual(toStrictSchema(SCHEMA));
  });

  it('makes a flat optional property required and nullable', () => {
    const out = toStrictSchema({
      type: 'object',
      properties: { label: { type: 'string' }, note: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] } },
      required: ['label'],
    });
    expect(out).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['label', 'note', 'kind'],
      properties: {
        label: { type: 'string' },
        note: { type: ['string', 'null'] },
        kind: { type: ['string', 'null'], enum: ['a', 'b', null] },
      },
    });
  });

  it('recurses through nested objects and arrays of objects', () => {
    const out = toStrictSchema({
      type: 'object',
      required: ['inner', 'list'],
      properties: {
        inner: { type: 'object', properties: { a: { type: 'string' } } },
        list: { type: 'array', items: { type: 'object', properties: { b: { type: 'number' } }, required: [] } },
      },
    });
    expect(out.properties?.inner).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: ['string', 'null'] } },
    });
    expect(out.properties?.list?.items).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['b'],
      properties: { b: { type: ['number', 'null'] } },
    });
  });

  it('wraps an optional $ref or anyOf property with null', () => {
    const out = toStrictSchema({
      type: 'object',
      properties: { r: { $ref: '#/$defs/x' }, u: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      $defs: { x: { type: 'object', properties: { y: { type: 'string' } } } },
    });
    expect(out.properties?.r).toEqual({ anyOf: [{ $ref: '#/$defs/x' }, { type: 'null' }] });
    expect(out.properties?.u).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] });
    expect(out.$defs?.x?.required).toEqual(['y']);
  });

  it('throws ModelSchemaError for schemas strict mode cannot express', () => {
    const bad = [
      { type: 'object', patternProperties: { '^a': { type: 'string' } } },
      { type: 'object', properties: {}, additionalProperties: true },
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
      { type: 'object', properties: { a: { allOf: [{ type: 'string' }] } } },
    ] as unknown as JsonSchema[];
    for (const schema of bad) expect(() => toStrictSchema(schema)).toThrow(ModelSchemaError);
  });

  it('strips only the nulls that the transform introduced', () => {
    const original: JsonSchema = {
      type: 'object',
      required: ['keep'],
      properties: {
        keep: { type: ['string', 'null'] },
        gone: { type: 'string' },
        nullOk: { type: ['string', 'null'] },
        inner: { type: 'object', properties: { a: { type: 'string' } } },
        list: { type: 'array', items: { type: 'object', properties: { b: { type: 'number' } } } },
      },
    };
    const value = { keep: null, gone: null, nullOk: null, inner: { a: null }, list: [{ b: null }, { b: 2 }] };
    expect(stripAddedNulls(value, original)).toEqual({ keep: null, nullOk: null, inner: {}, list: [{}, { b: 2 }] });
  });
});

describe('openai classify with optional properties', () => {
  const optionalRequest: ClassifyRequest<{ label: string; note?: string }> = {
    ...classifyRequest,
    schema: { type: 'object', properties: { label: { type: 'string' }, note: { type: 'string' } }, required: ['label'] },
    validate: (v): v is { label: string; note?: string } => typeof v === 'object' && v !== null && !('note' in v && v.note === null),
  };

  it('sends a strict schema and hands validate the shape the caller asked for', async () => {
    const { client, calls } = fakeClient(() => completion('{"label":"bug","note":null}'));
    const result = await createOpenAIModel({ apiKey: FAKE_KEY, client }).classify(optionalRequest);
    expect(result.value).toEqual({ label: 'bug' });
    const format = calls[0]?.response_format as { json_schema: { schema: JsonSchema; strict: boolean } };
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.required).toEqual(['label', 'note']);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
  });

  it('throws before any API call when the schema cannot be made strict', async () => {
    const { client, calls } = fakeClient(() => completion('{}'));
    const request = { ...optionalRequest, schema: { type: 'object', patternProperties: {} } as unknown as JsonSchema };
    await expect(createOpenAIModel({ apiKey: FAKE_KEY, client }).classify(request)).rejects.toBeInstanceOf(ModelSchemaError);
    expect(calls).toHaveLength(0);
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
