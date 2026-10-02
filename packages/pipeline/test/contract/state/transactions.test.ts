import { expect, it } from 'vitest';
import { StateNotFoundError } from '../../../src/contracts/state.ts';
import { artifact, event, fixture, id, outbox } from './helpers.ts';
const f = fixture();
it('rolls back events, artifacts and outbox together on throw', async () => {
  const key = id(), artifactId = id();
  const row = outbox();
  const failure = new Error('fake transaction failure');
  await expect(f.state().transaction(async (tx) => {
    await tx.append(key, [event(key)], 0);
    await tx.putArtifact({ ...artifact(key), id: artifactId });
    await tx.enqueueOutbox(row);
    throw failure;
  })).rejects.toBe(failure);
  expect(await f.state().read(key)).toEqual([]);
  await expect(f.state().getArtifact(artifactId)).rejects.toBeInstanceOf(StateNotFoundError);
  expect((await f.state().drainOutbox('jira', 100)).map((r) => r.id)).not.toContain(row.id);
  expect(await f.state().append(key, [event(key)], 0)).toEqual({ seq: 1 });
});
it('commits all writes and returns the callback value', async () => {
  const key = id(), artifactId = id();
  const row = outbox();
  expect(await f.state().transaction(async (tx) => {
    await tx.append(key, [event(key)], 0);
    await tx.putArtifact({ ...artifact(key), id: artifactId });
    await tx.enqueueOutbox(row);
    expect(await tx.read(key)).toHaveLength(1);
    return 'committed';
  })).toBe('committed');
  expect(await f.state().read(key)).toHaveLength(1);
  expect((await f.state().getArtifact(artifactId)).version).toBe(1);
  expect(await f.state().drainOutbox('jira', 100)).toContainEqual(row);
});
it('joins nested transactions and commits their writes', async () => {
  const key = id();
  await f.state().transaction(async (tx) => {
    await tx.append(key, [event(key)], 0);
    await tx.transaction(async (joined) => {
      expect(await joined.read(key)).toHaveLength(1);
      await joined.append(key, [event(key)], 1);
    });
  });
  expect((await f.state().read(key)).map((e) => e.seq)).toEqual([1, 2]);
});
it('rolls back successful nested writes when the outer transaction throws', async () => {
  const key = id();
  await expect(f.state().transaction(async (tx) => {
    await tx.transaction(async (joined) => { await joined.append(key, [event(key)], 0); });
    throw new Error('fake outer failure');
  })).rejects.toThrow('fake outer failure');
  expect(await f.state().read(key)).toEqual([]);
});
it('rolls back the outer writes when a nested failure propagates', async () => {
  const key = id();
  await expect(f.state().transaction(async (tx) => {
    await tx.append(key, [event(key)], 0);
    await tx.transaction(async () => { throw new Error('fake nested failure'); });
  })).rejects.toThrow('fake nested failure');
  expect(await f.state().read(key)).toEqual([]);
});
it('rolls back config and inbox writes', async () => {
  const key = id();
  await f.state().putConfigVersion('map', 'fake-original', 'original');
  f.setTime(1000);
  await expect(f.state().transaction(async (tx) => {
    await tx.putConfigVersion('map', 'fake-replacement', 'replacement');
    await tx.seenWebhook('github', key, 60);
    throw new Error('fake rollback');
  })).rejects.toThrow('fake rollback');
  expect(await f.state().getConfigVersion('map')).toEqual({ hash: 'fake-original', body: 'original' });
  expect(await f.state().seenWebhook('github', key, 60)).toBe(false);
});
