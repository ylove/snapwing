// Root assets (`schemas/`, `manifests/`, `demo/`) from a source checkout or an installed package (ADR 0021).
//
// In the monorepo the assets sit at the repository root, beside `packages/`. `pnpm pack:cli` copies
// them into the `@snapwing/pipeline` tarball at the package root, so an installed package carries its
// own copy (`node_modules/@snapwing/pipeline/schemas/...`). Code never builds `../../../../schemas`
// URLs itself: it asks `assetPath('schemas/playbook.xsd')`. Prompts are not assets; they sit beside
// their modules under `src/prompts/` and ship in the package as they are.

import { existsSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The `@snapwing/pipeline` package directory (`packages/pipeline` in the monorepo). */
export const PIPELINE_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** True when this code runs from a packed tarball: the assets were copied into the package root. */
export const INSTALLED_PACKAGE = existsSync(join(PIPELINE_PACKAGE_ROOT, 'schemas'));

/** Where `assetPath` resolves from: the package root when installed, else the repository root. */
export const ASSET_ROOT = INSTALLED_PACKAGE ? PIPELINE_PACKAGE_ROOT : resolve(PIPELINE_PACKAGE_ROOT, '..', '..');

/** The top-level asset directories `pnpm pack:cli` ships in the pipeline tarball. */
export const ASSET_DIRS = ['schemas', 'manifests', 'demo'] as const;

/**
 * Absolute path of a root asset, such as `assetPath('schemas/playbook.xsd')`. `relative` starts with
 * one of `ASSET_DIRS` and may not climb out of it.
 */
export function assetPath(relative: string): string {
  const parts = relative.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  const [top] = parts;
  if (top === undefined || !(ASSET_DIRS as readonly string[]).includes(top) || parts.includes('..')) {
    throw new Error(`assetPath: ${JSON.stringify(relative)} is not under ${ASSET_DIRS.join('/, ')}/`);
  }
  return join(ASSET_ROOT, ...parts);
}

/**
 * The tree Snapwing's own code runs from, which untrusted code must stay out of (ADR 0017). In the
 * monorepo that is the repository root. Installed, it is the directory that holds the outermost
 * `node_modules` the package sits in (the npx cache entry, or the project that installed it), so it
 * covers `@snapwing/app` and every dependency whatever the package manager's layout.
 */
export function serverCodeRoot(packageRoot: string = PIPELINE_PACKAGE_ROOT, installed: boolean = INSTALLED_PACKAGE): string {
  const dir = resolve(packageRoot);
  if (!installed) return resolve(dir, '..', '..');
  const { root } = parse(dir);
  const parts = dir.slice(root.length).split(sep);
  const at = parts.indexOf('node_modules');
  return at === -1 ? dir : join(root, ...parts.slice(0, at));
}
