import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { checkSlackSignature, verifySlackSignature } from '../../src/adapters/slack/auth.ts';
import { createSlackAuthorOf } from '../../src/adapters/slack/authorship.ts';
import {
  normalizeSlack,
  type SlackNormalizeContext,
  type SlackNormalizeResult,
  type SlackReactionsGetResult,
} from '../../src/adapters/slack/normalize.ts';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/slack/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

const SECRET = 'signing-secret-test';
const NOW_S = 1_700_000_000;
const NOW = new Date(NOW_S * 1000);

function sign(body: string, ts: number | string, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const body = 'token=xoxb-test&payload=%7B%7D';
  const headers = (ts: number, sig = sign(body, ts)) => ({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig });

  it('accepts a valid signature', () => {
    expect(verifySlackSignature(body, headers(NOW_S), SECRET, NOW)).toBe(true);
    expect(verifySlackSignature(body, headers(NOW_S), SECRET, NOW.getTime())).toBe(true);
  });

  it('accepts Headers instances and mixed-case record keys', () => {
    expect(verifySlackSignature(body, new Headers(headers(NOW_S)), SECRET, NOW)).toBe(true);
    expect(
      verifySlackSignature(body, { 'X-Slack-Request-Timestamp': String(NOW_S), 'X-Slack-Signature': [sign(body, NOW_S)] }, SECRET, NOW),
    ).toBe(true);
  });

  it('enforces the 300 s window on both sides', () => {
    expect(verifySlackSignature(body, headers(NOW_S - 300), SECRET, NOW)).toBe(true);
    expect(verifySlackSignature(body, headers(NOW_S + 300), SECRET, NOW)).toBe(true);
    expect(checkSlackSignature(body, headers(NOW_S - 301), SECRET, NOW)).toEqual({ ok: false, reason: 'stale' });
    expect(checkSlackSignature(body, headers(NOW_S + 301), SECRET, NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a bad signature, a wrong secret, and a tampered body', () => {
    expect(checkSlackSignature(body, headers(NOW_S, sign(body, NOW_S, 'other')), SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifySlackSignature(`${body}x`, headers(NOW_S), SECRET, NOW)).toBe(false);
  });

  it('rejects on a length mismatch without throwing', () => {
    expect(checkSlackSignature(body, headers(NOW_S, 'v0=abc'), SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifySlackSignature(body, headers(NOW_S, `${sign(body, NOW_S)}00`), SECRET, NOW)).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    expect(checkSlackSignature(body, {}, SECRET, NOW)).toEqual({ ok: false, reason: 'missing-headers' });
    expect(checkSlackSignature(body, { 'x-slack-signature': sign(body, NOW_S) }, SECRET, NOW)).toEqual({ ok: false, reason: 'missing-headers' });
    expect(checkSlackSignature(body, { 'x-slack-request-timestamp': String(NOW_S) }, SECRET, NOW)).toEqual({ ok: false, reason: 'missing-headers' });
    expect(checkSlackSignature(body, { 'x-slack-request-timestamp': 'soon', 'x-slack-signature': 'v0=00' }, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-timestamp',
    });
  });
});

const BOT = 'U0BOT';

function map(overrides: Partial<WorkspaceMap> = {}): WorkspaceMap {
  return {
    org: 'Example',
    updated: '2026-10-02T00:00:00Z',
    surfaces: [],
    channels: [
      { id: 'C0WEB', name: 'web-bugs', surface: 'web', triggerEmoji: [] },
      { id: 'C0OPS', name: 'ops', surface: 'web', triggerEmoji: ['fire'] },
    ],
    triggers: {
      messageActions: [{ label: 'Fix it from here' }],
      emoji: [
        { slack: 'bug', teams: 'bug' },
        { slack: 'fire', teams: 'fire', minReactors: 2 },
      ],
      directMessage: { images: true, text: true },
    },
    vocabulary: [],
    people: [{ slackId: 'U0REPORTER', handle: 'rae', email: 'rae@example.com', role: 'reporter', owns: [] }],
    policies: { autonomy: { default: 1, levels: [], overrides: [] } },
    ...overrides,
  };
}

const reactionsFixture = fixture('reactions-get') as { message: { text: string; reactions: SlackReactionsGetResult['reactions'] } };

function ctx(overrides: Partial<SlackNormalizeContext> = {}): SlackNormalizeContext {
  return {
    map: map(),
    botUserId: BOT,
    reactionsGet: () => Promise.resolve({ text: reactionsFixture.message.text, reactions: reactionsFixture.message.reactions }),
    workspaceDomain: 'example',
    newEventId: () => '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    ...overrides,
  };
}

function incident(r: SlackNormalizeResult) {
  if (r.kind !== 'incident') throw new Error(`expected incident, got ignored: ${r.reason}`);
  return r.payload;
}

function reaction(patch: Record<string, unknown>, itemPatch: Record<string, unknown> = {}): Record<string, unknown> {
  const base = fixture('reaction-added') as { event: Record<string, unknown> };
  return { ...base, event: { ...base.event, ...patch, item: { ...(base.event['item'] as object), ...itemPatch } } };
}

function im(name: string, patch: Record<string, unknown>): Record<string, unknown> {
  const base = fixture(name) as { event: Record<string, unknown> };
  return { ...base, event: { ...base.event, ...patch } };
}

describe('normalizeSlack: message shortcut', () => {
  it('normalizes a message_action with the exact idempotency key', async () => {
    const p = incident(await normalizeSlack(fixture('message-action'), ctx()));
    expect(p.idempotencyKey).toBe('slack-C0WEB-1700000000.000200');
    expect(p.source).toBe('slack');
    expect(p.anchorText).toBe('Checkout total shows NaN after applying a coupon');
    expect(p.reporter).toEqual({ id: 'U0REPORTER', name: 'rae', email: 'rae@example.com', role: 'reporter' });
    expect(p.context.channelId).toBe('C0WEB');
    expect(p.context.threadId).toBe('1699999900.000100');
    expect(p.context.deepLink).toBe('https://example.slack.com/archives/C0WEB/p1700000000000200');
    expect(p.timestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(p.eventId).toBe('01HZZZZZZZZZZZZZZZZZZZZZZZ');
  });

  it('falls back to the payload user name and unknown role for people outside the map', async () => {
    const raw = { ...fixture('message-action'), user: { id: 'U0STRANGER', name: 'sam' } };
    expect(incident(await normalizeSlack(raw, ctx())).reporter).toEqual({ id: 'U0STRANGER', name: 'sam', role: 'unknown' });
  });

  it('ignores a shortcut with another callback id, honors a configured one, and mints a ULID by default', async () => {
    const raw = { ...fixture('message-action'), callback_id: 'something_else' };
    expect(await normalizeSlack(raw, ctx())).toEqual({ kind: 'ignored', reason: 'unknown-callback' });
    expect(incident(await normalizeSlack(raw, ctx({ callbackId: 'something_else' }))).idempotencyKey).toBe('slack-C0WEB-1700000000.000200');
    const { newEventId: _unused, ...rest } = ctx();
    expect(incident(await normalizeSlack(fixture('message-action'), rest)).eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('normalizeSlack: reaction_added', () => {
  it('normalizes the default emoji with the reaction in the key and the anchor text from reactions.get', async () => {
    const reactionsGet = vi.fn(() => Promise.resolve({ text: 'anchor text', reactions: [] }));
    const p = incident(await normalizeSlack(fixture('reaction-added'), ctx({ reactionsGet })));
    expect(p.idempotencyKey).toBe('slack-C0WEB-1700000000.000200-bug');
    expect(p.anchorText).toBe('anchor text');
    expect(p.reporter.id).toBe('U0REPORTER');
    expect(p.timestamp).toBe('2023-11-14T22:16:40.000Z');
    expect(reactionsGet).toHaveBeenCalledWith('C0WEB', '1700000000.000200');
  });

  it('ignores the bot own reaction without calling the API', async () => {
    const reactionsGet = vi.fn();
    expect(await normalizeSlack(reaction({ user: BOT }), ctx({ reactionsGet }))).toEqual({ kind: 'ignored', reason: 'own-reaction' });
    expect(reactionsGet).not.toHaveBeenCalled();
  });

  it('ignores emoji that are not triggers and reactions on files', async () => {
    expect(await normalizeSlack(reaction({ reaction: 'tada' }), ctx())).toEqual({ kind: 'ignored', reason: 'not-a-trigger-emoji' });
    expect(await normalizeSlack(reaction({}, { type: 'file' }), ctx())).toEqual({ kind: 'ignored', reason: 'not-a-message-reaction' });
  });

  it('lets a per-channel override win over the workspace default', async () => {
    expect(await normalizeSlack(reaction({ reaction: 'bug' }, { channel: 'C0OPS' }), ctx())).toEqual({
      kind: 'ignored',
      reason: 'not-a-trigger-emoji',
    });
    const reactors = { text: 't', reactions: [{ name: 'fire', users: ['U0REPORTER', 'U0SECOND'] }] };
    const p = incident(await normalizeSlack(reaction({ reaction: 'fire' }, { channel: 'C0OPS' }), ctx({ reactionsGet: () => Promise.resolve(reactors) })));
    expect(p.idempotencyKey).toBe('slack-C0OPS-1700000000.000200-fire');
  });

  it('accepts several registered emoji', async () => {
    const m = map({ triggers: { messageActions: [], emoji: [{ slack: 'bug', teams: 'bug' }, { slack: 'beetle', teams: 'beetle' }] } });
    const p = incident(await normalizeSlack(reaction({ reaction: 'beetle' }), ctx({ map: m })));
    expect(p.idempotencyKey).toBe('slack-C0WEB-1700000000.000200-beetle');
    expect(incident(await normalizeSlack(reaction({ reaction: 'bug' }), ctx({ map: m }))).idempotencyKey).toBe('slack-C0WEB-1700000000.000200-bug');
  });

  it('honors minReactors by counting distinct reactors, not the bot, not duplicates', async () => {
    const fire = reaction({ reaction: 'fire' });
    const get = (users: string[]) => () => Promise.resolve({ text: 't', reactions: [{ name: 'fire', users }] });
    expect(await normalizeSlack(fire, ctx({ reactionsGet: get(['U0REPORTER']) }))).toEqual({ kind: 'ignored', reason: 'below-min-reactors' });
    expect(await normalizeSlack(fire, ctx({ reactionsGet: get(['U0REPORTER', 'U0REPORTER', BOT]) }))).toEqual({
      kind: 'ignored',
      reason: 'below-min-reactors',
    });
    expect(incident(await normalizeSlack(fire, ctx({ reactionsGet: get(['U0REPORTER', 'U0SECOND']) }))).idempotencyKey).toBe(
      'slack-C0WEB-1700000000.000200-fire',
    );
  });

  it('counts only the reaction that was added', async () => {
    const get = () => Promise.resolve({ text: 't', reactions: [{ name: 'heart', users: ['U0B', 'U0C'] }] });
    expect(await normalizeSlack(reaction({ reaction: 'fire' }), ctx({ reactionsGet: get }))).toEqual({ kind: 'ignored', reason: 'below-min-reactors' });
  });

  it('normalizes skin-tone variants to the base name', async () => {
    const m = map({ triggers: { messageActions: [], emoji: [{ slack: 'thumbsup', teams: 'like' }] } });
    const p = incident(await normalizeSlack(reaction({ reaction: 'thumbsup::skin-tone-3' }), ctx({ map: m })));
    expect(p.idempotencyKey).toBe('slack-C0WEB-1700000000.000200-thumbsup');
  });
});

describe('normalizeSlack: direct messages', () => {
  it('normalizes text, image, and both, keyed by channel and ts', async () => {
    const text = incident(await normalizeSlack(fixture('message-im-text'), ctx()));
    expect(text.idempotencyKey).toBe('slack-D0DM-1700000300.000400');
    expect(text.anchorText).toBe('The invoice page 500s when I click Download');
    expect(text.context.channelId).toBe('D0DM');
    expect(text.context.threadId).toBeUndefined();

    const image = incident(await normalizeSlack(fixture('message-im-image'), ctx()));
    expect(image.idempotencyKey).toBe('slack-D0DM-1700000400.000500');
    expect(image.anchorText).toBe('');
    expect(image.context.rawPayloadSnapshot['files']).toEqual([
      { id: 'F0SHOT', mimetype: 'image/png', url_private_download: 'https://files.slack.com/files-pri/T0001-F0SHOT/download/screenshot.png' },
    ]);

    const both = incident(await normalizeSlack(fixture('message-im-both'), ctx()));
    expect(both.anchorText).toBe('Blank total, see screenshot');
    expect(both.context.rawPayloadSnapshot['files']).toHaveLength(1);
  });

  // #360: a person posting through an app with their user token gets `bot_id` and `app_id` on the
  // message; it is still their report.
  it('captures a DM a mapped person posted through an app (bot_id and app_id on it)', async () => {
    const p = incident(await normalizeSlack(im('message-im-text', { bot_id: 'B0TESTDRIVER', app_id: 'A0TESTDRIVER' }), ctx()));
    expect(p.reporter.id).toBe('U0REPORTER');
    expect(p.anchorText).toBe('The invoice page 500s when I click Download');
  });

  it('asks users.info about someone the map does not name, and ignores our own bot id', async () => {
    const asked: string[] = [];
    const authorOf = createSlackAuthorOf({ botUserId: BOT, botId: 'B0SNAPWING', usersInfo: (u) => (asked.push(u), Promise.resolve({ is_bot: u === 'U0OTHERBOT' })) });
    const person = incident(await normalizeSlack(im('message-im-text', { user: 'U0NOBODY', bot_id: 'B0TESTDRIVER' }), ctx({ authorOf })));
    expect(person.reporter.id).toBe('U0NOBODY');
    expect(await normalizeSlack(im('message-im-text', { user: 'U0OTHERBOT', bot_id: 'B0OTHER' }), ctx({ authorOf }))).toEqual({ kind: 'ignored', reason: 'bot-message' });
    expect(asked).toEqual(['U0NOBODY', 'U0OTHERBOT']);
    expect(await normalizeSlack(im('message-im-text', { bot_id: 'B0SNAPWING' }), ctx({ authorOf }))).toEqual({ kind: 'ignored', reason: 'own-message' });
  });

  it('ignores the bot own messages, other bots, edits, and non-DM channels', async () => {
    expect(await normalizeSlack(im('message-im-text', { user: BOT }), ctx())).toEqual({ kind: 'ignored', reason: 'own-message' });
    expect(await normalizeSlack(im('message-im-text', { user: 'U0OTHERBOT', bot_id: 'B0X' }), ctx())).toEqual({ kind: 'ignored', reason: 'bot-message' });
    expect(await normalizeSlack(im('message-im-text', { user: undefined, bot_id: 'B0X' }), ctx())).toEqual({ kind: 'ignored', reason: 'bot-message' });
    expect(await normalizeSlack(im('message-im-text', { subtype: 'bot_message' }), ctx())).toEqual({ kind: 'ignored', reason: 'bot-message' });
    expect(await normalizeSlack(im('message-im-text', { subtype: 'message_changed' }), ctx())).toEqual({
      kind: 'ignored',
      reason: 'unsupported-subtype',
    });
    expect(await normalizeSlack(im('message-im-text', { channel_type: 'channel' }), ctx())).toEqual({ kind: 'ignored', reason: 'not-a-direct-message' });
  });

  it('ignores empty messages and files that are not images', async () => {
    expect(await normalizeSlack(im('message-im-text', { text: '  ' }), ctx())).toEqual({ kind: 'ignored', reason: 'empty-message' });
    const docOnly = im('message-im-both', { text: '', files: [{ id: 'F0DOC', mimetype: 'text/plain' }] });
    expect(await normalizeSlack(docOnly, ctx())).toEqual({ kind: 'ignored', reason: 'empty-message' });
  });

  it('honors the map directMessage switches', async () => {
    const noImages = map({ triggers: { messageActions: [], emoji: [], directMessage: { images: false, text: true } } });
    expect(await normalizeSlack(fixture('message-im-image'), ctx({ map: noImages }))).toEqual({ kind: 'ignored', reason: 'direct-message-disabled' });
    expect(incident(await normalizeSlack(fixture('message-im-text'), ctx({ map: noImages }))).anchorText).toContain('invoice');
    const noText = map({ triggers: { messageActions: [], emoji: [], directMessage: { images: true, text: false } } });
    expect(await normalizeSlack(fixture('message-im-text'), ctx({ map: noText }))).toEqual({ kind: 'ignored', reason: 'direct-message-disabled' });
  });
});

describe('normalizeSlack: everything else is ignored, not an error', () => {
  it('ignores url_verification, unknown envelopes, and unsubscribed event types', async () => {
    expect(await normalizeSlack({ type: 'url_verification', challenge: 'abc' }, ctx())).toEqual({ kind: 'ignored', reason: 'url-verification' });
    expect(await normalizeSlack({ type: 'block_actions' }, ctx())).toEqual({ kind: 'ignored', reason: 'unsupported-payload' });
    expect(await normalizeSlack({ type: 'event_callback', event: { type: 'file_shared' } }, ctx())).toEqual({
      kind: 'ignored',
      reason: 'unsupported-payload',
    });
    expect(await normalizeSlack(null, ctx())).toEqual({ kind: 'ignored', reason: 'unsupported-payload' });
    expect(await normalizeSlack('nope', ctx())).toEqual({ kind: 'ignored', reason: 'unsupported-payload' });
  });
});
