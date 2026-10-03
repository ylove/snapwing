// Text signals after filing (A 3, #294): four things a message in a filed incident's thread can say,
// beyond the A 1 intents the signal handler (#288) applies.
//
//   resolution     "nvm, works now", "fixed in the deploy that just went out". From the incident's
//                  reporter or an engineer: one confirmation prompt, then the incident closes and the
//                  issue goes to done with resolution `Fixed` (a fix went out, or the incident's PR
//                  merged) or `Cannot Reproduce` (it went away, or it was the reporter's mistake). The
//                  close is a `transition` row with the resolution through the outbox (#193).
//   environment    "this is staging", "happening on prod too": the incident's environment becomes the
//                  one named (`incidentEnvironment`), and a production mention on a staging incident
//                  raises the priority one step (`update-fields` with the Jira priority, plus
//                  `jira-priority-changed` so the incidents row has it at once).
//   scope change   "also the footer is broken", "same thing on the app": proposed as a linked incident
//                  with a card ("Sounds like a second issue on the app. File it separately?" **Yes** /
//                  **It's the same bug**). Yes files it as its own incident through `fileLinked`; the
//                  current incident never takes it in.
//   handoff        "@marcus can you take this?": recorded with a 15 minute window (`HANDOFF_WINDOW`). If
//                  Marcus reacts `claim` (the caller hands that to `acceptHandoff`) or says yes in the
//                  thread within it, he is reassigned (`assign`); otherwise nothing happens.
//
// Only the scope-change card is a message in the thread. The resolution prompt is ephemeral, shown to
// the person who said it and to nobody else (`askResolution`); everything else is state: a
// `text-signal` event per step (the record status answers and replays read), the events that move
// state, and Jira rows through the outbox. A comment on the ticket says why it closed or why its
// priority went up.
//
// Classification (A 1.2 shape): `classifyTextLexicon` is a deterministic phrase pass over short
// messages (under `lexicon.maxWords` words, as the intent lexicon); a message it does not place goes
// to the model (`classifyTextLlm`, prompt `prompts/text-signals.xml`, task `segmentation`, schema
// `text-signal`) when a model is given, and an answer under `lexicon.confidenceFloor` is dropped. A
// handoff needs a mention of someone other than the author (`<@U123>` in Slack text, or
// `TextMessage.mentions` from the adapter); a question is never a resolution, and a negation ("not
// fixed", "still broken") never is either.
//
// Replies come first: a message from the person a resolution prompt asked, or from the person a
// handoff named (within the window), is read as their answer when it is a plain yes or no.
//
// Only incidents with an issue of their own and not yet closed take text signals: before filing, the
// main 5.4 resolution pass and the clarify round own the thread, and a terminal incident has nothing
// to change. Every append passes the incident row's `lastSeq` and decides again on a conflict. A
// factory-free module: compose (#335/#337) wires the ports and calls the four entry points.

import { classifyLexicon } from './classify.ts';
import { parseSignalPrompt, type SignalPrompt } from './llm.ts';
import { botMessagePosted, type PostedMessage } from './messages.ts';
import { resolveTarget } from './target.ts';
import type { Playbook } from '../config/playbook.ts';
import type { EventActor, EventPayloads, EventType, IncidentEvent, NewEvent, TextSignalPayload } from '../contracts/events.ts';
import type { IncidentActor } from '../contracts/incident.ts';
import { isExpectedSeqConflict, type IncidentView, type OutboxItem } from '../contracts/state.ts';
import { isTerminalStatus, isValidTransition } from '../lifecycle/machine.ts';
import type { JiraPriorityName } from '../map/types.ts';
import type { ClassifyRequest, JsonSchema, ModelPort } from '../ports/model.ts';
import type { StatePort } from '../ports/state.ts';
import { jiraCommentBatchKey, jiraFieldBatchKey, JIRA_DONE, type AddCommentRow, type TransitionRow } from '../state/projections/outbox/jira.ts';
import { parseDuration } from '../util/duration.ts';
import { ulid } from '../util/ulid.ts';
import { readFile } from 'node:fs/promises';

/** How long a handoff waits for the named person (A 3: "within 15 minutes"). */
export const HANDOFF_WINDOW = 'PT15M';

export const RESOLUTION_FIXED = 'Fixed';
export const RESOLUTION_CANNOT_REPRODUCE = 'Cannot Reproduce';
export type TextResolution = typeof RESOLUTION_FIXED | typeof RESOLUTION_CANNOT_REPRODUCE;

/** Jira's default priorities, lowest first; raising moves one step right. */
export const PRIORITY_STEPS: readonly JiraPriorityName[] = Object.freeze(['Lowest', 'Low', 'Medium', 'High', 'Highest']);

export const TEXT_SIGNAL_SCHEMA_NAME = 'text-signal';

/** Re-reads per step on `ExpectedSeqConflictError`. */
const MAX_APPEND_ATTEMPTS = 8;

// Contracts ---------------------------------------------------------------------------------------

export type TextSignalKind = TextSignalPayload['kind'];

