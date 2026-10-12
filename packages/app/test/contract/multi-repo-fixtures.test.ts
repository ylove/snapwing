// The multi-repo contract fixtures (public #333, main 14.4): shared-ui and web seeded as local bare
// repositories, web pinned to shared-ui's seeded commit. Each suite is green at seed, the bug shows at
// seed (a euro cart priced with a dollar sign), and the scripted agent's two fixes (shared-ui first, then
// web pinned to the producer commit its request names) leave both suites green and the bug gone.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git, GIT_ENV } from '../../../pipeline/test/helpers/git.ts';
import { FakeGitHub } from '../fixtures/e2e/github.ts';
import { seedMultiRepo, type MultiRepoSeed } from '../fixtures/e2e/multi-repo/seed.ts';

const AGENT = fileURLToPath(new URL('../e2e/helpers/fake-agent.mjs', import.meta.url));
const KEY = 'OAJ-7';

let scratch: string;
let github: FakeGitHub;
let seed: MultiRepoSeed;

/** Runs a command, returning stdout; a failing suite throws with its output. */
function run(cwd: string, command: string, args: string[], input?: string): string {
  return execFileSync(command, args, { cwd, env: GIT_ENV, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function clone(repo: string, name: string): Promise<string> {
  const dir = join(scratch, name);
  git(scratch, ['clone', '--quiet', github.remoteUrl(repo), dir]);
  return dir;
}

/** The repository's own suite: web resolves its pinned shared-ui first, as `npm test` does. */
function suite(dir: string, web: boolean): string {
  if (web) run(dir, 'node', ['scripts/resolve-shared-ui.mjs']);
  return run(dir, 'node', ['--test', 'test/*.mjs']);
}

const EUR_CART = `{ currency: 'EUR', lines: [{ sku: 'a', unitPriceCents: 1000, quantity: 2 }] }`;
function euroLabel(web: string): string {
  return run(web, 'node', ['--input-type=module', '-e', `import { totalLabel } from './src/storefront.mjs'; console.log(totalLabel(${EUR_CART}));`]).trim();
}

/** The scripted fixer on `dir`, on a work branch, with `request` on stdin; returns its result and pushes the branch. */
function fix(dir: string, request: string): { outcome: string; branch: string; head: string } {
  git(dir, ['checkout', '--quiet', '-b', `fix/${KEY}`]);
  const out = run(dir, 'node', [AGENT, scratch, '1'], request);
  const result = JSON.parse(out) as { outcome: string; branch: string };
  git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/fix/${KEY}`]);
  return { ...result, head: git(dir, ['rev-parse', 'HEAD']) };
}

const request = (extra = ''): string => `<implementation-request issue="${KEY}"><intent>Euro prices show a dollar sign.</intent>${extra}</implementation-request>`;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-multi-repo-'));
  github = new FakeGitHub(scratch);
  seed = await seedMultiRepo(github);
});

afterAll(async () => {
  await github.remove();
  await rm(scratch, { recursive: true, force: true });
});

describe('multi-repo fixtures', () => {
  it('pins web to shared-ui by commit, in package.json', async () => {
    const web = await clone(seed.web.repo, 'web-pin');
    const pkg = JSON.parse(await readFile(join(web, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@fixture/shared-ui']).toBe(`git+file://${seed.sharedUi.url}#${seed.sharedUi.sha}`);
  });

  it('is green at seed in both repositories, and shows the bug at seed', async () => {
    const sharedUi = await clone(seed.sharedUi.repo, 'ui-seed');
    const web = await clone(seed.web.repo, 'web-seed');
    expect(suite(sharedUi, false)).toContain('ℹ fail 0');
    expect(suite(web, true)).toContain('ℹ fail 0');
    expect(euroLabel(web)).toBe('Total $20.00');
  });

  it('fixes the bug only with both scripted fixes, shared-ui first and web pinned to its commit', async () => {
    const sharedUi = await clone(seed.sharedUi.repo, 'ui-fix');
    const producer = fix(sharedUi, request());
    expect(producer.outcome).toBe('done');
    expect(producer.head).not.toBe(seed.sharedUi.sha);
    expect(suite(sharedUi, false)).toContain('ℹ fail 0');

    // The shared-ui fix alone does not change web: its pin is the seeded commit.
    const stale = await clone(seed.web.repo, 'web-stale');
    suite(stale, true);
    expect(euroLabel(stale)).toBe('Total $20.00');

    const web = await clone(seed.web.repo, 'web-fix');
    const consumer = fix(web, request(`<workItem id="web" repo="github.com/${seed.web.repo}" producer-commit="${producer.head}"/>`));
    expect(consumer.outcome).toBe('done');
    const pkg = await readFile(join(web, 'package.json'), 'utf8');
    expect(pkg).toContain(`#${producer.head}"`);
    expect(suite(web, true)).toContain('ℹ fail 0');
    expect(euroLabel(web)).toBe('Total €20.00');
  });

  it('fails the web fix when the request names no commit', async () => {
    const web = await clone(seed.web.repo, 'web-nocommit');
    git(web, ['checkout', '--quiet', '-b', 'fix/none']);
    const out = JSON.parse(run(web, 'node', [AGENT, scratch, '1'], request())) as { outcome: string; reason: string };
    expect(out.outcome).toBe('failed');
    expect(out.reason).toContain('producer commit');
  });
});
