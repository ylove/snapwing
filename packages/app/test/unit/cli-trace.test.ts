// `snapwing trace` and `snapwing metrics` (#387) over a seeded log, on the dialect `SNAPWING_DB`
// names (SQLite by default, Postgres with `DATABASE_URL`): a level 2 incident end to end, a
// stopped one, an autopilot one that was reverted, and one outside the metrics window.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { main } from '../../src/cli/main.ts';
import { computeMetrics, parseSince } from '../../src/cli/metrics.ts';

const WS = '01JZ0000000000000000000001';
const LEVEL2 = '01JZ00000000000000000000A2';
const STOPPED = '01JZ00000000000000000000B1';
const AUTOPILOT = '01JZ00000000000000000000C3';
const OLD = '01JZ00000000000000000000D0';

let tdb: TestDatabase;

beforeEach(async () => {
  tdb = await createTestDatabase();
  const state = await openState(tdb.options);
  try {
    await seed(state);
  } finally {
    await state.close();
  }
});

afterEach(async () => {
  await tdb.drop();
});

function at(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
}

/** A builder for one incident's events: each call appends with the next `expectedSeq`. */
function incident(state: OpenedState, incidentId: string) {
  let seq = 0;
  return async (type: string, occurredAt: string, payload: Record<string, unknown>, actor?: { id: string; role: string }): Promise<void> => {
    const event = { workspaceId: WS, incidentId, type, v: 1, source: actor === undefined ? 'agent' : 'slack', occurredAt, payload, ...(actor === undefined ? {} : { actor }) };
    ({ seq } = await state.append(incidentId, [event as unknown as NewEvent], seq));
  };
}

const reporter = { id: 'U-REPORTER', name: 'Rae Reporter', role: 'reporter' };

function captured(text: string): Record<string, unknown> {
  return { kind: 'incident', idempotencyKey: `slack:T:C:${text}`, source: 'slack', reporter, anchorText: text, anchorId: '1.1', channelId: 'C-FAKE' };
}

