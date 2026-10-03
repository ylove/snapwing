// Digests (A 4.6, #302). A seeded log on the dialect `SNAPWING_DB` selects, the in-process workflow,
// and a fake clock: the digest is what the log and projections say, posted by the cron job.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaybookDigest } from '../../src/config/playbook.ts';
import type { EventPayloads, EventType, NewEvent } from '../../src/contracts/events.ts';
import {
  buildDigest,
  digestWindow,
  FALLBACK_WINDOW_MS,
  humanDuration,
  MAX_DIGESTS,
  registerDigestJobs,
  renderDigest,
  type DigestDeps,
} from '../../src/notify/digest.ts';
import { LOG_START, type OpenedState } from '../../src/ports/state.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const WS = '01K6WORKSPACE0000000000000';
const OTHER_WS = '01K6WORKSPACE0000000000009';
const CRON = '0 9 * * 1-5';
const MONDAY_9 = Date.parse('2026-10-05T09:00:00.000Z');
const FRIDAY_9 = Date.parse('2026-10-02T09:00:00.000Z');
const H = 3_600_000;
const M = 60_000;
const at = (ms: number): string => new Date(ms).toISOString();

const A = '01K6DIGEST0000000000000001';
const B = '01K6DIGEST0000000000000002';
const C = '01K6DIGEST0000000000000003';
const D = '01K6DIGEST0000000000000004';
const E = '01K6DIGEST0000000000000005';
const F = '01K6DIGEST0000000000000006';

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];
let posts: { to: string; text: string }[];
let failPost: boolean;

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = FRIDAY_9;
  errors = [];
  posts = [];
  failPost = false;
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
});

function deps(extra: Partial<DigestDeps> = {}): DigestDeps {
  return {
    state,
    workflow: wf,
    clock: () => new Date(now),
    post: (to, text) => {
      if (failPost) return Promise.reject(new Error('slack unavailable'));
      posts.push({ to, text });
      return Promise.resolve();
    },
    ...extra,
  };
}

// Seeding -----------------------------------------------------------------------------------------

function ev<T extends EventType>(workspaceId: string, id: string, type: T, when: number, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId, incidentId: id, type, v: 1, source: 'agent', occurredAt: at(when), payload } as unknown as NewEvent<T>;
}

