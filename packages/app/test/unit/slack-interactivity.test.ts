// Slack interactivity, PR button refusals (#229; main 11.2). A refusal from `createPrActions` is posted
// to the tapper ephemerally; the card is left alone. Stubs for state, orchestrator, and the Web API.

import { describe, expect, it } from 'vitest';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { PrActionRefusedError, type PrActionRefused } from '@snapwing/pipeline/merge/actions.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { createSlackInteractivity } from '../../src/adapters/slack/interactivity.ts';
import type { SlackActionPayload } from '../../src/adapters/slack/transport.ts';
import type { PostEphemeralArgs, PostMessageArgs, UpdateMessageArgs } from '../../src/adapters/slack/web.ts';

const INC = '01K6REFUSAL00000000000001';
const USER = 'U0WEBDEV1';
const CHANNEL = 'C0WEBBUGS';
const THREAD = '1759395600.000100';
const CARD_TS = '1759395610.000200';

const MAP = { people: [{ handle: 'dev1', slackId: USER, role: 'engineer', owns: [] }] } as unknown as WorkspaceMap;
const INCIDENT = { id: INC, autonomyLevel: 2, status: 'mergeable', prNumber: 77, repo: 'acme/web' } as unknown as IncidentView;

function mergePayload(): SlackActionPayload {
  return {
    type: 'block_actions',
    user: { id: USER },
    container: { type: 'message', message_ts: CARD_TS, channel_id: CHANNEL, is_ephemeral: false },
    channel: { id: CHANNEL },
    message: {
      ts: CARD_TS,
      thread_ts: THREAD,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'PR ready' } },
        { type: 'actions', block_id: 'pr_actions', elements: [{ type: 'button', action_id: 'merge', value: INC, text: { type: 'plain_text', text: 'Merge' } }] },
      ],
    },
    actions: [{ type: 'button', block_id: 'pr_actions', action_id: 'merge', value: INC, text: { type: 'plain_text', text: 'Merge' } }],
  };
}

function setup(refusal: PrActionRefused | Error | undefined) {
  const posts: PostMessageArgs[] = [];
  const updates: UpdateMessageArgs[] = [];
  const ephemerals: PostEphemeralArgs[] = [];
  const ix = createSlackInteractivity({
    web: {
      postMessage: (a) => (posts.push(a), Promise.resolve({ channel: a.channel, ts: '1759395700.000300' })),
      updateMessage: (a) => (updates.push(a), Promise.resolve({ channel: a.channel, ts: a.ts })),
      postEphemeral: (a) => (ephemerals.push(a), Promise.resolve({})),
    },
    state: { getIncident: () => Promise.resolve(INCIDENT) } as unknown as StatePort,
    workspaceId: 'W0TEST',
    orchestrator: { handleTap: () => Promise.reject(new Error('not a card choice')) },
    stopIncident: () => Promise.reject(new Error('not a stop')),
    prActions: {
      merge: () => (refusal === undefined ? Promise.resolve() : Promise.reject(refusal instanceof Error ? refusal : new PrActionRefusedError(refusal))),
      requestChanges: () => Promise.resolve(),
      revert: () => Promise.resolve(),
    },
    getMap: () => Promise.resolve(MAP),
    githubLinked: () => true,
  });
  return { ix, posts, updates, ephemerals };
}

describe('a refused PR action', () => {
  it('posts the refusal message ephemerally and leaves the card unmarked', async () => {
    const { ix, updates, ephemerals } = setup({ done: false, action: 'merge', reason: 'not-reviewer', message: 'Only a requested reviewer can merge this.' });
    const out = await ix.handleAction(mergePayload());
    expect(out).toEqual({ kind: 'pr-refused', action: 'merge', incidentId: INC, reason: 'not-reviewer' });
    expect(ephemerals).toEqual([{ channel: CHANNEL, user: USER, text: 'Only a requested reviewer can merge this.', thread_ts: THREAD }]);
    expect(updates).toEqual([]);
  });

  it('adds the link when the refusal carries one', async () => {
    const { ix, updates, ephemerals } = setup({
      done: false,
      action: 'merge',
      reason: 'not-linked',
      message: 'Link your GitHub account first.',
      linkUrl: 'https://snapwing.example/auth/github/start?t=1',
    });
    await ix.handleAction(mergePayload());
    expect(ephemerals[0]?.text).toBe('Link your GitHub account first.\n<https://snapwing.example/auth/github/start?t=1|Link your GitHub account>');
    expect(updates).toEqual([]);
  });

  it('still marks the card when the action succeeds', async () => {
    const { ix, updates, ephemerals } = setup(undefined);
    expect(await ix.handleAction(mergePayload())).toEqual({ kind: 'pr-action', action: 'merge', incidentId: INC });
    expect(updates.map((u) => u.text)).toEqual([`<@${USER}> merged this.`]);
    expect(ephemerals).toEqual([]);
  });

  it('lets any other error reach the caller', async () => {
    const { ix, ephemerals } = setup(new Error('github down'));
    await expect(ix.handleAction(mergePayload())).rejects.toThrow('github down');
    expect(ephemerals).toEqual([]);
  });
});
