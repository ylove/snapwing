import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelProvider, ModelRow, ModelsConfig } from '../../src/config/app-config.ts';
import { ModelOutputError, ModelRoutingError, ModelValidationError } from '../../src/models/errors.ts';
import { MockModel, mockModelProvider, writeMockFixture } from '../../src/models/mock.ts';
import {
  DEFAULT_MODELS,
  MODEL_TASK_LIST,
  appendValidationError,
  createModelRouter,
  providerFromEnv,
  resolveModelRoutes,
  withValidation,
  type ModelProviders,
  type ModelRoute,
} from '../../src/models/router.ts';
import type {
  ClassifyRequest,
  CompletionRequest,
  ModelBackend,
  ModelTask,
  RawClassifyResult,
} from '../../src/ports/model.ts';

// Obvious fakes only.
const KEYS = { ANTHROPIC_API_KEY: 'fake-anthropic-key', OPENAI_API_KEY: 'fake-openai-key', GOOGLE_API_KEY: 'fake-google-key' };

/** A backend that answers `complete` with its route, so a test can see where a request landed. */
function echoProviders(built: ModelRoute[] = []): ModelProviders {
  const factory = (route: ModelRoute): ModelBackend => {
    built.push(route);
    const meta = { model: `${route.provider}/${route.model}` };
    return {
      complete: (r) => Promise.resolve({ text: `${route.provider}:${route.model}:${r.task}`, ...meta }),
      vision: () => Promise.resolve({ readings: [], ...meta }),
      classify: () => Promise.resolve({ value: { provider: route.provider }, ...meta }),
    };
  };
  return { anthropic: factory, openai: factory, google: factory };
}

const req = (task: ModelTask): CompletionRequest => ({ task, system: 's', prompt: 'p' });

const SPEC_ROWS: ModelRow[] = [
  { task: 'triage', provider: 'anthropic', name: 'claude-sonnet-5-5' },
  { task: 'segmentation', provider: 'anthropic', name: 'claude-haiku-4-5' },
  { task: 'vision', provider: 'openai', name: 'gpt-5' },
  { task: 'clarify', provider: 'anthropic', name: 'claude-haiku-4-5' },
  { task: 'scout', provider: 'anthropic', name: 'claude-opus-5-5' },
  { task: 'review', provider: 'google', name: 'gemini-2.5-pro' },
];

describe('sampling: a temperature only from the <model> row', () => {
  function recording() {
    const seen: Array<number | undefined> = [];
    const factory = (route: ModelRoute): ModelBackend => ({
      complete: (r) => (seen.push(r.temperature), Promise.resolve({ text: 'x', model: route.model })),
      vision: (r) => (seen.push(r.temperature), Promise.resolve({ readings: [], model: route.model })),
      classify: (r) => (seen.push(r.temperature), Promise.resolve({ value: { ok: true }, model: route.model })),
    });
    return { seen, providers: { anthropic: factory, openai: factory, google: factory } satisfies ModelProviders };
  }
  const rows: ModelRow[] = [{ task: 'triage', provider: 'openai', name: 'gpt-5' }, { task: 'clarify', provider: 'openai', name: 'gpt-4.1', temperature: 0.3 }];

  it('drops the stage temperature when the row sets none, and sends the row value when it does', async () => {
    const { seen, providers } = recording();
    const router = createModelRouter({ defaultProvider: 'openai', rows }, providers, KEYS);
    expect(router.routes.triage).not.toHaveProperty('temperature');
    expect(router.routes.clarify.temperature).toBe(0.3);
    await router.complete({ ...req('triage'), temperature: 0 });
    await router.vision({ ...req('triage'), temperature: 0, images: [] });
    await router.classify({ ...req('triage'), temperature: 0, schemaName: 's', schema: { type: 'object' }, validate: (v): v is unknown => v !== undefined });
    await router.complete({ ...req('clarify'), temperature: 0 });
    await router.complete(req('clarify'));
    await router.complete({ ...req('segmentation'), temperature: 1 });
    expect(seen).toEqual([undefined, undefined, undefined, 0.3, 0.3, undefined]);
  });
});

