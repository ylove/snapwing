// Environment holds and claim expiry (A 2.3, A 2.4, B 5 timers). Runs on the in-process workflow
// over the dialect `SNAPWING_DB` selects, with a fake clock that the state store, the workflow, and the
// module share. Chat posts go to a recording `say`; ticket and PR comments are read off the outbox.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomyLevel, EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { JobName } from '../../src/contracts/jobs.ts';
import { timerKey } from '../../src/contracts/jobs.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { WorkflowPort } from '../../src/ports/workflow.ts';
import { activeHolds, addBusinessTime, createHolds, type BusinessHours, type Holds, type HoldsDeps } from '../../src/signals/holds.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z'); // a Friday
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6HOLDSINC00000000000000';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DANA: EventActor = { id: 'U-FAKE-DANA', role: 'engineer' };
const SAM: EventActor = { id: 'U-FAKE-SAM', role: 'engineer' };

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];
let said: { text: string; mentionUserId?: string }[];
let released: { seq: number; scope: 'claim' | 'hold' }[];
let scheduled: { name: JobName; key: string | undefined }[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  said = [];
  released = [];
  scheduled = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

/** The real workflow, recording the singleton key of every schedule so the B 5 keys can be asserted. */
function recording(inner: InProcessWorkflow): WorkflowPort {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'schedule') {
        return (name: JobName, input: unknown, runAt: Date, opts?: { singletonKey?: string }) => {
          scheduled.push({ name, key: opts?.singletonKey });
          return target.schedule(name, input, runAt, opts);
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as WorkflowPort;
}

function holdsWith(overrides: Partial<HoldsDeps> = {}): Holds {
  const holds = createHolds({
    workspaceId: WS,
    state,
    workflow: recording(wf),
    clock: () => new Date(now),
    claims: { expiry: 'PT4H', holdExpiry: 'PT2H', businessHoursOnly: false },
    say: (_id, message) => {
      said.push(message);
      return Promise.resolve();
    },
    handleOf: (id) => (id === DANA.id ? 'dana' : id === SAM.id ? 'sam' : undefined),
    afterRelease: (_id, seq, scope) => {
      released.push({ seq, scope });
      return Promise.resolve();
    },
    ...overrides,
  });
  holds.register();
  return holds;
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], actor?: EventActor): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: INC,
    type,
    v: 1,
    source: 'slack',
    ...(actor === undefined ? {} : { actor }),
    occurredAt: new Date(now).toISOString(),
    payload,
  } as unknown as NewEvent<T>;
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

/** Appends and returns the seq of the last event. */
async function append(...events: NewEvent[]): Promise<number> {
  const last = (await log()).at(-1)?.seq ?? 0;
  return (await state.append(INC, events, last)).seq;
}

