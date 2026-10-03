// Escalation ladders (#299; A 6.2, B 5 `escalate:{incident}:{step}`). Runs on the in-process
// workflow over the dialect `SNAPWING_DB` selects, with a fake clock, a fake chat side, a fake
// Pager, and an in-memory secrets port. The A 6.2 example ladders (`outage`, `stalled-fix`) are the
// playbook under test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPlaybook, type Playbook, type PlaybookEscalation } from '../../src/config/playbook.ts';
import type { EscalationLadderPayload, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { timerKey } from '../../src/contracts/jobs.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import {
  createEscalationLadders,
  escalateTimerKey,
  ladderApplies,
  pagerDedupKey,
  serviceSecretName,
  type EscalationLadders,
  type EscalationPost,
  type LadderDeps,
} from '../../src/monitor/ladder.ts';
import type { Pager, PagerTriggerInput } from '../../src/monitor/pager.ts';
import { SecretNotFoundError, type SecretsPort } from '../../src/ports/secrets.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import type { Job, JobName, WaitKey, WorkflowPort } from '../../src/ports/workflow.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6LADDERINC000000000000A';
const MINUTE = 60_000;

const OUTAGE: PlaybookEscalation = {
  name: 'outage',
  steps: [
    { duration: 'PT0M', mention: 'owner' },
    { duration: 'PT30M', mention: '@U0ENGLEAD' },
    { duration: 'PT60M', pagerduty: 'P123ABC' },
    { duration: 'PT2H', mention: '@U0CTO', channel: '#incidents' },
  ],
  applyWhen: [{ priority: 'Highest' }, { outage: true }],
};

const STALLED_FIX: PlaybookEscalation = {
  name: 'stalled-fix',
  steps: [
    { duration: 'PT15M', mention: 'owner' },
    { duration: 'PT45M', mention: '@U0ENGLEAD' },
  ],
  applyWhen: [{ monitored: true, stalled: true }],
};

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

// Fakes -------------------------------------------------------------------------------------------

class FakeChat {
  readonly posts: EscalationPost[] = [];
  failNext = false;

  post(message: EscalationPost): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('chat is down'));
    }
    this.posts.push(message);
    return Promise.resolve();
  }
}

class FakePager implements Pager {
  readonly triggers: PagerTriggerInput[] = [];
  readonly resolves: { dedupKey: string; routingKey?: string }[] = [];

  trigger(input: PagerTriggerInput): Promise<void> {
    this.triggers.push(input);
    return Promise.resolve();
  }

  resolve(dedupKey: string, opts?: { routingKey?: string }): Promise<void> {
    this.resolves.push({ dedupKey, ...(opts?.routingKey === undefined ? {} : { routingKey: opts.routingKey }) });
    return Promise.resolve();
  }
}

class MapSecrets implements SecretsPort {
  readonly reads: string[] = [];
  constructor(private readonly values: Record<string, string>) {}

  get(name: string): Promise<string> {
    this.reads.push(name);
    const v = this.values[name];
    return v === undefined ? Promise.reject(new SecretNotFoundError(name, 'the test')) : Promise.resolve(v);
  }
}

/** Delegates to the real workflow and records every singleton key scheduled or cancelled. */
class RecordingWorkflow implements WorkflowPort {
  readonly scheduled: { key: string | undefined; runAt: number; data: unknown }[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly inner: WorkflowPort) {}

  start(name: JobName, input: unknown, opts: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean }): Promise<{ jobId: string }> {
    return this.inner.start(name, input, opts);
  }
  schedule(name: JobName, input: unknown, runAt: Date, opts?: { singletonKey?: string }): Promise<{ jobId: string }> {
    this.scheduled.push({ key: opts?.singletonKey, runAt: runAt.getTime(), data: input });
    return this.inner.schedule(name, input, runAt, opts);
  }
  cancel(singletonKey: string): Promise<void> {
    this.cancelled.push(singletonKey);
    return this.inner.cancel(singletonKey);
  }
  work(name: JobName, handler: (job: Job) => Promise<void>, opts?: { concurrency?: number }): void {
    this.inner.work(name, handler, opts);
  }
  park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void> {
    return this.inner.park(jobId, waitingOn, timeoutAt);
  }
  resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }> {
    return this.inner.resume(waitingOn, result);
  }
  cron(name: JobName, expression: string, input?: unknown): Promise<void> {
    return this.inner.cron(name, expression, input);
  }
}

