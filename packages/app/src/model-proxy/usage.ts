// src/model-proxy/usage.ts: the tokens a provider reports for one proxied call (#273), read from its
// response as it streams back to the container, without holding or changing it.
//
// A server-sent event stream is read line by line, each `data:` line as JSON; any other body is kept
// (up to `MAX_JSON_BODY`) and parsed once it ends, as an object or (Gemini's streamed array) an array of
// them. Each object's usage is taken per provider, and the largest value seen wins, because every
// provider either reports usage once or reports running totals (Anthropic's `message_start` and
// `message_delta`, Gemini's chunks):
//
//   anthropic  `usage` or `message.usage`: input = `input_tokens` + `cache_creation_input_tokens` +
//              `cache_read_input_tokens`, output = `output_tokens`
//   openai     `usage` or `response.usage`: input = `input_tokens` or `prompt_tokens`, output =
//              `output_tokens` or `completion_tokens`
//   google     `usageMetadata`: input = `promptTokenCount`, output = `candidatesTokenCount` +
//              `thoughtsTokenCount`
//
// The usage is handed over once, when the body ends, fails, or the container stops reading it.

import type { ModelProxyProvider } from './routes.ts';

export interface TokenUsage {
  input: number;
  output: number;
}

/** Longest non-stream body kept for its usage, in UTF-16 code units; a longer one is passed on unmetered. */
export const MAX_JSON_BODY = 16 * 1024 * 1024;
/** Longest event stream line kept; a longer one is skipped. */
const MAX_LINE = 1024 * 1024;

/** `body` passed through unchanged; `onUsage` gets what it reported once it ends or is cancelled. */
export function meterResponse(body: ReadableStream<Uint8Array>, provider: ModelProxyProvider, contentType: string, onUsage: (usage: TokenUsage) => void): ReadableStream<Uint8Array> {
  const usage: TokenUsage = { input: 0, output: 0 };
  const take = (value: unknown): void => {
    for (const item of Array.isArray(value) ? value : [value]) {
      const found = usageOf(provider, item);
      if (found === undefined) continue;
      usage.input = Math.max(usage.input, found.input);
      usage.output = Math.max(usage.output, found.output);
    }
  };
  const sse = contentType.toLowerCase().includes('text/event-stream');
  const decoder = new TextDecoder();
  let pending = '';
  let whole = '';
  let over = false;
  const line = (l: string): void => {
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (data === '' || data === '[DONE]') return;
    take(parse(data));
  };
  const push = (text: string): void => {
    if (!sse) {
      if (!over && whole.length + text.length <= MAX_JSON_BODY) whole += text;
      else over = true;
      return;
    }
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    if (pending.length > MAX_LINE) pending = '';
    for (const l of lines) line(l);
  };
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    push(decoder.decode());
    if (sse) line(pending);
    else if (!over) take(parse(whole));
    onUsage(usage);
  };

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
          return;
        }
        push(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (e) {
        end();
        controller.error(e);
      }
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
  });
}

function usageOf(provider: ModelProxyProvider, value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  if (provider === 'google') {
    const u = value['usageMetadata'];
    return isObject(u) ? { input: n(u['promptTokenCount']), output: n(u['candidatesTokenCount']) + n(u['thoughtsTokenCount']) } : undefined;
  }
  const nested = provider === 'anthropic' ? value['message'] : value['response'];
  const u = isObject(value['usage']) ? value['usage'] : isObject(nested) ? nested['usage'] : undefined;
  if (!isObject(u)) return undefined;
  if (provider === 'anthropic') {
    return { input: n(u['input_tokens']) + n(u['cache_creation_input_tokens']) + n(u['cache_read_input_tokens']), output: n(u['output_tokens']) };
  }
  return { input: n(u['input_tokens'] ?? u['prompt_tokens']), output: n(u['output_tokens'] ?? u['completion_tokens']) };
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
