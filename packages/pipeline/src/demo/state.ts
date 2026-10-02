// `pnpm demo:state` (phase 1 proof; B 4, B 5, B 11 rebuild row): seed a fresh database from the
// recorded incident logs in `demo/state/`, snapshot the projections, rebuild them from the log,
// snapshot again, and print a short trace per incident. Exits 1 when the snapshots differ or a
// recording does not end in its expected status.
//
//   pnpm demo:state [<dir>]            (default dir: demo/state)
//   SNAPWING_DB=sqlite|postgres        (postgres reads DATABASE_URL; the demo makes its own database in it)
//
// A recording is one `<name>.jsonl` file holding one incident: one `NewEvent` per line, in log order,
// with fixed `occurredAt` times and fixed ULIDs so a rebuild is deterministic. `expected.json` in the
// same directory maps each file to the status (and claim count) its replay must end in.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isEventType, type EventType, type IncidentEvent, type NewEvent } from '../contracts/events.ts';
import { LOG_START, stateOptionsFromEnv, type IncidentStatus, type StateOptions } from '../contracts/state.ts';
import { INITIAL_STATUS, isValidTransition, nextStatus } from '../lifecycle/machine.ts';
import type { OpenedState } from '../ports/state.ts';
import { openState } from '../state/db.ts';
import { rebuild, snapshotProjections } from '../state/rebuild.ts';
import { ulid } from '../util/ulid.ts';

// Recordings --------------------------------------------------------------------------------------

export interface Recording {
  /** File name inside the recordings directory. */
  file: string;
  incidentId: string;
  events: NewEvent[];
}

export interface Expectation {
  /** The `incidents.status` the replay must end in. */
  status: IncidentStatus;
  /** How many `claims` rows must remain; default 0. */
  claims?: number;
}

export type Expectations = Readonly<Record<string, Expectation>>;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SOURCES: ReadonlySet<string> = new Set(['slack', 'teams', 'jira', 'github', 'ci', 'deploy', 'agent', 'cli', 'fixer']);
const ACTOR_ROLES: ReadonlySet<string> = new Set(['engineer', 'reporter', 'unknown', 'human']);

/** `?` marks an optional key. `object` means a non-null, non-array object. */
type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array';
type Shape = Readonly<Record<string, Kind | `${Kind}?`>>;

/**
 * The keys each payload must carry and their JSON kinds: the runtime mirror of `EventPayloads`.
 * `satisfies` makes it exhaustive, so a new `EventType` without a row fails the typecheck. Union
 * payloads (`released`, `held`) list the keys every variant shares; `validateRecordedEvent` checks
 * their discriminant separately.
 */
