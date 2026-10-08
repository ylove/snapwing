// The CLI loads the server side lazily: a capture command such as `say` must not import the server,
// the state store, or any native or model module, so `npx snapwing say` works on a machine with no
// build tools. Each case runs the real `main` in a child process (through tsx, like the bin shim) with
// a resolve hook that logs every module URL, then checks that log. `trace --help` is the control: it
// must reach the state store, which proves the hook sees what it should.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHILD = fileURLToPath(new URL('./fixtures/cli-lazy-child.mjs', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HEAVY = /\/(server|state)\/|better-sqlite3|\/pg\/|\/pg-boss\/|@anthropic-ai|\/openai\/|@google/;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-cli-lazy-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs the CLI with `args` and returns every module URL it resolved. */
async function resolved(args: readonly string[], name: string): Promise<string[]> {
  const log = join(dir, `${name}.log`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CHILD, ...args],
      {
        cwd: APP_ROOT,
        env: { ...process.env, FORCE_COLOR: '0', HOME: dir, USERPROFILE: dir, SNAPWING_RESOLVE_LOG: log },
        timeout: 60_000,
      },
      (error) => (error === null || typeof error.code === 'number' ? resolve() : reject(error)),
    );
    child.stdin?.end();
  });
  return (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
}

describe('the CLI loads the server side lazily', () => {
  it('reaches the state store when a command needs it (control)', async () => {
    const urls = await resolved(['trace', '--help'], 'control');
    expect(urls.some((u) => /\/state\//.test(u))).toBe(true);
  }, 90_000);

  it.each([['--help'], ['say', 'the button is broken'], ['shot', 'missing.png'], ['status'], ['stop', 'SNAP-1'], ['login'], ['logout']])(
    '%s imports no server, state, native, or model module',
    async (...args) => {
      const urls = await resolved(args, args.join('_').replace(/\W/g, '_'));
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((u) => HEAVY.test(u))).toEqual([]);
    },
    90_000,
  );
});
