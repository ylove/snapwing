// Anthropic request shape per model family (#275), through the real SDK and the router on MSW.
// Opus 5.5 and Sonnet 5.5 reject a forced tool_choice, `thinking: {type: "disabled"}`, and sampling
// parameters with a 400, so classify and vision use structured outputs on every model.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { anthropicProvider } from '../../../src/models/anthropic/index.ts';
import { ModelRefusalError, ModelValidationError } from '../../../src/models/errors.ts';
import { createModelRouter, MODEL_TASK_LIST } from '../../../src/models/router.ts';
import { classification, imageData } from './model-port-suite.ts';

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
beforeAll(() => server.listen());
beforeEach(() => { requests = []; });
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function replay(names: string[]): void {
  server.use(http.post(ENDPOINT, async ({ request }) => {
    requests.push(object(await request.json()));
    const name = names[requests.length - 1];
    if (name === undefined) return HttpResponse.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Fixture sequence exhausted' } }, { status: 400 });
    return HttpResponse.json(fixture(name));
  }));
}

function port(model: string, temperature?: number) {
  return createModelRouter(
    {
      defaultProvider: 'anthropic',
      rows: MODEL_TASK_LIST.map((task) => ({ task, provider: 'anthropic' as const, name: model, ...(temperature === undefined ? {} : { temperature }) })),
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

describe.each([
  { model: 'claude-sonnet-5-5', sampling: false },
  { model: 'claude-opus-5-5', sampling: false },
  { model: 'claude-haiku-4-5', sampling: true },
])('anthropic request shape on $model', ({ model, sampling }) => {
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
  });
});

describe('anthropic sampling through the router', () => {
  it('drops a stage temperature when the row sets none, even on a model that takes sampling', async () => {
    replay(['valid']);
    await port('claude-haiku-4-5').classify({ ...classification, temperature: 0 });
    expect(object(requests[0])).not.toHaveProperty('temperature');
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
