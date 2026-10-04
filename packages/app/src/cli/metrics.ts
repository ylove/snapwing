// `snapwing metrics [--since 30d] [--json]` (main 20.3, B 10): what the log says about the window.
// It reads the incidents' logs through the state store (the 1000 most recently updated) and folds them; nothing is written.
//
// The window holds the incidents opened (`captured`, kind `incident`) at or after the cutoff; every
// other figure counts those incidents' own events, so a merge in the window of an older incident is
// not counted twice across windows. Definitions:
//   opened / closed   per surface (the latest `resolved` event's surface, else `unresolved`); closed
//                     is the `closed` event
//   time to PR        `captured` to the first `pr-opened`; time to merge: to the first `merged`
//                     (median and p90 by nearest rank, over the incidents that got there)
//   autopilot merges  `merged` with `levelAtMergeTime` 3; reverts: `reverted` events
//   degradations      a plan that fell back to the unresolved-surface project, and a merge gate
//                     decision of `degrade`
//   ask-back rate     incidents that asked the reporter a question, over incidents opened

import { parseArgs } from 'node:util';
import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import type { CliIo } from './state.ts';
import { openStateFromEnv, readIncidentLogs } from './trace.ts';

export const METRICS_USAGE = `Usage: snapwing metrics [--since 30d] [--json]

  --since <window>  a window such as 12h, 30d, 4w, or a date such as 2026-09-01 (default 30d)
  --json            print the figures as JSON

Environment: SNAPWING_DB=sqlite|postgres, DATABASE_URL (postgres), SNAPWING_SQLITE_PATH (sqlite file).`;

export interface Spread {
  /** How many incidents the spread covers. */
  count: number;
  /** Milliseconds; absent when no incident got there. */
  medianMs?: number;
  p90Ms?: number;
}

export interface SurfaceCount {
  surface: string;
  opened: number;
  closed: number;
}

export interface Metrics {
  since: string;
  until: string;
  opened: number;
  closed: number;
  perSurface: SurfaceCount[];
  timeToPr: Spread;
  timeToMerge: Spread;
  autopilotMerges: number;
  reverts: number;
  degradations: number;
  askedBack: number;
  /** `askedBack / opened`, 0 when nothing opened. */
  askBackRate: number;
}

/** Parses `30d`, `12h`, `4w`, or an ISO date, relative to `now`; undefined when it is none of them. */
export function parseSince(value: string, now: Date): Date | undefined {
  const m = /^(\d+)([hdw])$/.exec(value);
  if (m !== null) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 'h' | 'd' | 'w'];
    return new Date(now.getTime() - Number(m[1]) * unit);
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t);
}

/** Nearest-rank percentile of a non-empty ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] as number;
}

function spread(values: number[]): Spread {
  if (values.length === 0) {
    return { count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
}

/** Folds the log into the figures for incidents opened in `[since, now]`. */
export function computeMetrics(events: readonly IncidentEvent[], since: Date, now: Date): Metrics {
  const byIncident = new Map<string, IncidentEvent[]>();
  for (const e of events) {
    const list = byIncident.get(e.incidentId);
    if (list === undefined) {
      byIncident.set(e.incidentId, [e]);
    } else {
      list.push(e);
    }
  }
  const surfaces = new Map<string, SurfaceCount>();
  const toPr: number[] = [];
  const toMerge: number[] = [];
  const m: Metrics = {
    since: since.toISOString(),
    until: now.toISOString(),
    opened: 0,
    closed: 0,
    perSurface: [],
    timeToPr: { count: 0 },
    timeToMerge: { count: 0 },
    autopilotMerges: 0,
    reverts: 0,
    degradations: 0,
    askedBack: 0,
    askBackRate: 0,
  };
  for (const log of byIncident.values()) {
    const captured = log.find((e) => e.type === 'captured');
    if (captured?.type !== 'captured' || captured.payload.kind !== 'incident') {
      continue;
    }
    const openedAt = Date.parse(captured.occurredAt);
    if (openedAt < since.getTime() || openedAt > now.getTime()) {
      continue;
    }
    let surface = 'unresolved';
    for (const e of log) {
      if (e.type === 'resolved' && e.payload.surfaceId !== undefined) {
        surface = e.payload.surfaceId;
      }
    }
    const row = surfaces.get(surface) ?? { surface, opened: 0, closed: 0 };
    surfaces.set(surface, row);
    m.opened += 1;
    row.opened += 1;
    let askedBack = false;
    let sawPr = false;
    let sawMerge = false;
    for (const e of log) {
      const elapsed = Date.parse(e.occurredAt) - openedAt;
      switch (e.type) {
        case 'closed':
          m.closed += 1;
          row.closed += 1;
          break;
        case 'pr-opened':
          if (!sawPr) {
            sawPr = true;
            toPr.push(elapsed);
          }
          break;
        case 'merged':
          if (e.payload.levelAtMergeTime === 3) {
            m.autopilotMerges += 1;
          }
          if (!sawMerge) {
            sawMerge = true;
            toMerge.push(elapsed);
          }
          break;
        case 'reverted':
          m.reverts += 1;
          break;
        case 'planned':
          if (e.payload.degraded !== undefined) {
            m.degradations += 1;
          }
          break;
        case 'held':
          if (e.payload.kind === 'gate' && e.payload.gate?.decision === 'degrade') {
            m.degradations += 1;
          }
          break;
        case 'clarified':
          if (e.payload.audience === 'reporter' && e.payload.userSide === undefined) {
            askedBack = true;
          }
          break;
        default:
          break;
      }
    }
    if (askedBack) {
      m.askedBack += 1;
    }
  }
  m.perSurface = [...surfaces.values()].sort((a, b) => a.surface.localeCompare(b.surface));
  m.timeToPr = spread(toPr);
  m.timeToMerge = spread(toMerge);
  m.askBackRate = m.opened === 0 ? 0 : m.askedBack / m.opened;
  return m;
}

