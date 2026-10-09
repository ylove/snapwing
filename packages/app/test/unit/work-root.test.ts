// The private work root (#306): where it defaults to, and what startup creates or refuses.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataDir, ensurePrivateWorkRoot, workRoot, WorkRootError } from '../../src/server/work-root.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'work-root-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the work root', () => {
  it('defaults to work under the data directory, never the shared temp directory', () => {
    expect(workRoot({}, '/home/pat')).toBe('/home/pat/.local/state/snapwing/work');
    expect(workRoot({ XDG_STATE_HOME: '/var/state' }, '/home/pat')).toBe('/var/state/snapwing/work');
    expect(workRoot({ XDG_STATE_HOME: 'relative' }, '/home/pat')).toBe('/home/pat/.local/state/snapwing/work');
    expect(workRoot({ SNAPWING_DATA_DIR: '/srv/snapwing' })).toBe('/srv/snapwing/work');
    expect(workRoot({ SNAPWING_DATA_DIR: '/srv/snapwing', SNAPWING_WORKDIR_ROOT: '/srv/runs' })).toBe('/srv/runs');
    expect(dataDir({ SNAPWING_DATA_DIR: ' /srv/snapwing ' })).toBe('/srv/snapwing');
    expect(workRoot({}).startsWith(tmpdir())).toBe(false);
  });

  it('creates a missing root, and its missing parents, private to this user', async () => {
    const root = join(dir, 'data', 'snapwing', 'work');
    await ensurePrivateWorkRoot(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'data')).mode & 0o077).toBe(0);
    // Idempotent.
    await ensurePrivateWorkRoot(root);
  });

  it('refuses a root open to group or others, owned by another user, a link, or a file, and changes none of them', async () => {
    const open = join(dir, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    await expect(ensurePrivateWorkRoot(open)).rejects.toThrow(/has mode 0755, open to other users; run chmod 700/);
    expect(statSync(open).mode & 0o777).toBe(0o755);

    const mine = join(dir, 'mine');
    mkdirSync(mine, { mode: 0o700 });
    const uid = statSync(mine).uid;
    await expect(ensurePrivateWorkRoot(mine, uid + 1)).rejects.toThrow(new RegExp(`owned by uid ${uid}, not by this server's user`));
    await expect(ensurePrivateWorkRoot(mine, uid)).resolves.toBeUndefined();

    symlinkSync(mine, join(dir, 'link'));
    await expect(ensurePrivateWorkRoot(join(dir, 'link'))).rejects.toThrow(/is a symbolic link/);
    writeFileSync(join(dir, 'file'), 'x');
    await expect(ensurePrivateWorkRoot(join(dir, 'file'))).rejects.toBeInstanceOf(WorkRootError);
  });
});
