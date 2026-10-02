// Linked identities (#153; main 11.2, ADR 0007) and the AES-256-GCM sealing their tokens use. Runs on
// the dialect `SNAPWING_DB` selects; CI runs the file on both SQLite and Postgres.

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LinkedIdentityKey, NewLinkedIdentity, OpenedState } from '../../src/ports/state.ts';
import { StateStore } from '../../src/state/store.ts';
import { SealError, SEALED_PREFIX, deriveKey, isSealed, parseSealKey, seal, unseal } from '../../src/util/seal.ts';
import { TEST_DIALECT, createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const KEY = parseSealKey(randomBytes(32).toString('base64'));
const OTHER_KEY = parseSealKey(randomBytes(32).toString('hex'));

describe('seal (AES-256-GCM)', () => {
  it('parses 32-byte keys as hex, base64, and base64url, and rejects anything else without echoing it', () => {
    const bytes = randomBytes(32);
    for (const raw of [bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url'), ` ${bytes.toString('base64')}\n`]) {
      expect(parseSealKey(raw).bytes.equals(bytes)).toBe(true);
    }
    for (const raw of ['', 'short', randomBytes(16).toString('hex'), randomBytes(31).toString('base64'), randomBytes(33).toString('base64')]) {
      expect(() => parseSealKey(raw)).toThrow(SealError);
    }
    const secret = randomBytes(20).toString('hex');
    expect(() => parseSealKey(secret)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) as unknown }));
  });

  it('round-trips, never equals or contains the plaintext, and differs on every seal', () => {
    const token = 'test-user-token-example';
    const a = seal(KEY, token, 'ctx');
    const b = seal(KEY, token, 'ctx');
    expect(a.startsWith(SEALED_PREFIX)).toBe(true);
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(token);
    expect(a).not.toContain(token);
    expect(a).not.toBe(b);
    expect(unseal(KEY, a, 'ctx')).toBe(token);
    expect(unseal(KEY, b, 'ctx')).toBe(token);
  });

  it('refuses a wrong key, a wrong context, tampering, and a value that is not sealed', () => {
    const sealed = seal(KEY, 'test-user-token-x', 'row-1:access_token');
    expect(() => unseal(OTHER_KEY, sealed, 'row-1:access_token')).toThrow(SealError);
    expect(() => unseal(KEY, sealed, 'row-2:access_token')).toThrow(SealError);
    const [iv, ct, tag] = sealed.slice(SEALED_PREFIX.length).split('.') as [string, string, string];
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => unseal(KEY, `${SEALED_PREFIX}${iv}.${flipped.toString('base64url')}.${tag}`, 'row-1:access_token')).toThrow(SealError);
    expect(() => unseal(KEY, 'test-user-token-x', 'row-1:access_token')).toThrow(SealError);
    expect(() => unseal(KEY, `${SEALED_PREFIX}a.b`, 'row-1:access_token')).toThrow(SealError);
  });

  it('derives distinct keys per purpose', () => {
    expect(deriveKey(KEY, 'a').equals(deriveKey(KEY, 'a'))).toBe(true);
    expect(deriveKey(KEY, 'a').equals(deriveKey(KEY, 'b'))).toBe(false);
    expect(deriveKey(KEY, 'a').equals(KEY.bytes)).toBe(false);
  });
});

