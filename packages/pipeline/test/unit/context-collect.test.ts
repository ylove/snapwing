import { describe, expect, it } from 'vitest';
import type { SourceMessage } from '../../src/contracts/incident.ts';
import { nearestMidpoint, type ChatReader } from '../../src/context/chat-reader.ts';
import { collectWindow, widenPolicy, type Anchor } from '../../src/context/collect.ts';
import { narrow, scopePreview, widen } from '../../src/context/scope-preview.ts';

const BASE = Date.parse('2026-10-01T14:00:00.000Z');
const at = (min: number): string => new Date(BASE + min * 60_000).toISOString();

function msg(id: string, min: number, extra: Partial<SourceMessage> = {}): SourceMessage {
  return { id, authorId: 'U1', text: `text ${id}`, timestamp: at(min), mentions: [], reactions: [], attachments: [], ...extra };
}

class FakeReader implements ChatReader {
  historyCalls: { oldest: string; latest: string; limit: number }[] = [];
  replyCalls: string[] = [];
  constructor(private readonly all: SourceMessage[]) {}
  async history(_c: string, oldest: string, latest: string, limit: number): Promise<SourceMessage[]> {
    this.historyCalls.push({ oldest, latest, limit });
    const inWindow = this.all
      .filter((m) => m.threadParentId === undefined)
      .filter((m) => m.timestamp >= oldest && m.timestamp <= latest);
    return nearestMidpoint(inWindow, oldest, latest, limit);
  }
  async replies(_c: string, parentId: string): Promise<SourceMessage[]> {
    this.replyCalls.push(parentId);
    const parent = this.all.find((m) => m.id === parentId);
    const kids = this.all.filter((m) => m.threadParentId === parentId);
    return kids.length === 0 || !parent ? [] : [parent, ...kids];
  }
}

const anchorOf = (m: SourceMessage, extra: Partial<Anchor> = {}): Anchor => ({ channelId: 'C1', message: m, ...extra });
const ids = (xs: SourceMessage[]): string[] => xs.map((m) => m.id);