async function seed(state: OpenedState): Promise<void> {
  // Level 2, end to end: opened 09:00 on Oct 1, PR 09:30, merged 11:00, closed 11:10.
  const bundle = await state.putArtifact({
    workspaceId: WS,
    incidentId: LEVEL2,
    kind: 'bundle',
    contentType: 'application/json',
    body: JSON.stringify({
      anchorId: '1.1',
      included: [{ id: 'm1', authorId: 'U-REPORTER', text: 'Checkout says 500 on the pay button', timestamp: at(1, 9), mentions: [], reactions: [], attachments: [] }],
      excluded: [{ id: 'm2', reason: 'posted before the anchor window' }],
      windowUsed: { oldest: at(1, 8), latest: at(1, 9), cap: 20 },
    }),
    createdBy: 'test',
  });
  const a = incident(state, LEVEL2);
  await a('captured', at(1, 9), captured('Checkout says 500'));
  await a('context-assembled', at(1, 9, 1), { bundle: { artifactId: bundle.id, version: bundle.version }, includedCount: 1, excludedCount: 1 });
  await a('resolved', at(1, 9, 2), { surfaceId: 'web', componentId: 'checkout', ownerId: 'mia', repo: 'acme/web', resolvedBy: 'vocabulary', confidence: 0.82 });
  await a('dedupe-checked', at(1, 9, 3), { candidates: [{ issueKey: 'WEB-9', summary: 'Checkout flake', score: 0.31 }], decision: 'none' });
  await a('planned', at(1, 9, 4), { action: 'create', summary: 'Checkout returns 500', priority: 'High', autonomyLevel: 2 });
  await a('filed', at(1, 9, 5), { jiraKey: 'WEB-1' });
  await a('tapped', at(1, 9, 10), { eventId: 'card-1', card: 'fix-preview', choice: 'approve_fix' }, { id: 'U-MIA', role: 'engineer' });
  await a('level-changed', at(1, 9, 11), { from: 1, to: 2, reason: 'engineer approved the fix' }, { id: 'U-MIA', role: 'engineer' });
  await a('fixer-started', at(1, 9, 12), { runId: 'run-1', harness: 'claude-code', attempt: 1 });
  await a('fixer-done', at(1, 9, 28), { runId: 'run-1', branch: 'snapwing/web-1', summary: 'Guard the empty cart' });
  await a('pr-opened', at(1, 9, 30), { prNumber: 41, branch: 'snapwing/web-1' });
  await a('review-passed', at(1, 9, 40), { prNumber: 41 });
  await a('ci-green', at(1, 9, 50), { prNumber: 41, headSha: 'abcdef1234567' });
  await a('merged', at(1, 11), { prNumber: 41, mergeCommitSha: 'f00dfeed1234', levelAtMergeTime: 2 }, { id: 'U-MIA', role: 'engineer' });
  await a('status-message-posted', at(1, 11, 1), { messageId: '1727773199.000200' });
  await a('closed', at(1, 11, 10), { reason: 'verified on staging' });

  // Stopped: an engineer stopped the fixer; the reporter was asked a question first.
  const b = incident(state, STOPPED);
  await b('captured', at(2, 10), captured('Search is slow'));
  await b('resolved', at(2, 10, 1), { surfaceId: 'web', resolvedBy: 'channel-inferred', confidence: 0.4 });
  await b('clarified', at(2, 10, 2), { audience: 'reporter', question: 'Which page?', asks: 'component', timedOut: false });
  await b('clarify-answered', at(2, 10, 8), { questionSeq: 3, answer: 'The search page' }, { id: 'U-REPORTER', role: 'reporter' });
  await b('planned', at(2, 10, 9), { action: 'create', summary: 'Search is slow', priority: 'Medium', autonomyLevel: 1 });
  await b('filed', at(2, 10, 10), { jiraKey: 'WEB-2' });
  await b('fixer-started', at(2, 10, 20), { runId: 'run-2', harness: 'claude-code', attempt: 1 });
  await b('stopped', at(2, 10, 25), { reason: 'wrong direction' }, { id: 'U-MIA', role: 'engineer' });

  // Autopilot: merged at level 3 after 2h, then reverted; the plan fell back to the unresolved project.
  const c = incident(state, AUTOPILOT);
  await c('captured', at(3, 8), captured('API 502 on login'));
  await c('resolved', at(3, 8, 1), { surfaceId: 'api', resolvedBy: 'alert', confidence: 0.95 });
  await c('planned', at(3, 8, 2), { action: 'create', summary: 'Login 502', priority: 'Highest', autonomyLevel: 3, degraded: 'unresolved-surface' });
  await c('filed', at(3, 8, 3), { jiraKey: 'API-3' });
  await c('pr-opened', at(3, 8, 50), { prNumber: 50, branch: 'snapwing/api-3' });
  await c('merged', at(3, 10), { prNumber: 50, mergeCommitSha: 'c0ffee123456', levelAtMergeTime: 3 });
  await c('reverted', at(3, 12), { prNumber: 50, revertPrNumber: 51, reason: 'login still failing' });

  // Outside a 7-day window ending on Oct 5.
  const d = incident(state, OLD);
  await d('captured', new Date(Date.UTC(2026, 8, 1, 9)).toISOString(), captured('Old report'));
  await d('resolved', new Date(Date.UTC(2026, 8, 1, 9, 1)).toISOString(), { surfaceId: 'web', resolvedBy: 'mention', confidence: 0.9 });
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env:
      tdb.dialect === 'sqlite'
        ? { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: tdb.name }
        : { SNAPWING_DB: 'postgres', DATABASE_URL: tdb.options.url ?? '' },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('snapwing trace', () => {
  it('prints a level 2 incident end to end, in order, by Jira key', async () => {
    const result = await run(['trace', 'WEB-1']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const text = result.out;
    expect(text).toContain('Trace WEB-1');
    expect(text).toContain('closed, level 2, surface web');

    // The bundle, included and excluded with the reason.
    expect(text).toContain('bundle v1: 1 included, 1 excluded');
    expect(text).toContain('+ m1 U-REPORTER: Checkout says 500 on the pay button');
    expect(text).toContain('- m2: posted before the anchor window');
    // The stack result, the plan, the tap with who, the level change.
    expect(text).toContain('by vocabulary at 0.82: surface web, component checkout, owner mia, repo acme/web');
    expect(text).toContain('none, 1 candidates, best WEB-9 at 0.31');
    expect(text).toContain('create at level 2, High: Checkout returns 500');
    expect(text).toContain('[U-MIA (engineer)]  fix-preview card: approve_fix');
    expect(text).toContain('1 to 2: engineer approved the fix');
    // Fixer, review, CI, merge, status message.
    expect(text).toContain('run run-1 attempt 1 on claude-code');
    expect(text).toContain('PR #41 on snapwing/web-1');
    expect(text).toContain('review-passed');
    expect(text).toContain('PR #41 at abcdef1');
    expect(text).toContain('PR #41 at level 2');
    expect(text).toContain('message 1727773199.000200');
    expect(text).toContain('verified on staging');

    const order = ['captured', 'context-assembled', 'resolved', 'planned', 'filed', 'tapped', 'level-changed', 'fixer-started', 'pr-opened', 'review-passed', 'ci-green', 'merged', 'status-message-posted', 'closed'];
    const positions = order.map((type) => text.search(new RegExp(`^ *\\d+  \\S+  ${type} `, 'm')));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });

  it('prints a stopped incident by id, with the ask-back and the stop', async () => {
    const result = await run(['trace', STOPPED]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Trace WEB-2');
    expect(result.out).toContain('asked the reporter (component): Which page?');
    expect(result.out).toContain('[U-REPORTER (reporter)]  answered question at seq 3: The search page');
    expect(result.out).toContain('[U-MIA (engineer)]  wrong direction');
    expect(result.out).not.toContain('pr-opened');
  });

  it('--json prints the incident events', async () => {
    const result = await run(['trace', 'WEB-2', '--json']);
    expect(result.code).toBe(0);
    const events = JSON.parse(result.out) as { type: string; seq: number; incidentId: string }[];
    expect(events.map((e) => e.type)).toEqual(['captured', 'resolved', 'clarified', 'clarify-answered', 'planned', 'filed', 'fixer-started', 'stopped']);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(events.map((e) => e.incidentId))).toEqual(new Set([STOPPED]));
  });

  it('exits 1 for an unknown incident and for bad arguments', async () => {
    const missing = await run(['trace', 'WEB-404']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no incident matches "WEB-404"');
    expect((await run(['trace'])).code).toBe(1);
    expect((await run(['trace', 'WEB-1', 'WEB-2'])).code).toBe(1);
    expect((await run(['trace', '--nope'])).code).toBe(1);
  });
});

describe('snapwing metrics', () => {
  it('counts the window: per surface, timings, autopilot, degradations, ask-back', async () => {
    const result = await run(['metrics', '--since', '2026-10-01', '--json']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const m = JSON.parse(result.out) as ReturnType<typeof computeMetrics>;
    expect(m.opened).toBe(3);
    expect(m.closed).toBe(1);
    expect(m.perSurface).toEqual([
      { surface: 'api', opened: 1, closed: 0 },
      { surface: 'web', opened: 2, closed: 1 },
    ]);
    // To PR: 30 min (level 2) and 50 min (autopilot); to merge: 120 min and 120 min.
    expect(m.timeToPr).toEqual({ count: 2, medianMs: 30 * 60_000, p90Ms: 50 * 60_000 });
    expect(m.timeToMerge).toEqual({ count: 2, medianMs: 120 * 60_000, p90Ms: 120 * 60_000 });
    expect(m.autopilotMerges).toBe(1);
    expect(m.reverts).toBe(1);
    expect(m.degradations).toBe(1);
    expect(m.askedBack).toBe(1);
    expect(m.askBackRate).toBeCloseTo(1 / 3);
  });

  it('prints the table and honors the window', async () => {
    const all = await run(['metrics', '--since', '2026-08-01']);
    expect(all.code).toBe(0);
    expect(all.out).toContain('4 opened, 1 closed');
    const recent = await run(['metrics', '--since', '2026-10-01']);
    expect(recent.out).toContain('3 opened, 1 closed');
    expect(recent.out).toMatch(/web\s+2\s+1/);
    expect(recent.out).toContain('Time to PR:    median 30m, p90 50m (2 incidents)');
    expect(recent.out).toContain('Time to merge: median 2h, p90 2h (2 incidents)');
    expect(recent.out).toContain('Autopilot merges: 1, reverts: 1');
    expect(recent.out).toContain('Degradations: 1');
    expect(recent.out).toContain('Ask-back rate: 33% (1 of 3)');
  });

  it('rejects an unreadable window', async () => {
    const result = await run(['metrics', '--since', 'lately']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot read --since "lately"');
  });
});

describe('metrics helpers', () => {
  it('parseSince reads hours, days, weeks, and dates', () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    expect(parseSince('30d', now)?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(parseSince('12h', now)?.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(parseSince('1w', now)?.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(parseSince('2026-09-01', now)?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseSince('soon', now)).toBeUndefined();
  });

  it('an empty log gives zero figures and no timings', () => {
    const m = computeMetrics([], new Date(0), new Date('2026-10-10T00:00:00.000Z'));
    expect(m.opened).toBe(0);
    expect(m.askBackRate).toBe(0);
    expect(m.timeToPr).toEqual({ count: 0 });
  });
});