async function filed(level: AutonomyLevel = 2): Promise<void> {
  await append(
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Staging looks broken',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: 'Staging 500', priority: 'High', labels: [], autonomyLevel: level }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  );
}

function comment(intent: EventPayloads['comment']['intent'], actor: EventActor, environment?: string): NewEvent<'comment'> {
  return ev(
    'comment',
    { intent, platform: 'slack', signalSource: 'message', confidence: 1, raw: intent, ...(environment === undefined ? {} : { environment }) },
    actor,
  );
}

async function advance(ms: number): Promise<void> {
  now += ms;
  await wf.drain();
}

/** Appends one event and tells the module, as whatever appends a signal does. */
async function signal(holds: Holds, event: NewEvent): Promise<number> {
  const seq = await append(event);
  await holds.onEvent(INC, seq);
  return seq;
}

async function outbox(target: 'jira' | 'github'): Promise<OutboxItem[]> {
  return (await state.drainOutbox(target, 100)).filter((r) => r.incidentId === INC && r.op !== 'update-fields');
}

const texts = (rows: OutboxItem[]): string[] => rows.map((r) => String(r.payload['text']));
const types = async (): Promise<EventType[]> => (await log()).map((e) => e.type);

describe('environment hold (A 2.3)', () => {
  it('a claim on an environment appends held and comments on the ticket and the PR', async () => {
    const holds = holdsWith();
    await filed();
    await append(ev('pr-opened', { prNumber: 17, branch: 'fix/WEB-1042' }, DANA));
    await signal(holds, comment('claim', DANA, 'staging'));

    const held = (await log()).find((e) => e.type === 'held');
    expect(held?.payload).toMatchObject({ kind: 'environment', env: 'staging', claimerId: DANA.id });
    expect((held?.payload as { expiresAt: string }).expiresAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(activeHolds(await log()).map((h) => h.env)).toEqual(['staging']);

    const ticket = texts(await outbox('jira'));
    expect(ticket).toContain('Do not redeploy staging: @dana is investigating there as of 9:00 AM UTC.');
    const pr = await outbox('github');
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({ op: 'add-comment', payload: { repo: 'fake-org/web', prNumber: 17 } });
    expect(String(pr[0]?.payload['text'])).toContain('Do not redeploy staging');
    // The next step is not a deploy at this point, so no waiting line.
    expect(await types()).not.toContain('waiting-changed');
  });

  it('adds a waiting line on the holder when the next step deploys there, and clears it on release', async () => {
    const holds = holdsWith({ waitsOnEnvironment: (env) => env === 'staging' });
    await filed();
    const seq = await signal(holds, comment('claim', DANA, 'staging'));
    const waiting = (await log()).find((e) => e.seq > seq - 1 && e.type === 'waiting-changed');
    expect(waiting?.payload).toEqual({ waitingOn: { kind: 'hold', who: DANA.id } });
    expect((await state.getIncident(INC))?.waitingOn).toMatchObject({ kind: 'hold', who: DANA.id });

    await signal(holds, comment('release', DANA));
    expect((await state.getIncident(INC))?.waitingOn).toBeUndefined();
  });

  it('a second claim on a held environment sets nothing', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, comment('claim', DANA, 'staging'));
    await signal(holds, comment('claim', SAM, 'staging'));
    expect((await log()).filter((e) => e.type === 'held')).toHaveLength(1);
    expect(activeHolds(await log())[0]?.holderId).toBe(DANA.id);
  });

  it('nudges at half of holdExpiry, then releases the hold at the full span, on the hold key', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, comment('claim', DANA, 'staging'));
    expect(scheduled.at(-1)).toEqual({ name: 'timer.hold', key: timerKey('hold', { incidentId: INC, env: 'staging' }) });

    await advance(HOUR - MINUTE);
    expect(said).toEqual([]);
    await advance(MINUTE);
    expect(said).toEqual([{ text: "@dana, still on staging? I'll assume you're done in an hour.", mentionUserId: DANA.id }]);
    expect(activeHolds(await log())).toHaveLength(1);

    await advance(HOUR - MINUTE);
    expect(activeHolds(await log())).toHaveLength(1);
    await advance(MINUTE);
    expect(activeHolds(await log())).toEqual([]);
    const end = (await log()).find((e) => e.type === 'released');
    expect(end?.payload).toEqual({ scope: 'hold', env: 'staging', reason: 'expired' });
    expect(said).toHaveLength(2);
    expect(said[1]?.text).toContain('the hold on staging has expired');
    expect(released).toEqual([{ seq: end?.seq, scope: 'hold' }]);
    expect(texts(await outbox('jira')).at(-1)).toContain('The hold on staging is released');
  });

  it('activity from the holder resets the timers; anyone else is not activity', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, comment('claim', DANA, 'staging'));
    await advance(90 * MINUTE);
    expect(said).toHaveLength(1); // the nudge at one hour

    await signal(holds, ev('comment', { intent: 'none', platform: 'slack', signalSource: 'message', confidence: 1, raw: 'still poking at it' }, DANA));
    await advance(30 * MINUTE); // the original expiry has passed
    expect(activeHolds(await log())).toHaveLength(1);
    expect(said).toHaveLength(1);

    await signal(holds, ev('comment', { intent: 'none', platform: 'slack', signalSource: 'message', confidence: 1, raw: 'hello' }, SAM));
    await advance(30 * MINUTE); // one hour after Dana's message: the nudge again
    expect(said).toHaveLength(2);
    await advance(HOUR);
    expect(activeHolds(await log())).toEqual([]);
  });

  it('release or not-a-bug from the holder ends the hold at once; from anyone else it does not', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, comment('claim', DANA, 'staging'));
    await signal(holds, comment('release', SAM));
    expect(activeHolds(await log())).toHaveLength(1);

    await signal(holds, comment('release', DANA));
    expect(activeHolds(await log())).toEqual([]);
    expect((await log()).filter((e) => e.type === 'released').map((e) => e.payload)).toEqual([{ scope: 'hold', env: 'staging', reason: 'requested' }]);
    // The timer is gone: nothing fires later.
    await advance(3 * HOUR);
    expect(said).toEqual([]);

    await signal(holds, comment('claim', DANA, 'qa'));
    await signal(holds, comment('not-a-bug', DANA));
    expect(activeHolds(await log())).toEqual([]);
  });

  it('a closed incident stops the timers', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, comment('claim', DANA, 'staging'));
    await signal(holds, ev('not-a-bug', {}, DANA));
    await advance(3 * HOUR);
    expect(said).toEqual([]);
  });
});