describe('collectWindow', () => {
  it('reads plus or minus 30 minutes and reports the bounds used', async () => {
    const a = msg('a', 0);
    const reader = new FakeReader([msg('far-before', -31), msg('b1', -30), msg('b2', -5), a, msg('c1', 30), msg('far-after', 31)]);
    const bundle = await collectWindow(anchorOf(a), reader);
    expect(ids(bundle.included)).toEqual(['b1', 'b2', 'a', 'c1']);
    expect(bundle.anchorId).toBe('a');
    expect(bundle.windowUsed).toEqual({ oldest: at(-30), latest: at(30), cap: 40 });
    expect(reader.historyCalls[0]).toEqual({ oldest: at(-30), latest: at(30), limit: 40 });
  });

  it('honors a policy window and cap', async () => {
    const a = msg('a', 0);
    const reader = new FakeReader([msg('x', -10), msg('y', -4), a, msg('z', 4)]);
    const bundle = await collectWindow(anchorOf(a), reader, { window: 'PT5M', cap: 10 });
    expect(ids(bundle.included)).toEqual(['y', 'a', 'z']);
    expect(bundle.windowUsed).toEqual({ oldest: at(-5), latest: at(5), cap: 10 });
  });

  it('caps at 40, keeps the anchor and the messages nearest it, and records the rest as excluded', async () => {
    const all = Array.from({ length: 60 }, (_, i) => msg(`m${String(i).padStart(2, '0')}`, (i - 30) / 2));
    const a = all[30]!;
    const reader: ChatReader = { history: async () => all, replies: async () => [] };
    const bundle = await collectWindow(anchorOf(a), reader);
    expect(bundle.included.length).toBeLessThanOrEqual(40);
    expect(ids(bundle.included)).toContain('m30');
    expect(bundle.excluded.every((e) => e.reason === 'over-cap')).toBe(true);
    expect(bundle.included.length + bundle.excluded.length).toBe(60);
    // Nearest-first: the anchor's neighbors survive, the far ends go.
    expect(ids(bundle.included)).toContain('m29');
    expect(bundle.excluded.map((e) => e.id)).not.toContain('m31');
  });

  it('a busy window keeps the messages just after the anchor, not only the oldest ones', async () => {
    // 100 messages one per 30 seconds across the window, the anchor in the middle.
    const all = Array.from({ length: 100 }, (_, i) => msg(`b${String(i).padStart(3, '0')}`, -25 + i * 0.5));
    const a = msg('anchor', 0);
    const reader = new FakeReader([...all, a]);
    const bundle = await collectWindow(anchorOf(a), reader);
    const got = ids(bundle.included);
    expect(reader.historyCalls[0]?.limit).toBe(40);
    expect(got).toContain('anchor');
    // b051 is 30 seconds after the anchor, b060 is 5 minutes after it: both are in the bundle.
    expect(got).toContain('b051');
    expect(got).toContain('b060');
    expect(got).not.toContain('b000');
  });

  it('trims a reader that ignores the limit', async () => {
    const all = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, (i - 30) / 4));
    const reader: ChatReader = { history: async () => all, replies: async () => [] };
    const bundle = await collectWindow(anchorOf(all[30]!), reader);
    expect(bundle.included).toHaveLength(40);
  });

  it('calls replies only for messages with replies or an unknown reply count', async () => {
    const all = Array.from({ length: 40 }, (_, i) => {
      const extra: Partial<SourceMessage> = i < 3 ? { replyCount: 2 } : i < 33 ? { replyCount: 0 } : {};
      return msg(`m${String(i).padStart(2, '0')}`, (i - 20) / 2, extra);
    });
    const a = all[39]!; // no replyCount
    const reader = new FakeReader(all);
    const bundle = await collectWindow(anchorOf(a), reader);
    expect(bundle.included).toHaveLength(40);
    expect(reader.replyCalls).toHaveLength(10);
    expect(reader.replyCalls).toEqual(expect.arrayContaining(['m00', 'm01', 'm02', 'm39']));
    expect(reader.replyCalls).not.toContain('m10');
  });

  it('still expands the thread an in-thread anchor belongs to when replyCount is 0 elsewhere', async () => {
    const parent = msg('p', -5, { replyCount: 1 });
    const a = msg('a', 0, { threadParentId: 'p' });
    const reader = new FakeReader([parent, a, msg('q', -3, { replyCount: 0 })]);
    await collectWindow(anchorOf(a), reader);
    expect(reader.replyCalls).toEqual(['p']);
  });

  it('expands the sub-thread of every message in the window', async () => {
    const a = msg('a', 0);
    const all = [
      msg('p1', -10),
      msg('p1-r1', 20, { threadParentId: 'p1', authorId: 'U2' }),
      msg('p1-r2', 45, { threadParentId: 'p1' }),
      a,
      msg('p2', 5),
      msg('p2-r1', 6, { threadParentId: 'p2' }),
      msg('lonely', 8),
    ];
    const reader = new FakeReader(all);
    const bundle = await collectWindow(anchorOf(a), reader);
    expect(ids(bundle.included)).toEqual(['p1', 'a', 'p2', 'p2-r1', 'lonely', 'p1-r1', 'p1-r2'].sort((x, y) => all.find((m) => m.id === x)!.timestamp.localeCompare(all.find((m) => m.id === y)!.timestamp)));
    expect(new Set(reader.replyCalls)).toEqual(new Set(['p1', 'a', 'p2', 'lonely']));
  });

  it('collects the parent and siblings when the anchor is in a thread, even outside the window', async () => {
    const a = msg('a', 0, { threadParentId: 'root' });
    const all = [
      msg('root', -90),
      msg('sib-before', -60, { threadParentId: 'root' }),
      a,
      msg('sib-after', 50, { threadParentId: 'root' }),
      msg('nearby', 3),
    ];
    const bundle = await collectWindow(anchorOf(a), new FakeReader(all));
    expect(ids(bundle.included)).toEqual(['root', 'sib-before', 'a', 'nearby', 'sib-after']);
    expect(new Set(ids(bundle.included)).size).toBe(bundle.included.length);
  });

  it('yields the anchor alone for an image-only anchor in a DM or CLI send', async () => {
    const a = msg('a', 0, { text: '', attachments: [{ kind: 'image', url: 'https://example.test/s.png' }] });
    const reader = new FakeReader([msg('b', -1), a]);
    const bundle = await collectWindow(anchorOf(a, { direct: true }), reader);
    expect(ids(bundle.included)).toEqual(['a']);
    expect(bundle.excluded).toEqual([]);
    expect(reader.historyCalls).toHaveLength(0);
  });

  it('still reads the channel for an image-only anchor posted in a channel', async () => {
    const a = msg('a', 0, { text: '', attachments: [{ kind: 'image', url: 'https://example.test/s.png' }] });
    const bundle = await collectWindow(anchorOf(a), new FakeReader([msg('b', -1), a]));
    expect(ids(bundle.included)).toEqual(['b', 'a']);
  });
});

