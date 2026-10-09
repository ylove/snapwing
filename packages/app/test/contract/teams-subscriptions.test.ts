import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { GRAPH_BASE_URL, createTeamsGraph } from '../../src/adapters/teams/graph.ts';
import { readTeamsMode, teamsModeKey, writeTeamsMode } from '../../src/adapters/teams/conversations.ts';
import {
  MAX_VALIDATION_TOKEN,
  REDUCED_RETRY_MS,
  SUBSCRIPTION_LIFETIME_MS,
  createTeamsSubscriptions,
  subscriptionIdKey,
  subscriptionKey,
  subscriptionSince,
  teamIdsInMap,
  type TeamsSubscriptions,
} from '../../src/adapters/teams/subscriptions.ts';

const G = GRAPH_BASE_URL;
const CLIENT_STATE = 'client-state-secret';
const NOTIFY = 'https://snapwing.example.com/teams/notifications';
const LIFECYCLE = 'https://snapwing.example.com/teams/lifecycle';
const MIN = 60_000;

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let store: StateStore;
let cache: CachePort;
let clock = Date.parse('2026-10-03T10:00:00Z');
let nextId = 1;
let created: Record<string, unknown>[];
let renewed: { id: string; body: Record<string, unknown> }[];
let subs: TeamsSubscriptions;

beforeEach(async () => {
  tdb = await createTestDatabase();
  store = (await tdb.open()) as unknown as StateStore;
  cache = createKvCache(store);
  clock = Date.parse('2026-10-03T10:00:00Z');
  nextId = 1;
  created = [];
  renewed = [];
  subs = createTeamsSubscriptions({
    graph: createTeamsGraph({ token: 'graph-token' }),
    cache,
    notificationUrl: NOTIFY,
    lifecycleUrl: LIFECYCLE,
    clientState: CLIENT_STATE,
    now: () => new Date(clock),
  });
});

afterEach(async () => {
  server.resetHandlers();
  await tdb.drop();
});

/** A Graph that grants subscriptions: create returns an id and the requested expiry, renew echoes it. */
function grantingGraph(): void {
  server.use(
    http.post(`${G}/subscriptions`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      return HttpResponse.json({ id: `sub-${String(nextId++)}`, ...body }, { status: 201 });
    }),
    http.patch(`${G}/subscriptions/:id`, async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      renewed.push({ id: String(params['id']), body });
      return HttpResponse.json({ id: params['id'], resource: 'r', changeType: 'created,updated', notificationUrl: NOTIFY, ...body });
    }),
  );
}

const forbidden = () =>
  HttpResponse.json({ error: { code: 'Forbidden', message: 'Insufficient privileges to complete the operation.' } }, { status: 403 });

const iso = (ms: number): string => new Date(ms).toISOString();

