// Artifacts, webhook inbox, outbox, config cache, and kv (#19; B 1, B 3, B 7.1, B 8). Runs on the
// dialect `SNAPWING_DB` selects; CI runs the file on both SQLite and Postgres.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StateNotFoundError, type NewArtifact, type OutboxItem } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { ConfigWorkspaceAmbiguousError, DEFAULT_WORKSPACE_SLUG } from '../../src/state/config.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ00000000000000000000W1';
const INC = '01JZ0000000000000000000001';
const T0 = Date.parse('2026-10-01T12:00:00.000Z');

let tdb: TestDatabase;
let state: OpenedState;
let store: StateStore;
let nowMs: number;

const iso = (ms: number): string => new Date(ms).toISOString();
const advance = (ms: number): void => {
  nowMs += ms;
};

// One database for the file, emptied before each test: fewer Postgres schemas created and dropped
// while other state test files migrate in parallel (see otherSchemaDropped in migrations/index.ts).
beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(nowMs) });
  if (!(state instanceof StateStore)) {
    throw new Error('openState did not return a StateStore');
  }
  store = state;
});

beforeEach(async () => {
  nowMs = T0;
  const { db } = store.ctx;
  for (const table of ['artifacts', 'webhook_inbox', 'outbox', 'config_versions', 'kv', 'workspaces'] as const) {
    await db.deleteFrom(table).execute();
  }
});

afterAll(async () => {
  await tdb.drop();
});

// Artifacts ---------------------------------------------------------------------------------------

