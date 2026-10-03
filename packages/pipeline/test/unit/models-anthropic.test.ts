import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  acceptsRefusalFallback,
  anthropicProvider,
  createAnthropicModel,
  REFUSAL_FALLBACK_BETA,
  MIN_THINKING_MAX_TOKENS,
  ModelSchemaError,
  acceptsSampling,
  mapAnthropicError,
  type AnthropicClientLike,
} from '../../src/models/anthropic/index.ts';
import {
  ModelAuthError,
  ModelOutputError,
  ModelRateLimitError,
  ModelRefusalError,
  ModelUnavailableError,
  ModelValidationError,
} from '../../src/models/errors.ts';
import { DEFAULT_MODELS, createModelRouter, withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest, JsonSchema } from '../../src/ports/model.ts';

const FAKE_KEY = 'sk-ant-test-fake';

function message(content: unknown[], extra: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 11, output_tokens: 7 },
    ...extra,
  } as unknown as Anthropic.Message;
}

/** Params as either endpoint received them; the beta endpoint adds `betas` and `fallbacks`. */
type SentParams = Anthropic.MessageCreateParamsNonStreaming & { betas?: string[]; fallbacks?: unknown };

function fakeClient(replies: Array<Anthropic.Message | Error>) {
  const calls: SentParams[] = [];
  const endpoints: Array<'messages' | 'beta'> = [];
  const reply = (endpoint: 'messages' | 'beta') => async (params: SentParams): Promise<Anthropic.Message> => {
    calls.push(params);
    endpoints.push(endpoint);
    const next = replies.shift();
    if (next === undefined) throw new Error('no reply queued');
    if (next instanceof Error) throw next;
    return next;
  };
  const client = {
    messages: { create: reply('messages') },
    beta: { messages: { create: reply('beta') } },
  } as unknown as AnthropicClientLike;
  return { client, calls, endpoints };
}

const models = { ...DEFAULT_MODELS.anthropic, triage: 'claude-test-triage' };
const schema: JsonSchema = {
  type: 'object',
  properties: { priority: { type: 'string', enum: ['p1', 'p2'] } },
  required: ['priority'],
};
const isPriority = (v: unknown): v is { priority: string } =>
  typeof v === 'object' && v !== null && typeof (v as { priority?: unknown }).priority === 'string';
const classifyRequest: ClassifyRequest<{ priority: string }> = {
  task: 'triage',
  system: 'sys',
  prompt: '<ticket/>',
  schemaName: 'triage_result',
  schema,
  validate: isPriority,
};
/** A structured-output reply as Opus 5.5 and Sonnet 5.5 send it: an (omitted) thinking block, then the JSON text. */
const answer = (value: unknown, extra: Record<string, unknown> = {}) =>
  message([{ type: 'thinking', thinking: '', signature: 'sig-test' }, { type: 'text', text: JSON.stringify(value) }], extra);

describe('anthropic complete', () => {
  it('sends temperature and the caller max_tokens to a model that takes sampling (Haiku 4.5)', async () => {
    const { client, calls } = fakeClient([message([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])]);
    const model = createAnthropicModel({ apiKey: FAKE_KEY, models: { ...models, triage: 'claude-haiku-4-5' }, client });
    const result = await model.complete({ task: 'triage', system: 'be brief', prompt: 'hi', temperature: 0.2, maxTokens: 50 });
    expect(calls).toEqual([
      { model: 'claude-haiku-4-5', max_tokens: 50, system: 'be brief', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] },
    ]);
    expect(result).toEqual({ text: 'hello world', model: 'anthropic/claude-haiku-4-5', usage: { inputTokens: 11, outputTokens: 7 } });
  });

  for (const name of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
    it(`sends no temperature or thinking to ${name} and keeps room for thinking`, async () => {
      const { client, calls } = fakeClient([message([{ type: 'text', text: 'x' }])]);
      const model = createAnthropicModel({ apiKey: FAKE_KEY, models: { ...models, triage: name }, client });
      await model.complete({ task: 'triage', system: 's', prompt: 'p', temperature: 0, maxTokens: 1024 });
      expect(calls[0]).not.toHaveProperty('temperature');
      expect(calls[0]).not.toHaveProperty('thinking');
      expect(calls[0]?.max_tokens).toBe(MIN_THINKING_MAX_TOKENS);
    });
  }

  it('defaults max_tokens to 16000 and omits temperature', async () => {
    const { client, calls } = fakeClient([message([{ type: 'text', text: 'x' }])]);
    await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).complete({ task: 'clarify', system: 's', prompt: 'p' });
    expect(calls[0]?.max_tokens).toBe(16000);
    expect(calls[0]).not.toHaveProperty('temperature');
    expect(calls[0]?.model).toBe(DEFAULT_MODELS.anthropic.clarify);
  });

  it('throws ModelRefusalError on a refusal', async () => {
    const { client } = fakeClient([
      message([{ type: 'text', text: 'partial' }], {
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
      }),
    ]);
    const err = await createAnthropicModel({ apiKey: FAKE_KEY, models, client })
      .complete({ task: 'triage', system: 's', prompt: 'p' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect(err).toMatchObject({ category: 'cyber' });
  });
});

