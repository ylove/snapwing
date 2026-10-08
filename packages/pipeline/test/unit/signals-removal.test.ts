// Reaction removal (A 1.6): the plan for each removed intent, and that the projections the plan
// leans on (scores, subscriptions) behave as A 1.6 says. Pure; no database.

import { describe, expect, it } from 'vitest';
import type { EventActor, IncidentEvent } from '../../src/contracts/events.ts';
import type { Intent, TargetRole } from '../../src/contracts/signals.ts';
import { foldScores, type ScoreRow } from '../../src/state/projections/escalation.ts';
import { foldIncidentSubscriptions } from '../../src/state/projections/subscriptions.ts';
import { planRemoval, TRIGGER_STOP_WINDOW_MS, type RemovalInput } from '../../src/signals/removal.ts';

const WS = 'ws1';
const INC = 'inc1';
const MSG = '1700000000.000100';
const T0 = Date.parse('2026-10-03T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const pat: EventActor = { id: 'U_PAT', role: 'reporter', name: 'Pat' };
const sam: EventActor = { id: 'U_SAM', role: 'reporter', name: 'Sam' };
const dana: EventActor = { id: 'U_DANA', role: 'engineer', name: 'Dana' };

let seq = 0;
function comment(
  actor: EventActor,
  intent: Intent,
  source: 'reaction' | 'reaction-removed',
  offsetMs: number,
  extra: { effect?: string; messageId?: string; weight?: number } = {},
): IncidentEvent<'comment'> {
  seq += 1;
  return {
    workspaceId: WS,
    incidentId: INC,
    seq,
    v: 1,
    source: 'slack',
    actor,
    occurredAt: at(offsetMs),
    recordedAt: at(offsetMs),
    type: 'comment',
    payload: {
      intent,
      platform: 'slack',
      signalSource: source,
      target: { role: 'anchor', messageId: extra.messageId ?? MSG },
      confidence: 1,
      raw: 'x',
      ...(extra.effect === undefined ? {} : { effect: extra.effect }),
      ...(extra.weight === undefined ? {} : { count: { weight: extra.weight, windowEndsAt: at(7_200_000) } }),
    },
  };
}

function input(actor: EventActor, intent: Intent, role: TargetRole, offsetMs: number, log: IncidentEvent[], claimerIds: string[] = []): RemovalInput {
  return { workspaceId: WS, incidentId: INC, signal: { intent, actor, target: { messageId: MSG }, timestamp: at(offsetMs) }, role, log, claimerIds, source: 'slack' };
}

describe('removing claim', () => {
  it('releases the reactor claim', () => {
    const plan = planRemoval(input(dana, 'claim', 'anchor', 5_000, [comment(dana, 'claim', 'reaction', 0, { effect: 'hold' })], [dana.id]));
    expect(plan.effect).toBe('release');
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({ type: 'released', actor: dana, payload: { scope: 'claim', claimerId: dana.id, reason: 'requested' } });
  });

  it('releases only a claim the reactor holds (a reporter claim was a comment)', () => {
    const plan = planRemoval(input(pat, 'claim', 'anchor', 5_000, [comment(pat, 'claim', 'reaction', 0, { effect: 'comment' })], []));
    expect(plan.effect).toBe('removed');
    expect(plan.events).toEqual([]);
  });

  it('does not release another person claim', () => {
    const plan = planRemoval(input(sam, 'claim', 'anchor', 5_000, [], [dana.id]));
    expect(plan.events).toEqual([]);
  });
});

describe('removing watch', () => {
  it('unsubscribes: no event, the projection drops the subscription', () => {
    const add = comment(pat, 'watch', 'reaction', 0, { effect: 'watch' });
    const remove = comment(pat, 'watch', 'reaction-removed', 5_000, { effect: 'removed' });
    const plan = planRemoval(input(pat, 'watch', 'anchor', 5_000, [add]));
    expect(plan.effect).toBe('unsubscribe');
    expect(plan.events).toEqual([]);

    const subscribed = foldIncidentSubscriptions([], add);
    expect(subscribed.map((s) => s.userId)).toEqual([pat.id]);
    expect(foldIncidentSubscriptions(subscribed, remove)).toEqual([]);
  });

  it('leaves other watchers subscribed', () => {
    const subs = [comment(pat, 'watch', 'reaction', 0), comment(sam, 'watch', 'reaction', 1_000)].reduce(
      (acc, e) => foldIncidentSubscriptions(acc, e),
      [] as ReturnType<typeof foldIncidentSubscriptions>,
    );
    const after = foldIncidentSubscriptions(subs, comment(pat, 'watch', 'reaction-removed', 2_000));
    expect(after.map((s) => s.userId)).toEqual([sam.id]);
  });
});

describe('removing accept on a staging check', () => {
  const verify = (actor: EventActor, offsetMs = 0): IncidentEvent<'comment'> => comment(actor, 'accept', 'reaction', offsetMs, { effect: 'verify' });

  it('withdraws the verification and holds the dependent deploy', () => {
    const plan = planRemoval(input(pat, 'accept', 'staging-check', 60_000, [verify(pat)]));
    expect(plan.effect).toBe('withdraw');
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({ type: 'held', actor: pat, payload: { kind: 'gate', reason: expect.stringContaining('withdrawn by Pat') } });
  });

  it('does not hold while another reactor verification stands', () => {
    const plan = planRemoval(input(pat, 'accept', 'staging-check', 60_000, [verify(pat), verify(sam, 1_000)]));
    expect(plan.effect).toBe('removed');
    expect(plan.events).toEqual([]);
  });

  it('holds once the last standing verifier withdraws', () => {
    const log = [verify(pat), verify(sam, 1_000), comment(pat, 'accept', 'reaction-removed', 2_000, { effect: 'removed' })];
    expect(planRemoval(input(sam, 'accept', 'staging-check', 3_000, log)).effect).toBe('withdraw');
  });

  it('does nothing when the accept had not verified (not on staging, so it was a comment)', () => {
    const plan = planRemoval(input(pat, 'accept', 'staging-check', 60_000, [comment(pat, 'accept', 'reaction', 0, { effect: 'comment' })]));
    expect(plan.effect).toBe('removed');
    expect(plan.events).toEqual([]);
  });

  it('is only a recorded removal on any other target', () => {
    for (const role of ['anchor', 'pr', 'status', 'fix-preview'] as const) {
      const plan = planRemoval(input(pat, 'accept', role, 60_000, [verify(pat)]));
      expect(plan.effect).toBe('removed');
      expect(plan.events).toEqual([]);
    }
  });
});

describe('removing escalate', () => {
  it('lowers the score but never a priority already raised', () => {
    const add = (actor: EventActor, offset: number): IncidentEvent<'comment'> => comment(actor, 'escalate', 'reaction', offset, { effect: 'count', weight: actor.role === 'engineer' ? 1.5 : 1 });
    const adds = [add(pat, 0), add(sam, 1_000), add(dana, 2_000)];
    const reached: IncidentEvent = {
      workspaceId: WS, incidentId: INC, seq: ++seq, v: 1, source: 'slack', occurredAt: at(3_000), recordedAt: at(3_000),
      type: 'escalated', payload: { intent: 'escalate', score: 3.5, step: 3 },
    } as unknown as IncidentEvent;
    const rows = [...adds, reached].reduce<readonly ScoreRow[]>(foldScores, []);
    expect(rows[0]).toMatchObject({ score: 3.5, stepReached: 3 });

    const remove = comment(dana, 'escalate', 'reaction-removed', 9_000, { effect: 'removed', weight: 1.5 });
    const plan = planRemoval(input(dana, 'escalate', 'anchor', 9_000, [...adds, reached]));
    expect(plan.effect).toBe('lower');
    expect(plan.events).toEqual([]);
    expect(plan.lowersPriority).toBe(false);

    const after = foldScores(rows, remove);
    expect(after[0]).toMatchObject({ score: 2, stepReached: 3 });
    expect(after[0]?.reactorIds).not.toContain(dana.id);
  });
});

describe('removing trigger', () => {
  const trigger = comment(pat, 'trigger', 'reaction', 0, { effect: 'count', weight: 1 });

  it('within 60 s stays the existing Stop, owned by the adapter', () => {
    const plan = planRemoval(input(pat, 'trigger', 'anchor', 30_000, [trigger]));
    expect(plan).toMatchObject({ effect: 'stop', viaAdapter: true, events: [] });
  });

  it('at exactly 60 s is still a Stop; after it is only recorded', () => {
    expect(planRemoval(input(pat, 'trigger', 'anchor', TRIGGER_STOP_WINDOW_MS, [trigger])).effect).toBe('stop');
    const late = planRemoval(input(pat, 'trigger', 'anchor', TRIGGER_STOP_WINDOW_MS + 1, [trigger]));
    expect(late.effect).toBe('removed');
    expect(late.viaAdapter).toBeUndefined();
  });

  it('has no Stop for a reactor who never triggered on this message', () => {
    expect(planRemoval(input(sam, 'trigger', 'anchor', 10_000, [trigger])).effect).toBe('removed');
    const other = comment(sam, 'trigger', 'reaction', 0, { messageId: 'other' });
    expect(planRemoval(input(sam, 'trigger', 'anchor', 10_000, [other])).effect).toBe('removed');
  });
});

describe('other intents', () => {
  it('are recorded only', () => {
    for (const intent of ['reject', 'release', 'stop', 'not-a-bug'] as const) {
      const plan = planRemoval(input(pat, intent, 'anchor', 1_000, []));
      expect(plan).toEqual({ effect: 'removed', events: [], lowersPriority: false });
    }
  });
});
