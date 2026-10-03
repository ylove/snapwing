// Sampling on the OpenAI defaults (#275): gpt-5 and gpt-5-mini answer any non-default `temperature` with a
// 400, and the stages ask for `temperature: 0`. The router sends a temperature only when the task's <model>
// row sets one. Real SDK through the router, on MSW.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { openaiProvider } from '../../../src/models/openai/index.ts';
import { createModelRouter, MODEL_TASK_LIST } from '../../../src/models/router.ts';
import { classification, request } from './model-port-suite.ts';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
function fixture(name: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(new URL(`../../fixtures/models/openai/${name}.json`, import.meta.url), 'utf8')) as unknown);
}

// Anything but the replayed endpoint fails as a network error.
const server = setupServer(http.all('*', () => HttpResponse.error()));
let requests: Record<string, unknown>[];
beforeAll(() => server.listen());
beforeEach(() => { requests = []; });
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function replay(names: string[]): void {
  server.use(http.post(ENDPOINT, async ({ request: incoming }) => {
    requests.push(object(await incoming.json()));
    const name = names[requests.length - 1];
    if (name === undefined) return HttpResponse.json({ error: { message: 'Fixture sequence exhausted' } }, { status: 400 });
    return HttpResponse.json(fixture(name));
  }));
}

function port(model: string, temperature?: number) {
  return createModelRouter(
    {
      defaultProvider: 'openai',
      rows: MODEL_TASK_LIST.map((task) => ({ task, provider: 'openai' as const, name: model, ...(temperature === undefined ? {} : { temperature }) })),
    },
    { openai: openaiProvider },
    { OPENAI_API_KEY: 'sk-test-fake' },
  );
}

describe.each(['gpt-5', 'gpt-5-mini'])('openai sampling on %s', (model) => {
  it('complete sends no temperature although the stage asks for 0', async () => {
    replay(['complete']);
    await port(model).complete({ ...request, temperature: 0 });
    expect(object(requests[0])['model']).toBe(model);
    expect(object(requests[0])).not.toHaveProperty('temperature');
  });

  it('classify sends no temperature on the first attempt or the retry', async () => {
    replay(['invalid', 'valid']);
    const result = await port(model).classify({ ...classification, temperature: 0 });
    expect(result.attempts).toBe(2);
    expect(requests).toHaveLength(2);
    for (const body of requests) expect(body).not.toHaveProperty('temperature');
  });
});

describe('openai sampling from config', () => {
  it('sends the temperature a <model> row sets, instead of the stage value', async () => {
    replay(['complete']);
    await port('gpt-4.1', 0.3).complete({ ...request, temperature: 0 });
    expect(object(requests[0])['temperature']).toBe(0.3);
  });
});
