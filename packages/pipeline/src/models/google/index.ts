// Google (Gemini) ModelBackend over @google/genai (main 14.5, ADR 0002).
//
// createGoogleModel returns a ModelBackend: `classify` returns the parsed structured output without
// running `validate`; createModelRouter wraps it in withValidation. Provider failures map to
// ModelRateLimitError, ModelAuthError, ModelUnavailableError; unparseable output is ModelOutputError.

import { GoogleGenAI } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import type { ModelProviderFactory } from '../router.ts';
import { PROVIDER_KEY_ENV } from '../router.ts';
import {
  ModelAuthError,
  ModelError,
  ModelOutputError,
  ModelRateLimitError,
  ModelRoutingError,
  ModelUnavailableError,
} from '../errors.ts';
import type {
  ClassifyRequest,
  CompletionRequest,
  CompletionResult,
  ImageReading,
  ModelBackend,
  ModelTask,
  ModelUsage,
  RawClassifyResult,
  VisionRequest,
  VisionResult,
} from '../../ports/model.ts';
import { toGeminiSchema, IMAGE_READING_ARRAY_SCHEMA } from './schema.ts';


/** The one SDK call this adapter makes. `GoogleGenAI` satisfies it; tests pass a fake. */
export interface GoogleGenAiClient {
  models: {
    generateContent(params: GoogleGenerateParams): Promise<GenerateContentResponse>;
  };
}

export interface GoogleGenerateParams {
  model: string;
  contents: GoogleContent[];
  config: {
    systemInstruction: string;
    maxOutputTokens?: number;
    temperature?: number;
    responseMimeType?: 'application/json';
    responseSchema?: unknown;
  };
}

export interface GoogleContent {
  role: 'user';
  parts: GooglePart[];
}

export type GooglePart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GoogleModelOptions {
  apiKey: string;
  /** Model name per task, for example `gemini-2.5-flash`. */
  models: Readonly<Record<ModelTask, string>>;
  /** Replace the SDK client (tests). Defaults to `new GoogleGenAI({ apiKey })`. */
  client?: GoogleGenAiClient;
}

export function createGoogleModel(options: GoogleModelOptions): ModelBackend {
  if (options.apiKey.trim() === '') throw new ModelAuthError('Google model adapter needs a non-empty apiKey');
  const client: GoogleGenAiClient =
    options.client ?? (new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { fetch: retryAfterPreservingFetch() } }) as unknown as GoogleGenAiClient);

  const modelFor = (task: ModelTask): string => {
    const name = options.models[task];
    if (typeof name !== 'string' || name === '') throw new ModelRoutingError(`no Google model configured for task "${task}"`);
    return name;
  };

  const call = async (task: ModelTask, params: Omit<GoogleGenerateParams, 'model'>): Promise<{ response: GenerateContentResponse; model: string }> => {
    const model = modelFor(task);
    try {
      return { response: await client.models.generateContent({ model, ...params }), model };
    } catch (err) {
      throw mapGoogleError(err);
    }
  };

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const { response, model } = await call(request.task, {
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        config: baseConfig(request),
      });
      return { text: readText(response), model: qualified(model), ...usageOf(response) };
    },

    async vision(request: VisionRequest): Promise<VisionResult> {
      const { response, model } = await call(request.task, {
        contents: [
          {
            role: 'user',
            parts: [
              ...request.images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
              { text: request.prompt },
            ],
          },
        ],
        config: {
          ...baseConfig(request),
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(IMAGE_READING_ARRAY_SCHEMA),
        },
      });
      const readings = parseReadings(readText(response), request.images.length);
      return { readings, model: qualified(model), ...usageOf(response) };
    },

    async classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
      const { response, model } = await call(request.task, {
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        config: {
          ...baseConfig(request),
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(request.schema),
        },
      });
      const text = readText(response);
      return { value: parseJson(text), model: qualified(model), ...usageOf(response) };
    },
  };
}

/** Register with createModelRouter: `{ google: googleProviderFactory }`. Reads GOOGLE_API_KEY from env. */
export const googleProviderFactory: ModelProviderFactory = (route, env) => {
  const apiKey = env[PROVIDER_KEY_ENV.google];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ModelAuthError(`${PROVIDER_KEY_ENV.google} is not set`);
  }
  // The router routes one task per adapter; the same model serves every task key here.
  const models = Object.fromEntries(
    (['triage', 'segmentation', 'vision', 'clarify', 'scout', 'review'] as const).map((t) => [t, route.model]),
  ) as Record<ModelTask, string>;
  return createGoogleModel({ apiKey, models });
};

function qualified(model: string): string {
  return `google/${model}`;
}

