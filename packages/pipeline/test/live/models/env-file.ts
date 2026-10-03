// Where the live model tests look for `.env.live`: SNAPWING_ENV_LIVE, else the checkout's own root (the
// nearest directory up the tree with `pnpm-workspace.yaml`), never a directory above it. A git worktree
// lives inside another checkout (`.claude/worktrees/...`); that checkout's secrets must not be found.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function envLiveFile(start: string = dirname(fileURLToPath(import.meta.url))): string {
  const fromEnv = process.env['SNAPWING_ENV_LIVE'];
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.env.live');
    if (dirname(dir) === dir) break;
  }
  return resolve(start, '../../../.env.live');
}
