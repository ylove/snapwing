import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ModelAuthError, ModelError, ModelRateLimitError, ModelUnavailableError } from '../../../src/models/errors.ts';
import { classification, imageData, modelPortContract, request } from './model-port-suite.ts';
import type { Scenario } from './model-port-suite.ts';
import { models, port, providers } from './providers.ts';
import type { Provider } from './providers.ts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected JSON array');
  return value;
}
function fixture(provider: Provider, name: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(new URL(`../../fixtures/models/${provider}/${name}.json`, import.meta.url), 'utf8')) as unknown);
}
const endpoints = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  google: `https://generativelanguage.googleapis.com/v1beta/models/${models.google}:generateContent`,
};
let blockedRequests = 0;
const server = setupServer(http.all('*', () => {
  blockedRequests += 1;
  return HttpResponse.error();
}));
beforeAll(() => server.listen());
beforeEach(() => { blockedRequests = 0; });
afterEach(() => {
  server.resetHandlers();
  expect(blockedRequests, 'All HTTP requests must match a recording').toBe(0);
});
afterAll(() => server.close());

for (const provider of providers) {
  describe(`${provider} ModelPort recorded HTTP contract`, () => {
    let requests: Record<string, unknown>[];
    let unexpected: string[];
    beforeEach(() => { requests = []; unexpected = []; });
    afterEach(() => expect(unexpected).toEqual([]));

    function replay(names: string[], status = 200) {
      server.use(http.post(endpoints[provider], async ({ request: incoming }) => {
        requests.push(object(await incoming.json()));
        const name = names[requests.length - 1] ?? (status !== 200 ? names[0] : undefined);
        if (!name) {
          unexpected.push('Unexpected extra provider request');
          return HttpResponse.json({ error: 'Fixture sequence exhausted' }, { status: 400 });
        }
        return HttpResponse.json(fixture(provider, name), { status, headers: status === 429 ? { 'retry-after': '1' } : {} });
      }));
    }
    function parts(): unknown[] {
      const body = requests[0];
      if (!body) throw new Error('Expected a request');
      if (provider === 'google') return array(object(array(body['contents'])[0])['parts']);
      const messages = array(body['messages']).map(object);
      const user = messages.find((message) => message['role'] === 'user');
      return array(user?.['content']);
    }
    function schema(): Record<string, unknown> {
      const body = object(requests[0]);
      if (provider === 'anthropic') return object(object(object(body['output_config'])['format'])['schema']);
      if (provider === 'openai') return object(object(object(body['response_format'])['json_schema'])['schema']);
      return object(object(body['generationConfig'])['responseSchema']);
    }
    modelPortContract({
      create: () => port(provider, 'sk-test-fake'),
      prepare: (scenario: Scenario) => replay(scenario === 'retry' ? ['invalid', 'valid'] : scenario === 'invalid' ? ['invalid', 'invalid'] : [scenario]),
      assertRequests: (count, scenario) => {
        expect(requests).toHaveLength(count);
        if (scenario === 'retry' || scenario === 'invalid') {
          expect(JSON.stringify(requests[0])).not.toContain('<validation-error');
          expect(JSON.stringify(requests[1])).toContain('<validation-error');
          expect(JSON.stringify(requests[1])).toContain('contract_label');
          expect(JSON.stringify(requests[1])).toContain('previous-answer');
        }
      },
      assertVision: () => {
        const expected = provider === 'anthropic'
          ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } }
          : provider === 'openai'
            ? { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } }
            : { inlineData: { mimeType: 'image/png', data: imageData } };
        expect(parts()).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
        expect(JSON.stringify(requests)).not.toContain('private-test-image-ref');
      },
    });

    for (const [status, ErrorType] of [[429, ModelRateLimitError], [401, ModelAuthError], [503, ModelUnavailableError]] as const) {
      it(`maps HTTP ${status} to ${ErrorType.name}`, async () => {
        replay([`error-${status}`], status);
        const result = port(provider, 'sk-test-fake').complete(request);
        await expect(result).rejects.toBeInstanceOf(ErrorType);
        if (status === 429) await expect(result).rejects.toMatchObject({ retryAfterMs: 1000 });
        expect(requests.length).toBeGreaterThanOrEqual(1);
      }, 20000);
    }

    it('handles an optional field without sending an incompatible schema', async () => {
      replay(['optional']);
      const result = await port(provider, 'sk-test-fake').classify({ ...classification,
        schema: { type: 'object', properties: { label: { type: 'string', enum: ['bug'] }, note: { type: 'string' } }, required: ['label'] },
      }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ModelError);
        expect((result.error as Error).message).toMatch(/schema|optional|required|additionalProperties/i);
        expect(requests).toHaveLength(0);
        return;
      }
      expect(result.value.value).toMatchObject({ label: 'bug' });
      expect(requests).toHaveLength(1);
      const sent = schema();
      if (provider === 'openai' || provider === 'anthropic') {
        expect(sent['additionalProperties']).toBe(false);
        expect(sent['required']).toEqual(expect.arrayContaining(['label', 'note']));
        const note = object(object(sent['properties'])['note']);
        const nullable = Array.isArray(note['type']) && note['type'].includes('null') ||
          Array.isArray(note['anyOf']) && note['anyOf'].some((entry: unknown) => object(entry)['type'] === 'null');
        expect(nullable).toBe(true);
        if (provider === 'openai') {
          expect(object(object(requests[0])['response_format'])).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
        } else {
          expect(object(object(requests[0])['output_config'])).toMatchObject({ format: { type: 'json_schema' } });
        }
      } else {
        // Gemini responseSchema allows omitted optional properties.
        expect(object(sent['properties'])).toHaveProperty('note');
        expect(sent['required']).toEqual(['label']);
      }
    });
  });
}
