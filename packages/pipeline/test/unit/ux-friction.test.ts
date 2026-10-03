// UX friction (#306; A 5.3). Real state on the dialect `SNAPWING_DB` selects, a fake clock, a fake
// TTL cache on that clock, and a fake filer. Events are `user-side` rows as #305 records them.

import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPlaybook, type Playbook } from '../../src/config/playbook.ts';
import type { NewEvent } from '../../src/contracts/events.ts';
import type { UserSideKind } from '../../src/contracts/incident.ts';
import type { CachePort } from '../../src/ports/cache.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import {
  bugChannelFor,
  createUxFriction,
  frictionKey,
  type UxFriction,
  type UxFrictionTask,
} from '../../src/signals/ux-friction.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const DAY = 86_400_000;
const WS = '01K6WORKSPACE0000000000000';

const MAP = {
  surfaces: [
    { id: 'web-app', label: 'Web app', repo: 'acme/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [] },
    { id: 'api', label: 'API', repo: 'acme/api', jira: { project: 'API', defaultIssueType: 'Bug' }, components: [] },
  ],
  channels: [
    { id: 'C0INFER', name: '#web-chat', surface: 'web-app', confidence: 'inferred' as const, triggerEmoji: [] },
    { id: 'C0BUGS', name: '#web-bugs', surface: 'web-app', confidence: 'explicit' as const, triggerEmoji: [] },
  ],
};

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let incidentCount: number;
let playbook: Playbook;
let filed: UxFrictionTask[];
let failNext: boolean;
let errors: unknown[];
let sut: UxFriction;
let cacheStore: Map<string, { v: string; until: number }>;

/** A cache whose TTLs run on the fake clock. */
const cache: CachePort = {
  get: (k) => {
    const row = cacheStore.get(k);
    return Promise.resolve(row !== undefined && row.until > now ? row.v : null);
  },
  set: (k, v, ttlSec) => {
    cacheStore.set(k, { v, until: ttlSec === undefined ? Infinity : now + ttlSec * 1000 });
    return Promise.resolve();
  },
  setIfAbsent: (k, v, ttlSec) => {
    const row = cacheStore.get(k);
    if (row !== undefined && row.until > now) return Promise.resolve(false);
    cacheStore.set(k, { v, until: now + ttlSec * 1000 });
    return Promise.resolve(true);
  },
};

function userSide(reporter: string, kind: UserSideKind, surfaceId: string | undefined, at = now): NewEvent<'user-side'> {
  return {
    workspaceId: WS,
    incidentId: `01K6FRICTION${String(incidentCount++).padStart(14, '0')}`,
    v: 1,
    source: 'slack',
    actor: { id: reporter, role: 'human' },
    occurredAt: new Date(at).toISOString(),
    type: 'user-side',
    payload: { kind, evidence: 'URL bar shows staging.example.com', questionSeq: 1, ...(surfaceId === undefined ? {} : { surfaceId }) },
  };
}

/**
 * Appends the events, then waits until `readSince` can return them. On Postgres it withholds events
 * at or above the cluster's oldest in-flight transaction (ADR 0013), and other test files'
 * transactions count; on SQLite there is nothing to wait for.
 */
async function record(...events: NewEvent<'user-side'>[]): Promise<void> {
  for (const e of events) await state.append(e.incidentId, [e], 0);
  if (!(state instanceof StateStore) || state.dialect !== 'postgres') return;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await sql<{ settled: boolean }>`
      select coalesce(max(tx_order) < pg_snapshot_xmin(pg_current_snapshot())::text::bigint, true) as settled from incident_events
    `.execute(state.ctx.db);
    if (rows[0]?.settled === true) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the readSince watermark to pass the log');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  incidentCount = 0;
  state = await tdb.open({ now: () => new Date(now) });
  playbook = defaultPlaybook();
  filed = [];
  errors = [];
  failNext = false;
  cacheStore = new Map();
  sut = createUxFriction({
    state,
    cache,
    clock: () => new Date(now),
    playbook: () => playbook,
    map: () => MAP,
    file: (task) => {
      if (failNext) return Promise.reject(new Error('jira is down'));
      filed.push(task);
      return Promise.resolve();
    },
    onError: (e) => errors.push(e),
  });
});

