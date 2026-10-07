// Status queries (A 4.3): "where are we with this?" asked in a thread, by mention, in a DM, with
// `/status`, or from the CLI. Two steps, both pure over a snapshot of the projections (incidents,
// claims, subscriptions), the incident log, and the workspace map, so a test or a CLI can run them
// without a store:
//
// - `resolveQuery(query)`: which incident (or surface) the asker means. An explicit Jira key wins;
//   then, in a thread, the thread's incident; elsewhere the words are matched against open incidents
//   by the map's vocabulary table, component names, and summary similarity (shared words weighted by
//   how rare they are among open incidents). The best match wins; when the top two tie the answer is
//   a question naming both ("WEB-1042 (blank cart total) or WEB-1051 (promo code rejected)?"). Words
//   that only name a surface ("how's the website today?"), or no words at all in a channel the map
//   ties to a surface, are a surface question: open incidents there, worst first.
// - `answer(incident, audience)`: the A 4.3 shapes. Reporter: plain language under the 20.1 rules
//   (checked with `reporterViolations`, no "PR", no paths). Engineer: priority, owner, autonomy level,
//   the timeline from the log, holds and watchers. Lead (a stakeholder who did not report it): the
//   reporter's plain language plus priority and owner. Every answer ends with the next expected step
//   and who or what it waits on.
//
// The text uses the neutral form of `copy.ts`: plain text with `<@ref>` mention tokens only; each
// platform escapes the rest and renders the tokens. Times are wall clock in `timeZone` (default UTC).

import type { IncidentEvent } from '../contracts/events.ts';
import type { ApprovalAction, IncidentActor } from '../contracts/incident.ts';
import type { StatusStage } from '../contracts/adapters.ts';
import type { StatusAnswer, StatusQuery } from '../contracts/signals.ts';
import type { Claim, IncidentView, IncidentWaitingOn, Subscription } from '../contracts/state.ts';
import { INITIAL_STATUS, isTerminalStatus, nextStatus, type LifecycleStatus } from '../lifecycle/machine.ts';
import type { WorkspaceMap } from '../map/types.ts';
import { emojiFor, mentionToken, reporterViolations } from './copy.ts';

export type StatusAudience = StatusAnswer['audience'];
export type StatusWaitingOn = StatusAnswer['waitingOn'];

/** What the queries read. Everything but `incidents` and `now` is optional; a missing part reads as empty. */
export interface StatusSnapshot {
  /** `incidents` rows (B 3), open and closed. */
  incidents: readonly IncidentView[];
  /** The incident's log, oldest first. Without it the timeline is empty and times fall back to the row. */
  events?: (incidentId: string) => readonly IncidentEvent[];
  map?: WorkspaceMap;
  claims?: readonly Claim[];
  subscriptions?: readonly Subscription[];
  now: Date;
  /** IANA zone for wall-clock times. Default UTC. */
  timeZone?: string;
}

/** What `resolveQuery` found. */
export type QueryResolution =
  | { kind: 'incident'; incident: IncidentView; by: 'key' | 'thread' | 'words' }
  | { kind: 'tie'; candidates: [IncidentView, IncidentView]; question: string }
  | { kind: 'surface'; surfaceId: string; incidents: IncidentView[] }
  | { kind: 'none' };

export interface StatusQueries {
  resolveQuery(query: StatusQuery): QueryResolution;
  answer(incident: IncidentView, audience: StatusAudience): StatusAnswer;
  /** Open incidents on a surface, one line each, worst first. */
  answerSurface(surfaceId: string, audience: StatusAudience): StatusAnswer;
  /** `resolveQuery`, then the answer for the asker's audience (a tie or no match is answered with a question). */
  respond(query: StatusQuery): StatusAnswer;
}

/**
 * The shape an asker gets for an incident: engineers get the engineer shape, the incident's reporter
 * the reporter shape, anyone else (a stakeholder) the lead shape. A surface question with no incident
 * is a lead question unless an engineer asked.
 */
export function audienceFor(asker: IncidentActor, incident?: IncidentView): StatusAudience {
  if (asker.role === 'engineer') return 'engineer';
  if (incident !== undefined && incident.reporterId === asker.id) return 'reporter';
  return 'lead';
}