/** A thread message as the adapter hands it over. */
export interface TextMessage {
  id: string;
  authorId: string;
  text: string;
  timestamp: string;
  /** Chat user ids the message mentions, when the adapter resolved them (Teams). Slack `<@U123>` tokens in `text` are read as well. */
  mentions?: readonly string[];
}

/** What a message says, if it is one of the four (see the file header). */
export type TextSignal =
  | { kind: 'resolution'; fixed: boolean; confidence: number }
  | { kind: 'environment'; env: string; confidence: number }
  | { kind: 'scope-change'; where?: string; confidence: number }
  | { kind: 'handoff'; to: string; confidence: number }
  | { kind: 'none' };

/** The ephemeral confirmation prompt: only `userId` sees it, so it is not a message in the thread. */
export interface ResolutionPrompt {
  userId: string;
  issueKey: string;
  resolution: TextResolution;
  /** The message that said it; `answerResolution` takes it back. */
  messageId: string;
  /** "Close WEB-1042 as Cannot Reproduce?" */
  text: string;
  choices: readonly ResolutionChoice[];
}

export type ResolutionChoice = 'close' | 'keep-open';

export type ScopeChoice = 'yes' | 'same-bug';

/** The one message A 3 posts: "Sounds like a second issue on mobile. File it separately?" */
export interface ScopeChangeCard {
  kind: 'scope-change';
  text: string;
  where?: string;
  /** The message that described the second issue; a tap carries it back to `answerScopeChange`. */
  messageId: string;
  choices: readonly { id: ScopeChoice; label: string }[];
}

export const SCOPE_CHOICES: ScopeChangeCard['choices'] = Object.freeze([
  { id: 'yes', label: 'Yes' },
  { id: 'same-bug', label: "It's the same bug" },
]);

/** The second issue, to capture as its own incident linked to the first. */
export interface LinkedIncidentRequest {
  parentIncidentId: string;
  parentIssueKey?: string;
  platform: 'slack' | 'teams';
  channel: string;
  /** The message that described it: the new incident's anchor. */
  messageId: string;
  text: string;
  where?: string;
  /** The message's author, the new incident's reporter. */
  reporter: EventActor;
}

/** The calls out of the pipeline; compose wires them (chat adapter, engine capture, Jira). */
export interface TextSignalPorts {
  /** Shows the confirmation prompt to `prompt.userId` only (an ephemeral message). */
  askResolution(incidentId: string, prompt: ResolutionPrompt): Promise<void>;
  /** Posts the card in the incident's thread; the posted message is recorded as `bot-message-posted`. */
  postScopeCard(incidentId: string, card: ScopeChangeCard): Promise<PostedMessage | undefined>;
  /** Captures the second issue as a new incident linked to the parent. Resolves to its id when known. */
  fileLinked(request: LinkedIncidentRequest): Promise<{ incidentId: string } | undefined>;
  /** Assigns the person on the ticket. Jira has no assignee row in the outbox yet (as `fixer/claims.ts`). */
  assign(incidentId: string, userId: string): Promise<void>;
}

export interface TextSignalDeps {
  workspaceId: string;
  state: StatePort;
  /** The loaded playbook, or a getter for the current one (hot reload). */
  playbook: Playbook | (() => Playbook | Promise<Playbook>);
  /** The LLM pass; absent means the lexicon pass only. */
  model?: ModelPort;
  ports: TextSignalPorts;
  /**
   * The environment an incident started on when the thread has not named one (a screenshot's
   * `environmentHint`, an alert's environment). Absent: unknown until someone says.
   */
  environmentHint?: (incident: IncidentView) => Promise<string | undefined>;
  clock: () => Date;
}

/** A message in an incident's thread. */
export interface TextSignalInput {
  platform: 'slack' | 'teams';
  /** The channel and the thread's root message (the incident's anchor). */
  thread: { channel: string; rootId: string };
  message: TextMessage;
  /** The author, with their map role. */
  actor: IncidentActor;
  /** Earlier thread messages, oldest first, as context for the LLM pass. */
  context?: readonly TextMessage[];
}

export type TextEffect =
  | 'environment'
  | 'priority-raised'
  | 'resolution-asked'
  | 'closed'
  | 'resolution-declined'
  | 'scope-proposed'
  | 'scope-split'
  | 'scope-same'
  | 'handoff-asked'
  | 'reassigned';

export type TextSkipReason =
  | 'no-target'
  | 'not-filed'
  | 'closed'
  | 'no-signal'
  | 'not-allowed'
  | 'unchanged'
  | 'already-asked'
  | 'already-proposed'
  | 'not-pending'
  | 'already-decided'
  | 'expired'
  | 'no-card';

export type TextSignalOutcome =
  | { handled: false; reason: TextSkipReason }
  | { handled: true; incidentId: string; kind: TextSignalKind; effect: TextEffect; appended: EventType[] };

// Entry points ------------------------------------------------------------------------------------

