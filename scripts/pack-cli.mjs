#!/usr/bin/env node
// `pnpm pack:cli` (ADR 0021): packs `@snapwing/pipeline` and `@snapwing/app` as two tarballs that run
// `npx --yes -p <pipeline.tgz> -p <app.tgz> snapwing ...` from any directory, with nothing published.
//
//   node scripts/pack-cli.mjs [--out <dir>] [--json]
//
// Each package is staged in a temp directory and packed there with `npm pack`, so the working tree is
// never touched. Staging takes the package's `files`, drops `scripts` and `devDependencies`, and pins
// each `workspace:` dependency to that package's version (the sibling tarball satisfies it when both
// are installed together). The pipeline stage also gets the root `schemas/` and `manifests/` at its
// package root, where `assetPath` (pipeline/src/util/assets.ts) finds them once installed. `demo/` and
// the Slack test-driver manifest are for development and do not ship. Only files git tracks are staged
// (never an untracked `.env`, key, or database), and the pack fails if a staged path looks like a
// secret (see `SECRET_PATH`). The
// app stage bundles `@snapwing/capture-client` (no dependencies of its own) so two tarballs suffice.
// Writes to `--out` (default a fresh temp directory) and prints each tarball's path, or one JSON
// object `{ pipeline, app }` with `--json`.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const ASSET_DIRS = ['schemas', 'manifests'];
/** Tracked files that are not shipped even though they sit under an asset directory. */
const NOT_SHIPPED = new Set(['manifests/slack/test-driver.manifest.yaml']);
/** Paths that must never be staged: env files, keys, a `secrets/` directory, SQLite databases. */
const SECRET_PATH = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|secrets|[^/]*\.sqlite[^/]*)(\/|$)/;
const BUNDLED = ['@snapwing/capture-client'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** name -> { dir, manifest } for every workspace package. */
function workspacePackages() {
  const out = new Map();
  for (const dir of ['pipeline', 'app', 'capture-client']) {
    const manifest = readJson(join(PACKAGES, dir, 'package.json'));
    out.set(manifest.name, { dir: join(PACKAGES, dir), manifest });
  }
  return out;
}

/** The manifest as it ships: no scripts or devDependencies, `workspace:` pinned to versions. */
function shippedManifest(manifest, workspace) {
  const { scripts: _scripts, devDependencies: _dev, ...rest } = manifest;
  const dependencies = {};
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!String(spec).startsWith('workspace:')) {
      dependencies[name] = spec;
      continue;
    }
    const target = workspace.get(name);
    if (target === undefined) throw new Error(`${manifest.name}: ${name} is not a workspace package`);
    dependencies[name] = target.manifest.version;
  }
  return Object.keys(dependencies).length === 0 ? rest : { ...rest, dependencies };
}

/** Files git tracks under `paths` (repository-relative), so ignored and untracked files never ship. */
function trackedFiles(paths) {
  const raw = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: ROOT, encoding: 'utf8' });
  return raw.split('\0').filter((f) => f !== '' && !NOT_SHIPPED.has(f));
}

/** Copies the tracked files under `paths` (repository-relative) into `dest`, below `base`; refuses secrets. */
function stageTracked(paths, base, dest) {
  for (const file of trackedFiles(paths)) {
    if (SECRET_PATH.test(file)) throw new Error(`pack refused: ${file} looks like a secret and is tracked; remove it or rename it`);
    const to = join(dest, relative(base, join(ROOT, file)));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ROOT, file), to);
  }
}

/** Copies the package's `files` entries (tracked files only) into `stage`. */
function copyFiles(pkg, stage) {
  const paths = (pkg.manifest.files ?? ['src']).map((entry) => relative(ROOT, join(pkg.dir, entry)));
  stageTracked(paths, pkg.dir, stage);
}

function npmPack(stage, out) {
  const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', out], {
    cwd: stage,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [result] = JSON.parse(raw);
  return join(out, result.filename);
}

function stageAndPack(name, workspace, stageRoot, out, extra) {
  const pkg = workspace.get(name);
  const stage = join(stageRoot, name.replace('/', '-'));
  mkdirSync(stage, { recursive: true });
  copyFiles(pkg, stage);
  cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  const manifest = shippedManifest(pkg.manifest, workspace);
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(extra(stage, manifest), null, 2)}\n`);
  return npmPack(stage, out);
}

export function packCli(out) {
  const workspace = workspacePackages();
  const stageRoot = mkdtempSync(join(tmpdir(), 'snapwing-pack-stage-'));
  try {
    mkdirSync(out, { recursive: true });
    const pipeline = stageAndPack('@snapwing/pipeline', workspace, stageRoot, out, (stage, manifest) => {
      stageTracked(ASSET_DIRS, ROOT, stage);
      return manifest;
    });
    const app = stageAndPack('@snapwing/app', workspace, stageRoot, out, (stage, manifest) => {
      for (const name of BUNDLED) {
        const dep = workspace.get(name);
        const into = join(stage, 'node_modules', name);
        mkdirSync(into, { recursive: true });
        copyFiles(dep, into);
        writeFileSync(join(into, 'package.json'), `${JSON.stringify(shippedManifest(dep.manifest, workspace), null, 2)}\n`);
      }
      return { ...manifest, bundleDependencies: BUNDLED };
    });
    return { pipeline, app };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, json: { type: 'boolean', default: false } } });
  const out = values.out !== undefined ? resolve(values.out) : mkdtempSync(join(tmpdir(), 'snapwing-pack-'));
  const tarballs = packCli(out);
  process.stdout.write(values.json ? `${JSON.stringify(tarballs)}\n` : `${tarballs.pipeline}\n${tarballs.app}\n`);
}