function baseConfig(request: CompletionRequest): GoogleGenerateParams['config'] {
  return {
    systemInstruction: request.system,
    ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

function usageOf(response: GenerateContentResponse): { usage?: ModelUsage } {
  const u = response.usageMetadata;
  if (!u || typeof u.promptTokenCount !== 'number' || typeof u.candidatesTokenCount !== 'number') return {};
  return { usage: { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount } };
}

/** Text of the first candidate, or ModelOutputError when the prompt or answer was blocked or empty. */
function readText(response: GenerateContentResponse): string {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked !== undefined) throw new ModelOutputError(`Google blocked the prompt: ${String(blocked)}`);
  const candidate = response.candidates?.[0];
  if (!candidate) throw new ModelOutputError('Google returned no candidates');
  const text = (candidate.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' && p.thought !== true ? p.text : ''))
    .join('');
  if (text === '') {
    throw new ModelOutputError(`Google returned no text (finish reason: ${String(candidate.finishReason ?? 'unknown')})`);
  }
  return text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ModelOutputError('Google answer is not valid JSON', text, { cause });
  }
}

const CHROME = ['web', 'mobile', 'desktop', 'admin', 'unknown'] as const;
const ENVIRONMENTS = ['production', 'staging', 'local', 'unknown'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Parse the vision answer into one ImageReading per image. Gemini may send null for absent optionals. */
function parseReadings(text: string, expected: number): ImageReading[] {
  const raw = parseJson(text);
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['readings']) ? (raw['readings'] as unknown[]) : undefined;
  if (!list) throw new ModelOutputError('Google vision answer is not an array of readings', text);
  if (list.length !== expected) {
    throw new ModelOutputError(`Google vision answer has ${list.length} readings for ${expected} images`, text);
  }
  return list.map((item, i) => {
    if (!isRecord(item)) throw new ModelOutputError(`vision reading ${i} is not an object`, text);
    const plainDescription = item['plainDescription'];
    const sensitive = item['sensitive'];
    const uiElements = item['uiElements'];
    if (typeof plainDescription !== 'string') throw new ModelOutputError(`vision reading ${i} has no plainDescription`, text);
    if (typeof sensitive !== 'boolean') throw new ModelOutputError(`vision reading ${i} has no boolean sensitive`, text);
    if (!Array.isArray(uiElements) || !uiElements.every((e) => typeof e === 'string')) {
      throw new ModelOutputError(`vision reading ${i} has no uiElements string array`, text);
    }
    const signals = isRecord(item['surfaceSignals']) ? item['surfaceSignals'] : {};
    const urlBar = optionalString(signals['urlBar']);
    const pageTitle = optionalString(signals['pageTitle']);
    const chrome = CHROME.find((c) => c === signals['chrome']);
    const errorText = optionalString(item['errorText']);
    const environmentHint = ENVIRONMENTS.find((e) => e === item['environmentHint']);
    return {
      ...(errorText === undefined ? {} : { errorText }),
      surfaceSignals: {
        ...(urlBar === undefined ? {} : { urlBar }),
        ...(pageTitle === undefined ? {} : { pageTitle }),
        ...(chrome === undefined ? {} : { chrome }),
      },
      uiElements: uiElements as string[],
      ...(environmentHint === undefined ? {} : { environmentHint }),
      plainDescription,
      sensitive,
    };
  });
}

/**
 * Map an SDK failure to a typed error. The SDK's ApiError carries `status` and a message that is usually
 * the JSON error body, which may hold a RetryInfo detail (`retryDelay: "30s"`).
 */
export function mapGoogleError(err: unknown): Error {
  if (err instanceof ModelError) return err;
  const status = isRecord(err) && typeof err['status'] === 'number' ? err['status'] : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const detail = status === undefined ? message : `Google API ${status}: ${message}`;
  if (status === undefined) {
    // No HTTP status: a fetch/network failure. Anything else is a bug and passes through unchanged.
    return err instanceof TypeError || isNetworkError(err) ? new ModelUnavailableError(`Google unreachable: ${message}`, { cause: err }) : err instanceof Error ? err : new Error(message);
  }
  if (status === 429) return new ModelRateLimitError(detail, retryAfterMs(err, message), { cause: err });
  if (status === 401 || status === 403 || (status === 400 && /api key|API_KEY_INVALID/i.test(message))) {
    return new ModelAuthError(detail, { cause: err });
  }
  if (status === 408 || status >= 500) return new ModelUnavailableError(detail, { cause: err });
  return err instanceof Error ? err : new Error(detail);
}

function isNetworkError(err: unknown): boolean {
  const code = isRecord(err) ? err['code'] : undefined;
  return typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code);
}

/** Delta-seconds or HTTP date from a Retry-After header value, as milliseconds from now. */
function parseRetryAfterHeader(value: string): number | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (!isRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * The SDK's ApiError keeps only the status and the JSON body, so the HTTP Retry-After header is lost at its
 * boundary. This fetch wrapper copies the header of a 429 into the body as a RetryInfo detail (the shape
 * mapGoogleError already reads), unless the body has its own.
 */
export function retryAfterPreservingFetch(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    if (response.status !== 429) return response;
    const header = response.headers.get('retry-after');
    const ms = header === null ? undefined : parseRetryAfterHeader(header);
    if (ms === undefined) return response;
    const text = await response.text();
    let body: Record<string, unknown> = { error: { code: 429, message: text, status: response.statusText } };
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) body = parsed;
    } catch {
      // not JSON: keep the wrapped text
    }
    const error = isRecord(body['error']) ? body['error'] : {};
    const details: unknown[] = Array.isArray(error['details']) ? error['details'] : [];
    const hasHint = details.some((d) => isRecord(d) && typeof d['retryDelay'] === 'string');
    if (!hasHint) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${ms / 1000}s` });
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify({ ...body, error: { ...error, details } }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Retry delay in ms from a Retry-After header on the error (seconds or HTTP date), or the RetryInfo detail in the body. */
function retryAfterMs(err: unknown, message: string): number | undefined {
  const header = headerValue(isRecord(err) ? err['headers'] : undefined, 'retry-after');
  const fromHeader = header === undefined ? undefined : parseRetryAfterHeader(header);
  if (fromHeader !== undefined) return fromHeader;
  try {
    const body: unknown = JSON.parse(message);
    const details = isRecord(body) && isRecord(body['error']) ? body['error']['details'] : undefined;
    if (Array.isArray(details)) {
      for (const d of details) {
        const delay = isRecord(d) ? d['retryDelay'] : undefined;
        const m = typeof delay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
        if (m?.[1] !== undefined) return Math.round(Number(m[1]) * 1000);
      }
    }
  } catch {
    // message was not JSON; no hint available
  }
  return undefined;
}

