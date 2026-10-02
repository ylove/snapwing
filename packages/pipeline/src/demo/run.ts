// `pnpm demo` (phase 2 proof; main 14.3 reviewer demo mode, BUILDING 6): the merged orchestrator
// end to end, in one process on the `local` provider, with MSW standing in for Slack, Jira, and
// GitHub and a recorded model. No keys, no network: a request no mock handles fails the run.
//
//   pnpm demo [<dir>]                  (default dir: demo/levels)
//   SNAPWING_DB=sqlite|postgres        (postgres reads DATABASE_URL; the demo makes its own database in it)
//
// Pieces: state from `openState` on a fresh database; the in-process WorkflowPort on SQLite and
// pg-boss on Postgres, both polling for real; the demo-only Slack adapter, Jira search, outbox
// drainer, and GitHub repo reader in `msw/`; the model is each recording's answers by task behind
// `withValidation`, so every answer still passes the stage's own schema guard and retry contract.
//
// A recording (`<name>.json` next to `workspace-context.xml`) is one Slack channel moment: its
// messages, the message someone ran "Fix it from here" on, optional Jira issues and repo files that
// already exist, the model's answer per task, the taps people make on the cards in order, and the
// expected final status and Jira writes. The demo plays Slack (a signed `message_action`), lets the
// pipeline run until nothing is queued, sends what the outbox holds, applies the next tap to the card
// on screen, and repeats; then it prints the result next to the expectation. Exit 1 on any mismatch,
// any unhandled request, any job error, or a run over a minute.

import { readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventActorRole, IncidentEvent } from '../contracts/events.ts';
import type { ActorRole } from '../contracts/incident.ts';
import type { Job, JobName } from '../contracts/jobs.ts';
import type { CardKind } from '../engine/cursor.ts';
import type { EngineDeps } from '../engine/deps.ts';
import { IncidentOrchestrator } from '../engine/orchestrator.ts';
import { parseWorkspaceMap } from '../map/parse.ts';
import type { WorkspaceMap } from '../map/types.ts';
import { withValidation } from '../models/router.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionResult } from '../ports/model.ts';
import type { OpenedState, StatePort } from '../ports/state.ts';
import { waitKeyString, type WaitKey, type WorkflowPort } from '../ports/workflow.ts';
import { createKvCache } from '../providers/local/cache.ts';
import { openState } from '../state/db.ts';
import { StateStore } from '../state/store.ts';
import { InProcessWorkflow } from '../workflow/inprocess/index.ts';
import { PgBossWorkflow } from '../workflow/pgboss/index.ts';
import { demoRepoReader, type DemoRepos } from './msw/github.ts';
import { DemoJiraSearch, DemoOutboxDrainer, type SeedIssue, type SentRow } from './msw/jira.ts';
import { startDemoServer, type DemoServer } from './msw/server.ts';
import { DemoSlackAdapter, DemoSlackReader, demoSlackContext, messageActionRequest, type SlackWireMessage } from './msw/slack.ts';
import { createFreshDatabase, statusTrace } from './state.ts';

export const DEFAULT_DIR = 'demo/levels';
export const MAP_FILE = 'workspace-context.xml';
/** main 14.3: "a full pipeline trace in the terminal in under a minute". */
export const TIME_BUDGET_MS = 60_000;
const WORKSPACE_ID = '01K6DEMOWORKSPACE000000000';
const SETTLE_TIMEOUT_MS = 20_000;

// Recordings --------------------------------------------------------------------------------------

export interface DemoTap {
  card: CardKind;
  choice: string;
  /** Slack user id of whoever taps. */
  by: string;
}

export interface Scenario {
  /** File name without `.json`. */
  name: string;
  title: string;
  channel: { id: string; name: string };
  /** Who runs "Fix it from here". */
  reporter: { id: string; name: string };
  /** The `ts` of the message the action runs on. */
  anchor: string;
  messages: SlackWireMessage[];
  jira: SeedIssue[];
  github: DemoRepos;
  /** The model's answer per task (`segmentation`, `clarify`, `scout`, `triage`). */
  model: Readonly<Record<string, unknown>>;
  taps: DemoTap[];
  expect: { status: string; outbox: SentRow[] };
}

export class RecordingError extends Error {
  override readonly name = 'RecordingError';
  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
  }
}