describe('routing table: every task has a row (main 14.5 example)', () => {
  const config: ModelsConfig = { defaultProvider: 'anthropic', rows: SPEC_ROWS };

  it.each(SPEC_ROWS.map((r) => [r.task, r.provider, r.name] as const))('%s goes to %s/%s', async (task, provider, name) => {
    const router = createModelRouter(config, echoProviders(), {});
    expect(router.routes[task]).toEqual({ task, provider, model: name, source: 'row' });
    await expect(router.complete(req(task))).resolves.toEqual({ text: `${provider}:${name}:${task}`, model: `${provider}/${name}` });
  });

  it('covers all six tasks', () => {
    expect(new Set(SPEC_ROWS.map((r) => r.task))).toEqual(new Set(MODEL_TASK_LIST));
    expect(MODEL_TASK_LIST).toHaveLength(6);
  });

  it('needs no key when every task has a row and there is no default', () => {
    const routes = resolveModelRoutes({ rows: SPEC_ROWS }, {});
    expect(Object.values(routes).every((r) => r.source === 'row')).toBe(true);
  });

  it('dispatches vision and classify by task as well', async () => {
    const router = createModelRouter(config, echoProviders(), {});
    await expect(router.vision({ ...req('vision'), images: [] })).resolves.toEqual({ readings: [], model: 'openai/gpt-5' });
    const isAny = (v: unknown): v is { provider: ModelProvider } => typeof v === 'object' && v !== null;
    const result = await router.classify({ ...req('review'), schemaName: 'verdict', schema: { type: 'object' }, validate: isAny });
    expect(result).toEqual({ value: { provider: 'google' }, model: 'google/gemini-2.5-pro', attempts: 1 });
  });
});

describe('routing table: missing rows', () => {
  it('uses defaultProvider with its default model for each task without a row', () => {
    const rows: ModelRow[] = [{ task: 'vision', provider: 'openai', name: 'gpt-5' }];
    const routes = resolveModelRoutes({ defaultProvider: 'google', rows }, KEYS);
    expect(routes.vision).toEqual({ task: 'vision', provider: 'openai', model: 'gpt-5', source: 'row' });
    for (const task of MODEL_TASK_LIST.filter((t) => t !== 'vision')) {
      expect(routes[task]).toEqual({ task, provider: 'google', model: DEFAULT_MODELS.google[task], source: 'default-provider' });
    }
  });

  it('the configured default wins over env key order', () => {
    const routes = resolveModelRoutes({ defaultProvider: 'openai', rows: [] }, KEYS);
    expect(routes.triage.provider).toBe('openai');
  });

  it('every provider has a default model for every task', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      for (const task of MODEL_TASK_LIST) expect(DEFAULT_MODELS[provider][task]).toMatch(/\S/);
    }
  });
});

describe('routing table: no configured default (ADR 0002 key order)', () => {
  const cases: Array<[string, Record<string, string>, ModelProvider]> = [
    ['all three keys', KEYS, 'anthropic'],
    ['openai and google', { OPENAI_API_KEY: 'fake-openai-key', GOOGLE_API_KEY: 'fake-google-key' }, 'openai'],
    ['google only', { GOOGLE_API_KEY: 'fake-google-key' }, 'google'],
    ['empty anthropic key is ignored', { ANTHROPIC_API_KEY: '  ', GOOGLE_API_KEY: 'fake-google-key' }, 'google'],
  ];

  it.each(cases)('%s picks %s', (_name, env, expected) => {
    expect(providerFromEnv(env)).toBe(expected);
    const routes = resolveModelRoutes({ rows: [{ task: 'scout', provider: 'anthropic', name: 'claude-opus-5-5' }] }, env);
    expect(routes.scout.source).toBe('row');
    expect(routes.triage).toEqual({ task: 'triage', provider: expected, model: DEFAULT_MODELS[expected].triage, source: 'env-key' });
  });

  it('throws ModelRoutingError naming the uncovered tasks and the key names when no key is set', () => {
    const rows: ModelRow[] = [{ task: 'triage', provider: 'anthropic', name: 'claude-sonnet-5-5' }];
    expect(() => createModelRouter({ rows }, echoProviders(), {})).toThrow(ModelRoutingError);
    expect(() => resolveModelRoutes({ rows }, {})).toThrow(
      /segmentation, vision, clarify, scout, review.*ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY/,
    );
  });
});

