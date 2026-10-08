import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EVENT_TYPES,
  isEventType,
  type EventPayloads,
  type EventType,
  type IncidentEvent,
  type NewEvent,
} from '../../src/contracts/events.ts';
import type { InteractiveCard } from '../../src/contracts/adapters.ts';
import type { IncidentEvent as SignalsIncidentEvent, SignalEvent } from '../../src/contracts/signals.ts';
import type { IncidentActor } from '../../src/contracts/incident.ts';

const WS = '01JZ00000000000000000000W1';
const INC = '01JZ0000000000000000000002';
const ART = { artifactId: '01JZ00000000000000000000A1', version: 1 };
const REPORTER: IncidentActor = { id: 'U0FAKEREPORTER', name: 'Fake Reporter', role: 'reporter' };
const SHA = '0000000000000000000000000000000000000001';
const LATER = '2026-10-01T12:00:00.000Z';

// One valid payload per event type. `satisfies` makes this exhaustive at the type level: a new
// EventType without a payload entry, or a stale entry, fails `pnpm lint` (typecheck).
const SAMPLES = {
  captured: {
    kind: 'incident',
    idempotencyKey: 'slack:C0FAKE:1730000000.000100',
    source: 'slack',
    reporter: REPORTER,
    anchorText: 'checkout total is blank',
    anchorId: '1730000000.000100',
    channelId: 'C0FAKE',
    rawPayloadSnapshot: { text: 'checkout total is blank' },
  },
  'context-assembled': { bundle: ART, includedCount: 4, excludedCount: 1 },
  resolved: { surfaceId: 'checkout', repo: 'fake-org/web', resolvedBy: 'vocabulary', confidence: 0.9 },
  'dedupe-checked': { candidates: [], decision: 'none' },
  clarified: { audience: 'reporter', question: 'Which page?', answer: 'cart', timedOut: false },
  planned: {
    action: 'create_issue',
    projectKey: 'WEB',
    issueType: 'Bug',
    summary: 'Checkout total blank',
    priority: 'High',
    labels: ['snapwing'],
    autonomyLevel: 2,
    implementationRequest: ART,
  },
  filed: { jiraKey: 'WEB-1042' },
  claimed: { claimerId: 'U0FAKEENG', expiresAt: LATER },
  'fixer-started': { runId: '01JZ00000000000000000000R1', harness: 'claude-code', attempt: 1 },
  'pr-opened': { prNumber: 7, branch: 'fix/WEB-1042' },
  'review-passed': { prNumber: 7, review: ART },
  'review-failed': { prNumber: 7, verdict: 'request-changes', reason: 'missing test' },
  'ci-green': { prNumber: 7, headSha: SHA },
  'ci-red': { prNumber: 7, headSha: SHA, failingChecks: ['unit'] },
  merged: { prNumber: 7, mergeCommitSha: SHA, levelAtMergeTime: 3 },
  'deployed:staging': { commitSha: SHA },
  verified: { env: 'staging' },
  'deployed:production': { commitSha: SHA, deploymentId: 'dep-1' },
  closed: {},
  escalated: { intent: 'escalate', step: 1, action: 'mention', score: 3 },
  stopped: { reason: 'stop reaction' },
  released: { scope: 'claim', claimerId: 'U0FAKEENG', reason: 'expired', restoredLevel: 2 },
  held: { kind: 'environment', env: 'staging', claimerId: 'U0FAKEENG', expiresAt: LATER },
  comment: {
    intent: 'escalate',
    platform: 'slack',
    signalSource: 'reaction',
    target: { role: 'anchor', messageId: '1730000000.000100' },
    confidence: 1,
    raw: 'fire',
    count: { weight: 1, windowEndsAt: LATER },
  },
  'level-changed': { from: 2, to: 1, reason: 'claim' },
  reverted: { prNumber: 7, revertPrNumber: 8 },
  'resolution-signal': { messageId: '1730000000.000200', text: 'nvm works now' },
  'linked-to-existing': { issueKey: 'WEB-1000' },
  'not-a-bug': { reason: 'expected behaviour' },
  'let-agent-take': { claimerId: 'U0FAKEENG' },
  tapped: { eventId: 'card-1', card: 'dedupe', choice: 'link' },
  'scope-changed': { choice: 'widen', bundle: { artifactId: ART.artifactId, version: 2 }, includedCount: 6, excludedCount: 1 },
  'dedupe-decided': { decision: 'link', issueKey: 'WEB-1000' },
  'clarify-answered': { questionSeq: 5, answer: 'Website', appliesTo: { field: 'surface', id: 'web' } },
  corrected: { correctsSeq: 3, fields: { surfaceId: 'cart' }, reason: 'wrong surface' },
  'status-message-posted': { messageId: '1730000000.000300' },
  'waiting-changed': { waitingOn: { kind: 'human', who: 'U0FAKEENG' } },
  'monitoring-started': { qualifiedBy: 'priority' },
  'monitoring-stopped': { reason: 'downgraded' },
  'jira-priority-changed': { jiraKey: 'WEB-1042', from: 'High', to: 'Highest' },
  'jira-assignee-changed': { jiraKey: 'WEB-1042', to: 'fake-account-id' },
  'jira-transitioned': { jiraKey: 'WEB-1042', from: 'To Do', to: 'In Progress' },
  'fixer-checkpoint': { phase: 'branched', detail: 'fix/WEB-1042' },
  'fixer-artifact': { kind: 'diagnosis', artifact: ART },
  'fixer-done': { prNumber: 7, branch: 'fix/WEB-1042', summary: 'restore total', testsAdded: ['test/cart.test.ts', 'test/total.test.ts'] },
  'fixer-failed': { reason: 'tests red', partialBranch: 'fix/WEB-1042', attempts: 2 },
  'bot-message-posted': { platform: 'slack', channel: 'C0FAKEBUGS', messageId: '1730000000.000400', role: 'fix-preview' },
  'escalation-ladder': { phase: 'step', ladder: 'outage', step: 3, after: 'PT60M', pagerduty: 'PFAKE01', paged: true },
  'user-side': { kind: 'wrong-environment', evidence: 'URL bar shows staging.example.com', questionSeq: 5, surfaceId: 'web' },
  'text-signal': { kind: 'environment', messageId: '1730000000.000900', text: 'happening on prod too', confidence: 1, env: 'production', from: 'staging', priority: { from: 'Medium', to: 'High' } },
  'capture-cancelled': { card: 'file-confirm' },
} as const satisfies { readonly [K in EventType]: EventPayloads[K] };

