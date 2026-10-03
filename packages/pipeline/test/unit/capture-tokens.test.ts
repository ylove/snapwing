// Per-user capture tokens (#374; main 15.3, 15.4, 16, ADR 0007). Runs on the dialect `SNAPWING_DB`
// selects; the local gate runs the file on both SQLite and Postgres. Every token here is generated
// at run time by the store; none is written in this file.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OpenedState } from '../../src/ports/state.ts';
import { CAPTURE_TOKEN_PREFIX, hashCaptureToken, isCaptureTokenShape } from '../../src/state/capture-tokens.ts';
import { rebuild } from '../../src/state/rebuild.ts';
import { StateStore } from '../../src/state/store.ts';
import { TEST_DIALECT, createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-03T12:00:00.000Z');
const WS = '01JZ00000000000000000000W1';
const OTHER_WS = '01JZ00000000000000000000W2';

/** Every value of a row or object as text, for "the secret appears nowhere" checks. */
function texts(o: object): string[] {
  return Object.values(o).map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : JSON.stringify(v)));
}

describe(`capture tokens (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let store: StateStore;
  let nowMs = T0;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const state: OpenedState = await tdb.open({ now: () => new Date(nowMs) });
    if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
    store = state;
  });

  beforeEach(async () => {
    nowMs = T0;
    await store.ctx.db.deleteFrom('capture_tokens').execute();
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('issues a prefixed 32-byte base64url token once and stores only its SHA-256', async () => {
    const issued = await store.issueCaptureToken({ workspaceId: WS, person: 'dana', label: 'laptop' });
    expect(issued.token.startsWith(CAPTURE_TOKEN_PREFIX)).toBe(true);
    expect(isCaptureTokenShape(issued.token)).toBe(true);
    expect(Buffer.from(issued.token.slice(CAPTURE_TOKEN_PREFIX.length), 'base64url')).toHaveLength(32);
    expect(issued).toEqual({ id: issued.id, workspaceId: WS, person: 'dana', label: 'laptop', issuedAt: new Date(T0).toISOString(), token: issued.token });

    const row = await store.ctx.db.selectFrom('capture_tokens').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(hashCaptureToken(issued.token));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const secret = issued.token.slice(CAPTURE_TOKEN_PREFIX.length);
    for (const text of texts(row)) {
      expect(text).not.toContain(secret);
    }

    const again = await store.issueCaptureToken({ workspaceId: WS, person: 'dana' });
    expect(again.token).not.toBe(issued.token);
    expect(again.id).not.toBe(issued.id);
    expect(again).not.toHaveProperty('label');
  });

  it('verifies to the workspace, person, and token id, and stamps lastUsedAt', async () => {
    const issued = await store.issueCaptureToken({ workspaceId: WS, person: 'dana', label: 'laptop' });
    expect((await store.listCaptureTokens(WS))[0]).not.toHaveProperty('lastUsedAt');

    nowMs += 60_000;
    expect(await store.verifyCaptureToken(issued.token)).toEqual({ workspaceId: WS, person: 'dana', tokenId: issued.id });
    expect((await store.listCaptureTokens(WS))[0]?.lastUsedAt).toBe(new Date(T0 + 60_000).toISOString());

    nowMs += 60_000;
    expect(await store.verifyCaptureToken(issued.token)).not.toBeNull();
    expect((await store.listCaptureTokens(WS))[0]?.lastUsedAt).toBe(new Date(T0 + 120_000).toISOString());
  });

  it('a revoked token fails, and revoking is by id, once', async () => {
    const issued = await store.issueCaptureToken({ workspaceId: WS, person: 'dana' });
    nowMs += 1_000;
    expect(await store.revokeCaptureToken(issued.id)).toBe(true);
    expect(await store.verifyCaptureToken(issued.token)).toBeNull();
    expect(await store.revokeCaptureToken(issued.id)).toBe(false);
    expect(await store.revokeCaptureToken('01JZ0000000000000000000000')).toBe(false);
    const [listed] = await store.listCaptureTokens(WS);
    expect(listed?.revokedAt).toBe(new Date(T0 + 1_000).toISOString());
    expect(listed).not.toHaveProperty('lastUsedAt');
  });

  it('two people are independent: each token is its own person, and revoking one leaves the other', async () => {
    const dana = await store.issueCaptureToken({ workspaceId: WS, person: 'dana' });
    const sam = await store.issueCaptureToken({ workspaceId: WS, person: 'sam' });
    const danaCli = await store.issueCaptureToken({ workspaceId: WS, person: 'dana', label: 'cli' });
    expect((await store.verifyCaptureToken(dana.token))?.person).toBe('dana');
    expect((await store.verifyCaptureToken(sam.token))?.person).toBe('sam');

    expect(await store.revokeCaptureToken(dana.id)).toBe(true);
    expect(await store.verifyCaptureToken(dana.token)).toBeNull();
    expect(await store.verifyCaptureToken(sam.token)).toEqual({ workspaceId: WS, person: 'sam', tokenId: sam.id });
    expect(await store.verifyCaptureToken(danaCli.token)).toEqual({ workspaceId: WS, person: 'dana', tokenId: danaCli.id });
  });

  it('a wrong token fails: unknown, one character off, without the prefix, malformed, or empty', async () => {
    const issued = await store.issueCaptureToken({ workspaceId: WS, person: 'dana' });
    const last = issued.token.at(-1) === 'A' ? 'B' : 'A';
    const secret = issued.token.slice(CAPTURE_TOKEN_PREFIX.length);
    const wrong = [
      issued.token.slice(0, -1) + last,
      secret,
      `xyz_${secret}`,
      `${issued.token}A`,
      issued.token.slice(0, -1),
      ` ${issued.token}`,
      hashCaptureToken(issued.token),
      '',
    ];
    for (const token of wrong) {
      expect(await store.verifyCaptureToken(token)).toBeNull();
    }
    expect((await store.listCaptureTokens(WS))[0]).not.toHaveProperty('lastUsedAt');
    expect(await store.verifyCaptureToken(issued.token)).not.toBeNull();
  });

  it('the list is per workspace, oldest first, and shows no secret', async () => {
    const a = await store.issueCaptureToken({ workspaceId: WS, person: 'dana', label: 'laptop' });
    nowMs += 1_000;
    const b = await store.issueCaptureToken({ workspaceId: WS, person: 'sam' });
    const other = await store.issueCaptureToken({ workspaceId: OTHER_WS, person: 'dana' });

    const list = await store.listCaptureTokens(WS);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(list[0]).toEqual({ id: a.id, workspaceId: WS, person: 'dana', label: 'laptop', issuedAt: new Date(T0).toISOString() });
    for (const t of list) {
      expect(Object.keys(t).sort()).toEqual(expect.arrayContaining(['id', 'issuedAt', 'person', 'workspaceId']));
      expect(t).not.toHaveProperty('token');
      expect(t).not.toHaveProperty('tokenHash');
      for (const text of texts(t)) {
        for (const issued of [a, b]) {
          expect(text).not.toContain(issued.token.slice(CAPTURE_TOKEN_PREFIX.length));
          expect(text).not.toBe(hashCaptureToken(issued.token));
        }
      }
    }
    expect((await store.listCaptureTokens(OTHER_WS)).map((t) => t.id)).toEqual([other.id]);
    expect(await store.listCaptureTokens('01JZ00000000000000000000W3')).toEqual([]);
  });

  it('rejects a token without a workspace or person and writes nothing', async () => {
    await expect(store.issueCaptureToken({ workspaceId: WS, person: '' })).rejects.toThrow(TypeError);
    await expect(store.issueCaptureToken({ workspaceId: '', person: 'dana' })).rejects.toThrow(TypeError);
    expect(await store.listCaptureTokens(WS)).toEqual([]);
  });

  it('joins a transaction: a rolled-back issue leaves no token', async () => {
    let token = '';
    await expect(
      store.transaction(async (tx) => {
        token = (await tx.issueCaptureToken({ workspaceId: WS, person: 'dana' })).token;
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(token.startsWith(CAPTURE_TOKEN_PREFIX)).toBe(true);
    expect(await store.verifyCaptureToken(token)).toBeNull();
    expect(await store.listCaptureTokens(WS)).toEqual([]);
  });

  it('state rebuild keeps the table: tokens are not derived from events', async () => {
    const live = await store.issueCaptureToken({ workspaceId: WS, person: 'dana' });
    const revoked = await store.issueCaptureToken({ workspaceId: WS, person: 'sam' });
    await store.revokeCaptureToken(revoked.id);
    const before = await store.listCaptureTokens(WS);

    await rebuild(store, { all: true });

    expect(await store.listCaptureTokens(WS)).toEqual(before);
    expect(await store.verifyCaptureToken(live.token)).toEqual({ workspaceId: WS, person: 'dana', tokenId: live.id });
    expect(await store.verifyCaptureToken(revoked.token)).toBeNull();
  });
});