const CARDS: readonly CardKind[] = ['scope-preview', 'dedupe', 'clarify', 'fix-preview'];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates one recording; `file` names it in errors. */
export function parseScenario(file: string, value: unknown): Scenario {
  const fail = (problem: string): never => {
    throw new RecordingError(file, problem);
  };
  const obj = (v: unknown, at: string): Json => (isObject(v) ? v : fail(`${at} must be an object`));
  const text = (v: unknown, at: string): string => (typeof v === 'string' && v !== '' ? v : fail(`${at} must be a non-empty string`));
  const list = (v: unknown, at: string): unknown[] => (Array.isArray(v) ? v : fail(`${at} must be an array`));

  const root = obj(value, 'the recording');
  const channel = obj(root['channel'], 'channel');
  const reporter = obj(root['reporter'], 'reporter');
  const messages = list(root['messages'], 'messages').map((raw, i): SlackWireMessage => {
    const m = obj(raw, `messages[${i}]`);
    const ts = text(m['ts'], `messages[${i}].ts`);
    if (!/^\d{10}\.\d{6}$/.test(ts)) fail(`messages[${i}].ts must look like a Slack ts (1790845200.000100)`);
    const threadTs = m['thread_ts'];
    const replyCount = m['reply_count'];
    return {
      ts,
      user: text(m['user'], `messages[${i}].user`),
      text: text(m['text'], `messages[${i}].text`),
      ...(typeof threadTs === 'string' ? { thread_ts: threadTs } : {}),
      ...(typeof replyCount === 'number' ? { reply_count: replyCount } : {}),
    };
  });
  const anchor = text(root['anchor'], 'anchor');
  if (!messages.some((m) => m.ts === anchor)) fail(`anchor ${anchor} is not one of the messages`);

  const jira = isObject(root['jira']) ? list(root['jira']['issues'] ?? [], 'jira.issues') : [];
  const seeds = jira.map((raw, i): SeedIssue => {
    const s = obj(raw, `jira.issues[${i}]`);
    const assignee = s['assignee'];
    return {
      key: text(s['key'], `jira.issues[${i}].key`),
      summary: text(s['summary'], `jira.issues[${i}].summary`),
      ...(typeof assignee === 'string' ? { assignee } : {}),
    };
  });

  const github: Record<string, Record<string, string>> = {};
  for (const [repo, files] of Object.entries(root['github'] === undefined ? {} : obj(root['github'], 'github'))) {
    github[repo] = {};
    for (const [path, content] of Object.entries(obj(files, `github.${repo}`))) github[repo][path] = text(content, `github.${repo}.${path}`);
  }

  const taps = list(root['taps'], 'taps').map((raw, i): DemoTap => {
    const t = obj(raw, `taps[${i}]`);
    const card = text(t['card'], `taps[${i}].card`);
    const kind = CARDS.find((c) => c === card) ?? fail(`taps[${i}].card must be one of ${CARDS.join(', ')}`);
    return { card: kind, choice: text(t['choice'], `taps[${i}].choice`), by: text(t['by'], `taps[${i}].by`) };
  });

  const expect = obj(root['expect'], 'expect');
  const outbox = list(expect['outbox'], 'expect.outbox').map((raw, i) => {
    const r = obj(raw, `expect.outbox[${i}]`);
    const to = r['to'];
    const level = r['autonomyLevel'];
    const field = r['field'];
    const value = r['value'];
    const labels = r['labels'];
    return sentRow({
      op: text(r['op'], `expect.outbox[${i}].op`),
      issueKey: text(r['issueKey'], `expect.outbox[${i}].issueKey`),
      ...(typeof to === 'string' ? { to } : {}),
      ...(typeof level === 'number' ? { autonomyLevel: level } : {}),
      ...(typeof field === 'string' ? { field } : {}),
      ...(typeof value === 'string' || typeof value === 'number' ? { value } : {}),
      ...(Array.isArray(labels) ? { labels: labels.map((l, j) => text(l, `expect.outbox[${i}].labels[${j}]`)) } : {}),
    });
  });

  return {
    name: file.replace(/\.json$/, ''),
    title: text(root['title'], 'title'),
    channel: { id: text(channel['id'], 'channel.id'), name: text(channel['name'], 'channel.name') },
    reporter: { id: text(reporter['id'], 'reporter.id'), name: text(reporter['name'], 'reporter.name') },
    anchor,
    messages,
    jira: seeds,
    github,
    model: obj(root['model'], 'model'),
    taps,
    expect: { status: text(expect['status'], 'expect.status'), outbox },
  };
}