describe('EVENT_TYPES', () => {
  it('has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('has a payload entry for every member, and no extra entries', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });

  it('covers the names the acceptance criteria call out', () => {
    const required: EventType[] = [
      'stopped', 'escalated', 'level-changed', 'held', 'released', 'reverted', 'corrected',
      'jira-priority-changed', 'jira-assignee-changed', 'jira-transitioned',
      'fixer-checkpoint', 'fixer-artifact', 'fixer-done', 'fixer-failed', 'tapped',
    ];
    for (const t of required) expect(EVENT_TYPES).toContain(t);
  });

  it('models the parameterized A 4.2 names without a suffix', () => {
    expect(isEventType('held')).toBe(true);
    expect(isEventType('comment')).toBe(true);
    expect(isEventType('held:staging')).toBe(false);
    expect(isEventType('comment:escalate')).toBe(false);
  });
});

describe('isEventType', () => {
  it('accepts every catalog member', () => {
    for (const t of EVENT_TYPES) expect(isEventType(t)).toBe(true);
  });

  it('rejects unknown names', () => {
    for (const s of ['', 'Captured', 'deployed', 'deployed:qa', 'toString', 'fixer']) {
      expect(isEventType(s)).toBe(false);
    }
  });
});

describe('IncidentEvent', () => {
  function event<T extends EventType>(type: T, payload: EventPayloads[T], seq: number): IncidentEvent<T> {
    const e = {
      workspaceId: WS,
      incidentId: INC,
      seq,
      v: 1,
      source: 'agent',
      occurredAt: '2026-10-01T10:00:00.000Z',
      recordedAt: '2026-10-01T10:00:00.010Z',
      type,
      payload,
    };
    return e as IncidentEvent<T>;
  }

  it('narrows the payload on type', () => {
    const log: IncidentEvent[] = EVENT_TYPES.map((t, i) => event(t, SAMPLES[t], i + 1));
    const envs: string[] = [];
    for (const e of log) {
      if (e.type === 'held' && e.payload.kind === 'environment') envs.push(e.payload.env);
      if (e.type === 'comment') expectTypeOf(e.payload.intent).toEqualTypeOf<EventPayloads['comment']['intent']>();
    }
    expect(envs).toEqual(['staging']);
  });

  it('survives a JSON round trip, as it would through the jsonb payload column', () => {
    for (const t of EVENT_TYPES) {
      const e = event(t, SAMPLES[t], 1);
      expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    }
  });

  it('accepts an IncidentActor as actor', () => {
    const e: IncidentEvent<'claimed'> = { ...event('claimed', SAMPLES.claimed, 2), actor: REPORTER };
    expect(e.actor?.id).toBe(REPORTER.id);
  });

  it('is the IncidentEvent that signals.ts re-exports', () => {
    expectTypeOf<SignalsIncidentEvent>().toEqualTypeOf<IncidentEvent>();
  });
});

describe('NewEvent', () => {
  it('omits seq and recordedAt and keeps the discriminant', () => {
    const n: NewEvent<'filed'> = {
      workspaceId: WS,
      incidentId: INC,
      v: 1,
      source: 'jira',
      occurredAt: '2026-10-01T10:00:00.000Z',
      type: 'filed',
      payload: { jiraKey: 'WEB-1042' },
    };
    expect(n.type).toBe('filed');
    expectTypeOf<NewEvent>().not.toHaveProperty('seq');
    expectTypeOf<NewEvent>().not.toHaveProperty('recordedAt');
    expectTypeOf<NewEvent<'held'>['payload']>().toEqualTypeOf<EventPayloads['held']>();
  });

  it('rejects a payload that does not match its type', () => {
    const bad: NewEvent<'filed'> = {
      workspaceId: WS,
      incidentId: INC,
      v: 1,
      source: 'jira',
      occurredAt: '2026-10-01T10:00:00.000Z',
      type: 'filed',
      // @ts-expect-error filed carries jiraKey, not prNumber
      payload: { prNumber: 7 },
    };
    expect(bad.type).toBe('filed');
  });
});

describe('catalog follow-ups', () => {
  it('types the tapped payload from the card kinds and the approval actions', () => {
    expectTypeOf<EventPayloads['tapped']['card']>().toEqualTypeOf<InteractiveCard['kind']>();
    const approve: EventPayloads['tapped'] = { eventId: 'c1', card: 'fix-preview', choice: 'approve_fix' };
    const clarify: EventPayloads['tapped'] = { eventId: 'c2', card: 'clarify', choice: 'Checkout page' };
    expect([approve.choice, clarify.choice]).toEqual(['approve_fix', 'Checkout page']);
  });

  it('accepts jira as a comment platform through SignalEvent', () => {
    expectTypeOf<SignalEvent['platform']>().toEqualTypeOf<'slack' | 'teams' | 'jira'>();
    expectTypeOf<EventPayloads['comment']['platform']>().toEqualTypeOf<SignalEvent['platform']>();
  });

  it('lists file paths in fixer-done testsAdded, as HarnessResult does', () => {
    expectTypeOf<EventPayloads['fixer-done']['testsAdded']>().toEqualTypeOf<string[]>();
  });
});

describe('decision events (ADR 0015)', () => {
  it('records card decisions as their own events, not corrections', () => {
    for (const t of ['scope-changed', 'dedupe-decided', 'clarify-answered'] as const) expect(EVENT_TYPES).toContain(t);
    expectTypeOf<EventPayloads['scope-changed']['choice']>().toEqualTypeOf<'widen' | 'narrow'>();
    expectTypeOf<EventPayloads['dedupe-decided']['decision']>().toEqualTypeOf<'link' | 'create-anyway' | 'not-related'>();
    expectTypeOf<EventPayloads['clarify-answered']['appliesTo']>().toEqualTypeOf<{ field: 'surface' | 'component'; id: string } | undefined>();
  });

  it('references the full triage plan from planned', () => {
    const planned: EventPayloads['planned'] = { ...SAMPLES.planned, labels: [...SAMPLES.planned.labels], plan: ART, degraded: 'unresolved-surface' };
    expect(planned.plan).toEqual(ART);
  });
});
