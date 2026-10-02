// Anthropic ModelBackend (main 14.5, ADR 0002). Structured output is tool use with a single forced
// tool whose input schema is the request schema; images go in as native image content blocks.
// The router applies withValidation, so `classify` here returns the parsed tool input unvalidated.

import Anthropic from '@anthropic-ai/sdk';
import type { ImageReading } from '../../contracts/incident.ts';
import type {
  ClassifyRequest,
  CompletionRequest,
  CompletionResult,
  JsonSchema,
  ModelBackend,
  ModelTask,
  ModelUsage,
  RawClassifyResult,
  VisionRequest,
  VisionResult,
} from '../../ports/model.ts';
import { DEFAULT_MODELS, PROVIDER_KEY_ENV, type ModelProviderFactory } from '../router.ts';
import { ModelAuthError, ModelError, ModelOutputError, ModelRateLimitError, ModelUnavailableError } from '../errors.ts';

export const DEFAULT_MAX_TOKENS = 4096;

/** The one method of the SDK client this adapter uses; tests pass a fake. */
export interface AnthropicClientLike {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface AnthropicModelOptions {
  apiKey: string;
  /** Model name per task, for example `claude-haiku-4-5`. */
  models: Readonly<Record<ModelTask, string>>;
  baseURL?: string;
  /** Replaces the SDK client (tests). */
  client?: AnthropicClientLike;
}

export function createAnthropicModel(options: AnthropicModelOptions): ModelBackend {
  const client: AnthropicClientLike =
    options.client ??
    new Anthropic({ apiKey: options.apiKey, ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }) });

  const modelFor = (task: ModelTask): string => {
    const name = options.models[task];
    if (typeof name !== 'string' || name === '') throw new ModelError(`no Anthropic model configured for task "${String(task)}"`);
    return name;
  };

  const send = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    try {
      return await client.messages.create(params);
    } catch (err) {
      throw mapAnthropicError(err);
    }
  };

  const baseParams = (request: CompletionRequest, model: string) => ({
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  });

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const model = modelFor(request.task);
      const message = await send({
        ...baseParams(request, model),
        messages: [{ role: 'user', content: request.prompt }],
      });
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { text, ...meta(message, model) };
    },

    async vision(request: VisionRequest): Promise<VisionResult> {
      const model = modelFor(request.task);
      const message = await send({
        ...baseParams(request, model),
        messages: [
          {
            role: 'user',
            content: [
              ...request.images.map(
                (image): Anthropic.ImageBlockParam => ({
                  type: 'image',
                  source: { type: 'base64', media_type: image.mimeType, data: image.data },
                }),
              ),
              { type: 'text', text: request.prompt },
            ],
          },
        ],
        tools: [{ name: READINGS_TOOL, description: 'Report one reading per image, in order.', input_schema: READINGS_SCHEMA }],
        tool_choice: { type: 'tool', name: READINGS_TOOL },
      });
      const input = toolInput(message, READINGS_TOOL);
      const readings = parseReadings(input, request.images.length);
      return { readings, ...meta(message, model) };
    },

    async classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
      const model = modelFor(request.task);
      const wrapped = !isObjectSchema(request.schema);
      const name = toolName(request.schemaName);
      const message = await send({
        ...baseParams(request, model),
        messages: [{ role: 'user', content: request.prompt }],
        tools: [
          {
            name,
            description: request.schema.description ?? `Answer using the ${request.schemaName} schema.`,
            input_schema: (wrapped
              ? { type: 'object', properties: { value: request.schema }, required: ['value'] }
              : request.schema) as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name },
      });
      const input = toolInput(message, name);
      if (!wrapped) return { value: input, ...meta(message, model) };
      if (!isRecord(input) || !('value' in input)) {
        throw new ModelOutputError(`tool "${name}" input has no "value" field`, JSON.stringify(input));
      }
      return { value: input['value'], ...meta(message, model) };
    },
  };
}

/** Registers the adapter with the router: reads ANTHROPIC_API_KEY from `env` and uses the route's model for its task. */
export const anthropicProvider: ModelProviderFactory = (route, env) => {
  const apiKey = env[PROVIDER_KEY_ENV.anthropic];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ModelAuthError(`${PROVIDER_KEY_ENV.anthropic} is not set`);
  }
  return createAnthropicModel({ apiKey, models: { ...DEFAULT_MODELS.anthropic, [route.task]: route.model } });
};

// ---- structured output ----

const READINGS_TOOL = 'report_image_readings';

const IMAGE_READING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    errorText: { type: 'string', description: 'Error text exactly as shown, if any is visible.' },
    surfaceSignals: {
      type: 'object',
      properties: {
        urlBar: { type: 'string' },
        pageTitle: { type: 'string' },
        chrome: { type: 'string', enum: ['web', 'mobile', 'desktop', 'admin', 'unknown'] },
      },
    },
    uiElements: { type: 'array', items: { type: 'string' }, description: 'Visible labels, menu items, field names.' },
    environmentHint: { type: 'string', enum: ['production', 'staging', 'local', 'unknown'] },
    plainDescription: { type: 'string', description: 'What the reporter would say, in plain words.' },
    sensitive: { type: 'boolean', description: 'True when credentials, tokens, or personal data are visible.' },
  },
  required: ['surfaceSignals', 'uiElements', 'plainDescription', 'sensitive'],
};