describe('anthropic refusal fallback', () => {
  it('acceptsRefusalFallback is true only for the models whose classifiers decline', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1']) expect(acceptsRefusalFallback(m), m).toBe(true);
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-mythos-5-1', 'claude-test-triage', 'claude-opus-5-5-x']) {
      expect(acceptsRefusalFallback(m), m).toBe(false);
    }
  });

  it('sends fallbacks "default" with the beta header to a model that takes it, by default', async () => {
    const { client, calls, endpoints } = fakeClient([answer({ priority: 'p1' })]);
    const model = createAnthropicModel({ apiKey: FAKE_KEY, models: { ...models, triage: 'claude-opus-5-5' }, client });
    await model.classify(classifyRequest);
    expect(endpoints).toEqual(['beta']);
    expect(calls[0]).toMatchObject({ betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default', model: 'claude-opus-5-5' });
  });

  it('uses the plain endpoint without either field for other models, or when turned off', async () => {
    const { client, calls, endpoints } = fakeClient([answer({ priority: 'p1' }), answer({ priority: 'p1' })]);
    await createAnthropicModel({ apiKey: FAKE_KEY, models: { ...models, triage: 'claude-haiku-4-5' }, client }).classify(classifyRequest);
    await createAnthropicModel({ apiKey: FAKE_KEY, models: { ...models, triage: 'claude-opus-5-5' }, refusalFallback: false, client }).classify(
      classifyRequest,
    );
    expect(endpoints).toEqual(['messages', 'messages']);
    for (const call of calls) {
      expect(call).not.toHaveProperty('betas');
      expect(call).not.toHaveProperty('fallbacks');
    }
  });

  it('reads only the text after the last fallback block and names the serving model', async () => {
    const reply = message(
      [
        { type: 'text', text: '{"prio' },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } },
        { type: 'text', text: '{"priority":"p2"}' },
      ],
      {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          iterations: [{ type: 'message', model: 'claude-opus-5-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }],
        },
      },
    );
    const { client } = fakeClient([reply]);
    const result = await createAnthropicModel({ apiKey: FAKE_KEY, models: { ...models, triage: 'claude-opus-5-5' }, client }).classify(classifyRequest);
    expect(result).toEqual({ value: { priority: 'p2' }, model: 'anthropic/claude-opus-4-8', usage: { inputTokens: 5, outputTokens: 3 } });
  });

  it('the router carries refusalFallback false to every route only when the config turns it off', () => {
    const off = createModelRouter({ rows: [], refusalFallback: false }, { anthropic: anthropicProvider }, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(Object.values(off.routes).every((r) => r.refusalFallback === false)).toBe(true);
    const on = createModelRouter({ rows: [], refusalFallback: true }, { anthropic: anthropicProvider }, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(Object.values(on.routes).some((r) => 'refusalFallback' in r)).toBe(false);
  });
});

describe('anthropic acceptsSampling', () => {
  it('is true only for models that still take sampling parameters', () => {
    const older = [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-latest',
    ];
    for (const m of older) expect(acceptsSampling(m), m).toBe(true);
    const newer = [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-fable-5-1',
      'claude-haiku-5',
      'claude-test-triage',
    ];
    for (const m of newer) expect(acceptsSampling(m), m).toBe(false);
  });
});

describe('anthropic classify', () => {
  it('sends the schema as output_config.format with no tools or tool_choice, and parses the text answer', async () => {
    const { client, calls } = fakeClient([answer({ priority: 'p1' })]);
    const model = createAnthropicModel({ apiKey: FAKE_KEY, models, client });
    const result = await model.classify(classifyRequest);
    expect(calls[0]?.output_config).toEqual({ format: { type: 'json_schema', schema: { ...schema, additionalProperties: false } } });
    expect(calls[0]).not.toHaveProperty('tools');
    expect(calls[0]).not.toHaveProperty('tool_choice');
    expect(calls[0]).not.toHaveProperty('thinking');
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: '<ticket/>' }]);
    expect(result.value).toEqual({ priority: 'p1' });
    expect(result.model).toBe('anthropic/claude-test-triage');
  });

  it('makes optional properties nullable on the wire and strips the nulls from the answer', async () => {
    const { client, calls } = fakeClient([answer({ priority: 'p1', note: null })]);
    const withNote: JsonSchema = { ...schema, properties: { ...schema.properties, note: { type: 'string', maxLength: 10 } } };
    const result = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify({ ...classifyRequest, schema: withNote });
    expect(calls[0]?.output_config?.format?.schema).toEqual({
      type: 'object',
      properties: { priority: { type: 'string', enum: ['p1', 'p2'] }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['priority', 'note'],
      additionalProperties: false,
    });
    expect(result.value).toEqual({ priority: 'p1' });
  });

  it('wraps a non-object schema in an object and unwraps the answer', async () => {
    const { client, calls } = fakeClient([answer({ value: ['a', 'b'] })]);
    const arraySchema: JsonSchema = { type: 'array', items: { type: 'string' } };
    const result = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify({
      ...classifyRequest,
      schemaName: 'labels',
      schema: arraySchema,
    });
    expect(calls[0]?.output_config?.format?.schema).toEqual({
      type: 'object',
      properties: { value: arraySchema },
      required: ['value'],
      additionalProperties: false,
    });
    expect(result.value).toEqual(['a', 'b']);
  });

  it('throws ModelSchemaError before any call for a schema it cannot express', async () => {
    const { client, calls } = fakeClient([]);
    const open: JsonSchema = { type: 'object', properties: {}, additionalProperties: { type: 'string' } };
    await expect(
      createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify({ ...classifyRequest, schema: open }),
    ).rejects.toBeInstanceOf(ModelSchemaError);
    expect(calls).toHaveLength(0);
  });

  it('throws ModelOutputError when the answer is not JSON', async () => {
    const { client } = fakeClient([message([{ type: 'text', text: 'I think p1' }])]);
    const err = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify(classifyRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelOutputError);
    expect((err as ModelOutputError).raw).toBe('I think p1');
  });

  it('throws ModelOutputError for an answer cut off at max_tokens, without parsing it', async () => {
    const { client } = fakeClient([message([{ type: 'text', text: '{"priority": "p' }], { stop_reason: 'max_tokens' })]);
    const err = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify(classifyRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelOutputError);
    expect((err as Error).message).toMatch(/max_tokens/);
  });

  it('throws ModelRefusalError on a refusal, and withValidation does not retry it', async () => {
    const refusal = message([{ type: 'text', text: '{"priority":' }], {
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null },
    });
    const { client, calls } = fakeClient([refusal, answer({ priority: 'p1' })]);
    const port = withValidation(createAnthropicModel({ apiKey: FAKE_KEY, models, client }));
    const err = await port.classify(classifyRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect(err).toMatchObject({ category: null });
    expect(calls).toHaveLength(1);
  });

  it('is validated and retried once by withValidation', async () => {
    const { client, calls } = fakeClient([answer({ priority: 7 }), answer({ priority: 'p2' })]);
    const port = withValidation(createAnthropicModel({ apiKey: FAKE_KEY, models, client }));
    const result = await port.classify(classifyRequest);
    expect(result).toMatchObject({ value: { priority: 'p2' }, attempts: 2 });
    expect(calls[1]?.messages[0]?.content).toContain('<validation-error schema="triage_result">');
  });

  it('surfaces ModelValidationError after two bad answers', async () => {
    const { client } = fakeClient([answer({}), answer({})]);
    const port = withValidation(createAnthropicModel({ apiKey: FAKE_KEY, models, client }));
    await expect(port.classify(classifyRequest)).rejects.toBeInstanceOf(ModelValidationError);
  });
});

