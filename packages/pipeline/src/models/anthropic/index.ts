// Anthropic ModelBackend (main 14.5, ADR 0002). Structured output is the Messages API's structured outputs:
// `output_config.format` carries the request schema (converted by `toStructuredSchema` in ./schema.ts) and
// the answer is the JSON in the response's text. There is no forced `tool_choice`: Claude Opus 5.5,
// Claude Sonnet 5.5 and Claude Fable 5.1 reject `{type: "tool"}` and `{type: "any"}` with a 400, and one
// code path serves every model the router uses. Images go in as native image content blocks.
//
// Thinking: the request never sends `thinking`. Opus 5.5 and Sonnet 5.5 always think (`{type: "disabled"}`
// is a 400 there), Haiku 4.5 does not think without it. `temperature` goes only to models that still take
// sampling parameters (`acceptsSampling`); on the rest a non-default value is a 400. Models that think get
// at least MIN_THINKING_MAX_TOKENS, so thinking cannot use up the answer's budget.
//
// The router applies withValidation, so `classify` here returns the parsed answer unvalidated.

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
import {
  ModelAuthError,
  ModelError,
  ModelOutputError,
  ModelRateLimitError,
  ModelRefusalError,
  ModelUnavailableError,
} from '../errors.ts';
import { stripAddedNulls, toStructuredSchema } from './schema.ts';

export { ModelSchemaError, stripAddedNulls, toStructuredSchema } from './schema.ts';

/** Non-streaming default: room for thinking plus the answer, under the SDK's non-streaming timeout. */
export const DEFAULT_MAX_TOKENS = 16000;
/** Floor for models that think on every request; a smaller caller limit would starve the answer. */
export const MIN_THINKING_MAX_TOKENS = 16000;

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

/**
 * True for models that take `temperature` and do not think unless asked: Haiku 4.5, the 4.6 and earlier
 * Opus and Sonnet models, and the 3.x family. Every newer model (Opus 4.7 and later, Sonnet 5 and later,
 * Fable, Mythos) rejects sampling parameters, and an unknown model is treated as new.
 */
export function acceptsSampling(model: string): boolean {
  return /^claude-(?:3-|haiku-4-5(?:-\d{8})?$|(?:opus|sonnet)-4(?:-[0-6])?(?:-\d{8})?$)/.test(model);
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
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(params);
    } catch (err) {
      throw mapAnthropicError(err);
    }
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? null;
      throw new ModelRefusalError(
        `Anthropic declined the request (${category ?? 'no category'})${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ''}`,
        category,
      );
    }
    return message;
  };

  const baseParams = (request: CompletionRequest, model: string) => {
    const sampling = acceptsSampling(model);
    const requested = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    return {
      model,
      max_tokens: sampling ? requested : Math.max(requested, MIN_THINKING_MAX_TOKENS),
      system: request.system,
      ...(request.temperature === undefined || !sampling ? {} : { temperature: request.temperature }),
    };
  };

  const structured = async (
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'output_config'>,
    schema: JsonSchema,
  ): Promise<{ message: Anthropic.Message; value: unknown }> => {
    const message = await send({
      ...params,
      output_config: { format: { type: 'json_schema', schema: schema as unknown as Record<string, unknown> } },
    });
    return { message, value: parseAnswer(message) };
  };

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const model = modelFor(request.task);
      const message = await send({
        ...baseParams(request, model),
        messages: [{ role: 'user', content: request.prompt }],
      });
      return { text: textOf(message), ...meta(message, model) };
    },

    async vision(request: VisionRequest): Promise<VisionResult> {
      const model = modelFor(request.task);
      const { message, value } = await structured(
        {
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
        },
        READINGS_STRUCTURED,
      );
      const readings = parseReadings(stripAddedNulls(value, READINGS_SCHEMA), request.images.length);
      return { readings, ...meta(message, model) };
    },

    async classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
      const model = modelFor(request.task);
      const wrapped = !isObjectSchema(request.schema);
      const original: JsonSchema = wrapped
        ? { type: 'object', properties: { value: request.schema }, required: ['value'], additionalProperties: false }
        : request.schema;
      // Throws ModelSchemaError before any API call when the schema cannot be expressed.
      const schema = toStructuredSchema(original);
      const { message, value } = await structured(
        { ...baseParams(request, model), messages: [{ role: 'user', content: request.prompt }] },
        schema,
      );
      const answer = stripAddedNulls(value, original);
      if (!wrapped) return { value: answer, ...meta(message, model) };
      if (!isRecord(answer) || !('value' in answer)) {
        throw new ModelOutputError('structured answer has no "value" field', JSON.stringify(answer));
      }
      return { value: answer['value'], ...meta(message, model) };
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
      additionalProperties: false,
    },
    uiElements: { type: 'array', items: { type: 'string' }, description: 'Visible labels, menu items, field names.' },
    environmentHint: { type: 'string', enum: ['production', 'staging', 'local', 'unknown'] },
    plainDescription: { type: 'string', description: 'What the reporter would say, in plain words.' },
    sensitive: { type: 'boolean', description: 'True when credentials, tokens, or personal data are visible.' },
  },
  required: ['surfaceSignals', 'uiElements', 'plainDescription', 'sensitive'],
  additionalProperties: false,
};

const READINGS_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'One reading per image, in order.',
  properties: { readings: { type: 'array', items: IMAGE_READING_SCHEMA } },
  required: ['readings'],
  additionalProperties: false,
};

const READINGS_STRUCTURED = toStructuredSchema(READINGS_SCHEMA);

/**
 * The structured answer: the JSON in the text blocks. A truncated answer (`max_tokens`, or the context
 * window filling up) is a ModelOutputError, so withValidation retries it once and then surfaces it.
 */
function parseAnswer(message: Anthropic.Message): unknown {
  const text = textOf(message);
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    throw new ModelOutputError(`Anthropic answer was cut off (stop_reason ${message.stop_reason})`, text);
  }
  if (text.trim() === '') {
    throw new ModelOutputError(`Anthropic returned no structured answer (stop_reason ${String(message.stop_reason)})`, text);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ModelOutputError('Anthropic structured answer is not JSON', text, { cause: err });
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
}

function parseReadings(input: unknown, expected: number): ImageReading[] {
  const raw = JSON.stringify(input);
  const list = isRecord(input) ? input['readings'] : undefined;
  if (!Array.isArray(list)) throw new ModelOutputError('vision answer has no "readings" array', raw);
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
