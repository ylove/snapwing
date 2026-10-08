// Per-task model routing and the shared classify contract (main 14.5, ADR 0002).
//
// createModelRouter turns the `models` element of snapwing.config.xml into one ModelPort:
//   1. a task with a <model> row goes to that row's provider and model;
//   2. otherwise to `defaultProvider` with that provider's default model for the task (DEFAULT_MODELS);
//   3. with no configured default, to the first of anthropic, openai, google with a key in `env`.
// Every provider is wrapped in withValidation, so the classify retry rule is implemented once.

import type { ModelProvider, ModelRow, ModelTask as ConfigModelTask } from '../config/app-config.ts';
import type {
  ClassifyRequest,
  ClassifyResult,
  CompletionRequest,
  CompletionResult,
  ModelBackend,
  ModelPort,
  ModelTask,
  RawClassifyResult,
  VisionRequest,
  VisionResult,
} from '../ports/model.ts';
import { ModelOutputError, ModelRoutingError, ModelValidationError } from './errors.ts';

// The config's task list and the port's task union must stay the same six values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const TASKS_MATCH: Same<ConfigModelTask, ModelTask> = true;
void TASKS_MATCH;

export const MODEL_TASK_LIST: readonly ModelTask[] = ['triage', 'segmentation', 'vision', 'clarify', 'scout', 'review'];

/** Provider order for picking a default from the keys present (ADR 0002). */
export const PROVIDER_PREFERENCE: readonly ModelProvider[] = ['anthropic', 'openai', 'google'];

/** Conventional secret names (main 14.5). */
export const PROVIDER_KEY_ENV: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

/**
 * Each provider's model for a task that has no <model> row. Names follow the main 14.5 example; cheap
 * tasks (segmentation, clarify) get the small model, scout gets the largest. Change here, not in stages.
 */
export const DEFAULT_MODELS: Readonly<Record<ModelProvider, Readonly<Record<ModelTask, string>>>> = {
  anthropic: {
    triage: 'claude-sonnet-5-5',
    segmentation: 'claude-haiku-4-5',
    vision: 'claude-sonnet-5-5',
    clarify: 'claude-haiku-4-5',
    scout: 'claude-opus-5-5',
    review: 'claude-sonnet-5-5',
  },
  openai: {
    triage: 'gpt-5',
    segmentation: 'gpt-5-mini',
    vision: 'gpt-5',
    clarify: 'gpt-5-mini',
    scout: 'gpt-5',
    review: 'gpt-5',
  },
  google: {
    triage: 'gemini-2.5-pro',
    segmentation: 'gemini-2.5-flash',
    vision: 'gemini-2.5-pro',
    clarify: 'gemini-2.5-flash',
    scout: 'gemini-2.5-pro',
    review: 'gemini-2.5-pro',
  },
};

/**
 * What the router reads from config. A loaded `ModelsConfig` fits as is; `defaultProvider` is optional
 * here so a config written before onboarding picked one (or a test) falls back to the env keys.
 */
export interface ModelsSelection {
  defaultProvider?: ModelProvider;
  rows: readonly ModelRow[];
  /** `<models refusal-fallback>`: false turns server-side refusal fallback off for every route. Absent: on. */
  refusalFallback?: boolean;
}

export type ModelEnv = Readonly<Record<string, string | undefined>>;

export interface ModelRoute {
  task: ModelTask;
  provider: ModelProvider;
  model: string;
  /** Why this provider: a <model> row, the configured default-provider, or the first key found in env. */
  source: 'row' | 'default-provider' | 'env-key';
  /** The row's temperature. The router sends exactly this (or none) and ignores the request's own. */
  temperature?: number;
  /**
   * False when the config turns server-side refusal fallback off (`<models refusal-fallback="off">`);
   * absent means on. Adapters send it only to models that take it (Anthropic: `acceptsRefusalFallback`).
   */
  refusalFallback?: false;
}

/** Builds the adapter for one route. Vendor adapters read their key from `env` by PROVIDER_KEY_ENV. */
export type ModelProviderFactory = (route: ModelRoute, env: ModelEnv) => ModelBackend;

export type ModelProviders = Partial<Record<ModelProvider, ModelProviderFactory>>;

