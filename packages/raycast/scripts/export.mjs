#!/usr/bin/env node
// `pnpm raycast:export --out <dir>` (#361, spec main 23): writes a self-contained copy of the Raycast
// extension for the Raycast Store. The Store cannot resolve `workspace:*`, so the capture client's
// source is vendored under `src/vendor/` and the imports that name it are rewritten to relative paths.
// The source packages are only read, never changed.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = resolve(PKG, '..', 'capture-client');
const CLIENT_NAME = '@snapwing/capture-client';

// A standalone compiler config: the workspace one extends a root file the export does not carry.
const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2023'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noImplicitAny: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    jsx: 'react-jsx',
    types: ['node'],
  },
  include: ['src'],
};

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Rewrites `@snapwing/capture-client[/file]` specifiers in `text` (a file at `file`) to vendored relative paths. */
export function rewriteImports(text, file, vendorDir) {
  const spec = new RegExp(`(['"])${CLIENT_NAME}(?:/([^'"]+))?\\1`, 'g');
  return text.replace(spec, (_m, quote, sub) => {
    let rel = relative(dirname(file), join(vendorDir, sub ?? 'index.ts')).split('\\').join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${quote}${rel}${quote}`;
  });
}

/** The Store manifest: no workspace specifiers, not private, `@raycast/api` the only runtime dependency. */
export function exportManifest(pkg) {
  const out = { ...pkg };
  delete out.private;
  delete out.exports;
  const dependencies = {};
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (name === CLIENT_NAME) continue;
    if (String(range).startsWith('workspace:')) throw new Error(`Unexpected workspace dependency ${name}`);
    dependencies[name] = range;
  }
  out.dependencies = dependencies;
  const devDependencies = { ...pkg.devDependencies };
  delete devDependencies.vitest;
  out.devDependencies = devDependencies;
  const scripts = {};
  for (const name of ['dev', 'build']) if (pkg.scripts?.[name]) scripts[name] = pkg.scripts[name];
  scripts.lint = 'ray lint';
  scripts.typecheck = 'tsc --noEmit';
  out.scripts = scripts;
  return out;
}

export function exportExtension(out) {
  const dest = resolve(out);
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`${dest} exists and is not empty`);
  mkdirSync(dest, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  writeFileSync(join(dest, 'package.json'), `${JSON.stringify(exportManifest(pkg), null, 2)}\n`);
  writeFileSync(join(dest, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  for (const name of ['assets', 'metadata']) {
    mkdirSync(join(dest, name), { recursive: true });
    if (existsSync(join(PKG, name))) cpSync(join(PKG, name), join(dest, name), { recursive: true });
  }
  for (const name of ['README.md', 'CHANGELOG.md']) cpSync(join(PKG, name), join(dest, name));

  cpSync(join(PKG, 'src'), join(dest, 'src'), { recursive: true });
  const vendor = join(dest, 'src', 'vendor');
  cpSync(join(CLIENT, 'src'), vendor, { recursive: true });
  for (const file of walk(join(dest, 'src'))) {
    if (!/\.tsx?$/.test(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = rewriteImports(before, file, vendor);
    if (after !== before) writeFileSync(file, after);
    if (/['"]@snapwing\//.test(after)) throw new Error(`${file} still names a workspace package`);
  }
  return dest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: pnpm raycast:export --out <dir>');
    process.exit(2);
  }
  try {
    console.log(exportExtension(values.out));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