describe('createModelRouter boot checks and adapter lifecycle', () => {
  it('fails at creation when a routed provider has no adapter', () => {
    const providers = echoProviders();
    delete providers.google;
    expect(() => createModelRouter({ defaultProvider: 'anthropic', rows: SPEC_ROWS }, providers, {})).toThrow(
      /no adapter registered for provider google \(needed by review\)/,
    );
  });

  it('rejects duplicate rows for a task', () => {
    const rows: ModelRow[] = [SPEC_ROWS[0]!, SPEC_ROWS[0]!];
    expect(() => resolveModelRoutes({ rows }, KEYS)).toThrow(/more than one <model> row/);
  });

  it('builds each adapter lazily, once per task, and hands it the env', async () => {
    const built: ModelRoute[] = [];
    const envSeen: unknown[] = [];
    const providers = echoProviders(built);
    const inner = providers.anthropic!;
    providers.anthropic = (route, env) => {
      envSeen.push(env);
      return inner(route, env);
    };
    const router = createModelRouter({ defaultProvider: 'anthropic', rows: [] }, providers, KEYS);
    expect(built).toHaveLength(0);
    await router.complete(req('triage'));
    await router.complete(req('triage'));
    await router.complete(req('clarify'));
    expect(built.map((r) => r.task)).toEqual(['triage', 'clarify']);
    expect(envSeen[0]).toBe(KEYS);
  });

  it('rejects a task outside the six at call time', async () => {
    const router = createModelRouter({ defaultProvider: 'anthropic', rows: [] }, echoProviders(), {});
    await expect(router.complete({ task: 'poetry' as ModelTask, system: 's', prompt: 'p' })).rejects.toThrow(ModelRoutingError);
  });
});

// The classify contract, exercised through recorded mock fixtures: the retry prompt has a different
// sha256, so the first answer and the retry answer are two recordings.
interface Plan {
  priority: 'P1' | 'P2' | 'P3';
}
const isPlan = (v: unknown): v is Plan =>
  typeof v === 'object' && v !== null && ['P1', 'P2', 'P3'].includes((v as { priority?: unknown }).priority as string);

const planReq: ClassifyRequest<Plan> = {
  task: 'triage',
  system: 'You triage incidents.',
  prompt: '<incident>checkout total is blank</incident>',
  schemaName: 'triage-plan',
  schema: { type: 'object', properties: { priority: { type: 'string', enum: ['P1', 'P2', 'P3'] } }, required: ['priority'] },
  validate: isPlan,
};

