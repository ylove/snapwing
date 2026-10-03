// Anthropic request shape per model family (#275), through the real SDK and the router on MSW.
// Opus 5.5 and Sonnet 5.5 reject a forced tool_choice, `thinking: {type: "disabled"}`, and sampling
// parameters with a 400, so classify and vision use structured outputs on every model. On those two
// the request also carries server-side refusal fallback (#281): the beta endpoint, the
// `server-side-fallback-2026-07-01` header and `fallbacks: "default"`, unless the config turns it off.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { loadAppConfig } from '../../../src/config/app-config.ts';
import { anthropicProvider, REFUSAL_FALLBACK_BETA } from '../../../src/models/anthropic/index.ts';
import { ModelRefusalError, ModelValidationError } from '../../../src/models/errors.ts';
import { createModelRouter, MODEL_TASK_LIST } from '../../../src/models/router.ts';
import { classification, imageData, request } from './model-port-suite.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
function fixture(name: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(new URL(`../../fixtures/models/anthropic/${name}.json`, import.meta.url), 'utf8')) as unknown);
}

// Anything but the replayed endpoint fails as a network error.
const server = setupServer(http.all('*', () => HttpResponse.error()));
let requests: Record<string, unknown>[];
let sent: Array<{ url: string; beta: string | null }>;
beforeAll(() => server.listen());
beforeEach(() => { requests = []; sent = []; });
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function replay(names: string[]): void {
  server.use(http.post(ENDPOINT, async ({ request }) => {
    requests.push(object(await request.json()));
    sent.push({ url: request.url, beta: request.headers.get('anthropic-beta') });
    const name = names[requests.length - 1];
    if (name === undefined) return HttpResponse.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Fixture sequence exhausted' } }, { status: 400 });
    return HttpResponse.json(fixture(name));
  }));
}

function port(model: string, temperature?: number, refusalFallback?: boolean) {
  return createModelRouter(
    {
      defaultProvider: 'anthropic',
      rows: MODEL_TASK_LIST.map((task) => ({ task, provider: 'anthropic' as const, name: model, ...(temperature === undefined ? {} : { temperature }) })),
      ...(refusalFallback === undefined ? {} : { refusalFallback }),
    },
    { anthropic: anthropicProvider },
    { ANTHROPIC_API_KEY: 'sk-test-fake' },
  );
}

const visionRequest = {
  task: 'vision' as const,
  system: '<system>Read the screenshot.</system>',
  prompt: '<request>Describe the image.</request>',
  temperature: 0,
  images: [{ mimeType: 'image/png' as const, data: imageData }],
};

function expectStructured(body: Record<string, unknown>): void {
  expect(body).not.toHaveProperty('tool_choice');
  expect(body).not.toHaveProperty('tools');
  const format = object(object(body['output_config'])['format']);
  expect(format['type']).toBe('json_schema');
  expect(object(format['schema'])['additionalProperties']).toBe(false);
}

/** The beta endpoint with the fallback header and `fallbacks: "default"`, or the plain endpoint with neither. */
function expectFallback(index: number, on: boolean): void {
  const body = object(requests[index]);
  const call = sent[index];
  if (on) {
    expect(body['fallbacks']).toBe('default');
    expect(call?.beta?.split(',').map((b) => b.trim())).toContain(REFUSAL_FALLBACK_BETA);
    expect(call?.url).toMatch(/[?&]beta=true\b/);
  } else {
    expect(body).not.toHaveProperty('fallbacks');
    expect(body).not.toHaveProperty('betas');
    expect(call?.beta ?? '').not.toMatch(/server-side-fallback/);
    expect(call?.url).not.toMatch(/beta=true/);
  }
}

describe.each([
  { model: 'claude-sonnet-5-5', sampling: false, fallback: true },
  { model: 'claude-opus-5-5', sampling: false, fallback: true },
  { model: 'claude-haiku-4-5', sampling: true, fallback: false },
])('anthropic request shape on $model', ({ model, sampling, fallback }) => {
  it('classify sends structured outputs, no forced tool, and only the sampling and thinking fields the model takes', async () => {
    replay(['valid']);
    // The row sets a temperature, so the router passes it on; the adapter still withholds it from models that reject it.
    const result = await port(model, 0).classify({ ...classification, temperature: 0 });
    expect(result).toMatchObject({ value: { label: 'bug' }, attempts: 1 });
    expect(requests).toHaveLength(1);
    const body = object(requests[0]);
    expect(body['model']).toBe(model);
    expectStructured(body);
    expect(body).not.toHaveProperty('thinking');
    expectFallback(0, fallback);
    if (sampling) {
      expect(body['temperature']).toBe(0);
      expect(body['max_tokens']).toBe(classification.maxTokens);
    } else {
      expect(body).not.toHaveProperty('temperature');
      expect(body['max_tokens']).toBeGreaterThanOrEqual(16000);
    }
  });

  it('vision sends the image blocks with the same structured format', async () => {
    replay(['vision']);
    const result = await port(model, 0).vision(visionRequest);
    expect(result.readings).toEqual([{ surfaceSignals: {}, uiElements: [], plainDescription: 'A white square.', sensitive: false }]);
    const body = object(requests[0]);
    expectStructured(body);
    expect(body).not.toHaveProperty('thinking');
    if (!sampling) expect(body).not.toHaveProperty('temperature');
    expect(JSON.stringify(body['messages'])).toContain(imageData);
    expectFallback(0, fallback);
  });

  it('complete carries the same fallback setting', async () => {
    replay(['complete']);
    await port(model).complete(request);
    expectFallback(0, fallback);
  });
});

