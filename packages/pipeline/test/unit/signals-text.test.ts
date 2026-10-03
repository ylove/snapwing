// Text signals after filing (#294, A 3): resolution with one confirmation, environment mentions and the
// production priority raise, scope changes as a linked incident behind a card, and handoffs that
// reassign only when the named person takes it within 15 minutes. Runs on the dialect `SNAPWING_DB`
// selects (CI runs both); the ports are recording fakes and the model is a fake ModelPort.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPlaybook } from '../../src/config/playbook.ts';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { IncidentActor } from '../../src/contracts/incident.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { JiraPriorityName } from '../../src/map/types.ts';
import type { ClassifyRequest, ModelPort } from '../../src/ports/model.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import {
  acceptHandoff,
  answerResolution,
  answerScopeChange,
  classifyText,
  classifyTextLexicon,
  classifyTextLlm,
  handleTextSignal,
  HANDOFF_WINDOW,
  incidentEnvironment,
  normalizeEnvironment,
  raisePriority,
  RESOLUTION_CANNOT_REPRODUCE,
  RESOLUTION_FIXED,
  TEXT_SIGNAL_SCHEMA_NAME,
  type LinkedIncidentRequest,
  type ResolutionPrompt,
  type ScopeChangeCard,
  type TextMessage,
  type TextSignalAnswer,
  type TextSignalDeps,
  type TextSignalOutcome,
} from '../../src/signals/text.ts';
import { jiraCommentBatchKey, jiraFieldBatchKey } from '../../src/state/projections/outbox/jira.ts';
import { UPDATE_STATUS_OP } from '../../src/state/projections/outbox/status.ts';
import { parseDuration } from '../../src/util/duration.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6TEXTSIGINC00000000000A';
const CHANNEL = 'C0FAKEBUGS';
const ANCHOR = '1730000000.000100';
const CARD = '1730000000.000700';
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const MINUTE = 60_000;

const DANA: IncidentActor = { id: 'U0FAKEDANA', name: 'Dana', role: 'engineer' };
const MARCUS: IncidentActor = { id: 'U0FAKEMARCUS', name: 'Marcus', role: 'engineer' };
const PAT: IncidentActor = { id: 'U0FAKEPAT', name: 'Pat', role: 'reporter' };
const SAM: IncidentActor = { id: 'U0FAKESAM', name: 'Sam', role: 'reporter' };
const KIM: IncidentActor = { id: 'U0FAKEKIM', name: 'Kim', role: 'unknown' };

const PLAYBOOK = defaultPlaybook();

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let seq = 0;

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  seq = 0;
  state = await tdb.open({ now: () => new Date(now) });
});

afterEach(async () => {
  await tdb.drop();
});

// Fakes -------------------------------------------------------------------------------------------

interface World {
  deps: TextSignalDeps;
  asks: { incidentId: string; prompt: ResolutionPrompt }[];
  cards: { incidentId: string; card: ScopeChangeCard }[];
  linked: LinkedIncidentRequest[];
  assigns: [string, string][];
}

function world(opts: { environmentHint?: string; model?: ModelPort } = {}): World {
  const w: World = { asks: [], cards: [], linked: [], assigns: [], deps: undefined as unknown as TextSignalDeps };
  const hint = opts.environmentHint;
  w.deps = {
    workspaceId: WS,
    state,
    playbook: PLAYBOOK,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(hint === undefined ? {} : { environmentHint: () => Promise.resolve(hint) }),
    ports: {
      askResolution: (incidentId, prompt) => {
        w.asks.push({ incidentId, prompt });
        return Promise.resolve();
      },
      postScopeCard: (incidentId, card) => {
        w.cards.push({ incidentId, card });
        return Promise.resolve({ platform: 'slack', channel: CHANNEL, messageId: CARD, role: 'other' });
      },
      fileLinked: (request) => {
        w.linked.push(request);
        return Promise.resolve({ incidentId: '01K6TEXTSIGINC00000000000B' });
      },
      assign: (incidentId, userId) => {
        w.assigns.push([incidentId, userId]);
        return Promise.resolve();
      },
    },
    clock: () => new Date(now),
  };
  return w;
}