interface World {
  ladders: EscalationLadders;
  chat: FakeChat;
  pager: FakePager;
  secrets: MapSecrets;
  workflow: RecordingWorkflow;
  logs: string[];
  playbook: Playbook;
  flags: { stalled: boolean; outage: boolean };
}

async function setup(opts: { escalations?: PlaybookEscalation[]; secrets?: Record<string, string>; deps?: Partial<LadderDeps> } = {}): Promise<World> {
  const chat = new FakeChat();
  const pager = new FakePager();
  const secrets = new MapSecrets(opts.secrets ?? { [serviceSecretName('P123ABC')]: 'fake-routing-key-for-p123abc' });
  const workflow = new RecordingWorkflow(wf);
  const logs: string[] = [];
  const playbook = defaultPlaybook();
  playbook.escalations = opts.escalations ?? [OUTAGE, STALLED_FIX];
  const flags = { stalled: false, outage: false };
  const ladders = createEscalationLadders({
    workspaceId: WS,
    state,
    workflow,
    playbook: () => playbook,
    chat,
    pager,
    secrets,
    clock: () => new Date(now),
    outage: () => flags.outage,
    stalled: () => flags.stalled,
    link: (incident: IncidentView) => `https://snapwing.example.test/incidents/${incident.id}`,
    log: (m) => logs.push(m),
    ...opts.deps,
  });
  ladders.register();
  await append(...toFiled());
  return { ladders, chat, pager, secrets, workflow, logs, playbook, flags };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], incidentId = INC): NewEvent<T> {
  return { workspaceId: WS, incidentId, type, v: 1, source: 'agent', occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

function toFiled(incidentId = INC): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${incidentId}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
      anchorId: '1700000000.000100',
      threadId: '1700000000.000100',
    }, incidentId),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }, incidentId),
    ev('resolved', { surfaceId: 'checkout', componentId: 'checkout', repo: 'fake-org/web', ownerId: 'dana', resolvedBy: 'channel-explicit', confidence: 0.9 }, incidentId),
    ev('dedupe-checked', { candidates: [], decision: 'none' }, incidentId),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: 2,
    }, incidentId),
    ev('filed', { jiraKey: 'WEB-1042' }, incidentId),
  ];
}

async function log(incidentId = INC): Promise<IncidentEvent[]> {
  return state.read(incidentId);
}

async function append(...events: NewEvent[]): Promise<void> {
  const incidentId = events[0]?.incidentId ?? INC;
  const last = (await log(incidentId)).at(-1)?.seq ?? 0;
  await state.append(incidentId, events, last);
}

async function ladderEvents(incidentId = INC): Promise<EscalationLadderPayload[]> {
  return (await log(incidentId)).flatMap((e) => (e.type === 'escalation-ladder' ? [e.payload] : []));
}

async function steps(incidentId = INC): Promise<{ ladder: string; step: number }[]> {
  return (await ladderEvents(incidentId)).flatMap((p) => (p.phase === 'step' ? [{ ladder: p.ladder, step: p.step }] : []));
}

async function status(incidentId = INC): Promise<string | undefined> {
  return (await state.getIncident(incidentId))?.status;
}

/** Moves the fake clock to `minutes` after T0 and runs every timer due by then. */
async function at(minutes: number): Promise<void> {
  now = T0 + minutes * MINUTE;
  await wf.drain();
}

async function setPriority(to: string, from: string): Promise<void> {
  await append(ev('jira-priority-changed', { jiraKey: 'WEB-1042', from, to }));
}

// Tests -------------------------------------------------------------------------------------------

