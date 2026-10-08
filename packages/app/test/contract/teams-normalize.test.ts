import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { createTeamsGraph, type GraphMessage } from '../../src/adapters/teams/graph.ts';
import {
  normalizeTeams,
  teamsHtmlToText,
  teamsSnapshotOf,
  type TeamsNormalizeContext,
  type TeamsNormalizeResult,
  type TeamsReactionTrigger,
} from '../../src/adapters/teams/normalize.ts';

const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001';
const PAT = '6f1c2a3b-0000-4000-8000-00000000a002';
const DM = 'a:1personal-chat-rae';
const GRAPH = 'https://graph.microsoft.com/v1.0';

function activity(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/activities/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}
const reactionMessage = (): GraphMessage => activity('reaction-message') as unknown as GraphMessage;

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [],
  channels: [
    { id: CHANNEL, name: 'web-bugs', surface: 'web', platform: 'teams', teamId: TEAM, triggerEmoji: [] },
    { id: '19:override@thread.tacv2', name: 'ops', surface: 'web', platform: 'teams', teamId: TEAM, triggerEmoji: ['eyes'] },
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
  people: [
    { teamsId: RAE, handle: 'rae', email: 'rae@example.com', role: 'reporter', owns: [] },
    { teamsId: SAM, handle: 'sam', role: 'engineer', owns: [] },
    { teamsId: PAT, handle: 'pat', email: 'pat@example.com', role: 'reporter', owns: [] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

// Graph `GET /users/{id}`: Rae has a mailbox, Sam has only a UPN, Pat has both.
const users: Record<string, Record<string, unknown>> = {
  [RAE]: { id: RAE, displayName: 'Rae Reporter', userPrincipalName: 'rae@contoso.onmicrosoft.com', mail: 'rae@contoso.example' },
  [SAM]: { id: SAM, displayName: 'Sam Engineer', userPrincipalName: 'sam@contoso.onmicrosoft.com', mail: null },
  [PAT]: { id: PAT, displayName: 'Pat Reporter', userPrincipalName: 'pat@contoso.onmicrosoft.com', mail: 'pat@contoso.example' },
};

const server = setupServer(
  http.get(`${GRAPH}/users/:id`, ({ params }) => {
    const user = users[String(params['id'])];
    return user === undefined
      ? HttpResponse.json({ error: { code: 'Request_ResourceNotFound', message: 'not found' } }, { status: 404 })
      : HttpResponse.json(user);
  }),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const graph = createTeamsGraph({ token: 'graph-test-token' });

function ctx(over: Partial<TeamsNormalizeContext> = {}): TeamsNormalizeContext {
  return {
    map,
    botAppId: APP_ID,
    userOf: async (id) => {
      try {
        const u = await graph.user(id);
        return {
          ...(u.displayName ? { displayName: u.displayName } : {}),
          ...(u.userPrincipalName ? { userPrincipalName: u.userPrincipalName } : {}),
          ...(u.mail ? { mail: u.mail } : {}),
          ...(u.userType ? { userType: u.userType } : {}),
        };
      } catch {
        return undefined;
      }
    },
    newEventId: () => '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    ...over,
  };
}

function incident(result: TeamsNormalizeResult) {
  if (result.kind !== 'incident') throw new Error(`ignored: ${result.reason}`);
  return result.payload;
}

const fromActivity = (a: unknown, c = ctx()) => normalizeTeams({ kind: 'activity', activity: a }, c);
const fromReaction = (t: Partial<TeamsReactionTrigger> = {}, c = ctx()) =>
  normalizeTeams({ kind: 'reaction', trigger: { teamId: TEAM, channelId: CHANNEL, message: reactionMessage(), reaction: 'bug', reactorAadId: SAM, ...t } }, c);

describe('action command (message extension)', () => {
  it('fetchTask on a root post: the invoker reports, the post author is the anchor author, both by AAD id with Graph emails', async () => {
    const p = incident(await fromActivity(activity('action-fetch-task')));
    expect(p.source).toBe('teams');
    expect(p.idempotencyKey).toBe(`teams-${CHANNEL}-1790000100123`);
    expect(p.reporter).toEqual({ id: SAM, name: 'sam', email: 'sam@contoso.onmicrosoft.com', role: 'engineer' });
    expect(p.anchorAuthor).toEqual({ id: RAE, name: 'rae', email: 'rae@contoso.example', role: 'reporter' });
    expect(p.anchorText).toBe('Checkout total shows NaN & the pay button is gone @Sam Engineer');
    expect(p.timestamp).toBe('2026-10-03T10:00:00.000Z');
    expect(p.context.channelId).toBe(CHANNEL);
    expect(p.context.threadId).toBeUndefined();
    expect(p.context.deepLink).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/message\/19:5f3c0a7e9d2b4c1a8e6f@thread\.tacv2\/1790000100123\?/);
    const snap = teamsSnapshotOf(p);
    expect(snap).toMatchObject({
      type: 'action-command',
      conversationType: 'channel',
      channelId: CHANNEL,
      anchorId: '1790000100123',
      threadRootId: '1790000100123',
      teamId: TEAM,
      tenantId: TENANT,
      serviceUrl: 'https://smba.test/amer/',
      reporterTeamsId: '29:1sam-engineer-teams-id',
      reporterUpn: 'sam@contoso.onmicrosoft.com',
      anchorAuthorUpn: 'rae@contoso.onmicrosoft.com',
      invoke: 'composeExtension/fetchTask',
      commandId: 'fixItFromHere',
    });
    expect(snap.files).toEqual([{ kind: 'inline', url: expect.stringContaining('/hostedContents/aWQ9eF8wLXd1cy1kMTAt/$value') as unknown }]);
  });

  it('submitAction on a thread reply by its own author: the reply is the anchor, the root is the thread, no anchor author', async () => {
    const p = incident(await fromActivity(activity('action-submit-reply')));
    expect(p.idempotencyKey).toBe(`teams-${CHANNEL}-1790000100777`);
    expect(p.reporter.id).toBe(RAE);
    expect(p.anchorAuthor).toBeUndefined();
    expect(p.anchorText).toBe('Still broken after a refresh, on Safari too.\nTotal is NaN.');
    expect(p.context.threadId).toBe('1790000100123');
    // No link from Teams: built from the channel, the message, the map's team, and the thread.
    expect(p.context.deepLink).toBe(
      `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1790000100777?groupId=${TEAM}&parentMessageId=1790000100123`,
    );
    const snap = teamsSnapshotOf(p);
    expect(snap.teamId).toBe(TEAM);
    expect(snap.files).toEqual([
      { kind: 'file', url: 'https://contoso.sharepoint.com/sites/Web/Shared Documents/web-bugs/safari-total.png', contentType: 'image/png', name: 'safari-total.png' },
    ]);
  });

  it('an unknown command or a compose-box invocation is ignored', async () => {
    const a = activity('action-fetch-task');
    const other = { ...a, value: { ...(a['value'] as object), commandId: 'somethingElse' } };
    expect(await fromActivity(other)).toEqual({ kind: 'ignored', reason: 'unknown-command' });
    const compose = { ...a, value: { ...(a['value'] as object), commandContext: 'compose' } };
    expect(await fromActivity(compose)).toEqual({ kind: 'ignored', reason: 'not-a-message-command' });
    expect(await fromActivity(a, ctx({ commandId: 'renamedInManifest' }))).toEqual({ kind: 'ignored', reason: 'unknown-command' });
  });
});

describe('personal chat', () => {
  it('text: the chat is the channel, the message the anchor, no thread, no link', async () => {
    const p = incident(await fromActivity(activity('personal-text')));
    expect(p.idempotencyKey).toBe(`teams-${DM}-1790000200456`);
    expect(p.reporter).toEqual({ id: RAE, name: 'rae', email: 'rae@contoso.example', role: 'reporter' });
    expect(p.anchorAuthor).toBeUndefined();
    expect(p.anchorText).toBe('The export button does nothing on the reports page');
    expect(p.context).toMatchObject({ channelId: DM });
    expect(p.context.threadId).toBeUndefined();
    expect(p.context.deepLink).toBeUndefined();
    expect(teamsSnapshotOf(p)).toMatchObject({ type: 'personal-message', conversationType: 'personal', anchorId: '1790000200456', files: [] });
  });

  it('an inline image with no text: one image, read from the attachment and its HTML twin', async () => {
    const p = incident(await fromActivity(activity('personal-inline-image')));
    expect(p.anchorText).toBe('');
    expect(teamsSnapshotOf(p).files).toEqual([
      { kind: 'inline', url: 'https://smba.test/amer/v3/attachments/0-eus-d4-1a2b3c/views/original', contentType: 'image/*' },
    ]);
  });

  it('file attachments: image files are kept for the reader, other files are not', async () => {
    const p = incident(await fromActivity(activity('personal-file')));
    expect(p.anchorText).toBe('Here is the screenshot');
    expect(teamsSnapshotOf(p).files).toEqual([
      {
        kind: 'file',
        url: 'https://contoso-my.sharepoint.com/personal/rae/_layouts/15/download.aspx?UniqueId=4e5f6a7b-0000-4000-8000-0000000000f1',
        contentType: 'image/png',
        name: 'reports-export.png',
      },
    ]);
  });

  it("the bot's own message, another bot, a channel message, an empty message, and a disabled trigger are ignored", async () => {
    expect(await fromActivity(activity('own-message'))).toEqual({ kind: 'ignored', reason: 'own-message' });
    const text = activity('personal-text');
    expect(await fromActivity({ ...text, from: { id: '28:another-bot', name: 'Other' } })).toEqual({ kind: 'ignored', reason: 'bot-message' });
    const inChannel = { ...text, conversation: { conversationType: 'channel', id: `${CHANNEL};messageid=1` }, channelData: { channel: { id: CHANNEL } } };
    expect(await fromActivity(inChannel)).toEqual({ kind: 'ignored', reason: 'not-a-personal-chat' });
    expect(await fromActivity({ ...text, text: '  ' })).toEqual({ kind: 'ignored', reason: 'empty-message' });
    const textOff = { ...map, triggers: { ...map.triggers, directMessage: { images: true, text: false } } };
    expect(await fromActivity(text, ctx({ map: textOff }))).toEqual({ kind: 'ignored', reason: 'direct-message-disabled' });
    const imagesOff = { ...map, triggers: { ...map.triggers, directMessage: { images: false, text: true } } };
    expect(await fromActivity(activity('personal-inline-image'), ctx({ map: imagesOff }))).toEqual({ kind: 'ignored', reason: 'direct-message-disabled' });
  });

  it('an unknown activity is ignored', async () => {
    expect(await fromActivity(activity('conversation-update'))).toEqual({ kind: 'ignored', reason: 'unsupported-activity' });
    expect(await fromActivity({ type: 'invoke', name: 'adaptiveCard/action' })).toEqual({ kind: 'ignored', reason: 'unsupported-activity' });
    expect(await fromActivity('not an object')).toEqual({ kind: 'ignored', reason: 'unsupported-activity' });
  });
});

describe('reaction trigger (Graph diff)', () => {
  it('a trigger reaction on a reply: the reactor reports, the author is the anchor author, the root is the thread', async () => {
    const p = incident(await fromReaction());
    expect(p.idempotencyKey).toBe(`teams-${CHANNEL}-1790000100555-bug`);
    expect(p.reporter).toEqual({ id: SAM, name: 'sam', email: 'sam@contoso.onmicrosoft.com', role: 'engineer' });
    expect(p.anchorAuthor).toEqual({ id: RAE, name: 'rae', email: 'rae@contoso.example', role: 'reporter' });
    expect(p.anchorText).toBe('The coupon field rejects every code since this morning');
    expect(p.timestamp).toBe('2026-10-03T10:20:00.000Z');
    expect(p.context).toMatchObject({ channelId: CHANNEL, threadId: '1790000100123', deepLink: reactionMessage().webUrl });
    expect(teamsSnapshotOf(p)).toMatchObject({ type: 'reaction', reaction: 'bug', reactors: [SAM], teamId: TEAM, threadRootId: '1790000100123' });
  });

  it("the anchor's author reacting on their own post is the reporter, with no anchor author", async () => {
    const p = incident(await fromReaction({ reactorAadId: RAE }));
    expect(p.reporter.id).toBe(RAE);
    expect(p.anchorAuthor).toBeUndefined();
  });

  it("a bot's post has no anchor author", async () => {
    const message = { ...reactionMessage(), from: { application: { id: 'some-app', displayName: 'Deploy bot' } } };
    const p = incident(await fromReaction({ message }));
    expect(p.anchorAuthor).toBeUndefined();
  });

  it('other emoji, the bot itself, a deleted message, and minReactors are honored', async () => {
    expect(await fromReaction({ reaction: 'like' })).toEqual({ kind: 'ignored', reason: 'not-a-trigger-emoji' });
    expect(await fromReaction({ reactorAadId: APP_ID })).toEqual({ kind: 'ignored', reason: 'own-reaction' });
    expect(await fromReaction({ message: { ...reactionMessage(), deletedDateTime: '2026-10-03T10:30:00Z' } })).toEqual({
      kind: 'ignored',
      reason: 'deleted-message',
    });
    expect(await fromReaction({ reaction: 'fire' })).toEqual({ kind: 'ignored', reason: 'below-min-reactors' });
    expect(await fromReaction({ reaction: 'fire', reactors: [SAM, APP_ID] })).toEqual({ kind: 'ignored', reason: 'below-min-reactors' });
    const fire = incident(await fromReaction({ reaction: 'fire', reactors: [SAM, PAT] }));
    expect(fire.idempotencyKey).toBe(`teams-${CHANNEL}-1790000100555-fire`);
    expect(teamsSnapshotOf(fire).reactors).toEqual([SAM, PAT]);
  });

  it("a channel's emoji override replaces the workspace list", async () => {
    const onOverride = { channelId: '19:override@thread.tacv2' };
    expect(await fromReaction({ ...onOverride, reaction: 'bug' })).toEqual({ kind: 'ignored', reason: 'not-a-trigger-emoji' });
    expect((await fromReaction({ ...onOverride, reaction: 'eyes' })).kind).toBe('incident');
  });
});

describe('email correlation (main 15.2)', () => {
  it('without Graph the map email stands in; without either there is no email, never a made-up one', async () => {
    const { userOf: _graph, ...withoutGraph } = ctx();
    const noGraph = incident(await fromActivity(activity('personal-text'), withoutGraph));
    expect(noGraph.reporter).toEqual({ id: RAE, name: 'rae', email: 'rae@example.com', role: 'reporter' });
    // Sam has no map email and Graph is down: no email at all.
    const down = incident(await fromActivity(activity('action-fetch-task'), ctx({ userOf: () => Promise.resolve(undefined) })));
    expect(down.reporter).toEqual({ id: SAM, name: 'sam', role: 'engineer' });
  });

  it('a person outside the map keeps the AAD id and takes the Graph display name', async () => {
    const stranger = '6f1c2a3b-0000-4000-8000-00000000f00d';
    users[stranger] = { id: stranger, displayName: 'Lee Stranger', userPrincipalName: 'lee@contoso.onmicrosoft.com', mail: 'lee@contoso.example' };
    const text = activity('personal-text');
    const p = incident(await fromActivity({ ...text, from: { id: '29:1lee', name: 'Lee S', aadObjectId: stranger } }));
    expect(p.reporter).toEqual({ id: stranger, name: 'Lee Stranger', email: 'lee@contoso.example', role: 'unknown' });
  });
});

describe('teamsHtmlToText', () => {
  it('keeps mentions as names, breaks lines at blocks, drops tags, decodes entities', () => {
    expect(teamsHtmlToText('<p>a &lt;b&gt; &#39;c&#x27; &nbsp;<at id="1">Dana</at></p><p>next<br/>line</p><img src="x">')).toBe(
      "a <b> 'c'  @Dana\nnext\nline",
    );
  });
});

describe('who triggers caps the level (guest, external, fail closed)', () => {
  const CAP = { level: 1, reason: 'guest-trigger' };
  const GUEST = '6f1c2a3b-0000-4000-8000-00000000b001';
  const EXT = '6f1c2a3b-0000-4000-8000-00000000b002';
  const GONE = '6f1c2a3b-0000-4000-8000-00000000b003';
  const OTHER_TENANT = '7a0d5e6f-0000-4000-8000-0000000000d9';

  function withTenant(c: TeamsNormalizeContext = ctx()): TeamsNormalizeContext {
    return { ...c, tenantId: TENANT };
  }
  /** The same activity from `aad`, optionally claiming another tenant. */
  function from(name: string, aad: string, tenant?: string) {
    const a = activity(name);
    const channelData = (a['channelData'] ?? {}) as Record<string, unknown>;
    return {
      ...a,
      from: { ...(a['from'] as object), aadObjectId: aad },
      ...(tenant === undefined ? {} : { channelData: { ...channelData, tenant: { id: tenant } } }),
    };
  }

  it('leaves a member uncapped on every trigger', async () => {
    expect(incident(await fromActivity(activity('action-fetch-task'), withTenant())).levelCap).toBeUndefined();
    expect(incident(await fromActivity(activity('personal-text'), withTenant())).levelCap).toBeUndefined();
    expect(incident(await fromReaction({}, withTenant())).levelCap).toBeUndefined();
  });

  it('caps a guest (userType Guest, or an #EXT# account) who triggers the action command, a chat, or a reaction', async () => {
    users[GUEST] = { id: GUEST, displayName: 'Gus Guest', userPrincipalName: 'gus@contoso.onmicrosoft.com', mail: null, userType: 'Guest' };
    users[EXT] = { id: EXT, displayName: 'Eve Ext', userPrincipalName: 'eve_partner.com#EXT#@contoso.onmicrosoft.com', mail: null, userType: 'Member' };
    for (const who of [GUEST, EXT]) {
      expect(incident(await fromActivity(from('action-fetch-task', who), withTenant())).levelCap).toEqual(CAP);
      expect(incident(await fromActivity(from('personal-text', who), withTenant())).levelCap).toEqual(CAP);
      expect(incident(await fromReaction({ reactorAadId: who }, withTenant())).levelCap).toEqual(CAP);
    }
  });

  it('caps a user whose activity names another tenant, even a member of its own', async () => {
    const p = incident(await fromActivity(from('personal-text', RAE, OTHER_TENANT), withTenant()));
    expect(p.levelCap).toEqual(CAP);
    expect(incident(await fromActivity(from('action-fetch-task', SAM, OTHER_TENANT), withTenant())).levelCap).toEqual(CAP);
    expect(incident(await fromActivity(from('personal-text', RAE, TENANT), withTenant())).levelCap).toBeUndefined();
  });

  it('fails closed when the lookup fails or is not given', async () => {
    expect(incident(await fromActivity(from('personal-text', GONE), withTenant())).levelCap).toEqual(CAP);
    expect(incident(await fromActivity(activity('personal-text'), withTenant(ctx({ userOf: () => Promise.resolve(undefined) })))).levelCap).toEqual(CAP);
    const { userOf: _graph, ...noGraph } = ctx();
    expect(incident(await fromActivity(activity('action-fetch-task'), withTenant(noGraph))).levelCap).toEqual(CAP);
  });

  it('caps a reaction only when no reactor is a member', async () => {
    users[GUEST] = { id: GUEST, displayName: 'Gus Guest', userPrincipalName: 'gus@contoso.onmicrosoft.com', mail: null, userType: 'Guest' };
    expect(incident(await fromReaction({ reactorAadId: GUEST, reactors: [GUEST, GONE] }, withTenant())).levelCap).toEqual(CAP);
    expect(incident(await fromReaction({ reactorAadId: GUEST, reactors: [GUEST, SAM] }, withTenant())).levelCap).toBeUndefined();
  });
});
