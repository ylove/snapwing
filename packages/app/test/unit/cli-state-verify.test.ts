// `snapwing state rebuild --verify` must exit 1 with a readable diff when a projection row has
// drifted from the log. SQLite only, like cli-state.test.ts; the dialects have their own tests.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { main } from '../../src/cli/main.ts';

const DEMO_DIR = fileURLToPath(new URL('../../../../demo/state', import.meta.url));

let dir: string;
let sqlitePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-cli-verify-'));
  sqlitePath = join(dir, 'state.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env: { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: sqlitePath },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('snapwing state rebuild --verify on drift', () => {
  it('passes on the seeded demo recordings', async () => {
    const seeded = await run(['state', 'rebuild', '--verify', '--seed', DEMO_DIR]);
    expect(seeded.err).toBe('');
    expect(seeded.code).toBe(0);
    expect(seeded.out).toContain('verify ok');
  });

  it('exits 1 with a before/after diff after one projection row is tampered with', async () => {
    expect((await run(['state', 'rebuild', '--seed', DEMO_DIR])).code).toBe(0);

    const state = await openState({ dialect: 'sqlite', url: sqlitePath });
    try {
      if (!(state instanceof StateStore)) throw new Error('expected a StateStore');
      await state.ctx.db.updateTable('incidents').set({ summary: 'tampered by the test' }).where('jira_key', '=', 'DEMO-4').execute();
    } finally {
      await state.close();
    }

    const verify = await run(['state', 'rebuild', '--verify']);
    expect(verify.code).toBe(1);
    expect(verify.err).toContain('projections differ after rebuild');
    expect(verify.err).toContain('tampered by the test');
    expect(verify.err).toMatch(/\(before, line \d+\)/);
    expect(verify.err).toMatch(/\(after, line \d+\)/);
    expect(verify.out).not.toContain('verify ok');
  });
});
