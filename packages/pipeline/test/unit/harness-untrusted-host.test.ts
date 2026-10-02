// The host-side guards for untrusted code (ADR 0017, #233): a scratch HOME and TMPDIR per run, and no
// working directory in or above the server's own tree.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertOutsideServerTree,
  createScratchHome,
  ServerTreeError,
  serverTreeConflict,
  serverTreeRoots,
  SNAPWING_ROOT,
} from '../../src/harness/untrusted-host.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'snapwing-untrusted-host-test-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('createScratchHome', () => {
  it('makes a fresh, empty, private HOME and TMPDIR that is never the server user\'s home', async () => {
    const a = await createScratchHome('test');
    const b = await createScratchHome('test');
    try {
      expect(a.home).not.toBe(homedir());
      expect(a.home).not.toBe(b.home);
      expect(a.tmp).not.toBe(tmpdir());
      expect(readdirSync(a.home)).toEqual([]);
      expect(readdirSync(a.tmp)).toEqual([]);
      if (process.platform !== 'win32') {
        expect(statSync(a.home).mode & 0o777).toBe(0o700);
        expect(statSync(a.tmp).mode & 0o777).toBe(0o700);
      }
      expect(serverTreeConflict(a.root)).toBeUndefined();
    } finally {
      await a.dispose();
      await b.dispose();
    }
    expect(existsSync(a.root)).toBe(false);
    await a.dispose(); // twice is fine
  });
});

describe('serverTreeConflict', () => {
  const server = join(scratch, 'server');
  mkdirSync(join(server, 'secrets'), { recursive: true });
  const roots = [server];

  it('accepts a directory beside the server tree', () => {
    expect(serverTreeConflict(join(scratch, 'runs'), roots)).toBeUndefined();
    expect(serverTreeConflict(join(scratch, 'server-runs'), roots)).toBeUndefined();
  });

  it('refuses the tree itself, anything inside it, and anything above it', () => {
    expect(serverTreeConflict(server, roots)).toMatch(/inside the server's own tree/);
    expect(serverTreeConflict(join(server, 'secrets'), roots)).toMatch(/inside/);
    expect(serverTreeConflict(join(server, 'not', 'yet', 'made'), roots)).toMatch(/inside/);
    expect(serverTreeConflict(join(server, 'x', '..', '..', 'server', 'y'), roots)).toMatch(/inside/);
    expect(serverTreeConflict(scratch, roots)).toMatch(/contains the server's own tree/);
    expect(serverTreeConflict('/', roots)).toMatch(/contains/);
  });

  it('sees through a symlink into the tree', () => {
    const link = join(scratch, 'innocent-looking');
    symlinkSync(server, link);
    expect(serverTreeConflict(join(link, 'run-1'), roots)).toMatch(/inside/);
  });

  it('assertOutsideServerTree throws ServerTreeError', () => {
    expect(() => assertOutsideServerTree(join(server, 'runs'), roots)).toThrow(ServerTreeError);
    expect(() => assertOutsideServerTree(join(scratch, 'runs'), roots)).not.toThrow();
  });
});

describe('serverTreeRoots', () => {
  it('is the Snapwing checkout and the server\'s working directory', () => {
    expect(realpathSync(SNAPWING_ROOT)).toBe(realpathSync(fileURLToPath(new URL('../../../../', import.meta.url))));
    expect(existsSync(join(SNAPWING_ROOT, 'BUILDING.md'))).toBe(true);
    expect(serverTreeRoots('/srv/snapwing')).toEqual([SNAPWING_ROOT, '/srv/snapwing']);
  });

  it('leaves out a working directory that is a filesystem root or the user\'s home', () => {
    expect(serverTreeRoots('/')).toEqual([SNAPWING_ROOT]);
    expect(serverTreeRoots(homedir())).toEqual([SNAPWING_ROOT]);
  });
});
