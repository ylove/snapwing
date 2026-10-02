// Fixer reporting API (#132; B 9, B 0, main 10.4, main 16). The routes run behind a real `node:http`
// listener (a minimal stand-in for the ADR 0016 server) and the tests call them with `fetch`, over
// the dialect `SNAPWING_DB` selects. Tokens use a fake secret; the clock is a variable.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { handleFixerDone, handleFixerFailed, type FixerDeps } from '@snapwing/pipeline/fixer/job.ts';
import type { OpenedState, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createFixerReporter, type FixerHookContext, type FixerReporterDeps } from '../../src/fixer-api/reporter.ts';
import { createFixerRoutes, type FixerRoute } from '../../src/fixer-api/routes.ts';
import {
  fixerTokenKeysFromEnv,
  fixerTokenVerifier,
  issueFixerToken,
  verifyFixerToken,
  type FixerTokenKeys,
} from '../../src/fixer-api/token.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const MINUTE = 60_000;
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6FIXERAPI00000000000000';
const OTHER_INC = '01K6FIXERAPI0000000000000B';
const FAKE_SECRET = 'fake-fixer-token-secret-for-tests-only-0000';
const RUN = 'run-1';

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let keys: FixerTokenKeys;
let server: Server | undefined;
let base: string;
let hooks: { done: FixerHookContext[]; failed: FixerHookContext[] };

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
  keys = { secret: FAKE_SECRET, clock: () => new Date(now) };
  hooks = { done: [], failed: [] };
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
  await tdb.drop();
});

// HTTP --------------------------------------------------------------------------------------------

