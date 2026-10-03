// GitHub projector (#336; B 7.1, B 11): drains `target='github'` `add-comment` rows against a fake GitHub
// behind MSW, on the dialect `SNAPWING_DB` selects. The clock is shared by the store and the projector,
// so batch windows, pauses, and backoff move only when a test moves it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import type { GitHubAuth, InstallationTokenRequest } from '../../src/github/auth.ts';
import { COMMENT_WINDOW_MS, createGitHubProjector, parseGitHubRow, GitHubOutboxValidationError, type GitHubProjector, type GitHubProjectorOptions } from '../../src/github/projector.ts';

const API = 'https://api.github.com';
const REPO = 'octo-org/fixture-repo';
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const WS = '01K0000000000000000000WS01';
const INCIDENT = '01K0000000000000000000IN01';

interface Posted {
  repo: string;
  pr: number;
  body: string;
  authorization: string;
}

let posted: Posted[] = [];
/** Answers queued for the next comment posts, in order. */
let failures: { status: number; headers?: Record<string, string>; message?: string }[] = [];
/** Pull requests the fake knows; any other number is a 404. */
let knownPrs = new Set<number>([7, 8]);
const tokenRequests: InstallationTokenRequest[] = [];

const auth: GitHubAuth = {
  async installationToken(request) {
    tokenRequests.push(request);
    return { token: 'test-installation-token', expiresAt: '2026-10-02T13:00:00Z' };
  },
};

const server = setupServer(
  http.post(`${API}/repos/:owner/:name/issues/:pr/comments`, async ({ request, params }) => {
    const pr = Number(params['pr']);
    const failure = failures.shift();
    if (failure !== undefined) {
      return HttpResponse.json({ message: failure.message ?? `injected ${failure.status}` }, { status: failure.status, ...(failure.headers === undefined ? {} : { headers: failure.headers }) });
    }
    if (!knownPrs.has(pr)) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    const { body } = (await request.json()) as { body: string };
    posted.push({ repo: `${String(params['owner'])}/${String(params['name'])}`, pr, body, authorization: request.headers.get('authorization') ?? '' });
    return HttpResponse.json({ id: posted.length, body }, { status: 201 });
  }),
);

let tdb: TestDatabase;
let state: OpenedState;
let time = T0;

beforeAll(async () => {
  server.listen();
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  server.close();
  await tdb.drop();
});

beforeEach(async () => {
  // Clear what earlier tests left: move far ahead, ack everything due, come back.
  time = T0 + 365 * 24 * 3600 * 1000;
  for (let rows = await state.drainOutbox('github', 1000); rows.length > 0; rows = await state.drainOutbox('github', 1000)) {
    await state.ackOutbox(rows.map((r) => r.id));
  }
  time = T0;
  posted = [];
  failures = [];
  knownPrs = new Set([7, 8]);
  tokenRequests.length = 0;
});
afterEach(() => undefined);

function projector(overrides: Partial<GitHubProjectorOptions> = {}): GitHubProjector {
  return createGitHubProjector({ state, auth, workspaceId: WS, now: () => new Date(time), ...overrides });
}

let serial = 0;
/** An `add-comment` row created now; ids increase, so rows enqueued at the same instant drain in order. */
function row(payload: Record<string, unknown>, extra: Partial<OutboxItem> = {}): OutboxItem {
  const at = new Date(time).toISOString();
  const id = `${ulid(time).slice(0, 10)}${String(++serial).padStart(16, '0')}`;
  return { id, workspaceId: WS, target: 'github', incidentId: INCIDENT, op: 'add-comment', payload, attempts: 0, nextAttempt: at, createdAt: at, ...extra };
}

const comment = (text: string, prNumber = 7, repo = REPO): Record<string, unknown> => ({ repo, prNumber, text });

async function enqueue(...rows: OutboxItem[]): Promise<void> {
  for (const r of rows) await state.enqueueOutbox(r);
}

async function parked(): Promise<OutboxItem[]> {
  return (await state.listParkedOutbox('github', 100)).filter((r) => r.workspaceId === WS);
}