/** Indexes `snapshot` once; the returned functions answer any number of queries against it. */
export function createStatusQueries(snapshot: StatusSnapshot): StatusQueries {
  const index = buildIndex(snapshot);
  const queries: StatusQueries = {
    resolveQuery: (query) => resolve(index, query),
    answer: (incident, audience) => answerIncident(index, incident, audience),
    answerSurface: (surfaceId, audience) => answerSurface(index, surfaceId, audience),
    respond(query) {
      const found = queries.resolveQuery(query);
      switch (found.kind) {
        case 'incident':
          return queries.answer(found.incident, audienceFor(query.asker, found.incident));
        case 'surface':
          return queries.answerSurface(found.surfaceId, audienceFor(query.asker));
        case 'tie':
          return question(audienceFor(query.asker), found.question);
        case 'none':
          return question(
            audienceFor(query.asker),
            "I couldn't tell which report you mean. Name its key (like WEB-1042), a few words from it, or a surface.",
          );
      }
    },
  };
  return queries;
}

function question(audience: StatusAudience, text: string): StatusAnswer {
  return { audience, text, waitingOn: { kind: 'nothing' }, nextStep: 'tell me which one you mean', actions: [] };
}

// Index -------------------------------------------------------------------------------------------

interface Phrase {
  tokens: string[];
  surface: string;
  component?: string;
}

interface Index {
  snapshot: StatusSnapshot;
  byKey: Map<string, IncidentView[]>;
  /** Open top-level incidents: the candidates for words and surface lists. */
  open: IncidentView[];
  summaryTokens: Map<string, Set<string>>;
  idf: Map<string, number>;
  /** Names that point at a surface only: surface labels and ids, vocabulary terms without a component. */
  surfacePhrases: Phrase[];
  /** Names that point at a component: component labels and ids, vocabulary terms with one. */
  componentPhrases: Phrase[];
  claims: Map<string, Claim[]>;
  watchers: Map<string, string[]>;
  timeZone: string;
}

function buildIndex(snapshot: StatusSnapshot): Index {
  const byKey = new Map<string, IncidentView[]>();
  const open: IncidentView[] = [];
  const summaryTokens = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const incident of snapshot.incidents) {
    if (incident.jiraKey !== undefined) push(byKey, incident.jiraKey.toUpperCase(), incident);
    if (incident.kind !== 'incident' || isTerminalStatus(incident.status)) continue;
    open.push(incident);
    const tokens = new Set(contentTokens(incident.summary ?? ''));
    summaryTokens.set(incident.id, tokens);
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + open.length / n));

  const surfacePhrases: Phrase[] = [];
  const componentPhrases: Phrase[] = [];
  const map = snapshot.map;
  if (map !== undefined) {
    for (const s of map.surfaces) {
      for (const name of [s.label, s.id]) addPhrase(surfacePhrases, name, s.id);
      for (const c of s.components) for (const name of [c.label, c.id]) addPhrase(componentPhrases, name, s.id, c.id);
    }
    for (const term of map.vocabulary) {
      if (term.component === undefined) addPhrase(surfacePhrases, term.text, term.surface);
      else addPhrase(componentPhrases, term.text, term.surface, term.component);
    }
  }

  const claims = new Map<string, Claim[]>();
  for (const c of snapshot.claims ?? []) push(claims, c.incidentId, c);
  const watchers = new Map<string, string[]>();
  for (const s of snapshot.subscriptions ?? []) {
    if (s.scopeKind !== 'incident' || s.scopeId === undefined) continue;
    const list = watchers.get(s.scopeId) ?? [];
    if (!list.includes(s.userId)) list.push(s.userId);
    watchers.set(s.scopeId, list);
  }
  return { snapshot, byKey, open, summaryTokens, idf, surfacePhrases, componentPhrases, claims, watchers, timeZone: snapshot.timeZone ?? 'UTC' };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list === undefined) m.set(k, [v]);
  else list.push(v);
}

function addPhrase(list: Phrase[], text: string, surface: string, component?: string): void {
  const tokens = words(text).map(stem);
  if (tokens.length === 0) return;
  list.push(component === undefined ? { tokens, surface } : { tokens, surface, component });
}

// Words -------------------------------------------------------------------------------------------