export interface ModelRouter extends ModelPort {
  readonly routes: Readonly<Record<ModelTask, ModelRoute>>;
}

/** The first provider, in ADR 0002 order, whose key is a non-empty string in `env`. */
export function providerFromEnv(env: ModelEnv): ModelProvider | undefined {
  return PROVIDER_PREFERENCE.find((p) => hasKey(env, p));
}

/** Resolve all six tasks. Throws ModelRoutingError when a task needs the env fallback and no key is set. */
export function resolveModelRoutes(config: ModelsSelection, env: ModelEnv): Record<ModelTask, ModelRoute> {
  const rows = new Map<ModelTask, ModelRow>();
  for (const row of config.rows) {
    if (rows.has(row.task)) throw new ModelRoutingError(`task "${row.task}" has more than one <model> row`);
    rows.set(row.task, row);
  }
  let fallback: { provider: ModelProvider; source: 'default-provider' | 'env-key' } | undefined;
  const fallbackProvider = (): { provider: ModelProvider; source: 'default-provider' | 'env-key' } => {
    if (fallback) return fallback;
    if (config.defaultProvider !== undefined) {
      fallback = { provider: config.defaultProvider, source: 'default-provider' };
      return fallback;
    }
    const fromEnv = providerFromEnv(env);
    if (fromEnv === undefined) {
      const missing = MODEL_TASK_LIST.filter((t) => !rows.has(t));
      throw new ModelRoutingError(
        `no model provider for task${missing.length === 1 ? '' : 's'} ${missing.join(', ')}: no <model> row, ` +
          `no default-provider, and none of ${PROVIDER_PREFERENCE.map((p) => PROVIDER_KEY_ENV[p]).join(', ')} is set`,
      );
    }
    fallback = { provider: fromEnv, source: 'env-key' };
    return fallback;
  };

  const routes = {} as Record<ModelTask, ModelRoute>;
  const refusal = config.refusalFallback === false ? { refusalFallback: false as const } : {};
  for (const task of MODEL_TASK_LIST) {
    const row = rows.get(task);
    if (row) {
      routes[task] = {
        task,
        provider: row.provider,
        model: row.name,
        source: 'row',
        ...(row.temperature === undefined ? {} : { temperature: row.temperature }),
        ...refusal,
      };
    } else {
      const { provider, source } = fallbackProvider();
      routes[task] = { task, provider, model: DEFAULT_MODELS[provider][task], source, ...refusal };
    }
  }
  return routes;
}

/**
 * One ModelPort that dispatches each request by `request.task`. Routes and adapter registration are
 * checked here, at boot, so a misconfiguration fails before the first incident. Adapters are built
 * lazily, once per task, and each is wrapped in withValidation.
 */
export function createModelRouter(config: ModelsSelection, providers: ModelProviders, env: ModelEnv): ModelRouter {
  const routes = resolveModelRoutes(config, env);
  const unregistered = [...new Set(MODEL_TASK_LIST.map((t) => routes[t].provider))].filter((p) => !providers[p]);
  if (unregistered.length > 0) {
    throw new ModelRoutingError(
      `no adapter registered for provider${unregistered.length === 1 ? '' : 's'} ${unregistered.join(', ')} ` +
        `(needed by ${MODEL_TASK_LIST.filter((t) => unregistered.includes(routes[t].provider)).join(', ')})`,
    );
  }

  const ports = new Map<ModelTask, ModelPort>();
  const portFor = (task: ModelTask): ModelPort => {
    if (!Object.hasOwn(routes, task)) throw new ModelRoutingError(`unknown model task "${String(task)}"`);
    const route = routes[task];
    let port = ports.get(task);
    if (!port) {
      const factory = providers[route.provider];
      if (!factory) throw new ModelRoutingError(`no adapter registered for provider ${route.provider}`);
      port = withValidation(factory(route, env));
      ports.set(task, port);
    }
    return port;
  };

  return {
    routes,
    // async so a routing failure is a rejected promise, like every other model failure
    complete: async (request: CompletionRequest) => portFor(request.task).complete(withRouteSampling(request, routes)),
    vision: async (request: VisionRequest) => portFor(request.task).vision(withRouteSampling(request, routes)),
    classify: async <T>(request: ClassifyRequest<T>) => portFor(request.task).classify(withRouteSampling(request, routes)),
  };
}

