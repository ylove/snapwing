// The notify hook wired into `projectIncident`. Events go through a real store (both
// dialects, `SNAPWING_DB`), so what the projection reads is what production reads: the cached
// playbook, the incident's and the standing subscriptions, the channel member list, and the rows of
// the open burst window. Also the standing subscription writers and the DM phrases that use them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewEvent } from '../../src/contracts/events.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { applyStandingWatch, parseStandingWatch, resolveWatchTarget } from '../../src/signals/standing.ts';
import { channelMembersKey } from '../../src/state/projections/notify-context.ts';
import type { NotifyRow } from '../../src/state/projections/outbox/notify.ts';
import { StateStore } from '../../src/state/store.ts';
import { rebuild } from '../../src/state/rebuild.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-01T15:00:00.000Z'); // 11:00 in New York
const REPORTER = 'U-FAKE-REPORTER';
const KEY = 'WEB-1042';
const CHANNEL = 'C-FAKE';

let tdb: TestDatabase;
let state: OpenedState;
let time = T0;
const workspaceId = '01JZ0000000000000000000001';
let serial = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  await tdb.drop();
});

const iso = (): string => new Date(time).toISOString();

function ev<T extends NewEvent['type']>(incidentId: string, type: T, payload: Extract<NewEvent, { type: T }>['payload'], source: NewEvent['source'] = 'agent'): NewEvent {
  return { workspaceId, incidentId, type, v: 1, source, occurredAt: iso(), payload } as unknown as NewEvent;
}