/** Every `*.json` recording in `dir`, in file name order. */
export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch (e) {
      throw new RecordingError(file, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    scenarios.push(parseScenario(file, value));
  }
  if (scenarios.length === 0) throw new Error(`no recordings in ${dir}`);
  return scenarios;
}

/** A SentRow with its keys in one order, so two rows compare by their JSON. */
function sentRow(r: SentRow): SentRow {
  return {
    op: r.op,
    issueKey: r.issueKey,
    ...(r.to === undefined ? {} : { to: r.to }),
    ...(r.autonomyLevel === undefined ? {} : { autonomyLevel: r.autonomyLevel }),
    ...(r.field === undefined ? {} : { field: r.field }),
    ...(r.value === undefined ? {} : { value: r.value }),
    ...(r.labels === undefined ? {} : { labels: [...r.labels] }),
  };
}

// The recorded model ------------------------------------------------------------------------------

/**
 * Replays the current recording's answer for each task. A ModelBackend: `withValidation` runs each
 * request's own `validate` on the answer, so a recording cannot hand a stage something its schema
 * would refuse. A task the recording has no answer for fails the run, naming both.
 */
export class RecordedModel implements ModelBackend {
  readonly calls: string[] = [];
  #scenario = '';
  #answers: Readonly<Record<string, unknown>> = {};

  use(scenario: string, answers: Readonly<Record<string, unknown>>): void {
    this.#scenario = scenario;
    this.#answers = answers;
  }

  complete(): Promise<CompletionResult> {
    return Promise.reject(new Error(`${this.#scenario}: the demo records no free-text completions`));
  }

  vision(): Promise<VisionResult> {
    return Promise.reject(new Error(`${this.#scenario}: the demo records no image readings`));
  }

  classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
    this.calls.push(request.task);
    if (!(request.task in this.#answers)) {
      return Promise.reject(new Error(`${this.#scenario}: the recording has no model answer for task ${request.task}`));
    }
    return Promise.resolve({ value: this.#answers[request.task], model: 'demo/recorded' });
  }
}

// Knowing when the pipeline is idle ---------------------------------------------------------------

/**
 * A WorkflowPort decorator that knows when nothing is left to run: every job a `start` or `resume`
 * made due has been delivered, and no handler is running. Works over either real poller, so the
 * demo never sleeps a fixed time. A delivery that began after a call started counts for that call,
 * so a fast poller cannot leave a job id expected forever.
 */
export class SettlingWorkflow implements WorkflowPort {
  readonly errors: unknown[] = [];
  readonly #inner: WorkflowPort;
  readonly #expected = new Set<string>();
  readonly #lastDelivery = new Map<string, number>();
  readonly #parkedOn = new Map<string, string>();
  #deliveries = 0;
  #running = 0;

  constructor(inner: WorkflowPort) {
    this.#inner = inner;
  }

  async start(name: JobName, input: unknown, opts: Parameters<WorkflowPort['start']>[2]): Promise<{ jobId: string }> {
    const mark = this.#deliveries;
    const result = await this.#inner.start(name, input, opts);
    this.#expect(result.jobId, mark);
    return result;
  }

  schedule(name: JobName, input: unknown, runAt: Date, opts?: { singletonKey?: string }): Promise<{ jobId: string }> {
    return this.#inner.schedule(name, input, runAt, opts);
  }

  cancel(singletonKey: string): Promise<void> {
    return this.#inner.cancel(singletonKey);
  }

  work(name: JobName, handler: (job: Job) => Promise<void>, opts?: { concurrency?: number }): void {
    this.#inner.work(
      name,
      async (job) => {
        this.#deliveries += 1;
        this.#lastDelivery.set(job.id, this.#deliveries);
        this.#expected.delete(job.id);
        this.#running += 1;
        try {
          await handler(job);
        } catch (err) {
          this.errors.push(err);
          throw err;
        } finally {
          this.#running -= 1;
        }
      },
      opts,
    );
  }

  async park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void> {
    await this.#inner.park(jobId, waitingOn, timeoutAt);
    this.#parkedOn.set(waitKeyString(waitingOn), jobId);
  }

  async resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }> {
    const mark = this.#deliveries;
    const out = await this.#inner.resume(waitingOn, result);
    const jobId = this.#parkedOn.get(waitKeyString(waitingOn));
    if (out.resumed > 0 && jobId !== undefined) this.#expect(jobId, mark);
    return out;
  }

