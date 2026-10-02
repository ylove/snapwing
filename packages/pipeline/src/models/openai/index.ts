// OpenAI ModelBackend (main 14.5, ADR 0002). Structured output uses `response_format: json_schema` with
// `strict: true`; images go in as `image_url` content parts (base64 data URLs, so OpenAI never fetches a URL).
// The router wraps this in withValidation, so `classify` here returns the parsed object unvalidated and
// throws ModelOutputError when the answer cannot be parsed.

import OpenAI, { APIConnectionError, APIError } from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { ImageReading } from '../../contracts/incident.ts';
import type {
  ClassifyRequest,
  CompletionRequest,
  CompletionResult,
  JsonSchema,
  ModelBackend,
  ModelResultMeta,
  ModelTask,
  RawClassifyResult,
  VisionRequest,
  VisionResult,
} from '../../ports/model.ts';
import {
  ModelAuthError,
  ModelOutputError,
  ModelRateLimitError,
  ModelUnavailableError,
} from '../errors.ts';
import { DEFAULT_MODELS, PROVIDER_KEY_ENV, type ModelProviderFactory } from '../router.ts';
import { stripAddedNulls, toStrictSchema } from './strict.ts';

export { ModelSchemaError, stripAddedNulls, toStrictSchema } from './strict.ts';

/** The one SDK call this adapter makes. The real `OpenAI` client satisfies it; tests pass a fake. */
export interface OpenAIChatClient {
  chat: { completions: { create(body: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> } };
}

export interface OpenAIModelOptions {
  apiKey: string | undefined;
  /** Model name per task; a task that is absent uses DEFAULT_MODELS.openai. */
  models?: Partial<Record<ModelTask, string>>;
  /** Replaces the SDK client (tests). When set, `apiKey` is not required. */
  client?: OpenAIChatClient;
}

export function createOpenAIModel(options: OpenAIModelOptions): ModelBackend {
  let client = options.client;
  const getClient = (): OpenAIChatClient => {
    if (client) return client;
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new ModelAuthError(`no OpenAI API key (set ${PROVIDER_KEY_ENV.openai})`);
    }
    client = new OpenAI({ apiKey: options.apiKey });
    return client;
  };
  const modelFor = (task: ModelTask): string => options.models?.[task] ?? DEFAULT_MODELS.openai[task];

  const call = async (request: CompletionRequest, body: Partial<ChatCompletionCreateParamsNonStreaming>) => {
    const model = modelFor(request.task);
    let response: ChatCompletion;
    try {
      response = await getClient().chat.completions.create({
        model,
        ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...body,
        messages: body.messages ?? [],
      });
    } catch (err) {
      throw mapOpenAIError(err);
    }
    const meta: ModelResultMeta = { model: `openai/${response.model || model}` };
    if (response.usage) {
      meta.usage = { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens };
    }
    return { response, meta };
  };

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const { response, meta } = await call(request, { messages: textMessages(request) });
      return { ...meta, text: messageText(response) };
    },

    async classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
      // Throws ModelSchemaError before any API call when the schema cannot be made strict.
      const strict = toStrictSchema(request.schema);
      const { response, meta } = await call(request, {
        messages: textMessages(request),
        response_format: jsonSchemaFormat(request.schemaName, strict),
      });
      return { ...meta, value: stripAddedNulls(parseJson(messageText(response, true)), request.schema) };
    },

    async vision(request: VisionRequest): Promise<VisionResult> {
      const { response, meta } = await call(request, {
        messages: [
          { role: 'system', content: request.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: request.prompt },
              ...request.images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              })),
            ],
          },
        ],
        response_format: jsonSchemaFormat('image_readings', READINGS_SCHEMA),
      });
      const raw = messageText(response, true);
      return { ...meta, readings: parseReadings(raw, request.images.length) };
    },
  };
}

/** The factory the router registers: `createModelRouter(config, { openai: openaiProvider }, env)`. */
export const openaiProvider: ModelProviderFactory = (route, env) =>
  createOpenAIModel({ apiKey: env[PROVIDER_KEY_ENV.openai], models: { [route.task]: route.model } });

function textMessages(request: CompletionRequest): ChatCompletionCreateParamsNonStreaming['messages'] {
  return [
    { role: 'system', content: request.system },
    { role: 'user', content: request.prompt },
  ];
}

function jsonSchemaFormat(name: string, schema: JsonSchema): NonNullable<ChatCompletionCreateParamsNonStreaming['response_format']> {
  return {
    type: 'json_schema',
    json_schema: { name, schema: schema as unknown as Record<string, unknown>, strict: true },
  };
}