function duration(ms: number | undefined): string {
  if (ms === undefined) {
    return 'none';
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 6) / 10;
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 2.4) / 10}d`;
}

/** The figures as lines. */
export function renderMetrics(m: Metrics): string[] {
  const lines = [`Metrics ${m.since.slice(0, 10)} to ${m.until.slice(0, 10)}: ${m.opened} opened, ${m.closed} closed`];
  const width = Math.max(7, ...m.perSurface.map((s) => s.surface.length));
  lines.push(`  ${'surface'.padEnd(width)}  opened  closed`);
  for (const s of m.perSurface) {
    lines.push(`  ${s.surface.padEnd(width)}  ${String(s.opened).padStart(6)}  ${String(s.closed).padStart(6)}`);
  }
  lines.push(`Time to PR:    median ${duration(m.timeToPr.medianMs)}, p90 ${duration(m.timeToPr.p90Ms)} (${m.timeToPr.count} incidents)`);
  lines.push(`Time to merge: median ${duration(m.timeToMerge.medianMs)}, p90 ${duration(m.timeToMerge.p90Ms)} (${m.timeToMerge.count} incidents)`);
  lines.push(`Autopilot merges: ${m.autopilotMerges}, reverts: ${m.reverts}`);
  lines.push(`Degradations: ${m.degradations}`);
  lines.push(`Ask-back rate: ${Math.round(m.askBackRate * 100)}% (${m.askedBack} of ${m.opened})`);
  return lines;
}

/** Runs `snapwing metrics <args>` and returns the exit code. `now` is the clock tests move. */
export async function runMetrics(args: readonly string[], io: CliIo, now: () => Date = () => new Date()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        since: { type: 'string', default: '30d' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.stderr(`snapwing metrics: ${errorMessage(e)}\n${METRICS_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.stdout(METRICS_USAGE);
    return 0;
  }
  const current = now();
  const since = parseSince(parsed.values.since, current);
  if (parsed.positionals.length > 0 || since === undefined) {
    io.stderr(`snapwing metrics: ${since === undefined ? `cannot read --since ${JSON.stringify(parsed.values.since)}` : 'takes no arguments'}\n${METRICS_USAGE}`);
    return 1;
  }
  let state: OpenedState | undefined;
  try {
    state = await openStateFromEnv(io.env);
    const log = await readIncidentLogs(state);
    if (log.truncated) {
      io.stderr('snapwing metrics: more than 1000 incidents; counting the 1000 most recently updated');
    }
    const metrics = computeMetrics(log.events, since, current);
    if (parsed.values.json) {
      io.stdout(JSON.stringify(metrics, null, 2));
    } else {
      for (const line of renderMetrics(metrics)) {
        io.stdout(line);
      }
    }
    return 0;
  } catch (e) {
    io.stderr(`snapwing metrics: ${errorMessage(e)}`);
    return 1;
  } finally {
    await state?.close();
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