/**
 * The request with the route's temperature, or with none. A stage's own `temperature` is dropped: gpt-5,
 * gpt-5-mini, Claude Opus 5.5 and Claude Sonnet 5.5 answer any non-default value with a 400, so a
 * temperature is sent only when the task's <model> row sets one.
 */
function withRouteSampling<R extends CompletionRequest>(request: R, routes: Readonly<Record<ModelTask, ModelRoute>>): R {
  const route = Object.hasOwn(routes, request.task) ? routes[request.task] : undefined;
  const { temperature: _ignored, ...rest } = request;
  return (route?.temperature === undefined ? rest : { ...rest, temperature: route.temperature }) as R;
}

/**
 * The classify contract every provider shares (main 14.5): a result that fails `validate` (or that the
 * provider could not parse, ModelOutputError) is retried once with the validation error appended to the
 * prompt; a second failure throws ModelValidationError. A value never reaches a stage unvalidated.
 * `complete` and `vision` pass through.
 */
export function withValidation(backend: ModelBackend): ModelPort {
  return {
    complete: (request: CompletionRequest): Promise<CompletionResult> => backend.complete(request),
    vision: (request: VisionRequest): Promise<VisionResult> => backend.vision(request),
    classify: async <T>(request: ClassifyRequest<T>): Promise<ClassifyResult<T>> => {
      const first = await attempt(backend, request);
      if (first.ok) return { ...first.meta, value: first.value, attempts: 1 };
      const retry = await attempt(backend, { ...request, prompt: appendValidationError(request, first) });
      if (retry.ok) return { ...retry.meta, value: retry.value, attempts: 2 };
      throw new ModelValidationError({
        task: request.task,
        schemaName: request.schemaName,
        attempts: 2,
        lastValue: retry.value,
        reason: retry.reason,
      });
    },
  };
}

type Attempt<T> =
  | { ok: true; value: T; meta: Omit<RawClassifyResult, 'value'> }
  | { ok: false; value: unknown; reason: string; raw?: string };

async function attempt<T>(backend: ModelBackend, request: ClassifyRequest<T>): Promise<Attempt<T>> {
  let result: RawClassifyResult;
  try {
    result = await backend.classify(request);
  } catch (err) {
    if (err instanceof ModelOutputError) {
      return { ok: false, value: undefined, reason: err.message, ...(err.raw === undefined ? {} : { raw: err.raw }) };
    }
    throw err;
  }
  const { value, ...meta } = result;
  if (request.validate(value)) return { ok: true, value, meta };
  return { ok: false, value, reason: describeValidationFailure(request.validate, request.schemaName) };
}

/**
 * Validators are type guards, so the detail comes from wherever the validator keeps it: an Ajv-style
 * `errors` array on the function, if present. Otherwise the reason names the schema.
 */
function describeValidationFailure(validate: (v: unknown) => boolean, schemaName: string): string {
  const errors = (validate as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
  }
  return `the value does not match schema "${schemaName}"`;
}

/** The retry prompt: the original prompt plus an XML block naming what was wrong (prompts stay XML, main 14.5). */
export function appendValidationError(
  request: ClassifyRequest<unknown>,
  failure: { value: unknown; reason: string; raw?: string },
): string {
  const previous = failure.raw ?? (failure.value === undefined ? '' : JSON.stringify(failure.value));
  return (
    `${request.prompt}\n\n` +
    `<validation-error schema="${xmlEscape(request.schemaName)}">\n` +
    `  <reason>${xmlEscape(failure.reason)}</reason>\n` +
    `  <previous-answer>${xmlEscape(previous)}</previous-answer>\n` +
    `  <instruction>Answer again. The answer must match the schema exactly.</instruction>\n` +
    `</validation-error>`
  );
}

function hasKey(env: ModelEnv, provider: ModelProvider): boolean {
  const value = env[PROVIDER_KEY_ENV[provider]];
  return typeof value === 'string' && value.trim() !== '';
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