/** Reads one thread message (see the file header). */
export async function handleTextSignal(deps: TextSignalDeps, input: TextSignalInput): Promise<TextSignalOutcome> {
  const target = await resolveTarget(deps.state, { platform: input.platform, channel: input.thread.channel, messageId: input.thread.rootId });
  if (target === null) return skip('no-target');
  const incident = await deps.state.getIncident(target.incidentId);
  const open = openReason(incident);
  if (open !== undefined || incident === null) return skip(open ?? 'no-target');
  const playbook = await playbookOf(deps);
  const { message, actor } = input;

  // Replies to a pending prompt or handoff, when they are a plain yes or no.
  const log = await deps.state.read(incident.id);
  const reply = replyOf(playbook, message.text);
  if (reply !== undefined) {
    const asked = pendingResolution(log);
    if (asked !== undefined && asked.actor?.id === actor.id) {
      return decideResolution(deps, incident.id, asked.payload.messageId, actor, reply === 'yes' ? 'close' : 'keep-open', message.timestamp);
    }
    if (reply === 'yes' && pendingHandoff(log, actor.id, message.timestamp) !== undefined) {
      return acceptHandoff(deps, { incidentId: incident.id, actor, at: message.timestamp, via: 'message' });
    }
  }

  const signal = await classifyText(playbook, message, input.context ?? [], deps.model);
  switch (signal.kind) {
    case 'none':
      return skip('no-signal');
    case 'resolution':
      return askResolution(deps, incident.id, input, signal);
    case 'environment':
      return applyEnvironment(deps, incident.id, input, signal);
    case 'scope-change':
      return proposeScopeChange(deps, incident.id, input, signal);
    case 'handoff':
      return recordHandoff(deps, incident.id, input, signal);
  }
}

/** The answer to the resolution prompt (`ResolutionPrompt.messageId` names the prompt answered). */
export async function answerResolution(
  deps: TextSignalDeps,
  answer: { incidentId: string; messageId: string; actor: IncidentActor; choice: ResolutionChoice; at: string },
): Promise<TextSignalOutcome> {
  return decideResolution(deps, answer.incidentId, answer.messageId, answer.actor, answer.choice, answer.at);
}

/**
 * A tap on the scope-change card. From the author of the message, the incident's reporter, or an
 * engineer; the first answer decides. `yes` files the second issue through `fileLinked`.
 */
export async function answerScopeChange(
  deps: TextSignalDeps,
  answer: { incidentId: string; messageId: string; actor: IncidentActor; choice: ScopeChoice; at: string },
): Promise<TextSignalOutcome> {
  const incident = await deps.state.getIncident(answer.incidentId);
  if (incident === null) return skip('no-target');
  const proposal = scopeProposal(await deps.state.read(incident.id), answer.messageId);
  if (proposal === undefined) return skip('not-pending');
  if (proposal.decided) return skip('already-decided');
  const author = proposal.event.actor;
  const allowed = answer.actor.role === 'engineer' || answer.actor.id === incident.reporterId || answer.actor.id === author?.id;
  if (!allowed) return skip('not-allowed');

  let linkedIncidentId: string | undefined;
  if (answer.choice === 'yes') {
    const p = proposal.event.payload;
    const filed = await deps.ports.fileLinked({
      parentIncidentId: incident.id,
      ...(incident.jiraKey === undefined ? {} : { parentIssueKey: incident.jiraKey }),
      platform: incident.source === 'teams' ? 'teams' : 'slack',
      channel: incident.channelId ?? '',
      messageId: p.messageId,
      text: p.text ?? '',
      ...(p.where === undefined ? {} : { where: p.where }),
      reporter: author ?? { id: answer.actor.id, role: answer.actor.role },
    });
    linkedIncidentId = filed?.incidentId;
  }
  const phase = answer.choice === 'yes' ? 'split' : 'same';
  return commit(deps, incident.id, 'scope-change', answer.choice === 'yes' ? 'scope-split' : 'scope-same', (row, log) => {
    const again = scopeProposal(log, answer.messageId);
    if (again === undefined || again.decided) return skip('already-decided');
    return {
      events: [
        textEvent(deps, row.id, answer.actor, answer.at, sourceOf(row), {
          kind: 'scope-change',
          messageId: answer.messageId,
          phase,
          ...(linkedIncidentId === undefined ? {} : { linkedIncidentId }),
        }),
      ],
    };
  });
}

/**
 * The named person took the handoff: a `claim` reaction anywhere on the incident (the caller passes
 * it after the signal handler applied it) or a yes in the thread. Reassigns when a handoff to them
 * is pending and `at` is inside its window; otherwise nothing.
 */
export async function acceptHandoff(
  deps: TextSignalDeps,
  input: { incidentId: string; actor: IncidentActor; at: string; via: 'reaction' | 'message' },
): Promise<TextSignalOutcome> {
  const incident = await deps.state.getIncident(input.incidentId);
  const open = openReason(incident);
  if (open !== undefined || incident === null) return skip(open ?? 'no-target');
  const log = await deps.state.read(incident.id);
  const asked = latestHandoffTo(log, input.actor.id);
  if (asked === undefined) return skip('not-pending');
  if (Date.parse(input.at) > Date.parse(asked.payload.expiresAt ?? '')) return skip('expired');

  await deps.ports.assign(incident.id, input.actor.id);
  return commit(deps, incident.id, 'handoff', 'reassigned', (row, fresh) => {
    const again = latestHandoffTo(fresh, input.actor.id);
    if (again === undefined) return skip('not-pending');
    return {
      events: [
        textEvent(deps, row.id, input.actor, input.at, sourceOf(row), {
          kind: 'handoff',
          messageId: again.payload.messageId,
          phase: 'accepted',
          to: input.actor.id,
          via: input.via,
        }),
      ],
    };
  });
}