/** Captures an incident on surface `web` (a Slack thread) and files it. Returns its id. */
async function filedIncident(opts: { priority?: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest'; surface?: string; file?: boolean; triggeredBy?: string } = {}): Promise<{ id: string; seq: number }> {
  serial += 1;
  const id = `01JZ0000000000000000${String(serial).padStart(6, '0')}`;
  const drafts: NewEvent[] = [
    ev(id, 'captured', {
      kind: 'incident',
      idempotencyKey: `slack:${id}`,
      source: 'slack',
      // An engineer's trigger on the reporter's post: the engineer brought it in, the reporter wrote it.
      ...(opts.triggeredBy === undefined
        ? { reporter: { id: REPORTER, name: 'Test Reporter', role: 'reporter' } }
        : { reporter: { id: opts.triggeredBy, name: 'Test Engineer', role: 'engineer' }, anchorAuthor: { id: REPORTER, name: 'Test Reporter', role: 'reporter' } }),
      anchorText: 'Checkout says 500',
      anchorId: '1700000000.000100',
      channelId: CHANNEL,
    }, 'slack'),
    ev(id, 'context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 1, excludedCount: 0 }),
    ev(id, 'resolved', { surfaceId: opts.surface ?? 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev(id, 'dedupe-checked', { candidates: [], decision: 'none' }),
    ev(id, 'planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500',
      priority: opts.priority ?? 'Medium',
      labels: ['snapwing'],
      autonomyLevel: 2,
      implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
    }),
  ];
  let { seq } = await state.append(id, drafts, 0);
  if (opts.file !== false) seq = await push(id, seq, ev(id, 'filed', { jiraKey: `${KEY}-${String(serial)}` }));
  return { id, seq };
}

async function push(id: string, seq: number, ...events: NewEvent[]): Promise<number> {
  return (await state.append(id, events, seq)).seq;
}

async function notifyRows(id: string): Promise<OutboxItem[]> {
  const rows: OutboxItem[] = [];
  const far = time;
  time = far + 400 * 24 * 3600 * 1000;
  try {
    for (let page = await state.drainOutbox('slack', 1000); page.length > 0; page = await state.drainOutbox('slack', 1000)) {
      rows.push(...page);
      await state.ackOutbox(page.map((r) => r.id));
    }
  } finally {
    time = far;
  }
  return rows.filter((r) => r.incidentId === id && r.op === 'notify');
}

const toMerged = (id: string): NewEvent[] => {
  return [
    ev(id, 'review-passed', { prNumber: 418 }),
    ev(id, 'ci-green', { prNumber: 418, headSha: 'abc' }),
    ev(id, 'merged', { prNumber: 418, sha: 'abc', levelAtMergeTime: 2 } as never, 'github'),
  ];
};

const payload = (r: OutboxItem): NotifyRow => r.payload as unknown as NotifyRow;

const FORCE_HIGH = `<playbook xmlns="urn:snapwing:playbook:v1" version="1"><notifications><forcePush priority="High"/></notifications></playbook>`;

describe('the wired hook (A 4.4)', () => {
  it('is silent with no watcher and no policy, even on a milestone', async () => {
    time += 3_600_000;
    const { id } = await filedIncident();
    expect(await notifyRows(id)).toEqual([]);
  });

  it('mentions a standing surface subscriber on a milestone', async () => {
    time += 3_600_000;
    await state.subscribe({ workspaceId, userId: 'U-PAT', scopeKind: 'surface', scopeId: 'web', channel: 'thread', createdAt: iso() });
    await state.subscribe({ workspaceId, userId: 'U-OTHER', scopeKind: 'surface', scopeId: 'api', channel: 'thread', createdAt: iso() });
    const { id } = await filedIncident();
    const rows = await notifyRows(id);
    expect(rows).toHaveLength(1);
    expect(payload(rows[0] as OutboxItem)).toMatchObject({ delivery: 'thread', mentions: ['U-PAT'], milestone: 'filed', reason: 'watch' });
    await state.unsubscribe({ workspaceId, userId: 'U-PAT', scopeKind: 'surface', scopeId: 'web' });
    await state.unsubscribe({ workspaceId, userId: 'U-OTHER', scopeKind: 'surface', scopeId: 'api' });
  });

  it('joins a milestone inside the open window to its batch, and opens a new one after it closes', async () => {
    time += 3_600_000;
    await state.subscribe({ workspaceId, userId: 'U-ALL', scopeKind: 'all', channel: 'thread', createdAt: iso() });
    const { id, seq } = await filedIncident();
    time += 60_000;
    const next = await push(id, seq, ev(id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }), ev(id, 'pr-opened', { prNumber: 418, branch: 'fix/x' }, 'github'));
    const [filed, prOpen] = await notifyRows(id);
    expect(payload(filed as OutboxItem).milestone).toBe('filed');
    expect(payload(prOpen as OutboxItem).milestone).toBe('pr-open');
    // One window: same key, same batch_key, same send time (five minutes after the first).
    expect(payload(prOpen as OutboxItem).windowKey).toBe(payload(filed as OutboxItem).windowKey);
    expect(prOpen?.batchKey).toBe(filed?.batchKey);
    expect(prOpen?.nextAttempt).toBe(filed?.nextAttempt);
    expect(Date.parse(filed?.nextAttempt ?? '') - Date.parse(filed?.createdAt ?? '')).toBe(300_000);

    time += 10 * 60_000;
    await push(id, next, ...toMerged(id));
    const [merged] = await notifyRows(id);
    expect(payload(merged as OutboxItem).windowKey).not.toBe(payload(filed as OutboxItem).windowKey);
    await state.unsubscribe({ workspaceId, userId: 'U-ALL', scopeKind: 'all' });
  });

  it('reads the cached playbook: forcePush mentions the reporter with no watchers', async () => {
    time += 3_600_000;
    await state.putConfigVersion('playbook', 'hash-force-high', FORCE_HIGH);
    const high = await filedIncident({ priority: 'High' });
    const low = await filedIncident({ priority: 'Low' });
    const rows = await notifyRows(high.id);
    expect(rows.map((r) => [payload(r).delivery, payload(r).mentions, payload(r).reason])).toEqual([['thread', [REPORTER], 'policy']]);
    expect(await notifyRows(low.id)).toEqual([]);
  });

  it('sends the reporter the staging request regardless of the playbook, and a DM to a watcher outside the channel', async () => {
    time += 3_600_000;
    await state.putConfigVersion('playbook', 'hash-empty', '<playbook xmlns="urn:snapwing:playbook:v1" version="1"/>');
    if (!(state instanceof StateStore)) throw new Error('not a StateStore');
    await state.kvSet(channelMembersKey(CHANNEL), JSON.stringify([REPORTER]));
    await state.subscribe({ workspaceId, userId: 'U-FAR', scopeKind: 'surface', scopeId: 'web', channel: 'thread', createdAt: iso() });
    const { id, seq } = await filedIncident();
    await notifyRows(id);
    time += 60_000;
    await push(
      id,
      seq,
      ev(id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }),
      ev(id, 'pr-opened', { prNumber: 418, branch: 'fix/x' }, 'github'),
      ...toMerged(id),
      ev(id, 'deployed:staging', { env: 'staging', sha: 'abc' } as never),
    );
    const rows = await notifyRows(id);
    const staging = rows.filter((r) => payload(r).milestone === 'staging');
    expect(staging.map((r) => [payload(r).reason, payload(r).delivery, payload(r).mentions])).toEqual([
      ['request', 'thread', [REPORTER]],
      ['watch', 'dm', ['U-FAR']],
    ]);
    await state.unsubscribe({ workspaceId, userId: 'U-FAR', scopeKind: 'surface', scopeId: 'web' });
  });

  it('asks the anchor\'s author, not the engineer whose trigger brought it in, to check staging', async () => {
    time += 3_600_000;
    await state.putConfigVersion('playbook', 'hash-empty', '<playbook xmlns="urn:snapwing:playbook:v1" version="1"/>');
    const { id, seq } = await filedIncident({ triggeredBy: 'U-FAKE-ENGINEER' });
    expect((await state.getIncident(id))?.reporterId).toBe(REPORTER);
    await notifyRows(id);
    time += 60_000;
    await push(
      id,
      seq,
      ev(id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }),
      ev(id, 'pr-opened', { prNumber: 418, branch: 'fix/x' }, 'github'),
      ...toMerged(id),
      ev(id, 'deployed:staging', { env: 'staging', sha: 'abc' } as never),
    );
    const request = (await notifyRows(id)).filter((r) => payload(r).reason === 'request');
    expect(request.map((r) => [payload(r).delivery, payload(r).mentions])).toEqual([['thread', [REPORTER]]]);
    expect(payload(request[0] as OutboxItem).text).toMatch(new RegExp(`^<@${REPORTER}> .* Can you check\\?$`));
    expect(payload(request[0] as OutboxItem).text).not.toContain('U-FAKE-ENGINEER');
  });

  it('lets a waiting notify row sit without holding back the incident\'s status rows', async () => {
    time += 3_600_000;
    const at = iso();
    const later = new Date(time + 300_000).toISOString();
    const base = { workspaceId, target: 'slack' as const, incidentId: '01JZ0000000000000000WAIT01', attempts: 0 };
    await state.enqueueOutbox({ ...base, id: '01JZ0000000000000000ROW001', op: 'notify', payload: {}, batchKey: 'notify:w:thread', nextAttempt: later, createdAt: at });
    await state.enqueueOutbox({ ...base, id: '01JZ0000000000000000ROW002', op: 'update-status', payload: {}, batchKey: 'status:x', nextAttempt: at, createdAt: new Date(time + 1).toISOString() });
    time += 1000;
    expect((await state.drainOutbox('slack', 10, workspaceId)).map((r) => r.op)).toEqual(['update-status']);
    await state.ackOutbox(['01JZ0000000000000000ROW001', '01JZ0000000000000000ROW002']);
  });

  it('rebuild keeps standing subscriptions and sends nothing', async () => {
    time += 3_600_000;
    await state.subscribe({ workspaceId, userId: 'U-KEEP', scopeKind: 'surface', scopeId: 'web', channel: 'dm', createdAt: iso() });
    const { id } = await filedIncident();
    await notifyRows(id);
    await rebuild(state, { all: true });
    expect(await notifyRows(id)).toEqual([]);
    expect((await state.getSubscriptions(id)).map((s) => [s.userId, s.scopeKind, s.channel])).toEqual([['U-KEEP', 'surface', 'dm']]);
    await state.unsubscribe({ workspaceId, userId: 'U-KEEP', scopeKind: 'surface', scopeId: 'web' });
  });
});

