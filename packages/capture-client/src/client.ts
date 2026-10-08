import { CaptureAuthError, CaptureServerError, CaptureTimeoutError } from './errors.ts';
import {
  CAPTURE_ROUTES,
  validateHealthResult,
  validateLookupResponse,
  validateQueueView,
  validateStopResult,
  validateTicketStatus,
  type AnswerRequest,
  type CaptureContext,
  type CaptureRequest,
  type CaptureSource,
  type HealthResult,
  type LookupResponse,
  type QueueView,
  type StopResult,
  type TicketStatus,
  type Validation,
} from './wire.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CaptureClientOptions {
  /** Only a URL: `https://snapwing.example.com` or `http://localhost:3000` are equally fine. */
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: FetchLike;
  /** Per-call timeout; default 15000. */
  readonly timeoutMs?: number;
}

export interface SendOptions {
  readonly source?: CaptureSource;
  readonly surface?: string;
  readonly context?: CaptureContext;
}

export interface CaptureClient {
  sendText(text: string, options?: SendOptions): Promise<LookupResponse>;
  sendImage(image: string, mimeType: string, options?: SendOptions): Promise<LookupResponse>;
  answer(captureId: string, choiceId: string): Promise<LookupResponse>;
  poll(captureId: string): Promise<LookupResponse>;
  status(key: string): Promise<TicketStatus>;
  stop(key: string): Promise<StopResult>;
  health(): Promise<HealthResult>;
  queue(): Promise<QueueView>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createCaptureClient(options: CaptureClientOptions): CaptureClient {
  const base = options.endpoint.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (raw: unknown) => Validation<T>,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    // The bearer token travels in this header and nowhere else.
    if (auth) headers['authorization'] = `Bearer ${options.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (cause) {
        if (timedOut) throw new CaptureTimeoutError(timeoutMs);
        throw new CaptureServerError(null, `Could not reach ${base}: ${describe(cause)}`, { cause });
      }
      if (res.status === 401 || res.status === 403) throw new CaptureAuthError(res.status);
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after'));
        throw new CaptureServerError(429, Number.isFinite(wait) && wait > 0 ? `Too many reports, try again in ${Math.ceil(wait)} seconds.` : 'Too many reports, try again in a minute.');
      }
      if (res.status === 413) throw new CaptureServerError(413, 'That image is too large (limit 5 MB).');
      if (!res.ok) throw new CaptureServerError(res.status, `The server answered ${res.status}.`);
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (cause) {
        if (timedOut) throw new CaptureTimeoutError(timeoutMs);
        throw new CaptureServerError(res.status, 'The server sent a body that is not JSON.', { cause });
      }
      const parsed = parse(raw);
      if (!parsed.ok) throw new CaptureServerError(res.status, `Unexpected response: ${parsed.error}`);
      return parsed.value;
    } finally {
      clearTimeout(timer);
    }
  }

  function common(opts: SendOptions | undefined): {
    source: CaptureSource;
    surface?: string;
    context?: CaptureContext;
  } {
    return {
      source: opts?.source ?? 'cli',
      ...(opts?.surface === undefined ? {} : { surface: opts.surface }),
      ...(opts?.context === undefined ? {} : { context: opts.context }),
    };
  }

  return {
    sendText(text, opts) {
      const body: CaptureRequest = { ...common(opts), text };
      return call('POST', CAPTURE_ROUTES.send, body, validateLookupResponse);
    },
    sendImage(image, mimeType, opts) {
      const body: CaptureRequest = { ...common(opts), image, mimeType };
      return call('POST', CAPTURE_ROUTES.send, body, validateLookupResponse);
    },
    answer(captureId, choiceId) {
      const body: AnswerRequest = { choiceId };
      return call('POST', CAPTURE_ROUTES.answer(captureId), body, validateLookupResponse);
    },
    poll(captureId) {
      return call('GET', CAPTURE_ROUTES.poll(captureId), undefined, validateLookupResponse);
    },
    status(key) {
      return call('GET', CAPTURE_ROUTES.status(key), undefined, validateTicketStatus);
    },
    stop(key) {
      return call('POST', CAPTURE_ROUTES.stop(key), {}, validateStopResult);
    },
    queue() {
      return call('GET', CAPTURE_ROUTES.queue, undefined, validateQueueView);
    },
    health() {
      return call('GET', CAPTURE_ROUTES.health, undefined, validateHealthResult, false);
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
