// The `.env` writer's temp file and the ignore warning (#274).

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envNotIgnoredWarning, writeEnvFile, writeFileAtomic } from '../../src/onboard/interview/env.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-env-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeEnvFile', () => {
  it('writes mode 0600 and leaves no temp file behind', async () => {
    await writeEnvFile(join(dir, '.env'), { A: 'one' });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('A=one\n');
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['.env']);
  });

  it('tightens an existing loose file', async () => {
    await writeFile(join(dir, '.env'), 'B=2\n');
    await chmod(join(dir, '.env'), 0o644);
    await writeEnvFile(join(dir, '.env'), { A: '1' });
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
  });

  it('removes its temp file when the rename fails', async () => {
    await mkdir(join(dir, '.env', 'inner'), { recursive: true });
    await expect(writeFileAtomic(join(dir, '.env'), 'A=1\n')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['.env']);
  });
});

describe('envNotIgnoredWarning', () => {
  it('is silent outside a checkout', async () => {
    expect(await envNotIgnoredWarning(join(dir, '.env'))).toBeUndefined();
  });

  it('warns in a checkout that does not ignore .env, and not once it does', async () => {
    execFileSync('git', ['init', '-q', dir]);
    expect(await envNotIgnoredWarning(join(dir, '.env'))).toMatch(/not ignored by git/);
    await writeFile(join(dir, '.gitignore'), '.env\n');
    expect(await envNotIgnoredWarning(join(dir, '.env'))).toBeUndefined();
  });
});
