// Digests (A 4.6): an optional summary to a channel or a DM, on a cron, for the tech lead. Off by
// default: with no `<digest to cron>` in the playbook nothing is registered and nothing is posted.
//
// Each playbook digest is one cron job (`digest.0` to `digest.3`, in playbook order; more than
// `MAX_DIGESTS` is rejected at registration, not silently dropped, because `WorkflowPort.cron` keeps
// one schedule per job name). The window runs from the cron's fire before the one this run answers
// to, up to the clock, so a weekday 09:00 digest on a Monday covers the weekend; with no earlier fire
// in the past 35 days it is `FALLBACK_WINDOW_MS`.
//
// The digest is read off the event log and the incidents projection, never off Jira or chat:
// - opened: `captured` events of kind `incident` in the window;
// - closed: `closed` and `not-a-bug` events in the window;
// - time to PR: capture to the first `pr-opened` of an incident whose first PR opened in the window
//   (median and slowest);
// - autopilot merges: `merged` events in the window made at level 3; reverts: `reverted` events;
// - the three oldest open (non-terminal) incidents and what each waits on (`waitingOn`).
// Posting is injected (`DigestDeps.post`): the chat adapter resolves `to` (`#channel` or a user).
// The log is scanned from its start on each run; a digest runs at most daily or weekly.

import type { PlaybookDigest } from '../config/playbook.ts';
import type { JobName } from '../contracts/jobs.ts';
import type { IncidentEvent } from '../contracts/events.ts';
import type { IncidentView } from '../contracts/state.ts';
import { LIFECYCLE_STATUSES, TERMINAL_STATUSES } from '../lifecycle/machine.ts';
import { LOG_START, type StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { parseCron } from '../workflow/inprocess/cron.ts';

export const DIGEST_JOBS: readonly JobName[] = ['digest.0', 'digest.1', 'digest.2', 'digest.3'];
export const MAX_DIGESTS = DIGEST_JOBS.length;
/** Window when the cron has no earlier fire in the past 35 days. */
export const FALLBACK_WINDOW_MS = 24 * 3_600_000;
const LOOKBACK_MS = 35 * 24 * 3_600_000;
const OLDEST_SHOWN = 3;
const PAGE = 500;
const MINUTE_MS = 60_000;

export interface DigestWindow {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export interface OpenIncidentLine {
  incidentId: string;
  /** Jira key when filed, else the incident id. */
  label: string;
  summary?: string;
  openedAt: string;
  /** Milliseconds open at the end of the window. */
  ageMs: number;
  /** `ci`, `review`, `human`, `deploy`, `hold`, or `nothing`. */
  waitingOn: string;
  who?: string;
}

export interface Digest {
  window: DigestWindow;
  opened: number;
  closed: number;
  /** Incidents whose first PR opened in the window. */
  pullRequests: number;
  medianTimeToPrMs?: number;
  slowestTimeToPrMs?: number;
  autopilotMerges: number;
  reverts: number;
  oldestOpen: OpenIncidentLine[];
}

export interface DigestDeps {
  state: StatePort;
  workflow: WorkflowPort;
  clock(): Date;
  /** Delivers the digest text to the playbook's `to`. A rejection fails the job (it retries per policy). */
  post(to: string, text: string): Promise<void>;
  /** Limit the digest to one workspace; absent means every workspace in the log. */
  workspaceId?: string;
}

// Window -----------------------------------------------------------------------------------------

/** From the fire before the latest one at or before `now`, up to `now` (see the file header). */
export function digestWindow(cron: string, now: Date): DigestWindow {
  const schedule = parseCron(cron);
  let last: Date | undefined;
  let prior: Date | undefined;
  let at = new Date(now.getTime() - LOOKBACK_MS);
  for (;;) {
    const next = schedule.next(at);
    if (next.getTime() > now.getTime()) break;
    prior = last;
    last = next;
    at = next;
  }
  return { from: prior ?? new Date(now.getTime() - FALLBACK_WINDOW_MS), to: new Date(now.getTime()) };
}

// Build ------------------------------------------------------------------------------------------

async function* eventsOf(state: StatePort): AsyncGenerator<IncidentEvent> {
  let cursor = LOG_START;
  for (;;) {
    const page = await state.readSince(cursor, PAGE);
    if (page.events.length === 0) return;
    yield* page.events;
    cursor = page.cursor;
  }
}

const inWindow = (iso: string, w: DigestWindow): boolean => {
  const t = Date.parse(iso);
  return t >= w.from.getTime() && t < w.to.getTime();
};

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : Math.round((upper + (sorted[mid - 1] ?? upper)) / 2);
}

const OPEN_STATUSES: readonly IncidentView['status'][] = LIFECYCLE_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

/** Reads the digest for `window` off the log and projections. */
export async function buildDigest(deps: Pick<DigestDeps, 'state' | 'workspaceId'>, window: DigestWindow): Promise<Digest> {
  const { state } = deps;
  let opened = 0;
  let closed = 0;
  let autopilotMerges = 0;
  let reverts = 0;
  const firstPr = new Map<string, string>();
  for await (const e of eventsOf(state)) {
    if (deps.workspaceId !== undefined && e.workspaceId !== deps.workspaceId) continue;
    if (e.type === 'pr-opened' && !firstPr.has(e.incidentId)) firstPr.set(e.incidentId, e.occurredAt);
    if (!inWindow(e.occurredAt, window)) continue;
    if (e.type === 'captured') {
      if (e.payload.kind === 'incident') opened += 1;
    } else if (e.type === 'closed' || e.type === 'not-a-bug') {
      closed += 1;
    } else if (e.type === 'merged') {
      if (e.payload.levelAtMergeTime === 3) autopilotMerges += 1;
    } else if (e.type === 'reverted') {
      reverts += 1;
    }
  }

  const timesToPr: number[] = [];
  for (const [incidentId, at] of firstPr) {
    if (!inWindow(at, window)) continue;
    const incident = await state.getIncident(incidentId);
    if (incident === null || incident.kind !== 'incident') continue;
    timesToPr.push(Math.max(0, Date.parse(at) - Date.parse(incident.openedAt)));
  }
  timesToPr.sort((a, b) => a - b);

  const open = await state.findIncidents({
    kind: 'incident',
    status: OPEN_STATUSES,
    ...(deps.workspaceId === undefined ? {} : { workspaceId: deps.workspaceId }),
    limit: 1000,
  });
  const oldest = open
    .filter((i) => Date.parse(i.openedAt) < window.to.getTime())
    .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || (a.id < b.id ? -1 : 1))
    .slice(0, OLDEST_SHOWN)
    .map((i) => openLine(i, window.to));

  return {
    window,
    opened,
    closed,
    pullRequests: timesToPr.length,
    ...(timesToPr.length === 0 ? {} : { medianTimeToPrMs: median(timesToPr), slowestTimeToPrMs: timesToPr[timesToPr.length - 1] ?? 0 }),
    autopilotMerges,
    reverts,
    oldestOpen: oldest,
  };
}