describe('artifacts', () => {
  const draft = (body: string, id?: string): NewArtifact => ({
    ...(id === undefined ? {} : { id }),
    workspaceId: WS,
    incidentId: INC,
    kind: 'implementation-request',
    contentType: 'application/xml',
    body,
    createdBy: 'triage-agent',
  });
  const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  it('assigns version 1, 2, 3 per id and stores the sha256 of the body', async () => {
    const first = await state.putArtifact(draft('<request v="1"/>'));
    expect(first.version).toBe(1);
    expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    advance(1000);
    const second = await state.putArtifact(draft('<request v="2"/>', first.id));
    const third = await state.putArtifact(draft('<request v="3"/>', first.id));
    expect([second, third]).toEqual([
      { id: first.id, version: 2 },
      { id: first.id, version: 3 },
    ]);

    const latest = await state.getArtifact(first.id);
    expect(latest).toEqual({
      id: first.id,
      version: 3,
      workspaceId: WS,
      incidentId: INC,
      kind: 'implementation-request',
      contentType: 'application/xml',
      sha256: sha('<request v="3"/>'),
      body: '<request v="3"/>',
      createdBy: 'triage-agent',
      createdAt: iso(T0 + 1000),
    });
    const v1 = await state.getArtifact(first.id, 1);
    expect(v1).toMatchObject({ version: 1, body: '<request v="1"/>', sha256: sha('<request v="1"/>'), createdAt: iso(T0) });
    expect((await state.getArtifact(first.id, 2)).body).toBe('<request v="2"/>');
  });

  it('hashes the UTF-8 bytes as lowercase hex (known vectors)', async () => {
    const abc = await state.putArtifact(draft('abc'));
    expect((await state.getArtifact(abc.id)).sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const accented = await state.putArtifact(draft('café'));
    expect((await state.getArtifact(accented.id)).sha256).toBe(sha('café'));
    expect((await state.getArtifact(accented.id)).body).toBe('café');
  });

  it('versions each id independently, and a caller-minted id starts at version 1', async () => {
    const a = await state.putArtifact(draft('a1'));
    await state.putArtifact(draft('a2', a.id));
    const b = await state.putArtifact({ ...draft('{}', '01JZ00000000000000000000B1'), kind: 'diagnosis', contentType: 'application/json' });
    expect(b).toEqual({ id: '01JZ00000000000000000000B1', version: 1 });
    expect(await state.getArtifact(b.id)).toMatchObject({ kind: 'diagnosis', contentType: 'application/json', version: 1 });
    expect((await state.getArtifact(a.id)).version).toBe(2);
  });

  it('rejects with StateNotFoundError for an unknown id or version', async () => {
    const missing: unknown = await state.getArtifact('01JZ00000000000000000000X1').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(StateNotFoundError);
    expect(missing).toMatchObject({ entity: 'artifact', key: '01JZ00000000000000000000X1' });
    const a = await state.putArtifact(draft('a1'));
    const noVersion: unknown = await state.getArtifact(a.id, 2).catch((e: unknown) => e);
    expect(noVersion).toBeInstanceOf(StateNotFoundError);
    expect(noVersion).toMatchObject({ key: `${a.id}@2` });
  });

  it('gives concurrent puts of one id distinct, gapless versions', async () => {
    const a = await state.putArtifact(draft('v1'));
    const puts = await Promise.all([2, 3, 4, 5, 6].map((n) => state.putArtifact(draft(`v${n}`, a.id))));
    expect(puts.map((p) => p.version).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6]);
    expect((await state.getArtifact(a.id)).version).toBe(6);
  });

  it('writes nothing when the surrounding transaction rolls back', async () => {
    const boom = new Error('boom');
    let id = '';
    await expect(
      state.transaction(async (tx) => {
        id = (await tx.putArtifact(draft('doomed'))).id;
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(state.getArtifact(id)).rejects.toBeInstanceOf(StateNotFoundError);
  });
});

// Webhook inbox ------------------------------------------------------------------------------------

describe('webhook inbox (B 8)', () => {
  const WEEK = 7 * 24 * 3600;

  it('returns false the first time and true on a repeat within the TTL', async () => {
    expect(await state.seenWebhook('github', 'delivery-1', WEEK)).toBe(false);
    expect(await state.seenWebhook('github', 'delivery-1', WEEK)).toBe(true);
    advance(WEEK * 1000 - 1);
    expect(await state.seenWebhook('github', 'delivery-1', WEEK)).toBe(true);
  });

  it('keys on (source, deliveryId)', async () => {
    expect(await state.seenWebhook('github', 'd1', 60)).toBe(false);
    expect(await state.seenWebhook('jira', 'd1', 60)).toBe(false);
    expect(await state.seenWebhook('github', 'd2', 60)).toBe(false);
    expect(await state.seenWebhook('jira', 'd1', 60)).toBe(true);
  });

  it('counts an expired row as unseen and renews it', async () => {
    expect(await state.seenWebhook('slack', 'ev-1', 60)).toBe(false);
    advance(60_000); // expires_at == now: expired
    expect(await state.seenWebhook('slack', 'ev-1', 60)).toBe(false);
    advance(59_999);
    expect(await state.seenWebhook('slack', 'ev-1', 60)).toBe(true);
    const row = await store.ctx.db.selectFrom('webhook_inbox').selectAll().executeTakeFirstOrThrow();
    expect(store.ctx.codec.fromTimestamp(row.received_at)).toBe(iso(T0 + 60_000));
    expect(store.ctx.codec.fromTimestamp(row.expires_at)).toBe(iso(T0 + 120_000));
  });

  it('lets exactly one of several concurrent calls see false', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => state.seenWebhook('ci', 'run-9', 60)));
    expect(results.filter((seen) => !seen)).toHaveLength(1);
  });

  it('rejects a TTL that is not a positive number of seconds', async () => {
    await expect(state.seenWebhook('ci', 'x', 0)).rejects.toBeInstanceOf(RangeError);
    await expect(state.seenWebhook('ci', 'x', Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });
});

// Outbox -------------------------------------------------------------------------------------------

describe('outbox (B 7.1)', () => {
  const row = (id: string, createdAtMs: number, extra: Partial<OutboxItem> = {}): OutboxItem => ({
    id,
    workspaceId: WS,
    target: 'jira',
    op: 'add-comment',
    payload: { body: `comment ${id}` },
    attempts: 0,
    nextAttempt: iso(createdAtMs),
    createdAt: iso(createdAtMs),
    ...extra,
  });

  it('drains due, undone rows for the target in created_at order', async () => {
    await state.enqueueOutbox(row('o3', T0 - 1000));
    await state.enqueueOutbox(row('o1', T0 - 3000, { incidentId: INC, batchKey: `comment:${INC}`, payload: { nested: { list: [1, 'two', null] } } }));
    await state.enqueueOutbox(row('o2', T0 - 2000, { attempts: 2, lastError: 'HTTP 429' }));
    await state.enqueueOutbox(row('later', T0 - 4000, { nextAttempt: iso(T0 + 5000) }));
    await state.enqueueOutbox(row('done', T0 - 5000, { doneAt: iso(T0 - 100) }));
    await state.enqueueOutbox(row('gh', T0 - 6000, { target: 'github', op: 'create-pr' }));

    const drained = await state.drainOutbox('jira', 10);
    expect(drained.map((r) => r.id)).toEqual(['o1', 'o2', 'o3']);
    expect(drained[0]).toEqual({
      id: 'o1',
      workspaceId: WS,
      target: 'jira',
      incidentId: INC,
      op: 'add-comment',
      payload: { nested: { list: [1, 'two', null] } },
      batchKey: `comment:${INC}`,
      attempts: 0,
      nextAttempt: iso(T0 - 3000),
      createdAt: iso(T0 - 3000),
    });
    expect(drained[1]).toEqual(row('o2', T0 - 2000, { attempts: 2, lastError: 'HTTP 429' }));
    expect(drained[2]).toEqual(row('o3', T0 - 1000));
    expect((await state.drainOutbox('github', 10)).map((r) => r.id)).toEqual(['gh']);
    expect(await state.drainOutbox('slack', 10)).toEqual([]);

    advance(5000); // next_attempt == now: due
    expect((await state.drainOutbox('jira', 10)).map((r) => r.id)).toEqual(['later', 'o1', 'o2', 'o3']);
  });

  it('returns the same rows when drained twice without an ack, and honours the limit', async () => {
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      await state.enqueueOutbox(row(id, T0 - 3000 + i));
    }
    const first = await state.drainOutbox('jira', 2);
    const second = await state.drainOutbox('jira', 2);
    expect(first.map((r) => r.id)).toEqual(['a', 'b']);
    expect(second).toEqual(first);
    expect(await state.drainOutbox('jira', 0)).toEqual([]);
  });

  it('ackOutbox sets done_at, hides the rows from drain, and ignores unknown ids', async () => {
    await state.enqueueOutbox(row('a', T0 - 2000));
    await state.enqueueOutbox(row('b', T0 - 1000));
    advance(250);
    await state.ackOutbox(['a', 'missing']);
    await state.ackOutbox([]);
    expect((await state.drainOutbox('jira', 10)).map((r) => r.id)).toEqual(['b']);

    const doneAt = async (id: string): Promise<string | undefined> => {
      const r = await store.ctx.db.selectFrom('outbox').select('done_at').where('id', '=', id).executeTakeFirstOrThrow();
      return store.ctx.codec.fromTimestampOpt(r.done_at);
    };
    expect(await doneAt('a')).toBe(iso(T0 + 250));
    expect(await doneAt('b')).toBeUndefined();

    advance(1000); // a second ack keeps the first done_at
    await state.ackOutbox(['a', 'b', 'b']);
    expect(await doneAt('a')).toBe(iso(T0 + 250));
    expect(await doneAt('b')).toBe(iso(T0 + 1250));
    expect(await state.drainOutbox('jira', 10)).toEqual([]);
  });

  it('rejects a duplicate id and an invalid limit', async () => {
    await state.enqueueOutbox(row('a', T0));
    await expect(state.enqueueOutbox(row('a', T0))).rejects.toThrow();
    await expect(state.drainOutbox('jira', -1)).rejects.toBeInstanceOf(RangeError);
    await expect(state.drainOutbox('jira', 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

// Config cache -------------------------------------------------------------------------------------

describe('config cache', () => {
  const configRows = () => store.ctx.db.selectFrom('config_versions').selectAll().orderBy('kind').orderBy('hash').execute();

  it('rejects with StateNotFoundError before any version of the kind is loaded', async () => {
    const before: unknown = await state.getConfigVersion('map').catch((e: unknown) => e);
    expect(before).toBeInstanceOf(StateNotFoundError);
    expect(before).toMatchObject({ entity: 'config-version', key: 'map' });
    await state.putConfigVersion('map', 'h-map-1', '<map/>');
    await expect(state.getConfigVersion('playbook')).rejects.toBeInstanceOf(StateNotFoundError);
  });

  it('returns the latest loaded version per kind', async () => {
    await state.putConfigVersion('map', 'h-map-1', '<map v="1"/>');
    await state.putConfigVersion('playbook', 'h-pb-1', '<playbook/>');
    advance(1000);
    await state.putConfigVersion('map', 'h-map-2', '<map v="2"/>');
    expect(await state.getConfigVersion('map')).toEqual({ hash: 'h-map-2', body: '<map v="2"/>' });
    expect(await state.getConfigVersion('playbook')).toEqual({ hash: 'h-pb-1', body: '<playbook/>' });

    // Two puts within one millisecond: the last one still wins.
    await state.putConfigVersion('instructions', 'h-i-1', 'one');
    await state.putConfigVersion('instructions', 'h-i-2', 'two');
    await state.putConfigVersion('instructions', 'h-i-0', 'zero');
    expect(await state.getConfigVersion('instructions')).toEqual({ hash: 'h-i-0', body: 'zero' });
  });

  it('makes a re-put hash (a revert) the latest again, keeping one row per hash', async () => {
    await state.putConfigVersion('map', 'h-a', '<map a/>');
    advance(1000);
    await state.putConfigVersion('map', 'h-b', '<map b/>');
    advance(1000);
    await state.putConfigVersion('map', 'h-a', '<map a/>');
    expect(await state.getConfigVersion('map')).toEqual({ hash: 'h-a', body: '<map a/>' });
    const rows = await configRows();
    expect(rows.map((r) => r.hash)).toEqual(['h-a', 'h-b']);
    expect(rows.map((r) => store.ctx.codec.fromBool(r.valid))).toEqual([true, true]);
    expect(rows.map((r) => r.errors)).toEqual([null, null]);
    expect(store.ctx.codec.fromTimestamp(rows[0]?.loaded_at)).toBe(iso(T0 + 2000));
  });

  it("creates the install's default workspace when there is none", async () => {
    await state.putConfigVersion('map', 'h1', '<map/>');
    const workspaces = await store.ctx.db.selectFrom('workspaces').selectAll().execute();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.slug).toBe(DEFAULT_WORKSPACE_SLUG);
    expect((await configRows())[0]?.workspace_id).toBe(workspaces[0]?.id);
  });

  it('uses the existing single workspace, and refuses to guess between several', async () => {
    await store.ctx.db.insertInto('workspaces').values({ id: WS, slug: 'acme', created_at: iso(T0) }).execute();
    await state.putConfigVersion('map', 'h1', '<map/>');
    expect((await configRows())[0]?.workspace_id).toBe(WS);
    expect(await store.ctx.db.selectFrom('workspaces').select('id').execute()).toEqual([{ id: WS }]);

    await store.ctx.db.insertInto('workspaces').values({ id: '01JZ00000000000000000000W2', slug: 'other', created_at: iso(T0) }).execute();
    await expect(state.putConfigVersion('map', 'h2', '<map/>')).rejects.toBeInstanceOf(ConfigWorkspaceAmbiguousError);
    await expect(state.getConfigVersion('map')).rejects.toBeInstanceOf(ConfigWorkspaceAmbiguousError);
  });
});

// kv -----------------------------------------------------------------------------------------------

describe('kv (cache-port fallback)', () => {
  it('gets, sets, and overwrites', async () => {
    expect(await store.kvGet('idem:1')).toBeUndefined();
    await store.kvSet('idem:1', 'a');
    expect(await store.kvGet('idem:1')).toBe('a');
    await store.kvSet('idem:1', 'b');
    expect(await store.kvGet('idem:1')).toBe('b');
  });

  it('expires a value after its TTL, and a set without TTL clears the expiry', async () => {
    await store.kvSet('rate:u1', '3', 30);
    advance(29_999);
    expect(await store.kvGet('rate:u1')).toBe('3');
    advance(1); // expires_at == now: expired
    expect(await store.kvGet('rate:u1')).toBeUndefined();

    await store.kvSet('rate:u1', '4', 30);
    await store.kvSet('rate:u1', '5');
    advance(3_600_000);
    expect(await store.kvGet('rate:u1')).toBe('5');
  });

  it('setIfAbsent sets only an absent or expired key', async () => {
    expect(await store.kvSetIfAbsent('lock:x', 'first', 10)).toBe(true);
    expect(await store.kvSetIfAbsent('lock:x', 'second', 10)).toBe(false);
    expect(await store.kvGet('lock:x')).toBe('first');
    advance(10_000);
    expect(await store.kvSetIfAbsent('lock:x', 'third')).toBe(true);
    expect(await store.kvGet('lock:x')).toBe('third');
    advance(3_600_000); // no TTL: never expires, so never taken over
    expect(await store.kvSetIfAbsent('lock:x', 'fourth', 10)).toBe(false);
    expect(await store.kvGet('lock:x')).toBe('third');
  });

  it('lets exactly one of several concurrent setIfAbsent calls win', async () => {
    const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => store.kvSetIfAbsent('lock:y', `w${i}`, 60)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const winner = wins.indexOf(true);
    expect(await store.kvGet('lock:y')).toBe(`w${winner}`);
  });

  it('rejects a TTL that is not a positive number of seconds', async () => {
    await expect(store.kvSet('k', 'v', 0)).rejects.toBeInstanceOf(RangeError);
    await expect(store.kvSetIfAbsent('k', 'v', -1)).rejects.toBeInstanceOf(RangeError);
  });

  it('joins a transaction and rolls back with it', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.kvSet('tx:k', 'v');
        expect(await tx.kvGet('tx:k')).toBe('v');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await store.kvGet('tx:k')).toBeUndefined();
  });
});
