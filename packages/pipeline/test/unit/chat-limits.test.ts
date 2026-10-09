// Chat abuse limits (main 16, #272): the per-person and per-incident windows on chat model work, the
// daily model-call budget from the playbook, and who may hear about which incident in a status answer.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultPlaybook, loadPlaybook } from '../../src/config/playbook.ts';
import type { IncidentActor } from '../../src/contracts/incident.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { ModelPort } from '../../src/ports/model.ts';
import { countModelCalls, createChatLimits, type ChatLimitsOptions } from '../../src/policy/limits.ts';
import { askerMayAsk, briefMembers, visibleTo, type StatusAccess } from '../../src/status/ask.ts';

function limits(over: Partial<ChatLimitsOptions> & { at?: { now: number } } = {}) {
  const at = over.at ?? { now: Date.parse('2026-10-08T10:00:00Z') };
  return { at, limits: createChatLimits({ budget: () => 1000, clock: () => new Date(at.now), ...over }) };
}

describe('chat limits', () => {
  it('bounds model work per person and per incident thread in sliding windows', () => {
    const { at, limits: l } = limits({ windows: { perUser: { max: 2, windowMs: 60_000 }, perIncident: { max: 3, windowMs: 60_000 } } });
    expect(l.modelWork('U1', 'T1')).toBeUndefined();
    expect(l.modelWork('U1', 'T1')).toBeUndefined();
    expect(l.modelWork('U1', 'T1')).toBe('user');
    expect(l.modelWork('U2', 'T1')).toBeUndefined();
    expect(l.modelWork('U3', 'T1')).toBe('incident');
    expect(l.modelWork('U3', 'T2')).toBeUndefined();
    at.now += 60_000;
    expect(l.modelWork('U1', 'T1')).toBeUndefined();
  });

  it('bounds new incidents per person, with defaults no team reaches by hand', () => {
    const { at, limits: l } = limits();
    for (let i = 0; i < 20; i++) expect(l.newIncident('U1')).toBeUndefined();
    expect(l.newIncident('U1')).toBe('user');
    expect(l.newIncident('U2')).toBeUndefined();
    at.now += 60 * 60_000;
    expect(l.newIncident('U1')).toBeUndefined();
    for (let i = 0; i < 30; i++) expect(l.modelWork('U9', `T${i % 2}`)).toBeUndefined();
  });

  it('stops new chat model work once the day budget is spent, tells once that day, and starts again the next', async () => {
    const spent: number[] = [];
    const { at, limits: l } = limits({ budget: () => 3, onSpent: (b) => spent.push(b) });
    const answer = { model: 'fake/model' };
    const inner: ModelPort = {
      complete: () => Promise.resolve({ ...answer, text: '' }),
      vision: () => Promise.resolve({ ...answer, readings: [] }),
      classify: () => Promise.reject(new Error('unused')),
    };
    const model = countModelCalls(inner, () => l.countCall());
    await model.complete({ task: 'triage', system: '', prompt: '' });
    await model.vision({ task: 'vision', system: '', prompt: '', images: [] });
    expect(l.overBudget()).toBe(false);
    expect(l.budgetNotice()).toBe(false);
    l.countCall();
    expect(spent).toEqual([3]);
    expect(l.modelWork('U1', 'T1')).toBe('budget');
    expect(l.newIncident('U1')).toBe('budget');
    expect(l.budgetNotice()).toBe(true);
    expect(l.budgetNotice()).toBe(false);
    l.countCall();
    expect(spent).toEqual([3]);
    at.now = Date.parse('2026-10-09T00:00:01Z');
    expect(l.overBudget()).toBe(false);
    expect(l.newIncident('U1')).toBeUndefined();
  });

  it('reads the budget from the playbook: <limits modelCallsPerDay>, default 5000', async () => {
    expect(defaultPlaybook().limits).toEqual({ modelCallsPerDay: 5000 });
    const root = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
    const map = await parseWorkspaceMap(readFileSync(root('examples/workspace-context.example.xml'), 'utf8'));
    const loaded = await loadPlaybook('<playbook xmlns="urn:snapwing:playbook:v1"><limits modelCallsPerDay="40"/></playbook>', map);
    expect(loaded.ok && loaded.playbook.limits).toEqual({ modelCallsPerDay: 40 });
    const zero = await loadPlaybook('<playbook xmlns="urn:snapwing:playbook:v1"><limits modelCallsPerDay="0"/></playbook>', map);
    expect(zero.ok).toBe(false);
  });
});

describe('status access', () => {
  const ASKER: IncidentActor = { id: 'U0ASKER', name: 'ash', role: 'engineer' };
  const view = (id: string, extra: Partial<IncidentView>): IncidentView => ({
    id,
    workspaceId: 'W',
    kind: 'incident',
    lastSeq: 1,
    status: 'filed',
    source: 'slack',
    monitored: false,
    openedAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    ...extra,
  });
  const asked: string[] = [];
  const access: StatusAccess = {
    platform: 'slack',
    membership: (u) => Promise.resolve(u === 'U0GUEST' ? 'guest' : u === 'U0GONE' ? Promise.reject(new Error('down')) : 'member'),
    inChannel: (c) => (asked.push(c), Promise.resolve(c === 'C0MINE')),
  };

  it('keeps incidents from channels the asker is in, theirs, and channel-less captures; never another platform', async () => {
    const incidents = [
      view('mine', { channelId: 'C0MINE' }),
      view('private', { channelId: 'C0PRIVATE' }),
      view('private-2', { channelId: 'C0PRIVATE' }),
      view('reported', { channelId: 'C0PRIVATE', reporterId: 'U0ASKER' }),
      view('owned', { channelId: 'C0PRIVATE', ownerRef: 'ash' }),
      view('cli', { source: 'cli', channelId: 'cli:ash' }),
      view('teams', { source: 'teams', channelId: '19:x@thread.tacv2' }),
    ];
    const seen = await visibleTo(access, ASKER, incidents);
    expect(seen.map((i) => i.id)).toEqual(['mine', 'reported', 'owned', 'cli']);
    expect(asked.sort()).toEqual(['C0MINE', 'C0PRIVATE']);
  });

  it('answers members only: a guest, an external person, or a failed lookup gets no status', async () => {
    expect(await askerMayAsk(access, 'U0ASKER')).toBe(true);
    expect(await askerMayAsk(access, 'U0GUEST')).toBe(false);
    expect(await askerMayAsk(access, 'U0GONE')).toBe(false);
    expect(await askerMayAsk(undefined, 'U0GUEST')).toBe(true);
  });

  it('remembers a member list for a minute, and a list that fails has nobody in it', async () => {
    let now = 0;
    let reads = 0;
    const inChannel = briefMembers(
      (c) => (reads++, c === 'C0BAD' ? Promise.reject(new Error('not_in_channel')) : Promise.resolve(['U1'])),
      () => new Date(now),
    );
    expect(await inChannel('C1', 'U1')).toBe(true);
    expect(await inChannel('C1', 'U2')).toBe(false);
    expect(reads).toBe(1);
    now += 60_000;
    expect(await inChannel('C1', 'U1')).toBe(true);
    expect(reads).toBe(2);
    expect(await inChannel('C0BAD', 'U1')).toBe(false);
  });
});