describe('standing subscription writers', () => {
  it('writes one row per person and scope, and changing the channel replaces it', async () => {
    await state.subscribe({ workspaceId, userId: 'U-ONE', scopeKind: 'surface', scopeId: 'web', channel: 'thread', createdAt: '2026-10-01T00:00:00.000Z' });
    await state.subscribe({ workspaceId, userId: 'U-ONE', scopeKind: 'surface', scopeId: 'web', channel: 'dm', createdAt: '2026-10-02T00:00:00.000Z' });
    const { id } = await filedIncident({ file: false });
    const mine = (await state.getSubscriptions(id)).filter((s) => s.userId === 'U-ONE');
    expect(mine).toEqual([{ workspaceId, userId: 'U-ONE', scopeKind: 'surface', scopeId: 'web', channel: 'dm', createdAt: '2026-10-01T00:00:00.000Z' }]);
    expect(await state.unsubscribe({ workspaceId, userId: 'U-ONE', scopeKind: 'surface', scopeId: 'web' })).toBe(true);
    expect(await state.unsubscribe({ workspaceId, userId: 'U-ONE', scopeKind: 'surface', scopeId: 'web' })).toBe(false);
  });

  it('refuses an incident scope and a surface scope with no id', async () => {
    await expect(state.subscribe({ workspaceId, userId: 'U-ONE', scopeKind: 'incident', scopeId: 'x', channel: 'thread', createdAt: iso() })).rejects.toThrow(TypeError);
    await expect(state.subscribe({ workspaceId, userId: 'U-ONE', scopeKind: 'surface', channel: 'thread', createdAt: iso() })).rejects.toThrow(TypeError);
  });
});