const PAYLOAD_SHAPES = {
  captured: { kind: 'string', idempotencyKey: 'string', source: 'string', reporter: 'object', anchorText: 'string', channelId: 'string', anchorId: 'string?', threadId: 'string?', parentId: 'string?', deepLink: 'string?', rawPayloadSnapshot: 'object?' },
  'context-assembled': { bundle: 'object', includedCount: 'number', excludedCount: 'number' },
  resolved: { resolvedBy: 'string', confidence: 'number', surfaceId: 'string?', componentId: 'string?', ownerId: 'string?', repo: 'string?', jiraProject: 'string?' },
  'dedupe-checked': { candidates: 'array', decision: 'string' },
  clarified: { audience: 'string', question: 'string', answer: 'string?', timedOut: 'boolean' },
  planned: { action: 'string', projectKey: 'string', issueType: 'string', summary: 'string', priority: 'string', labels: 'array', autonomyLevel: 'number', linkTo: 'string?', componentId: 'string?', implementationRequest: 'object?' },
  filed: { jiraKey: 'string' },
  claimed: { claimerId: 'string', expiresAt: 'string' },
  'fixer-started': { runId: 'string', harness: 'string', attempt: 'number' },
  'pr-opened': { prNumber: 'number', branch: 'string' },
  'review-passed': { prNumber: 'number', review: 'object?' },
  'review-failed': { prNumber: 'number', verdict: 'string', reason: 'string', review: 'object?' },
  'ci-green': { prNumber: 'number', headSha: 'string' },
  'ci-red': { prNumber: 'number', headSha: 'string', failingChecks: 'array' },
  merged: { prNumber: 'number', mergeCommitSha: 'string', levelAtMergeTime: 'number' },
  'deployed:staging': { commitSha: 'string', deploymentId: 'string?' },
  verified: { env: 'string', note: 'string?' },
  'deployed:production': { commitSha: 'string', deploymentId: 'string?' },
  closed: { reason: 'string?' },
  escalated: { intent: 'string', step: 'number', action: 'string', score: 'number' },
  stopped: { reason: 'string?' },
  released: { scope: 'string', reason: 'string', claimerId: 'string?', restoredLevel: 'number?', env: 'string?' },
  held: { kind: 'string', env: 'string?', claimerId: 'string?', expiresAt: 'string?', reason: 'string?', gate: 'object?' },
  comment: { intent: 'string', platform: 'string', signalSource: 'string', confidence: 'number', raw: 'string', target: 'object?', environment: 'string?', count: 'object?' },
  'level-changed': { from: 'number', to: 'number', reason: 'string' },
  reverted: { prNumber: 'number', revertPrNumber: 'number?', reason: 'string?' },
  'resolution-signal': { messageId: 'string', text: 'string' },
  'linked-to-existing': { issueKey: 'string' },
  'not-a-bug': { reason: 'string?' },
  'let-agent-take': { claimerId: 'string' },
  tapped: { eventId: 'string', card: 'string', choice: 'string' },
  corrected: { correctsSeq: 'number', fields: 'object', reason: 'string' },
  'status-message-posted': { messageId: 'string' },
  'waiting-changed': { waitingOn: 'object?' },
  'monitoring-started': { qualifiedBy: 'string' },
  'monitoring-stopped': { reason: 'string' },
  'jira-priority-changed': { jiraKey: 'string', to: 'string', from: 'string?' },
  'jira-assignee-changed': { jiraKey: 'string', from: 'string?', to: 'string?' },
  'jira-transitioned': { jiraKey: 'string', from: 'string', to: 'string' },
  'fixer-checkpoint': { phase: 'string', detail: 'string' },
  'fixer-artifact': { kind: 'string', artifact: 'object' },
  'fixer-done': { prNumber: 'number', branch: 'string', summary: 'string', testsAdded: 'array' },
  'fixer-failed': { reason: 'string', attempts: 'number', partialBranch: 'string?' },
} as const satisfies { readonly [K in EventType]: Shape };

/** Closed value sets for the discriminants and enums a typo would silently break. */
const ENUMS: Readonly<Partial<Record<EventType, Readonly<Record<string, readonly string[]>>>>> = {
  released: { scope: ['claim', 'hold'] },
  held: { kind: ['environment', 'gate'] },
  'fixer-checkpoint': { phase: ['cloned', 'branched', 'implemented', 'tested', 'pushed', 'pr-opened'] },
  'review-failed': { verdict: ['request-changes', 'escalate'] },
  tapped: { card: ['scope-preview', 'dedupe', 'clarify', 'fix-preview'] },
  'dedupe-checked': { decision: ['none', 'link', 'create-anyway', 'pending-user'] },
};

function kindOf(value: unknown): Kind | 'null' | 'other' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'other';
  }
}

/**
 * Checks one recorded event against the event catalog (contracts/events.ts): the envelope, a known
 * `type`, and the payload keys and kinds for that type. Returns the problems, empty when it is valid.
 */