/** Question words and filler that say nothing about which incident: "status on the checkout thing". */
const STOPWORDS = new Set(
  (
    'a an and any are as at be been being bug bugs by can could did do does doing for from going got has have how hows i ' +
    'in into is issue issues it its let me my of on open or our please problem s so status thing things that the there ' +
    'this to today update updates us was we were what whats where wheres which who why with yet you your agent ' +
    'hey hi thanks tell know news any anything going latest right now still'
  ).split(' '),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** A light plural strip, enough for "totals" to meet "total". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function contentTokens(text: string): string[] {
  return words(text)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** Start positions of `phrase` in `tokens`. */
function phraseAt(tokens: readonly string[], phrase: readonly string[]): number[] {
  const at: number[] = [];
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    if (phrase.every((t, j) => tokens[i + j] === t)) at.push(i);
  }
  return at;
}

// Resolving ---------------------------------------------------------------------------------------

const JIRA_KEY = /\b([a-z][a-z0-9]{0,9}-\d+)\b/gi;

/** Score weights: a named component outweighs shared summary words; a named surface only nudges. */
const COMPONENT_WEIGHT = 3;
const SURFACE_WEIGHT = 1;
const TIE_EPSILON = 1e-9;

function resolve(index: Index, query: StatusQuery): QueryResolution {
  for (const m of query.text.matchAll(JIRA_KEY)) {
    const hit = preferIncident(index.byKey.get((m[1] ?? '').toUpperCase()) ?? []);
    if (hit !== undefined) return { kind: 'incident', incident: hit, by: 'key' };
  }
  const threadId = query.context.threadId;
  if (threadId !== undefined && threadId !== '') {
    const hit = threadIncident(index, query.context.channelId, threadId);
    if (hit !== undefined) return { kind: 'incident', incident: hit, by: 'thread' };
  }
  return byWords(index, query);
}

/** The top-level incident when there is one, else the most recently updated row. */
function preferIncident(rows: readonly IncidentView[]): IncidentView | undefined {
  const sorted = [...rows].sort((a, b) => Number(b.kind === 'incident') - Number(a.kind === 'incident') || b.updatedAt.localeCompare(a.updatedAt));
  return sorted[0];
}

/**
 * The incident whose thread `threadId` is: its anchor message, its pinned status message, or the
 * thread its anchor was a reply in (`captured.threadId`, from the log). Open incidents win over
 * closed ones, then the latest updated.
 */
function threadIncident(index: Index, channelId: string | undefined, threadId: string): IncidentView | undefined {
  const inChannel = index.snapshot.incidents.filter((i) => channelId === undefined || i.channelId === undefined || i.channelId === channelId);
  const events = index.snapshot.events;
  const hits = inChannel.filter((i) => {
    if (i.anchorId === threadId || i.statusMsgId === threadId) return true;
    if (events === undefined) return false;
    const captured = events(i.id).find((e) => e.type === 'captured');
    return captured?.type === 'captured' && captured.payload.threadId === threadId;
  });
  const open = hits.filter((i) => !isTerminalStatus(i.status));
  return preferIncident(open.length > 0 ? open : hits);
}

function byWords(index: Index, query: StatusQuery): QueryResolution {
  // Mention tokens (the bot's own, a person's) say nothing about which incident.
  const tokens = words(query.text.replace(/<[^>]*>/g, ' ')).map(stem);
  const consumed = new Set<number>();
  const surfaces: string[] = [];
  for (const p of index.surfacePhrases) {
    for (const at of phraseAt(tokens, p.tokens)) {
      for (let k = 0; k < p.tokens.length; k += 1) consumed.add(at + k);
      if (!surfaces.includes(p.surface)) surfaces.push(p.surface);
    }
  }
  const components = new Map<string, Set<string>>();
  for (const p of index.componentPhrases) {
    if (p.component === undefined) continue;
    const at = phraseAt(tokens, p.tokens);
    if (at.length === 0) continue;
    for (const i of at) for (let k = 0; k < p.tokens.length; k += 1) consumed.add(i + k);
    const set = components.get(p.surface) ?? new Set<string>();
    set.add(p.component);
    components.set(p.surface, set);
  }
  // Summary words: what is left after surface names, minus filler.
  const free = new Set(tokens.filter((t, i) => !consumed.has(i) && t.length > 1 && !STOPWORDS.has(t)));
  // A component name also counts as a summary word ("checkout" in "Checkout returns 500").
  for (const p of index.componentPhrases) for (const t of p.tokens) if (tokens.includes(t) && !STOPWORDS.has(t)) free.add(t);

  const scored: { incident: IncidentView; score: number }[] = [];
  for (const incident of index.open) {
    let specific = 0;
    if (incident.componentId !== undefined && incident.surfaceId !== undefined && components.get(incident.surfaceId)?.has(incident.componentId) === true) {
      specific += COMPONENT_WEIGHT;
    }
    const summary = index.summaryTokens.get(incident.id);
    if (summary !== undefined) for (const t of free) if (summary.has(t)) specific += index.idf.get(t) ?? 0;
    if (specific <= 0) continue;
    const surfaceBonus = incident.surfaceId !== undefined && surfaces.includes(incident.surfaceId) ? SURFACE_WEIGHT : 0;
    scored.push({ incident, score: specific + surfaceBonus });
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score || worse(a.incident, b.incident));
    const [first, second] = scored;
    if (first === undefined) return { kind: 'none' };
    if (second !== undefined && first.score - second.score < TIE_EPSILON) {
      const pair: [IncidentView, IncidentView] = [first.incident, second.incident];
      return { kind: 'tie', candidates: pair, question: `${pair.map(tieLabel).join(' or ')}?` };
    }
    return { kind: 'incident', incident: first.incident, by: 'words' };
  }

  const surfaceId = surfaces[0] ?? channelSurface(index, query.context.channelId);
  if (surfaceId !== undefined) return { kind: 'surface', surfaceId, incidents: openOn(index, surfaceId) };
  return { kind: 'none' };
}

