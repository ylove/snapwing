// src/server/work-root.ts: where runs keep their checkouts, bundles, and credentials files (#306).
//
// The work root is `SNAPWING_WORKDIR_ROOT`, else `work` under the server's data directory:
// `SNAPWING_DATA_DIR`, else `$XDG_STATE_HOME/snapwing`, else `~/.local/state/snapwing`. Not under the
// working directory (untrusted code may not run in or under the server's own tree, harness/
// untrusted-host.ts) and not the shared temp directory, where other users can see and race for names.
//
// At startup `ensurePrivateWorkRoot` creates a missing root (and any missing parent) as 0700, and refuses
// an existing one that is a link, not a directory, owned by another user, or open to group or others:
// runs leave checkouts and, briefly, credentials files there. It never loosens or tightens an existing
// directory itself; the error says what to change.

import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DATA_DIR_ENV = 'SNAPWING_DATA_DIR';
export const WORK_ROOT_ENV = 'SNAPWING_WORKDIR_ROOT';

type Env = Readonly<Record<string, string | undefined>>;

/** The server's data directory, absolute. */
export function dataDir(env: Env, home: string = homedir()): string {
  const explicit = env[DATA_DIR_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const state = env['XDG_STATE_HOME']?.trim();
  return join(state && isAbsolute(state) ? state : join(home, '.local', 'state'), 'snapwing');
}

/** The work root, absolute: `SNAPWING_WORKDIR_ROOT`, else `<data dir>/work`. */
export function workRoot(env: Env, home?: string): string {
  const explicit = env[WORK_ROOT_ENV]?.trim();
  return explicit ? resolve(explicit) : join(dataDir(env, home), 'work');
}

export class WorkRootError extends Error {
  override readonly name = 'WorkRootError';
}

/**
 * Creates `path` as a private directory when it is missing; refuses one that is not a directory of this
 * server's user with no group or other access. `uid` defaults to the process's (none on Windows: then
 * only the mode is checked).
 */
export async function ensurePrivateWorkRoot(path: string, uid: number | undefined = process.getuid?.()): Promise<void> {
  let st = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (st === undefined) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    st = await lstat(path);
  }
  const where = `the work root ${path} (${WORK_ROOT_ENV})`;
  if (st.isSymbolicLink()) throw new WorkRootError(`${where} is a symbolic link; point ${WORK_ROOT_ENV} at the directory itself`);
  if (!st.isDirectory()) throw new WorkRootError(`${where} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new WorkRootError(`${where} is owned by uid ${String(st.uid)}, not by this server's user (uid ${String(uid)}); use a directory this user owns`);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) throw new WorkRootError(`${where} has mode ${mode.toString(8).padStart(4, '0')}, open to other users; run chmod 700 on it`);
}
