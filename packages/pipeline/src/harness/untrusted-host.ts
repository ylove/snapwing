// src/harness/untrusted-host.ts: interim guards for untrusted code that runs on the host (ADR 0017).
//
// Fixer edits, a pull request's test command, and review runs are untrusted (main 16). Their place is
// inside the RunnerPort's isolation boundary (the docker provider, or another container or VM
// provider); the `local` runner and the host-side regression proof are for development. While they
// run on the host, two guards narrow what the code can reach without pretending to be a boundary:
//
// - `createScratchHome`: HOME and TMPDIR point at a fresh private directory, never the server user's
//   home, so `~/.ssh`, `~/.git-credentials`, `~/.config/gh`, and CLI logins are not found by path.
// - `serverTreeConflict`: the working directory must be outside the server's own tree (the Snapwing
//   checkout this code runs from, and the server's working directory, where `.env` is read by
//   default), so a relative path never lands on the server's secrets.
//
// Neither stops a process that knows an absolute path the server user can read. Only the runner's
// isolation boundary does that; hence the `local` runner refuses production (`snapwing serve`).

import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Snapwing checkout this code runs from (the repository root in a source checkout). */
export const SNAPWING_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface ScratchHome {
  /** Parent of `home` and `tmp`, for callers that keep more scratch state beside them. */
  root: string;
  /** The untrusted process's HOME: empty, private (0700), and never `os.homedir()`. */
  home: string;
  /** The untrusted process's TMPDIR: private to this run, so it cannot browse other runs' temp files. */
  tmp: string;
  /** Removes `root` and everything under it. Never throws. */
  dispose(): Promise<void>;
}

/** A fresh `{ root, home, tmp }` under the server's temp directory. `label` names it for debugging. */
export async function createScratchHome(label: string): Promise<ScratchHome> {
  const root = await mkdtemp(join(tmpdir(), `snapwing-${label}-`));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(tmp, { mode: 0o700 });
  } catch (e) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return { root, home, tmp, dispose: () => rm(root, { recursive: true, force: true }).catch(() => undefined) };
}

/**
 * The directories untrusted code must not run in, under, or above: the Snapwing checkout, and the
 * server's working directory unless that is a filesystem root or the user's home (too broad to be
 * "the server's tree"; the scratch HOME covers the home directory).
 */
export function serverTreeRoots(cwd: string = process.cwd()): string[] {
  const roots = [SNAPWING_ROOT];
  const dir = resolve(cwd);
  if (parse(dir).root !== dir && canonical(dir) !== canonical(homedir())) roots.push(dir);
  return roots;
}

/**
 * Why `dir` may not hold untrusted code, or undefined when it may: it is a server tree root, inside
 * one, or contains one. Paths are compared after resolving symlinks (`/tmp` is `/private/tmp` on
 * macOS); a path that does not exist yet is compared through its nearest existing ancestor.
 */
export function serverTreeConflict(dir: string, roots: readonly string[] = serverTreeRoots()): string | undefined {
  const target = canonical(dir);
  for (const root of roots.map(canonical)) {
    if (within(root, target)) return `${dir} is inside the server's own tree (${root})`;
    if (within(target, root)) return `${dir} contains the server's own tree (${root})`;
  }
  return undefined;
}

/** Throws `ServerTreeError` when `dir` may not hold untrusted code (see `serverTreeConflict`). */
export function assertOutsideServerTree(dir: string, roots?: readonly string[]): void {
  const conflict = serverTreeConflict(dir, roots);
  if (conflict !== undefined) throw new ServerTreeError(conflict);
}

export class ServerTreeError extends Error {
  constructor(message: string) {
    super(`untrusted code may not run here: ${message}`);
    this.name = 'ServerTreeError';
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** `path` absolute with symlinks resolved; the missing tail of a path that does not exist is kept as is. */
function canonical(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const { root, base } = parse(head);
      if (head === root) return resolve(path);
      tail.unshift(base);
      head = resolve(head, '..');
    }
  }
}
