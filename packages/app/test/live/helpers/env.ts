// Shared by the live tier: find `.env.live` and read named values from it (or the environment).
// `SNAPWING_ENV_LIVE` points at the file; otherwise it is the `.env.live` at the root of this checkout (the
// nearest directory up the tree with `pnpm-workspace.yaml`), never one above it: a git worktree lives inside
// another checkout (`.claude/worktrees/...`), and that checkout's secrets must not make its live run go live.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';

export function findEnvFile(start: string = dirname(fileURLToPath(import.meta.url))): string {
  const fromEnv = process.env.SNAPWING_ENV_LIVE;
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.env.live');
    if (dirname(dir) === dir) break;
  }
  // No workspace root above the start (the repository always has one): this package's root.
  return resolve(start, '../../../.env.live');
}

/** The named values, each empty when missing. Never throws and never logs a value. */
export async function readLiveEnv<const N extends readonly string[]>(names: N): Promise<{ [K in N[number]]: string }> {
  const secrets = createEnvFileSecrets({ path: findEnvFile() });
  const entries = await Promise.all(names.map(async (n) => [n, await secrets.get(n).then((v) => v, () => '')] as const));
  return Object.fromEntries(entries) as { [K in N[number]]: string };
}
