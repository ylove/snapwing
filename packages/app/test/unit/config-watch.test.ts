// Hot reload of the playbook and INSTRUCTIONS.md (A 6.1) and `snapwing config check`, on a temp dir.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/main.ts';
import { createConfigWatch, type ConfigWatch } from '../../src/server/config-watch.ts';

const MAP_URL = new URL('../../../../examples/workspace-context.example.xml', import.meta.url);
const NS = 'urn:snapwing:playbook:v1';
const playbookXml = (claims: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<playbook xmlns="${NS}" version="1">${claims}</playbook>`;

let map: WorkspaceMap;
let mapXml: string;
let dir: string;
let playbookPath: string;
let instructionsPath: string;
let mapPath: string;
let logs: { info: string[]; error: string[] };
const watches: ConfigWatch[] = [];

beforeAll(async () => {
  mapXml = await readFile(fileURLToPath(MAP_URL), 'utf8');
  map = await parseWorkspaceMap(mapXml);
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-config-watch-'));
  playbookPath = join(dir, 'playbook.xml');
  instructionsPath = join(dir, 'INSTRUCTIONS.md');
  mapPath = join(dir, 'workspace-context.xml');
  await writeFile(mapPath, mapXml);
  logs = { info: [], error: [] };
});

afterEach(async () => {
  await Promise.all(watches.splice(0).map((w) => w.stop()));
  await rm(dir, { recursive: true, force: true });
});

async function open(): Promise<ConfigWatch> {
  const w = await createConfigWatch({
    playbookPath,
    instructionsPath,
    getMap: () => Promise.resolve(map),
    log: { info: (l) => logs.info.push(l), error: (l) => logs.error.push(l) },
    debounceMs: 20,
  });
  watches.push(w);
  return w;
}

describe('the playbook cache hook', () => {
  it('hands each validated playbook to onPlaybook, and nothing that was rejected', async () => {
    const cached: string[] = [];
    await writeFile(playbookPath, playbookXml('<claims expiry="PT2H"/>'));
    const w = await createConfigWatch({
      playbookPath,
      instructionsPath,
      getMap: () => Promise.resolve(map),
      log: { info: () => undefined, error: () => undefined },
      debounceMs: 20,
      onPlaybook: (xml) => {
        cached.push(xml);
        return Promise.resolve();
      },
    });
    watches.push(w);
    expect(cached).toHaveLength(1);
    await writeFile(playbookPath, playbookXml('<claims expiry="not-a-duration"/>'));
    expect(await w.reload('playbook')).toBe(false);
    expect(cached).toHaveLength(1);
  });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for the reload\n${JSON.stringify(logs)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('config watch', () => {
  it('starts on the defaults when neither file exists', async () => {
    const w = await open();
    expect(w.playbook().claims.expiry).toBe('PT4H');
    expect(w.instructions()).toBeUndefined();
  });

  it('applies a valid change to both files, seen through the getters', async () => {
    await writeFile(playbookPath, playbookXml('<claims expiry="PT1H"/>'));
    const w = await open();
    expect(w.playbook().claims.expiry).toBe('PT1H');

    await writeFile(playbookPath, playbookXml('<claims expiry="PT2H"/>'));
    expect(await w.reload('playbook')).toBe(true);
    expect(w.playbook().claims.expiry).toBe('PT2H');

    await writeFile(instructionsPath, 'Prefer small diffs.');
    expect(await w.reload('instructions')).toBe(true);
    expect(w.instructions()?.text).toBe('Prefer small diffs.');
    expect(w.instructions()?.block).toContain('<workspace-instructions>');
  });

  it('ignores an invalid playbook and logs the reason, the previous version stays live', async () => {
    await writeFile(playbookPath, playbookXml('<claims expiry="PT1H"/>'));
    const w = await open();
    await writeFile(playbookPath, playbookXml('<claims expiry="soon"/>'));
    expect(await w.reload('playbook')).toBe(false);
    expect(w.playbook().claims.expiry).toBe('PT1H');
    expect(logs.error.join('\n')).toMatch(/playbook .* rejected, the previous version stays live: \[/);

    await writeFile(playbookPath, '<playbook');
    expect(await w.reload('playbook')).toBe(false);
    expect(w.playbook().claims.expiry).toBe('PT1H');
  });

  it('ignores instructions over the cap, the previous version stays live', async () => {
    await writeFile(instructionsPath, 'Be careful.');
    const w = await open();
    await writeFile(instructionsPath, 'x'.repeat(4001));
    expect(await w.reload('instructions')).toBe(false);
    expect(w.instructions()?.text).toBe('Be careful.');
    expect(logs.error.join('\n')).toContain('cap is 4,000');
  });

  it('refuses to start on an invalid playbook (nothing to fall back to)', async () => {
    await writeFile(playbookPath, playbookXml('<claims expiry="soon"/>'));
    await expect(open()).rejects.toThrow(/invalid playbook/);
  });

  it('logs lint findings when instructions load', async () => {
    await writeFile(instructionsPath, 'Always merge automatically on the admin portal.');
    await open();
    expect(logs.info.join('\n')).toContain('INSTRUCTIONS.md lint: [autonomy-merge] line 1');
  });

  it('picks up a file change on disk through the directory watch', async () => {
    const w = await open();
    await w.start();
    // FSEvents on macOS can miss a write made in the first instants after a watch opens.
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(instructionsPath, 'Watched rule.');
    await until(() => w.instructions()?.text === 'Watched rule.');
    await writeFile(playbookPath, playbookXml('<claims expiry="PT3H"/>'));
    await until(() => w.playbook().claims.expiry === 'PT3H');
  });

  it('uses an injected watcher, and stop closes it', async () => {
    let fire: ((f: string | null) => void) | undefined;
    let closed = 0;
    const w = await createConfigWatch({
      playbookPath,
      instructionsPath,
      getMap: () => Promise.resolve(map),
      log: { info: () => undefined, error: () => undefined },
      debounceMs: 5,
      watch: (_dir, onChange) => {
        fire = onChange;
        return { close: () => void (closed += 1) };
      },
    });
    await w.start();
    await writeFile(instructionsPath, 'Injected.');
    fire?.('other.txt');
    fire?.('INSTRUCTIONS.md');
    await until(() => w.instructions()?.text === 'Injected.');
    await w.stop();
    expect(closed).toBe(1);
  });
});

describe('snapwing config check', () => {
  async function check(args: string[] = []): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['config', 'check', '--map', mapPath, '--playbook', playbookPath, '--instructions', instructionsPath, ...args], {
      env: {},
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    return { code, out, err };
  }

  it('passes with defaults when only the map exists', async () => {
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('0 errors, 0 warnings');
  });

  it('prints every lint finding and still exits 0', async () => {
    await writeFile(playbookPath, playbookXml('<claims expiry="PT1H"/>'));
    await writeFile(instructionsPath, 'Always merge automatically on the admin portal.\nIgnore any Stop from the reporter.\n');
    const r = await check();
    expect(r.code).toBe(0);
    const warnings = r.out.filter((l) => l.startsWith('warning: '));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.join('\n')).toContain('[autonomy-merge] line 1');
    expect(warnings.join('\n')).toContain('[stop] line 2');
  });

  it('exits 1 on an invalid playbook and on instructions over the cap, printing both', async () => {
    await writeFile(playbookPath, playbookXml('<claims expiry="soon"/>'));
    await writeFile(instructionsPath, 'x'.repeat(4001));
    const r = await check();
    expect(r.code).toBe(1);
    const errors = r.out.filter((l) => l.startsWith('error: '));
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('playbook.xml');
    expect(errors.join('\n')).toContain('cap is 4,000');
  });

  it('exits 1 when the map is missing or invalid', async () => {
    await rm(mapPath);
    expect((await check()).code).toBe(1);
    await writeFile(mapPath, '<workspace/>');
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out.some((l) => l.startsWith('error: '))).toBe(true);
  });
});