describe('applyWhen', () => {
  const facts = { closed: false, outage: false, monitored: false, stalled: false };

  it('holds when any one element matches, and every attribute on that element must', () => {
    expect(ladderApplies(OUTAGE, { ...facts, priority: 'Highest' })).toBe(true);
    expect(ladderApplies(OUTAGE, { ...facts, priority: 'High', outage: true })).toBe(true);
    expect(ladderApplies(OUTAGE, { ...facts, priority: 'High' })).toBe(false);
    expect(ladderApplies(STALLED_FIX, { ...facts, monitored: true, stalled: true })).toBe(true);
    expect(ladderApplies(STALLED_FIX, { ...facts, monitored: true })).toBe(false);
    expect(ladderApplies(STALLED_FIX, { ...facts, stalled: true })).toBe(false);
  });

  it('never holds on a closed incident, nor for a ladder with no applyWhen', () => {
    expect(ladderApplies(OUTAGE, { ...facts, priority: 'Highest', closed: true })).toBe(false);
    expect(ladderApplies({ ...OUTAGE, applyWhen: [] }, { ...facts, priority: 'Highest', outage: true })).toBe(false);
  });

  it('matches the priority name without regard to case', () => {
    expect(ladderApplies(OUTAGE, { ...facts, priority: 'highest' })).toBe(true);
  });
});

describe('timer keys', () => {
  it('are B 5 escalate keys built by timerKey, one per ladder step', () => {
    expect(escalateTimerKey(INC, 'outage', 2)).toBe(timerKey('escalate', { incidentId: INC, step: 'outage.2' }));
    expect(escalateTimerKey(INC, 'outage', 2)).toBe(`escalate:${INC}:outage.2`);
    expect(escalateTimerKey(INC, 'stalled-fix', 1)).not.toBe(escalateTimerKey(INC, 'outage', 1));
  });

  it('names the per-service routing key secret from the service id', () => {
    expect(serviceSecretName('P123ABC')).toBe('PAGERDUTY_ROUTING_KEY_P123ABC');
    expect(serviceSecretName('p-12 x')).toBe('PAGERDUTY_ROUTING_KEY_P_12_X');
  });
});