describe('claim expiry (A 2.4)', () => {
  const claimed = (): NewEvent<'claimed'> => ev('claimed', { claimerId: DANA.id, expiresAt: new Date(now + 4 * HOUR).toISOString() }, DANA);

  it('prompts once at claims.expiry, then returns the incident to its level after an hour', async () => {
    const holds = holdsWith();
    await filed(2);
    await signal(holds, claimed());
    expect(scheduled.at(-1)).toEqual({ name: 'timer.claim-nudge', key: timerKey('claim-nudge', { incidentId: INC, userId: DANA.id }) });

    await advance(4 * HOUR - MINUTE);
    expect(said).toEqual([]);
    await advance(MINUTE);
    expect(said).toEqual([{ text: '@dana, still on WEB-1042? React 👀 to keep it, or I can take it.', mentionUserId: DANA.id }]);
    expect(scheduled.at(-1)).toEqual({ name: 'timer.claim-expiry', key: timerKey('claim', { incidentId: INC, userId: DANA.id }) });

    await advance(HOUR - MINUTE);
    expect(said).toHaveLength(1);
    expect(await types()).not.toContain('released');
    await advance(MINUTE);
    const end = (await log()).find((e) => e.type === 'released');
    expect(end?.payload).toEqual({ scope: 'claim', claimerId: DANA.id, reason: 'expired', restoredLevel: 2 });
    expect(said).toHaveLength(2);
    expect(said[1]?.text).toBe('@dana did not answer, so WEB-1042 is back at autonomy level 2.');
    expect(released).toEqual([{ seq: end?.seq, scope: 'claim' }]);
    expect(texts(await outbox('jira')).at(-1)).toContain('back at autonomy level 2');

    await advance(10 * HOUR);
    expect(said).toHaveLength(2);
  });

  it('activity before the prompt pushes it back; an answer to the prompt keeps the claim', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, claimed());
    await advance(3 * HOUR);
    await signal(holds, ev('comment', { intent: 'none', platform: 'slack', signalSource: 'message', confidence: 1, raw: 'found it' }, DANA));
    await advance(2 * HOUR); // past the original four hours
    expect(said).toEqual([]);
    await advance(2 * HOUR); // four hours after the message
    expect(said).toHaveLength(1);

    await advance(30 * MINUTE);
    await signal(holds, comment('claim', DANA)); // the 👀
    await advance(2 * HOUR);
    expect(await types()).not.toContain('released');
    expect(said).toHaveLength(1);
    await advance(2 * HOUR); // four hours after the 👀: prompted again
    expect(said).toHaveLength(2);
    await advance(HOUR);
    expect(await types()).toContain('released');
  });

  it('does nothing once the claim has been handed back or the fixer has started', async () => {
    const holds = holdsWith();
    await filed();
    await signal(holds, claimed());
    await signal(holds, ev('let-agent-take', { claimerId: DANA.id }, DANA));
    await advance(6 * HOUR);
    expect(said).toEqual([]);
    expect(await types()).not.toContain('released');

    // A claim after the fixer started holds nothing (A 2.2), so a timer left over from it does nothing.
    await append(ev('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }, undefined));
    await signal(holds, claimed());
    await advance(6 * HOUR);
    expect(said).toEqual([]);
  });

  it('counts business hours when configured, and wall clock time when not', async () => {
    const hours: BusinessHours = { tz: 'UTC', from: '09:00', to: '17:00' };
    now = Date.parse('2026-10-02T16:00:00.000Z'); // Friday, an hour before close
    const holds = holdsWith({ claims: { expiry: 'PT4H', holdExpiry: 'PT2H', businessHoursOnly: true }, businessHours: hours });
    await filed();
    await signal(holds, claimed());

    // 1 h Friday, then 3 h from Monday 09:00: Monday 12:00.
    await advance(24 * HOUR + 7 * HOUR + 59 * MINUTE); // Saturday 23:59
    expect(said).toEqual([]);
    now = Date.parse('2026-10-05T11:59:00.000Z');
    await wf.drain();
    expect(said).toEqual([]);
    await advance(MINUTE);
    expect(said).toHaveLength(1);
  });
});

