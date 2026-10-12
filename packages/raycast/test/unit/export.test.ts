import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The Store export (#361, spec main 23): a self-contained directory with the capture client vendored.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(PKG, 'scripts', 'export.mjs');

let work: string;
let out: string;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function sourceFiles(): string[] {
  return [...walk(join(out, 'src'))].filter((f) => /\.tsx?$/.test(f));
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) found.push(m[1] as string);
  return found;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'snapwing-raycast-export-'));
  out = join(work, 'extension');
  execFileSync(process.execPath, [SCRIPT, '--out', out], { stdio: 'pipe' });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('raycast export', () => {
  it('writes the manifest, assets, README, CHANGELOG and metadata', () => {
    for (const name of ['package.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'assets/command-icon.png', 'metadata']) {
      expect(existsSync(join(out, name)), name).toBe(true);
    }
    expect(existsSync(join(out, 'src', 'vendor', 'client.ts'))).toBe(true);
  });

  it('has no workspace specifier and is not private', () => {
    const raw = readFileSync(join(out, 'package.json'), 'utf8');
    expect(raw).not.toContain('workspace:');
    expect(raw).not.toContain('@snapwing/');
    expect((JSON.parse(raw) as { private?: boolean }).private).toBeUndefined();
  });

  it('keeps @raycast/api as the only runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['@raycast/api']);
  });

  it('resolves every relative import inside the directory', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        expect(spec.startsWith('@snapwing/'), `${file}: ${spec}`).toBe(false);
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec);
        expect(target.startsWith(`${out}/`), `${file}: ${spec} leaves the directory`).toBe(true);
        expect(existsSync(target), `${file}: ${spec}`).toBe(true);
      }
    }
  });

  it('vendors the capture client source unchanged apart from import paths', () => {
    const src = join(PKG, '..', 'capture-client', 'src');
    for (const name of readdirSync(src)) {
      expect(readFileSync(join(out, 'src', 'vendor', name), 'utf8')).toBe(readFileSync(join(src, name), 'utf8'));
    }
  });

  it('refuses to overwrite a non-empty directory', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--out', out], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not empty');
  });

  // Offline: the exported directory borrows the workspace's installed copy of `@raycast/api`, React and
  // the TypeScript compiler through a node_modules link, so no network install is needed.
  describe('inside the exported directory', () => {
    beforeAll(() => {
      symlinkSync(join(PKG, 'node_modules'), join(out, 'node_modules'), 'dir');
    });

    it('passes tsc --noEmit', () => {
      const run = spawnSync(join(out, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], {
        cwd: out,
        encoding: 'utf8',
      });
      expect(run.stdout + run.stderr).toBe('');
      expect(run.status).toBe(0);
    }, 120_000);

    const ray = join(PKG, 'node_modules', '.bin', 'ray');
    const lint = existsSync(ray) ? it : it.skip;
    // Skipped (not failed) when the Raycast CLI is not installed: `ray lint` ships with `@raycast/api`.
    lint('passes ray lint apart from the author, which is set at submission', () => {
      // Without workspace tools on PATH, `ray lint` skips its ESLint and Prettier formatting checks.
      const path = (process.env.PATH ?? '').split(delimiter).filter((p) => !p.includes('node_modules'));
      const run = spawnSync(ray, ['lint'], { cwd: out, encoding: 'utf8', env: { ...process.env, PATH: path.join(delimiter) } });
      const text = `${run.stdout}${run.stderr}`.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
      const errors = text.split('\n').filter((l) => /^\s*\d+:\d+\s+error\s/.test(l) && !/Invalid author/.test(l));
      expect(errors, text).toEqual([]);
    }, 120_000);
    if (!existsSync(ray)) console.warn('ray lint skipped: the Raycast CLI is not installed');
  });
});