describe('outage ladder', () => {
  it('runs every step on its durable timer, in order, from the start time', async () => {
    const w = await setup();
    expect(await w.ladders.evaluate(INC)).toEqual([]);
    expect(await ladderEvents()).toEqual([]);

    await setPriority('Highest', 'High');
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'outage', started: true }]);
    expect(w.workflow.scheduled.map((s) => s.key)).toEqual([escalateTimerKey(INC, 'outage', 1)]);

    // PT0M fires on the next poll: the owner (the resolved owner, no assignee yet) in the thread.
    await at(0);
    expect(await steps()).toEqual([{ ladder: 'outage', step: 1 }]);
    expect(w.chat.posts).toEqual([
      {
        incidentId: INC,
        ladder: 'outage',
        step: 1,
        where: { kind: 'thread', channel: 'C-FAKE', threadId: '1700000000.000100' },
        mention: 'dana',
        text: 'Escalating (outage, step 1 of 4): WEB-1042 Checkout returns 500 on submit',
      },
    ]);

    // Evaluating again mid-ladder neither restarts it nor pushes its timers out.
    await at(10);
    expect(await w.ladders.evaluate(INC)).toEqual([]);
    await at(29);
    expect(await steps()).toHaveLength(1);
    await at(30);
    expect(await steps()).toEqual([
      { ladder: 'outage', step: 1 },
      { ladder: 'outage', step: 2 },
    ]);
    expect(w.chat.posts[1]).toMatchObject({ step: 2, mention: 'U0ENGLEAD', where: { kind: 'thread' } });

    // PT60M pages through the injected Pager with the service's own routing key.
    await at(60);
    expect(w.pager.triggers).toEqual([
      {
        dedupKey: pagerDedupKey(INC, 'outage'),
        summary: 'Escalating (outage, step 3 of 4): WEB-1042 Checkout returns 500 on submit',
        severity: 'critical',
        source: 'snapwing',
        routingKey: 'fake-routing-key-for-p123abc',
        link: { href: `https://snapwing.example.test/incidents/${INC}`, text: 'WEB-1042' },
        details: { incident: INC, ladder: 'outage', step: '3', service: 'P123ABC', jira: 'WEB-1042' },
      },
    ]);

    // PT2H posts to the channel, mentioning the CTO.
    await at(120);
    expect(w.chat.posts[2]).toMatchObject({ step: 4, mention: 'U0CTO', where: { kind: 'channel', channel: '#incidents' } });

    const recorded = (await ladderEvents()).filter((p) => p.phase === 'step');
    expect(recorded).toEqual([
      { phase: 'step', ladder: 'outage', step: 1, after: 'PT0M', mention: 'owner', mentioned: 'dana', posted: true },
      { phase: 'step', ladder: 'outage', step: 2, after: 'PT30M', mention: '@U0ENGLEAD', mentioned: 'U0ENGLEAD', posted: true },
      { phase: 'step', ladder: 'outage', step: 3, after: 'PT60M', pagerduty: 'P123ABC', paged: true },
      { phase: 'step', ladder: 'outage', step: 4, after: 'PT2H', mention: '@U0CTO', mentioned: 'U0CTO', channel: '#incidents', posted: true },
    ]);
    // The step events record each step at its time and never move the lifecycle status.
    const times = (await log()).filter((e) => e.type === 'escalation-ladder').map((e) => (Date.parse(e.occurredAt) - T0) / MINUTE);
    expect(times).toEqual([0, 0, 30, 60, 120]);
    expect(await status()).toBe('filed');

    // Nothing after the last step; closing stops the ladder and resolves its page.
    await at(600);
    expect(await steps()).toHaveLength(4);
    await append(ev('closed', { reason: 'fixed' }));
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'outage', stopped: 'closed' }]);
    expect(w.pager.resolves).toEqual([{ dedupKey: pagerDedupKey(INC, 'outage'), routingKey: 'fake-routing-key-for-p123abc' }]);
    expect(w.workflow.cancelled).toEqual([1, 2, 3, 4].map((i) => escalateTimerKey(INC, 'outage', i)));
    expect((await ladderEvents()).at(-1)).toEqual({ phase: 'stopped', ladder: 'outage', reason: 'closed' });
  });

  it('starts on an outage from the reaction ladder at any priority', async () => {
    const w = await setup();
    w.flags.outage = true;
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'outage', started: true }]);
  });

  it('mentions the Jira assignee as the owner when there is one', async () => {
    const w = await setup();
    await append(ev('jira-assignee-changed', { jiraKey: 'WEB-1042', to: 'U-FAKE-ASSIGNEE' }));
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(0);
    expect(w.chat.posts[0]?.mention).toBe('U-FAKE-ASSIGNEE');
  });

  // #360: an outage reached by reactions adopted at capture starts the ladder before resolution names
  // an owner; `mention="owner"` then falls back to the owner of the channel's surface in the map.
  it('before resolution, mentions the owner of the channel surface from the map', async () => {
    const map = {
      channels: [{ id: 'C-FAKE', name: 'web-bugs', surface: 'checkout', triggerEmoji: [] }],
      surfaces: [{ id: 'checkout', label: 'Checkout', components: [] }],
      people: [{ slackId: 'U-FAKE-DANA', handle: 'dana', role: 'engineer', owns: [{ surface: 'checkout', primary: true }] }],
    } as unknown as WorkspaceMap;
    const w = await setup({ deps: { map: () => map } });
    const early = '01K6LADDERINC00000000000ZZ';
    await append(toFiled(early)[0] as NewEvent);
    expect((await state.getIncident(early))?.ownerRef).toBeUndefined();
    w.flags.outage = true;
    await w.ladders.evaluate(early);
    await at(0);
    expect(w.chat.posts.find((p) => p.incidentId === early)?.mention).toBe('dana');
    expect((await ladderEvents(early)).find((p) => p.phase === 'step')).toMatchObject({ mention: 'owner', mentioned: 'dana', posted: true });
  });
});

