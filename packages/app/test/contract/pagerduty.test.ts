import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import {
  PAGERDUTY_EVENTS_URL,
  PagerDutyApiError,
  PagerDutyRateLimitError,
  PagerDutyValidationError,
  createPagerDutyPager,
  createPagerDutyPagerFromSecrets,
} from '../../src/pager/pagerduty.ts';

const KEY = 'pd-routing-key-test';
const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const secrets: SecretsPort = {
  async get(name) {
    if (name === 'PAGERDUTY_ROUTING_KEY') return KEY;
    throw new SecretNotFoundError(name, 'test');
  },
};

function capture(): { bodies: Record<string, unknown>[] } {
  const seen: { bodies: Record<string, unknown>[] } = { bodies: [] };
  server.use(
    http.post(PAGERDUTY_EVENTS_URL, async ({ request }) => {
      seen.bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ status: 'success', message: 'Event processed', dedup_key: 'x' }, { status: 202 });
    }),
  );
  return seen;
}

describe('trigger and resolve', () => {
  it('triggers with the secret routing key and the dedup key', async () => {
    const seen = capture();
    const pager = createPagerDutyPagerFromSecrets(secrets);
    await pager.trigger({
      dedupKey: 'inc1:outage',
      summary: 'Checkout is down',
      link: { href: 'https://example.test/i/1', text: 'incident' },
      details: { surface: 'checkout' },
    });
    expect(seen.bodies).toEqual([
      {
        routing_key: KEY,
        event_action: 'trigger',
        dedup_key: 'inc1:outage',
        payload: { summary: 'Checkout is down', source: 'snapwing', severity: 'critical', custom_details: { surface: 'checkout' } },
        links: [{ href: 'https://example.test/i/1', text: 'incident' }],
      },
    ]);
  });

  it('a step routing key wins over the secret', async () => {
    const seen = capture();
    await createPagerDutyPagerFromSecrets(secrets).trigger({ dedupKey: 'd', summary: 's', routingKey: 'step-key-test', severity: 'error' });
    expect(seen.bodies[0]).toMatchObject({ routing_key: 'step-key-test', payload: { severity: 'error' } });
  });

  it('resolves by dedup key', async () => {
    const seen = capture();
    await createPagerDutyPager({ routingKey: KEY }).resolve('inc1:outage');
    expect(seen.bodies).toEqual([{ routing_key: KEY, event_action: 'resolve', dedup_key: 'inc1:outage' }]);
  });

  it('truncates a long summary to 1024 characters', async () => {
    const seen = capture();
    await createPagerDutyPager({ routingKey: KEY }).trigger({ dedupKey: 'd', summary: 'x'.repeat(2000) });
    expect((seen.bodies[0]?.['payload'] as { summary: string }).summary).toHaveLength(1024);
  });
});

describe('errors', () => {
  it('429 carries Retry-After', async () => {
    server.use(http.post(PAGERDUTY_EVENTS_URL, () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '7' } })));
    const err = await createPagerDutyPager({ routingKey: KEY }).trigger({ dedupKey: 'd', summary: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PagerDutyRateLimitError);
    expect((err as PagerDutyRateLimitError).retryAfterMs).toBe(7000);
  });

  it('429 without a header defaults to one second', async () => {
    server.use(http.post(PAGERDUTY_EVENTS_URL, () => new HttpResponse(null, { status: 429 })));
    const err = await createPagerDutyPager({ routingKey: KEY }).resolve('d').catch((e: unknown) => e);
    expect((err as PagerDutyRateLimitError).retryAfterMs).toBe(1000);
  });

  it('400 is a validation error with PagerDuty text and no routing key', async () => {
    server.use(
      http.post(PAGERDUTY_EVENTS_URL, () =>
        HttpResponse.json({ status: 'invalid event', message: 'Event object is invalid', errors: ['Routing key is invalid'] }, { status: 400 }),
      ),
    );
    const err = await createPagerDutyPager({ routingKey: KEY }).trigger({ dedupKey: 'd', summary: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PagerDutyValidationError);
    expect((err as Error).message).toContain('Routing key is invalid');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('5xx is an api error', async () => {
    server.use(http.post(PAGERDUTY_EVENTS_URL, () => new HttpResponse(null, { status: 503 })));
    const err = await createPagerDutyPager({ routingKey: KEY }).trigger({ dedupKey: 'd', summary: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PagerDutyApiError);
    expect((err as PagerDutyApiError).status).toBe(503);
  });

  it('a network failure never echoes the key', async () => {
    server.use(http.post(PAGERDUTY_EVENTS_URL, () => HttpResponse.error()));
    const err = await createPagerDutyPager({ routingKey: KEY }).trigger({ dedupKey: 'd', summary: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PagerDutyApiError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('a missing secret rejects with SecretNotFoundError', async () => {
    const empty: SecretsPort = {
      get: async (n) => {
        throw new SecretNotFoundError(n, 'test');
      },
    };
    await expect(createPagerDutyPagerFromSecrets(empty).resolve('d')).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});