describe('withValidation: retry once, then ModelValidationError', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snapwing-router-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a first valid answer with attempts 1 and no retry', async () => {
    await writeMockFixture(dir, planReq, { value: { priority: 'P2' } });
    const mock = new MockModel({ fixturesDir: dir });
    await expect(withValidation(mock).classify(planReq)).resolves.toMatchObject({ value: { priority: 'P2' }, attempts: 1 });
    expect(mock.calls).toHaveLength(1);
  });

  it('retries once with the validation error appended and returns the valid retry', async () => {
    const bad = { priority: 'urgent' };
    await writeMockFixture(dir, planReq, { value: bad });
    const retryPrompt = appendValidationError(planReq, { value: bad, reason: 'the value does not match schema "triage-plan"' });
    expect(retryPrompt.startsWith(planReq.prompt)).toBe(true);
    expect(retryPrompt).toContain('<validation-error schema="triage-plan">');
    expect(retryPrompt).toContain('{&quot;priority&quot;:&quot;urgent&quot;}');
    await writeMockFixture(dir, { ...planReq, prompt: retryPrompt }, { value: { priority: 'P1' } });

    const mock = new MockModel({ fixturesDir: dir });
    await expect(withValidation(mock).classify(planReq)).resolves.toMatchObject({ value: { priority: 'P1' }, attempts: 2 });
    expect(mock.calls).toHaveLength(2);
  });

  it('throws ModelValidationError when the retry fails too', async () => {
    const bad = { priority: 'urgent' };
    await writeMockFixture(dir, planReq, { value: bad });
    const retryPrompt = appendValidationError(planReq, { value: bad, reason: 'the value does not match schema "triage-plan"' });
    await writeMockFixture(dir, { ...planReq, prompt: retryPrompt }, { value: { priority: 'P9' } });

    const err = await withValidation(new MockModel({ fixturesDir: dir })).classify(planReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelValidationError);
    const v = err as ModelValidationError;
    expect(v).toMatchObject({ task: 'triage', schemaName: 'triage-plan', attempts: 2, lastValue: { priority: 'P9' } });
    expect(v.message).toContain('failed schema "triage-plan" after 2 attempts');
  });

  it('applies the same contract to every provider behind the router', async () => {
    await writeMockFixture(dir, planReq, { value: 'not an object' });
    const retryPrompt = appendValidationError(planReq, { value: 'not an object', reason: 'the value does not match schema "triage-plan"' });
    await writeMockFixture(dir, { ...planReq, prompt: retryPrompt }, { value: null });
    const providers: ModelProviders = { anthropic: mockModelProvider(dir), openai: mockModelProvider(dir), google: mockModelProvider(dir) };
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const router = createModelRouter({ defaultProvider: provider, rows: [] }, providers, {});
      await expect(router.classify(planReq)).rejects.toThrow(ModelValidationError);
    }
  });

  it('uses Ajv-style validator errors as the reason when the validator exposes them', async () => {
    const calls: string[] = [];
    const validate = Object.assign((v: unknown): v is Plan => isPlan(v), { errors: [{ instancePath: '/priority', message: 'must be equal to one of the allowed values' }] });
    const backend: ModelBackend = {
      complete: () => Promise.reject(new Error('unused')),
      vision: () => Promise.reject(new Error('unused')),
      classify: (r): Promise<RawClassifyResult> => {
        calls.push(r.prompt);
        return Promise.resolve({ value: { priority: 'urgent' }, model: 'fake/model' });
      },
    };
    const err = await withValidation(backend).classify({ ...planReq, validate }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelValidationError);
    expect(calls[1]).toContain('must be equal to one of the allowed values');
    expect((err as ModelValidationError).reason).toContain('/priority');
  });

  it('treats ModelOutputError as a failed attempt and retries with the raw output', async () => {
    const prompts: string[] = [];
    const backend: ModelBackend = {
      complete: () => Promise.reject(new Error('unused')),
      vision: () => Promise.reject(new Error('unused')),
      classify: (r): Promise<RawClassifyResult> => {
        prompts.push(r.prompt);
        if (prompts.length === 1) return Promise.reject(new ModelOutputError('response was not JSON', 'Sure! Priority: P1'));
        return Promise.resolve({ value: { priority: 'P1' }, model: 'fake/model' });
      },
    };
    await expect(withValidation(backend).classify(planReq)).resolves.toEqual({ value: { priority: 'P1' }, model: 'fake/model', attempts: 2 });
    expect(prompts[1]).toContain('<previous-answer>Sure! Priority: P1</previous-answer>');
    expect(prompts[1]).toContain('<reason>response was not JSON</reason>');
  });

  it('does not retry other provider errors', async () => {
    let count = 0;
    const backend: ModelBackend = {
      complete: () => Promise.reject(new Error('unused')),
      vision: () => Promise.reject(new Error('unused')),
      classify: () => {
        count += 1;
        return Promise.reject(new Error('HTTP 529 overloaded'));
      },
    };
    await expect(withValidation(backend).classify(planReq)).rejects.toThrow('HTTP 529 overloaded');
    expect(count).toBe(1);
  });
});
