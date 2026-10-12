// Seeds the multi-repo contract fixtures (public #333, main 14.4) into the e2e world's fake GitHub, the way
// the world seeds any repository: a local bare repository per `owner/name` (`FakeGitHub.addRepo`).
//
// Two repositories carry one bug that needs both: `shared-ui` (a price formatter with no currency) and
// `web` (a storefront that shows prices through it and never passes the cart's currency). Web pins
// shared-ui by commit in its `package.json` as `git+file://<shared-ui bare repository>#<commit>`, and its
// `npm test` checks that commit out of the local repository (`scripts/resolve-shared-ui.mjs`), so both
// suites run with no network. The pin is the seeded commit of shared-ui's `main`, known only after
// shared-ui is seeded, which is why `web`'s `package.json` is a template here.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_ENV } from '../../../../../pipeline/test/helpers/git.ts';
import type { FakeGitHub } from '../github.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SHARED_UI_DIR = join(HERE, 'shared-ui');
export const WEB_DIR = join(HERE, 'web');

/** The repository names the fixtures seed by default. */
export const MULTI_REPO_NAMES = { sharedUi: 'acme/shared-ui', web: 'acme/web' } as const;

export interface SeededRepo {
  /** `owner/name`, as the map writes it after `github.com/`. */
  repo: string;
  /** The bare repository path, usable as a clone URL. */
  url: string;
  /** The seeded commit on `main`. */
  sha: string;
}

export interface MultiRepoSeed {
  sharedUi: SeededRepo;
  web: SeededRepo;
}

/** Every file under `dir` as a path-to-content map (paths relative, `/` separated; dotfiles included). */
export function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(dir, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return files;
}

/** Web's files with its shared-ui pin filled in. */
export function webFiles(sharedUiUrl: string, sharedUiSha: string): Record<string, string> {
  const files = readTree(WEB_DIR);
  const pkg = files['package.json'];
  if (pkg === undefined) throw new Error('multi-repo fixtures: web has no package.json');
  files['package.json'] = pkg.replace('{{SHARED_UI_URL}}', sharedUiUrl).replace('{{SHARED_UI_SHA}}', sharedUiSha);
  return files;
}

/**
 * Seeds both repositories into `github` and returns where they are. Shared-ui first, so web can pin its
 * seeded commit. `github.remove()` cleans both up with the rest of the world.
 */
export async function seedMultiRepo(
  github: Pick<FakeGitHub, 'addRepo' | 'repos'>,
  names: { sharedUi: string; web: string } = MULTI_REPO_NAMES,
): Promise<MultiRepoSeed> {
  const seeded = (repo: string): SeededRepo => {
    const bare = github.repos.get(repo);
    if (bare === undefined) throw new Error(`multi-repo fixtures: ${repo} was not seeded`);
    const sha = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare.url, env: GIT_ENV, encoding: 'utf8' }).trim();
    return { repo, url: bare.url, sha };
  };
  await github.addRepo(names.sharedUi, readTree(SHARED_UI_DIR));
  const sharedUi = seeded(names.sharedUi);
  await github.addRepo(names.web, webFiles(sharedUi.url, sharedUi.sha));
  return { sharedUi, web: seeded(names.web) };
}
