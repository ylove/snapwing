import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type EventType, type IncidentEvent } from '../../src/contracts/events.ts';
import {
  INITIAL_STATUS,
  LIFECYCLE_STATUSES,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isValidTransition,
  nextStatus,
  type LifecycleStatus,
} from '../../src/lifecycle/machine.ts';

/** Only `type` (and, for `held`, the payload kind) matters to the reducer; the rest is obvious filler. */
function ev(type: EventType, payload: Record<string, unknown> = {}): IncidentEvent {
  return {
    workspaceId: 'ws-test',
    incidentId: 'inc-test',
    seq: 1,
    v: 1,
    source: 'agent',
    occurredAt: '2026-10-01T00:00:00Z',
    recordedAt: '2026-10-01T00:00:00Z',
    type,
    payload,
  } as unknown as IncidentEvent;
}

const gateHold = ev('held', { kind: 'gate', reason: 'merge gate' });
const envHold = ev('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-01T02:00:00Z' });

type Row = [from: LifecycleStatus, event: IncidentEvent, to: LifecycleStatus];

const ARROWS: Row[] = [
  // Intake
  ['captured', ev('context-assembled'), 'assembling'],
  ['captured', ev('resolution-signal'), 'not-filed'],
  ['assembling', ev('resolved'), 'resolved'],
  ['assembling', ev('resolution-signal'), 'not-filed'],
  ['resolved', ev('dedupe-checked'), 'deduped'],
  ['deduped', ev('linked-to-existing'), 'linked-to-existing'],
  ['deduped', ev('clarified'), 'deduped'],
  ['deduped', ev('resolved'), 'deduped'], // a clarify answer re-resolves (ADR 0015)
  ['deduped', ev('planned'), 'planned'],
  ['planned', ev('filed'), 'filed'],
  ['deduped', ev('not-a-bug'), 'not-a-bug'],
  // Claim and fix
  ['filed', ev('claimed'), 'claimed'],
  ['filed', ev('fixer-started'), 'fixing'],
  ['claimed', ev('released'), 'fixing'],
  ['claimed', ev('let-agent-take'), 'fixing'],
  ['claimed', ev('jira-transitioned'), 'human-fixing'],
  ['claimed', ev('not-a-bug'), 'not-a-bug'], // the claim card's Not a bug (A 2.1)
  ['human-fixing', ev('pr-opened'), 'in-review'],
  ['human-fixing', ev('let-agent-take'), 'fixing'],
  ['fixing', ev('pr-opened'), 'in-review'],
  ['fixing', ev('fixer-started'), 'fixing'],
  ['fixing', ev('fixer-done'), 'fixing'],
  ['fixing-retry', ev('fixer-started'), 'fixing-retry'],
  ['fixing-retry', ev('fixer-done'), 'fixing-retry'],
  // Review and CI, first pass
  ['in-review', ev('review-passed'), 'ci'],
  ['in-review', ev('review-failed'), 'fixing-retry'],
  ['ci', ev('ci-green'), 'mergeable'],
  ['ci', ev('ci-red'), 'fixing-retry'],
  // Retry once, then escalate
  ['fixing-retry', ev('pr-opened'), 'in-review-retry'],
  ['in-review-retry', ev('review-passed'), 'ci-retry'],
  ['in-review-retry', ev('review-failed'), 'escalated'],
  ['ci-retry', ev('ci-green'), 'mergeable'],
  ['ci-retry', ev('ci-red'), 'escalated'],
  // A human's Request changes after the review passed (main 11.2)
  ['ci', ev('review-failed'), 'fixing-retry'],
  ['mergeable', ev('review-failed'), 'fixing-retry'],
  ['held', ev('review-failed'), 'fixing-retry'],
  ['ci-retry', ev('review-failed'), 'escalated'],
  ['fixing', ev('fixer-failed'), 'escalated'],
  ['fixing-retry', ev('fixer-failed'), 'escalated'],
  // Merge and deploy
  ['mergeable', ev('merged'), 'merged'],
  // A person merges before the review agent or CI finishes (main 11.2)
  ['in-review', ev('merged'), 'merged'],
  ['in-review-retry', ev('merged'), 'merged'],
  ['ci', ev('merged'), 'merged'],
  ['ci-retry', ev('merged'), 'merged'],
  ['held', ev('merged'), 'merged'],
  ['escalated', ev('merged'), 'merged'],
  ['mergeable', gateHold, 'held'],
  ['held', ev('released', { scope: 'hold', env: 'staging', reason: 'requested' }), 'mergeable'],
  ['merged', ev('deployed:staging'), 'deployed:staging'],
  ['deployed:staging', ev('verified'), 'deployed:staging'],
  ['deployed:staging', ev('deployed:production'), 'deployed:production'],
  ['deployed:production', ev('closed'), 'closed'],
  ['merged', ev('reverted'), 'reverted'],
  ['deployed:production', ev('reverted'), 'reverted'],
  ['reverted', ev('closed'), 'closed'],
  // At any state
  ['filed', ev('stopped'), 'stopped'],
  ['fixing', ev('stopped'), 'stopped'],
  // The `escalated` event is the A 1.4 reaction ladder (ADR 0018): it keeps the status
  ['mergeable', ev('escalated'), 'mergeable'],
  ['captured', ev('escalated'), 'captured'],
  ['planned', ev('escalated'), 'planned'],
  ['linked-to-existing', ev('escalated'), 'linked-to-existing'],
  // Stopped accepts what filed accepts
  ['stopped', ev('filed'), 'filed'],
  ['stopped', ev('claimed'), 'claimed'],
  ['stopped', ev('fixer-started'), 'fixing'],
  ['stopped', ev('pr-opened'), 'in-review'],
  ['stopped', ev('not-a-bug'), 'not-a-bug'],
  ['stopped', ev('closed'), 'closed'],
  // Leaving escalated
  ['escalated', ev('claimed'), 'claimed'],
  ['escalated', ev('fixer-started'), 'fixing'],
  ['escalated', ev('pr-opened'), 'in-review'],
  // Non-state-changing events keep the status
  ['fixing', ev('comment'), 'fixing'],
  ['mergeable', envHold, 'mergeable'],
  ['closed', ev('comment'), 'closed'],
  ['deduped', ev('tapped'), 'deduped'],
  ['closed', ev('tapped'), 'closed'],
  ['filed', ev('level-changed'), 'filed'],
  ['filed', ev('jira-priority-changed'), 'filed'],
  ['fixing', ev('fixer-checkpoint'), 'fixing'],
];

