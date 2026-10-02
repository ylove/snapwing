import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  anthropicProvider,
  createAnthropicModel,
  mapAnthropicError,
  type AnthropicClientLike,
} from '../../src/models/anthropic/index.ts';
import {
  ModelAuthError,
  ModelOutputError,
  ModelRateLimitError,
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
    usage: { input_tokens: 11, output_tokens: 7 },
    ...extra,
  } as unknown as Anthropic.Message;
}

function fakeClient(replies: Array<Anthropic.Message | Error>) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AnthropicClientLike = {
    messages: {
      create: async (params) => {
        calls.push(params);
        const next = replies.shift();
        if (next === undefined) throw new Error('no reply queued');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, calls };
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
const toolUse = (name: string, input: unknown) => ({ type: 'tool_use', id: 'toolu_1', name, input });

describe('anthropic complete', () => {
  it('sends system, prompt, per-task model, and joins text blocks', async () => {
    const { client, calls } = fakeClient([message([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])]);
    const model = createAnthropicModel({ apiKey: FAKE_KEY, models, client });
    const result = await model.complete({ task: 'triage', system: 'be brief', prompt: 'hi', temperature: 0.2, maxTokens: 50 });
    expect(calls).toEqual([
      { model: 'claude-test-triage', max_tokens: 50, system: 'be brief', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] },
    ]);
    expect(result).toEqual({ text: 'hello world', model: 'anthropic/claude-test-triage', usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it('defaults max_tokens and omits temperature', async () => {
    const { client, calls } = fakeClient([message([{ type: 'text', text: 'x' }])]);
    await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).complete({ task: 'clarify', system: 's', prompt: 'p' });
    expect(calls[0]?.max_tokens).toBe(4096);
    expect(calls[0]).not.toHaveProperty('temperature');
    expect(calls[0]?.model).toBe(DEFAULT_MODELS.anthropic.clarify);
  });
});

describe('anthropic classify', () => {
  it('forces a single tool whose input schema is the request schema and returns the parsed input', async () => {
    const { client, calls } = fakeClient([message([toolUse('triage_result', { priority: 'p1' })])]);
    const model = createAnthropicModel({ apiKey: FAKE_KEY, models, client });
    const result = await model.classify(classifyRequest);
    expect(calls[0]?.tools).toEqual([{ name: 'triage_result', description: 'Answer using the triage_result schema.', input_schema: schema }]);
    expect(calls[0]?.tool_choice).toEqual({ type: 'tool', name: 'triage_result' });
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: '<ticket/>' }]);
    expect(result.value).toEqual({ priority: 'p1' });
    expect(result.model).toBe('anthropic/claude-test-triage');
  });

  it('wraps a non-object schema in an object and unwraps the answer', async () => {
    const { client, calls } = fakeClient([message([toolUse('labels', { value: ['a', 'b'] })])]);
    const arraySchema: JsonSchema = { type: 'array', items: { type: 'string' } };
    const result = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify({
      ...classifyRequest,
      schemaName: 'labels',
      schema: arraySchema,
    });
    expect(calls[0]?.tools?.[0]).toMatchObject({
      input_schema: { type: 'object', properties: { value: arraySchema }, required: ['value'] },
    });
    expect(result.value).toEqual(['a', 'b']);
  });

  it('sanitises the schema name into a legal tool name', async () => {
    const { client, calls } = fakeClient([message([toolUse('triage_v1_result', { priority: 'p2' })])]);
    await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify({ ...classifyRequest, schemaName: 'triage.v1 result' });
    expect(calls[0]?.tool_choice).toEqual({ type: 'tool', name: 'triage_v1_result' });
  });

  it('throws ModelOutputError when the model returns no tool call', async () => {
    const { client } = fakeClient([message([{ type: 'text', text: 'I think p1' }])]);
    const err = await createAnthropicModel({ apiKey: FAKE_KEY, models, client }).classify(classifyRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelOutputError);
    expect((err as ModelOutputError).raw).toBe('I think p1');
  });

  it('is validated and retried once by withValidation', async () => {
    const { client, calls } = fakeClient([
      message([toolUse('triage_result', { priority: 7 })]),
      message([toolUse('triage_result', { priority: 'p2' })]),
    ]);
    const port = withValidation(createAnthropicModel({ apiKey: FAKE_KEY, models, client }));
    const result = await port.classify(classifyRequest);
    expect(result).toMatchObject({ value: { priority: 'p2' }, attempts: 2 });
    expect(calls[1]?.messages[0]?.content).toContain('<validation-error schema="triage_result">');
  });

  it('surfaces ModelValidationError after two bad answers', async () => {
    const { client } = fakeClient([message([toolUse('triage_result', {})]), message([toolUse('triage_result', {})])]);
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

  it('sends native base64 image blocks then the prompt, and parses ImageReadings in order', async () => {
    const second = { surfaceSignals: {}, uiElements: [], plainDescription: 'a login page', sensitive: true };
    const { client, calls } = fakeClient([message([toolUse('report_image_readings', { readings: [reading, second] })])]);
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
    expect(calls[0]?.tool_choice).toEqual({ type: 'tool', name: 'report_image_readings' });
    expect(result.readings).toEqual([reading, second]);
  });

  it('throws ModelOutputError when the reading count differs from the image count', async () => {
    const { client } = fakeClient([message([toolUse('report_image_readings', { readings: [reading] })])]);
    await expect(createAnthropicModel({ apiKey: FAKE_KEY, models, client }).vision(request)).rejects.toBeInstanceOf(ModelOutputError);
  });

  it('throws ModelOutputError for a malformed reading', async () => {
    const bad = { ...reading, sensitive: 'no' };
    const { client } = fakeClient([message([toolUse('report_image_readings', { readings: [bad, bad] })])]);
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
