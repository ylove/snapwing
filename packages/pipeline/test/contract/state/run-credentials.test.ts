// Runner container run credentials (#273): revocation and the persisted spend counters the fixer API
// and the model proxy check. Runs on the dialect `SNAPWING_DB` selects (SQLite and Postgres).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OpenedState } from '../../../src/ports/state.ts';
import { StateStore } from '../../../src/state/store.ts';
import { TEST_DIALECT, createTestDatabase, type TestDatabase } from '../../helpers/db.ts';

const RUN = '01JZRUN0000000000000000001';
const OTHER = '01JZRUN0000000000000000002';
const LIMITS = { maxRequests: 3, maxTokens: 1000 };

describe(`run credentials (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let store: StateStore;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const state: OpenedState = await tdb.open();
    if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
    store = state;
  });

  beforeEach(async () => {
    await store.ctx.db.deleteFrom('run_credentials').execute();
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('counts model requests up to the cap, per run, and persists the counters', async () => {
    for (let i = 0; i < 3; i++) expect(await store.reserveModelRequest(RUN, LIMITS)).toEqual({ ok: true });
    expect(await store.reserveModelRequest(RUN, LIMITS)).toEqual({ ok: false, reason: 'request-cap' });
    expect(await store.reserveModelRequest(OTHER, LIMITS)).toEqual({ ok: true });
    // A second handle on the same database sees the same counters (another process, a restart).
    const again = await tdb.open();
    if (!(again instanceof StateStore)) throw new Error('openState did not return a StateStore');
    expect(await again.runCredentialUse(RUN)).toMatchObject({ modelRequests: 3, revoked: false });
  });

  it('meters tokens and refuses the next request once the run has spent its tokens', async () => {
    expect(await store.reserveModelRequest(RUN, LIMITS)).toEqual({ ok: true });
    await store.recordModelTokens(RUN, 700, 250);
    expect(await store.reserveModelRequest(RUN, LIMITS)).toEqual({ ok: true });
    await store.recordModelTokens(RUN, 40, 10);
    expect(await store.runCredentialUse(RUN)).toMatchObject({ modelRequests: 2, inputTokens: 740, outputTokens: 260 });
    expect(await store.reserveModelRequest(RUN, LIMITS)).toEqual({ ok: false, reason: 'token-cap' });
  });

  it('caps artifacts by count and by bytes', async () => {
    const limits = { maxArtifacts: 2, maxBytes: 100 };
    expect(await store.reserveArtifact(RUN, 60, limits)).toEqual({ ok: true });
    expect(await store.reserveArtifact(RUN, 41, limits)).toEqual({ ok: false, reason: 'artifact-cap' });
    expect(await store.reserveArtifact(RUN, 40, limits)).toEqual({ ok: true });
    expect(await store.reserveArtifact(RUN, 0, limits)).toEqual({ ok: false, reason: 'artifact-cap' });
    expect(await store.reserveArtifact(OTHER, 101, limits)).toEqual({ ok: false, reason: 'artifact-cap' });
    expect(await store.runCredentialUse(RUN)).toMatchObject({ artifacts: 2, artifactBytes: 100 });
  });

  it('a revoked run spends nothing more, whether or not it was used before', async () => {
    expect(await store.reserveModelRequest(RUN, LIMITS)).toEqual({ ok: true });
    await store.revokeRunCredentials(RUN);
    await store.revokeRunCredentials(RUN);
    await store.revokeRunCredentials(OTHER);
    for (const run of [RUN, OTHER]) {
      expect(await store.runCredentialsRevoked(run)).toBe(true);
      expect(await store.reserveModelRequest(run, LIMITS)).toEqual({ ok: false, reason: 'revoked' });
      expect(await store.reserveArtifact(run, 1, { maxArtifacts: 5, maxBytes: 100 })).toEqual({ ok: false, reason: 'revoked' });
    }
    expect(await store.runCredentialsRevoked('01JZRUN0000000000000000003')).toBe(false);
  });
});
