// PagerDuty Events API v2 pager (A 6.2, escalation `pagerduty`). Implements the pipeline's `Pager`.
// The routing key is the step's value when it carries one, else `PAGERDUTY_ROUTING_KEY` through the
// SecretsPort (CONTEXT 6b). The key goes in the request body only; it never reaches an error or a log.

import type { Pager, PagerSeverity, PagerTriggerInput } from '@snapwing/pipeline/monitor/pager.ts';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { PagerDutyApiError, PagerDutyRateLimitError, PagerDutyValidationError } from './errors.ts';

export * from './errors.ts';

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';
/** The secret name of CONTEXT 6b. */
export const PAGERDUTY_SECRET_NAME = 'PAGERDUTY_ROUTING_KEY';

export interface PagerDutyOptions {
  /** Fixed routing key; when absent, read lazily from the secrets port. */
  routingKey?: string;
  secrets?: SecretsPort;
  /** Defaults to the production Events endpoint. */
  url?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Reported as the event's `source` when the trigger gives none. */
  source?: string;
}

function parseRetryAfterMs(header: string | null): number {
  if (header === null) return 1000;
  const secs = Number(header);
  return Number.isFinite(secs) ? Math.max(0, Math.round(secs * 1000)) : 1000;
}

async function readError(res: Response): Promise<{ message: string; errors: string[] }> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return { message: '', errors: [] };
    const rec = body as Record<string, unknown>;
    const errors = Array.isArray(rec['errors']) ? rec['errors'].filter((e): e is string => typeof e === 'string') : [];
    return { message: typeof rec['message'] === 'string' ? rec['message'] : '', errors };
  } catch {
    return { message: '', errors: [] };
  }
}

export function createPagerDutyPager(options: PagerDutyOptions): Pager {
  const url = options.url ?? PAGERDUTY_EVENTS_URL;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const defaultSource = options.source ?? 'snapwing';

  async function resolveKey(override: string | undefined): Promise<string> {
    if (override) return override;
    if (options.routingKey) return options.routingKey;
    if (!options.secrets) throw new PagerDutyApiError(0, `no routing key and no secrets port (${PAGERDUTY_SECRET_NAME})`);
    return options.secrets.get(PAGERDUTY_SECRET_NAME);
  }

  async function send(body: Record<string, unknown>): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Never echo the request: the body holds the routing key.
      throw new PagerDutyApiError(0, `POST ${new URL(url).pathname}`);
    }
    if (res.ok) return;
    if (res.status === 429) throw new PagerDutyRateLimitError(parseRetryAfterMs(res.headers.get('Retry-After')));
    if (res.status === 400) {
      const { message, errors } = await readError(res);
      throw new PagerDutyValidationError(message, errors);
    }
    throw new PagerDutyApiError(res.status);
  }

  return {
    async trigger(input: PagerTriggerInput): Promise<void> {
      const routing_key = await resolveKey(input.routingKey);
      const severity: PagerSeverity = input.severity ?? 'critical';
      await send({
        routing_key,
        event_action: 'trigger',
        dedup_key: input.dedupKey,
        payload: {
          summary: input.summary.slice(0, 1024),
          source: input.source ?? defaultSource,
          severity,
          ...(input.details ? { custom_details: input.details } : {}),
        },
        ...(input.link ? { links: [{ href: input.link.href, ...(input.link.text ? { text: input.link.text } : {}) }] } : {}),
      });
    },

    async resolve(dedupKey: string, opts?: { routingKey?: string }): Promise<void> {
      const routing_key = await resolveKey(opts?.routingKey);
      await send({ routing_key, event_action: 'resolve', dedup_key: dedupKey });
    },
  };
}

/** Builds a pager whose routing key comes from the SecretsPort (CONTEXT 6b). */
export function createPagerDutyPagerFromSecrets(secrets: SecretsPort, opts: { fetch?: typeof fetch; url?: string } = {}): Pager {
  return createPagerDutyPager({ secrets, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.url ? { url: opts.url } : {}) });
}