  cron(name: JobName, expression: string, input?: unknown): Promise<void> {
    return this.#inner.cron(name, expression, input);
  }

  /** Resolves once nothing is expected or running; rejects on a job error or after `timeoutMs`. */
  async settled(timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let quietChecks = 0;
    while (quietChecks < 2) {
      if (this.errors.length > 0) throw this.errors[0];
      if (Date.now() > deadline) throw new Error(`the pipeline did not settle within ${timeoutMs} ms`);
      quietChecks = this.#expected.size === 0 && this.#running === 0 ? quietChecks + 1 : 0;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  #expect(jobId: string, mark: number): void {
    if ((this.#lastDelivery.get(jobId) ?? 0) <= mark) this.#expected.add(jobId);
  }
}

// Trace -------------------------------------------------------------------------------------------

interface TraceLine {
  at: number;
  /** Events sort before platform calls made in the same millisecond. */
  order: 0 | 1;
  text: string;
}

const WIDTH = 200;

function clip(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > WIDTH ? `${flat.slice(0, WIDTH - 3)}...` : flat;
}

function get(p: Json, key: string): string {
  const v = p[key];
  return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
}

type Names = (slackIdOrHandle: string) => string;

/**
 * One line per event type, keyed by name rather than switched on the union, so a renamed event
 * (#117) prints with an empty summary instead of breaking the build.
 */
const EVENT_SUMMARY: Readonly<Record<string, (p: Json, names: Names) => string>> = {
  captured: (p, n) => `from ${n(get(isObject(p['reporter']) ? p['reporter'] : {}, 'id'))}: "${get(p, 'anchorText')}"`,
  'context-assembled': (p) => `${get(p, 'includedCount')} included, ${get(p, 'excludedCount')} excluded`,
  resolved: (p, n) => {
    const where = [get(p, 'surfaceId') || '?', get(p, 'componentId')].filter((s) => s !== '').join('/');
    return `${where}, owner ${n(get(p, 'ownerId'))}, project ${get(p, 'jiraProject')}, repo ${get(p, 'repo')} (${get(p, 'resolvedBy')})`;
  },
  'dedupe-checked': (p) => {
    const candidates = Array.isArray(p['candidates']) ? p['candidates'].filter(isObject) : [];
    const best = candidates[0];
    return best === undefined
      ? 'no duplicates'
      : `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}, best ${get(best, 'issueKey')} at ${Number(best['score']).toFixed(2)}, ${get(p, 'decision')}`;
  },
  'dedupe-decided': (p) => `${get(p, 'decision')}${get(p, 'issueKey') === '' ? '' : ` ${get(p, 'issueKey')}`}${p['timedOut'] === true ? ' (timed out)' : ''}`,
  clarified: (p) => `asks the ${get(p, 'audience')}: "${get(p, 'question')}"`,
  'clarify-answered': (p) => {
    const applies = isObject(p['appliesTo']) ? `, sets ${get(p['appliesTo'], 'field')} ${get(p['appliesTo'], 'id')}` : '';
    return `"${get(p, 'answer')}" to seq ${get(p, 'questionSeq')}${applies}`;
  },
  planned: (p) => {
    const request = isObject(p['implementationRequest']) ? ', implementation request stored' : '';
    return `level ${get(p, 'autonomyLevel')}, ${get(p, 'priority')} ${get(p, 'issueType')} "${get(p, 'summary')}"${request}`;
  },
  filed: (p) => get(p, 'jiraKey'),
  tapped: (p) => `${get(p, 'card')}: ${get(p, 'choice')}`,
  'waiting-changed': (p, n) => {
    const on = isObject(p['waitingOn']) ? p['waitingOn'] : undefined;
    return on === undefined ? 'wait over' : `waiting on ${on['who'] === undefined ? get(on, 'kind') : n(get(on, 'who'))}`;
  },
  corrected: (p) => `seq ${get(p, 'correctsSeq')} ${get(p, 'fields')} (${get(p, 'reason')})`,
  'resolution-signal': (p) => `"${get(p, 'text')}"`,
  'linked-to-existing': (p) => get(p, 'issueKey'),
  'not-a-bug': (p) => get(p, 'reason'),
};

function eventLine(e: IncidentEvent, names: Names): string {
  const summary = EVENT_SUMMARY[e.type]?.(e.payload as unknown as Json, names) ?? '';
  return `event   #${String(e.seq).padEnd(2)} ${e.type.padEnd(19)} ${summary}`;
}

// The demo ----------------------------------------------------------------------------------------

export interface DemoIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface DemoOptions {
  /** Recordings directory; default `demo/levels`. */
  dir?: string;
}

export interface ScenarioResult {
  name: string;
  title: string;
  incidentId?: string;
  status?: string;
  level?: number;
  /** Jira writes the outbox drainer sent for this incident, in order. */
  outbox: SentRow[];
  /** Outbox rows still unsent when the scenario ended (always 0 when it passes). */
  pending: number;
  /** The touched Jira issues as the mock holds them at the end. */
  jira: { key: string; status: string; comments: number }[];
  /** Kinds of the cards posted in the thread, in order. */
  cards: string[];
  problems: string[];
  elapsedMs: number;
}

export interface DemoReport {
  code: 0 | 1;
  dialect?: string;
  elapsedMs: number;
  scenarios: ScenarioResult[];
  unhandled: string[];
}

interface Runtime {
  io: DemoIo;
  map: WorkspaceMap;
  state: StatePort;
  workflow: SettlingWorkflow;
  engine: IncidentOrchestrator;
  adapter: DemoSlackAdapter;
  drainer: DemoOutboxDrainer;
  model: RecordedModel;
  server: DemoServer;
  buffer: TraceLine[];
  names: Names;
  roleOf: (slackId: string) => ActorRole;
}

async function settle(rt: Runtime): Promise<void> {
  for (let i = 0; i < 16; i++) {
    await rt.workflow.settled();
    if ((await rt.drainer.drain()) === 0) return;
  }
  throw new Error('the outbox kept refilling');
}

function flush(rt: Runtime, events: readonly IncidentEvent[]): void {
  const lines: TraceLine[] = [
    ...events.map((e): TraceLine => ({ at: Date.parse(e.recordedAt), order: 0, text: eventLine(e, rt.names) })),
    ...rt.buffer.splice(0),
  ];
  lines.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const l of lines) rt.io.stdout(`  ${clip(l.text)}`);
}

async function newEvents(rt: Runtime, incidentId: string | undefined, after: number): Promise<IncidentEvent[]> {
  if (incidentId === undefined) return [];
  return (await rt.state.read(incidentId)).filter((e) => e.seq > after);
}

async function runScenario(rt: Runtime, s: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const { io, server } = rt;
  const problems: string[] = [];
  rt.model.use(s.name, s.model);
  server.slack.addChannel(s.channel.id, s.channel.name, s.messages);
  server.jira.seed(s.jira);
  server.github.addRepos(s.github);

  io.stdout('');
  io.stdout(`${s.name}: ${s.title}`);
  for (const m of [...s.messages].sort((a, b) => Number(a.ts) - Number(b.ts))) {
    const marker = m.ts === s.anchor ? '>' : ' ';
    io.stdout(`  ${marker} #${s.channel.name} ${new Date(Number(m.ts) * 1000).toISOString().slice(11, 16)} ${rt.names(m.user)}: ${m.text}`);
  }
  for (const seed of s.jira) io.stdout(`    jira already has ${seed.key} "${seed.summary}"`);

  const anchor = s.messages.find((m) => m.ts === s.anchor);
  if (anchor === undefined) throw new RecordingError(`${s.name}.json`, 'anchor missing');
  const request = messageActionRequest({ channel: s.channel, user: s.reporter, message: anchor });
  const ack = (await rt.engine.handleInbound('slack', request)) as { status: number };
  io.stdout(`  slack   ${rt.names(s.reporter.id)} runs "Fix it from here" on the ${new Date(Number(s.anchor) * 1000).toISOString().slice(11, 16)} message; acknowledged ${ack.status}`);
  const incidentId = rt.adapter.received.get(`slack:${s.channel.id}:${s.anchor}`)?.eventId;
  if (incidentId === undefined) problems.push('the adapter never normalized the action');

  let printed = 0;
  const step = async (): Promise<void> => {
    await settle(rt);
    const events = await newEvents(rt, incidentId, printed);
    printed = events[events.length - 1]?.seq ?? printed;
    flush(rt, events);
  };
  await step();

  for (const tap of s.taps) {
    const card = server.slack.lastCard(s.channel.id, s.anchor);
    if (card?.kind !== tap.card || card.eventId === undefined) {
      problems.push(`expected a ${tap.card} card to tap, found ${card?.kind ?? 'none'}`);
      break;
    }
    const role: EventActorRole = rt.roleOf(tap.by);
    io.stdout(`  tap     ${rt.names(tap.by)} taps ${tap.choice} on ${tap.card}`);
    const outcome = await rt.engine.handleTap({ eventId: card.eventId, card: tap.card, choice: tap.choice, actor: { id: tap.by, role } });
    if (!outcome.accepted) {
      problems.push(`tap ${tap.choice} on ${tap.card} refused: ${outcome.reason}`);
      break;
    }
    await step();
  }

  const view = incidentId === undefined ? undefined : ((await rt.state.getIncident(incidentId)) ?? undefined);
  const log = incidentId === undefined ? [] : await rt.state.read(incidentId);
  const planned = log.find((e): e is IncidentEvent<'planned'> => e.type === 'planned');
  const outbox = (incidentId === undefined ? [] : (rt.drainer.sent.get(incidentId) ?? [])).map(sentRow);
  const pending = (await rt.state.drainOutbox('jira', 50)).filter((r) => r.incidentId === incidentId).length;
  const touched = [...new Set(outbox.map((r) => r.issueKey))];
  const jira = touched.flatMap((key) => {
    const issue = server.jira.issues.get(key);
    return issue === undefined ? [] : [{ key, status: issue.status, comments: issue.comments.length }];
  });
  const cards = server.slack.posts.filter((p) => p.channel === s.channel.id && p.threadTs === s.anchor && p.kind !== 'status').map((p) => p.kind);

  if (view?.status !== s.expect.status) problems.push(`status ${view?.status ?? 'missing'}, expected ${s.expect.status}`);
  if (JSON.stringify(outbox) !== JSON.stringify(s.expect.outbox)) {
    problems.push(`outbox ${JSON.stringify(outbox)}, expected ${JSON.stringify(s.expect.outbox)}`);
  }
  if (pending > 0) problems.push(`${pending} outbox rows left unsent`);

  const elapsedMs = Date.now() - started;
  const path = statusTrace(log).path.join(' > ');
  const detail = (r: SentRow): string =>
    r.to !== undefined ? ` to ${r.to}` : r.field !== undefined ? ` ${r.field} "${String(r.value)}"` : r.labels !== undefined ? ` ${r.labels.join(' ')}` : '';
  const writes = outbox.length === 0 ? 'no Jira writes' : outbox.map((r) => `${r.op} ${r.issueKey}${detail(r)}`).join(', ');
  io.stdout(`  path    ${path}`);
  io.stdout(
    `  result  ${view?.status ?? 'missing'}${planned === undefined ? '' : ` at level ${planned.payload.autonomyLevel}`}; ${writes}; ` +
      `${problems.length === 0 ? 'as expected' : `MISMATCH: ${problems.join('; ')}`} (${(elapsedMs / 1000).toFixed(1)} s)`,
  );

  return {
    name: s.name,
    title: s.title,
    ...(incidentId === undefined ? {} : { incidentId }),
    ...(view === undefined ? {} : { status: view.status }),
    ...(planned === undefined ? {} : { level: planned.payload.autonomyLevel }),
    outbox,
    pending,
    jira,
    cards,
    problems,
    elapsedMs,
  };
}

/** Runs every recording in `dir` and returns the report; `report.code` is the exit code. */
export async function runDemo(io: DemoIo, options: DemoOptions = {}): Promise<DemoReport> {
  const started = Date.now();
  const dir = options.dir ?? DEFAULT_DIR;
  const scenarios: ScenarioResult[] = [];
  const buffer: TraceLine[] = [];
  let server: DemoServer | undefined;
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>> | undefined;
  let state: OpenedState | undefined;
  let poller: InProcessWorkflow | PgBossWorkflow | undefined;
  let dialect: string | undefined;
  let failed = false;
  try {
    const map = await parseWorkspaceMap(await readFile(join(dir, MAP_FILE), 'utf8'));
    const recordings = await loadScenarios(dir);
    server = startDemoServer((who, text) => buffer.push({ at: Date.now(), order: 1, text: `${who.padEnd(7)} ${text}` }));

    fresh = await createFreshDatabase(io.env);
    const opened = await openState(fresh.options);
    state = opened;
    dialect = opened.dialect;
    if (!(opened instanceof StateStore)) throw new Error('demo: openState did not return the StateStore');
    const store: StateStore = opened;
    const onError = (e: unknown): void => io.stderr(`demo: job error: ${e instanceof Error ? e.message : String(e)}`);
    if (store.dialect === 'postgres') {
      poller = new PgBossWorkflow(store, { schema: 'pgboss', pollingIntervalSeconds: 0.5, onError });
    } else {
      poller = new InProcessWorkflow(store, { pollIntervalMs: 10, onError });
    }
    const workflow = new SettlingWorkflow(poller);

    const people = new Map<string, { handle: string; role: ActorRole }>();
    for (const p of map.people) if (p.slackId !== undefined) people.set(p.slackId, { handle: p.handle, role: p.role === 'engineer' ? 'engineer' : 'reporter' });
    const names: Names = (id) => (id === '' ? 'nobody' : `@${people.get(id)?.handle ?? id}`);
    const roleOf = (id: string): ActorRole => people.get(id)?.role ?? 'unknown';

    const clock = (): Date => new Date();
    const adapter = new DemoSlackAdapter(roleOf, clock);
    const model = new RecordedModel();
    const deps: EngineDeps = {
      workspaceId: WORKSPACE_ID,
      state: store,
      workflow,
      model: withValidation(model),
      adapters: new Map([['slack', adapter]]),
      context: new Map([['slack', demoSlackContext(new DemoSlackReader())]]),
      jiraSearch: new DemoJiraSearch(),
      cache: createKvCache(store),
      map,
      repoReader: demoRepoReader,
      clock,
    };
    const engine = new IncidentOrchestrator(deps);
    engine.register();
    await poller.startPolling();
    const drainer = new DemoOutboxDrainer({ state: store, workspaceId: WORKSPACE_ID, continueIncident: (id) => engine.continueIncident(id), clock });

    io.stdout(
      `pnpm demo on ${store.dialect} (${store.dialect === 'postgres' ? 'pg-boss' : 'in-process'} workflow, local provider): ` +
        `${recordings.length} recordings from ${dir}; Slack, Jira, and GitHub are MSW mocks, the model is recorded, no keys`,
    );
    const rt: Runtime = { io, map, state: store, workflow, engine, adapter, drainer, model, server, buffer, names, roleOf };
    for (const s of recordings) {
      const result = await runScenario(rt, s);
      scenarios.push(result);
      failed = failed || result.problems.length > 0;
    }
  } catch (e) {
    io.stderr(`demo: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  } finally {
    await poller?.stop();
    await state?.close();
    await fresh?.drop();
    server?.close();
  }

  const unhandled = server?.unhandled ?? [];
  if (unhandled.length > 0) {
    io.stderr(`demo: requests left the mocks: ${unhandled.join(', ')}`);
    failed = true;
  }
  const elapsedMs = Date.now() - started;
  const passed = scenarios.filter((s) => s.problems.length === 0).length;
  io.stdout('');
  io.stdout(`${passed} of ${scenarios.length} recordings as expected, ${unhandled.length} requests outside the mocks, ${(elapsedMs / 1000).toFixed(1)} s`);
  if (elapsedMs > TIME_BUDGET_MS) {
    io.stderr(`demo: took ${(elapsedMs / 1000).toFixed(1)} s, over the one minute budget (main 14.3)`);
    failed = true;
  }
  return { code: failed ? 1 : 0, ...(dialect === undefined ? {} : { dialect }), elapsedMs, scenarios, unhandled };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const dir = process.argv[2];
  const report = await runDemo({ env: process.env, stdout: (l) => console.log(l), stderr: (l) => console.error(l) }, dir === undefined ? {} : { dir });
  process.exitCode = report.code;
}