function channelSurface(index: Index, channelId: string | undefined): string | undefined {
  if (channelId === undefined) return undefined;
  const channel = index.snapshot.map?.channels.find((c) => c.id === channelId);
  if (channel === undefined || channel.surface === 'from-payload') return undefined;
  return channel.surface;
}

function tieLabel(incident: IncidentView): string {
  const summary = safeSummary(incident.summary);
  const name = incident.jiraKey ?? summary ?? 'an unfiled report';
  return incident.jiraKey !== undefined && summary !== undefined ? `${name} (${summary})` : name;
}

// Worst first -------------------------------------------------------------------------------------

const PRIORITY_RANK: Readonly<Record<string, number>> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
/** Statuses where a person has to act before anything moves. */
const NEEDS_HUMAN = new Set<LifecycleStatus>(['escalated', 'reverted', 'held', 'stopped']);

/** Negative when `a` is worse than `b`: higher priority, monitored, needing a human, then older. */
function worse(a: IncidentView, b: IncidentView): number {
  const rank = (i: IncidentView): number => PRIORITY_RANK[(i.priority ?? '').toLowerCase()] ?? 5;
  return (
    rank(a) - rank(b) ||
    Number(b.monitored) - Number(a.monitored) ||
    Number(NEEDS_HUMAN.has(b.status)) - Number(NEEDS_HUMAN.has(a.status)) ||
    a.openedAt.localeCompare(b.openedAt) ||
    a.id.localeCompare(b.id)
  );
}

function openOn(index: Index, surfaceId: string): IncidentView[] {
  return index.open.filter((i) => i.surfaceId === surfaceId).sort(worse);
}

// Where an incident stands ------------------------------------------------------------------------

interface Standing {
  /** Plain-language present state, reporter safe, no trailing period. */
  now: string;
  /** Plain-language next step, reporter safe. */
  next: string;
  waiting: StatusWaitingOn;
  /** Engineer form of what it waits on, in order: "CI, then <@dana>'s approval". */
  chain: string;
  stage?: StatusStage;
  actions: ApprovalAction[];
  /** For the reporter: what they are asked to do, when it waits on them. */
  ask?: string;
}

/** The autonomy level at which a fix starts on filing (main 12). */
const FIX_NOW_LEVEL = 2;