describe('create and renew', () => {
  it('creates one subscription per team on getAllMessages and keeps its state in kv', async () => {
    grantingGraph();
    const out = await subs.ensure('T1');
    expect(out).toMatchObject({ kind: 'created', teamId: 'T1', id: 'sub-1' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      resource: '/teams/T1/channels/getAllMessages',
      changeType: 'created,updated',
      notificationUrl: NOTIFY,
      lifecycleNotificationUrl: LIFECYCLE,
      clientState: CLIENT_STATE,
    });
    const expires = Date.parse(String(created[0]?.['expirationDateTime']));
    expect(expires - clock).toBe(SUBSCRIPTION_LIFETIME_MS);
    expect(expires - clock).toBeLessThanOrEqual(60 * MIN);
    expect(JSON.parse((await cache.get(subscriptionKey('T1'))) ?? '')).toEqual({ id: 'sub-1', expiresAt: iso(expires), since: iso(clock) });
    expect(await cache.get(subscriptionIdKey('sub-1'))).toBe('T1');
    expect((await subs.mode('T1')).mode).toBe('full');
  });

  it('keeps separate subscriptions for separate teams and none duplicated for one team', async () => {
    grantingGraph();
    const outs = await subs.ensureAll(['T1', 'T2', 'T1']);
    expect(outs.map((o) => o.kind)).toEqual(['created', 'created', 'active']);
    // ensureAll runs the teams in parallel, so the requests arrive in either order.
    expect(created.map((c) => String(c['resource'])).sort()).toEqual(['/teams/T1/channels/getAllMessages', '/teams/T2/channels/getAllMessages']);
  });

  it('leaves a fresh subscription alone and renews at 45 minutes', async () => {
    grantingGraph();
    await subs.ensure('T1');
    clock += 44 * MIN;
    expect((await subs.ensure('T1')).kind).toBe('active');
    expect(renewed).toEqual([]);
    clock += 1 * MIN;
    const out = await subs.ensure('T1');
    expect(out).toMatchObject({ kind: 'renewed', id: 'sub-1' });
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.id).toBe('sub-1');
    expect(Date.parse(String(renewed[0]?.body['expirationDateTime'])) - clock).toBe(SUBSCRIPTION_LIFETIME_MS);
    clock += 44 * MIN;
    expect((await subs.ensure('T1')).kind).toBe('active');
    expect(created).toHaveLength(1);
  });

  it("keeps when the team's notifications started across renewals and a recreation", async () => {
    grantingGraph();
    const start = clock;
    await subs.ensure('T1');
    clock += 45 * MIN;
    expect((await subs.ensure('T1')).kind).toBe('renewed');
    expect(await subscriptionSince(cache, 'T1')).toBe(iso(start));
    await subs.handleLifecycle({ value: [{ subscriptionId: 'sub-1', lifecycleEvent: 'subscriptionRemoved', clientState: CLIENT_STATE }] });
    expect(JSON.parse((await cache.get(subscriptionKey('T1'))) ?? '')).toMatchObject({ id: 'sub-2', since: iso(start) });
    expect(await subscriptionSince(cache, 'T2')).toBeUndefined();
  });

  it('recreates when Graph no longer knows the subscription on renew', async () => {
    grantingGraph();
    await subs.ensure('T1');
    server.use(http.patch(`${G}/subscriptions/:id`, () => HttpResponse.json({ error: { code: 'ResourceNotFound', message: 'gone' } }, { status: 404 })));
    clock += 50 * MIN;
    const out = await subs.ensure('T1');
    expect(out).toMatchObject({ kind: 'created', id: 'sub-2' });
    expect(await cache.get(subscriptionIdKey('sub-2'))).toBe('T1');
  });

  it('reports a rate limit as retry and an unexpected failure through onError, never a throw', async () => {
    const seen: unknown[] = [];
    const quiet = createTeamsSubscriptions({
      graph: createTeamsGraph({ token: 't' }),
      cache,
      notificationUrl: NOTIFY,
      lifecycleUrl: LIFECYCLE,
      clientState: CLIENT_STATE,
      now: () => new Date(clock),
      onError: (_team, error) => seen.push(error),
    });
    server.use(http.post(`${G}/subscriptions`, () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '7' } })));
    expect(await quiet.ensure('T1')).toEqual({ kind: 'retry', teamId: 'T1', afterMs: 7000 });
    server.use(http.post(`${G}/subscriptions`, () => HttpResponse.json({ error: { code: 'x', message: 'boom' } }, { status: 500 })));
    expect((await quiet.ensure('T1')).kind).toBe('error');
    expect(seen).toHaveLength(1);
  });

  it('names the team ids of a map once each', () => {
    const channel = (id: string, platform: 'slack' | 'teams', teamId?: string) => ({ id, platform, ...(teamId ? { teamId } : {}) });
    const map = { channels: [channel('a', 'slack'), channel('b', 'teams', 'T1'), channel('c', 'teams', 'T1'), channel('d', 'teams', 'T2')] };
    expect(teamIdsInMap(map as never)).toEqual(['T1', 'T2']);
  });
});

describe('lifecycle', () => {
  const lifecycle = (event: string, subscriptionId: string, clientState = CLIENT_STATE) => ({
    value: [{ subscriptionId, lifecycleEvent: event, clientState, resource: 'teams/getAllMessages', tenantId: 'tenant' }],
  });

  it('reauthorizationRequired renews even when the subscription is fresh', async () => {
    grantingGraph();
    await subs.ensure('T1');
    const out = await subs.handleLifecycle(lifecycle('reauthorizationRequired', 'sub-1'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'reauthorized', subscriptionId: 'sub-1', outcome: { kind: 'renewed', teamId: 'T1' } });
    expect(renewed.map((r) => r.id)).toEqual(['sub-1']);
  });

  it('subscriptionRemoved creates a new subscription for the same team', async () => {
    grantingGraph();
    await subs.ensure('T1');
    const out = await subs.handleLifecycle(lifecycle('subscriptionRemoved', 'sub-1'));
    expect(out[0]).toMatchObject({ kind: 'recreated', outcome: { kind: 'created', teamId: 'T1', id: 'sub-2' } });
    expect(created).toHaveLength(2);
    expect(JSON.parse((await cache.get(subscriptionKey('T1'))) ?? '')).toMatchObject({ id: 'sub-2' });
  });

  it('reports missed and unknown subscriptions, and drops a forged lifecycle notification', async () => {
    grantingGraph();
    await subs.ensure('T1');
    expect(await subs.handleLifecycle(lifecycle('missed', 'sub-1'))).toEqual([{ kind: 'missed', subscriptionId: 'sub-1' }]);
    expect(await subs.handleLifecycle(lifecycle('subscriptionRemoved', 'sub-zzz'))).toEqual([
      { kind: 'unknown-subscription', subscriptionId: 'sub-zzz' },
    ]);
    expect(await subs.handleLifecycle(lifecycle('subscriptionRemoved', 'sub-1', 'forged'))).toEqual([]);
    expect(created).toHaveLength(1);
  });
});