/** The assistant text. With `structured`, a refusal, truncation, or empty answer is a ModelOutputError. */
function messageText(response: ChatCompletion, structured = false): string {
  const choice = response.choices[0];
  const message = choice?.message;
  const content = message?.content ?? '';
  if (!structured) return content;
  if (message?.refusal) throw new ModelOutputError(`OpenAI refused: ${message.refusal}`, content);
  if (choice?.finish_reason === 'length') throw new ModelOutputError('OpenAI answer was cut off at the token limit', content);
  if (content.trim() === '') throw new ModelOutputError('OpenAI returned an empty answer', content);
  return content;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ModelOutputError('OpenAI answer is not valid JSON', text, { cause });
  }
}

// Strict mode needs every property listed in `required`, so optional ImageReading fields are nullable here
// and dropped when the null comes back.
const nullableString: JsonSchema = { type: ['string', 'null'] };
const READING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['errorText', 'surfaceSignals', 'uiElements', 'environmentHint', 'plainDescription', 'sensitive'],
  properties: {
    errorText: nullableString,
    surfaceSignals: {
      type: 'object',
      additionalProperties: false,
      required: ['urlBar', 'pageTitle', 'chrome'],
      properties: {
        urlBar: nullableString,
        pageTitle: nullableString,
        chrome: { type: ['string', 'null'], enum: ['web', 'mobile', 'desktop', 'admin', 'unknown', null] },
      },
    },
    uiElements: { type: 'array', items: { type: 'string' } },
    environmentHint: { type: ['string', 'null'], enum: ['production', 'staging', 'local', 'unknown', null] },
    plainDescription: { type: 'string' },
    sensitive: { type: 'boolean' },
  },
};
const READINGS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['readings'],
  properties: { readings: { type: 'array', items: READING_SCHEMA } },
};

const CHROME = ['web', 'mobile', 'desktop', 'admin', 'unknown'] as const;
const ENVIRONMENTS = ['production', 'staging', 'local', 'unknown'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseReadings(raw: string, expected: number): ImageReading[] {
  const parsed = parseJson(raw);
  const list = isRecord(parsed) ? parsed.readings : undefined;
  if (!Array.isArray(list)) throw new ModelOutputError('OpenAI vision answer has no "readings" array', raw);
  if (list.length !== expected) {
    throw new ModelOutputError(`OpenAI vision answer has ${list.length} readings for ${expected} images`, raw);
  }
  return list.map((item) => parseReading(item, raw));
}

function parseReading(item: unknown, raw: string): ImageReading {
  if (!isRecord(item)) throw new ModelOutputError('OpenAI vision reading is not an object', raw);
  const { plainDescription, sensitive, uiElements } = item;
  if (typeof plainDescription !== 'string' || typeof sensitive !== 'boolean') {
    throw new ModelOutputError('OpenAI vision reading lacks plainDescription or sensitive', raw);
  }
  if (!Array.isArray(uiElements) || !uiElements.every((e): e is string => typeof e === 'string')) {
    throw new ModelOutputError('OpenAI vision reading has a bad uiElements list', raw);
  }
  const signals = isRecord(item.surfaceSignals) ? item.surfaceSignals : {};
  const surfaceSignals: ImageReading['surfaceSignals'] = {};
  if (typeof signals.urlBar === 'string') surfaceSignals.urlBar = signals.urlBar;
  if (typeof signals.pageTitle === 'string') surfaceSignals.pageTitle = signals.pageTitle;
  const chrome = CHROME.find((c) => c === signals.chrome);
  if (chrome) surfaceSignals.chrome = chrome;
  const reading: ImageReading = { surfaceSignals, uiElements, plainDescription, sensitive };
  if (typeof item.errorText === 'string') reading.errorText = item.errorText;
  const environmentHint = ENVIRONMENTS.find((e) => e === item.environmentHint);
  if (environmentHint) reading.environmentHint = environmentHint;
  return reading;
}

/** Provider errors to typed errors (main 14.5). Anything else is rethrown untouched. */
export function mapOpenAIError(err: unknown): unknown {
  if (err instanceof APIConnectionError) return new ModelUnavailableError(`OpenAI is unreachable: ${err.message}`, { cause: err });
  if (!(err instanceof APIError)) return err;
  const status = err.status;
  if (status === 429) {
    const retryAfterMs = retryAfterFrom(err.headers);
    return new ModelRateLimitError(`OpenAI rate limit: ${err.message}`, retryAfterMs, { cause: err });
  }
  if (status === 401 || status === 403) return new ModelAuthError(`OpenAI rejected the credentials: ${err.message}`, { cause: err });
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return new ModelUnavailableError(`OpenAI is unavailable (${status}): ${err.message}`, { cause: err });
  }
  return err;
}

/** Milliseconds from `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
function retryAfterFrom(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') !== null && Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