afterEach(async () => {
  await tdb.drop();
});

describe('threshold and window', () => {
  it('defaults to 3 reporters in P30D', () => {
    expect(playbook.userSide).toMatchObject({ uxFrictionThreshold: 3, uxFrictionWindow: 'P30D' });
  });

  it('files one Task, labeled ux-friction, once the third reporter lands in the window', async () => {
    await record(userSide('U1', 'wrong-environment', 'web-app', now), userSide('U2', 'wrong-environment', 'web-app', now + DAY));
    now += 2 * DAY;
    expect(await sut.scan()).toEqual([]);

    await record(userSide('U3', 'wrong-environment', 'web-app', now));
    const out = await sut.scan();
    expect(out).toHaveLength(1);
    expect(filed).toEqual(out);
    const task = out[0]!;
    expect(task).toMatchObject({
      workspaceId: WS,
      surfaceId: 'web-app',
      kind: 'wrong-environment',
      issueType: 'Task',
      labels: ['ux-friction'],
      channelId: 'C0BUGS',
      channelName: '#web-bugs',
      pattern: { reporters: 3, window: 'P30D' },
    });
    expect(task.summary).toBe('3 reporters landed on a test environment instead of the live site on Web app');
    expect(task.description).toContain('Posted to #web-bugs.');
  });

  it('names no one: no reporter id appears anywhere in the Task', async () => {
    await record(userSide('U0ALICE', 'stale-cache', 'api'), userSide('U0BOB', 'stale-cache', 'api'), userSide('U0CAROL', 'stale-cache', 'api'));
    const [task] = await sut.scan();
    const text = JSON.stringify(task);
    for (const id of ['U0ALICE', 'U0BOB', 'U0CAROL']) expect(text).not.toContain(id);
    expect(task?.channelId).toBeUndefined();
  });

  it('counts reporters, not taps: one reporter three times is one', async () => {
    await record(userSide('U1', 'network', 'api'), userSide('U1', 'network', 'api'), userSide('U1', 'network', 'api'), userSide('U2', 'network', 'api'));
    expect(await sut.scan()).toEqual([]);
  });

  it('keeps kinds and surfaces apart', async () => {
    await record(
      userSide('U1', 'wrong-environment', 'web-app'),
      userSide('U2', 'stale-cache', 'web-app'),
      userSide('U3', 'wrong-environment', 'api'),
    );
    expect(await sut.scan()).toEqual([]);
  });

  it('ignores events with no surface or no reporter', async () => {
    const anonymous = userSide('U9', 'network', 'api');
    delete anonymous.actor;
    await record(userSide('U1', 'network', undefined), userSide('U2', 'network', undefined), userSide('U3', 'network', undefined), anonymous);
    await record(userSide('U4', 'network', 'api'), userSide('U5', 'network', 'api'));
    expect(await sut.scan()).toEqual([]);
  });

  it('does not count reporters whose events fell out of the window', async () => {
    await record(userSide('U1', 'wrong-environment', 'web-app', T0), userSide('U2', 'wrong-environment', 'web-app', T0 + DAY));
    now = T0 + 31 * DAY;
    await record(userSide('U3', 'wrong-environment', 'web-app', now));
    expect(await sut.scan()).toEqual([]);

    now += DAY;
    await record(userSide('U4', 'wrong-environment', 'web-app', now), userSide('U5', 'wrong-environment', 'web-app', now));
    expect(await sut.scan()).toHaveLength(1);
  });

  it('reads the threshold and the window from the playbook at each scan', async () => {
    playbook = { ...playbook, userSide: { ...playbook.userSide, uxFrictionThreshold: 2, uxFrictionWindow: 'P7D' } };
    await record(userSide('U1', 'network', 'api', T0), userSide('U2', 'network', 'api', T0 + 8 * DAY));
    now = T0 + 9 * DAY;
    expect(await sut.scan()).toEqual([]);
    await record(userSide('U3', 'network', 'api', now));
    expect(await sut.scan()).toHaveLength(1);
  });
});

