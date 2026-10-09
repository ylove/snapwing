// Push notifications (A 4.4). The milestone mapping, the policy rule by rule (watchers, DM
// versus thread, forcePush, the reporter's staging request, quiet hours, the rate limit and the burst
// merge), and the `notify` outbox rows through `outboxFor`.

import { describe, expect, it } from 'vitest';
import { defaultPlaybook } from '../../src/config/playbook.ts';
import type { EventActor, EventPayloads, EventSource, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { IncidentView, OutboxItem, Subscription } from '../../src/contracts/state.ts';
import type { JiraPriorityName } from '../../src/map/types.ts';
import { milestoneFor, type Milestone } from '../../src/notify/milestone.ts';
import { planNotices, priorityAtLeast, quietEnd, type NotifyContext } from '../../src/notify/policy.ts';
import { foldIncident } from '../../src/state/projections/incidents.ts';
import { outboxFor } from '../../src/state/projections/outbox.ts';
import { NOTIFY_OP, notifyRows, windowFromRows, type NotifyRow } from '../../src/state/projections/outbox/notify.ts';
import { foldIncidentSubscriptions } from '../../src/state/projections/subscriptions.ts';

const WS = '01JZ0000000000000000000001';
const INC = '01JZ00000000000000000000A1';
const KEY = 'WEB-1042';
const REPORTER = 'U-FAKE-REPORTER';
const DANA: EventActor = { id: 'U-FAKE-DANA', role: 'engineer' };
const T0 = Date.parse('2026-10-01T15:00:00.000Z'); // 11:00 in New York: outside quiet hours

type Draft<T extends EventType> = { type: T; payload: EventPayloads[T]; actor?: EventActor; source?: EventSource };

function draft<T extends EventType>(type: T, payload: EventPayloads[T], actor?: EventActor, source?: EventSource): Draft<T> {
  return { type, payload, ...(actor === undefined ? {} : { actor }), ...(source === undefined ? {} : { source }) };
}

const prefix = (source: 'slack' | 'teams' | 'cli' = 'slack', priority: JiraPriorityName = 'High'): Draft<EventType>[] => [
  draft('captured', {
    kind: 'incident',
    idempotencyKey: `${source}:${INC}`,
    source,
    reporter: { id: REPORTER, name: 'Test Reporter', role: 'reporter' },
    anchorText: 'Checkout says 500',
    channelId: 'C-FAKE',
  }),
  draft('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 2, excludedCount: 0 }),
  draft('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
  draft('dedupe-checked', { candidates: [], decision: 'none' }),
  draft('planned', {
    action: 'create_issue',
    projectKey: 'WEB',
    issueType: 'Bug',
    summary: 'Checkout returns 500 on submit',
    priority,
    labels: ['snapwing'],
    autonomyLevel: 2,
    implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
  }),
];

/** Folds events one minute apart (or at `at`) and gives the hook's notify rows for each. */
class Script {
  view: IncidentView | undefined;
  before: IncidentView | undefined;
  last: IncidentEvent | undefined;
  seq = 0;
  clock = T0;

  push<T extends EventType>(d: Draft<T>, ctx?: NotifyContext, advanceMs = 60_000): OutboxItem[] {
    this.seq += 1;
    this.clock += advanceMs;
    const at = new Date(this.clock).toISOString();
    const event = {
      workspaceId: WS,
      incidentId: INC,
      seq: this.seq,
      v: 1,
      type: d.type,
      source: d.source ?? (d.actor === undefined ? 'agent' : 'slack'),
      ...(d.actor === undefined ? {} : { actor: d.actor }),
      occurredAt: at,
      recordedAt: at,
      payload: d.payload,
    } as unknown as IncidentEvent;
    this.before = this.view;
    const fold = foldIncident(this.before, event);
    if (fold.view === undefined) throw new Error(`no row after ${d.type}`);
    this.view = fold.view;
    this.last = event;
    return outboxFor(event, { before: this.before, after: fold.view, valid: fold.valid, ...(ctx === undefined ? {} : { notify: ctx }) }).filter(
      (r) => r.op === NOTIFY_OP,
    );
  }

  all(drafts: readonly Draft<EventType>[]): void {
    for (const d of drafts) this.push(d);
  }
}

const started = () => draft('fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 });
const prOpened = () => draft('pr-opened', { prNumber: 418, branch: 'fix/WEB-1042' }, undefined, 'github');

/** An incident captured from `source` (Slack by default) at `priority`, ready for the next event. */
function filedScript(source: 'slack' | 'teams' | 'cli' = 'slack', priority: JiraPriorityName = 'High'): Script {
  const s = new Script();
  s.all(prefix(source, priority));
  return s;
}

const filed = () => draft('filed', { jiraKey: KEY });

function sub(
  userId: string,
  scopeKind: Subscription['scopeKind'],
  scopeId: string | undefined,
  channel: Subscription['channel'] = 'thread',
  platform?: Subscription['platform'],
): Subscription {
  return {
    workspaceId: WS,
    userId,
    scopeKind,
    ...(scopeId === undefined ? {} : { scopeId }),
    channel,
    ...(platform === undefined ? {} : { platform }),
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function context(patch: Partial<NotifyContext> = {}, notifications: Partial<NotifyContext['playbook']> = {}): NotifyContext {
  return { playbook: { ...defaultPlaybook().notifications, ...notifications }, subscriptions: [], ...patch };
}

const payloadOf = (row: OutboxItem): NotifyRow => row.payload as unknown as NotifyRow;

// Milestones --------------------------------------------------------------------------------------

describe('milestones', () => {
  it('names filed, PR open, merged, staging, live, stopped, and failed, and nothing else', () => {
    const s = filedScript();
    const seen: (Milestone | undefined)[] = [];
    const run = (d: Draft<EventType>): void => {
      s.push(d);
      seen.push(milestoneFor(s.last as IncidentEvent, s.view as IncidentView, s.before));
    };
    run(filed());
    run(started());
    run(prOpened());
    run(draft('review-passed', { prNumber: 418 }));
    run(draft('ci-green', { prNumber: 418, headSha: 'abc' }));
    run(draft('merged', { prNumber: 418, sha: 'abc', levelAtMergeTime: 2 } as never, DANA));
    run(draft('deployed:staging', { env: 'staging', sha: 'abc' } as never));
    run(draft('deployed:production', { env: 'production', sha: 'abc' } as never));
    expect(seen).toEqual(['filed', undefined, 'pr-open', undefined, undefined, 'merged', 'staging', 'live']);
  });

  it('counts stopped and a failed fixer', () => {
    const a = filedScript();
    a.push(filed());
    a.push(started());
    a.push(draft('stopped', { reason: 'user' } as never, DANA));
    expect(milestoneFor(a.last as IncidentEvent, a.view as IncidentView, a.before)).toBe('stopped');

    const b = filedScript();
    b.push(filed());
    b.push(started());
    b.push(draft('fixer-failed', { runId: 'run-1', reason: 'tests red' } as never));
    expect(milestoneFor(b.last as IncidentEvent, b.view as IncidentView, b.before)).toBe('failed');
  });

  it('has no milestone before the incident has its own key', () => {
    const s = filedScript();
    expect(milestoneFor(s.last as IncidentEvent, s.view as IncidentView, s.before)).toBeUndefined();
  });
});

// The rules ---------------------------------------------------------------------------------------

describe('notify rows: watchers (A 4.4)', () => {
  it('writes nothing without a context: off by default', () => {
    const s = filedScript();
    expect(s.push(filed())).toEqual([]);
  });

  it('mentions an incident watcher in the thread on a milestone', () => {
    const s = filedScript();
    const rows = s.push(filed(), context({ subscriptions: [sub('U-PAT', 'incident', INC)] }));
    expect(rows).toHaveLength(1);
    const row = rows[0] as OutboxItem;
    expect(row).toMatchObject({ target: 'slack', op: 'notify', incidentId: INC, attempts: 0 });
    expect(payloadOf(row)).toMatchObject({ delivery: 'thread', mentions: ['U-PAT'], milestone: 'filed', reason: 'watch', issueKey: KEY });
    expect(payloadOf(row).text).toBe(`<@U-PAT> ${KEY} is filed.`);
  });

  it('mentions a standing surface subscriber, and a scope-all one, once each', () => {
    const s = filedScript();
    const rows = s.push(
      filed(),
      context({
        subscriptions: [sub('U-PAT', 'surface', 'web'), sub('U-PAT', 'incident', INC), sub('U-BOSS', 'all', undefined), sub('U-OTHER', 'surface', 'api')],
        channelMembers: new Set(['U-PAT', 'U-BOSS', 'U-OTHER']),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0] as OutboxItem).mentions).toEqual(['U-BOSS', 'U-PAT']);
  });

  it('sends a DM to a watcher who is not in the channel, and to a standing DM subscriber', () => {
    const s = filedScript();
    const rows = s.push(
      filed(),
      context({
        subscriptions: [sub('U-IN', 'incident', INC), sub('U-OUT', 'incident', INC), sub('U-STANDING', 'surface', 'web', 'dm')],
        channelMembers: new Set(['U-IN', 'U-STANDING']),
      }),
    );
    expect(rows.map((r) => [payloadOf(r).delivery, payloadOf(r).mentions])).toEqual([
      ['thread', ['U-IN']],
      ['dm', ['U-OUT']],
      ['dm', ['U-STANDING']],
    ]);
    expect(payloadOf(rows[1] as OutboxItem).text).toBe(`${KEY} is filed.`);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it('tells a standing watcher only about what a status answer would show them (#272)', () => {
    const subs = [sub('U-IN', 'surface', 'web'), sub('U-OUT', 'all', undefined, 'dm'), sub(REPORTER, 'surface', 'web', 'dm'), sub('U-WATCH', 'incident', INC)];
    const mentions = (ctx: NotifyContext) => filedScript().push(filed(), ctx).map((r) => [payloadOf(r).delivery, payloadOf(r).mentions]);
    // In the channel, the incident's reporter, and a watch on the incident itself; not someone outside it.
    expect(mentions(context({ subscriptions: subs, channelMembers: new Set(['U-IN', 'U-WATCH']) }))).toEqual([
      ['thread', ['U-IN', 'U-WATCH']],
      ['dm', [REPORTER]],
    ]);
    // A channel nobody could list shows a standing watcher nothing; a watch on the incident still applies.
    expect(mentions(context({ subscriptions: subs }))).toEqual([
      ['thread', ['U-WATCH']],
      ['dm', [REPORTER]],
    ]);
    // An incident with no chat thread (the CLI) reaches every standing watcher.
    expect(filedScript('cli').push(filed(), context({ subscriptions: [sub('U-OUT', 'all', undefined, 'dm')] }))).toHaveLength(1);
  });

  it('tells an incident from the CLI by DM only, since it has no thread', () => {
    const s = filedScript('cli');
    const rows = s.push(filed(), context({ subscriptions: [sub('U-PAT', 'incident', INC, 'dm')] }));
    expect(rows.map((r) => [r.target, payloadOf(r).delivery])).toEqual([['slack', 'dm']]);
  });

  it('notifies on each milestone but not on other events', () => {
    const s = filedScript();
    const ctx = context({ subscriptions: [sub('U-PAT', 'incident', INC)] });
    expect(s.push(filed(), ctx)).toHaveLength(1);
    expect(s.push(started(), ctx)).toEqual([]);
    expect(s.push(prOpened(), ctx)).toHaveLength(1);
    expect(s.push(draft('review-passed', { prNumber: 418 }), ctx)).toEqual([]);
  });
});

describe('notify rows: a DM goes to the platform the watcher subscribed from', () => {
  const targets = (rows: readonly OutboxItem[]) => rows.map((r) => [r.target, payloadOf(r).delivery, payloadOf(r).mentions]);

  it('tells a standing watcher from the other platform nothing about a chat incident: that channel is never theirs (#272)', () => {
    const teams = filedScript('teams');
    const rows = teams.push(filed(), context({ subscriptions: [sub('U-SLACK', 'surface', 'web', 'dm', 'slack'), sub('AAD-IN', 'incident', INC, 'thread', 'teams')], channelMembers: new Set(['AAD-IN', 'U-SLACK']) }));
    expect(targets(rows)).toEqual([['teams', 'thread', ['AAD-IN']]]);
    const slack = filedScript('slack');
    const back = slack.push(filed(), context({ subscriptions: [sub('AAD-TEAMS', 'surface', 'web', 'dm', 'teams'), sub('U-PAT', 'incident', INC, 'thread', 'slack')], channelMembers: new Set(['U-PAT']) }));
    expect(targets(back)).toEqual([['slack', 'thread', ['U-PAT']]]);
  });

  it('tells a thread watcher from the other platform by DM there, not by a mention in a thread they cannot read', () => {
    // No member list is known, which would otherwise put every thread watcher in the thread.
    const s = filedScript('teams');
    const rows = s.push(filed(), context({ subscriptions: [sub('U-SLACK', 'incident', INC, 'thread', 'slack'), sub('AAD-PAT', 'incident', INC, 'thread', 'teams')] }));
    expect(targets(rows)).toEqual([
      ['teams', 'thread', ['AAD-PAT']],
      ['slack', 'dm', ['U-SLACK']],
    ]);
    expect(rows[1]?.batchKey).toBe(`notify:${INC}:${String(s.seq)}:dm:U-SLACK`);
  });

  it('keeps the old target for a subscription with no platform: the thread, or the incident\'s platform for a DM', () => {
    const teams = filedScript('teams');
    const rows = teams.push(filed(), context({ subscriptions: [sub('U-OLD-DM', 'surface', 'web', 'dm'), sub('U-OLD-THREAD', 'surface', 'web')], channelMembers: new Set(['U-OLD-DM', 'U-OLD-THREAD']) }));
    expect(targets(rows)).toEqual([
      ['teams', 'thread', ['U-OLD-THREAD']],
      ['teams', 'dm', ['U-OLD-DM']],
    ]);
    const cli = filedScript('cli');
    expect(targets(cli.push(filed(), context({ subscriptions: [sub('U-OLD-DM', 'surface', 'web', 'dm')] })))).toEqual([['slack', 'dm', ['U-OLD-DM']]]);
  });

  it('sends the DM of an incident with no thread (the CLI) to the watcher\'s platform too', () => {
    const s = filedScript('cli');
    expect(targets(s.push(filed(), context({ subscriptions: [sub('AAD-TEAMS', 'surface', 'web', 'dm', 'teams')] })))).toEqual([['teams', 'dm', ['AAD-TEAMS']]]);
  });

  it('plans a DM with the watcher\'s platform and a thread message without one', () => {
    const notices = planNotices({
      milestone: 'live',
      // An incident with no chat thread: every standing watcher may hear about it (#272).
      incident: { id: INC, jiraKey: KEY, surfaceId: 'web' },
      at: new Date(T0).toISOString(),
      seq: 1,
      context: context({ subscriptions: [sub('U-SLACK', 'surface', 'web', 'dm', 'slack'), sub('AAD-PAT', 'surface', 'web', 'thread', 'teams'), sub('U-OLD', 'all', undefined, 'dm')] }),
    });
    expect(notices.map((n) => [n.delivery, n.mentions, n.platform])).toEqual([
      ['thread', ['AAD-PAT'], undefined],
      ['dm', ['U-OLD'], undefined],
      ['dm', ['U-SLACK'], 'slack'],
    ]);
  });

  it('records the incident\'s chat platform on a watch, and none for an incident with no thread', () => {
    const at = new Date(T0).toISOString();
    const watch = {
      workspaceId: WS,
      incidentId: INC,
      seq: 9,
      v: 1,
      type: 'comment',
      source: 'teams',
      actor: DANA,
      occurredAt: at,
      recordedAt: at,
      payload: { intent: 'watch', platform: 'teams', signalSource: 'reaction', confidence: 1, raw: 'eyes' },
    } as unknown as IncidentEvent;
    expect(foldIncidentSubscriptions([], watch, 'teams').map((s) => s.platform)).toEqual(['teams']);
    expect(foldIncidentSubscriptions([], watch, 'slack').map((s) => s.platform)).toEqual(['slack']);
    expect(foldIncidentSubscriptions([], watch, 'cli')).toEqual([{ workspaceId: WS, userId: DANA.id, scopeKind: 'incident', scopeId: INC, channel: 'thread', createdAt: at }]);
  });
});

describe('notify rows: forcePush (6.2)', () => {
  it('pushes a priority at or above the forced one with no watchers, mentioning the reporter', () => {
    const s = filedScript('slack', 'Highest');
    const rows = s.push(filed(), context({}, { forcePush: [{ priority: 'High' }] }));
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0] as OutboxItem)).toMatchObject({ delivery: 'thread', mentions: [REPORTER], reason: 'policy' });
  });

  it('does not push a lower priority', () => {
    const s = filedScript('slack', 'Medium');
    expect(s.push(filed(), context({}, { forcePush: [{ priority: 'High' }] }))).toEqual([]);
  });

  it('pushes a forced surface, and not another one', () => {
    const on = filedScript();
    expect(on.push(filed(), context({}, { forcePush: [{ surface: 'web' }] }))).toHaveLength(1);
    const off = filedScript();
    expect(off.push(filed(), context({}, { forcePush: [{ surface: 'api' }] }))).toEqual([]);
  });

  it('keeps the watchers and the reporter in one mention list', () => {
    const s = filedScript();
    const rows = s.push(filed(), context({ subscriptions: [sub('U-PAT', 'incident', INC)] }, { forcePush: [{ surface: 'web' }] }));
    expect(payloadOf(rows[0] as OutboxItem).mentions).toEqual(['U-PAT', REPORTER]);
  });

  it('reads priority in Jira order and ignores unknown names', () => {
    expect(priorityAtLeast('Highest', 'High')).toBe(true);
    expect(priorityAtLeast('High', 'High')).toBe(true);
    expect(priorityAtLeast('Low', 'High')).toBe(false);
    expect(priorityAtLeast('Urgent', 'High')).toBe(false);
    expect(priorityAtLeast(undefined, 'High')).toBe(false);
  });
});

describe('notify rows: the reporter on the staging check', () => {
  const toStaging = (priority: JiraPriorityName = 'High'): Script => {
    const s = filedScript('slack', priority);
    s.all([filed(), started(), prOpened(), draft('review-passed', { prNumber: 418 }), draft('ci-green', { prNumber: 418, headSha: 'abc' })]);
    s.push(draft('merged', { prNumber: 418, sha: 'abc', levelAtMergeTime: 2 } as never, DANA));
    return s;
  };
  const staging = draft('deployed:staging', { env: 'staging', sha: 'abc' } as never);

  it('always mentions the reporter, with no playbook rule and no watcher, right away', () => {
    const s = toStaging();
    const rows = s.push(staging, context());
    expect(rows).toHaveLength(1);
    const row = rows[0] as OutboxItem;
    expect(payloadOf(row)).toMatchObject({ delivery: 'thread', mentions: [REPORTER], reason: 'request' });
    expect(payloadOf(row).text).toContain('Can you check?');
    expect(row.nextAttempt).toBe(row.createdAt);
  });

  it('skips quiet hours and an open burst window', () => {
    const s = toStaging();
    const rows = s.push(
      staging,
      context(
        { window: { key: 'earlier', sendAt: new Date(s.clock + 3_600_000).toISOString() } },
        { quietHours: { tz: 'UTC', from: '00:00', to: '23:59' } },
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nextAttempt).toBe(rows[0]?.createdAt);
  });

  it('does not mention a reporter who also watches twice, and still tells other watchers', () => {
    const s = toStaging();
    const rows = s.push(staging, context({ subscriptions: [sub(REPORTER, 'incident', INC), sub('U-PAT', 'incident', INC)] }));
    expect(rows.map((r) => [payloadOf(r).reason, payloadOf(r).mentions])).toEqual([
      ['request', [REPORTER]],
      ['watch', ['U-PAT']],
    ]);
  });
});

describe('notify rows: quiet hours', () => {
  const quiet = { tz: 'America/New_York', from: '20:00', to: '08:00' } as const;

  it('computes the end of quiet hours across midnight, and nothing outside them', () => {
    // 2026-10-02T02:30Z is 22:30 in New York (EDT, UTC-4): quiet until 08:00 local, 12:00Z.
    expect(quietEnd(Date.parse('2026-10-02T02:30:00Z'), quiet)).toBe(Date.parse('2026-10-02T12:00:00Z'));
    // 01:00 local, after midnight: still quiet until 08:00 local.
    expect(quietEnd(Date.parse('2026-10-02T05:00:00Z'), quiet)).toBe(Date.parse('2026-10-02T12:00:00Z'));
    expect(quietEnd(Date.parse('2026-10-02T15:00:00Z'), quiet)).toBeUndefined();
    expect(quietEnd(Date.parse('2026-10-02T12:00:00Z'), quiet)).toBeUndefined();
  });

  it('treats a bad zone, a bad clock, or equal bounds as no quiet hours', () => {
    const at = Date.parse('2026-10-02T02:30:00Z');
    expect(quietEnd(at, { ...quiet, tz: 'Nowhere/Land' })).toBeUndefined();
    expect(quietEnd(at, { ...quiet, from: 'late' })).toBeUndefined();
    expect(quietEnd(at, { ...quiet, from: '08:00', to: '08:00' })).toBeUndefined();
  });

  const nightScript = (priority: JiraPriorityName): Script => {
    const s = filedScript('slack', priority);
    s.clock = Date.parse('2026-10-02T02:20:00Z');
    return s;
  };
  const watcher = [sub('U-PAT', 'incident', INC)];

  it('holds a notification that would go out in quiet hours until they end', () => {
    const s = nightScript('High');
    const rows = s.push(filed(), context({ subscriptions: watcher }, { quietHours: quiet }));
    expect(rows[0]?.nextAttempt).toBe('2026-10-02T12:00:00.000Z');
  });

  it('lets exceptPriority through, at the end of the burst window as usual', () => {
    const s = nightScript('Highest');
    const rows = s.push(filed(), context({ subscriptions: watcher }, { quietHours: { ...quiet, exceptPriority: 'Highest' } }));
    expect(Date.parse(rows[0]?.nextAttempt ?? '') - Date.parse(rows[0]?.createdAt ?? '')).toBe(5 * 60_000);
  });

  it('does not let a lower priority through an exception for a higher one', () => {
    const s = nightScript('High');
    const rows = s.push(filed(), context({ subscriptions: watcher }, { quietHours: { ...quiet, exceptPriority: 'Highest' } }));
    expect(rows[0]?.nextAttempt).toBe('2026-10-02T12:00:00.000Z');
  });

  it('merges a night of milestones into one held batch', () => {
    const s = nightScript('High');
    const ctx = context({ subscriptions: watcher }, { quietHours: quiet });
    const first = s.push(filed(), ctx);
    const window = windowFromRows(first);
    const second = s.push(prOpened(), { ...ctx, ...(window === undefined ? {} : { window }) }, 3_600_000);
    expect(second[0]?.batchKey).toBe(first[0]?.batchKey);
    expect(second[0]?.nextAttempt).toBe(first[0]?.nextAttempt);
  });
});

describe('notify rows: the rate limit and the burst merge', () => {
  const ctx = (extra: Partial<NotifyContext> = {}, rate = 'PT5M'): NotifyContext =>
    context({ subscriptions: [sub('U-PAT', 'incident', INC)], ...extra }, { rateLimit: { perIncident: rate } });

  it('goes out when the window closes: five minutes after the first milestone by default', () => {
    const s = filedScript();
    const rows = s.push(filed(), ctx());
    expect(Date.parse(rows[0]?.nextAttempt ?? '') - Date.parse(rows[0]?.createdAt ?? '')).toBe(5 * 60_000);
    expect(rows[0]?.batchKey).toBe(`notify:${INC}:${String(s.seq)}:thread`);
  });

  it('turns a burst inside the window into rows with one batch key and one send time', () => {
    const s = filedScript();
    const rows = s.push(filed(), ctx());
    // Started is no milestone; the PR and the stop land inside the same five minutes.
    for (const d of [started(), prOpened(), draft('stopped', { reason: 'user' } as never, DANA)]) {
      const window = windowFromRows(rows);
      rows.push(...s.push(d, ctx(window === undefined ? {} : { window })));
    }
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.batchKey)).size).toBe(1);
    expect(new Set(rows.map((r) => r.nextAttempt)).size).toBe(1);
    expect(rows.map((r) => payloadOf(r).milestone)).toEqual(['filed', 'pr-open', 'stopped']);
  });

  it('opens a new window, and so a new message, once the first one has gone out', () => {
    const s = filedScript();
    const first = s.push(filed(), ctx());
    const window = windowFromRows(first);
    const later = s.push(prOpened(), ctx(window === undefined ? {} : { window }), 6 * 60_000);
    expect(later[0]?.batchKey).not.toBe(first[0]?.batchKey);
    expect(Date.parse(later[0]?.nextAttempt ?? '')).toBeGreaterThan(Date.parse(first[0]?.nextAttempt ?? ''));
  });

  it('honors a playbook interval other than five minutes', () => {
    const s = filedScript();
    const rows = s.push(filed(), ctx({}, 'PT15M'));
    expect(Date.parse(rows[0]?.nextAttempt ?? '') - Date.parse(rows[0]?.createdAt ?? '')).toBe(15 * 60_000);
  });

  it('keeps each DM recipient on a batch of their own', () => {
    const s = filedScript();
    const rows = s.push(filed(), context({ subscriptions: [sub('U-A', 'incident', INC, 'dm'), sub('U-B', 'incident', INC, 'dm')] }));
    expect(rows.map((r) => r.batchKey)).toEqual([`notify:${INC}:${String(s.seq)}:dm:U-A`, `notify:${INC}:${String(s.seq)}:dm:U-B`]);
  });

  it('finds the open window from the incident rows, ignoring the staging request', () => {
    expect(windowFromRows([])).toBeUndefined();
    const s = filedScript();
    const [row] = s.push(filed(), ctx());
    const request = { ...(row as OutboxItem), id: 'z', createdAt: '2027-01-01T00:00:00.000Z', payload: { ...(row as OutboxItem).payload, reason: 'request' } };
    expect(windowFromRows([row as OutboxItem, request])).toEqual({ key: `${INC}:${String(s.seq)}`, sendAt: (row as OutboxItem).nextAttempt });
  });
});

describe('notify rows: shape', () => {
  it('is an outbox row for the slack target with op notify, and an invalid event adds none', () => {
    const s = filedScript();
    const ctx = context({ subscriptions: [sub('U-PAT', 'incident', INC)] });
    const [row] = s.push(filed(), ctx);
    expect(row).toMatchObject({ target: 'slack', op: NOTIFY_OP, workspaceId: WS });
    expect(row?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const event = s.last as IncidentEvent;
    expect(notifyRows(event, { before: s.before, after: s.view as IncidentView, valid: false, notify: ctx })).toEqual([]);
    expect(notifyRows(event, { before: s.before, after: s.view as IncidentView, valid: true, notify: ctx })).toEqual([row]);
  });

  it('plans nothing for a milestone nobody follows', () => {
    expect(planNotices({ milestone: 'live', incident: { id: INC, jiraKey: KEY }, at: new Date(T0).toISOString(), seq: 1, context: context() })).toEqual([]);
  });
});
