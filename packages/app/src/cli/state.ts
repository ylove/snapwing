// `snapwing state ...` (B 4: "rebuild is a command"; B 10).
//
//   snapwing state rebuild [<incidentId> | --all] [--verify] [--seed <dir>]
//
// Rebuilds the projections from the event log on the dialect `SNAPWING_DB` / `DATABASE_URL` name
// (`stateOptionsFromEnv`; on SQLite `SNAPWING_SQLITE_PATH` names the file). With neither an incident
// id nor `--all`, the whole log is rebuilt. `--verify` snapshots the projections, rebuilds,
// snapshots again, and exits 1 with a diff when they differ. `--seed <dir>` first appends every
// `*.jsonl` recording in `<dir>` (one event per line) to an empty database.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LOG_START, stateOptionsFromEnv } from '@snapwing/pipeline/contracts/state.ts';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { rebuild, snapshotProjections, type RebuildTarget } from '@snapwing/pipeline/state/rebuild.ts';

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const STATE_USAGE = `Usage: snapwing state rebuild [<incidentId> | --all] [--verify] [--seed <dir>]

  <incidentId>   rebuild one incident's projections
  --all          rebuild every incident (the default)
  --verify       snapshot, rebuild, snapshot; exit 1 with a diff if they differ
  --seed <dir>   first append every *.jsonl recording in <dir> to an empty database

Environment: SNAPWING_DB=sqlite|postgres, DATABASE_URL (postgres), SNAPWING_SQLITE_PATH (sqlite file).`;

/** Runs `snapwing state <args>` and returns the exit code. */
export async function runState(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    io.stdout(STATE_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'rebuild') {
    io.stderr(`snapwing state: unknown subcommand ${JSON.stringify(sub)}\n${STATE_USAGE}`);
    return 1;
  }
  return runRebuild(rest, io);
}

async function runRebuild(args: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        all: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        seed: { type: 'string' },
      },
    });
  } catch (e) {
    io.stderr(`snapwing state rebuild: ${errorMessage(e)}\n${STATE_USAGE}`);
    return 1;
  }
  const { all, verify, seed } = parsed.values;
  const [incidentId, ...extra] = parsed.positionals;
  if (extra.length > 0 || (all && incidentId !== undefined)) {
    io.stderr(`snapwing state rebuild: give one incident id or --all, not both\n${STATE_USAGE}`);
    return 1;
  }
  const target: RebuildTarget = incidentId === undefined ? { all: true } : { incidentId };

  let state: OpenedState | undefined;
  try {
    const options = stateOptionsFromEnv(io.env);
    const sqlitePath = io.env['SNAPWING_SQLITE_PATH']?.trim();
    if (options.dialect === 'sqlite' && sqlitePath !== undefined && sqlitePath !== '') {
      options.url = sqlitePath;
    }
    state = await openState(options);
    if (seed !== undefined) {
      const seeded = await seedFromDirectory(state, seed);
      io.stdout(`seeded ${seeded.events} events across ${seeded.incidents} incidents from ${seeded.files} files`);
    }
    let before: string | undefined;
    if (verify) {
      before = await snapshotProjections(state);
    }
    const result = await rebuild(state, target);
    io.stdout(`rebuilt ${result.incidents} incidents from ${result.events} events (${state.dialect})`);
    if (before !== undefined) {
      const after = await snapshotProjections(state);
      if (before !== after) {
        io.stderr(`projections differ after rebuild:\n${lineDiff(before, after)}`);
        return 1;
      }
      io.stdout('verify ok: projections match a rebuild from the log');
    }
    return 0;
  } catch (e) {
    io.stderr(`snapwing state rebuild: ${errorMessage(e)}`);
    return 1;
  } finally {
    await state?.close();
  }
}

// Seed --------------------------------------------------------------------------------------------

interface SeedResult {
  files: number;
  incidents: number;
  events: number;
}

/**
 * Appends each incident's recorded events, in file order, with `expectedSeq` taken from the log.
 * Rejects when the database already holds events, so a seed never mixes with a live log.
 */
export async function seedFromDirectory(state: OpenedState, dir: string): Promise<SeedResult> {
  const existing = await state.readSince(LOG_START, 1);
  if (existing.events.length > 0) {
    throw new Error('--seed needs an empty database, but the event log already has events');
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const byIncident = new Map<string, NewEvent[]>();
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '') {
        return;
      }
      const event = parseEventLine(line, `${file}:${i + 1}`);
      const list = byIncident.get(event.incidentId) ?? [];
      list.push(event);
      byIncident.set(event.incidentId, list);
    });
  }
  let events = 0;
  for (const [incidentId, list] of byIncident) {
    let expectedSeq = 0;
    for (const event of list) {
      const { seq } = await state.append(incidentId, [event], expectedSeq);
      expectedSeq = seq;
      events += 1;
    }
  }
  return { files: files.length, incidents: byIncident.size, events };
}

function parseEventLine(line: string, where: string): NewEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`${where}: not valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  const { seq: _seq, recordedAt: _recordedAt, ...event } = value as Record<string, unknown>;
  if (typeof event['incidentId'] !== 'string' || event['incidentId'] === '' || typeof event['type'] !== 'string') {
    throw new Error(`${where}: an event needs string incidentId and type`);
  }
  // The state port validates the rest on append; a recording may carry seq and recordedAt, which it assigns.
  return event as unknown as NewEvent;
}

// Diff --------------------------------------------------------------------------------------------

/** A readable line diff of two canonical snapshots: `-` before, `+` after, with line numbers. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence on lines; snapshots are small enough for the quadratic table.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push(`- ${a[i]}  (before, line ${i + 1})`);
      i++;
    } else {
      out.push(`+ ${b[j]}  (after, line ${j + 1})`);
      j++;
    }
  }
  return out.join('\n');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