// Resolution --------------------------------------------------------------------------------------

async function askResolution(deps: TextSignalDeps, incidentId: string, input: TextSignalInput, signal: Extract<TextSignal, { kind: 'resolution' }>): Promise<TextSignalOutcome> {
  const { actor, message } = input;
  let prompt: ResolutionPrompt | undefined;
  const outcome = await commit(deps, incidentId, 'resolution', 'resolution-asked', (row, log) => {
    if (actor.role !== 'engineer' && actor.id !== row.reporterId) return skip('not-allowed');
    if (pendingResolution(log) !== undefined) return skip('already-asked');
    const resolution = signal.fixed || MERGED.has(row.status) ? RESOLUTION_FIXED : RESOLUTION_CANNOT_REPRODUCE;
    const issueKey = row.jiraKey ?? '';
    prompt = { userId: actor.id, issueKey, resolution, messageId: message.id, text: `Close ${issueKey} as ${resolution}?`, choices: ['close', 'keep-open'] };
    return {
      events: [
        textEvent(deps, row.id, actor, message.timestamp, input.platform, {
          kind: 'resolution',
          messageId: message.id,
          phase: 'asked',
          text: message.text,
          confidence: signal.confidence,
          resolution,
        }),
      ],
    };
  });
  if (outcome.handled && prompt !== undefined) await deps.ports.askResolution(incidentId, prompt);
  return outcome;
}

async function decideResolution(deps: TextSignalDeps, incidentId: string, messageId: string, actor: IncidentActor, choice: ResolutionChoice, at: string): Promise<TextSignalOutcome> {
  const effect: TextEffect = choice === 'close' ? 'closed' : 'resolution-declined';
  return commit(deps, incidentId, 'resolution', effect, (row, log) => {
    if (openReason(row) !== undefined) return skip('closed');
    const asked = pendingResolution(log);
    if (asked === undefined || asked.payload.messageId !== messageId) return skip('not-pending');
    if (asked.actor?.id !== actor.id) return skip('not-allowed');
    const resolution: TextResolution = MERGED.has(row.status) ? RESOLUTION_FIXED : asked.payload.resolution === RESOLUTION_FIXED ? RESOLUTION_FIXED : RESOLUTION_CANNOT_REPRODUCE;
    const record = textEvent(deps, row.id, actor, at, sourceOf(row), { kind: 'resolution', messageId, phase: choice === 'close' ? 'confirmed' : 'declined', resolution });
    if (choice === 'keep-open') return { events: [record] };
    if (!fits(row, 'closed')) return skip('closed');
    const said = clause(asked.payload.text ?? '');
    const closed = event(deps, row.id, 'closed', { reason: `${resolution}: ${personLabel(actor)} said it is resolved${said === '' ? '' : `: "${said}"`}` }, at, sourceOf(row), actorOf(actor));
    const issueKey = row.jiraKey ?? '';
    return {
      events: [record, closed],
      // The `closed` event's own transition carries no resolution: drop it and send this one (#193).
      after: async (tx) => {
        await tx.dropOutbox('jira', jiraFieldBatchKey(row.id, 'status'));
        const close: TransitionRow = { issueKey, to: JIRA_DONE, resolution };
        await tx.enqueueOutbox(jiraRow(deps, row.id, 'transition', { ...close }, jiraFieldBatchKey(row.id, 'status')));
        const note: AddCommentRow = { issueKey, text: `Closed as ${resolution}. ${personLabel(actor)} confirmed it in the thread${said === '' ? '' : `: "${said}"`}.` };
        await tx.enqueueOutbox(jiraRow(deps, row.id, 'add-comment', { ...note }, jiraCommentBatchKey(row.id)));
      },
    };
  });
}

/** The asked step no `confirmed` or `declined` answered yet, if any. */
export function pendingResolution(log: readonly IncidentEvent[]): IncidentEvent<'text-signal'> | undefined {
  let asked: IncidentEvent<'text-signal'> | undefined;
  for (const e of textSignals(log, 'resolution')) {
    if (e.payload.phase === 'asked') asked = e;
    else if (asked !== undefined && e.payload.messageId === asked.payload.messageId) asked = undefined;
  }
  return asked;
}

const MERGED: ReadonlySet<string> = new Set(['merged', 'deployed:staging', 'deployed:production']);

// Environment -------------------------------------------------------------------------------------

