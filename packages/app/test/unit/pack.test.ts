// Packaging without the network (#382, ADR 0021): `assetPath` and `serverCodeRoot` resolution, and
// the installed bin shim (`bin/snapwing.mjs`) passing its arguments and exit code through to `main`,
// run from the monorepo against a temp working directory. Packing and `npx` from the tarballs need the
// registry and live in the pack tier (`pnpm test:pack`, test/pack/pack.test.ts).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SNAPWING_ROOT } from '@snapwing/pipeline/harness/untrusted-host.ts';
import { ASSET_ROOT, assetPath, INSTALLED_PACKAGE, serverCodeRoot } from '@snapwing/pipeline/util/assets.ts';
import { USAGE } from '../../src/cli/main.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SHIM = fileURLToPath(new URL('../../bin/snapwing.mjs', import.meta.url));
const EXAMPLE_MAP = join(REPO_ROOT, 'examples', 'workspace-context.example.xml');

describe('assetPath in the monorepo', () => {
  it('resolves schemas, manifests, and demo from the repository root', () => {
    expect(INSTALLED_PACKAGE).toBe(false);
    expect(ASSET_ROOT).toBe(REPO_ROOT.replace(/[\\/]$/, ''));
    for (const asset of ['schemas/playbook.xsd', 'schemas/workspace-context.sch', 'manifests/github-app.json', 'demo/state/expected.json']) {
      expect(existsSync(assetPath(asset)), asset).toBe(true);
    }
  });

  it('refuses a path outside the asset directories', () => {
    expect(() => assetPath('packages/app/package.json')).toThrow(/not under/);
    expect(() => assetPath('schemas/../.env')).toThrow(/not under/);
    expect(() => assetPath('')).toThrow(/not under/);
  });

  it('puts the server tree at the repository root here, and at the outermost node_modules parent when installed', () => {
    expect(join(SNAPWING_ROOT, sep)).toBe(REPO_ROOT);
    const npx = join(sep, 'home', 'u', '.npm', '_npx', 'abc', 'node_modules', '@snapwing', 'pipeline');
    expect(serverCodeRoot(npx, true)).toBe(join(sep, 'home', 'u', '.npm', '_npx', 'abc'));
    const pnpm = join(sep, 'srv', 'proj', 'node_modules', '.pnpm', '@snapwing+pipeline@0.0.0', 'node_modules', '@snapwing', 'pipeline');
    expect(serverCodeRoot(pnpm, true)).toBe(join(sep, 'srv', 'proj'));
    expect(serverCodeRoot(join(sep, 'opt', 'snapwing'), true)).toBe(join(sep, 'opt', 'snapwing'));
  });
});

describe('bin/snapwing.mjs', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'snapwing-shim-'));
    await cp(EXAMPLE_MAP, join(cwd, 'map.xml'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** Runs the shim the way the installed `snapwing` does: plain node, the caller's directory. */
  const shim = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^snapwing_/i.test(k) && k !== 'NODE_OPTIONS') env[k] = v;
    return new Promise((resolve) => {
      execFile(process.execPath, [SHIM, ...args], { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
      });
    });
  };

  it('prints the usage for --help with exit 0, and for a bare snapwing with exit 1', async () => {
    const help = await shim('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(USAGE);
    const bare = await shim();
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain(USAGE);
  });

  it('passes arguments through: config check reads the map named relative to the working directory', async () => {
    const ok = await shim('config', 'check', '--map', 'map.xml');
    expect(ok.stdout).toContain('ok: map.xml');
    expect(ok.code).toBe(0);
    const missing = await shim('config', 'check', '--map', 'absent.xml');
    expect(missing.stdout).toContain('error: absent.xml: no such file');
    expect(missing.code).toBe(1);
    const unknown = await shim('no-such-command');
    expect(unknown.stderr).toContain('unknown command "no-such-command"');
    expect(unknown.code).toBe(1);
  });
});