describe('standing watch phrases (A 4.4)', () => {
  const map = {
    surfaces: [
      { id: 'web', label: 'Website' },
      { id: 'admin', label: 'Admin Portal' },
    ],
  } as unknown as WorkspaceMap;

  it('parses the ways to ask to be kept posted, and to stop', () => {
    expect(parseStandingWatch('keep me posted on the website')).toEqual({ action: 'watch', target: 'the website', command: false });
    expect(parseStandingWatch('Please keep me updated about admin portal!')).toEqual({ action: 'watch', target: 'admin portal', command: false });
    expect(parseStandingWatch('stop keeping me posted on web')).toEqual({ action: 'unwatch', target: 'web', command: false });
    expect(parseStandingWatch('watch web')).toEqual({ action: 'watch', target: 'web', command: true });
    expect(parseStandingWatch('checkout is broken, keep me posted')).toBeUndefined();
    expect(parseStandingWatch('Cart total is blank')).toBeUndefined();
  });

  it('resolves a surface by id or label, and "everything"', () => {
    expect(resolveWatchTarget(map, 'the website')).toEqual({ kind: 'surface', surfaceId: 'web', label: 'Website' });
    expect(resolveWatchTarget(map, 'web')).toEqual({ kind: 'surface', surfaceId: 'web', label: 'Website' });
    expect(resolveWatchTarget(map, 'everything')).toEqual({ kind: 'all' });
    expect(resolveWatchTarget(map, 'billing')).toBeUndefined();
  });

  it('writes a surface row from a DM, answers an unknown surface, and ignores a bare watch that is a bug report', async () => {
    await filedIncident({ file: false });
    const input = { workspaceId, userId: 'U-DM', channel: 'dm' as const, platform: 'slack' as const, now: new Date(T0) };
    const done = await applyStandingWatch(state, map, { ...input, text: 'keep me posted on the website' });
    expect(done).toMatchObject({ handled: true, changed: true });
    const { id } = await filedIncident({ file: false });
    expect((await state.getSubscriptions(id)).map((s) => [s.userId, s.scopeKind, s.scopeId, s.channel, s.platform])).toContainEqual(['U-DM', 'surface', 'web', 'dm', 'slack']);

    expect(await applyStandingWatch(state, map, { ...input, text: 'keep me posted on billing' })).toMatchObject({ handled: true, changed: false });
    expect(await applyStandingWatch(state, map, { ...input, text: 'watch out, the cart is blank' })).toEqual({ handled: false });

    const stopped = await applyStandingWatch(state, map, { ...input, text: 'stop keeping me posted on the website' });
    expect(stopped).toMatchObject({ handled: true, changed: true });
    expect((await state.getSubscriptions(id)).filter((s) => s.userId === 'U-DM')).toEqual([]);
  });
});
