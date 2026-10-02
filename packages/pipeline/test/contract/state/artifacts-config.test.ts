import { expect, it } from 'vitest';
import { StateNotFoundError } from '../../../src/contracts/state.ts';
import { artifact, epoch, fixture, id } from './helpers.ts';
const f = fixture();
it('creates artifact version one with a ULID and content hash', async () => {
  const input = artifact();
  const result = await f.state().putArtifact(input);
  expect(result.version).toBe(1);
  expect(result.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(await f.state().getArtifact(result.id)).toEqual({ ...input, ...result, createdAt: epoch, sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' });
});
it('increments versions and reads latest or a specific immutable version', async () => {
  const input = artifact();
  const first = await f.state().putArtifact(input);
  const original = await f.state().getArtifact(first.id, 1);
  for (const version of [2, 3]) {
    f.setTime(version * 1000);
    expect(await f.state().putArtifact({ ...input, id: first.id, body: JSON.stringify({ version }) })).toEqual({ id: first.id, version });
  }
  expect(await f.state().getArtifact(first.id)).toEqual(await f.state().getArtifact(first.id, 3));
  expect((await f.state().getArtifact(first.id, 2)).body).toBe('{"version":2}');
  expect(await f.state().getArtifact(first.id, 1)).toEqual(original);
});
it('versions separate artifact IDs independently', async () => {
  const a = await f.state().putArtifact(artifact());
  const b = await f.state().putArtifact(artifact());
  expect(a.id).not.toBe(b.id);
  expect(b.version).toBe(1);
});
it('rejects an unknown artifact', async () => {
  await expect(f.state().getArtifact(id())).rejects.toBeInstanceOf(StateNotFoundError);
});
it('rejects a missing artifact version', async () => {
  const a = await f.state().putArtifact(artifact());
  await expect(f.state().getArtifact(a.id, 2)).rejects.toBeInstanceOf(StateNotFoundError);
});
it('rejects config before its first load', async () => {
  await expect(f.state().getConfigVersion('map')).rejects.toBeInstanceOf(StateNotFoundError);
});
it('returns the latest loaded config hash and body', async () => {
  f.setTime(10000);
  await f.state().putConfigVersion('map', 'fake-hash-one', 'fake body one');
  expect(await f.state().getConfigVersion('map')).toEqual({ hash: 'fake-hash-one', body: 'fake body one' });
  f.setTime(11000);
  await f.state().putConfigVersion('map', 'fake-hash-two', 'fake body two');
  expect(await f.state().getConfigVersion('map')).toEqual({ hash: 'fake-hash-two', body: 'fake body two' });
});
it('keeps config kinds independent', async () => {
  await f.state().putConfigVersion('playbook', 'fake-playbook', 'playbook body');
  await f.state().putConfigVersion('instructions', 'fake-instructions', 'instructions body');
  expect(await f.state().getConfigVersion('playbook')).toEqual({ hash: 'fake-playbook', body: 'playbook body' });
  expect(await f.state().getConfigVersion('instructions')).toEqual({ hash: 'fake-instructions', body: 'instructions body' });
});
// StatePort exposes no config version counter or historical lookup.