async function applyEnvironment(deps: TextSignalDeps, incidentId: string, input: TextSignalInput, signal: Extract<TextSignal, { kind: 'environment' }>): Promise<TextSignalOutcome> {
  const { actor, message } = input;
  const hint = deps.environmentHint;
  let raised = false;
  const outcome = await commit(deps, incidentId, 'environment', 'environment', async (row, log) => {
    const from = incidentEnvironment(log) ?? (hint === undefined ? undefined : normalizeEnvironment((await hint(row)) ?? ''));
    if (from === signal.env) return skip('unchanged');
    const to = from === 'staging' && signal.env === 'production' ? raisePriority(row.priority) : undefined;
    raised = to !== undefined;
    const priority = to === undefined || row.priority === undefined ? undefined : { from: row.priority, to };
    const record = textEvent(deps, row.id, actor, message.timestamp, input.platform, {
      kind: 'environment',
      messageId: message.id,
      text: message.text,
      confidence: signal.confidence,
      env: signal.env,
      ...(from === undefined ? {} : { from }),
      ...(priority === undefined ? {} : { priority }),
    });
    if (priority === undefined || row.jiraKey === undefined) return { events: [record] };
    const issueKey = row.jiraKey;
    const changed = event(deps, row.id, 'jira-priority-changed', { jiraKey: issueKey, from: priority.from, to: priority.to }, message.timestamp, 'agent');
    return {
      events: [record, changed],
      after: async (tx) => {
        await tx.enqueueOutbox(jiraRow(deps, row.id, 'update-fields', { issueKey, fields: { priority: { name: priority.to } } }, jiraFieldBatchKey(row.id, 'priority')));
        const note: AddCommentRow = { issueKey, text: `Priority raised from ${priority.from} to ${priority.to}: ${personLabel(actor)} says it happens on production too: "${clause(message.text)}".` };
        await tx.enqueueOutbox(jiraRow(deps, row.id, 'add-comment', { ...note }, jiraCommentBatchKey(row.id)));
      },
    };
  });
  return outcome.handled && raised ? { ...outcome, effect: 'priority-raised' } : outcome;
}

/** The environment the thread last named for the incident, if any. */
export function incidentEnvironment(log: readonly IncidentEvent[]): string | undefined {
  let env: string | undefined;
  for (const e of textSignals(log, 'environment')) env = e.payload.env ?? env;
  return env;
}

/** One step up `PRIORITY_STEPS`; undefined when the priority is unknown or already the highest. */
export function raisePriority(priority: string | undefined): JiraPriorityName | undefined {
  const at = PRIORITY_STEPS.findIndex((p) => p.toLowerCase() === priority?.trim().toLowerCase());
  return at < 0 ? undefined : PRIORITY_STEPS[at + 1];
}

/** `prod` and `production` are `production`; `staging`, `stage`, `stg`, `preprod` are `staging`; local and dev words are `development`; anything else as said, lowercased. */
export function normalizeEnvironment(word: string): string | undefined {
  const w = word.trim().toLowerCase();
  if (w === '' || w === 'unknown') return undefined;
  if (/^(prod|production|live)$/.test(w)) return 'production';
  if (/^(staging|stage|stg|pre-?prod)$/.test(w)) return 'staging';
  if (/^(local|localhost|locally|dev|development)$/.test(w)) return 'development';
  return w;
}

// Scope change ------------------------------------------------------------------------------------

async function proposeScopeChange(deps: TextSignalDeps, incidentId: string, input: TextSignalInput, signal: Extract<TextSignal, { kind: 'scope-change' }>): Promise<TextSignalOutcome> {
  const { actor, message } = input;
  if (scopeProposal(await deps.state.read(incidentId), message.id) !== undefined) return skip('already-proposed');
  const card: ScopeChangeCard = {
    kind: 'scope-change',
    text: `Sounds like a second issue${signal.where === undefined ? '' : ` on ${signal.where}`}. File it separately?`,
    ...(signal.where === undefined ? {} : { where: signal.where }),
    messageId: message.id,
    choices: SCOPE_CHOICES,
  };
  const posted = await deps.ports.postScopeCard(incidentId, card);
  if (posted === undefined) return skip('no-card');
  return commit(deps, incidentId, 'scope-change', 'scope-proposed', (row, log) => {
    if (scopeProposal(log, message.id) !== undefined) return skip('already-proposed');
    return {
      events: [
        textEvent(deps, row.id, actor, message.timestamp, input.platform, {
          kind: 'scope-change',
          messageId: message.id,
          phase: 'proposed',
          text: message.text,
          confidence: signal.confidence,
          ...(signal.where === undefined ? {} : { where: signal.where }),
          cardMessageId: posted.messageId,
        }),
        botMessagePosted(deps.workspaceId, row.id, posted, deps.clock().toISOString()),
      ],
    };
  });
}

/** The proposal for the message `messageId`, and whether a tap decided it. */
export function scopeProposal(log: readonly IncidentEvent[], messageId: string): { event: IncidentEvent<'text-signal'>; decided: boolean } | undefined {
  let found: { event: IncidentEvent<'text-signal'>; decided: boolean } | undefined;
  for (const e of textSignals(log, 'scope-change')) {
    if (e.payload.messageId !== messageId) continue;
    if (e.payload.phase === 'proposed') found ??= { event: e, decided: false };
    else if (found !== undefined) found.decided = true;
  }
  return found;
}

