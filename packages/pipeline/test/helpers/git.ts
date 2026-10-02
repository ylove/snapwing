// Local git fixtures for the fixer workdir and the local runner: a bare repository standing in for
// GitHub, seeded with one commit per branch. Git runs without the host's config.

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'],
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** Runs git and returns trimmed stdout; throws with stderr on a non-zero exit. */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface BareRepo {
  /** Path of the bare repository; usable as a clone URL. */
  url: string;
  remove(): Promise<void>;
}

/**
 * A bare repository whose default branch is `defaultBranch`, with one commit (a README) on it and on
 * each of `branches`, plus any `files` on the default branch.
 */
export async function createBareRepo(options: { defaultBranch?: string; branches?: string[]; files?: Record<string, string> } = {}): Promise<BareRepo> {
  const root = await mkdtemp(join(tmpdir(), 'snapwing-git-'));
  const url = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const main = options.defaultBranch ?? 'main';
  git(root, ['init', '--quiet', '--bare', `--initial-branch=${main}`, url]);
  git(root, ['init', '--quiet', `--initial-branch=${main}`, seed]);
  await writeFile(join(seed, 'README.md'), '# fixture\n');
  for (const [path, body] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), body);
  }
  git(seed, ['add', '-A']);
  git(seed, ['commit', '--quiet', '-m', 'seed']);
  git(seed, ['push', '--quiet', url, `HEAD:refs/heads/${main}`]);
  for (const b of options.branches ?? []) {
    git(seed, ['checkout', '--quiet', '-b', b, main]);
    await writeFile(join(seed, `${b.replaceAll('/', '-')}.txt`), `${b}\n`);
    git(seed, ['add', '-A']);
    git(seed, ['commit', '--quiet', '-m', `seed ${b}`]);
    git(seed, ['push', '--quiet', url, `HEAD:refs/heads/${b}`]);
  }
  return { url, remove: () => rm(root, { recursive: true, force: true }) };
}
