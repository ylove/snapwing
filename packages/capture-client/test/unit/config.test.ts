import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientConfigPath, loadClientConfig, saveClientConfig } from '../../src/config.ts';
import { CaptureConfigError } from '../../src/errors.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'snapwing-cc-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeRaw(text: string): Promise<void> {
  await mkdir(join(home, '.config', 'snapwing'), { recursive: true });
  await writeFile(clientConfigPath(home), text);
}

describe('loadClientConfig', () => {
  it('uses the environment when both variables are set, without reading the file', async () => {
    await writeRaw('not json');
    const c = await loadClientConfig({ env: { SNAPWING_URL: 'http://localhost:3000', SNAPWING_TOKEN: 't1' }, home });
    expect(c).toEqual({ endpoint: 'http://localhost:3000', token: 't1' });
  });

  it('lets the environment win over the file, field by field', async () => {
    await saveClientConfig({ endpoint: 'https://file.example', token: 'file-token' }, { home });
    expect(await loadClientConfig({ env: { SNAPWING_TOKEN: 'env-token' }, home })).toEqual({
      endpoint: 'https://file.example',
      token: 'env-token',
    });
    expect(await loadClientConfig({ env: { SNAPWING_URL: 'http://localhost:9' }, home })).toEqual({
      endpoint: 'http://localhost:9',
      token: 'file-token',
    });
  });

  it('falls back to the file and treats empty variables as unset', async () => {
    await saveClientConfig({ endpoint: 'https://file.example', token: 'file-token' }, { home });
    expect(await loadClientConfig({ env: { SNAPWING_URL: '', SNAPWING_TOKEN: '' }, home })).toEqual({
      endpoint: 'https://file.example',
      token: 'file-token',
    });
  });

  it('returns undefined when nothing is configured', async () => {
    expect(await loadClientConfig({ env: {}, home })).toBeUndefined();
    await writeRaw(JSON.stringify({ endpoint: 'https://x.example' }));
    expect(await loadClientConfig({ env: {}, home })).toBeUndefined();
  });

  it('rejects an invalid file or endpoint with a typed error', async () => {
    await writeRaw('{nope');
    await expect(loadClientConfig({ env: {}, home })).rejects.toBeInstanceOf(CaptureConfigError);
    await writeRaw('[]');
    await expect(loadClientConfig({ env: {}, home })).rejects.toBeInstanceOf(CaptureConfigError);
    await expect(
      loadClientConfig({ env: { SNAPWING_URL: 'ftp://x', SNAPWING_TOKEN: 't' }, home }),
    ).rejects.toBeInstanceOf(CaptureConfigError);
    await expect(
      loadClientConfig({ env: { SNAPWING_URL: 'not a url', SNAPWING_TOKEN: 't' }, home }),
    ).rejects.toBeInstanceOf(CaptureConfigError);
  });

  it('reports an unreadable path as a config error', async () => {
    await mkdir(clientConfigPath(home), { recursive: true });
    await expect(loadClientConfig({ env: {}, home })).rejects.toBeInstanceOf(CaptureConfigError);
  });
});

describe('saveClientConfig', () => {
  it('writes ~/.config/snapwing/client.json with mode 0600', async () => {
    const path = await saveClientConfig({ endpoint: 'http://localhost:3000', token: 'secret' }, { home });
    expect(path).toBe(join(home, '.config', 'snapwing', 'client.json'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ endpoint: 'http://localhost:3000', token: 'secret' });
  });

  it('tightens an existing file with a looser mode', async () => {
    await writeRaw('{}');
    await chmod(clientConfigPath(home), 0o644);
    await saveClientConfig({ endpoint: 'http://localhost:3000', token: 'secret' }, { home });
    expect((await stat(clientConfigPath(home))).mode & 0o777).toBe(0o600);
  });

  it('refuses a bad endpoint or an empty token', async () => {
    await expect(saveClientConfig({ endpoint: 'nope', token: 't' }, { home })).rejects.toBeInstanceOf(CaptureConfigError);
    await expect(saveClientConfig({ endpoint: 'http://localhost:1', token: '' }, { home })).rejects.toBeInstanceOf(
      CaptureConfigError,
    );
  });
});