describe('scopePreview', () => {
  it('renders count, time range, screenshot, and thread', async () => {
    const a = msg('a', 0, { authorId: 'U1' });
    const all = [
      msg('m1', -10, { authorId: 'U3' }),
      msg('m2', -5, { authorId: 'U2', attachments: [{ kind: 'image', url: 'https://example.test/s.png' }] }),
      a,
      msg('m3', 6, { authorId: 'U4' }),
      msg('m3-r1', 11, { threadParentId: 'm3' }),
    ];
    const bundle = await collectWindow(anchorOf(a), new FakeReader(all));
    const p = scopePreview(bundle, { names: { U2: 'Dana', U4: 'Marcus' } });
    expect(p.text).toBe("Reading 5 messages from 13:50 to 14:11, including Dana's screenshot and the thread under Marcus's message.");
    expect(p.actions).toEqual(['Looks right', 'Widen', 'Narrow']);
  });

  it('handles a single message and plain windows', async () => {
    const a = msg('a', 0);
    const bundle = await collectWindow(anchorOf(a), new FakeReader([a]));
    expect(scopePreview(bundle).text).toBe('Reading 1 message at 14:00.');
  });

  it('lists several extras with commas and a final and', async () => {
    const a = msg('a', 0, { attachments: [{ kind: 'image', url: 'https://example.test/s.png' }] });
    const f = msg('f', 1, { attachments: [{ kind: 'file', url: 'https://example.test/l.log' }] });
    const t = msg('t', 2);
    const r = msg('r', 3, { threadParentId: 't' });
    const bundle = await collectWindow(anchorOf(a), new FakeReader([a, f, t, r]));
    expect(scopePreview(bundle).text).toBe("Reading 4 messages from 14:00 to 14:03, including U1's screenshot, U1's file and the thread under U1's message.");
  });

  it('respects a time zone', async () => {
    const a = msg('a', 0);
    const bundle = await collectWindow(anchorOf(a), new FakeReader([a]));
    expect(scopePreview(bundle, { timeZone: 'America/New_York' }).text).toContain('at 10:00');
  });
});

describe('widen and narrow', () => {
  it('widen doubles the window (and the cap)', async () => {
    expect(widenPolicy({ window: 'PT30M', cap: 40 })).toEqual({ window: 'PT1H', cap: 80 });
    const a = msg('a', 0);
    const reader = new FakeReader([msg('w', -50), msg('n', -20), a, msg('e', 55)]);
    const base = await collectWindow(anchorOf(a), reader);
    expect(ids(base.included)).toEqual(['n', 'a']);
    const wide = await widen(anchorOf(a), reader);
    expect(ids(wide.included)).toEqual(['w', 'n', 'a', 'e']);
    expect(wide.windowUsed).toEqual({ oldest: at(-60), latest: at(60), cap: 80 });
  });

  it('narrow limits to the thread of a top-level anchor', async () => {
    const a = msg('a', 0);
    const all = [msg('other', -3), a, msg('a-r1', 4, { threadParentId: 'a' }), msg('a-r2', 9, { threadParentId: 'a' })];
    const bundle = await narrow(anchorOf(a), new FakeReader(all));
    expect(ids(bundle.included)).toEqual(['a', 'a-r1', 'a-r2']);
    expect(bundle.windowUsed.oldest).toBe(at(0));
    expect(bundle.windowUsed.latest).toBe(at(9));
  });

  it('narrow limits to the parent thread when the anchor is a reply', async () => {
    const a = msg('a', 5, { threadParentId: 'root' });
    const all = [msg('root', 0), a, msg('r2', 8, { threadParentId: 'root' }), msg('other', 6)];
    const bundle = await narrow(anchorOf(a), new FakeReader(all));
    expect(ids(bundle.included)).toEqual(['root', 'a', 'r2']);
  });

  it('narrow with no thread is the anchor alone', async () => {
    const a = msg('a', 0);
    const bundle = await narrow(anchorOf(a), new FakeReader([msg('b', 1), a]));
    expect(ids(bundle.included)).toEqual(['a']);
  });
});
