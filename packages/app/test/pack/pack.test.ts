// The pack tier (`pnpm test:pack`, #382, ADR 0021): `pnpm pack:cli` writes the pipeline and app
// tarballs, and `npx` runs `snapwing` from them in an empty directory outside the repository, with
// nothing published. It needs npm and the registry (npx installs the packages' dependencies), so it
// is its own tier, never part of unit or contract, and is skipped, with the reason in its title, when
// npm is not on PATH. The network-free half (assetPath, the bin shim) is test/unit/pack.test.ts.
// npm runs on a cache of its own under the OS temp directory, shared by runs so later runs are quick,
// and the npx install this test makes is removed.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverTreeConflict } from '@snapwing/pipeline/harness/untrusted-host.ts';
import { USAGE } from '../../src/cli/main.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACK_SCRIPT = join(REPO_ROOT, 'scripts', 'pack-cli.mjs');
const EXAMPLE_MAP = join(REPO_ROOT, 'examples', 'workspace-context.example.xml');
const NPM_CACHE = join(tmpdir(), 'snapwing-pack-test-npm-cache');

function npmVersion(): string | undefined {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** The environment npm gets: none of pnpm's `npm_*` settings or the server's `SNAPWING_*` ones. */
function npmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|snapwing_)/i.test(k) || k === 'NODE_OPTIONS' || k === 'INIT_CWD') continue;
    env[k] = v;
  }
  return {
    ...env,
    npm_config_cache: NPM_CACHE,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
    npm_config_prefer_offline: 'true',
  };
}

const NPM = npmVersion();
const title = NPM === undefined ? 'npx snapwing from packed tarballs (skipped: npm is not on PATH)' : 'npx snapwing from packed tarballs';

describe.skipIf(NPM === undefined)(title, () => {
  let root: string;
  let empty: string;
  let tarballs: { pipeline: string; app: string };
  let env: NodeJS.ProcessEnv;

  const npx = (...args: string[]): Promise<Run> =>
    run('npx', ['--yes', '-p', tarballs.pipeline, '-p', tarballs.app, 'snapwing', ...args], empty, env);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'snapwing-pack-'));
    empty = join(root, 'empty');
    await mkdir(empty);
    await cp(EXAMPLE_MAP, join(empty, 'workspace-context.example.xml'));
    env = npmEnv();
    const packed = await run('node', [PACK_SCRIPT, '--out', join(root, 'tarballs'), '--json'], REPO_ROOT, env);
    expect(packed.stderr).toBe('');
    expect(packed.code).toBe(0);
    tarballs = JSON.parse(packed.stdout) as { pipeline: string; app: string };
  }, 120_000);

  afterAll(async () => {
    // npx keeps each install under <cache>/_npx/<hash>; remove the ones pointing at this run's tarballs.
    const npxDir = join(NPM_CACHE, '_npx');
    for (const entry of await readdir(npxDir).catch(() => [] as string[])) {
      const manifest = await readFile(join(npxDir, entry, 'package.json'), 'utf8').catch(() => '');
      if (root !== undefined && manifest.includes(root)) await rm(join(npxDir, entry), { recursive: true, force: true });
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }, 120_000);

  it('writes both tarballs outside the repository', () => {
    for (const tgz of [tarballs.pipeline, tarballs.app]) {
      expect(existsSync(tgz)).toBe(true);
      expect(relative(REPO_ROOT, tgz).startsWith('..')).toBe(true);
    }
    expect(tarballs.pipeline).toMatch(/snapwing-pipeline-.*\.tgz$/);
    expect(tarballs.app).toMatch(/snapwing-app-.*\.tgz$/);
  });

  it('prints the usage for --help, and for a bare snapwing with exit 1', async () => {
    const help = await npx('--help');
    expect(help.stderr).not.toMatch(/ERR!|npm error/);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(USAGE);

    const bare = await npx();
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain(USAGE);
  }, 600_000);

  it('validates the example map with config check, the schemas coming from the installed package', async () => {
    const check = await npx('config', 'check', '--map', 'workspace-context.example.xml');
    expect(check.stdout).toContain('ok: workspace-context.example.xml');
    expect(check.stdout).toContain('0 errors');
    expect(check.code).toBe(0);
  }, 600_000);

  it('resolves assets and the server tree inside the installed packages', async () => {
    const npxDir = join(NPM_CACHE, '_npx');
    let install: string | undefined;
    for (const entry of await readdir(npxDir)) {
      const manifest = await readFile(join(npxDir, entry, 'package.json'), 'utf8').catch(() => '');
      if (manifest.includes(tarballs.app)) install = join(npxDir, entry);
    }
    expect(install, 'the npx install of this run').toBeDefined();
    const probe = `
      import { register } from 'tsx/esm/api';
      register({ tsconfig: false });
      const { existsSync } = await import('node:fs');
      const a = await import('@snapwing/pipeline/util/assets.ts');
      const h = await import('@snapwing/pipeline/harness/untrusted-host.ts');
      const assets = ['schemas/playbook.xsd', 'manifests/github-app.json', 'demo/state/expected.json'].map((p) => a.assetPath(p));
      const app = (await import('node:path')).join(process.cwd(), 'node_modules', '@snapwing', 'app');
      console.log(JSON.stringify({
        installed: a.INSTALLED_PACKAGE,
        assetRoot: a.ASSET_ROOT,
        assetsExist: assets.every((p) => existsSync(p)),
        root: h.SNAPWING_ROOT,
        appConflict: h.serverTreeConflict(app, [h.SNAPWING_ROOT]) ?? null,
      }));
    `;
    const out = await run('node', ['--input-type=module', '-e', probe], install as string, env);
    expect(out.stderr).toBe('');
    const result = JSON.parse(out.stdout) as { installed: boolean; assetRoot: string; assetsExist: boolean; root: string; appConflict: string | null };
    expect(result.installed).toBe(true);
    expect(result.assetRoot).toContain(join('node_modules', '@snapwing', 'pipeline'));
    expect(result.assetsExist).toBe(true);
    expect(serverTreeConflict(install as string, [result.root])).toBeDefined();
    expect(result.appConflict).toMatch(/inside the server's own tree/);
  }, 120_000);
});