describe('early stop', () => {
  it('stops when a human downgrades the priority: no later step, timers cancelled', async () => {
    const w = await setup();
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(30);
    expect(await steps()).toHaveLength(2);

    await at(45);
    await setPriority('High', 'Highest');
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'outage', stopped: 'no-longer-applies' }]);
    expect(w.workflow.cancelled).toContain(escalateTimerKey(INC, 'outage', 3));

    await at(600);
    expect(await steps()).toHaveLength(2);
    expect(w.pager.triggers).toEqual([]);
    // Nothing was paged, so nothing is resolved.
    expect(w.pager.resolves).toEqual([]);
  });

  it('a step that comes due after the incident closed stops the ladder instead of acting, without an evaluate', async () => {
    const w = await setup();
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(0);
    await at(10);
    await append(ev('closed', { reason: 'fixed' }));

    await at(30);
    expect(await steps()).toEqual([{ ladder: 'outage', step: 1 }]);
    expect(w.chat.posts).toHaveLength(1);
    expect((await ladderEvents()).at(-1)).toEqual({ phase: 'stopped', ladder: 'outage', reason: 'closed' });
    await at(600);
    expect(await steps()).toHaveLength(1);
  });

  it('stops a ladder removed from the playbook', async () => {
    const w = await setup();
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(0);
    w.playbook.escalations = [STALLED_FIX];
    await at(30);
    expect((await ladderEvents()).at(-1)).toEqual({ phase: 'stopped', ladder: 'outage', reason: 'removed' });
    expect(await steps()).toHaveLength(1);
  });

  it('resolves the page when the ladder stops after paging', async () => {
    const w = await setup();
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(60);
    expect(w.pager.triggers).toHaveLength(1);
    await setPriority('Medium', 'Highest');
    await w.ladders.evaluate(INC);
    expect(w.pager.resolves).toEqual([{ dedupKey: pagerDedupKey(INC, 'outage'), routingKey: 'fake-routing-key-for-p123abc' }]);
  });
});

describe('stalled-fix ladder', () => {
  it('runs while monitored and stalled, stops when unstalled, and restarts on the next stall', async () => {
    const w = await setup();
    await append(ev('monitoring-started', { qualifiedBy: 'critical-surface' }));
    expect(await w.ladders.evaluate(INC)).toEqual([]);

    // A 4.5: the stall detector (#301) reports the stall and evaluates.
    w.flags.stalled = true;
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'stalled-fix', started: true }]);
    await at(14);
    expect(await steps()).toEqual([]);
    await at(15);
    expect(await steps()).toEqual([{ ladder: 'stalled-fix', step: 1 }]);
    expect(w.chat.posts[0]).toMatchObject({ ladder: 'stalled-fix', step: 1, mention: 'dana' });

    // Progress arrives; nobody evaluates. The PT45M step finds it unstalled and stops the ladder.
    w.flags.stalled = false;
    await at(45);
    expect(await steps()).toHaveLength(1);
    expect((await ladderEvents()).at(-1)).toEqual({ phase: 'stopped', ladder: 'stalled-fix', reason: 'no-longer-applies' });

    // A second stall is a new run with its own anchor.
    await at(70);
    w.flags.stalled = true;
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'stalled-fix', started: true }]);
    await at(84);
    expect(await steps()).toHaveLength(1);
    await at(85);
    expect(await steps()).toEqual([
      { ladder: 'stalled-fix', step: 1 },
      { ladder: 'stalled-fix', step: 1 },
    ]);
    await at(115);
    expect((await steps()).at(-1)).toEqual({ ladder: 'stalled-fix', step: 2 });
    expect(await status()).toBe('filed');
  });

  it('stops when monitoring stops', async () => {
    const w = await setup();
    await append(ev('monitoring-started', { qualifiedBy: 'priority' }));
    w.flags.stalled = true;
    await w.ladders.evaluate(INC);
    await append(ev('monitoring-stopped', { reason: 'downgraded' }));
    expect(await w.ladders.evaluate(INC)).toEqual([{ ladder: 'stalled-fix', stopped: 'no-longer-applies' }]);
    await at(120);
    expect(await steps()).toEqual([]);
  });

  it('runs alongside the outage ladder without sharing timers', async () => {
    const w = await setup();
    await append(ev('monitoring-started', { qualifiedBy: 'priority' }));
    await setPriority('Highest', 'High');
    w.flags.stalled = true;
    expect(await w.ladders.evaluate(INC)).toEqual([
      { ladder: 'outage', started: true },
      { ladder: 'stalled-fix', started: true },
    ]);
    await at(0);
    await at(15);
    await at(30);
    expect(await steps()).toEqual([
      { ladder: 'outage', step: 1 },
      { ladder: 'stalled-fix', step: 1 },
      { ladder: 'outage', step: 2 },
    ]);
  });
});