describe('anthropic vision', () => {
  const reading = {
    errorText: 'Total is required',
    surfaceSignals: { urlBar: 'app.example.test/checkout', chrome: 'web' },
    uiElements: ['Total', 'Pay'],
    environmentHint: 'staging',
    plainDescription: 'the total field is blank',
    sensitive: false,
  };
  const request = {
    task: 'vision' as const,
    system: 'read screenshots',
    prompt: '<images/>',
    images: [
      { mimeType: 'image/png' as const, data: 'AAAA', ref: 'file-1' },
      { mimeType: 'image/jpeg' as const, data: 'BBBB' },
    ],
  };

  it('sends native base64 image blocks then the prompt with a structured format, and parses ImageReadings in order', async () => {
    const second = {
      errorText: null,
      surfaceSignals: { urlBar: null, pageTitle: null, chrome: null },
      uiElements: [],
      environmentHint: null,
      plainDescription: 'a login page',
      sensitive: true,
    };
    const { client, calls } = fakeClient([answer({ readings: [reading, second] })]);
    const result = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).vision(request);
    expect(calls[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
          { type: 'text', text: '<images/>' },
        ],
      },
    ]);
    expect(calls[0]).not.toHaveProperty('tool_choice');
    expect(calls[0]).not.toHaveProperty('tools');
    const sent = calls[0]?.output_config?.format;
    expect(sent?.type).toBe('json_schema');
    expect(JSON.stringify(sent?.schema)).toContain('"additionalProperties":false');
    expect(result.readings).toEqual([reading, { surfaceSignals: {}, uiElements: [], plainDescription: 'a login page', sensitive: true }]);
  });

  it('throws ModelOutputError when the reading count differs from the image count', async () => {
    const { client } = fakeClient([answer({ readings: [reading] })]);
    await expect(createAnthropicModel({ apiKey: FAKE_KEY, models, client }).vision(request)).rejects.toBeInstanceOf(ModelOutputError);
  });

  it('throws ModelOutputError for a malformed reading', async () => {
    const bad = { ...reading, sensitive: 'no' };
    const { client } = fakeClient([answer({ readings: [bad, bad] })]);
    await expect(createAnthropicModel({ apiKey: FAKE_KEY, models, client }).vision(request)).rejects.toThrow(/sensitive/);
  });
});

