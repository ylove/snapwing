// `pnpm demo:state` (#36, the phase 1 proof): the recordings in demo/state/ validate against the
// event catalog, replay to their expected final status, and rebuild identically. Runs on the
// dialect `SNAPWING_DB` selects; CI runs it once per dialect.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadExpectations,
  loadRecordings,
  runDemoState,
  seedRecordings,
  validateRecordedEvent,
  type Expectations,
  type Recording,
} from '../../src/demo/state.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const DEMO_DIR = fileURLToPath(new URL('../../../../demo/state', import.meta.url));

let recordings: Recording[];
let expectations: Expectations;

beforeAll(async () => {
  recordings = await loadRecordings(DEMO_DIR);
  expectations = await loadExpectations(DEMO_DIR);
});

async function run(options: Parameters<typeof runDemoState>[1] = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDemoState(
    { env: process.env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    { dir: DEMO_DIR, ...options },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('demo/state recordings', () => {
  it('holds at least six recordings, each with an expected final status', () => {
    expect(recordings.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(expectations).sort()).toEqual(recordings.map((r) => r.file).sort());
  });

  it('has events that all validate against the catalog, with fixed ULIDs and timestamps', () => {
    for (const r of recordings) {
      for (const e of r.events) {
        expect(validateRecordedEvent(e), `${r.file} ${e.type}`).toEqual([]);
      }
    }
  });

  it('has strictly increasing occurredAt within each recording', () => {
    for (const r of recordings) {
      const times = r.events.map((e) => Date.parse(e.occurredAt));
      expect(times, r.file).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size, r.file).toBe(times.length);
    }
  });

  it('covers the scenarios the proof names', () => {
    const types = (file: string): string[] => recordings.find((r) => r.file === file)!.events.map((e) => e.type);
    const levels = recordings.map((r) => {
      const planned = r.events.find((e) => e.type === 'planned');
      return planned?.type === 'planned' ? planned.payload.autonomyLevel : undefined;
    });
    expect(levels).toEqual(expect.arrayContaining([0, 1, 2, 3]));
    expect(types('02-level-1-fix-on-tap.jsonl')).toContain('tapped');
    expect(types('02-level-1-fix-on-tap.jsonl')).toContain('corrected');
    expect(types('03-level-2-fix-now-review-retry.jsonl')).toContain('review-failed');
    expect(types('04-level-3-autopilot-closed.jsonl')).toContain('closed');
    expect(types('05-stop-mid-fix.jsonl')).toEqual(expect.arrayContaining(['fixer-started', 'stopped']));
    expect(types('06-claim-then-release.jsonl')).toEqual(expect.arrayContaining(['claimed', 'released']));
  });
});

describe('validateRecordedEvent', () => {
  const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(recordings[0]!.events[5]));

  it('accepts a recorded event', () => {
    expect(validateRecordedEvent(good())).toEqual([]);
  });

  it('rejects an unknown type, a missing payload key, a wrong kind, an extra key, and a bad envelope', () => {
    expect(validateRecordedEvent({ ...good(), type: 'filled' }).join()).toContain('not in the event catalog');
    expect(validateRecordedEvent({ ...good(), payload: {} }).join()).toContain('missing jiraKey');
    expect(validateRecordedEvent({ ...good(), payload: { jiraKey: 7 } }).join()).toContain('jiraKey must be a string');
    expect(validateRecordedEvent({ ...good(), payload: { jiraKey: 'X-1', extra: 1 } }).join()).toContain('unknown key extra');
    expect(validateRecordedEvent({ ...good(), incidentId: 'not-a-ulid' }).join()).toContain('ULID');
    expect(validateRecordedEvent({ ...good(), occurredAt: 'yesterday' }).join()).toContain('occurredAt');
    expect(validateRecordedEvent({ ...good(), source: 'telegram' }).join()).toContain('source');
    expect(validateRecordedEvent('nope')).toEqual(['expected a JSON object']);
  });

  it('checks enum-valued payload fields', () => {
    const released = recordings.flatMap((r) => r.events).find((e) => e.type === 'released')!;
    const bad = { ...released, payload: { ...released.payload, scope: 'galaxy' } };
    expect(validateRecordedEvent(bad).join()).toContain('scope must be one of');
  });
});

describe('replay', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('replays every recording to its expected final status', async () => {
    const state = await tdb.open();
    await seedRecordings(state, recordings);
    for (const r of recordings) {
      const expected = expectations[r.file]!;
      const view = await state.getIncident(r.incidentId);
      expect(view?.status, r.file).toBe(expected.status);
      expect(view?.lastSeq, r.file).toBe(r.events.length);
      expect(await state.getClaims(r.incidentId), r.file).toHaveLength(expected.claims ?? 0);
    }
  });
});

describe('runDemoState', () => {
  it('seeds, rebuilds, prints a trace, and reports identical: yes with exit 0', async () => {
    const { code, out, err } = await run();
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain(`seeded ${recordings.reduce((n, r) => n + r.events.length, 0)} events across ${recordings.length} incidents`);
    expect(out).toContain('04-level-3-autopilot-closed');
    expect(out).toContain('captured > assembling > resolved > deduped > planned > filed');
    expect(out).not.toContain('MISMATCH');
    expect(out.trimEnd().endsWith('identical: yes')).toBe(true);
  });

  it('exits 1 with identical: no and a diff when a projection drifts', async () => {
    const { code, out, err } = await run({
      afterSeed: async (state) => {
        if (!(state instanceof StateStore)) throw new Error('expected a StateStore');
        await state.ctx.db.updateTable('incidents').set({ summary: 'tampered by the test' }).execute();
      },
    });
    // The snapshot before the rebuild holds the tampered rows; the rebuild repairs them.
    expect(code).toBe(1);
    expect(out).toContain('identical: no');
    expect(err).toContain('projections differ after rebuild');
    expect(err).toContain('tampered by the test');
  });

  describe('with a bad directory', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'snapwing-demo-state-test-'));
      await cp(DEMO_DIR, dir, { recursive: true });
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('exits 1 when a recording ends in a different status than expected', async () => {
      const wrong = { ...expectations, '01-level-0-ticket-only.jsonl': { status: 'closed' } };
      await writeFile(join(dir, 'expected.json'), JSON.stringify(wrong));
      const { code, out } = await run({ dir });
      expect(code).toBe(1);
      expect(out).toContain('MISMATCH: status filed, expected closed');
    });

    it('exits 1 and names the file and line of an invalid event', async () => {
      await writeFile(join(dir, 'expected.json'), await readFile(join(DEMO_DIR, 'expected.json')));
      await writeFile(join(dir, '99-bad.jsonl'), '{"type":"captured"}\n');
      const { code, err } = await run({ dir });
      expect(code).toBe(1);
      expect(err).toContain('99-bad.jsonl:1');
    });
  });
});