export function validateRecordedEvent(value: unknown): string[] {
  const problems: string[] = [];
  if (kindOf(value) !== 'object') {
    return ['expected a JSON object'];
  }
  const e = value as Record<string, unknown>;
  for (const key of ['workspaceId', 'incidentId'] as const) {
    if (typeof e[key] !== 'string' || !ULID_RE.test(e[key])) problems.push(`${key} must be a 26-character ULID`);
  }
  if (typeof e['v'] !== 'number' || !Number.isInteger(e['v']) || e['v'] < 1) problems.push('v must be a positive integer');
  if (typeof e['source'] !== 'string' || !SOURCES.has(e['source'])) problems.push('source is not an event source');
  if (typeof e['occurredAt'] !== 'string' || !ISO_RE.test(e['occurredAt']) || Number.isNaN(Date.parse(e['occurredAt']))) {
    problems.push('occurredAt must be an ISO 8601 UTC timestamp');
  }
  if (e['actor'] !== undefined) {
    const actor = e['actor'] as Record<string, unknown> | null;
    if (kindOf(actor) !== 'object' || typeof actor?.['id'] !== 'string' || typeof actor['role'] !== 'string' || !ACTOR_ROLES.has(actor['role'])) {
      problems.push('actor must be { id: string, role: engineer | reporter | unknown | human }');
    }
  }
  const type = e['type'];
  if (typeof type !== 'string' || !isEventType(type)) {
    problems.push(`type ${JSON.stringify(type)} is not in the event catalog`);
    return problems;
  }
  if (kindOf(e['payload']) !== 'object') {
    problems.push('payload must be an object');
    return problems;
  }
  const payload = e['payload'] as Record<string, unknown>;
  const shape: Shape = PAYLOAD_SHAPES[type];
  for (const [key, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?');
    const want = (optional ? spec.slice(0, -1) : spec) as Kind;
    const got = payload[key];
    if (got === undefined) {
      if (!optional) problems.push(`${type} payload is missing ${key}`);
    } else if (kindOf(got) !== want) {
      problems.push(`${type} payload ${key} must be a ${want}`);
    }
  }
  for (const key of Object.keys(payload)) {
    if (!(key in shape)) problems.push(`${type} payload has unknown key ${key}`);
  }
  for (const [key, allowed] of Object.entries(ENUMS[type] ?? {})) {
    const got = payload[key];
    if (typeof got === 'string' && !allowed.includes(got)) problems.push(`${type} payload ${key} must be one of ${allowed.join(', ')}`);
  }
  return problems;
}

/** Reads every `*.jsonl` in `dir` (sorted by name), validating each line. One incident per file. */
export async function loadRecordings(dir: string): Promise<Recording[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  if (files.length === 0) {
    throw new Error(`no *.jsonl recordings in ${dir}`);
  }
  const recordings: Recording[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const events: NewEvent[] = [];
    text.split('\n').forEach((line, i) => {
      if (line.trim() === '') {
        return;
      }
      const where = `${file}:${i + 1}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${where}: not valid JSON`);
      }
      const problems = validateRecordedEvent(value);
      if (problems.length > 0) {
        throw new Error(`${where}: ${problems.join('; ')}`);
      }
      events.push(value as NewEvent);
    });
    const first = events[0];
    if (first === undefined) {
      throw new Error(`${file}: empty recording`);
    }
    if (events.some((e) => e.incidentId !== first.incidentId)) {
      throw new Error(`${file}: a recording holds exactly one incident`);
    }
    recordings.push({ file, incidentId: first.incidentId, events });
  }
  return recordings;
}

/** Reads `expected.json` in `dir`: `{ "<file>.jsonl": { "status": "...", "claims": 0 } }`. */
export async function loadExpectations(dir: string): Promise<Expectations> {
  const value: unknown = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));
  if (kindOf(value) !== 'object') {
    throw new Error('expected.json must be an object keyed by recording file name');
  }
  for (const [file, exp] of Object.entries(value as Record<string, unknown>)) {
    const e = exp as { status?: unknown; claims?: unknown } | null;
    if (typeof e?.status !== 'string' || (e.claims !== undefined && typeof e.claims !== 'number')) {
      throw new Error(`expected.json: ${file} needs { status: string, claims?: number }`);
    }
  }
  return value as Expectations;
}