function fakeModel(value: TextSignalAnswer): { model: ModelPort; requests: ClassifyRequest<unknown>[] } {
  const requests: ClassifyRequest<unknown>[] = [];
  const model: ModelPort = {
    complete: () => Promise.reject(new Error('not used')),
    vision: () => Promise.reject(new Error('not used')),
    classify: <T,>(request: ClassifyRequest<T>) => {
      requests.push(request as ClassifyRequest<unknown>);
      if (!request.validate(value)) return Promise.reject(new Error('fixture does not validate'));
      return Promise.resolve({ value, attempts: 1 as const, model: 'mock/test' });
    },
  };
  return { model, requests };
}

// The incident ------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T], at = now): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(at).toISOString(), payload } as unknown as NewEvent<T>;
}

function toPlanned(priority: JiraPriorityName = 'Medium'): NewEvent[] {
  return [
    ev(
      'captured',
      { kind: 'incident', idempotencyKey: `slack-${CHANNEL}-${ANCHOR}`, source: 'slack', reporter: PAT, anchorText: 'Checkout total is blank', anchorId: ANCHOR, channelId: CHANNEL },
      T0 - MINUTE,
    ),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: 'Checkout total is blank', priority, labels: ['snapwing'], autonomyLevel: 2 }),
  ];
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function filed(priority: JiraPriorityName = 'Medium'): Promise<void> {
  await append(...toPlanned(priority), ev('filed', { jiraKey: 'WEB-1042' }));
  await drained();
}

/** Takes the incident to `deployed:staging` with PR #77 merged. */
async function onStaging(): Promise<void> {
  await filed();
  await append(
    ev('fixer-started', { runId: '01K6RUN0000000000000000001', harness: 'claude-code', attempt: 1 }),
    ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' }),
    ev('review-passed', { prNumber: 77 }),
    ev('ci-green', { prNumber: 77, headSha: 'abc123' }),
    ev('merged', { prNumber: 77, mergeCommitSha: 'def456', levelAtMergeTime: 2 }),
    ev('deployed:staging', { commitSha: 'def456' }),
  );
  await drained();
}

/** Acks every pending row, so a test sees only the rows its own signals imply. */
async function drained(): Promise<void> {
  for (const target of ['jira', 'github', 'slack'] as const) {
    const rows = await state.drainOutbox(target, 500);
    if (rows.length > 0) await state.ackOutbox(rows.map((r) => r.id));
  }
}

