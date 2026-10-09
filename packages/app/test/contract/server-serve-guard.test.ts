// The local runner is refused where production secrets are present, whatever NODE_ENV says (#265, ADR 0017).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRODUCTION_SECRETS, localRunnerCheck, runServe } from '../../src/server/serve.ts';

const EXAMPLE_CONFIG = fileURLToPath(new URL('../../../../examples/snapwing.config.example.xml', import.meta.url));
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-guard-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs serve against the example config (the local runner); startup stops at the store, which the stub rejects. */
async function serve(args: string[], env: Record<string, string>): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const code = await runServe(
    ['--config', EXAMPLE_CONFIG, ...args],
    { env, stdout: () => undefined, stderr: (l) => err.push(l) },
    { openState: () => Promise.reject(new Error('store reached')), signals: { once: () => undefined, off: () => undefined } },
  );
  return { code, err: err.join('\n') };
}

describe('snapwing serve: the local runner and production secrets', () => {
  it('names the GitHub App key among the production secrets', () => {
    expect(PRODUCTION_SECRETS).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it.each(PRODUCTION_SECRETS)('refuses the local runner when %s is in the environment, without NODE_ENV', async (name) => {
    const run = await serve([], { [name]: 'x', SNAPWING_ENV_FILE: join(dir, 'absent.env') });
    expect(run.code).toBe(1);
    expect(run.err).toContain('refusing to start');
    expect(run.err).toContain(name);
    expect(run.err).toContain('<runtime provider="docker"/>');
    expect(run.err).toContain('--allow-local-runner');
    expect(run.err).not.toContain('store reached');
  });

  it('refuses when the secret is only in the .env file', async () => {
    const envFile = join(dir, '.env');
    await writeFile(envFile, 'GITHUB_APP_PRIVATE_KEY="-----BEGIN-----"\n');
    const run = await serve(['--env-file', envFile], {});
    expect(run.code).toBe(1);
    expect(run.err).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('passes with --allow-local-runner, warning, and with no production secrets', async () => {
    const absent = join(dir, 'absent.env');
    const allowed = await serve(['--allow-local-runner'], { GITHUB_APP_PRIVATE_KEY: 'x', SNAPWING_ENV_FILE: absent });
    expect(allowed.err).toContain('store reached');
    expect(allowed.err).toContain('warning: runtime provider "local"');
    const bare = await serve([], { SNAPWING_ENV_FILE: absent, SLACK_BOT_TOKEN: '  ' });
    expect(bare.err).toContain('store reached');
  });

  it('never refuses another provider, and keeps the stricter NODE_ENV=production rule', () => {
    expect(localRunnerCheck('docker', { GITHUB_APP_PRIVATE_KEY: 'x' }, false)).toBeUndefined();
    expect(localRunnerCheck('local', { NODE_ENV: 'production' }, false)).toHaveProperty('refuse');
    expect(localRunnerCheck('local', { GITHUB_APP_PRIVATE_KEY: 'x' }, true)).toHaveProperty('warn');
  });
});
