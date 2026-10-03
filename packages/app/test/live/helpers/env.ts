// Shared by the live tier: find `.env.live` and read named values from it (or the environment).
// `SNAPWING_ENV_LIVE` points at the file; otherwise the nearest `.env.live` up the tree is used.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';

export function findEnvFile(): string {
  const fromEnv = process.env.SNAPWING_ENV_LIVE;
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env.live');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(dir, '.env.live');
}

/** The named values, each empty when missing. Never throws and never logs a value. */
export async function readLiveEnv<const N extends readonly string[]>(names: N): Promise<{ [K in N[number]]: string }> {
  const secrets = createEnvFileSecrets({ path: findEnvFile() });
  const entries = await Promise.all(names.map(async (n) => [n, await secrets.get(n).then((v) => v, () => '')] as const));
  return Object.fromEntries(entries) as { [K in N[number]]: string };
}