/** Appends each recording's events in order with `expectedSeq` taken from the log. Returns events appended. */
export async function seedRecordings(state: OpenedState, recordings: readonly Recording[]): Promise<number> {
  const existing = await state.readSince(LOG_START, 1);
  if (existing.events.length > 0) {
    throw new Error('seeding needs an empty database, but the event log already has events');
  }
  let appended = 0;
  for (const recording of recordings) {
    let expectedSeq = 0;
    for (const event of recording.events) {
      expectedSeq = (await state.append(recording.incidentId, [event], expectedSeq)).seq;
      appended += 1;
    }
  }
  return appended;
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

// Fresh database ----------------------------------------------------------------------------------

interface FreshDatabase {
  options: StateOptions;
  drop(): Promise<void>;
}

/** An empty database of its own: a temp SQLite file, or a new database inside the `DATABASE_URL` server. */
export async function createFreshDatabase(env: Readonly<Record<string, string | undefined>>): Promise<FreshDatabase> {
  const base = stateOptionsFromEnv(env);
  if (base.dialect === 'sqlite') {
    const dir = await mkdtemp(join(tmpdir(), 'snapwing-demo-state-'));
    return {
      options: { dialect: 'sqlite', url: join(dir, 'state.sqlite') },
      drop: () => rm(dir, { recursive: true, force: true }),
    };
  }
  const adminUrl = base.url ?? '';
  const database = `snapwing_demo_${ulid().toLowerCase()}`;
  await withClient(adminUrl, (c) => c.query(`create database "${database}"`));
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return {
    options: { dialect: 'postgres', url: url.toString() },
    drop: () => withClient(adminUrl, (c) => c.query(`drop database if exists "${database}" with (force)`)).then(() => undefined),
  };
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// The demo ----------------------------------------------------------------------------------------

export interface DemoIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface DemoOptions {
  /** Recordings directory; default `demo/state`. */
  dir?: string;
  /** Runs after seeding and before the first snapshot. Tests tamper with a projection here to prove drift exits 1. */
  afterSeed?: (state: OpenedState) => Promise<void>;
}

/** Status path of a replay, from the log alone: `captured > assembling > ... > filed`, repeats collapsed. */
export function statusTrace(log: readonly IncidentEvent[]): { path: IncidentStatus[]; invalid: string[] } {
  const path: IncidentStatus[] = [INITIAL_STATUS];
  const invalid: string[] = [];
  let current: IncidentStatus = INITIAL_STATUS;
  for (const event of log) {
    if (!isValidTransition(current, event)) {
      invalid.push(`seq ${event.seq} ${event.type} in ${current}`);
    }
    current = nextStatus(current, event);
    if (path[path.length - 1] !== current) {
      path.push(current);
    }
  }
  return { path, invalid };
}

/** Runs the demo and returns the exit code: 0 identical and as expected, 1 otherwise. */
export async function runDemoState(io: DemoIo, options: DemoOptions = {}): Promise<number> {
  const dir = options.dir ?? 'demo/state';
  let fresh: FreshDatabase | undefined;
  let state: OpenedState | undefined;
  try {
    const recordings = await loadRecordings(dir);
    const expectations = await loadExpectations(dir);
    for (const r of recordings) {
      if (expectations[r.file] === undefined) throw new Error(`expected.json has no entry for ${r.file}`);
    }
    fresh = await createFreshDatabase(io.env);
    state = await openState(fresh.options);
    const events = await seedRecordings(state, recordings);
    io.stdout(`demo:state on ${state.dialect}: seeded ${events} events across ${recordings.length} incidents from ${dir}`);

    await options.afterSeed?.(state);
    const before = await snapshotProjections(state);
    const result = await rebuild(state, { all: true });
    const after = await snapshotProjections(state);
    io.stdout(`rebuilt ${result.incidents} incidents from ${result.events} events`);

    let ok = true;
    for (const r of recordings) {
      const expected = expectations[r.file]!;
      const view = await state.getIncident(r.incidentId);
      const claims = (await state.getClaims(r.incidentId)).length;
      const { path, invalid } = statusTrace(await state.read(r.incidentId));
      const problems: string[] = invalid.map((i) => `event does not fit the lifecycle (${i})`);
      if (view?.status !== expected.status) problems.push(`status ${view?.status ?? 'missing'}, expected ${expected.status}`);
      if (claims !== (expected.claims ?? 0)) problems.push(`${claims} claims, expected ${expected.claims ?? 0}`);
      if (path[path.length - 1] !== expected.status) problems.push(`lifecycle path ends in ${path[path.length - 1]}`);
      ok = ok && problems.length === 0;
      io.stdout(`${r.file.replace(/\.jsonl$/, '')} (${r.events.length} events)`);
      io.stdout(`  ${path.join(' > ')}`);
      io.stdout(`  final ${view?.status ?? 'missing'}, claims ${claims}, ${problems.length === 0 ? 'as expected' : `MISMATCH: ${problems.join('; ')}`}`);
    }

    if (before === after) {
      io.stdout('identical: yes');
    } else {
      io.stdout('identical: no');
      io.stderr(`projections differ after rebuild:\n${lineDiff(before, after)}`);
      ok = false;
    }
    return ok ? 0 : 1;
  } catch (e) {
    io.stderr(`demo:state: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await state?.close();
    await fresh?.drop();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const dir = process.argv[2];
  process.exitCode = await runDemoState(
    { env: process.env, stdout: (l) => console.log(l), stderr: (l) => console.error(l) },
    dir === undefined ? {} : { dir },
  );
}