async function pending(target: 'jira' | 'slack'): Promise<OutboxItem[]> {
  return state.drainOutbox(target, 500);
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function textSignals(): Promise<IncidentEvent<'text-signal'>[]> {
  return (await log()).filter((e): e is IncidentEvent<'text-signal'> => e.type === 'text-signal');
}

function message(text: string, author: IncidentActor, extra: Partial<TextMessage> = {}): TextMessage {
  seq += 1;
  return { id: `1730000001.${String(seq).padStart(6, '0')}`, authorId: author.id, text, timestamp: new Date(now).toISOString(), ...extra };
}

async function say(w: World, text: string, actor: IncidentActor, extra: Partial<TextMessage> = {}): Promise<TextSignalOutcome & { messageId: string }> {
  const m = message(text, actor, extra);
  const outcome = await handleTextSignal(w.deps, { platform: 'slack', thread: { channel: CHANNEL, rootId: ANCHOR }, message: m, actor });
  return { ...outcome, messageId: m.id };
}

function effect(outcome: TextSignalOutcome): string {
  return outcome.handled ? outcome.effect : `skip:${outcome.reason}`;
}

// Classification ----------------------------------------------------------------------------------

describe('classifyTextLexicon', () => {
  const lex = (text: string, author: IncidentActor = DANA, extra: Partial<TextMessage> = {}) => classifyTextLexicon(PLAYBOOK, message(text, author, extra));

  it('reads resolution signals: gone (Cannot Reproduce) or fixed', () => {
    expect(lex('nvm, works now')).toEqual({ kind: 'resolution', fixed: false, confidence: 1 });
    expect(lex('that was me, I was on the wrong account')).toEqual({ kind: 'resolution', fixed: false, confidence: 1 });
    expect(lex('already fixed in the deploy that just went out')).toEqual({ kind: 'resolution', fixed: true, confidence: 1 });
  });

  it('never reads a question or a negation as a resolution', () => {
    expect(lex('is it fixed?').kind).toBe('none');
    expect(lex('not fixed yet').kind).toBe('none');
    expect(lex('still broken for me').kind).toBe('none');
    expect(lex('can you fix it').kind).toBe('none');
  });

  it('reads environment mentions, normalized', () => {
    expect(lex('this is staging')).toEqual({ kind: 'environment', env: 'staging', confidence: 1 });
    expect(lex('happening on prod too')).toEqual({ kind: 'environment', env: 'production', confidence: 1 });
    expect(lex('still broken on production')).toEqual({ kind: 'environment', env: 'production', confidence: 1 });
  });

  it('reads scope changes, with where the second issue is when the message says', () => {
    expect(lex('also the footer is broken')).toEqual({ kind: 'scope-change', confidence: 1 });
    expect(lex('same thing on the app')).toEqual({ kind: 'scope-change', where: 'the app', confidence: 1 });
  });

  it('reads a handoff only with a mention of someone else', () => {
    expect(lex(`<@${MARCUS.id}> can you take this?`)).toEqual({ kind: 'handoff', to: MARCUS.id, confidence: 1 });
    expect(lex('Marcus can you take this?', DANA, { mentions: [MARCUS.id] })).toEqual({ kind: 'handoff', to: MARCUS.id, confidence: 1 });
    expect(lex('can you take this?').kind).toBe('none');
    expect(lex(`<@${DANA.id}> can you take this?`).kind).toBe('none');
  });

  it('leaves chatter and long messages alone', () => {
    expect(lex('thanks for the screenshot').kind).toBe('none');
    expect(lex('nvm works now but I want to say a lot more words about the whole thing here').kind).toBe('none');
  });

  it('normalizes environments and raises priorities one step', () => {
    expect(normalizeEnvironment('Prod')).toBe('production');
    expect(normalizeEnvironment('stg')).toBe('staging');
    expect(normalizeEnvironment('localhost')).toBe('development');
    expect(normalizeEnvironment('QA')).toBe('qa');
    expect(raisePriority('Medium')).toBe('High');
    expect(raisePriority('high')).toBe('Highest');
    expect(raisePriority('Highest')).toBeUndefined();
    expect(raisePriority('P1')).toBeUndefined();
  });
});

describe('classifyTextLlm', () => {
  it('sends the message to the segmentation task with the text-signal schema', async () => {
    const { model, requests } = fakeModel({ kind: 'environment', confidence: 0.9, environment: 'Prod' });
    const m = message('our customers on the live site see it as well', DANA);
    expect(await classifyTextLlm(PLAYBOOK, m, [], model)).toEqual({ kind: 'environment', env: 'production', confidence: 0.9 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.task).toBe('segmentation');
    expect(requests[0]?.schemaName).toBe(TEXT_SIGNAL_SCHEMA_NAME);
    expect(requests[0]?.prompt).toContain('our customers on the live site see it as well');
  });

  it('drops answers under the confidence floor, and a handoff with no mention', async () => {
    const m = message('maybe someone else should look at this one', DANA);
    expect(await classifyTextLlm(PLAYBOOK, m, [], fakeModel({ kind: 'resolution', confidence: 0.5 }).model)).toEqual({ kind: 'none' });
    expect(await classifyTextLlm(PLAYBOOK, m, [], fakeModel({ kind: 'handoff', confidence: 0.95 }).model)).toEqual({ kind: 'none' });
    const withMention = message('Marcus, think you could own this one from here', DANA, { mentions: [MARCUS.id] });
    expect(await classifyTextLlm(PLAYBOOK, withMention, [], fakeModel({ kind: 'handoff', confidence: 0.95 }).model)).toEqual({ kind: 'handoff', to: MARCUS.id, confidence: 0.95 });
  });

  it('runs only when the lexicon pass places nothing', async () => {
    const { model, requests } = fakeModel({ kind: 'scope-change', confidence: 0.8, where: 'mobile' });
    expect(await classifyText(PLAYBOOK, message('nvm, works now', PAT), [], model)).toMatchObject({ kind: 'resolution' });
    expect(requests).toHaveLength(0);
    expect(await classifyText(PLAYBOOK, message('the checkout on the phone app has a broken layout too', PAT), [], model)).toEqual({ kind: 'scope-change', where: 'mobile', confidence: 0.8 });
    expect(requests).toHaveLength(1);
  });
});

// Resolution --------------------------------------------------------------------------------------

describe('resolution signals after filing', () => {
  it('asks one confirmation, then closes as Cannot Reproduce through the projector', async () => {
    const w = world();
    await filed();
    const said = await say(w, 'nvm, works now', PAT);
    expect(effect(said)).toBe('resolution-asked');
    expect(w.asks).toEqual([
      {
        incidentId: INC,
        prompt: { userId: PAT.id, issueKey: 'WEB-1042', resolution: RESOLUTION_CANNOT_REPRODUCE, messageId: said.messageId, text: 'Close WEB-1042 as Cannot Reproduce?', choices: ['close', 'keep-open'] },
      },
    ]);
    expect((await state.getIncident(INC))?.status).toBe('filed');
    expect(await pending('jira')).toEqual([]);

    // A second resolution signal while the prompt is open asks nothing more.
    expect(effect(await say(w, 'works now', DANA))).toBe('skip:already-asked');
    expect(w.asks).toHaveLength(1);

    now += MINUTE;
    expect(effect(await say(w, 'yes', PAT))).toBe('closed');
    const incident = await state.getIncident(INC);
    expect(incident?.status).toBe('closed');
    const jira = await pending('jira');
    const transitions = jira.filter((r) => r.op === 'transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.payload).toEqual({ issueKey: 'WEB-1042', to: 'done', resolution: RESOLUTION_CANNOT_REPRODUCE });
    expect(transitions[0]?.batchKey).toBe(jiraFieldBatchKey(INC, 'status'));
    const comment = jira.find((r) => r.op === 'add-comment');
    expect(comment?.payload['text']).toBe('Closed as Cannot Reproduce. @Pat confirmed it in the thread: "nvm, works now".');
    expect(comment?.batchKey).toBe(jiraCommentBatchKey(INC));
    expect((await textSignals()).map((e) => e.payload.phase)).toEqual(['asked', 'confirmed']);
    expect(w.cards).toEqual([]);
  });

  it('closes as Fixed when a fix went out, or the incident\'s PR merged', async () => {
    const w = world();
    await filed();
    await say(w, 'already fixed in the deploy that just went out', DANA);
    expect(w.asks[0]?.prompt.resolution).toBe(RESOLUTION_FIXED);
    const answered = await answerResolution(w.deps, { incidentId: INC, messageId: w.asks[0]?.prompt.messageId ?? '', actor: DANA, choice: 'close', at: new Date(now).toISOString() });
    expect(effect(answered)).toBe('closed');
    expect((await pending('jira')).find((r) => r.op === 'transition')?.payload['resolution']).toBe(RESOLUTION_FIXED);
  });

  it('reads it works now on a merged fix as Fixed', async () => {
    const w = world();
    await onStaging();
    await say(w, 'works now', PAT);
    expect(w.asks[0]?.prompt.resolution).toBe(RESOLUTION_FIXED);
    expect(effect(await say(w, 'confirmed', PAT))).toBe('closed');
    expect((await state.getIncident(INC))?.status).toBe('closed');
  });

  it('keeps the incident open when the answer is no', async () => {
    const w = world();
    await filed();
    const said = await say(w, 'nvm, works now', PAT);
    expect(effect(await answerResolution(w.deps, { incidentId: INC, messageId: said.messageId, actor: PAT, choice: 'keep-open', at: new Date(now).toISOString() }))).toBe('resolution-declined');
    expect((await state.getIncident(INC))?.status).toBe('filed');
    expect(await pending('jira')).toEqual([]);

    // Declined is answered: a later resolution signal asks again, and a typed no declines it.
    await say(w, 'my bad, that was me', PAT);
    expect(w.asks).toHaveLength(2);
    expect(effect(await say(w, 'nope', PAT))).toBe('resolution-declined');
    expect((await state.getIncident(INC))?.status).toBe('filed');
  });

  it('takes it only from the reporter or an engineer, and the answer only from the person asked', async () => {
    const w = world();
    await filed();
    expect(effect(await say(w, 'nvm, works now', SAM))).toBe('skip:not-allowed');
    expect(effect(await say(w, 'nvm, works now', KIM))).toBe('skip:not-allowed');
    expect(w.asks).toEqual([]);
    const said = await say(w, 'nvm, works now', PAT);
    expect(effect(await answerResolution(w.deps, { incidentId: INC, messageId: said.messageId, actor: DANA, choice: 'close', at: new Date(now).toISOString() }))).toBe('skip:not-allowed');
    expect((await state.getIncident(INC))?.status).toBe('filed');
  });

  it('does nothing before filing, or once the incident is closed', async () => {
    const w = world();
    await append(...toPlanned());
    expect(effect(await say(w, 'nvm, works now', PAT))).toBe('skip:not-filed');
    await append(ev('filed', { jiraKey: 'WEB-1042' }), ev('closed', { reason: 'done' }));
    expect(effect(await say(w, 'nvm, works now', PAT))).toBe('skip:closed');
    expect(w.asks).toEqual([]);
  });

  it('ignores a thread that is no incident\'s', async () => {
    const w = world();
    await filed();
    const m = message('nvm, works now', PAT);
    const outcome = await handleTextSignal(w.deps, { platform: 'slack', thread: { channel: CHANNEL, rootId: '1730000099.000001' }, message: m, actor: PAT });
    expect(effect(outcome)).toBe('skip:no-target');
  });
});

// Environment -------------------------------------------------------------------------------------

describe('environment mentions', () => {
  it('update the incident\'s environment, and production on a staging incident raises priority one step', async () => {
    const w = world();
    await filed('Medium');
    expect(effect(await say(w, 'this is staging', DANA))).toBe('environment');
    expect(incidentEnvironment(await log())).toBe('staging');
    expect((await state.getIncident(INC))?.priority).toBe('Medium');
    expect(await pending('jira')).toEqual([]);

    expect(effect(await say(w, 'happening on prod too', PAT))).toBe('priority-raised');
    expect(incidentEnvironment(await log())).toBe('production');
    expect((await state.getIncident(INC))?.priority).toBe('High');
    const jira = await pending('jira');
    const field = jira.find((r) => r.op === 'update-fields');
    expect(field?.payload).toEqual({ issueKey: 'WEB-1042', fields: { priority: { name: 'High' } } });
    expect(field?.batchKey).toBe(jiraFieldBatchKey(INC, 'priority'));
    expect(jira.find((r) => r.op === 'add-comment')?.payload['text']).toBe('Priority raised from Medium to High: @Pat says it happens on production too: "happening on prod too".');
    const changed = (await log()).filter((e) => e.type === 'jira-priority-changed');
    expect(changed.map((e) => e.payload)).toEqual([{ jiraKey: 'WEB-1042', from: 'Medium', to: 'High' }]);
    expect((await textSignals()).at(-1)?.payload).toMatchObject({ kind: 'environment', env: 'production', from: 'staging', priority: { from: 'Medium', to: 'High' } });

    // Saying it again changes nothing.
    expect(effect(await say(w, 'yes prod', DANA))).toBe('skip:unchanged');
    expect((await state.getIncident(INC))?.priority).toBe('High');
  });

  it('raises nothing when the incident was not on staging', async () => {
    const w = world();
    await filed('Medium');
    expect(effect(await say(w, 'happening on prod too', PAT))).toBe('environment');
    expect((await state.getIncident(INC))?.priority).toBe('Medium');
    expect(await pending('jira')).toEqual([]);
  });

  it('takes a staging start from the environment hint', async () => {
    const w = world({ environmentHint: 'stg' });
    await filed('Low');
    expect(effect(await say(w, 'seeing it in production as well', DANA))).toBe('priority-raised');
    expect((await state.getIncident(INC))?.priority).toBe('Medium');
  });

  it('keeps Highest at Highest', async () => {
    const w = world();
    await filed('Highest');
    await say(w, 'this is staging', DANA);
    expect(effect(await say(w, 'happening on prod too', DANA))).toBe('environment');
    expect((await state.getIncident(INC))?.priority).toBe('Highest');
    expect((await log()).some((e) => e.type === 'jira-priority-changed')).toBe(false);
  });
});

// Scope change ------------------------------------------------------------------------------------

describe('scope changes', () => {
  it('propose a linked incident with a Yes / It\'s the same bug card, and Yes files it separately', async () => {
    const w = world();
    await filed();
    const before = (await log()).length;
    const said = await say(w, 'same thing on the app', PAT);
    expect(effect(said)).toBe('scope-proposed');
    expect(w.cards).toEqual([
      {
        incidentId: INC,
        card: {
          kind: 'scope-change',
          text: 'Sounds like a second issue on the app. File it separately?',
          where: 'the app',
          messageId: said.messageId,
          choices: [
            { id: 'yes', label: 'Yes' },
            { id: 'same-bug', label: "It's the same bug" },
          ],
        },
      },
    ]);
    const added = (await log()).slice(before);
    expect(added.map((e) => e.type)).toEqual(['text-signal', 'bot-message-posted']);
    expect(added[1]?.payload).toEqual({ platform: 'slack', channel: CHANNEL, messageId: CARD, role: 'other' });
    expect((await state.getIncident(INC))?.status).toBe('filed');

    // The same message delivered again posts nothing more.
    const again = await handleTextSignal(w.deps, {
      platform: 'slack',
      thread: { channel: CHANNEL, rootId: ANCHOR },
      message: { id: said.messageId, authorId: PAT.id, text: 'same thing on the app', timestamp: new Date(now).toISOString() },
      actor: PAT,
    });
    expect(effect(again)).toBe('skip:already-proposed');
    expect(w.cards).toHaveLength(1);

    const tap = await answerScopeChange(w.deps, { incidentId: INC, messageId: said.messageId, actor: PAT, choice: 'yes', at: new Date(now).toISOString() });
    expect(effect(tap)).toBe('scope-split');
    expect(w.linked).toEqual([
      {
        parentIncidentId: INC,
        parentIssueKey: 'WEB-1042',
        platform: 'slack',
        channel: CHANNEL,
        messageId: said.messageId,
        text: 'same thing on the app',
        where: 'the app',
        reporter: { id: PAT.id, role: 'reporter' },
      },
    ]);
    expect((await textSignals()).at(-1)?.payload).toEqual({ kind: 'scope-change', messageId: said.messageId, phase: 'split', linkedIncidentId: '01K6TEXTSIGINC00000000000B' });
    // Never merged into the current incident: no rescope, no new bundle, same status.
    expect((await log()).some((e) => e.type === 'scope-changed' || (e.type === 'context-assembled' && e.seq > before))).toBe(false);
    expect((await state.getIncident(INC))?.status).toBe('filed');

    expect(effect(await answerScopeChange(w.deps, { incidentId: INC, messageId: said.messageId, actor: DANA, choice: 'same-bug', at: new Date(now).toISOString() }))).toBe('skip:already-decided');
  });

  it('records It\'s the same bug and files nothing', async () => {
    const w = world();
    await filed();
    const said = await say(w, 'also the footer is broken', PAT);
    expect(w.cards[0]?.card.text).toBe('Sounds like a second issue. File it separately?');
    expect(effect(await answerScopeChange(w.deps, { incidentId: INC, messageId: said.messageId, actor: KIM, choice: 'yes', at: new Date(now).toISOString() }))).toBe('skip:not-allowed');
    expect(effect(await answerScopeChange(w.deps, { incidentId: INC, messageId: said.messageId, actor: DANA, choice: 'same-bug', at: new Date(now).toISOString() }))).toBe('scope-same');
    expect(w.linked).toEqual([]);
    expect((await textSignals()).map((e) => e.payload.phase)).toEqual(['proposed', 'same']);
  });
});

// Handoff -----------------------------------------------------------------------------------------

describe('handoffs', () => {
  const WINDOW = parseDuration(HANDOFF_WINDOW);

  it('reassign when the mentioned person says yes within 15 minutes', async () => {
    const w = world();
    await filed();
    expect(effect(await say(w, `<@${MARCUS.id}> can you take this?`, DANA))).toBe('handoff-asked');
    expect((await textSignals()).at(-1)?.payload).toMatchObject({ kind: 'handoff', phase: 'asked', to: MARCUS.id, expiresAt: new Date(now + WINDOW).toISOString() });
    expect(w.assigns).toEqual([]);

    now += 5 * MINUTE;
    expect(effect(await say(w, 'yes', SAM))).toBe('skip:no-signal');
    expect(w.assigns).toEqual([]);
    expect(effect(await say(w, 'sure, on it', MARCUS))).toBe('reassigned');
    expect(w.assigns).toEqual([[INC, MARCUS.id]]);
    expect((await textSignals()).at(-1)?.payload).toMatchObject({ kind: 'handoff', phase: 'accepted', to: MARCUS.id, via: 'message' });

    // Taken once: a second yes does nothing.
    expect(effect(await say(w, 'yes', MARCUS))).toBe('skip:no-signal');
    expect(w.assigns).toHaveLength(1);
  });

  it('reassign on a claim reaction within the window', async () => {
    const w = world();
    await filed();
    await say(w, `<@${MARCUS.id}> can you take this?`, DANA);
    now += 14 * MINUTE;
    const taken = await acceptHandoff(w.deps, { incidentId: INC, actor: MARCUS, at: new Date(now).toISOString(), via: 'reaction' });
    expect(effect(taken)).toBe('reassigned');
    expect(w.assigns).toEqual([[INC, MARCUS.id]]);
  });

  it('do nothing after 15 minutes, or for anyone else', async () => {
    const w = world();
    await filed();
    await say(w, `<@${MARCUS.id}> can you take this?`, DANA);
    expect(effect(await acceptHandoff(w.deps, { incidentId: INC, actor: SAM, at: new Date(now).toISOString(), via: 'reaction' }))).toBe('skip:not-pending');
    now += 16 * MINUTE;
    expect(effect(await say(w, 'yes', MARCUS))).toBe('skip:no-signal');
    expect(effect(await acceptHandoff(w.deps, { incidentId: INC, actor: MARCUS, at: new Date(now).toISOString(), via: 'reaction' }))).toBe('skip:expired');
    expect(w.assigns).toEqual([]);
    expect((await textSignals()).map((e) => e.payload.phase)).toEqual(['asked']);
  });
});

// Only the card posts -----------------------------------------------------------------------------

describe('messages', () => {
  it('only the scope-change card posts; the other signals update state', async () => {
    const w = world();
    await filed();
    await say(w, 'this is staging', DANA);
    await say(w, `<@${MARCUS.id}> can you take this?`, DANA);
    await say(w, 'ok', MARCUS);
    await say(w, 'nvm, works now', PAT);
    await say(w, 'yes', PAT);
    expect((await state.getIncident(INC))?.status).toBe('closed');
    expect(w.cards).toEqual([]);
    expect((await log()).some((e) => e.type === 'bot-message-posted')).toBe(false);
    // The pinned status message is edited in place; nothing else goes to the thread.
    expect((await pending('slack')).every((r) => r.op === UPDATE_STATUS_OP)).toBe(true);
    expect(w.assigns).toEqual([[INC, MARCUS.id]]);
    expect(w.asks).toHaveLength(1);
  });
});
