// The live tier's `.env.live` lookup stops at the checkout root: a worktree under
// `.claude/worktrees/` must not find the main checkout's file above it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEnvFile } from '../live/helpers/env.ts';

describe('live findEnvFile', () => {
  let tmp: string;
  let saved: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'snapwing-envfile-'));
    saved = process.env.SNAPWING_ENV_LIVE;
    delete process.env.SNAPWING_ENV_LIVE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SNAPWING_ENV_LIVE;
    else process.env.SNAPWING_ENV_LIVE = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** main/.env.live, and a worktree inside main with its own workspace marker (and no .env.live). */
  function tree(): { main: string; worktree: string; start: string } {
    const main = join(tmp, 'main');
    const worktree = join(main, '.claude', 'worktrees', 'agent-1');
    const start = join(worktree, 'packages', 'app', 'test', 'live', 'helpers');
    mkdirSync(start, { recursive: true });
    writeFileSync(join(main, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(main, '.env.live'), 'X=1\n');
    writeFileSync(join(worktree, 'pnpm-workspace.yaml'), 'packages: []\n');
    return { main, worktree, start };
  }

  it('returns the worktree root, never the main checkout above it', () => {
    const { main, worktree, start } = tree();
    expect(findEnvFile(start)).toBe(join(worktree, '.env.live'));
    expect(findEnvFile(start)).not.toBe(join(main, '.env.live'));
  });

  it('returns the root file when the root has one', () => {
    const { worktree, start } = tree();
    writeFileSync(join(worktree, '.env.live'), 'Y=2\n');
    expect(findEnvFile(start)).toBe(join(worktree, '.env.live'));
  });

  it('stays inside the checkout when no workspace root exists above the start', () => {
    const start = join(tmp, 'a', 'b', 'c', 'd');
    mkdirSync(start, { recursive: true });
    writeFileSync(join(tmp, '.env.live'), 'X=1\n');
    expect(findEnvFile(start)).toBe(resolve(start, '../../../.env.live'));
  });

  it('prefers SNAPWING_ENV_LIVE', () => {
    const { start } = tree();
    process.env.SNAPWING_ENV_LIVE = join(tmp, 'elsewhere.env');
    expect(findEnvFile(start)).toBe(join(tmp, 'elsewhere.env'));
  });
});
