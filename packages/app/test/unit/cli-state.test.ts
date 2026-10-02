// `snapwing state rebuild` (#35): the CLI runs in-process on a temp SQLite database with an inline
// two-incident recording. The database is always SQLite here; the dialects are #20's tests.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/main.ts';
import { lineDiff } from '../../src/cli/state.ts';

const WS = '01JZ0000000000000000000001';
const INC_A = '01JZ00000000000000000000A1';
const INC_B = '01JZ00000000000000000000B1';

let dir: string;
let minute: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-cli-state-'));
  minute = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function event(incidentId: string, type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceId: WS,
    incidentId,
    type,
    v: 1,
    source: 'agent',
    occurredAt: new Date(Date.parse('2026-10-01T09:00:00.000Z') + minute++ * 60_000).toISOString(),
    payload,
  };
}

function captured(incidentId: string): Record<string, unknown> {
  return event(incidentId, 'captured', {
    kind: 'incident',
    idempotencyKey: `slack:T-FAKE:C-FAKE:${incidentId}`,
    source: 'slack',
    reporter: { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' },
    anchorText: 'Checkout says 500',
    anchorId: '1727773199.000100',
    channelId: 'C-FAKE',
  });
}

/** Two incidents, interleaved across two files: A is captured and filed, B is captured. */
async function writeRecording(): Promise<string> {
  const recordings = join(dir, 'recordings');
  await mkdir(recordings);
  const lines = (events: Record<string, unknown>[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(join(recordings, '01-a.jsonl'), lines([captured(INC_A), event(INC_A, 'filed', { jiraKey: 'FAKE-1' })]));
  await writeFile(join(recordings, '02-b.jsonl'), lines([captured(INC_B)]));
  await writeFile(join(recordings, 'notes.txt'), 'not a recording');
  return recordings;
}

async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env: { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: join(dir, 'state.sqlite'), ...extraEnv },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('snapwing state rebuild', () => {
  it('seeds a recording, rebuilds, and prints counts', async () => {
    const recordings = await writeRecording();
    const result = await run(['state', 'rebuild', '--all', '--seed', recordings]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('seeded 3 events across 2 incidents from 2 files');
    expect(result.out).toContain('rebuilt 2 incidents from 3 events (sqlite)');
  });

  it('rebuilds one incident by id', async () => {
    const recordings = await writeRecording();
    await run(['state', 'rebuild', '--seed', recordings]);
    const result = await run(['state', 'rebuild', INC_A]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rebuilt 1 incidents from 2 events');
  });

  it('--verify passes when projections match a rebuild', async () => {
    const recordings = await writeRecording();
    const result = await run(['state', 'rebuild', '--verify', '--seed', recordings]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('verify ok');
  });

  it('refuses to seed a database that already has events', async () => {
    const recordings = await writeRecording();
    await run(['state', 'rebuild', '--seed', recordings]);
    const again = await run(['state', 'rebuild', '--seed', recordings]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('empty database');
  });

  it('reports a malformed recording line with its file and line', async () => {
    const recordings = await writeRecording();
    await writeFile(join(recordings, '03-bad.jsonl'), '{"incidentId": \n');
    const result = await run(['state', 'rebuild', '--seed', recordings]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('03-bad.jsonl:1');
  });

  it('rejects bad arguments and unknown commands with exit 1', async () => {
    expect((await run(['state', 'rebuild', INC_A, '--all'])).code).toBe(1);
    expect((await run(['state', 'rebuild', '--nope'])).code).toBe(1);
    expect((await run(['state', 'frobnicate'])).code).toBe(1);
    expect((await run(['bogus'])).code).toBe(1);
    expect((await run(['state', 'rebuild'], { SNAPWING_DB: 'oracle' })).code).toBe(1);
  });
});

describe('lineDiff', () => {
  it('marks removed and added lines with their line numbers', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(diff).toContain('- b  (before, line 2)');
    expect(diff).toContain('+ B  (after, line 2)');
    expect(diff).not.toContain('a  (');
  });
});
