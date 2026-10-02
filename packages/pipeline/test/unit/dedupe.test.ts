// Unit tests for dedupe before create (main 6): a fake JiraSearch and the local kv cache on the
// SNAPWING_DB dialect.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContextBundle, Resolution } from '../../src/contracts/incident.ts';
import {
  buildDedupeQueries,
  dedupe,
  normalizeSummary,
  recentIncidentKey,
  rememberIncident,
  scoreSummaries,
  summaryHash,
  RECENT_INCIDENT_TTL_SEC,
  type JiraSearch,
  type JiraSearchHit,
} from '../../src/dedupe/index.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

class FakeJira implements JiraSearch {
  readonly calls: { jql: string; limit: number }[] = [];
  constructor(private readonly issues: JiraSearchHit[]) {}
  search(jql: string, limit: number): Promise<JiraSearchHit[]> {
    this.calls.push({ jql, limit });
    return Promise.resolve(this.issues.slice(0, limit));
  }
}

const resolution: Resolution = { surfaceId: 'web', componentId: 'nav', jiraProject: 'WEB', resolvedBy: 'mention', confidence: 0.9 };

const bundleFor = (text: string): ContextBundle => ({
  anchorId: 'a1',
  included: [{ id: 'a1', authorId: 'U1', text, timestamp: '2026-10-02T09:00:00.000Z', mentions: [], reactions: [], attachments: [] }],
  excluded: [],
  windowUsed: { oldest: '2026-10-02T08:00:00.000Z', latest: '2026-10-02T09:00:00.000Z', cap: 50 },
});

describe('summary normalization', () => {
  it('ignores case, punctuation, accents, filler words, and word order', () => {
    expect(normalizeSummary('  Nav DROPDOWN   not-rendering, on Safari!! ')).toBe('nav dropdown not rendering on safari');
    expect(normalizeSummary('Café crash')).toBe('cafe crash');
    expect(summaryHash('The nav dropdown is not rendering on Safari')).toBe(summaryHash('safari: nav dropdown NOT rendering'));
    expect(summaryHash('nav dropdown broken')).not.toBe(summaryHash('footer link broken'));
  });

  it('keys the cache by surface, component, and hash', () => {
    const k = recentIncidentKey(resolution, 'Nav dropdown broken');
    expect(k).toBe(`dedupe:recent:web:nav:${summaryHash('nav dropdown broken')}`);
    expect(recentIncidentKey({}, 'Nav dropdown broken')).toContain(':-:-:');
    expect(recentIncidentKey({ surfaceId: 'api', componentId: 'nav' }, 'Nav dropdown broken')).not.toBe(k);
  });
});

describe('scoreSummaries', () => {
  it('is 1 for the same words, high for a close paraphrase, near 0 for unrelated', () => {
    expect(scoreSummaries('nav dropdown not rendering', 'Nav dropdown not rendering!')).toBe(1);
    expect(scoreSummaries('nav dropdown not rendering on safari', 'Nav dropdown not rendering on Safari 17')).toBeGreaterThan(0.7);
    expect(scoreSummaries('nav dropdown not rendering', 'invoice export times out')).toBe(0);
    expect(scoreSummaries('', 'anything')).toBe(0);
  });
});

describe('buildDedupeQueries', () => {
  it('scopes to the project, open issues, 30 days, and escapes quotes', () => {
    const q = buildDedupeQueries('WEB', 'the "nav" dropdown');
    expect(q.recent).toBe('project = "WEB" AND statusCategory != Done AND updated >= -30d ORDER BY updated DESC');
    expect(q.fullText).toBe('project = "WEB" AND statusCategory != Done AND updated >= -30d AND text ~ "dropdown nav" ORDER BY updated DESC');
    expect(buildDedupeQueries(undefined, 'x y').recent).toBe('statusCategory != Done AND updated >= -30d ORDER BY updated DESC');
    expect(buildDedupeQueries('A"B', 'x').recent).toContain('project = "A\\"B"');
  });
});