// Handoff -----------------------------------------------------------------------------------------

async function recordHandoff(deps: TextSignalDeps, incidentId: string, input: TextSignalInput, signal: Extract<TextSignal, { kind: 'handoff' }>): Promise<TextSignalOutcome> {
  const { actor, message } = input;
  const expiresAt = new Date(Date.parse(message.timestamp) + parseDuration(HANDOFF_WINDOW)).toISOString();
  return commit(deps, incidentId, 'handoff', 'handoff-asked', (row) => ({
    events: [
      textEvent(deps, row.id, actor, message.timestamp, input.platform, {
        kind: 'handoff',
        messageId: message.id,
        phase: 'asked',
        text: message.text,
        confidence: signal.confidence,
        to: signal.to,
        expiresAt,
      }),
    ],
  }));
}

/** The latest handoff that named `userId` and that they have not taken yet. */
function latestHandoffTo(log: readonly IncidentEvent[], userId: string): IncidentEvent<'text-signal'> | undefined {
  let asked: IncidentEvent<'text-signal'> | undefined;
  for (const e of textSignals(log, 'handoff')) {
    if (e.payload.phase === 'asked') asked = e.payload.to === userId ? e : undefined;
    else if (e.payload.phase === 'accepted' && asked !== undefined && e.payload.messageId === asked.payload.messageId) asked = undefined;
  }
  return asked;
}

/** The handoff to `userId` still open at `at`, if any. */
export function pendingHandoff(log: readonly IncidentEvent[], userId: string, at: string): IncidentEvent<'text-signal'> | undefined {
  const asked = latestHandoffTo(log, userId);
  return asked !== undefined && Date.parse(at) <= Date.parse(asked.payload.expiresAt ?? '') ? asked : undefined;
}

// Classification ----------------------------------------------------------------------------------

/** The lexicon pass, then the LLM pass for a message it does not place (when a model is given). */
export async function classifyText(playbook: Pick<Playbook, 'signals'>, message: TextMessage, thread: readonly TextMessage[], model?: ModelPort): Promise<TextSignal> {
  const lexical = classifyTextLexicon(playbook, message);
  if (lexical.kind !== 'none' || model === undefined) return lexical;
  return classifyTextLlm(playbook, message, thread, model);
}

/** Words, lowercased, apostrophes dropped, no stemming ("fixed" must not match "fix it"). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function has(tokens: readonly string[], phrases: readonly (readonly string[])[]): boolean {
  return phrases.some((p) => {
    for (let i = 0; i + p.length <= tokens.length; i++) if (p.every((w, j) => tokens[i + j] === w)) return true;
    return false;
  });
}

const phrases = (...list: string[]): string[][] => list.map(words);

const NEGATION = phrases('not fixed', 'isnt fixed', 'not resolved', 'still', 'not working', 'doesnt work', 'didnt fix', 'didnt work', 'but not', 'broken', 'again');
const FIXED = phrases('fixed', 'fix went out', 'fix is out', 'fix is live', 'fix is deployed', 'fix shipped', 'shipped a fix', 'shipped the fix', 'hotfix', 'hotfixed', 'patched');
const GONE = phrases(
  'nvm', 'never mind', 'nevermind', 'works now', 'working now', 'works fine now', 'it works', 'that was me', 'my bad', 'my mistake',
  'wrong account', 'user error', 'false alarm', 'cant reproduce', 'cannot reproduce', 'can not reproduce', 'not reproducible',
  'all good now', 'went away', 'fine now', 'resolved itself', 'no longer happening', 'not happening anymore',
);
const HANDOFF = phrases(
  'can you take', 'could you take', 'can you look', 'could you look', 'can you grab', 'take this', 'take a look', 'over to you',
  'all yours', 'can you own', 'can you pick', 'pick this up', 'handing this', 'handing it', 'hand this', 'can you handle', 'assigning to',
);
const SCOPE = phrases(
  'also the', 'also broken', 'also happening', 'also seeing', 'another bug', 'another issue', 'another problem', 'separate issue',
  'separate bug', 'different issue', 'different bug', 'second issue', 'unrelated but', 'same thing on', 'same thing in', 'same issue on',
  'same issue in', 'same problem on', 'same problem in', 'same bug on', 'same bug in', 'same error on', 'same error in',
);
const YES = phrases(
  'yes', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'on it', 'will do', 'got it', 'ill take it', 'i can take it', 'taking it', 'mine',
  'confirmed', 'confirm', 'correct', 'close it', 'absolutely', 'sounds good',
);
const NO = phrases('no', 'nope', 'nah', 'not yet', 'keep it open', 'dont close', 'still', 'not fixed', 'wait');

const ENVIRONMENTS: readonly { env: string; re: RegExp }[] = [
  { env: 'production', re: /\b(prod|production)\b/i },
  { env: 'staging', re: /\b(staging|stg|pre-?prod)\b/i },
  { env: 'development', re: /\b(localhost|locally|on local|on dev|in dev|dev environment)\b/i },
];

/** Chat user ids the message mentions other than its author: `TextMessage.mentions` and Slack `<@U123>` tokens. */
export function mentionsOf(message: TextMessage): string[] {
  const ids = [...(message.mentions ?? [])];
  for (const m of message.text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) if (m[1] !== undefined) ids.push(m[1]);
  return [...new Set(ids)].filter((id) => id !== message.authorId);
}