/** Serves `routes` on a free port: `:name` segments become `ctx.params`, as the ADR 0016 router does. */
async function serve(routes: FixerRoute[]): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const parts = url.pathname.split('/').filter((p) => p !== '');
        let response = new Response('not found', { status: 404 });
        for (const route of routes) {
          const segs = route.path.split('/').filter((p) => p !== '');
          if (route.method !== req.method || segs.length !== parts.length) continue;
          const params: Record<string, string> = {};
          if (!segs.every((s, i) => (s.startsWith(':') ? ((params[s.slice(1)] = decodeURIComponent(parts[i] ?? '')), true) : s === parts[i]))) continue;
          const body = req.method === 'GET' ? null : Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          response = await route.handler(new Request(url, { method: req.method ?? 'GET', headers, body }), { params });
          break;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

async function start(opts: { state?: StatePort; deps?: Partial<FixerReporterDeps> } = {}): Promise<void> {
  const reporter = createFixerReporter({
    state: opts.state ?? state,
    clock: () => new Date(now),
    onDone: async (c) => void hooks.done.push(c),
    onFailed: async (c) => void hooks.failed.push(c),
    ...opts.deps,
  });
  await serve(createFixerRoutes(reporter, fixerTokenVerifier(keys)));
}

function token(workItemId = INC, incidentId = INC, ttl = 'PT45M'): string {
  return issueFixerToken({ workItemId, incidentId, ttl }, keys);
}

async function call(
  op: string,
  body?: unknown,
  opts: { token?: string | null; workItem?: string; rawBody?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const t = opts.token === undefined ? token() : opts.token;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (t !== null) headers['authorization'] = `Bearer ${t}`;
  const res = await fetch(`${base}/fixer/${opts.workItem ?? INC}/${op}`, {
    method: op === 'stop' ? 'GET' : 'POST',
    headers,
    ...(op === 'stop' ? {} : { body: opts.rawBody ?? JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

// Log ---------------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' = 'agent', incidentId = INC): NewEvent<T> {
  return { workspaceId: WS, incidentId, type, v: 1, source, occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

/** An incident filed at level 3 with a fixer run going. */
async function seedRunning(incidentId = INC): Promise<void> {
  const request = { artifactId: '01K6REQUEST000000000000001', version: 1 };
  await appendTo(incidentId, [
    ev(
      'captured',
      {
        kind: 'incident',
        idempotencyKey: `slack:C-FAKE:${incidentId}`,
        source: 'slack',
        reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
        anchorText: 'Checkout says 500',
        channelId: 'C-FAKE',
      },
      'agent',
      incidentId,
    ),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }, 'agent', incidentId),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }, 'agent', incidentId),
    ev('dedupe-checked', { candidates: [], decision: 'none' }, 'agent', incidentId),
    ev(
      'planned',
      {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary: 'Checkout returns 500 on submit',
        priority: 'High',
        labels: ['snapwing'],
        autonomyLevel: 3,
        implementationRequest: request,
      },
      'agent',
      incidentId,
    ),
    ev('filed', { jiraKey: 'WEB-1042' }, 'agent', incidentId),
    ev('fixer-started', { runId: RUN, harness: 'claude-code', attempt: 1 }, 'agent', incidentId),
  ]);
}

async function appendTo(incidentId: string, events: NewEvent[]): Promise<void> {
  const last = (await state.read(incidentId)).at(-1)?.seq ?? 0;
  await state.append(incidentId, events, last);
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function types(): Promise<EventType[]> {
  return (await log()).map((e) => e.type);
}

// Tokens ------------------------------------------------------------------------------------------

describe('fixer tokens', () => {
  it('round-trips and carries the incident', () => {
    const v = verifyFixerToken(token(INC, OTHER_INC), INC, keys);
    expect(v).toEqual({
      ok: true,
      claims: { workItemId: INC, incidentId: OTHER_INC, issuedAt: new Date(T0), expiresAt: new Date(T0 + 45 * MINUTE) },
    });
  });

  it('rejects a token for one work item on another', () => {
    expect(verifyFixerToken(token(INC), OTHER_INC, keys)).toEqual({ ok: false, reason: 'wrong-work-item' });
  });

  it('rejects at expiry, not before', () => {
    const t = token(INC, INC, 'PT10M');
    now = T0 + 10 * MINUTE - 1;
    expect(verifyFixerToken(t, INC, keys).ok).toBe(true);
    now = T0 + 10 * MINUTE;
    expect(verifyFixerToken(t, INC, keys)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a forged MAC, edited claims, another secret, and junk', () => {
    const t = token();
    const [prefix, claims, mac] = t.split('.') as [string, string, string];
    const flipped = `${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyFixerToken(`${prefix}.${claims}.${flipped}`, INC, keys)).toEqual({ ok: false, reason: 'bad-signature' });
    const edited = Buffer.from(JSON.stringify({ w: INC, i: OTHER_INC, iat: T0, exp: T0 + 10 * MINUTE })).toString('base64url');
    expect(verifyFixerToken(`${prefix}.${edited}.${mac}`, INC, keys)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyFixerToken(t, INC, { ...keys, secret: `${FAKE_SECRET}-other` })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyFixerToken(`${prefix}.${claims}.${mac.slice(0, 10)}`, INC, keys)).toEqual({ ok: false, reason: 'bad-signature' });
    for (const junk of ['', 'abc', 'swf1..', 'jwt.a.b', `${t}.extra`, 'swf1.a+b.c']) {
      expect(verifyFixerToken(junk, INC, keys)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a short or missing secret and an over-long TTL', () => {
    expect(() => issueFixerToken({ workItemId: INC, incidentId: INC, ttl: 'PT1M' }, { ...keys, secret: 'short' })).toThrow(/at least 32/);
    expect(() => fixerTokenKeysFromEnv({}, keys.clock)).toThrow(/SNAPWING_FIXER_TOKEN_SECRET is not set/);
    expect(fixerTokenKeysFromEnv({ SNAPWING_FIXER_TOKEN_SECRET: FAKE_SECRET }, keys.clock).secret).toBe(FAKE_SECRET);
    expect(() => token(INC, INC, 'P2D')).toThrow(RangeError);
  });
});

// Endpoints ---------------------------------------------------------------------------------------

describe('fixer API over HTTP', () => {
  it('checkpoint appends fixer-checkpoint from the fixer and drops unknown keys', async () => {
    await seedRunning();
    await start();
    const r = await call('checkpoint', { phase: 'branched', detail: 'fix/WEB-1042', injected: { role: 'admin' }, source: 'agent' });
    expect(r).toEqual({ status: 200, json: { seq: 8 } });
    const e = (await log()).at(-1);
    expect(e?.type).toBe('fixer-checkpoint');
    expect(e?.source).toBe('fixer');
    expect(e?.actor).toBeUndefined();
    expect(e?.payload).toEqual({ phase: 'branched', detail: 'fix/WEB-1042' });
  });

  it('rejects an invalid body or bad JSON with 400 and appends nothing', async () => {
    await seedRunning();
    await start();
    const before = (await log()).length;
    expect(await call('checkpoint', { phase: 'deployed' })).toMatchObject({ status: 400, json: { error: 'invalid', field: 'phase' } });
    expect(await call('checkpoint', ['cloned'])).toMatchObject({ status: 400, json: { field: 'body' } });
    expect(await call('done', { prNumber: 0, branch: 'fix/x' })).toMatchObject({ status: 400, json: { field: 'prNumber' } });
    expect(await call('done', { prNumber: 7, branch: 'fix/../x' })).toMatchObject({ status: 400, json: { field: 'branch' } });
    expect(await call('done', { prNumber: 7, branch: 'fix/x', testsAdded: ['a.test.ts', 3] })).toMatchObject({
      status: 400,
      json: { field: 'testsAdded[1]' },
    });
    expect(await call('failed', { reason: 'tests red' })).toMatchObject({ status: 400, json: { field: 'attempts' } });
    expect(await call('artifact', { kind: 'review', body: '<x/>' })).toMatchObject({ status: 400, json: { field: 'kind' } });
    expect(await call('checkpoint', undefined, { rawBody: '{not json' })).toEqual({ status: 400, json: { error: 'invalid-json' } });
    expect((await log()).length).toBe(before);
  });

  it('artifact stores the body as a new artifact version, then appends fixer-artifact', async () => {
    await seedRunning();
    await start();
    const first = await call('artifact', { kind: 'diagnosis', body: '<diagnosis>null cart</diagnosis>', extra: 'dropped' });
    expect(first.status).toBe(200);
    const ref1 = (first.json as { artifact: { artifactId: string; version: number } }).artifact;
    expect(ref1.version).toBe(1);
    const second = await call('artifact', { kind: 'diagnosis', body: '{"cause":"null cart"}', contentType: 'application/json' });
    const ref2 = (second.json as { artifact: { artifactId: string; version: number } }).artifact;
    expect(ref2).toEqual({ artifactId: ref1.artifactId, version: 2 });
    const contract = await call('artifact', { kind: 'contract', body: '<contract/>' });
    expect((contract.json as { artifact: { artifactId: string } }).artifact.artifactId).not.toBe(ref1.artifactId);

    const stored = await state.getArtifact(ref1.artifactId, 1);
    expect(stored).toMatchObject({ kind: 'diagnosis', contentType: 'application/xml', body: '<diagnosis>null cart</diagnosis>', createdBy: `fixer:${RUN}` });
    expect((await state.getArtifact(ref1.artifactId)).contentType).toBe('application/json');
    const events = (await log()).filter((e): e is IncidentEvent<'fixer-artifact'> => e.type === 'fixer-artifact');
    expect(events.map((e) => e.payload)).toEqual([
      { kind: 'diagnosis', artifact: ref1 },
      { kind: 'diagnosis', artifact: ref2 },
      { kind: 'contract', artifact: (contract.json as { artifact: unknown }).artifact },
    ]);
  });

  it('done appends fixer-done and pr-opened together and calls onDone; a duplicate done is 409', async () => {
    await seedRunning();
    await start();
    const body = { prNumber: 7, branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: ['test/cart.test.ts'], token: 'x' };
    expect(await call('done', body)).toEqual({ status: 200, json: { seq: 9 } });
    const tail = (await log()).slice(-2);
    expect(tail.map((e) => [e.seq, e.type, e.source])).toEqual([
      [8, 'fixer-done', 'fixer'],
      [9, 'pr-opened', 'fixer'],
    ]);
    expect(tail[0]?.payload).toEqual({ prNumber: 7, branch: 'fix/WEB-1042', summary: 'Guard the null cart', testsAdded: ['test/cart.test.ts'] });
    expect(tail[1]?.payload).toEqual({ prNumber: 7, branch: 'fix/WEB-1042' });
    expect(hooks.done).toEqual([{ workItemId: INC, incidentId: INC, runId: RUN, seq: 8 }]);

    expect(await call('done', body)).toEqual({ status: 409, json: { error: 'run-finished' } });
    expect((await log()).length).toBe(9);
    // The duplicate re-runs the idempotent hook, so a crash between append and hook heals.
    expect(hooks.done).toHaveLength(2);
    expect(await call('checkpoint', { phase: 'pushed' })).toEqual({ status: 409, json: { error: 'run-finished' } });
    expect(hooks.failed).toEqual([]);
  });

  it('failed appends fixer-failed and calls onFailed, which handleFixerFailed can be', async () => {
    await seedRunning();
    const wf = new InProcessWorkflow(state);
    const marked: string[] = [];
    const fixerDeps: FixerDeps = {
      workspaceId: WS,
      state,
      workflow: wf,
      runner: { runFixer: () => Promise.reject(new Error('unused')), cancel: () => Promise.resolve() },
      github: { markIncomplete: async (b) => void marked.push(b), closePr: () => Promise.resolve() },
      config: { harness: { adapter: 'claude-code' } },
      clock: () => new Date(now),
    };
    await start({
      deps: {
        onDone: (c) => handleFixerDone(fixerDeps, c.incidentId),
        onFailed: async (c) => void (await handleFixerFailed(fixerDeps, c.incidentId)),
      },
    });
    try {
      const r = await call('failed', { reason: 'tests still red', partialBranch: 'fix/WEB-1042', attempts: 3, stack: '...' });
      expect(r).toEqual({ status: 200, json: { seq: 8 } });
      const events = await log();
      expect(events[7]).toMatchObject({ type: 'fixer-failed', source: 'fixer', payload: { reason: 'tests still red', partialBranch: 'fix/WEB-1042', attempts: 3 } });
      expect(events[7]?.payload).not.toHaveProperty('stack');
      expect(events[8]).toMatchObject({ type: 'level-changed', payload: { from: 3, to: 2 } });
      expect(marked).toEqual(['fix/WEB-1042']);

      // A duplicate is refused; the hook runs again and, being idempotent, does nothing more.
      expect(await call('failed', { reason: 'tests still red', attempts: 3 })).toEqual({ status: 409, json: { error: 'run-finished' } });
      expect((await log()).length).toBe(9);
      expect(marked).toEqual(['fix/WEB-1042']);
    } finally {
      await wf.stop();
    }
  });

  it('stop is 200 { stop: false } while running and 204 once a stopped follows the run', async () => {
    await seedRunning();
    await start();
    expect(await call('stop')).toEqual({ status: 200, json: { stop: false } });
    await appendTo(INC, [ev('stopped', { reason: 'wrong approach' })]);
    expect(await call('stop')).toEqual({ status: 204, json: undefined });
    // The stop ended the run: reports are refused and append nothing.
    const before = (await log()).length;
    expect(await call('checkpoint', { phase: 'pushed' })).toEqual({ status: 409, json: { error: 'run-finished' } });
    expect((await log()).length).toBe(before);
  });

  it('refuses every report on a closed incident with 409 and appends nothing', async () => {
    await seedRunning();
    await appendTo(INC, [ev('closed', { reason: 'duplicate of WEB-1001' })]);
    await start();
    const before = (await log()).length;
    for (const [op, body] of [
      ['checkpoint', { phase: 'pushed' }],
      ['artifact', { kind: 'diagnosis', body: '<d/>' }],
      ['done', { prNumber: 7, branch: 'fix/WEB-1042' }],
      ['failed', { reason: 'r', attempts: 1 }],
      ['stop', undefined],
    ] as const) {
      expect(await call(op, body)).toEqual({ status: 409, json: { error: 'incident-closed' } });
    }
    expect((await log()).length).toBe(before);
    expect(hooks).toEqual({ done: [], failed: [] });
  });

  it('answers 404 for an incident with no log', async () => {
    await start();
    expect(await call('checkpoint', { phase: 'cloned' })).toEqual({ status: 404, json: { error: 'unknown-incident' } });
    expect(await call('stop')).toEqual({ status: 404, json: { error: 'unknown-incident' } });
  });

  it('rejects a missing, forged, or expired token with 401 and another work item with 403', async () => {
    await seedRunning();
    await seedRunning(OTHER_INC);
    await start();
    const before = (await log()).length;
    expect(await call('checkpoint', { phase: 'cloned' }, { token: null })).toEqual({ status: 401, json: { error: 'unauthorized', reason: 'missing-token' } });
    const forged = issueFixerToken({ workItemId: INC, incidentId: INC, ttl: 'PT45M' }, { ...keys, secret: `${FAKE_SECRET}-attacker` });
    expect(await call('checkpoint', { phase: 'cloned' }, { token: forged })).toEqual({ status: 401, json: { error: 'unauthorized', reason: 'bad-signature' } });
    expect(await call('stop', undefined, { token: 'not-a-token' })).toEqual({ status: 401, json: { error: 'unauthorized', reason: 'malformed' } });

    const short = token(INC, INC, 'PT5M');
    now = T0 + 5 * MINUTE;
    expect(await call('checkpoint', { phase: 'cloned' }, { token: short })).toEqual({ status: 401, json: { error: 'unauthorized', reason: 'expired' } });

    // OTHER_INC's token on INC's path, and INC's token on OTHER_INC's path.
    expect(await call('checkpoint', { phase: 'cloned' }, { token: token(OTHER_INC, OTHER_INC) })).toEqual({ status: 403, json: { error: 'forbidden' } });
    expect(await call('done', { prNumber: 1, branch: 'fix/a' }, { workItem: OTHER_INC })).toEqual({ status: 403, json: { error: 'forbidden' } });
    expect((await log()).length).toBe(before);
    expect((await state.read(OTHER_INC)).length).toBe(7);
  });

  it('retries an expectedSeq conflict from a fresh read', async () => {
    await seedRunning();
    const racer = racingState(state, () => [ev('fixer-checkpoint', { phase: 'cloned', detail: 'from a racing request' }, 'fixer')]);
    await start({ state: racer.state });
    expect(await call('checkpoint', { phase: 'branched', detail: 'fix/WEB-1042' })).toEqual({ status: 200, json: { seq: 9 } });
    expect(racer.conflicts).toBe(1);
    const tail = (await log()).slice(-2);
    expect(tail.map((e) => [e.seq, e.payload])).toEqual([
      [8, { phase: 'cloned', detail: 'from a racing request' }],
      [9, { phase: 'branched', detail: 'fix/WEB-1042' }],
    ]);
  });

  it('decides again after a conflict: a stop that wins the race refuses the report', async () => {
    await seedRunning();
    const racer = racingState(state, () => [ev('stopped', {})]);
    await start({ state: racer.state });
    expect(await call('done', { prNumber: 7, branch: 'fix/WEB-1042' })).toEqual({ status: 409, json: { error: 'run-finished' } });
    expect(racer.conflicts).toBe(1);
    expect((await types()).slice(-2)).toEqual(['fixer-started', 'stopped']);
    expect(hooks.done).toEqual([]);
  });
});

/**
 * A StatePort whose first `append` loses a race: another writer appends `racing()` at the same seq
 * just before it, so the reporter's append conflicts and must re-read.
 */
function racingState(inner: OpenedState, racing: () => NewEvent[]): { state: StatePort; conflicts: number } {
  const out = { state: inner as StatePort, conflicts: 0 };
  let raced = false;
  out.state = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'append') {
        return async (incidentId: string, events: NewEvent[], expectedSeq: number) => {
          if (!raced) {
            raced = true;
            await target.append(incidentId, racing(), expectedSeq);
            try {
              return await target.append(incidentId, events, expectedSeq);
            } catch (e) {
              out.conflicts++;
              throw e;
            }
          }
          return target.append(incidentId, events, expectedSeq);
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return out;
}
