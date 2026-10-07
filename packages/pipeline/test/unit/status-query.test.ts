// #295: status queries (A 4.3, A 7). Resolving which incident a question means (a thread, a key,
// words, a tie, a surface) and the answer shapes per audience, over rows folded from scripted logs as
// the projector folds them, plus a 500-incident benchmark.

import { describe, expect, it } from 'vitest';
import type { EventActor, EventPayloads, EventSource, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { IncidentActor } from '../../src/contracts/incident.ts';
import type { StatusQuery } from '../../src/contracts/signals.ts';
import type { Claim, IncidentView, Subscription } from '../../src/contracts/state.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { foldIncident } from '../../src/state/projections/incidents.ts';
import { reporterViolations } from '../../src/status/copy.ts';
import { audienceFor, createStatusQueries, type StatusSnapshot } from '../../src/status/query.ts';

const WS = '01JZ0000000000000000000001';
const BASE = Date.parse('2026-10-01T14:00:00.000Z');
const NOW = new Date(BASE + 60 * 60_000);
const CHANNEL = 'C-FAKE-WEB';
const REPORTER: IncidentActor = { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' };
const ENGINEER: IncidentActor = { id: 'U-FAKE-ENG', name: 'Test Engineer', role: 'engineer' };
const STAKEHOLDER: IncidentActor = { id: 'U-FAKE-BOSS', name: 'Test Boss', role: 'reporter' };

const MAP: WorkspaceMap = {
  org: 'fake-org',
  updated: '2026-10-01T00:00:00Z',
  surfaces: [
    {
      id: 'web',
      label: 'Website',
      repo: 'github.com/fake-org/web',
      jira: { project: 'WEB', defaultIssueType: 'Bug' },
      components: [
        { id: 'checkout', label: 'Checkout' },
        { id: 'search', label: 'Search' },
      ],
    },
    { id: 'app', label: 'Mobile app', repo: 'github.com/fake-org/app', jira: { project: 'APP', defaultIssueType: 'Bug' }, components: [{ id: 'login', label: 'Login' }] },
  ],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
  triggers: { messageActions: [], emoji: [] },
  vocabulary: [
    { text: 'cart', surface: 'web', component: 'checkout' },
    { text: 'the site', surface: 'web' },
  ],
  people: [],
  policies: {
    autonomy: {
      default: 1,
      levels: [
        { id: 0, name: 'ticket-only', fixer: 'never', merge: 'none', requires: [] },
        { id: 1, name: 'fix-on-tap', fixer: 'on-tap', merge: 'human', requires: [] },
        { id: 2, name: 'fix-now', fixer: 'immediate', merge: 'human', requires: [] },
        { id: 3, name: 'autopilot', fixer: 'immediate', merge: 'agent', requires: ['review-agent', 'ci-green', 'risk-gate'] },
      ],
      overrides: [],
    },
  },
};

// Scripted logs, folded as the projector folds them -----------------------------------------------

type Draft = { type: EventType; payload: unknown; actor?: EventActor; source?: EventSource };

function d<T extends EventType>(type: T, payload: EventPayloads[T], actor?: EventActor, source?: EventSource): Draft {
  return { type, payload, ...(actor === undefined ? {} : { actor }), ...(source === undefined ? {} : { source }) };
}

interface Spec {
  id: string;
  key?: string;
  summary: string;
  surface: string;
  component?: string;
  owner?: string;
  priority?: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
  level?: 0 | 1 | 2 | 3;
  anchor?: string;
  thread?: string;
  /** Minutes after BASE of the first event. */
  start?: number;
  then?: Draft[];
  /** Someone else's trigger on the reporter's post: they brought it in, the reporter wrote it (#363). */
  triggeredBy?: IncidentActor;
}

interface Built {
  view: IncidentView;
  log: IncidentEvent[];
}

function build(spec: Spec): Built {
  const drafts: Draft[] = [
    d('captured', {
      kind: 'incident',
      idempotencyKey: `slack:${spec.id}`,
      source: 'slack',
      ...(spec.triggeredBy === undefined ? { reporter: REPORTER } : { reporter: spec.triggeredBy, anchorAuthor: REPORTER }),
      anchorText: spec.summary,
      channelId: CHANNEL,
      anchorId: spec.anchor ?? `1700000000.${spec.id.slice(-6)}`,
      ...(spec.thread === undefined ? {} : { threadId: spec.thread }),
    }),
    d('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 1, excludedCount: 0 }),
    d('resolved', {
      surfaceId: spec.surface,
      ...(spec.component === undefined ? {} : { componentId: spec.component }),
      ...(spec.owner === undefined ? {} : { ownerId: spec.owner }),
      repo: `github.com/fake-org/${spec.surface}`,
      resolvedBy: 'channel-explicit',
      confidence: 0.9,
    }),
    d('dedupe-checked', { candidates: [], decision: 'none' }),
    d('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: spec.summary,
      priority: spec.priority ?? 'Medium',
      labels: ['snapwing'],
      autonomyLevel: spec.level ?? 2,
      implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
    }),
    ...(spec.key === undefined ? [] : [d('filed', { jiraKey: spec.key })]),
    ...(spec.then ?? []),
  ];
  let view: IncidentView | undefined;
  const log: IncidentEvent[] = [];
  drafts.forEach((draft, i) => {
    const at = new Date(BASE + ((spec.start ?? 0) + i) * 60_000).toISOString();
    const event = {
      workspaceId: WS,
      incidentId: spec.id,
      seq: i + 1,
      v: 1,
      type: draft.type,
      source: draft.source ?? (draft.actor === undefined ? 'agent' : 'slack'),
      ...(draft.actor === undefined ? {} : { actor: draft.actor }),
      occurredAt: at,
      recordedAt: at,
      payload: draft.payload,
    } as unknown as IncidentEvent;
    log.push(event);
    const fold = foldIncident(view, event, log);
    if (fold.view === undefined) throw new Error(`no row after ${draft.type}`);
    view = fold.view;
  });
  if (view === undefined) throw new Error('empty script');
  return { view, log };
}

const started = (attempt = 1) => d('fixer-started', { runId: `run-${String(attempt)}`, harness: 'claude-code', attempt });
const prOpened = (n = 418) => d('pr-opened', { prNumber: n, branch: `fix/WEB-${String(n)}` }, undefined, 'github');
const reviewPassed = (n = 418) => d('review-passed', { prNumber: n });
const toCi = [started(), prOpened(), reviewPassed()];

function snapshot(built: readonly Built[], extra: Partial<StatusSnapshot> = {}): StatusSnapshot {
  const logs = new Map(built.map((b) => [b.view.id, b.log]));
  return { incidents: built.map((b) => b.view), events: (id) => logs.get(id) ?? [], map: MAP, now: NOW, ...extra };
}

function ask(text: string, asker: IncidentActor = STAKEHOLDER, context: StatusQuery['context'] = {}): StatusQuery {
  return { asker, text, context };
}

// A workspace: two checkout incidents, a search one, a mobile one, and a closed duplicate of the first.
const CART = build({ id: '01JZ00000000000000000000A1', key: 'WEB-1042', summary: 'Blank cart total', surface: 'web', component: 'checkout', owner: 'dana', priority: 'High', anchor: '1700000000.000100', then: toCi });
const PROMO = build({ id: '01JZ00000000000000000000A2', key: 'WEB-1051', summary: 'Promo code rejected', surface: 'web', component: 'checkout', owner: 'dana', priority: 'Medium', start: 5, then: [started()] });
const SEARCH = build({ id: '01JZ00000000000000000000A3', key: 'WEB-1060', summary: 'Search results empty for long queries', surface: 'web', component: 'search', priority: 'Low', level: 1, start: 10 });
const LOGIN = build({ id: '01JZ00000000000000000000A4', key: 'APP-7', summary: 'Login spinner never stops', surface: 'app', component: 'login', priority: 'Highest', start: 12 });
const OLD = build({ id: '01JZ00000000000000000000A5', key: 'WEB-1000', summary: 'Blank cart total', surface: 'web', component: 'checkout', priority: 'Highest', then: [d('closed', { reason: 'fixed' })] });
const WORLD = [CART, PROMO, SEARCH, LOGIN, OLD];

describe('resolveQuery', () => {
  const q = createStatusQueries(snapshot(WORLD));

  it("in a thread, answers with the thread's incident whatever the words say", () => {
    const found = q.resolveQuery(ask('where are we with the promo code?', REPORTER, { channelId: CHANNEL, threadId: '1700000000.000100' }));
    expect(found).toMatchObject({ kind: 'incident', by: 'thread' });
    expect(found.kind === 'incident' && found.incident.jiraKey).toBe('WEB-1042');
  });

  it('finds the thread through the anchor reply thread in the log and through the status message', () => {
    const reply = build({ id: '01JZ00000000000000000000B1', key: 'WEB-2001', summary: 'Footer link broken', surface: 'web', anchor: '1700000001.000200', thread: '1700000001.000001' });
    const posted = build({ id: '01JZ00000000000000000000B2', key: 'WEB-2002', summary: 'Header overlaps', surface: 'web', then: [d('status-message-posted', { messageId: '1700000002.000900' })] });
    const qq = createStatusQueries(snapshot([...WORLD, reply, posted]));
    const viaLog = qq.resolveQuery(ask('status?', REPORTER, { channelId: CHANNEL, threadId: '1700000001.000001' }));
    expect(viaLog.kind === 'incident' && viaLog.incident.jiraKey).toBe('WEB-2001');
    const viaStatus = qq.resolveQuery(ask('status?', REPORTER, { channelId: CHANNEL, threadId: '1700000002.000900' }));
    expect(viaStatus.kind === 'incident' && viaStatus.incident.jiraKey).toBe('WEB-2002');
  });

  it('a thread that belongs to no incident falls back to the words', () => {
    const found = q.resolveQuery(ask('the promo code thing', REPORTER, { channelId: CHANNEL, threadId: '1699999999.000000' }));
    expect(found.kind === 'incident' && found.incident.jiraKey).toBe('WEB-1051');
  });

  it('an explicit key wins, closed or open, any case', () => {
    expect(q.resolveQuery(ask('<@U-BOT> WEB-1051'))).toMatchObject({ kind: 'incident', by: 'key', incident: { jiraKey: 'WEB-1051' } });
    expect(q.resolveQuery(ask('what happened with web-1000'))).toMatchObject({ kind: 'incident', by: 'key', incident: { jiraKey: 'WEB-1000' } });
  });

  it('matches words by summary similarity among open incidents only', () => {
    const found = q.resolveQuery(ask('@agent status on the blank totals'));
    expect(found).toMatchObject({ kind: 'incident', by: 'words', incident: { jiraKey: 'WEB-1042' } });
    expect(q.resolveQuery(ask('where are we with the promo code?'))).toMatchObject({ kind: 'incident', incident: { jiraKey: 'WEB-1051' } });
    expect(q.resolveQuery(ask('login spinner'))).toMatchObject({ kind: 'incident', incident: { jiraKey: 'APP-7' } });
  });

  it('matches component names and vocabulary terms', () => {
    expect(q.resolveQuery(ask("what's up with search?"))).toMatchObject({ kind: 'incident', incident: { jiraKey: 'WEB-1060' } });
    // "cart" is a vocabulary term for checkout, and also a summary word of WEB-1042 only.
    expect(q.resolveQuery(ask('the cart thing'))).toMatchObject({ kind: 'incident', incident: { jiraKey: 'WEB-1042' } });
  });

  it('asks only when two candidates tie, naming both, worst first', () => {
    const found = q.resolveQuery(ask('@agent status on the checkout thing'));
    expect(found.kind).toBe('tie');
    if (found.kind !== 'tie') return;
    expect(found.candidates.map((i) => i.jiraKey)).toEqual(['WEB-1042', 'WEB-1051']);
    expect(found.question).toBe('WEB-1042 (Blank cart total) or WEB-1051 (Promo code rejected)?');
    const answer = q.respond(ask('@agent status on the checkout thing'));
    expect(answer.text).toBe(found.question);
    expect(answer.incidentId).toBeUndefined();
  });

  it('words that only name a surface are a surface question, worst first', () => {
    for (const text of ["how's the website today?", "what's open on the site?"]) {
      const found = q.resolveQuery(ask(text));
      expect(found.kind).toBe('surface');
      if (found.kind !== 'surface') continue;
      expect(found.surfaceId).toBe('web');
      expect(found.incidents.map((i) => i.jiraKey)).toEqual(['WEB-1042', 'WEB-1051', 'WEB-1060']);
    }
  });

  it("no words in a mapped channel is that channel's surface; nowhere, nothing", () => {
    expect(q.resolveQuery(ask('<@U-BOT> anything?', STAKEHOLDER, { channelId: CHANNEL }))).toMatchObject({ kind: 'surface', surfaceId: 'web' });
    expect(q.resolveQuery(ask('<@U-BOT> anything?', STAKEHOLDER, { channelId: 'D-FAKE' }))).toEqual({ kind: 'none' });
    const answer = q.respond(ask('hmm', STAKEHOLDER));
    expect(answer.incidentId).toBeUndefined();
    expect(answer.text).toContain('Name its key');
  });
});

describe('answer', () => {
  const watchers: Subscription[] = ['U-FAKE-PAT', 'U-FAKE-BOSS'].map((userId) => ({
    workspaceId: WS,
    userId,
    scopeKind: 'incident',
    scopeId: CART.view.id,
    channel: 'thread',
    createdAt: NOW.toISOString(),
  }));
  const q = createStatusQueries(snapshot(WORLD, { subscriptions: watchers }));

  it('reporter: plain language, filed time, current stage and since, ends with the next step and the wait', () => {
    const a = q.answer(CART.view, 'reporter');
    expect(a.text).toBe(
      'WEB-1042, Blank cart total. Filed 2:05 PM. A fix is being reviewed (since 2:08 PM). ' +
        "Next: once the automated checks pass and <@dana> approves, it goes to staging, and I'll ask you to check. " +
        'Waiting on the automated checks. Nothing needed from you right now.',
    );
    expect(reporterViolations(a.text)).toEqual([]);
    expect(a).toMatchObject({ incidentId: CART.view.id, audience: 'reporter', waitingOn: { kind: 'ci', since: '2026-10-01T14:08:00.000Z' }, actions: [] });
    expect(a.nextStep).toContain('goes to staging');
  });

  it('reporter: when it waits on them, says so and asks', () => {
    const staged = build({
      id: '01JZ00000000000000000000C1',
      key: 'WEB-1070',
      summary: 'Price rounding',
      surface: 'web',
      then: [...toCi, d('ci-green', { prNumber: 418, headSha: 'abc' }), d('merged', { prNumber: 418, mergeCommitSha: 'def', levelAtMergeTime: 2 }), d('deployed:staging', { commitSha: 'def' })],
    });
    const a = createStatusQueries(snapshot([staged])).answer(staged.view, 'reporter');
    expect(a.text.endsWith('Waiting on you: can you check it on staging?')).toBe(true);
    expect(a.waitingOn).toMatchObject({ kind: 'human', who: REPORTER.id });
    expect(reporterViolations(a.text)).toEqual([]);
  });

  it('a merged incident with no deploy event says it waits for a staging deploy, never "rolling out" (#168)', () => {
    const merged = build({
      id: '01JZ00000000000000000000C4',
      key: 'WEB-1073',
      summary: 'Tax line missing',
      surface: 'web',
      then: [...toCi, d('ci-green', { prNumber: 418, headSha: 'abc' }), d('merged', { prNumber: 418, mergeCommitSha: 'def', levelAtMergeTime: 2 })],
    });
    const queries = createStatusQueries(snapshot([merged]));
    for (const audience of ['reporter', 'engineer', 'lead'] as const) {
      const a = queries.answer(merged.view, audience);
      expect(a.text).not.toMatch(/rolling out|rollout/i);
      expect(a.waitingOn.kind).toBe('deploy');
    }
    const reporter = queries.answer(merged.view, 'reporter');
    expect(reporter.text).toContain('The fix is merged (since');
    expect(reporter.text.match(/Waiting/g)).toHaveLength(1);
    expect(reporter.text).toContain("when it's on staging I'll ask you to check");
    expect(reporter.text).toContain('Waiting on a deploy to staging.');
    expect(queries.answer(merged.view, 'engineer').text).toContain('merged 2:10 → waiting on: the staging deploy');
  });

  it("the engine's recorded wait wins over the status", () => {
    const asked = build({
      id: '01JZ00000000000000000000C2',
      key: 'WEB-1071',
      summary: 'Wrong currency',
      surface: 'web',
      level: 1,
      then: [d('waiting-changed', { waitingOn: { kind: 'human', who: REPORTER.id } })],
    });
    const a = createStatusQueries(snapshot([asked])).answer(asked.view, 'reporter');
    expect(a.waitingOn).toEqual({ kind: 'human', who: REPORTER.id, since: asked.log.at(-1)?.occurredAt });
    expect(a.text.endsWith('Waiting on you: an answer to the question in the thread.')).toBe(true);
  });

  it('reporter: never shows a summary with a path or the word PR', () => {
    const leaky = build({ id: '01JZ00000000000000000000C3', key: 'WEB-1072', summary: 'TypeError in src/cart/total.ts', surface: 'web', then: [started()] });
    const a = createStatusQueries(snapshot([leaky])).answer(leaky.view, 'reporter');
    expect(a.text.startsWith('WEB-1072. ')).toBe(true);
    expect(reporterViolations(a.text)).toEqual([]);
  });

  it('engineer: priority, owner, level; holds and watchers; the timeline ending with what it waits on', () => {
    const a = q.answer(CART.view, 'engineer');
    expect(a.text.split('\n')).toEqual([
      'WEB-1042 · High · <@dana> · fix-now',
      'Hold: none. Watchers: <@U-FAKE-PAT>, <@U-FAKE-BOSS>.',
      "filed 2:05 → fixer 2:06 → PR #418 2:07 → review agent ✅ 2:08 → CI 🟡 running (52 min) → waiting on: CI, then <@dana>'s approval",
    ]);
    expect(a.actions).toEqual(['stop']);
    expect(a.waitingOn.kind).toBe('ci');
  });

  it('engineer: a claim with an environment hold shows in Hold', () => {
    const claims: Claim[] = [
      { incidentId: PROMO.view.id, claimerId: 'U-FAKE-ENG', since: NOW.toISOString(), lastActivity: NOW.toISOString(), expiresAt: '2026-10-01T17:00:00.000Z', holdEnv: 'staging', holdExpiresAt: '2026-10-01T16:00:00.000Z' },
    ];
    const a = createStatusQueries(snapshot(WORLD, { claims })).answer(PROMO.view, 'engineer');
    expect(a.text).toContain('Hold: claimed by <@U-FAKE-ENG> until 5:00; staging held until 4:00.');
    expect(a.text.split('\n').at(-1)).toMatch(/fixer 🟡 running \(\d+ min\) → next: the fixer, then the review agent$/);
  });

  it('lead: plain language plus priority and owner, ending with the next step and the wait', () => {
    const a = q.answer(CART.view, 'lead');
    const lines = a.text.split('\n');
    expect(lines[0]).toBe('WEB-1042, Blank cart total. High priority, owner <@dana>.');
    expect(lines[1]).toBe('🔍 A fix is being reviewed (since 2:08 PM). Open 1 h.');
    expect(lines[2]).toMatch(/^Next: .+\. Waiting on the automated checks\.$/);
    expect(reporterViolations(a.text)).toEqual([]);
    expect(a.actions).toEqual([]);
  });

  it('every audience and status ends with the next step and what it waits on', () => {
    const scripts: Draft[][] = [
      [],
      [started()],
      [started(), prOpened()],
      [...toCi, d('ci-green', { prNumber: 418, headSha: 'a' })],
      [...toCi, d('ci-green', { prNumber: 418, headSha: 'a' }), d('held', { kind: 'gate', reason: 'Touches payments' })],
      [d('stopped', { reason: 'no' }, ENGINEER)],
      [started(), d('fixer-failed', { reason: 'tests', attempts: 1 })],
      [d('closed', {})],
    ];
    scripts.forEach((then, i) => {
      const b = build({ id: `01JZ00000000000000000000D${String(i)}`, key: `WEB-${String(3000 + i)}`, summary: 'Thing', surface: 'web', owner: 'dana', level: 1, then });
      const qq = createStatusQueries(snapshot([b]));
      for (const audience of ['reporter', 'lead', 'engineer'] as const) {
        const a = qq.answer(b.view, audience);
        const last = a.text.split('\n').at(-1) ?? '';
        if (audience === 'engineer') expect(last).toMatch(/(waiting on|next): .+$/);
        else expect(last).toMatch(/Next: .+\. (Waiting on .+\.|Nothing needed from you right now\.|Nothing is holding it up\.)$/);
        if (audience !== 'engineer') expect(reporterViolations(a.text)).toEqual([]);
        expect(a.nextStep.length).toBeGreaterThan(0);
      }
    });
  });

  it('audienceFor: engineers, the reporter, everyone else a lead', () => {
    expect(audienceFor(ENGINEER, CART.view)).toBe('engineer');
    expect(audienceFor(REPORTER, CART.view)).toBe('reporter');
    expect(audienceFor(STAKEHOLDER, CART.view)).toBe('lead');
    expect(audienceFor(REPORTER)).toBe('lead');
    expect(q.respond(ask('status?', REPORTER, { channelId: CHANNEL, threadId: '1700000000.000100' })).audience).toBe('reporter');
  });

  it("the anchor's author is the reporter when an engineer's trigger brought it in, and asking from their DM gets the reporter's one line (#363)", () => {
    const filed = build({ id: '01JZ00000000000000000000B1', key: 'WEB-2001', summary: 'Discounts ten times too small', surface: 'web', owner: 'dana', priority: 'High', level: 0, triggeredBy: ENGINEER });
    expect(filed.view.reporterId).toBe(REPORTER.id);
    const world = createStatusQueries(snapshot([filed]));
    const dm = { channelId: 'D-FAKE-REPORTER' };

    const mine = world.respond(ask('where are we with the discounts thing?', REPORTER, dm));
    expect(mine).toMatchObject({ incidentId: filed.view.id, audience: 'reporter', actions: [] });
    expect(mine.text).toMatch(/^WEB-2001\b/);
    expect(mine.text).toContain('Next: ');
    expect(mine.text).toMatch(/Nothing needed from you right now\.$|Waiting on you: /);
    expect(mine.text).not.toContain('\n');
    expect(reporterViolations(mine.text)).toEqual([]);

    // The engineer whose trigger brought it in still gets the engineer's shape.
    expect(world.respond(ask('where are we with the discounts thing?', ENGINEER, dm)).audience).toBe('engineer');
  });
});

describe('surface answers', () => {
  const q = createStatusQueries(snapshot(WORLD));

  it('lists open incidents on the surface, one line each, worst first', () => {
    const a = q.respond(ask("how's the website today?"));
    expect(a.incidentId).toBeUndefined();
    expect(a.audience).toBe('lead');
    const lines = a.text.split('\n');
    expect(lines[0]).toBe('Website: 3 open, worst first.');
    expect(lines.slice(1).map((l) => /WEB-\d+/.exec(l)?.[0])).toEqual(['WEB-1042', 'WEB-1051', 'WEB-1060']);
    expect(lines[1]).toBe(
      "🔍 WEB-1042 · High · Blank cart total: a fix is being reviewed. Next: once the automated checks pass and <@dana> approves, it goes to staging, and I'll ask you to check; waiting on the automated checks.",
    );
    expect(lines[3]).toContain('waiting on an engineer');
    expect(reporterViolations(a.text)).toEqual([]);
    expect(a.waitingOn.kind).toBe('ci');
    expect(a.nextStep).toContain('goes to staging');
  });

  it('says so when nothing is open', () => {
    const a = createStatusQueries(snapshot([OLD])).answerSurface('web', 'lead');
    expect(a.text).toBe('Website: nothing open. Next: new reports land here.');
    expect(a.waitingOn).toEqual({ kind: 'nothing' });
  });
});

describe('benchmark', () => {
  it('resolves and answers under 1 s on a workspace with 500 incidents', () => {
    const nouns = ['cart', 'promo', 'search', 'login', 'header', 'footer', 'price', 'invoice', 'avatar', 'upload', 'export', 'filter'];
    const verbs = ['blank', 'rejected', 'slow', 'crashes', 'empty', 'wrong', 'missing', 'duplicated', 'stuck', 'flickers'];
    const scripts: Draft[][] = [[], [started()], toCi, [started(), prOpened()]];
    const built: Built[] = [];
    for (let i = 0; i < 500; i += 1) {
      const summary = `${nouns[i % nouns.length] ?? ''} ${verbs[(i * 7) % verbs.length] ?? ''} on page ${String(i)}`;
      built.push(
        build({
          id: `01JZ0000000000000000${String(i).padStart(6, '0')}`,
          key: `WEB-${String(5000 + i)}`,
          summary,
          surface: i % 3 === 0 ? 'app' : 'web',
          component: i % 3 === 0 ? 'login' : i % 2 === 0 ? 'checkout' : 'search',
          owner: 'dana',
          priority: (['Highest', 'High', 'Medium', 'Low'] as const)[i % 4] ?? 'Medium',
          then: scripts[i % scripts.length] ?? [],
        }),
      );
    }
    const t0 = performance.now();
    const q = createStatusQueries(snapshot(built));
    const texts = ['status on the price empty page 42', 'how is the website', 'WEB-5123', 'cart blank', 'the checkout thing'];
    for (const text of texts) {
      for (const asker of [REPORTER, ENGINEER, STAKEHOLDER]) q.respond(ask(text, asker, { channelId: CHANNEL }));
    }
    q.respond(ask('status?', REPORTER, { channelId: CHANNEL, threadId: built[250]?.view.anchorId ?? '' }));
    const elapsed = performance.now() - t0;
    expect(q.resolveQuery(ask('price empty page 42'))).toMatchObject({ kind: 'incident', incident: { jiraKey: 'WEB-5042' } });
    expect(elapsed).toBeLessThan(1000);
  });
});