function standing(index: Index, incident: IncidentView, log: readonly IncidentEvent[], since: string): Standing {
  const ownerRef = incident.assigneeId ?? incident.ownerRef;
  const owner = ownerRef === undefined ? 'an engineer' : mentionToken(ownerRef);
  const ownerWait = (): StatusWaitingOn => (ownerRef === undefined ? { kind: 'human', since } : { kind: 'human', who: ownerRef, since });
  const level = incident.autonomyLevel ?? 0;
  const claim = index.claims.get(incident.id)?.[0];
  const reporterRef = incident.reporterId;
  const key = incident.jiraKey ?? 'the ticket';

  switch (incident.status) {
    case 'captured':
    case 'assembling':
    case 'resolved':
    case 'deduped':
    case 'planned':
      return { now: "I'm reading the thread and filing it", next: 'it gets filed as a ticket', waiting: { kind: 'nothing' }, chain: 'filing', actions: [] };
    case 'filed':
      if (level >= FIX_NOW_LEVEL) {
        return { now: 'Filed, and a fix is starting', next: 'a fix gets written and reviewed', waiting: { kind: 'nothing' }, chain: 'the fixer starting', stage: 'filed', actions: ['stop'] };
      }
      return {
        now: 'Filed, waiting for an engineer to pick it up',
        next: `${owner} decides whether the agent fixes it or picks it up`,
        waiting: ownerWait(),
        chain: `${owner} (Fix it or pick it up)`,
        stage: 'filed',
        actions: ['approve_fix'],
      };
    case 'stopped':
      return {
        now: `The fix was stopped and ${key} is back in Backlog`,
        next: `${owner} decides what happens next`,
        waiting: ownerWait(),
        chain: `${owner} (Fix it or pick it up)`,
        stage: 'stopped',
        actions: ['approve_fix'],
      };
    case 'claimed':
    case 'human-fixing': {
      const who = claim?.claimerId ?? ownerRef;
      const person = who === undefined ? 'An engineer' : mentionToken(who);
      return {
        now: `${person} is fixing it`,
        next: 'their fix goes up for review',
        waiting: who === undefined ? { kind: 'human', since } : { kind: 'human', who, since },
        chain: `${person}'s fix`,
        stage: 'fixing',
        actions: [],
      };
    }
    case 'fixing':
    case 'fixing-retry':
      return {
        now: incident.status === 'fixing' ? 'A fix is being written' : 'A second attempt at a fix is being written',
        next: 'the fix goes up for review',
        waiting: { kind: 'nothing' },
        chain: 'the fixer, then the review agent',
        stage: 'fixing',
        actions: ['stop'],
      };
    case 'in-review':
    case 'in-review-retry':
      return {
        now: 'A fix is being reviewed',
        next: "once the review and the automated checks pass, it goes to staging, and I'll ask you to check",
        waiting: { kind: 'review', who: 'review agent', since },
        chain: level >= 3 ? 'the review agent, then CI' : `the review agent, then CI, then ${owner}'s approval`,
        stage: 'review-passed',
        actions: ['stop'],
      };
    case 'ci':
    case 'ci-retry':
      return {
        now: 'A fix is being reviewed',
        next:
          level >= 3
            ? "once the automated checks pass, it merges and goes to staging, and I'll ask you to check"
            : `once the automated checks pass and ${owner} approves, it goes to staging, and I'll ask you to check`,
        waiting: { kind: 'ci', who: 'CI', since },
        chain: level >= 3 ? 'CI, then automatic merge' : `CI, then ${owner}'s approval`,
        stage: 'review-passed',
        actions: ['stop'],
      };
    case 'mergeable':
      if (level >= 3) {
        return { now: 'The fix passed review', next: "it merges and goes to staging, and I'll ask you to check", waiting: { kind: 'nothing' }, chain: 'automatic merge', stage: 'review-passed', actions: ['stop'] };
      }
      return {
        now: 'The fix passed review',
        next: `${owner} approves it, then it goes to staging, and I'll ask you to check`,
        waiting: ownerWait(),
        chain: `${owner}'s approval`,
        stage: 'review-passed',
        actions: ['merge', 'request_changes'],
      };
    case 'held': {
      const reason = heldReason(log);
      return {
        now: reason === undefined ? 'The fix is held for human review' : `The fix is held for human review: ${reason}`,
        next: `${owner} decides whether it goes ahead`,
        waiting: ownerRef === undefined ? { kind: 'hold', since } : { kind: 'hold', who: ownerRef, since },
        chain: `${owner} (held at a gate)`,
        stage: 'held',
        actions: ['merge', 'request_changes'],
      };
    }
    case 'merged':
      return {
        now: 'The fix is merged. Waiting for a staging deploy',
        next: "when it's on staging I'll ask you to check",
        waiting: { kind: 'deploy', who: 'staging', since },
        chain: 'the staging deploy',
        stage: 'merged',
        actions: ['revert'],
      };
    case 'deployed:staging': {
      const reporter = reporterRef === undefined ? 'the reporter' : mentionToken(reporterRef);
      return {
        now: 'The fix is on staging',
        next: 'once it checks out on staging, it goes live',
        waiting: reporterRef === undefined ? { kind: 'human', since } : { kind: 'human', who: reporterRef, since },
        chain: `${reporter} to check staging, then the production deploy`,
        stage: 'staging',
        actions: ['revert'],
        ask: 'can you check it on staging?',
      };
    }
    case 'deployed:production':
      return { now: 'The fix is live', next: `${key} closes`, waiting: { kind: 'nothing' }, chain: 'closing', stage: 'production', actions: ['revert'] };
    case 'reverted':
      return {
        now: `The fix was reverted and ${key} is open again`,
        next: `${owner} decides on the next fix`,
        waiting: ownerWait(),
        chain: `${owner} (Fix it or pick it up)`,
        stage: 'reverted',
        actions: ['approve_fix'],
      };
    case 'escalated':
      return {
        now: "The agent couldn't produce a passing fix",
        next: `${owner} takes it from here`,
        waiting: ownerWait(),
        chain: `${owner} (escalated)`,
        stage: 'failed',
        actions: ['approve_fix'],
      };
    case 'closed':
      return { now: 'Closed', next: 'nothing further; ask again here if it comes back', waiting: { kind: 'nothing' }, chain: 'nothing', stage: 'production', actions: [] };
    case 'not-filed':
      return { now: 'Not filed: the thread says it was already fixed', next: 'nothing further; ask again here if it comes back', waiting: { kind: 'nothing' }, chain: 'nothing', actions: [] };
    case 'not-a-bug':
      return { now: 'Marked as not a bug', next: 'nothing further; ask again here if it comes back', waiting: { kind: 'nothing' }, chain: 'nothing', actions: [] };
    case 'linked-to-existing':
      return { now: `Added to ${key}, which was already open`, next: `updates come from ${key}`, waiting: { kind: 'nothing' }, chain: `${key}`, actions: [] };
  }
}

