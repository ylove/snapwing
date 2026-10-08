// The Slack PrReadyChat (main 11.2): the card in the thread, and the private link prompt.

import { describe, expect, it } from 'vitest';
import type { PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { buildPrReady } from '../../src/adapters/slack/cards/cards.ts';
import { createSlackPrReadyChat } from '../../src/adapters/slack/pr-ready.ts';
import type { PostEphemeralArgs, PostMessageArgs } from '../../src/adapters/slack/web.ts';

const INC = '01K6PRREADY0000000000000001';
const CARD: PrReadyCard = {
  kind: 'pr-ready',
  prNumber: 77,
  prUrl: 'https://github.com/acme/web/pull/77',
  issueKey: 'WEB-1042',
  reviewVerdict: 'approve',
  ciState: 'green',
  filesChanged: 2,
  additions: 10,
  deletions: 3,
  reviewerUserIds: ['U0WEBDEV1'],
};

function setup() {
  const posts: PostMessageArgs[] = [];
  const ephemerals: PostEphemeralArgs[] = [];
  const chat = createSlackPrReadyChat({
    web: {
      postMessage: (a) => (posts.push(a), Promise.resolve({ channel: a.channel, ts: '1759395700.000300' })),
      postEphemeral: (a) => (ephemerals.push(a), Promise.resolve({})),
    },
  });
  return { chat, posts, ephemerals };
}

describe('createSlackPrReadyChat', () => {
  it('postPrReady posts the card in the thread, with buttons when canMerge', async () => {
    const { chat, posts } = setup();
    await chat.postPrReady({ channel: 'C0WEBBUGS', threadId: '1759395600.000100' }, INC, CARD, { canMerge: true });
    const expected = buildPrReady(INC, CARD, { canMerge: true });
    expect(posts).toEqual([{ channel: 'C0WEBBUGS', text: expected.text, blocks: expected.blocks, thread_ts: '1759395600.000100' }]);
    expect(JSON.stringify(posts[0]?.blocks)).toContain('"action_id":"merge"');
  });

  it('postPrReady offers Open PR only when canMerge is false', async () => {
    const { chat, posts } = setup();
    await chat.postPrReady({ channel: 'C0WEBBUGS', threadId: '1759395600.000100' }, INC, CARD, { canMerge: false });
    const json = JSON.stringify(posts[0]?.blocks);
    expect(json).toContain('"action_id":"open_pr"');
    expect(json).not.toContain('"action_id":"merge"');
  });

  it('postPrReady drops the thread in a direct message and when none is given', async () => {
    const { chat, posts } = setup();
    await chat.postPrReady({ channel: 'D0DIRECT', threadId: '1759395600.000100' }, INC, CARD, { canMerge: true });
    await chat.postPrReady({ channel: 'C0WEBBUGS' }, INC, CARD, { canMerge: true });
    expect(posts.map((p) => 'thread_ts' in p)).toEqual([false, false]);
  });

  it('postLinkPrompt shows one user the Open PR only card and a link, ephemerally in the thread', async () => {
    const { chat, posts, ephemerals } = setup();
    await chat.postLinkPrompt('U0WEBDEV1', { channel: 'C0WEBBUGS', threadId: '1759395600.000100' }, INC, CARD, 'https://snapwing.example/auth/github/start?t=1');
    expect(posts).toEqual([]);
    expect(ephemerals).toHaveLength(1);
    const sent = ephemerals[0];
    expect(sent).toMatchObject({ channel: 'C0WEBBUGS', user: 'U0WEBDEV1', thread_ts: '1759395600.000100' });
    const json = JSON.stringify(sent?.blocks);
    expect(json).toContain('"action_id":"open_pr"');
    expect(json).not.toContain('"action_id":"merge"');
    expect(json).toContain('<https://snapwing.example/auth/github/start?t=1|Link your GitHub account>');
  });

  it('with state, each posted card is recorded as a pr message; the ephemeral prompt is not (A 1.3)', async () => {
    const appended: NewEvent[] = [];
    const errors: unknown[] = [];
    const chat = createSlackPrReadyChat({
      web: {
        postMessage: (a) => Promise.resolve({ channel: a.channel, ts: '1759395700.000300' }),
        postEphemeral: () => Promise.resolve({}),
      },
      state: {
        read: () => Promise.resolve([{ workspaceId: 'W0FAKE', seq: 9 }] as unknown as IncidentEvent[]),
        append: (_id, events, seq) => (appended.push(...events), Promise.resolve({ seq: seq + events.length })),
      },
      onError: (e) => errors.push(e),
    });
    await chat.postPrReady({ channel: 'C0WEBBUGS', threadId: '1759395600.000100' }, INC, CARD, { canMerge: true });
    await chat.postLinkPrompt('U0WEBDEV1', { channel: 'C0WEBBUGS' }, INC, CARD, 'https://snapwing.example/link');
    expect(appended.map((e) => [e.incidentId, e.type, e.payload])).toEqual([
      [INC, 'bot-message-posted', { platform: 'slack', channel: 'C0WEBBUGS', messageId: '1759395700.000300', role: 'pr' }],
    ]);
    expect(errors).toEqual([]);
  });

  it('postLinkPrompt drops the thread in a direct message', async () => {
    const { chat, ephemerals } = setup();
    await chat.postLinkPrompt('U0WEBDEV1', { channel: 'D0DIRECT', threadId: '1759395600.000100' }, INC, CARD, 'https://snapwing.example/link');
    expect('thread_ts' in (ephemerals[0] ?? {})).toBe(false);
  });
});