describe('anthropic error mapping', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  const api = (status: number, h: Record<string, string> = {}) =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'boom' } }, 'boom', headers(h));

  it('maps 429 to ModelRateLimitError with retry-after seconds', () => {
    const err = mapAnthropicError(api(429, { 'retry-after': '12' }));
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect((err as ModelRateLimitError).retryAfterMs).toBe(12000);
  });

  it('prefers retry-after-ms, reads HTTP dates, and leaves it undefined when absent', () => {
    expect((mapAnthropicError(api(429, { 'retry-after-ms': '250' })) as ModelRateLimitError).retryAfterMs).toBe(250);
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const fromDate = (mapAnthropicError(api(429, { 'retry-after': soon })) as ModelRateLimitError).retryAfterMs;
    expect(fromDate).toBeGreaterThan(20_000);
    expect(fromDate).toBeLessThanOrEqual(30_000);
    expect((mapAnthropicError(api(429)) as ModelRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('maps 401 and 403 to ModelAuthError', () => {
    expect(mapAnthropicError(api(401))).toBeInstanceOf(ModelAuthError);
    expect(mapAnthropicError(api(403))).toBeInstanceOf(ModelAuthError);
  });

  it('maps 5xx, 529, and connection failures to ModelUnavailableError', () => {
    expect(mapAnthropicError(api(500))).toBeInstanceOf(ModelUnavailableError);
    expect(mapAnthropicError(api(529))).toBeInstanceOf(ModelUnavailableError);
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'down' }))).toBeInstanceOf(ModelUnavailableError);
  });

  it('keeps the original error as cause and maps other statuses to a plain ModelError', () => {
    const original = api(400);
    const mapped = mapAnthropicError(original);
    expect(mapped).not.toBeInstanceOf(ModelAuthError);
    expect(mapped.cause).toBe(original);
  });

  it('surfaces mapped errors from every operation', async () => {
    const { client } = fakeClient([api(401), api(429, { 'retry-after': '1' }), api(503)]);
    const model = createAnthropicModel({ apiKey: FAKE_KEY, models, client });
    await expect(model.complete({ task: 'triage', system: 's', prompt: 'p' })).rejects.toBeInstanceOf(ModelAuthError);
    await expect(model.classify(classifyRequest)).rejects.toBeInstanceOf(ModelRateLimitError);
    await expect(
      model.vision({ task: 'vision', system: 's', prompt: 'p', images: [{ mimeType: 'image/png', data: 'AA' }] }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe('anthropicProvider', () => {
  it('builds a backend for a route from the env key, and fails without one', () => {
    const route = { task: 'triage' as const, provider: 'anthropic' as const, model: 'claude-x', source: 'row' as const };
    expect(typeof anthropicProvider(route, { ANTHROPIC_API_KEY: FAKE_KEY }).classify).toBe('function');
    expect(() => anthropicProvider(route, {})).toThrow(ModelAuthError);
  });

  it('plugs into the router', () => {
    const router = createModelRouter({ rows: [] }, { anthropic: anthropicProvider }, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(router.routes.triage.provider).toBe('anthropic');
  });
});
