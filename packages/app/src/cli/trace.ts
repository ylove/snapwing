// `snapwing trace <KEY or incident id> [--json]` (main 20.3, B 10): the incident, in order, from the
// event log. It opens the state store the way `state rebuild` does (`SNAPWING_DB` / `DATABASE_URL`,
// `SNAPWING_SQLITE_PATH` for the SQLite file) and reads; it never writes.
//
// The text trace is one line per event that carries a fact an engineer asks about: the bundle
// (what was included, and what was excluded with the reason), the confidence stack result (the
// `resolved` event), dedupe, the ask-back, plan, gates, cards and taps with who, level changes,
// fixer runs, review, CI, merge, and the status messages. Events that only feed projections
// (`waiting-changed`, `bot-message-posted`, ...) are left out of the text and kept in `--json`.

import { parseArgs } from 'node:util';
import { stateOptionsFromEnv } from '@snapwing/pipeline/contracts/state.ts';
import type { ContextBundle } from '@snapwing/pipeline/contracts/incident.ts';
import type { ArtifactRef, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { openState } from '@snapwing/pipeline/state/db.ts';
import type { CliIo } from './state.ts';

export const TRACE_USAGE = `Usage: snapwing trace <KEY or incident id> [--json]

  <KEY>          the Jira key, such as WEB-1042
  <incident id>  the incident's ULID
  --json         print the incident's events as JSON instead of the trace

Environment: SNAPWING_DB=sqlite|postgres, DATABASE_URL (postgres), SNAPWING_SQLITE_PATH (sqlite file).`;

/** Opens the store the way `state rebuild` does. The caller closes it. */
export async function openStateFromEnv(env: CliIo['env']): Promise<OpenedState> {
  const options = stateOptionsFromEnv(env);
  const sqlitePath = env['SNAPWING_SQLITE_PATH']?.trim();
  if (options.dialect === 'sqlite' && sqlitePath !== undefined && sqlitePath !== '') {
    options.url = sqlitePath;
  }
  return openState(options);
}

/** The most incidents `findIncidents` returns (`FIND_INCIDENTS_MAX_LIMIT`). */
const MAX_INCIDENTS = 1000;

/**
 * The events of the most recently updated incidents (up to 1000), read per incident. `readSince`
 * would page the whole log, but on Postgres it withholds rows above the oldest open transaction in
 * the cluster, so a quiet-looking page can hide committed events; a per-incident `read` has no such
 * gate. `truncated` is true when more incidents exist than were read.
 */
export async function readIncidentLogs(state: StatePort): Promise<{ events: IncidentEvent[]; truncated: boolean }> {
  const incidents = await state.findIncidents({ kind: 'incident', limit: MAX_INCIDENTS });
  const events: IncidentEvent[] = [];
  for (const incident of incidents) {
    events.push(...(await state.read(incident.id)));
  }
  return { events, truncated: incidents.length >= MAX_INCIDENTS };
}

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** A Jira key or an incident id; the most recently updated incident wins when a key matches several. */
export async function findIncident(state: StatePort, ref: string): Promise<IncidentView | null> {
  if (JIRA_KEY.test(ref)) {
    const found = await state.findIncidents({ jiraKey: ref.toUpperCase(), limit: 1 });
    return found[0] ?? null;
  }
  return state.getIncident(ref);
}

/** Runs `snapwing trace <args>` and returns the exit code. */
export async function runTrace(args: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (e) {
    io.stderr(`snapwing trace: ${errorMessage(e)}\n${TRACE_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.stdout(TRACE_USAGE);
    return 0;
  }
  const [ref, ...extra] = parsed.positionals;
  if (ref === undefined || extra.length > 0) {
    io.stderr(`snapwing trace: give one Jira key or incident id\n${TRACE_USAGE}`);
    return 1;
  }
  let state: OpenedState | undefined;
  try {
    state = await openStateFromEnv(io.env);
    const incident = await findIncident(state, ref);
    if (incident === null) {
      io.stderr(`snapwing trace: no incident matches ${JSON.stringify(ref)}`);
      return 1;
    }
    const events = await state.read(incident.id);
    if (parsed.values.json) {
      io.stdout(JSON.stringify(events, null, 2));
      return 0;
    }
    for (const line of await renderTrace(state, incident, events)) {
      io.stdout(line);
    }
    return 0;
  } catch (e) {
    io.stderr(`snapwing trace: ${errorMessage(e)}`);
    return 1;
  } finally {
    await state?.close();
  }
}

/** The trace as lines: a header, then one line per event worth reading (a bundle adds its messages below it). */
export async function renderTrace(state: StatePort, incident: IncidentView, events: readonly IncidentEvent[]): Promise<string[]> {
  const head = [incident.jiraKey, incident.id].filter((s) => s !== undefined).join(' ');
  const lines = [
    `Trace ${head}: ${incident.status}${incident.autonomyLevel === undefined ? '' : `, level ${incident.autonomyLevel}`}${incident.surfaceId === undefined ? '' : `, surface ${incident.surfaceId}`}`,
  ];
  if (incident.summary !== undefined) {
    lines.push(`  ${incident.summary}`);
  }
  for (const event of events) {
    const text = describe(event);
    if (text === undefined) {
      continue;
    }
    lines.push(`${String(event.seq).padStart(3)}  ${event.occurredAt.slice(0, 19)}Z  ${event.type.padEnd(20)} ${who(event)}  ${text}`.trimEnd());
    const ref = bundleRef(event);
    if (ref !== undefined) {
      lines.push(...(await renderBundle(state, ref)));
    }
  }
  return lines;
}

function who(event: IncidentEvent): string {
  const actor = event.actor === undefined ? event.source : `${event.actor.id} (${event.actor.role})`;
  return `[${actor}]`;
}

function bundleRef(event: IncidentEvent): ArtifactRef | undefined {
  return event.type === 'context-assembled' || event.type === 'scope-changed' ? event.payload.bundle : undefined;
}

async function renderBundle(state: StatePort, ref: ArtifactRef): Promise<string[]> {
  let bundle: ContextBundle;
  try {
    const artifact = await state.getArtifact(ref.artifactId, ref.version);
    bundle = JSON.parse(artifact.body) as ContextBundle;
  } catch {
    return ['       (bundle body not available)'];
  }
  const out: string[] = [];
  for (const m of bundle.included ?? []) {
    out.push(`       + ${m.id} ${m.authorId}: ${clip(m.text)}`);
  }
  for (const x of bundle.excluded ?? []) {
    out.push(`       - ${x.id}: ${x.reason}`);
  }
  return out;
}

/** One line of detail for an event, or undefined for the events the text trace skips. */
function describe(event: IncidentEvent): string | undefined {
  switch (event.type) {
    case 'captured': {
      const p = event.payload;
      return `${p.kind} from ${p.source} by ${p.reporter.name}: ${clip(p.anchorText)}`;
    }
    case 'context-assembled':
      return `bundle v${event.payload.bundle.version}: ${event.payload.includedCount} included, ${event.payload.excludedCount} excluded`;
    case 'scope-changed':
      return `scope ${event.payload.choice}: bundle v${event.payload.bundle.version}, ${event.payload.includedCount} included, ${event.payload.excludedCount} excluded`;
    case 'resolved': {
      const p = event.payload;
      const found = [p.surfaceId && `surface ${p.surfaceId}`, p.componentId && `component ${p.componentId}`, p.ownerId && `owner ${p.ownerId}`, p.repo && `repo ${p.repo}`];
      return `by ${p.resolvedBy} at ${p.confidence}: ${found.filter((s) => typeof s === 'string' && s !== '').join(', ') || 'nothing resolved'}${p.evidence ? ` (from ${p.evidence.path})` : ''}`;
    }
    case 'dedupe-checked': {
      const best = event.payload.candidates[0];
      return `${event.payload.decision}, ${event.payload.candidates.length} candidates${best === undefined ? '' : `, best ${best.issueKey} at ${best.score}`}`;
    }
    case 'dedupe-decided':
      return `${event.payload.decision}${event.payload.issueKey ? ` ${event.payload.issueKey}` : ''}${event.payload.timedOut ? ' (timed out)' : ''}`;
    case 'linked-to-existing':
      return `linked to ${event.payload.issueKey}`;
    case 'clarified':
      return `asked the ${event.payload.audience}${event.payload.asks ? ` (${event.payload.asks})` : ''}: ${clip(event.payload.question)}`;
    case 'clarify-answered':
      return `answered question at seq ${event.payload.questionSeq}: ${clip(event.payload.answer)}`;
    case 'planned': {
      const p = event.payload;
      return `${p.action}${p.autonomyLevel === undefined ? '' : ` at level ${p.autonomyLevel}`}${p.priority ? `, ${p.priority}` : ''}: ${clip(p.summary ?? '')}${p.degraded ? ` (degraded: ${p.degraded})` : ''}`;
    }
    case 'filed':
      return event.payload.jiraKey;
    case 'tapped':
      return `${event.payload.card} card: ${event.payload.choice}`;
    case 'claimed':
      return `claimed by ${event.payload.claimerId} until ${event.payload.expiresAt}`;
    case 'released':
      return event.payload.scope === 'claim' ? `claim by ${event.payload.claimerId} ${event.payload.reason}` : `hold on ${event.payload.env} ${event.payload.reason}`;
    case 'let-agent-take':
      return `${event.payload.claimerId} handed it back to the agent`;
    case 'held': {
      const p = event.payload;
      if (p.kind === 'environment') {
        return `environment ${p.env} until ${p.expiresAt}`;
      }
      const g = p.gate;
      return `gate: ${p.reason}${g === undefined ? '' : ` (review ${g.reviewVerdict}, ci ${g.ciGreen ? 'green' : 'not green'}, risk ${g.riskGate.passed ? 'passed' : 'failed'}, decision ${g.decision})`}`;
    }
    case 'level-changed':
      return `${event.payload.from} to ${event.payload.to}: ${event.payload.reason}`;
    case 'fixer-started':
      return `run ${event.payload.runId} attempt ${event.payload.attempt} on ${event.payload.harness}`;
    case 'fixer-checkpoint':
      return `${event.payload.phase}: ${clip(event.payload.detail)}`;
    case 'fixer-done':
      return `branch ${event.payload.branch}: ${clip(event.payload.summary)}`;
    case 'fixer-failed':
      return `${clip(event.payload.reason)} after ${event.payload.attempts} attempts`;
    case 'pr-opened':
      return `PR #${event.payload.prNumber} on ${event.payload.branch}`;
    case 'review-passed':
      return `PR #${event.payload.prNumber}`;
    case 'review-failed':
      return `PR #${event.payload.prNumber} ${event.payload.verdict}: ${clip(event.payload.reason)}`;
    case 'ci-green':
      return `PR #${event.payload.prNumber} at ${event.payload.headSha.slice(0, 7)}`;
    case 'ci-red':
      return `PR #${event.payload.prNumber}: ${event.payload.failingChecks.join(', ')}`;
    case 'merged':
      return `PR #${event.payload.prNumber} at level ${event.payload.levelAtMergeTime}`;
    case 'reverted':
      return `PR #${event.payload.prNumber}${event.payload.revertPrNumber === undefined ? '' : ` by #${event.payload.revertPrNumber}`}${event.payload.reason ? `: ${event.payload.reason}` : ''}`;
    case 'deployed:staging':
    case 'deployed:production':
      return event.payload.commitSha.slice(0, 7);
    case 'verified':
      return `${event.payload.env}${event.payload.note ? `: ${event.payload.note}` : ''}`;
    case 'closed':
    case 'not-a-bug':
    case 'stopped':
      return event.payload.reason ?? '';
    case 'escalated':
      return `step ${event.payload.step} (${event.payload.action}) at score ${event.payload.score}`;
    case 'status-message-posted':
      return `message ${event.payload.messageId}`;
    case 'corrected':
      return `seq ${event.payload.correctsSeq}: ${event.payload.reason}`;
    default:
      return undefined;
  }
}

function clip(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
