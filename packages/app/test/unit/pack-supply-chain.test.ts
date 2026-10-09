// The packed CLI's supply chain (#274), without the network: the secret-path check and the shrinkwrap
// generated from the lockfile. Packing and `npx` from the tarballs live in the pack tier.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const load = async (name: string): Promise<unknown> => import(pathToFileURL(join(REPO_ROOT, 'scripts', name)).href);

interface Entry {
  version?: string;
  integrity?: string;
  inBundle?: boolean;
}

describe('pack-cli secret paths', () => {
  it('refuses every kind of path the ignore file lists as secret', async () => {
    const { isSecretPath } = (await load('pack-cli.mjs')) as { isSecretPath: (f: string) => boolean };
    const secrets = [
      '.env',
      '.env.live',
      'a/.env.onboard',
      'k.pem',
      'x/id.key',
      'c.p12',
      'c.pfx',
      'a.private-key.json',
      'secrets/a',
      '.secrets/a',
      'x.secret',
      'x.secrets.json',
      'credentials.json',
      'credentials-prod.json',
      'service-account.json',
      'service-account-x.json',
      'd.sqlite',
      'd.sqlite3',
      'd.db',
    ];
    for (const f of secrets) expect(isSecretPath(f), f).toBe(true);
    for (const f of ['src/index.ts', 'package.json', 'schemas/a.xsd', 'docs/environment.md']) expect(isSecretPath(f), f).toBe(false);
  });
});

describe('shrinkwrap from the lockfile', () => {
  it('pins versions with integrity, bundles the workspace package, and leaves the sibling out', async () => {
    const mod = (await load('shrinkwrap.mjs')) as {
      readLock: (root: string) => unknown;
      shrinkwrapFor: (o: unknown) => { lockfileVersion: number; packages: Record<string, Entry> };
    };
    const sw = mod.shrinkwrapFor({
      lock: mod.readLock(REPO_ROOT),
      importer: 'packages/app',
      manifest: { name: '@snapwing/app', version: '0.0.0', dependencies: { '@snapwing/capture-client': '0.0.0', '@snapwing/pipeline': '0.0.0', slimdom: '4.3.5', tsx: '^4.23.15', yaml: '^2.9.1' } },
      bundled: ['@snapwing/capture-client'],
    });
    expect(sw.lockfileVersion).toBe(3);
    expect(sw.packages['node_modules/slimdom']?.version).toBe('4.3.5');
    expect(sw.packages['node_modules/@snapwing/capture-client']?.inBundle).toBe(true);
    expect(sw.packages['node_modules/@snapwing/pipeline']).toBeUndefined();
    for (const [path, entry] of Object.entries(sw.packages)) {
      if (path === '' || entry.inBundle === true) continue;
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
  });
});