/** Captured at `t`, through `filed` over the next minutes. */
function filed(id: string, t: number, key: string, ws = WS): NewEvent[] {
  return [
    ev(ws, id, 'captured', t, {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${id}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev(ws, id, 'context-assembled', t + M, { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev(ws, id, 'resolved', t + 2 * M, { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev(ws, id, 'dedupe-checked', t + 3 * M, { candidates: [], decision: 'none' }),
    ev(ws, id, 'planned', t + 4 * M, {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: `Problem in ${key}`,
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: 3,
      implementationRequest: { artifactId: '01K6REQUEST0000000000000001', version: 1 },
    }),
    ev(ws, id, 'filed', t + 5 * M, { jiraKey: key }),
  ];
}

/** A fixer run that opens PR `pr` one minute after `t` and passes review. */
function withPr(id: string, t: number, pr: number): NewEvent[] {
  return [
    ev(WS, id, 'fixer-started', t, { runId: `${id}-run`, harness: 'claude-code', attempt: 1 }),
    ev(WS, id, 'pr-opened', t + M, { prNumber: pr, branch: `fix/${id}` }),
    ev(WS, id, 'review-passed', t + 2 * M, { prNumber: pr }),
  ];
}

async function seed(id: string, ...events: NewEvent[]): Promise<void> {
  const last = (await state.read(id)).at(-1)?.seq ?? 0;
  await state.append(id, events, last);
}

/**
 * Waits until `readSince` returns every event seeded so far. On Postgres it withholds events at or
 * above the cluster's oldest in-flight transaction (ADR 0013), and other test files' transactions
 * count; SQLite is settled at once.
 */
async function settled(): Promise<void> {
  let committed = 0;
  for (const id of [A, B, C, D, E, F]) committed += (await state.read(id)).length;
  const deadline = Date.now() + 15_000;
  for (;;) {
    let seen = 0;
    let cursor = LOG_START;
    for (;;) {
      const page = await state.readSince(cursor, 500);
      if (page.events.length === 0) break;
      seen += page.events.length;
      cursor = page.cursor;
    }
    if (seen >= committed) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for readSince to pass the seeded log');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Window: Friday 09:00 to Monday 09:00.
 * A: opened Saturday, PR 40 minutes after capture, merged at level 3, then reverted (a reverted incident is still open).
 * B: opened Sunday, PR 2 hours after capture, still open, waiting on CI.
 * C: opened Thursday, open, waiting on a person.
 * D: opened Wednesday, closed Sunday.
 * E: opened Tuesday, open, waiting on a review (the oldest).
 * F: opened Monday 08:00, open (the newest open; not among the three oldest).
 */
async function seedWeekend(): Promise<void> {
  const sat = Date.parse('2026-10-03T10:00:00.000Z');
  const sun = Date.parse('2026-10-04T08:00:00.000Z');
  await seed(A, ...filed(A, sat, 'WEB-1'));
  await seed(
    A,
    ev(WS, A, 'fixer-started', sat + 20 * M, { runId: `${A}-run`, harness: 'claude-code', attempt: 1 }),
    ev(WS, A, 'pr-opened', sat + 40 * M, { prNumber: 11, branch: 'fix/a' }),
    ev(WS, A, 'review-passed', sat + 41 * M, { prNumber: 11 }),
  );
  await seed(
    A,
    ev(WS, A, 'ci-green', sat + 45 * M, { prNumber: 11, headSha: 'a'.repeat(40) }),
    ev(WS, A, 'merged', sat + 50 * M, { prNumber: 11, mergeCommitSha: 'b'.repeat(40), levelAtMergeTime: 3 }),
  );
  await seed(A, ev(WS, A, 'reverted', sat + 5 * H, { prNumber: 11, reason: 'checkout broke' }));

  await seed(B, ...filed(B, sun, 'WEB-2'));
  await seed(B, ...withPr(B, sun + 109 * M, 12));
  await seed(B, ev(WS, B, 'waiting-changed', sun + 2 * H + 5 * M, { waitingOn: { kind: 'ci', who: 'required checks' } }));

  await seed(C, ...filed(C, Date.parse('2026-10-01T10:00:00.000Z'), 'WEB-3'));
  await seed(C, ev(WS, C, 'waiting-changed', Date.parse('2026-10-01T11:00:00.000Z'), { waitingOn: { kind: 'human', who: 'U-FAKE-DANA' } }));

  await seed(D, ...filed(D, Date.parse('2026-09-30T10:00:00.000Z'), 'WEB-4'));
  await seed(D, ev(WS, D, 'not-a-bug', Date.parse('2026-10-04T12:00:00.000Z'), { reason: 'works as designed' }));

  await seed(E, ...filed(E, Date.parse('2026-09-29T12:00:00.000Z'), 'WEB-5'));
  await seed(E, ...withPr(E, Date.parse('2026-09-30T12:00:00.000Z'), 13));
  await seed(E, ev(WS, E, 'waiting-changed', Date.parse('2026-09-30T12:05:00.000Z'), { waitingOn: { kind: 'review' } }));

  await seed(F, ...filed(F, Date.parse('2026-10-05T08:00:00.000Z'), 'WEB-6'));
  await settled();
}

// Tests -------------------------------------------------------------------------------------------

describe('digestWindow', () => {
  it('runs from the previous fire, so a Monday digest covers the weekend', () => {
    const w = digestWindow(CRON, new Date(MONDAY_9));
    expect(w.from.toISOString()).toBe('2026-10-02T09:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-05T09:00:00.000Z');
  });

  it('is one week for a weekly cron, and the fallback when the cron has no earlier fire', () => {
    expect(digestWindow('0 9 * * 1', new Date(MONDAY_9)).from.toISOString()).toBe('2026-09-28T09:00:00.000Z');
    const yearly = digestWindow('0 0 1 1 *', new Date('2026-01-01T00:00:00.000Z'));
    expect(yearly.to.getTime() - yearly.from.getTime()).toBe(FALLBACK_WINDOW_MS);
  });
});

describe('buildDigest', () => {
  it('counts opened and closed, time to PR, autopilot merges and reverts, and lists the three oldest open with what they wait on', async () => {
    await seedWeekend();
    const digest = await buildDigest({ state }, digestWindow(CRON, new Date(MONDAY_9)));
    expect(digest.opened).toBe(3);
    expect(digest.closed).toBe(1);
    expect(digest.pullRequests).toBe(2);
    expect(digest.medianTimeToPrMs).toBe(75 * M);
    expect(digest.slowestTimeToPrMs).toBe(110 * M);
    expect(digest.autopilotMerges).toBe(1);
    expect(digest.reverts).toBe(1);
    expect(digest.oldestOpen.map((o) => [o.label, o.waitingOn, o.who])).toEqual([
      ['WEB-5', 'review', undefined],
      ['WEB-3', 'human', 'U-FAKE-DANA'],
      ['WEB-1', 'nothing', undefined],
    ]);
  });

  it('keeps a merge below level 3 out of the autopilot count, and another workspace out of a scoped digest', async () => {
    const sat = Date.parse('2026-10-03T10:00:00.000Z');
    await seed(A, ...filed(A, sat, 'WEB-1'));
    await seed(A, ...withPr(A, sat + 20 * M, 11));
    await seed(
      A,
      ev(WS, A, 'ci-green', sat + 45 * M, { prNumber: 11, headSha: 'a'.repeat(40) }),
      ev(WS, A, 'merged', sat + 50 * M, { prNumber: 11, mergeCommitSha: 'b'.repeat(40), levelAtMergeTime: 2 }),
    );
    await seed(B, ...filed(B, sat, 'OTH-1', OTHER_WS));
    await settled();
    const w = digestWindow(CRON, new Date(MONDAY_9));
    const mine = await buildDigest({ state, workspaceId: WS }, w);
    expect(mine).toMatchObject({ opened: 1, autopilotMerges: 0, reverts: 0 });
    expect(mine.oldestOpen.map((o) => o.label)).toEqual(['WEB-1']);
    expect((await buildDigest({ state }, w)).opened).toBe(2);
  });

  it('is empty and says so when nothing happened', async () => {
    const text = renderDigest(await buildDigest({ state }, digestWindow(CRON, new Date(MONDAY_9))));
    expect(text).toContain('Opened 0 incidents, closed 0.');
    expect(text).toContain('no pull requests opened');
    expect(text).toContain('Autopilot: 0 merges, 0 reverts.');
    expect(text).toContain('Nothing is open.');
  });
});

describe('renderDigest', () => {
  it('reads as a short message with the oldest incidents and their waits', async () => {
    await seedWeekend();
    const text = renderDigest(await buildDigest({ state }, digestWindow(CRON, new Date(MONDAY_9))));
    expect(text.split('\n')).toEqual([
      'Snapwing digest, 2026-10-02 to 2026-10-05',
      'Opened 3 incidents, closed 1.',
      'Time to PR: median 1h 15m, slowest 1h 50m, across 2 pull requests.',
      'Autopilot: 1 merge, 1 revert.',
      'Oldest open 3 incidents:',
      '- WEB-5, Problem in WEB-5: open 5d 21h, waiting on the review.',
      '- WEB-3, Problem in WEB-3: open 3d 23h, waiting on an engineer (U-FAKE-DANA).',
      '- WEB-1, Problem in WEB-1: open 1d 23h, waiting on nothing in particular.',
    ]);
    expect(text).not.toContain('—');
  });

  it('rounds durations to two units', () => {
    expect(humanDuration(30_000)).toBe('under a minute');
    expect(humanDuration(40 * M)).toBe('40m');
    expect(humanDuration(2 * H)).toBe('2h');
    expect(humanDuration(26 * H)).toBe('1d 2h');
  });
});

describe('digest cron job (playbook digest to cron)', () => {
  const digests: PlaybookDigest[] = [{ to: '#eng-leads', cron: CRON }];

  it('is off by default: no digests registers no job and posts nothing', async () => {
    expect(await registerDigestJobs(deps(), [])).toEqual([]);
    await seedWeekend();
    now = MONDAY_9 + 24 * H;
    await wf.drain();
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('posts the digest to the playbook target when the cron fires on the fake clock, and not before', async () => {
    await seedWeekend();
    now = Date.parse('2026-10-03T00:00:00.000Z');
    expect(await registerDigestJobs(deps(), digests)).toEqual(['digest.0']);
    await wf.drain();
    expect(posts).toEqual([]);

    now = Date.parse('2026-10-05T08:59:00.000Z');
    await wf.drain();
    expect(posts).toEqual([]);

    now = MONDAY_9 + 30_000;
    await wf.drain();
    expect(errors).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.to).toBe('#eng-leads');
    expect(posts[0]?.text).toContain('Opened 3 incidents, closed 1.');
    expect(posts[0]?.text).toContain('Autopilot: 1 merge, 1 revert.');
    expect(posts[0]?.text).toContain('WEB-5');

    // The next day's window starts at Monday 09:00, so the weekend is not repeated.
    now = Date.parse('2026-10-06T09:00:30.000Z');
    await wf.drain();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.text).toContain('Opened 0 incidents, closed 0.');
    expect(posts[1]?.text).toContain('Snapwing digest, 2026-10-05 to 2026-10-06');
  });

  it('gives each playbook digest its own cron and target', async () => {
    await seedWeekend();
    now = Date.parse('2026-10-05T08:00:00.000Z');
    const two: PlaybookDigest[] = [
      { to: '#eng-leads', cron: CRON },
      { to: 'U-FAKE-DANA', cron: '30 9 * * 1' },
    ];
    expect(await registerDigestJobs(deps(), two)).toEqual(['digest.0', 'digest.1']);
    now = Date.parse('2026-10-05T09:45:00.000Z');
    await wf.drain();
    expect(posts.map((p) => p.to).sort()).toEqual(['#eng-leads', 'U-FAKE-DANA']);
  });

  it('rejects a bad cron and too many digests at registration', async () => {
    await expect(registerDigestJobs(deps(), [{ to: '#x', cron: '0 9 *' }])).rejects.toThrow(/cron/);
    const many = Array.from({ length: MAX_DIGESTS + 1 }, (_, i) => ({ to: `#c${String(i)}`, cron: CRON }));
    await expect(registerDigestJobs(deps(), many)).rejects.toThrow(RangeError);
  });

  it('fails the job when the post fails, so the workflow can retry it', async () => {
    await seedWeekend();
    now = Date.parse('2026-10-05T08:00:00.000Z');
    await registerDigestJobs(deps(), digests);
    failPost = true;
    now = MONDAY_9 + 30_000;
    await wf.drain();
    expect(posts).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    errors = [];
  });
});