/** The latest gate hold's reason, when it is reporter safe. */
function heldReason(log: readonly IncidentEvent[]): string | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i];
    if (e?.type === 'held' && e.payload.kind === 'gate') {
      const reason = clean(e.payload.reason).replace(/[.\s]+$/, '');
      return reason === '' || reporterViolations(reason).length > 0 ? undefined : reason;
    }
  }
  return undefined;
}

/**
 * When the current status began: replays the log through the lifecycle reducer. Falls back to the
 * row's `updatedAt` when there is no log or the replay disagrees with the row (a correction moved it).
 */
function statusSince(incident: IncidentView, log: readonly IncidentEvent[]): string {
  let status: LifecycleStatus = INITIAL_STATUS;
  let since: string | undefined;
  for (const e of log) {
    const next = nextStatus(status, e);
    if (since === undefined || next !== status) since = e.occurredAt;
    status = next;
  }
  return since !== undefined && status === incident.status ? since : incident.updatedAt;
}

/** The engine's recorded wait wins over the one derived from the status. */
function waitingFrom(column: IncidentWaitingOn | undefined, derived: StatusWaitingOn): StatusWaitingOn {
  if (column === undefined) return derived;
  return column.who === undefined ? { kind: column.kind, since: column.since } : { kind: column.kind, who: column.who, since: column.since };
}

// Answers -----------------------------------------------------------------------------------------

function answerIncident(index: Index, incident: IncidentView, audience: StatusAudience): StatusAnswer {
  const log = index.snapshot.events?.(incident.id) ?? [];
  const since = statusSince(incident, log);
  const s = standing(index, incident, log, since);
  const waitingOn = waitingFrom(incident.waitingOn, s.waiting);
  const base = { incidentId: incident.id, audience, waitingOn, nextStep: s.next };
  switch (audience) {
    case 'reporter':
      return { ...base, text: reporterText(index, incident, log, s, waitingOn, since), actions: [] };
    case 'lead':
      return { ...base, text: leadText(index, incident, s, waitingOn, since), actions: [] };
    case 'engineer':
      return { ...base, text: engineerText(index, incident, log, s, waitingOn, since), actions: s.actions };
  }
}

/** "WEB-1042, blank cart total." with whichever parts are known and reporter safe. */
function heading(incident: IncidentView): string {
  const summary = safeSummary(incident.summary);
  if (incident.jiraKey !== undefined) return summary === undefined ? `${incident.jiraKey}.` : `${incident.jiraKey}, ${summary}.`;
  return summary === undefined ? 'Your report.' : `${capitalize(summary)}.`;
}

function reporterText(index: Index, incident: IncidentView, log: readonly IncidentEvent[], s: Standing, waitingOn: StatusWaitingOn, since: string): string {
  const parts = [heading(incident)];
  const filed = log.find((e) => e.type === 'filed');
  if (filed !== undefined && incident.status !== 'filed') parts.push(`Filed ${clock(index, filed.occurredAt)}.`);
  parts.push(`${s.now} (since ${clock(index, since)}).`);
  parts.push(`Next: ${s.next}.`);
  const onReporter = waitingOn.kind === 'human' && waitingOn.who !== undefined && waitingOn.who === incident.reporterId;
  if (onReporter) parts.push(`Waiting on you: ${s.ask ?? 'an answer to the question in the thread.'}`);
  else if (waitingOn.kind === 'nothing') parts.push('Nothing needed from you right now.');
  else parts.push(`Waiting on ${waitPhrase(waitingOn)}. Nothing needed from you right now.`);
  return parts.join(' ');
}