describe('reduced mode (a missing RSC grant)', () => {
  it('marks the team reduced on 403, retries hourly, and lifts the mode when the grant appears', async () => {
    let calls = 0;
    server.use(
      http.post(`${G}/subscriptions`, () => {
        calls++;
        return forbidden();
      }),
    );
    const out = await subs.ensure('T1');
    expect(out).toEqual({ kind: 'reduced', teamId: 'T1', reason: 'missing ChannelMessage.Read.Group', retryAt: iso(clock + REDUCED_RETRY_MS) });
    expect(calls).toBe(1);
    const mode = JSON.parse((await cache.get(teamsModeKey('T1'))) ?? '');
    expect(mode).toMatchObject({ mode: 'reduced', since: iso(clock), retryAt: iso(clock + REDUCED_RETRY_MS) });
    expect(await subs.mode('T1')).toMatchObject({ mode: 'reduced' });

    // Inside the hour: no Graph call.
    clock += 59 * MIN;
    expect((await subs.ensure('T1')).kind).toBe('reduced');
    expect(calls).toBe(1);

    // At the hour: retried, still 403, still reduced, retry pushed out, `since` kept.
    clock += 1 * MIN;
    expect((await subs.ensure('T1')).kind).toBe('reduced');
    expect(calls).toBe(2);
    expect(await subs.mode('T1')).toMatchObject({ mode: 'reduced', since: iso(clock - 60 * MIN), retryAt: iso(clock + REDUCED_RETRY_MS) });

    // The grant appears: the next hourly retry creates the subscription and lifts reduced mode.
    grantingGraph();
    clock += 60 * MIN;
    expect(await subs.ensure('T1')).toMatchObject({ kind: 'created', id: 'sub-1' });
    expect(await subs.mode('T1')).toEqual({ mode: 'full', since: iso(clock) });
  });

  it('drops to reduced when a renew is refused, and treats 402 (metered) the same way', async () => {
    grantingGraph();
    await subs.ensure('T1');
    server.use(http.patch(`${G}/subscriptions/:id`, forbidden));
    clock += 50 * MIN;
    expect((await subs.ensure('T1')).kind).toBe('reduced');
    expect(await cache.get(subscriptionKey('T1'))).toBe('');

    server.use(http.post(`${G}/subscriptions`, () => HttpResponse.json({ error: { code: 'PaymentRequired', message: 'metered' } }, { status: 402 })));
    expect(await subs.ensure('T2')).toMatchObject({ kind: 'reduced', reason: 'metered API not enabled' });
  });

  it('one team being reduced does not stop another', async () => {
    server.use(
      http.post(`${G}/subscriptions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (String(body['resource']).includes('/T1/')) return forbidden();
        return HttpResponse.json({ id: 'sub-ok', ...body }, { status: 201 });
      }),
    );
    const outs = await subs.ensureAll(['T1', 'T2']);
    expect(outs.map((o) => o.kind)).toEqual(['reduced', 'created']);
  });
});

describe('validation and clientState', () => {
  it('echoes the validationToken as text/plain and ignores anything else', async () => {
    const res = subs.handleValidation(new Request(`${NOTIFY}?validationToken=${encodeURIComponent('Validation: Testing client application reachability')}`, { method: 'POST' }));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('text/plain');
    expect(await res?.text()).toBe('Validation: Testing client application reachability');
    expect(subs.handleValidation(new Request(NOTIFY, { method: 'POST' }))).toBeUndefined();
  });

  it('echoes at most MAX_VALIDATION_TOKEN printable characters, with nosniff; anything else is a 400 (#269)', async () => {
    const answer = (token: string) => subs.handleValidation(new Request(`${NOTIFY}?validationToken=${encodeURIComponent(token)}`, { method: 'POST' }));
    const longest = 'v'.repeat(MAX_VALIDATION_TOKEN);
    const ok = answer(longest);
    expect(ok?.status).toBe(200);
    expect(await ok?.text()).toBe(longest);
    expect(ok?.headers.get('x-content-type-options')).toBe('nosniff');
    for (const token of [`${longest}v`, '<b>\r\n</b>', 'tab\there', '\u202eevil', '']) {
      const res = answer(token);
      expect(res?.status).toBe(400);
      expect(await res?.text()).toBe('');
      expect(res?.headers.get('content-type')).toContain('text/plain');
      expect(res?.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  const change = (clientState: unknown, id = 'sub-1', resource = "teams('T1')/channels('C1')/messages('M1')") => ({
    subscriptionId: id,
    changeType: 'updated',
    clientState,
    resource,
    tenantId: 'tenant',
  });

  it('keeps notifications with our clientState and parses the resource', () => {
    const body = {
      value: [change(CLIENT_STATE), change(CLIENT_STATE, 'sub-1', "teams('T1')/channels('C1')/messages('M1')/replies('R1')")],
    };
    expect(subs.verifyNotification(body)).toEqual([
      { subscriptionId: 'sub-1', changeType: 'updated', resource: "teams('T1')/channels('C1')/messages('M1')", teamId: 'T1', channelId: 'C1', messageId: 'M1' },
      {
        subscriptionId: 'sub-1',
        changeType: 'updated',
        resource: "teams('T1')/channels('C1')/messages('M1')/replies('R1')",
        teamId: 'T1',
        channelId: 'C1',
        messageId: 'M1',
        replyId: 'R1',
      },
    ]);
  });

  it('drops a forged clientState, a missing one, near misses, and malformed bodies', () => {
    const body = {
      value: [
        change('forged'),
        change(undefined),
        change(null),
        change(42),
        change(`${CLIENT_STATE} `),
        change(CLIENT_STATE.slice(0, -1)),
        change(CLIENT_STATE.toUpperCase()),
        change(CLIENT_STATE),
        { clientState: CLIENT_STATE },
        'junk',
        null,
      ],
    };
    expect(subs.verifyNotification(body)).toHaveLength(1);
    expect(subs.verifyNotification({ value: [change('forged')] })).toEqual([]);
    expect(subs.verifyNotification({})).toEqual([]);
    expect(subs.verifyNotification(null)).toEqual([]);
    expect(subs.verifyNotification('x')).toEqual([]);
  });
});

describe('one written format for teams-mode', () => {
  it('both writers write the shared JSON shape', async () => {
    server.use(http.post(`${G}/subscriptions`, forbidden));
    await subs.ensure('T1');
    expect(JSON.parse((await cache.get(teamsModeKey('T1'))) ?? '')).toEqual({ mode: 'reduced', since: iso(clock), retryAt: iso(clock + REDUCED_RETRY_MS), reason: 'missing ChannelMessage.Read.Group' });

    await writeTeamsMode(cache, 'T2', 'reduced', { since: iso(clock) });
    expect(JSON.parse((await cache.get(teamsModeKey('T2'))) ?? '')).toEqual({ mode: 'reduced', since: iso(clock) });
    await writeTeamsMode(cache, 'T2', 'full', { since: iso(clock) });
    expect(JSON.parse((await cache.get(teamsModeKey('T2'))) ?? '')).toEqual({ mode: 'full', since: iso(clock) });
  });

  it('still reads a row written as the old bare string', async () => {
    await cache.set(teamsModeKey('T1'), 'reduced');
    expect(await readTeamsMode(cache, 'T1')).toBe('reduced');
    expect(await subs.mode('T1')).toMatchObject({ mode: 'reduced' });
    await cache.set(teamsModeKey('T1'), 'full');
    expect(await readTeamsMode(cache, 'T1')).toBe('full');
    expect(await subs.mode('T1')).toMatchObject({ mode: 'full' });
  });

  it("lifts a reduced mark set by either path with the other path's full write", async () => {
    // The subscriptions mark reduced; the mode check writes full.
    server.use(http.post(`${G}/subscriptions`, forbidden));
    await subs.ensure('T1');
    expect(await readTeamsMode(cache, 'T1')).toBe('reduced');
    await writeTeamsMode(cache, 'T1', 'full');
    expect((await subs.mode('T1')).mode).toBe('full');

    // The mode check marks reduced; the next subscription that succeeds writes full.
    await writeTeamsMode(cache, 'T2', 'reduced');
    expect((await subs.mode('T2')).mode).toBe('reduced');
    grantingGraph();
    expect(await subs.ensure('T2')).toMatchObject({ kind: 'created' });
    expect(await readTeamsMode(cache, 'T2')).toBe('full');
  });
});