describe('paging', () => {
  it('falls back to PAGERDUTY_ROUTING_KEY when the service has no key of its own', async () => {
    const w = await setup({ secrets: { PAGERDUTY_ROUTING_KEY: 'fake-default-routing-key' } });
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(60);
    expect(w.secrets.reads).toEqual(['PAGERDUTY_ROUTING_KEY_P123ABC', 'PAGERDUTY_ROUTING_KEY']);
    expect(w.pager.triggers[0]?.routingKey).toBe('fake-default-routing-key');
  });

  it('with no key at all skips the page, logs once, and still runs the other actions of the step', async () => {
    const ladder: PlaybookEscalation = {
      name: 'outage',
      steps: [
        { duration: 'PT0M', mention: 'owner', pagerduty: 'P123ABC' },
        { duration: 'PT10M', pagerduty: 'P123ABC' },
        { duration: 'PT20M', mention: '@U0ENGLEAD' },
      ],
      applyWhen: [{ priority: 'Highest' }],
    };
    const w = await setup({ escalations: [ladder], secrets: {} });
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(20);

    expect(w.pager.triggers).toEqual([]);
    expect(w.chat.posts.map((p) => p.step)).toEqual([1, 3]);
    expect((await ladderEvents()).filter((p) => p.phase === 'step')).toEqual([
      { phase: 'step', ladder: 'outage', step: 1, after: 'PT0M', mention: 'owner', mentioned: 'dana', posted: true, pagerduty: 'P123ABC', paged: false },
      { phase: 'step', ladder: 'outage', step: 2, after: 'PT10M', pagerduty: 'P123ABC', paged: false },
      { phase: 'step', ladder: 'outage', step: 3, after: 'PT20M', mention: '@U0ENGLEAD', mentioned: 'U0ENGLEAD', posted: true },
    ]);
    expect(w.logs.filter((m) => m.includes('no PagerDuty routing key'))).toHaveLength(1);
    expect(w.logs.join('\n')).not.toMatch(/fake-/);
  });
});

describe('failures', () => {
  it('a failing post is recorded and neither the page nor the next step is lost', async () => {
    const ladder: PlaybookEscalation = {
      name: 'outage',
      steps: [
        { duration: 'PT0M', mention: 'owner', pagerduty: 'P123ABC' },
        { duration: 'PT5M', mention: '@U0ENGLEAD' },
      ],
      applyWhen: [{ priority: 'Highest' }],
    };
    const w = await setup({ escalations: [ladder] });
    w.chat.failNext = true;
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(5);
    expect(w.pager.triggers).toHaveLength(1);
    expect((await ladderEvents()).filter((p) => p.phase === 'step')).toMatchObject([
      { step: 1, posted: false, paged: true },
      { step: 2, posted: true },
    ]);
    expect(w.logs.some((m) => m.includes('post for incident') && m.includes('chat is down'))).toBe(true);
  });

  it('a timer from an earlier run, or a repeated delivery, does nothing', async () => {
    const w = await setup();
    await setPriority('Highest', 'High');
    await w.ladders.evaluate(INC);
    await at(0);
    const run = (await log()).find((e) => e.type === 'escalation-ladder' && e.payload.phase === 'started')?.seq ?? 0;
    expect(await w.ladders.fire({ incidentId: INC, ladder: 'outage', step: 1, run })).toEqual({ fired: false, reason: 'duplicate' });
    expect(await w.ladders.fire({ incidentId: INC, ladder: 'outage', step: 2, run: run - 1 })).toEqual({ fired: false, reason: 'stale' });
    expect(await w.ladders.fire({ incidentId: INC, ladder: 'stalled-fix', step: 1, run })).toEqual({ fired: false, reason: 'stale' });
    expect(w.chat.posts).toHaveLength(1);
  });
});