describe('addBusinessTime', () => {
  const hours: BusinessHours = { tz: 'UTC', from: '09:00', to: '17:00' };
  const at = (iso: string): number => Date.parse(iso);

  it('stays within the day when it fits', () => {
    expect(addBusinessTime(at('2026-10-02T10:00:00Z'), 4 * HOUR, hours)).toBe(at('2026-10-02T14:00:00Z'));
  });

  it('carries the rest to the next business day', () => {
    expect(addBusinessTime(at('2026-10-02T15:00:00Z'), 4 * HOUR, hours)).toBe(at('2026-10-05T11:00:00Z'));
  });

  it('starts counting at the opening time when begun outside hours', () => {
    expect(addBusinessTime(at('2026-10-03T12:00:00Z'), HOUR, hours)).toBe(at('2026-10-05T10:00:00Z'));
    expect(addBusinessTime(at('2026-10-02T05:00:00Z'), HOUR, hours)).toBe(at('2026-10-02T10:00:00Z'));
  });

  it('reads the window in its time zone', () => {
    const ny: BusinessHours = { tz: 'America/New_York', from: '09:00', to: '17:00' };
    // 14:00 UTC is 10:00 in New York (EDT): two hours still fit before 17:00 local (21:00 UTC).
    expect(addBusinessTime(at('2026-10-02T14:00:00Z'), 2 * HOUR, ny)).toBe(at('2026-10-02T16:00:00Z'));
    // 20:00 UTC is 16:00 local: one hour left today, the next on Monday 09:00 local (13:00 UTC).
    expect(addBusinessTime(at('2026-10-02T20:00:00Z'), 2 * HOUR, ny)).toBe(at('2026-10-05T14:00:00Z'));
  });

  it('rejects a window that cannot hold time', () => {
    expect(() => addBusinessTime(T0, HOUR, { tz: 'UTC', from: '17:00', to: '09:00' })).toThrow(RangeError);
    expect(() => addBusinessTime(T0, HOUR, { tz: 'UTC', from: '9am', to: '17:00' })).toThrow(RangeError);
  });
});

// A handler that gets a job it should not has to say so, not fail silently.
describe('timer job data', () => {
  it('a malformed hold timer job is an error', async () => {
    holdsWith();
    await wf.start('timer.hold', { nope: true }, {});
    await wf.drain();
    expect(errors).toHaveLength(1);
    errors = [];
  });
});