describe('once per pattern per window', () => {
  async function threeReporters(): Promise<void> {
    await record(userSide('U1', 'wrong-environment', 'web-app'), userSide('U2', 'wrong-environment', 'web-app'), userSide('U3', 'wrong-environment', 'web-app'));
  }

  it('files nothing on a second scan, nor when a fourth reporter arrives in the same window', async () => {
    await threeReporters();
    expect(await sut.scan()).toHaveLength(1);
    expect(await sut.scan()).toEqual([]);
    now += DAY;
    await record(userSide('U4', 'wrong-environment', 'web-app'));
    expect(await sut.scan()).toEqual([]);
    expect(filed).toHaveLength(1);
  });

  it('files a second Task for the same pattern once a full window has passed and it still holds', async () => {
    await threeReporters();
    await sut.scan();
    const at = T0 + 20 * DAY;
    await record(userSide('U4', 'wrong-environment', 'web-app', at), userSide('U5', 'wrong-environment', 'web-app', at), userSide('U6', 'wrong-environment', 'web-app', at));
    now = T0 + 25 * DAY;
    expect(await sut.scan()).toEqual([]);

    now = T0 + 31 * DAY;
    const again = await sut.scan();
    expect(again).toHaveLength(1);
    expect(again[0]?.pattern.reporters).toBe(3);
    expect(filed).toHaveLength(2);
  });

  it('files each pattern on its own', async () => {
    await threeReporters();
    await record(userSide('U1', 'network', 'api'), userSide('U2', 'network', 'api'), userSide('U3', 'network', 'api'));
    const out = await sut.scan();
    expect(out.map((t) => frictionKey(t.surfaceId, t.kind)).sort()).toEqual(['ux-friction:api:network', 'ux-friction:web-app:wrong-environment']);
  });

  it('a fresh instance (a restart) replays the log and does not file again', async () => {
    await threeReporters();
    await sut.scan();
    const restarted = createUxFriction({
      state,
      cache,
      clock: () => new Date(now),
      playbook: () => playbook,
      map: () => MAP,
      file: (task) => {
        filed.push(task);
        return Promise.resolve();
      },
    });
    expect(await restarted.scan()).toEqual([]);
    expect(filed).toHaveLength(1);
  });

  it('a filer that fails is reported and retried on a later scan', async () => {
    await threeReporters();
    failNext = true;
    expect(await sut.scan()).toEqual([]);
    expect(errors).toHaveLength(1);
    failNext = false;
    now += 2000;
    expect(await sut.scan()).toHaveLength(1);
    expect(filed).toHaveLength(1);
  });
});

describe('userSide check="false"', () => {
  it('files nothing and reads nothing, and picks the log up when switched back on', async () => {
    playbook = { ...playbook, userSide: { ...playbook.userSide, check: false } };
    await record(userSide('U1', 'network', 'api'), userSide('U2', 'network', 'api'), userSide('U3', 'network', 'api'));
    expect(await sut.scan()).toEqual([]);
    expect(filed).toEqual([]);

    playbook = { ...playbook, userSide: { ...playbook.userSide, check: true } };
    expect(await sut.scan()).toHaveLength(1);
  });
});

describe('bugChannelFor', () => {
  it('prefers an explicit channel, falls back to an inferred one, and is undefined for none', () => {
    expect(bugChannelFor(MAP, 'web-app')).toEqual({ id: 'C0BUGS', name: '#web-bugs' });
    expect(bugChannelFor({ channels: [MAP.channels[0]!] }, 'web-app')).toEqual({ id: 'C0INFER', name: '#web-chat' });
    expect(bugChannelFor(MAP, 'api')).toBeUndefined();
  });
});