describe('anthropic sampling through the router', () => {
  it('drops a stage temperature when the row sets none, even on a model that takes sampling', async () => {
    replay(['valid']);
    await port('claude-haiku-4-5').classify({ ...classification, temperature: 0 });
    expect(object(requests[0])).not.toHaveProperty('temperature');
  });
});

describe('anthropic refusal fallback', () => {
  it('parses an answer a fallback model served and records that model', async () => {
    replay(['fallback-served']);
    const result = await port('claude-opus-5-5').classify(classification);
    expect(result).toMatchObject({ value: { label: 'bug' }, attempts: 1, model: 'anthropic/claude-opus-4-8' });
    expect(result.usage).toEqual({ inputTokens: 29, outputTokens: 9 });
    expect(requests).toHaveLength(1);
    expectFallback(0, true);
  });

  it('records the fallback model on a sticky turn, which carries no fallback block', async () => {
    replay(['fallback-sticky']);
    const result = await port('claude-sonnet-5-5').classify(classification);
    expect(result).toMatchObject({ value: { label: 'bug' }, model: 'anthropic/claude-sonnet-5' });
  });

  it('names the requested model when no fallback ran', async () => {
    replay(['valid']);
    await expect(port('claude-sonnet-5-5').classify(classification)).resolves.toMatchObject({ model: 'anthropic/claude-sonnet-5-5' });
  });

  it('throws ModelRefusalError when the whole chain refused, without retrying', async () => {
    replay(['fallback-chain-refusal', 'valid']);
    const result = port('claude-opus-5-5').classify(classification);
    await expect(result).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(result).rejects.toMatchObject({ category: 'cyber', message: expect.stringContaining('claude-opus-4-8') });
    expect(requests).toHaveLength(1);
  });

  it('is off with refusal-fallback="off": plain endpoint, no header, no field, and a refusal is ModelRefusalError', async () => {
    replay(['valid', 'refusal']);
    await port('claude-opus-5-5', undefined, false).classify(classification);
    expectFallback(0, false);
    await expect(port('claude-sonnet-5-5', undefined, false).classify(classification)).rejects.toBeInstanceOf(ModelRefusalError);
    expectFallback(1, false);
  });

  it('follows the loaded config: on by default, off when the XML says so', async () => {
    const xml = (attr: string) =>
      `<snapwing xmlns="urn:snapwing:config:v1" version="1"><runtime provider="local"/>` +
      `<models default-provider="anthropic"${attr}><model task="triage" provider="anthropic" name="claude-opus-5-5"/></models>` +
      `<harness fixer="claude-code" review="claude-code"/></snapwing>`;
    for (const [attr, on] of [['', true], [' refusal-fallback="on"', true], [' refusal-fallback="off"', false]] as const) {
      requests = [];
      sent = [];
      replay(['valid']);
      const config = loadAppConfig(xml(attr));
      await createModelRouter(config.models, { anthropic: anthropicProvider }, { ANTHROPIC_API_KEY: 'sk-test-fake' }).classify(classification);
      expectFallback(0, on);
    }
  });
});

describe('anthropic stop reasons', () => {
  it('maps a refusal to ModelRefusalError without parsing or retrying it', async () => {
    replay(['refusal', 'valid']);
    const result = port('claude-sonnet-5-5').classify(classification);
    await expect(result).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(result).rejects.toMatchObject({ category: 'cyber' });
    expect(requests).toHaveLength(1);
  });

  it('treats a max_tokens cut-off as unparseable output: retried once, then ModelValidationError', async () => {
    replay(['max-tokens', 'max-tokens']);
    const result = port('claude-opus-5-5').classify(classification);
    await expect(result).rejects.toBeInstanceOf(ModelValidationError);
    await expect(result).rejects.toMatchObject({ reason: expect.stringMatching(/max_tokens/) });
    expect(requests).toHaveLength(2);
  });

  it('recovers when the retry after a cut-off answers in full', async () => {
    replay(['max-tokens', 'valid']);
    await expect(port('claude-opus-5-5').classify(classification)).resolves.toMatchObject({ value: { label: 'bug' }, attempts: 2 });
  });
});
