// Generates an `npm-shrinkwrap.json` for a packed package from pnpm-lock.yaml (#274), so an `npx` or
// `npm install` of the tarball installs exactly the versions, and checks the integrity hashes, the
// repository resolved when it was packed. Only the package's production closure is written: its
// `dependencies` and their `dependencies` and `optionalDependencies`. A `workspace:` dependency is left
// out (the sibling tarball carries its own shrinkwrap), and a bundled one is marked `inBundle`.
//
// The tree is laid out the way npm does: a package goes at the top when nothing there conflicts, and
// nests under its dependent when another version already holds the top.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The lockfile document that holds the importers (pnpm may write an environment document first). */
export function readLock(root = ROOT) {
  const { parseAllDocuments } = createRequire(join(root, 'packages', 'app', 'package.json'))('yaml');
  const text = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  for (const doc of parseAllDocuments(text)) {
    const value = doc.toJS();
    if (value?.importers?.['packages/app'] !== undefined) return value;
  }
  throw new Error('pnpm-lock.yaml has no packages/app importer');
}

/** `name@1.2.3(peer@1)` -> { name, version } with the peer suffix dropped. */
function splitKey(key) {
  const at = key.indexOf('@', 1);
  return { name: key.slice(0, at), version: key.slice(at + 1).replace(/\(.*$/, '') };
}

function registryUrl(name, version) {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/**
 * @param {object} options
 * @param {object} options.lock           the parsed pnpm-lock.yaml
 * @param {string} options.importer       the workspace importer key, such as `packages/app`
 * @param {object} options.manifest       the shipped package.json
 * @param {string[]} [options.bundled]    workspace packages that ship inside the tarball
 */
export function shrinkwrapFor({ lock, importer, manifest, bundled = [] }) {
  const imp = lock.importers[importer];
  if (imp === undefined) throw new Error(`pnpm-lock.yaml has no importer ${importer}`);
  /** path -> entry */
  const nodes = new Map();
  /** snapshot key -> { name, version, snapshot, meta } */
  const info = (key) => {
    const { name, version } = splitKey(key);
    return { name, version, snapshot: lock.snapshots?.[key] ?? {}, meta: lock.packages?.[`${name}@${version}`] ?? {} };
  };
  const find = (from, name) => {
    // npm resolution: from/node_modules/name, then each ancestor's, then the top.
    let here = from;
    for (;;) {
      const path = here === '' ? `node_modules/${name}` : `${here}/node_modules/${name}`;
      if (nodes.has(path)) return path;
      if (here === '') return undefined;
      const cut = here.lastIndexOf('/node_modules/');
      here = cut === -1 ? '' : here.slice(0, cut);
    }
  };
  const entryFor = (item, optional) => {
    const { snapshot, meta } = item;
    const entry = {
      version: item.version,
      resolved: meta.resolution?.tarball ?? registryUrl(item.name, item.version),
      integrity: meta.resolution?.integrity,
    };
    if (optional || snapshot.optional === true) entry.optional = true;
    const deps = snapshot.dependencies ?? {};
    if (Object.keys(deps).length > 0) entry.dependencies = Object.fromEntries(Object.keys(deps).map((n) => [n, '*']));
    const opt = snapshot.optionalDependencies ?? {};
    if (Object.keys(opt).length > 0) entry.optionalDependencies = Object.fromEntries(Object.keys(opt).map((n) => [n, '*']));
    if (meta.engines !== undefined) entry.engines = meta.engines;
    if (meta.os !== undefined) entry.os = meta.os;
    if (meta.cpu !== undefined) entry.cpu = meta.cpu;
    if (meta.libc !== undefined) entry.libc = meta.libc;
    if (meta.requiresBuild === true) entry.hasInstallScript = true;
    return JSON.parse(JSON.stringify(entry));
  };

  /** Places `item` for a dependent at `from`; returns without descending when it is already placed. */
  const queue = [];
  const place = (from, name, version, optional) => {
    const key = `${name}@${version}`;
    const existing = find(from, name);
    if (existing !== undefined && nodes.get(existing).version === version) return;
    const path = existing === undefined ? `node_modules/${name}` : from === '' ? `node_modules/${name}` : `${from}/node_modules/${name}`;
    const item = info(key);
    nodes.set(path, entryFor(item, optional));
    queue.push({ path, item });
  };

  /** `version` in an importer or snapshot is a snapshot key suffix: `name@version` is the key. */
  const direct = Object.entries(imp.dependencies ?? {});
  const bundledEntries = {};
  for (const [name, spec] of direct) {
    if (String(spec.version).startsWith('link:')) {
      if (bundled.includes(name)) bundledEntries[name] = { version: manifest.dependencies?.[name] ?? '0.0.0', inBundle: true };
      continue;
    }
    place('', name, spec.version, false);
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { path, item } = next;
    for (const [name, version] of Object.entries(item.snapshot.dependencies ?? {})) place(path, name, version, false);
    for (const [name, version] of Object.entries(item.snapshot.optionalDependencies ?? {})) place(path, name, version, true);
  }

  const packages = { '': { name: manifest.name, version: manifest.version, license: manifest.license, dependencies: manifest.dependencies } };
  if (manifest.bin !== undefined) packages[''].bin = manifest.bin;
  if (manifest.engines !== undefined) packages[''].engines = manifest.engines;
  if (bundled.length > 0) packages[''].bundleDependencies = bundled;
  for (const [name, entry] of Object.entries(bundledEntries)) packages[`node_modules/${name}`] = entry;
  for (const path of [...nodes.keys()].sort()) packages[path] = nodes.get(path);
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
}
