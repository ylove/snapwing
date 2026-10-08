// `snapwing token issue | list | revoke`: on a temp SQLite file and a temp copy of the example map.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_TOKEN_PREFIX } from '@snapwing/pipeline/state/capture-tokens.ts';
import { main } from '../../src/cli/main.ts';

const exampleXml = await readFile(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

let dir: string;
let env: Record<string, string>;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-cli-token-'));
  const mapPath = join(dir, 'workspace-context.xml');
  await writeFile(mapPath, exampleXml);
  env = { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: join(dir, 'state.db'), SNAPWING_MAP: mapPath, SNAPWING_PUBLIC_URL: 'https://snapwing.example.test' };
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (args: string[]): Promise<number> => main(['token', ...args], { env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
const text = (lines: string[]): string => lines.join('\n');
const tokenIn = (lines: string[]): string => lines.find((l) => l.startsWith(CAPTURE_TOKEN_PREFIX)) ?? '';
const idIn = (lines: string[]): string => /^token (\S+) for /.exec(lines[0] ?? '')?.[1] ?? '';

describe('token issue', () => {
  it('prints the token once with the login line, and lists it without the token', async () => {
    expect(await run(['issue', 'webDev1', '--label', 'laptop'])).toBe(0);
    const token = tokenIn(out);
    expect(token).toMatch(/^swc_[A-Za-z0-9_-]{43}$/);
    expect(text(out)).toContain('for webDev1 (laptop)');
    expect(text(out)).toContain('snapwing login --url https://snapwing.example.test');
    expect(text(out).split(token)).toHaveLength(2);

    out = [];
    expect(await run(['list'])).toBe(0);
    expect(text(out)).toMatch(/id\s+person\s+label\s+issued\s+last used\s+status/);
    expect(text(out)).toMatch(/webDev1\s+laptop\s+\S+\s+never\s+live/);
    expect(text(out)).not.toContain(token);
  });

  it('exits 1 for a handle not in the map and issues nothing', async () => {
    expect(await run(['issue', 'stranger'])).toBe(1);
    expect(text(err)).toContain('"stranger" is not a person');
    expect(tokenIn(out)).toBe('');
    out = [];
    expect(await run(['list'])).toBe(0);
    expect(text(out)).toBe('no capture tokens');
  });

  it('exits 1 without a readable map', async () => {
    env['SNAPWING_MAP'] = join(dir, 'absent.xml');
    expect(await run(['issue', 'webDev1'])).toBe(1);
    expect(text(err)).toContain('no such file');
  });

  it('needs exactly one handle', async () => {
    expect(await run(['issue'])).toBe(1);
    expect(await run(['issue', 'a', 'b'])).toBe(1);
  });
});

describe('token revoke', () => {
  it('revokes one token alone, then refuses a second revoke and an unknown id', async () => {
    await run(['issue', 'webDev1', '--label', 'laptop']);
    const first = idIn(out);
    out = [];
    await run(['issue', 'webDev1', '--label', 'ci']);
    const second = idIn(out);

    out = [];
    expect(await run(['revoke', first])).toBe(0);
    expect(text(out)).toBe(`revoked ${first}`);

    out = [];
    await run(['list']);
    const rows = out[0]?.split('\n') ?? [];
    expect(rows.find((r) => r.startsWith(first))).toMatch(/revoked \d{4}-/);
    expect(rows.find((r) => r.startsWith(second))).toMatch(/live$/);

    err = [];
    expect(await run(['revoke', first])).toBe(1);
    expect(text(err)).toContain('no live token');
    expect(await run(['revoke', '01JZ0000000000000000000000'])).toBe(1);
  });
});

describe('token usage', () => {
  it('prints usage for bare token and refuses an unknown subcommand', async () => {
    expect(await run([])).toBe(1);
    expect(text(out)).toContain('Usage: snapwing token issue');
    expect(await run(['mint'])).toBe(1);
    expect(await run(['--help'])).toBe(0);
  });
});