describe('dedupe', () => {
  let tdb: TestDatabase;
  let state: OpenedState;
  let nowMs = Date.parse('2026-10-02T09:00:00.000Z');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    state = await tdb.open({ now: () => new Date(nowMs) });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const cache = () => {
    if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
    return createKvCache(state);
  };

  it('runs the recent query and the full-text query over the resolved project', async () => {
    const jira = new FakeJira([]);
    const result = await dedupe(resolution, bundleFor('Nav dropdown not rendering on Safari'), { jira, cache: cache(), limit: 5 });
    expect(result).toEqual({ candidates: [], decision: 'none' });
    expect(jira.calls).toHaveLength(2);
    expect(jira.calls.every((c) => c.limit === 5)).toBe(true);
    expect(jira.calls[0]?.jql).toContain('updated >= -30d');
    expect(jira.calls[1]?.jql).toContain('text ~ "dropdown nav not rendering safari"');
  });

  it('returns scored candidates above the threshold, best first, and drops the rest', async () => {
    const jira = new FakeJira([
      { key: 'WEB-900', summary: 'Invoice export times out' },
      { key: 'WEB-812', summary: 'Nav dropdown not rendering on Safari', assignee: 'Dana' },
      { key: 'WEB-820', summary: 'Nav dropdown not rendering on Safari 17 beta build' },
    ]);
    const result = await dedupe(resolution, bundleFor('Nav dropdown not rendering on Safari'), { jira, cache: cache() });
    expect(result.decision).toBe('pending-user');
    expect(result.candidates.map((c) => c.issueKey)).toEqual(['WEB-812', 'WEB-820']);
    expect(result.candidates[0]).toEqual({ issueKey: 'WEB-812', summary: 'Nav dropdown not rendering on Safari', score: 1, assignee: 'Dana' });
    expect(result.candidates[1]?.score).toBeLessThan(1);
  });

  it('honors a configurable threshold', async () => {
    const jira = new FakeJira([{ key: 'WEB-820', summary: 'Nav dropdown not rendering on Safari 17 beta build' }]);
    const bundle = bundleFor('Nav dropdown not rendering on Safari');
    const strict = await dedupe(resolution, bundle, { jira, cache: cache(), threshold: 0.99 });
    expect(strict).toEqual({ candidates: [], decision: 'none' });
    const loose = await dedupe(resolution, bundle, { jira, cache: cache(), threshold: 0.3 });
    expect(loose.candidates.map((c) => c.issueKey)).toEqual(['WEB-820']);
  });

  it('lists an issue once when both searches return it', async () => {
    const jira = new FakeJira([{ key: 'WEB-812', summary: 'Nav dropdown not rendering on Safari' }]);
    const result = await dedupe(resolution, bundleFor('Nav dropdown not rendering on Safari'), { jira, cache: cache() });
    expect(result.candidates).toHaveLength(1);
  });

  it('finds an incident filed minutes ago from another channel via the cache, though Jira does not return it', async () => {
    const c = cache();
    await rememberIncident(c, resolution, { issueKey: 'WEB-901', summary: 'Safari: nav dropdown NOT rendering', assignee: 'Dana' });
    nowMs += 5 * 60_000;
    const result = await dedupe(resolution, bundleFor('the nav dropdown is not rendering on Safari'), { jira: new FakeJira([]), cache: c });
    expect(result.decision).toBe('pending-user');
    expect(result.candidates).toEqual([{ issueKey: 'WEB-901', summary: 'Safari: nav dropdown NOT rendering', score: 1, assignee: 'Dana' }]);
  });

  it('does not match the cache across another surface or component', async () => {
    const c = cache();
    await rememberIncident(c, resolution, { issueKey: 'WEB-902', summary: 'checkout button unresponsive' });
    const other = { ...resolution, componentId: 'checkout' };
    const result = await dedupe(other, bundleFor('checkout button unresponsive'), { jira: new FakeJira([]), cache: c });
    expect(result.candidates).toEqual([]);
  });

  it('expires the cache entry after seven days', async () => {
    const c = cache();
    await rememberIncident(c, resolution, { issueKey: 'WEB-903', summary: 'login page blank' });
    nowMs += (RECENT_INCIDENT_TTL_SEC - 1) * 1000;
    expect((await dedupe(resolution, bundleFor('login page blank'), { jira: new FakeJira([]), cache: c })).candidates).toHaveLength(1);
    nowMs += 1000;
    expect((await dedupe(resolution, bundleFor('login page blank'), { jira: new FakeJira([]), cache: c })).candidates).toHaveLength(0);
  });

  it('ignores a corrupt cache value and an empty summary', async () => {
    const c = cache();
    await c.set(recentIncidentKey(resolution, 'garbled entry here'), 'not json', 60);
    expect((await dedupe(resolution, bundleFor('garbled entry here'), { jira: new FakeJira([]), cache: c })).decision).toBe('none');
    const jira = new FakeJira([{ key: 'WEB-1', summary: 'x' }]);
    expect(await dedupe(resolution, bundleFor('   '), { jira, cache: c })).toEqual({ candidates: [], decision: 'none' });
    expect(jira.calls).toHaveLength(0);
  });

  it('takes the first line of the anchor message as the summary unless one is given', async () => {
    const jira = new FakeJira([]);
    await dedupe(resolution, bundleFor('\nlogin broken\nmore detail below'), { jira, cache: cache() });
    expect(jira.calls[1]?.jql).toContain('text ~ "broken login"');
    await dedupe(resolution, bundleFor('ignored'), { jira, cache: cache(), summary: 'override words' });
    expect(jira.calls[3]?.jql).toContain('text ~ "override words"');
  });
});