/** The deterministic pass (see the file header). */
export function classifyTextLexicon(playbook: Pick<Playbook, 'signals'>, message: TextMessage): TextSignal {
  const text = message.text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' @mention ');
  const tokens = words(text);
  if (tokens.length === 0 || tokens.length >= playbook.signals.lexicon.maxWords) return { kind: 'none' };
  const question = /\?\s*$/.test(text);

  if (!question && !has(tokens, NEGATION)) {
    const fixed = has(tokens, FIXED);
    if (fixed || has(tokens, GONE)) return { kind: 'resolution', fixed, confidence: 1 };
  }
  const to = mentionsOf(message)[0];
  if (to !== undefined && has(tokens, HANDOFF)) return { kind: 'handoff', to, confidence: 1 };
  const env = ENVIRONMENTS.find((e) => e.re.test(text))?.env;
  if (env !== undefined) return { kind: 'environment', env, confidence: 1 };
  if (has(tokens, SCOPE)) {
    const where = whereOf(text);
    return { kind: 'scope-change', ...(where === undefined ? {} : { where }), confidence: 1 };
  }
  return { kind: 'none' };
}

/** "same thing on the app" is `the app`; at most four words. */
function whereOf(text: string): string | undefined {
  const m = /\b(?:same (?:thing|issue|problem|bug|error)|also (?:happening|broken|seeing it))\s+(?:on|in)\s+([^.,!?;]+)/i.exec(text);
  const where = m?.[1]?.trim().split(/\s+/).filter((w) => !/^(too|also|as well)$/i.test(w)).slice(0, 4).join(' ');
  return where === undefined || where === '' ? undefined : where.toLowerCase();
}

/** A plain yes or no, by the reply phrases plus the playbook's claim, accept, and reject phrases. */
function replyOf(playbook: Pick<Playbook, 'signals'>, text: string): 'yes' | 'no' | undefined {
  const tokens = words(text);
  if (tokens.length === 0 || tokens.length >= playbook.signals.lexicon.maxWords) return undefined;
  const intent = classifyLexicon(playbook.signals, text).intent;
  if (has(tokens, NO) || intent === 'reject') return 'no';
  if (has(tokens, YES) || intent === 'claim' || intent === 'accept') return 'yes';
  return undefined;
}

// The LLM pass --------------------------------------------------------------------------------------

const KINDS = ['resolution', 'environment', 'scope-change', 'handoff', 'none'] as const;

export interface TextSignalAnswer {
  kind: (typeof KINDS)[number];
  confidence: number;
  fixed?: boolean;
  environment?: string;
  where?: string;
}

export const TEXT_SIGNAL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    confidence: { type: 'number' },
    fixed: { type: 'boolean' },
    environment: { type: 'string' },
    where: { type: 'string' },
  },
  required: ['kind', 'confidence'],
  additionalProperties: false,
};

export function isTextSignalAnswer(v: unknown): v is TextSignalAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['kind'] === 'string' &&
    (KINDS as readonly string[]).includes(o['kind']) &&
    typeof o['confidence'] === 'number' &&
    Number.isFinite(o['confidence']) &&
    (o['fixed'] === undefined || typeof o['fixed'] === 'boolean') &&
    (o['environment'] === undefined || typeof o['environment'] === 'string') &&
    (o['where'] === undefined || typeof o['where'] === 'string')
  );
}

const PROMPT_URL = new URL('../prompts/text-signals.xml', import.meta.url);
let promptCache: Promise<SignalPrompt> | undefined;