describe('batched PR comments', () => {
  it('turns a burst of three attribution rows into one comment after the window', async () => {
    const p = projector();
    const rows = ['a', 'b', 'c'].map((who) => row(comment(`${who} reacted with a thumbs up`), { batchKey: `comment:${INCIDENT}` }));
    await enqueue(...rows);

    time = T0 + 10_000;
    const early = await p.drainOnce();
    expect(early.held).toHaveLength(1);
    expect(posted).toEqual([]);

    time = T0 + COMMENT_WINDOW_MS;
    const report = await p.drainOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repo: REPO, pr: 7, body: 'a reacted with a thumbs up\n\nb reacted with a thumbs up\n\nc reacted with a thumbs up' });
    expect(report.sent.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(tokenRequests[0]).toMatchObject({ repo: REPO, permissions: { pull_requests: 'write' } });
    expect(posted[0]?.authorization).toBe('Bearer test-installation-token');

    expect((await p.drainOnce()).drained).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it('keeps rows of another pull request or batch key apart, and sends an unbatched row at once', async () => {
    const p = projector();
    await enqueue(
      row(comment('on seven'), { batchKey: `comment:${INCIDENT}` }),
      row(comment('on eight', 8), { batchKey: `comment:${INCIDENT}` }),
      row(comment('a hold notice'), { incidentId: '01K0000000000000000000IN02' }),
    );
    expect((await p.drainOnce()).sent).toHaveLength(1);
    expect(posted.map((c) => c.body)).toEqual(['a hold notice']);

    time = T0 + COMMENT_WINDOW_MS;
    await p.drainOnce();
    expect(posted.map((c) => `${c.pr}:${c.body}`).sort()).toEqual(['7:on seven', '8:on eight', '7:a hold notice'].sort());
  });

  it('accepts the map form of the repo, github.com/owner/name', async () => {
    const p = projector();
    await enqueue(row(comment('hold', 7, `github.com/${REPO}`)));
    await p.drainOnce();
    expect(posted[0]).toMatchObject({ repo: REPO, pr: 7 });
  });
});

describe('failures', () => {
  it('pauses the whole drain on a 429 for Retry-After and leaves the row untouched', async () => {
    const p = projector();
    const r = row(comment('hello'));
    await enqueue(r, row(comment('later', 8)));
    failures.push({ status: 429, headers: { 'retry-after': '30' } });

    const first = await p.drainOnce();
    expect(first.pausedUntil).toBe(new Date(T0 + 30_000).toISOString());
    expect(p.pausedUntil()?.getTime()).toBe(T0 + 30_000);
    expect(posted).toEqual([]);
    expect(await p.metrics()).toContain('snapwing_github_drain_paused_seconds{workspace="' + WS + '"} 30');

    time = T0 + 10_000;
    expect((await p.drainOnce()).drained).toBe(0);
    expect(posted).toEqual([]);

    time = T0 + 30_000;
    const resumed = await p.drainOnce();
    expect(resumed.pausedUntil).toBeUndefined();
    expect(posted.map((c) => c.body)).toEqual(['hello', 'later']);
    const sent = (await state.listParkedOutbox('github', 10)).filter((x) => x.id === r.id);
    expect(sent).toEqual([]);
  });

  it('pauses on a secondary rate limit (403 with a rate limit message)', async () => {
    const p = projector();
    await enqueue(row(comment('hello')));
    failures.push({ status: 403, headers: { 'retry-after': '90' }, message: 'You have exceeded a secondary rate limit.' });
    const report = await p.drainOnce();
    expect(report.pausedUntil).toBe(new Date(T0 + 90_000).toISOString());
    expect(report.parked).toEqual([]);
    expect(report.deferred).toEqual([]);
    time = T0 + 90_000;
    await p.drainOnce();
    expect(posted).toHaveLength(1);
  });

  it('parks a row whose pull request is missing and goes on with the next', async () => {
    const p = projector();
    const gone = row(comment('to a deleted pull request', 99));
    await enqueue(gone, row(comment('to a live one', 7), { incidentId: '01K0000000000000000000IN02' }));
    const report = await p.drainOnce();
    expect(report.parked).toEqual([gone.id]);
    expect(posted.map((c) => c.body)).toEqual(['to a live one']);
    const rows = await parked();
    expect(rows.map((r) => r.id)).toEqual([gone.id]);
    expect(rows[0]?.lastError).toContain('404');
    const metrics = await p.metrics();
    expect(metrics).toContain(`snapwing_outbox_parked_rows{target="github",workspace="${WS}"} 1`);
    expect(metrics).toContain(`id="${gone.id}"`);
    // Parked rows are not retried.
    time = T0 + 3600_000;
    expect((await p.drainOnce()).drained).toBe(0);
  });

  it('parks a 422 at once', async () => {
    const p = projector();
    const r = row(comment('locked conversation'));
    await enqueue(r);
    failures.push({ status: 422, message: 'Validation Failed' });
    expect((await p.drainOnce()).parked).toEqual([r.id]);
  });

  it('parks a row whose payload is not an add-comment', async () => {
    const p = projector();
    const bad = row({ repo: REPO, text: 'no pull request number' });
    const other = row(comment('x'), { op: 'add-pr-comment' as OutboxItem['op'] });
    await enqueue(bad, other);
    const report = await p.drainOnce();
    expect(report.parked.sort()).toEqual([bad.id, other.id].sort());
    expect(posted).toEqual([]);
    expect(() => parseGitHubRow(bad)).toThrow(GitHubOutboxValidationError);
  });

  it('defers a server error with a doubling delay and parks it after maxAttempts', async () => {
    const p = projector({ maxAttempts: 2, retryDelayMs: 1000 });
    const r = row(comment('flaky'));
    await enqueue(r);
    failures.push({ status: 500 }, { status: 500 });
    const first = await p.drainOnce();
    expect(first.deferred).toEqual([r.id]);
    time = T0 + 1000;
    const second = await p.drainOnce();
    expect(second.parked).toEqual([r.id]);
    expect((await parked())[0]?.lastError).toContain('gave up after 2 attempts');
  });
});