const INVALID: Row[] = [
  ['captured', ev('merged'), 'captured'],
  ['filed', ev('review-passed'), 'filed'],
  ['fixing', ev('ci-green'), 'fixing'],
  ['closed', ev('fixer-started'), 'closed'],
  ['filed', ev('fixer-done'), 'filed'],
  ['in-review', ev('fixer-done'), 'in-review'],
  ['in-review', ev('fixer-started'), 'in-review'],
  ['closed', ev('fixer-done'), 'closed'],
  ['not-filed', ev('stopped'), 'not-filed'],
  ['filed', ev('reverted'), 'filed'],
  ['resolved', ev('captured'), 'resolved'],
];

describe('lifecycle machine', () => {
  it.each(ARROWS.map((r, i) => [i, r[0], r[1].type, r[2], r] as const))(
    'arrow %i: %s + %s -> %s',
    (_i, from, _type, to, row) => {
      expect(nextStatus(from, row[1])).toBe(to);
      expect(isValidTransition(from, row[1])).toBe(true);
    },
  );

  it('has at least 30 arrow rows and 5 invalid rows', () => {
    expect(ARROWS.length).toBeGreaterThanOrEqual(30);
    expect(INVALID.length).toBeGreaterThanOrEqual(5);
  });

  it.each(INVALID.map((r, i) => [i, r[0], r[1].type, r] as const))(
    'invalid %i: %s + %s returns current and is not valid',
    (_i, from, _type, row) => {
      expect(() => nextStatus(from, row[1])).not.toThrow();
      expect(nextStatus(from, row[1])).toBe(from);
      expect(isValidTransition(from, row[1])).toBe(false);
    },
  );

  it.each(['status-message-posted', 'waiting-changed', 'monitoring-started', 'monitoring-stopped', 'scope-changed', 'dedupe-decided', 'clarify-answered', 'bot-message-posted'] as const)(
    '%s is valid and status-preserving in every status',
    (type) => {
      for (const status of LIFECYCLE_STATUSES) {
        expect(isValidTransition(status, ev(type))).toBe(true);
        expect(nextStatus(status, ev(type))).toBe(status);
      }
    },
  );

  it('a new incident starts at captured and its captured event is valid there', () => {
    expect(INITIAL_STATUS).toBe('captured');
    expect(nextStatus('captured', ev('captured'))).toBe('captured');
    expect(isValidTransition('captured', ev('captured'))).toBe(true);
  });

  it('terminal statuses are exactly closed, not-filed, not-a-bug, linked-to-existing', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['closed', 'linked-to-existing', 'not-a-bug', 'not-filed']);
    expect(isTerminalStatus('stopped')).toBe(false);
  });

  it('no event leaves a terminal status', () => {
    for (const status of TERMINAL_STATUSES) {
      for (const type of EVENT_TYPES) {
        expect(nextStatus(status, ev(type))).toBe(status);
      }
    }
  });

  it('is total: every status and every event type returns a known status without throwing', () => {
    const known = new Set<string>(LIFECYCLE_STATUSES);
    for (const status of LIFECYCLE_STATUSES) {
      for (const type of EVENT_TYPES) {
        const event = ev(type);
        expect(known.has(nextStatus(status, event))).toBe(true);
        expect(typeof isValidTransition(status, event)).toBe('boolean');
      }
    }
  });

  it('is pure: the same inputs give the same answer and the event is not mutated', () => {
    const event = ev('review-failed');
    const before = JSON.stringify(event);
    expect(nextStatus('in-review', event)).toBe(nextStatus('in-review', event));
    expect(JSON.stringify(event)).toBe(before);
  });

  it('review-failed and ci-red retry once, then escalate (full runs)', () => {
    const run = (events: IncidentEvent[]): LifecycleStatus =>
      events.reduce<LifecycleStatus>((s, e) => nextStatus(s, e), 'fixing');
    expect(run([ev('pr-opened'), ev('review-failed')])).toBe('fixing-retry');
    expect(run([ev('pr-opened'), ev('review-failed'), ev('pr-opened'), ev('review-failed')])).toBe('escalated');
    expect(run([ev('pr-opened'), ev('review-passed'), ev('ci-red'), ev('pr-opened'), ev('review-passed'), ev('ci-red')])).toBe(
      'escalated',
    );
    expect(run([ev('pr-opened'), ev('review-failed'), ev('pr-opened'), ev('review-passed'), ev('ci-green')])).toBe(
      'mergeable',
    );
  });
});