describe(`linked identities (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let store: StateStore;
  let nowMs = T0;

  const KEY_A: LinkedIdentityKey = { workspaceId: '01JZ00000000000000000000W1', chat: 'slack', chatUserId: 'U0AAAA' };
  const ACCESS = 'test-access-token-plain';
  const REFRESH = 'test-refresh-token-plain';

  function identity(overrides: Partial<NewLinkedIdentity> = {}): NewLinkedIdentity {
    return {
      ...KEY_A,
      githubLogin: 'octo',
      githubUserId: 2_147_483_648_123,
      accessToken: seal(KEY, ACCESS, 'a'),
      accessTokenExpiresAt: '2026-10-02T20:00:00.000Z',
      refreshToken: seal(KEY, REFRESH, 'r'),
      refreshTokenExpiresAt: '2027-04-02T12:00:00.000Z',
      ...overrides,
    };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const state: OpenedState = await tdb.open({ now: () => new Date(nowMs) });
    if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
    store = state;
  });

  beforeEach(async () => {
    nowMs = T0;
    await store.ctx.db.deleteFrom('linked_identities').execute();
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('links, reads back every field, and unlinks', async () => {
    expect(await store.getLinkedIdentity(KEY_A)).toBeNull();
    const id = identity();
    await store.linkIdentity(id);
    expect(await store.getLinkedIdentity(KEY_A)).toEqual({ ...id, linkedAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() });
    expect(await store.getLinkedIdentity({ ...KEY_A, chat: 'teams' })).toBeNull();
    expect(await store.getLinkedIdentity({ ...KEY_A, workspaceId: '01JZ00000000000000000000W2' })).toBeNull();
    expect(await store.unlinkIdentity(KEY_A)).toBe(true);
    expect(await store.unlinkIdentity(KEY_A)).toBe(false);
    expect(await store.getLinkedIdentity(KEY_A)).toBeNull();
  });

  it('stores a link without expiries or a refresh token as absent fields', async () => {
    const id = identity();
    delete id.accessTokenExpiresAt;
    delete id.refreshToken;
    delete id.refreshTokenExpiresAt;
    await store.linkIdentity(id);
    const got = await store.getLinkedIdentity(KEY_A);
    expect(got).not.toBeNull();
    expect(Object.keys(got ?? {}).sort()).toEqual(['accessToken', 'chat', 'chatUserId', 'githubLogin', 'githubUserId', 'linkedAt', 'updatedAt', 'workspaceId']);
  });

  it('updates in place: keeps linkedAt on a token refresh, resets it when the GitHub account changes', async () => {
    await store.linkIdentity(identity());
    nowMs += 60_000;
    const refreshed = identity({ accessToken: seal(KEY, 'test-access-token-new', 'a'), accessTokenExpiresAt: '2026-10-03T04:00:00.000Z' });
    await store.linkIdentity(refreshed);
    let got = await store.getLinkedIdentity(KEY_A);
    expect(got?.linkedAt).toBe(new Date(T0).toISOString());
    expect(got?.updatedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(got?.accessToken).toBe(refreshed.accessToken);
    expect(got?.accessTokenExpiresAt).toBe('2026-10-03T04:00:00.000Z');

    nowMs += 60_000;
    await store.linkIdentity(identity({ githubLogin: 'other', githubUserId: 7 }));
    got = await store.getLinkedIdentity(KEY_A);
    expect(got?.githubLogin).toBe('other');
    expect(got?.linkedAt).toBe(new Date(T0 + 120_000).toISOString());
    const count = await store.ctx.db.selectFrom('linked_identities').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('rejects a token that is not sealed and writes nothing', async () => {
    await expect(store.linkIdentity(identity({ accessToken: ACCESS }))).rejects.toThrow(TypeError);
    await expect(store.linkIdentity(identity({ refreshToken: REFRESH }))).rejects.toThrow(TypeError);
    await expect(store.linkIdentity(identity({ accessToken: ACCESS }))).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining(ACCESS) as unknown }));
    expect(await store.getLinkedIdentity(KEY_A)).toBeNull();
  });

  it('never stores a token in the clear: the raw columns hold ciphertext', async () => {
    await store.linkIdentity(identity());
    const row = await store.ctx.db.selectFrom('linked_identities').selectAll().executeTakeFirstOrThrow();
    for (const v of Object.values(row)) {
      const text = v instanceof Date ? v.toISOString() : String(v);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(REFRESH);
    }
    expect(unseal(KEY, row.access_token, 'a')).toBe(ACCESS);
    expect(unseal(KEY, row.refresh_token ?? '', 'r')).toBe(REFRESH);
  });

  it('joins a transaction: a rolled-back link is not stored', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.linkIdentity(identity());
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await store.getLinkedIdentity(KEY_A)).toBeNull();
  });
});