function leadText(index: Index, incident: IncidentView, s: Standing, waitingOn: StatusWaitingOn, since: string): string {
  const ownerRef = incident.assigneeId ?? incident.ownerRef;
  const facts = [incident.priority === undefined ? undefined : `${clean(incident.priority)} priority`, ownerRef === undefined ? undefined : `owner ${mentionToken(ownerRef)}`]
    .filter((f): f is string => f !== undefined)
    .join(', ');
  const first = facts === '' ? heading(incident) : `${heading(incident)} ${capitalize(facts)}.`;
  const emoji = s.stage === undefined ? '' : `${emojiFor(s.stage)} `;
  const open = isTerminalStatus(incident.status) ? '' : ` Open ${duration(index, incident.openedAt)}.`;
  const second = `${emoji}${s.now} (since ${clock(index, since)}).${open}`;
  return [first, second, `Next: ${s.next}. ${waitSentence(waitingOn)}`].join('\n');
}

function engineerText(index: Index, incident: IncidentView, log: readonly IncidentEvent[], s: Standing, waitingOn: StatusWaitingOn, since: string): string {
  const ownerRef = incident.assigneeId ?? incident.ownerRef;
  const level = incident.autonomyLevel;
  const levelName = level === undefined ? undefined : (index.snapshot.map?.policies.autonomy.levels.find((l) => l.id === level)?.name ?? `level ${String(level)}`);
  const head = [incident.jiraKey ?? 'unfiled', incident.priority, levelName]
    .map((p) => (p === undefined ? undefined : clean(p)))
    .toSpliced(2, 0, ownerRef === undefined ? 'unowned' : mentionToken(ownerRef))
    .filter((p): p is string => p !== undefined)
    .join(' · ');

  const holds: string[] = [];
  for (const c of index.claims.get(incident.id) ?? []) {
    holds.push(`claimed by ${mentionToken(c.claimerId)} until ${clock(index, c.expiresAt, true)}`);
    if (c.holdEnv !== undefined) holds.push(`${clean(c.holdEnv)} held${c.holdExpiresAt === undefined ? '' : ` until ${clock(index, c.holdExpiresAt, true)}`}`);
  }
  if (incident.status === 'held') {
    const gate = [...log].reverse().find((e) => e.type === 'held');
    holds.push(gate?.type === 'held' && gate.payload.kind === 'gate' ? `gate, ${clean(gate.payload.reason)}` : 'gate');
  }
  const watchers = (index.watchers.get(incident.id) ?? []).map(mentionToken);
  const third = `Hold: ${holds.length === 0 ? 'none' : holds.join('; ')}. Watchers: ${watchers.length === 0 ? 'none' : watchers.join(', ')}.`;

  const steps = timeline(index, incident, log, since);
  const wait = waitingOn.kind === 'nothing' ? `next: ${s.chain}` : `waiting on: ${s.chain}`;
  return [head, third, [...steps, wait].join(' → ')].join('\n');
}

/** At most this many timeline steps: the first, then the latest. */
const TIMELINE_STEPS = 8;

function timeline(index: Index, incident: IncidentView, log: readonly IncidentEvent[], since: string): string[] {
  const steps: string[] = [];
  for (const e of log) {
    const at = clock(index, e.occurredAt, true);
    const label = milestone(e);
    if (label !== undefined) steps.push(`${label} ${at}`);
  }
  const running = runningLabel(incident.status);
  if (running !== undefined) steps.push(`${running} 🟡 running (${duration(index, since)})`);
  if (steps.length <= TIMELINE_STEPS) return steps;
  return [steps[0] ?? '', '…', ...steps.slice(steps.length - (TIMELINE_STEPS - 1))];
}

function milestone(e: IncidentEvent): string | undefined {
  switch (e.type) {
    case 'filed':
      return 'filed';
    case 'claimed':
      return `claimed by ${mentionToken(e.payload.claimerId)}`;
    case 'fixer-started':
      return e.payload.attempt > 1 ? 'fixer retry' : 'fixer';
    case 'fixer-failed':
      return 'fixer ❌';
    case 'pr-opened':
      return `PR #${String(e.payload.prNumber)}`;
    case 'review-passed':
      return 'review agent ✅';
    case 'review-failed':
      return `review ❌ (${e.payload.verdict})`;
    case 'ci-green':
      return 'CI ✅';
    case 'ci-red':
      return 'CI ❌';
    case 'held':
      return e.payload.kind === 'gate' ? 'held' : `${clean(e.payload.env)} held`;
    case 'stopped':
      return 'stopped';
    case 'merged':
      return e.payload.levelAtMergeTime === 3 ? 'merged (auto)' : 'merged';
    case 'deployed:staging':
      return 'staging';
    case 'deployed:production':
      return 'production';
    case 'reverted':
      return 'reverted';
    case 'closed':
      return 'closed';
    default:
      return undefined;
  }
}