const READINGS_SCHEMA = {
  type: 'object',
  properties: { readings: { type: 'array', items: IMAGE_READING_SCHEMA } },
  required: ['readings'],
} as Anthropic.Tool.InputSchema;

function parseReadings(input: unknown, expected: number): ImageReading[] {
  const raw = JSON.stringify(input);
  const list = isRecord(input) ? input['readings'] : undefined;
  if (!Array.isArray(list)) throw new ModelOutputError('vision tool input has no "readings" array', raw);
  if (list.length !== expected) {
    throw new ModelOutputError(`expected ${expected} image readings, got ${list.length}`, raw);
  }
  return list.map((item, i) => parseReading(item, i, raw));
}

const CHROME = ['web', 'mobile', 'desktop', 'admin', 'unknown'] as const;
const ENVIRONMENTS = ['production', 'staging', 'local', 'unknown'] as const;

function parseReading(item: unknown, index: number, raw: string): ImageReading {
  const fail = (why: string): never => {
    throw new ModelOutputError(`image reading ${index}: ${why}`, raw);
  };
  if (!isRecord(item)) return fail('not an object');
  const { errorText, surfaceSignals, uiElements, environmentHint, plainDescription, sensitive } = item;
  if (typeof plainDescription !== 'string') return fail('plainDescription must be a string');
  if (typeof sensitive !== 'boolean') return fail('sensitive must be a boolean');
  if (!Array.isArray(uiElements) || !uiElements.every((e) => typeof e === 'string')) {
    return fail('uiElements must be an array of strings');
  }
  if (errorText !== undefined && typeof errorText !== 'string') return fail('errorText must be a string');
  if (environmentHint !== undefined && !(ENVIRONMENTS as readonly unknown[]).includes(environmentHint)) {
    return fail('environmentHint is not a known value');
  }
  if (!isRecord(surfaceSignals)) return fail('surfaceSignals must be an object');
  const { urlBar, pageTitle, chrome } = surfaceSignals;
  if (urlBar !== undefined && typeof urlBar !== 'string') return fail('surfaceSignals.urlBar must be a string');
  if (pageTitle !== undefined && typeof pageTitle !== 'string') return fail('surfaceSignals.pageTitle must be a string');
  if (chrome !== undefined && !(CHROME as readonly unknown[]).includes(chrome)) {
    return fail('surfaceSignals.chrome is not a known value');
  }
  return {
    ...(errorText === undefined ? {} : { errorText }),
    surfaceSignals: {
      ...(urlBar === undefined ? {} : { urlBar }),
      ...(pageTitle === undefined ? {} : { pageTitle }),
      ...(chrome === undefined ? {} : { chrome: chrome as (typeof CHROME)[number] }),
    },
    uiElements: uiElements as string[],
    ...(environmentHint === undefined ? {} : { environmentHint: environmentHint as (typeof ENVIRONMENTS)[number] }),
    plainDescription,
    sensitive,
  };
}

function toolInput(message: Anthropic.Message, name: string): unknown {
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === name);
  if (!block) {
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    throw new ModelOutputError(`the model did not call tool "${name}" (stop_reason ${String(message.stop_reason)})`, text);
  }
  return block.input;
}

/** Anthropic tool names allow letters, digits, underscore, hyphen, at most 64 characters. */
function toolName(schemaName: string): string {
  const cleaned = schemaName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned === '' ? 'answer' : cleaned;
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === 'object';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function meta(message: Anthropic.Message, model: string): { model: string; usage: ModelUsage } {
  return {
    model: `anthropic/${model}`,
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
  };
}

// ---- error mapping ----

/** Maps an SDK error to a typed ModelError. Matches on `status`, so it needs no SDK class at runtime. */
export function mapAnthropicError(err: unknown): Error {
  if (err instanceof ModelError) return err;
  const text = err instanceof Error ? err.message : String(err);
  const status = isRecord(err) && typeof err['status'] === 'number' ? err['status'] : undefined;
  if (status === 429) {
    const retryAfterMs = retryAfterOf(isRecord(err) ? err['headers'] : undefined);
    return new ModelRateLimitError(`Anthropic rate limit: ${text}`, retryAfterMs, { cause: err });
  }
  if (status === 401 || status === 403) return new ModelAuthError(`Anthropic rejected the credentials: ${text}`, { cause: err });
  if (status === undefined) {
    // No HTTP status: the SDK's connection and timeout errors, or something we do not recognise.
    if (err instanceof Anthropic.APIConnectionError) return new ModelUnavailableError(`Anthropic unreachable: ${text}`, { cause: err });
    return err instanceof Error ? err : new ModelError(text, { cause: err });
  }
  if (status >= 500) return new ModelUnavailableError(`Anthropic unavailable (${status}): ${text}`, { cause: err });
  return new ModelError(`Anthropic request failed (${status}): ${text}`, { cause: err });
}

/** `retry-after` is delta-seconds or an HTTP date; `retry-after-ms` is the SDK's own millisecond form. */
function retryAfterOf(headers: unknown): number | undefined {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (isRecord(headers)) {
      const v = headers[name];
      return typeof v === 'string' ? v : undefined;
    }
    return undefined;
  };
  const ms = Number(get('retry-after-ms'));
  if (get('retry-after-ms') !== undefined && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const value = get('retry-after');
  if (value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