function openLine(i: IncidentView, at: Date): OpenIncidentLine {
  return {
    incidentId: i.id,
    label: i.jiraKey ?? i.id,
    ...(i.summary === undefined ? {} : { summary: i.summary }),
    openedAt: i.openedAt,
    ageMs: Math.max(0, at.getTime() - Date.parse(i.openedAt)),
    waitingOn: i.waitingOn?.kind ?? 'nothing',
    ...(i.waitingOn?.who === undefined ? {} : { who: i.waitingOn.who }),
  };
}

// Text -------------------------------------------------------------------------------------------

/** Rounds to the two largest units: "3d 4h", "2h 5m", "40m", "under a minute". */
export function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return 'under a minute';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return h > 0 ? `${String(d)}d ${String(h)}h` : `${String(d)}d`;
  if (h > 0) return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`;
  return `${String(m)}m`;
}

const WAITING_PHRASE: Readonly<Record<string, string>> = {
  ci: 'the automated checks',
  review: 'the review',
  human: 'an engineer',
  deploy: 'a rollout',
  hold: 'a human review',
  nothing: 'nothing in particular',
};

function waitPhrase(line: OpenIncidentLine): string {
  const base = WAITING_PHRASE[line.waitingOn] ?? line.waitingOn;
  return line.who === undefined ? base : `${base} (${line.who.replace(/[<>\s]/g, '')})`;
}

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The message posted to the channel or DM. */
export function renderDigest(d: Digest): string {
  const day = (t: Date): string => t.toISOString().slice(0, 10);
  const lines = [`Snapwing digest, ${day(d.window.from)} to ${day(d.window.to)}`];
  lines.push(`Opened ${count(d.opened, 'incident', 'incidents')}, closed ${String(d.closed)}.`);
  lines.push(
    d.medianTimeToPrMs === undefined
      ? 'Time to PR: no pull requests opened.'
      : `Time to PR: median ${humanDuration(d.medianTimeToPrMs)}, slowest ${humanDuration(d.slowestTimeToPrMs ?? 0)}, across ${count(d.pullRequests, 'pull request', 'pull requests')}.`,
  );
  lines.push(`Autopilot: ${count(d.autopilotMerges, 'merge', 'merges')}, ${count(d.reverts, 'revert', 'reverts')}.`);
  if (d.oldestOpen.length === 0) {
    lines.push('Nothing is open.');
  } else {
    lines.push(`Oldest open ${d.oldestOpen.length === 1 ? 'incident' : `${String(d.oldestOpen.length)} incidents`}:`);
    for (const o of d.oldestOpen) {
      lines.push(`- ${o.label}${o.summary === undefined ? '' : `, ${o.summary}`}: open ${humanDuration(o.ageMs)}, waiting on ${waitPhrase(o)}.`);
    }
  }
  return lines.join('\n');
}

// Job --------------------------------------------------------------------------------------------

/**
 * Registers one cron job per playbook digest (`digest to cron`) and returns the job names. An empty
 * list registers nothing: digests are off by default. More than `MAX_DIGESTS` rejects.
 */
export async function registerDigestJobs(deps: DigestDeps, digests: readonly PlaybookDigest[]): Promise<JobName[]> {
  if (digests.length > MAX_DIGESTS) {
    throw new RangeError(`the playbook has ${String(digests.length)} digests; at most ${String(MAX_DIGESTS)} are supported`);
  }
  const names: JobName[] = [];
  for (const [i, digest] of digests.entries()) {
    const name = DIGEST_JOBS[i];
    if (name === undefined) continue;
    parseCron(digest.cron);
    deps.workflow.work(name, async () => {
      await runDigest(deps, digest);
    });
    await deps.workflow.cron(name, digest.cron, { to: digest.to });
    names.push(name);
  }
  return names;
}

/** One digest run at the clock's current time: builds it and posts it to `digest.to`. */
export async function runDigest(deps: DigestDeps, digest: PlaybookDigest): Promise<Digest> {
  const built = await buildDigest(deps, digestWindow(digest.cron, deps.clock()));
  await deps.post(digest.to, renderDigest(built));
  return built;
}