function runningLabel(status: LifecycleStatus): string | undefined {
  switch (status) {
    case 'fixing':
    case 'fixing-retry':
      return 'fixer';
    case 'in-review':
    case 'in-review-retry':
      return 'review agent';
    case 'ci':
    case 'ci-retry':
      return 'CI';
    default:
      return undefined;
  }
}

function waitPhrase(w: StatusWaitingOn): string {
  switch (w.kind) {
    case 'ci':
      return 'the automated checks';
    case 'review':
      return 'the review';
    case 'human':
      return w.who === undefined ? 'an engineer' : mentionToken(w.who);
    case 'deploy':
      return `a deploy to ${w.who === undefined ? 'staging' : clean(w.who)}`;
    case 'hold':
      return w.who === undefined ? 'a human review' : `a human review by ${mentionToken(w.who)}`;
    case 'nothing':
      return 'nothing';
  }
}

function waitSentence(w: StatusWaitingOn): string {
  return w.kind === 'nothing' ? 'Nothing is holding it up.' : `Waiting on ${waitPhrase(w)}.`;
}

function answerSurface(index: Index, surfaceId: string, audience: StatusAudience): StatusAnswer {
  const label = clean(index.snapshot.map?.surfaces.find((s) => s.id === surfaceId)?.label ?? surfaceId);
  const open = openOn(index, surfaceId);
  if (open.length === 0) {
    return { audience, text: `${label}: nothing open. Next: new reports land here.`, waitingOn: { kind: 'nothing' }, nextStep: 'new reports land here', actions: [] };
  }
  const lines = [`${label}: ${String(open.length)} open, worst first.`];
  let worst: { next: string; waitingOn: StatusWaitingOn } | undefined;
  for (const incident of open) {
    const log = index.snapshot.events?.(incident.id) ?? [];
    const since = statusSince(incident, log);
    const s = standing(index, incident, log, since);
    const waitingOn = waitingFrom(incident.waitingOn, s.waiting);
    worst ??= { next: s.next, waitingOn };
    const emoji = s.stage === undefined ? '' : `${emojiFor(s.stage)} `;
    const name = [incident.jiraKey, incident.priority === undefined ? undefined : clean(incident.priority), safeSummary(incident.summary)]
      .filter((p): p is string => p !== undefined)
      .join(' · ');
    const wait = waitingOn.kind === 'nothing' ? 'nothing holding it up' : `waiting on ${waitPhrase(waitingOn)}`;
    lines.push(`${emoji}${name === '' ? 'Unfiled report' : name}: ${lowerFirst(s.now)}. Next: ${s.next}; ${wait}.`);
  }
  return { audience, text: lines.join('\n'), waitingOn: worst?.waitingOn ?? { kind: 'nothing' }, nextStep: worst?.next ?? 'new reports land here', actions: [] };
}

// Text helpers ------------------------------------------------------------------------------------

/** Free text made safe to interpolate: no angle brackets, so it can never forge a mention token (as in copy.ts). */
function clean(text: string): string {
  return text.replace(/[<>]/g, '').trim();
}

/** The summary when a reporter may see it (20.1: no path, no "PR"), without a trailing period. */
function safeSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const s = clean(summary).replace(/[.\s]+$/, '');
  if (s === '' || reporterViolations(s).length > 0) return undefined;
  return s;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  // Keep a leading mention token, a key, or "I" as written.
  return /^(?!I\b)[A-Z](?=[a-z ])/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** "2:31 PM" today, "Oct 1, 2:31 PM" otherwise; `short` drops AM and PM ("2:31"), as in the engineer timeline. */
function clock(index: Index, iso: string, short = false): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const tz = index.timeZone;
  const day = (d: Date): string => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(at);
  const time = parts
    .filter((p) => !short || (p.type !== 'dayPeriod' && !(p.type === 'literal' && /^\s+$/.test(p.value))))
    .map((p) => p.value)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (day(at) === day(index.snapshot.now)) return time;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(at);
  return `${date}, ${time}`;
}

/** "4 min", "2 h 5 min", "3 d" from `iso` to now. */
function duration(index: Index, iso: string): string {
  const ms = Math.max(0, index.snapshot.now.getTime() - Date.parse(iso));
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${String(min)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${String(h)} h` : `${String(h)} h ${String(min % 60)} min`;
  return `${String(Math.floor(h / 24))} d`;
}