export function loadTextSignalPrompt(): Promise<SignalPrompt> {
  promptCache ??= readFile(PROMPT_URL, 'utf8').then(parseSignalPrompt);
  return promptCache;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function messageXml(m: TextMessage): string {
  return `      <message id="${xml(m.id)}" author="${xml(m.authorId)}" time="${xml(m.timestamp)}"><text>${xml(m.text)}</text></message>`;
}

/** The classify request for one message. Exported so tests can see exactly what the model is sent. */
export function buildTextSignalRequest(message: TextMessage, thread: readonly TextMessage[], prompt: SignalPrompt): ClassifyRequest<TextSignalAnswer> {
  return {
    task: 'segmentation',
    system: prompt.system,
    prompt: prompt.request.replaceAll('{{thread}}', thread.map(messageXml).join('\n')).replaceAll('{{message}}', messageXml(message)),
    schemaName: TEXT_SIGNAL_SCHEMA_NAME,
    schema: TEXT_SIGNAL_SCHEMA,
    validate: isTextSignalAnswer,
    temperature: 0,
  };
}

/** The model's reading, under the playbook's confidence floor dropped; a handoff with no mention is `none`. */
export async function classifyTextLlm(playbook: Pick<Playbook, 'signals'>, message: TextMessage, thread: readonly TextMessage[], model: ModelPort): Promise<TextSignal> {
  const { value } = await model.classify(buildTextSignalRequest(message, thread, await loadTextSignalPrompt()));
  const confidence = value.confidence;
  if (value.kind === 'none' || !(confidence >= playbook.signals.lexicon.confidenceFloor) || confidence > 1) return { kind: 'none' };
  switch (value.kind) {
    case 'resolution':
      return { kind: 'resolution', fixed: value.fixed === true, confidence };
    case 'environment': {
      const env = normalizeEnvironment(value.environment ?? '');
      return env === undefined ? { kind: 'none' } : { kind: 'environment', env, confidence };
    }
    case 'scope-change': {
      const where = value.where?.trim();
      return { kind: 'scope-change', ...(where === undefined || where === '' ? {} : { where }), confidence };
    }
    case 'handoff': {
      const to = mentionsOf(message)[0];
      return to === undefined ? { kind: 'none' } : { kind: 'handoff', to, confidence };
    }
  }
}

// Appending ---------------------------------------------------------------------------------------

interface Plan {
  events: NewEvent[];
  /** Runs in the append's transaction, after the append (outbox rows). */
  after?: (tx: StatePort) => Promise<void>;
}

type Skip = { handled: false; reason: TextSkipReason };

function skip(reason: TextSkipReason): Skip {
  return { handled: false, reason };
}

/** Plans on the incident row and log, appends at the row's `lastSeq`, and plans again on a conflict. */
async function commit(
  deps: TextSignalDeps,
  incidentId: string,
  kind: TextSignalKind,
  effect: TextEffect,
  plan: (incident: IncidentView, log: readonly IncidentEvent[]) => Plan | Skip | Promise<Plan | Skip>,
): Promise<TextSignalOutcome> {
  for (let attempt = 1; ; attempt++) {
    const incident = await deps.state.getIncident(incidentId);
    const open = openReason(incident);
    if (open !== undefined || incident === null) return skip(open ?? 'no-target');
    const decided = await plan(incident, await deps.state.read(incidentId));
    if ('handled' in decided) return decided;
    try {
      await deps.state.transaction(async (tx) => {
        await tx.append(incidentId, decided.events, incident.lastSeq);
        await decided.after?.(tx);
      });
      return { handled: true, incidentId, kind, effect, appended: decided.events.map((e) => e.type) };
    } catch (err) {
      if (!isExpectedSeqConflict(err) || attempt >= MAX_APPEND_ATTEMPTS) throw err;
    }
  }
}

/** Why the incident takes no text signal, or undefined when it does: it has its own issue and is open. */
function openReason(incident: IncidentView | null): TextSkipReason | undefined {
  if (incident === null) return 'no-target';
  if (isTerminalStatus(incident.status)) return 'closed';
  if (incident.jiraKey === undefined) return 'not-filed';
  return undefined;
}

function textSignals(log: readonly IncidentEvent[], kind: TextSignalKind): IncidentEvent<'text-signal'>[] {
  return log.filter((e): e is IncidentEvent<'text-signal'> => e.type === 'text-signal' && e.payload.kind === kind);
}

function event<T extends EventType>(deps: TextSignalDeps, incidentId: string, type: T, payload: EventPayloads[T], at: string, source: NewEvent['source'], actor?: EventActor): NewEvent {
  return { workspaceId: deps.workspaceId, incidentId, type, v: 1, source, ...(actor === undefined ? {} : { actor }), occurredAt: at, payload } as unknown as NewEvent;
}

function textEvent(deps: TextSignalDeps, incidentId: string, actor: IncidentActor, at: string, source: NewEvent['source'], payload: TextSignalPayload): NewEvent {
  return event(deps, incidentId, 'text-signal', payload, at, source, actorOf(actor));
}

function jiraRow(deps: TextSignalDeps, incidentId: string, op: string, payload: Record<string, unknown>, batchKey: string): OutboxItem {
  const now = deps.clock();
  return {
    id: ulid(now.getTime()),
    workspaceId: deps.workspaceId,
    target: 'jira',
    incidentId,
    op,
    payload,
    batchKey,
    attempts: 0,
    nextAttempt: now.toISOString(),
    createdAt: now.toISOString(),
  };
}

/** True when the lifecycle accepts an event of `type` in the incident's status. */
function fits(incident: IncidentView, type: EventType): boolean {
  return isValidTransition(incident.status, { type, payload: {} } as unknown as IncidentEvent);
}

function sourceOf(incident: IncidentView): NewEvent['source'] {
  return incident.source === 'teams' ? 'teams' : 'slack';
}

function actorOf(actor: IncidentActor): EventActor {
  const name = actor.name.trim();
  return { id: actor.id, role: actor.role, ...(name === '' ? {} : { name }) };
}

function personLabel(actor: IncidentActor): string {
  const name = actor.name.trim();
  return `@${name === '' ? actor.id : name}`;
}

/** One line, trimmed, at most 200 characters. */
function clause(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

async function playbookOf(deps: TextSignalDeps): Promise<Playbook> {
  return typeof deps.playbook === 'function' ? deps.playbook() : deps.playbook;
}
