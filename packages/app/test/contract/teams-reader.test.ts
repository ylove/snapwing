import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import { collectWindow } from '@snapwing/pipeline/context/collect.ts';
import { scopePreview } from '@snapwing/pipeline/context/scope-preview.ts';
import { GRAPH_BASE_URL, createTeamsGraph } from '../../src/adapters/teams/graph.ts';
import {
  anchorIdOf,
  bodyToText,
  createTeamsChatReader,
  createTeamsContextSource,
  createTeamsImageLoader,
  toSourceMessage,
} from '../../src/adapters/teams/reader.ts';

const G = GRAPH_BASE_URL;
const T = 'T1';
const C = '19:chan@thread.tacv2';
const CH = `${G}/teams/${T}/channels/${encodeURIComponent(C)}`;
const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const graph = createTeamsGraph({ token: 'graph-token' });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const ANCHOR_ID = '1790000100000';
const iso = (offsetSeconds: number): string => new Date(Date.parse('2026-10-03T10:00:00.000Z') + offsetSeconds * 1000).toISOString();

function message(id: string, offsetSeconds: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    replyToId: null,
    messageType: 'message',
    createdDateTime: iso(offsetSeconds),
    lastModifiedDateTime: iso(offsetSeconds),
    from: { user: { id: `aad-${id}` } },
    body: { contentType: 'text', content: `text ${id}` },
    attachments: [],
    reactions: [],
    ...over,
  };
}

function payload(over: Partial<CanonicalIncidentPayload['context']> = {}, key = `teams-${C};messageid=${ANCHOR_ID}-${ANCHOR_ID}`): CanonicalIncidentPayload {
  return {
    eventId: '01J000000000000000000000AA',
    idempotencyKey: key,
    source: 'teams',
    reporter: { id: 'aad-reporter' } as CanonicalIncidentPayload['reporter'],
    anchorText: 'Checkout is broken',
    context: { channelId: C, rawPayloadSnapshot: { teamId: T }, ...over },
    timestamp: iso(0),
  };
}

describe('body to text', () => {
  it('turns html into text and keeps mentions as ids', () => {
    const m = {
      ...message('m1', 0),
      body: {
        contentType: 'html',
        content:
          '<p>Hi <at id="0">Dana</at> &amp; <at id="1">Everyone</at></p><p>line two<br>three &lt;ok&gt; <emoji alt="🐞" title="bug"></emoji></p><attachment id="a1"></attachment>',
      },
      mentions: [
        { id: 0, mentionText: 'Dana', mentioned: { user: { id: 'aad-dana' } } },
        { id: 1, mentionText: 'Everyone', mentioned: {} },
      ],
    };
    expect(bodyToText(m as never)).toEqual({ text: 'Hi <@aad-dana> & Everyone\nline two\nthree <ok> 🐞', mentions: ['aad-dana'] });
  });
});

describe('history and replies', () => {
  it('reads a window around the anchor with the thread, replyCount, reactions and attachments', async () => {
    server.use(
      http.get(`${CH}/messages`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('$filter')).toContain('lastModifiedDateTime gt');
        return HttpResponse.json({
          value: [
            message('late', 4000), // after the window
            message('m3', 120, { reactions: [{ reactionType: 'like', createdDateTime: iso(130), user: { user: { id: 'u' } } }] }),
            message('deleted', 90, { deletedDateTime: iso(95) }),
            message('system', 80, { messageType: 'systemEventMessage' }),
            message(ANCHOR_ID, 0, { 'replies@odata.count': 2 }),
            message('m1', -60, { 'replies@odata.count': 0 }),
            message('early', -4000, {}), // before the window
          ],
        });
      }),
      http.get(`${CH}/messages/${ANCHOR_ID}/replies`, () =>
        HttpResponse.json({
          value: [message('r2', 30, { replyToId: ANCHOR_ID }), message('r1', 10, { replyToId: ANCHOR_ID })],
        }),
      ),
      http.get(`${CH}/messages/${ANCHOR_ID}`, () => HttpResponse.json(message(ANCHOR_ID, 0))),
      // replyCount is unknown for m3, so its replies are asked for and there are none.
      http.get(`${CH}/messages/m3/replies`, () => HttpResponse.json({ value: [] })),
    );
    const source = createTeamsContextSource(graph);
    const anchor = await source.anchor(payload());
    expect(anchor.message.id).toBe(ANCHOR_ID);
    const bundle = await collectWindow(anchor, source.reader!);
    expect(bundle.included.map((m) => m.id)).toEqual(['m1', ANCHOR_ID, 'r1', 'r2', 'm3']);
    const byId = new Map(bundle.included.map((m) => [m.id, m]));
    expect(byId.get('r1')?.threadParentId).toBe(ANCHOR_ID);
    expect(byId.get('m3')?.reactions).toEqual(['like']);
    expect(byId.get('m1')?.replyCount).toBe(0);
    expect(scopePreview(bundle).text).toContain('the thread under ');
  });

  it('pages over nextLink and keeps the messages nearest the anchor over the limit', async () => {
    const second = `${CH}/messages?$skiptoken=p2`;
    server.use(
      http.get(`${CH}/messages`, ({ request }) => {
        if (new URL(request.url).searchParams.get('$skiptoken') === 'p2') {
          return HttpResponse.json({ value: [message('a', -300), message('b', -20)] });
        }
        return HttpResponse.json({ '@odata.nextLink': second, value: [message('c', 10), message('d', 600)] });
      }),
    );
    const reader = createTeamsChatReader(graph, { teamFor: () => T });
    const got = await reader.history(C, iso(-900), iso(900), 2);
    expect(got.map((m) => m.id)).toEqual(['b', 'c']);
    const all = await reader.history(C, iso(-900), iso(900), 10);
    expect(all.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('gives a thread parent first and nothing for a message without replies', async () => {
    server.use(
      http.get(`${CH}/messages/p/replies`, () => HttpResponse.json({ value: [message('r', 5, { replyToId: 'p' })] })),
      http.get(`${CH}/messages/p`, () => HttpResponse.json(message('p', 0))),
      http.get(`${CH}/messages/q/replies`, () => HttpResponse.json({ value: [] })),
    );
    const reader = createTeamsChatReader(graph, { teamFor: () => T });
    const thread = await reader.replies(C, 'p');
    expect(thread.map((m) => m.id)).toEqual(['p', 'r']);
    expect(thread[0]?.replyCount).toBe(1);
    expect(await reader.replies(C, 'q')).toEqual([]);
  });

  it('finds a reply anchor through its parent', async () => {
    const reply = '1790000100777';
    server.use(http.get(`${CH}/messages/p/replies/${reply}`, () => HttpResponse.json(message(reply, 5, { replyToId: 'p' }))));
    const source = createTeamsContextSource(graph);
    const anchor = await source.anchor(payload({ threadId: 'p' }, `teams-${C}-${reply}-bug`));
    expect(anchor.message).toMatchObject({ id: reply, threadParentId: 'p' });
  });

  it('never takes the team from channelData.team.id, which is a channel thread id', async () => {
    server.use(http.get(`${G}/teams/GROUP/channels/${encodeURIComponent(C)}/messages/${ANCHOR_ID}`, () => HttpResponse.json(message(ANCHOR_ID, 0))));
    const activity = { channelData: { team: { id: '19:general@thread.tacv2' } } };
    // The captured group id wins over the activity's thread id; with none, the map's team is used.
    const withSnapshot = createTeamsContextSource(graph);
    expect((await withSnapshot.anchor(payload({ rawPayloadSnapshot: { ...activity, teamId: 'GROUP' } }))).message.id).toBe(ANCHOR_ID);
    const fromMap = createTeamsContextSource(graph, { teamFor: () => 'GROUP' });
    expect((await fromMap.anchor(payload({ rawPayloadSnapshot: activity }))).message.id).toBe(ANCHOR_ID);
    // Neither: the thread id is not a team, so there is nothing to read and the limitation says so.
    const neither = createTeamsContextSource(graph);
    expect(await neither.limitation?.(payload({ rawPayloadSnapshot: activity }))).toBe('anchor-only');
  });

  it('is deterministic: the same payload gives the same anchor', async () => {
    server.use(http.get(`${CH}/messages/${ANCHOR_ID}`, () => HttpResponse.json(message(ANCHOR_ID, 0))));
    const source = createTeamsContextSource(graph);
    expect(await source.anchor(payload())).toEqual(await source.anchor(payload()));
    expect(anchorIdOf(payload({ rawPayloadSnapshot: { messageId: '1790000100999' } }))).toBe('1790000100999');
    expect(anchorIdOf(payload())).toBe(ANCHOR_ID);
  });
});

describe('without the RSC grant', () => {
  const denied = (): ReturnType<typeof HttpResponse.json> =>
    HttpResponse.json({ error: { code: 'Forbidden', message: 'no rsc' } }, { status: 403 });

  it('returns the anchor only and reports the limitation to the scope preview', async () => {
    server.use(
      http.get(`${CH}/messages`, denied),
      http.get(`${CH}/messages/${ANCHOR_ID}/replies`, denied),
      http.get(`${CH}/messages/${ANCHOR_ID}`, denied),
    );
    const source = createTeamsContextSource(graph);
    const anchor = await source.anchor(payload({}));
    expect(anchor.message).toMatchObject({ id: ANCHOR_ID, text: 'Checkout is broken', authorId: 'aad-reporter' });
    const bundle = await collectWindow(anchor, source.reader!);
    expect(bundle.included.map((m) => m.id)).toEqual([ANCHOR_ID]);
    const limitation = await source.limitation?.(payload());
    expect(limitation).toBe('anchor-only');
    expect(scopePreview(bundle, { ...(limitation === undefined ? {} : { limitation }) }).text).toBe(
      'Reading 1 message at 10:00. I could only read this message.',
    );
  });

  it('reports no limitation when the grant is there', async () => {
    server.use(http.get(`${CH}/messages/${ANCHOR_ID}`, () => HttpResponse.json(message(ANCHOR_ID, 0))));
    expect(await createTeamsContextSource(graph).limitation?.(payload())).toBeUndefined();
  });

  it('keeps the preview as it was without a limitation', () => {
    const bundle = { anchorId: 'a', included: [], excluded: [], windowUsed: { oldest: iso(0), latest: iso(0), cap: 40 } };
    expect(scopePreview(bundle).text).toBe('Reading 0 messages.');
  });

  it('treats a personal chat as the activity alone, with no limitation', async () => {
    const dm = payload(
      {
        channelId: 'a:1personal',
        rawPayloadSnapshot: {
          conversationType: 'personal',
          attachments: [{ contentType: 'image/png', contentUrl: 'https://smba.trafficmanager.net/amer/v3/attachments/x/views/original', name: 's.png' }],
        },
      },
      'teams-a:1personal-1790000100123',
    );
    const source = createTeamsContextSource(graph);
    const anchor = await source.anchor(dm);
    expect(anchor.direct).toBe(true);
    expect(anchor.message.attachments).toEqual([
      { kind: 'image', url: 'https://smba.trafficmanager.net/amer/v3/attachments/x/views/original', mimeType: 'image/png' },
    ]);
    expect(await source.limitation?.(dm)).toBeUndefined();
    expect(await source.reader!.history('a:1personal', iso(-1), iso(1), 5)).toEqual([]);
  });
});

describe('image loader', () => {
  const loader = createTeamsImageLoader(graph, { botToken: () => 'bot-token' });

  it('downloads an inline image from hosted contents', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${CH}/messages/m1/hostedContents/hc1/$value`, ({ request }) => {
        auth = request.headers.get('authorization');
        return new HttpResponse(PNG);
      }),
    );
    const html = `<p>see</p><img src="${CH}/messages/m1/hostedContents/hc1/$value" alt="x">`;
    const src = toSourceMessage({ ...message('m1', 0), body: { contentType: 'html', content: html } } as never, { teamId: T, channelId: C });
    expect(src.text).toBe('see');
    expect(src.attachments).toHaveLength(1);
    const image = await loader(src.attachments[0]!);
    expect(image).toMatchObject({ mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') });
    expect(auth).toBe('Bearer graph-token');
  });

  it('downloads an inline image from a reply', async () => {
    server.use(http.get(`${CH}/messages/p/replies/r/hostedContents/hc2/$value`, () => new HttpResponse(PNG)));
    const image = await loader({ kind: 'image', url: `${CH}/messages/p/replies/r/hostedContents/hc2/$value` });
    expect(image?.mimeType).toBe('image/png');
  });

  it('downloads a SharePoint channel file through Graph', async () => {
    const url = 'https://contoso.sharepoint.com/sites/team/Shared Documents/General/screen.png';
    let seen: string | undefined;
    server.use(
      http.get(`${G}/shares/:token/driveItem/content`, ({ params }) => {
        seen = String(params['token']);
        return new HttpResponse(PNG);
      }),
    );
    const m = toSourceMessage({ ...message('m2', 0), attachments: [{ id: 'a', contentType: 'reference', contentUrl: url, name: 'screen.png' }] } as never, { teamId: T, channelId: C });
    expect(m.attachments).toEqual([{ kind: 'image', url, mimeType: 'image/png' }]);
    const image = await loader(m.attachments[0]!);
    expect(image?.mimeType).toBe('image/png');
    expect(seen).toMatch(/^u!/);
  });

  it('downloads a personal-chat file with the bot token, and only from a bot host', async () => {
    let auth: string | null = null;
    const url = 'https://smba.trafficmanager.net/amer/v3/attachments/x/views/original';
    server.use(
      http.get(url, ({ request }) => {
        auth = request.headers.get('authorization');
        return new HttpResponse(PNG);
      }),
    );
    expect((await loader({ kind: 'image', url, mimeType: 'image/png' }))?.mimeType).toBe('image/png');
    expect(auth).toBe('Bearer bot-token');
    // A host the loader was not told about never gets the token and is never fetched.
    expect(await loader({ kind: 'image', url: 'https://evil.example.com/a.png', mimeType: 'image/png' })).toBeUndefined();
    expect(await loader({ kind: 'file', url, mimeType: 'application/pdf' })).toBeUndefined();
  });

  it('returns undefined for a refused download or an html page', async () => {
    server.use(
      http.get(`${G}/shares/:token/driveItem/content`, () => HttpResponse.json({ error: { code: 'Forbidden' } }, { status: 403 })),
      http.get(`${CH}/messages/m1/hostedContents/hc9/$value`, () => new HttpResponse('<!DOCTYPE html><html>sign in</html>')),
    );
    expect(await loader({ kind: 'image', url: 'https://contoso.sharepoint.com/a.png', mimeType: 'image/png' })).toBeUndefined();
    expect(await loader({ kind: 'image', url: `${CH}/messages/m1/hostedContents/hc9/$value` })).toBeUndefined();
  });

  it('loads a recording through the same path and refuses a sign-in page', async () => {
    const source = createTeamsContextSource(graph, { botToken: () => 'bot-token' });
    const video = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    server.use(
      http.get(`${G}/shares/:token/driveItem/content`, ({ params }) => {
        const url = Buffer.from(String(params['token']).slice(2).replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString();
        return new HttpResponse(url.endsWith('bad.mp4') ? '<html>sign in</html>' : video);
      }),
    );
    const att = (name: string): { kind: 'file'; url: string; mimeType: string } => ({
      kind: 'file',
      url: `https://contoso.sharepoint.com/${name}`,
      mimeType: 'video/mp4',
    });
    expect(await source.loadRecording(att('ok.mp4'))).toEqual(video);
    expect(await source.loadRecording(att('bad.mp4'))).toBeUndefined();
    expect(await source.loadRecording({ kind: 'file', url: 'https://contoso.sharepoint.com/a.pdf', mimeType: 'application/pdf' })).toBeUndefined();
  });
});

describe('which token goes where, and whose inline images (#269)', () => {
  const ATTACHMENT = 'https://smba.trafficmanager.net/amer/v3/attachments/x/views/original';
  let requests: { url: string; auth: string | null }[];

  // Every request the loaders make, answered with an image unless a test says otherwise.
  beforeEach(() => {
    requests = [];
    server.use(
      http.all(/.*/, ({ request }) => {
        requests.push({ url: request.url, auth: request.headers.get('authorization') });
        return new HttpResponse(PNG);
      }),
    );
  });

  it('sends the bot token only to a Bot Connector attachment on an exact Bot Connector host', async () => {
    const loader = createTeamsImageLoader(graph, { botToken: () => 'bot-token', botHosts: ['smba.test'] });
    const allowed = [
      ATTACHMENT,
      'https://smba.infra.gcc.teams.microsoft.com/gcc/v3/attachments/x/views/original',
      // A configured service URL's host (`botHosts`).
      'https://smba.test/amer/v3/attachments/x/views/original',
    ];
    for (const url of allowed) expect((await loader({ kind: 'image', url, mimeType: 'image/png' }))?.mimeType).toBe('image/png');
    expect(requests).toEqual(allowed.map((url) => ({ url, auth: 'Bearer bot-token' })));

    requests = [];
    const refused = [
      // Any other Microsoft host, however it looks.
      'https://us-api.asm.skype.com/v1/objects/0-wus-d2-x/views/imgo',
      'https://example.microsoft.com/amer/v3/attachments/x/views/original',
      'https://api.botframework.com/v3/attachments/x/views/original',
      // A look-alike, a subdomain, another port, plain http.
      'https://smba.trafficmanager.net.attacker.test/amer/v3/attachments/x/views/original',
      'https://x.smba.trafficmanager.net/amer/v3/attachments/x/views/original',
      'https://smba.trafficmanager.net:8443/amer/v3/attachments/x/views/original',
      'http://smba.trafficmanager.net/amer/v3/attachments/x/views/original',
      // The right host, but not an attachment.
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Ax/members',
    ];
    for (const url of refused) expect(await loader({ kind: 'image', url, mimeType: 'image/png' })).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("fetches a personal chat's own attachment, from the activity, with the bot token", async () => {
    const dm = payload(
      { channelId: 'a:1personal', rawPayloadSnapshot: { conversationType: 'personal', attachments: [{ contentType: 'image/png', contentUrl: ATTACHMENT }] } },
      'teams-a:1personal-1790000100123',
    );
    const source = createTeamsContextSource(graph, { botToken: () => 'bot-token' });
    const anchor = await source.anchor(dm);
    expect((await source.loadImage(anchor.message.attachments[0]!))?.mimeType).toBe('image/png');
    expect(requests).toEqual([{ url: ATTACHMENT, auth: 'Bearer bot-token' }]);
  });

  it('never passes on a Bot Connector attachment read back from Graph, so Graph content never meets the bot token', async () => {
    const sharepoint = 'https://contoso.sharepoint.com/sites/team/Shared Documents/General/screen.png';
    server.use(
      http.get(`${CH}/messages/${ANCHOR_ID}`, () =>
        HttpResponse.json(
          message(ANCHOR_ID, 0, {
            body: { contentType: 'html', content: `<p>see</p><img src="${ATTACHMENT}">` },
            attachments: [
              { id: 'a', contentType: 'image/png', contentUrl: ATTACHMENT, name: 'a.png' },
              { id: 'b', contentType: 'image/png', contentUrl: 'https://smba.test/amer/v3/attachments/y/views/original', name: 'b.png' },
              { id: 'c', contentType: 'reference', contentUrl: sharepoint, name: 'screen.png' },
            ],
          }),
        ),
      ),
    );
    const source = createTeamsContextSource(graph, { botToken: () => 'bot-token', botHosts: ['smba.test'] });
    const anchor = await source.anchor(payload());
    expect(anchor.message.attachments).toEqual([{ kind: 'image', url: sharepoint, mimeType: 'image/png' }]);
    for (const a of anchor.message.attachments) expect((await source.loadImage(a))?.mimeType).toBe('image/png');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.auth).toBe('Bearer graph-token');
  });

  it('keeps an inline image only when its URL names the message being read', async () => {
    const hosted = (path: string): string => `${G}/teams/${path}/hostedContents/hc/$value`;
    const channel = encodeURIComponent(C);
    const own = hosted(`${T}/channels/${channel}/messages/m1`);
    const others = [
      hosted(`${T}/channels/${channel}/messages/m9`),
      hosted(`${T}/channels/${encodeURIComponent('19:other@thread.tacv2')}/messages/m1`),
      hosted(`T9/channels/${channel}/messages/m1`),
      hosted(`${T}/channels/${channel}/messages/m1/replies/r1`),
    ];
    const at = { teamId: T, channelId: C };
    const html = [own, ...others].map((u) => `<img src="${u}">`).join('');
    expect(toSourceMessage({ ...message('m1', 0), body: { contentType: 'html', content: html } } as never, at).attachments).toEqual([{ kind: 'image', url: own }]);
    // A reply's own image names its root and itself; its root's image is not the reply's.
    const replyOwn = hosted(`${T}/channels/${channel}/messages/m1/replies/r1`);
    const reply = { ...message('r1', 5, { replyToId: 'm1' }), body: { contentType: 'html', content: `<img src="${replyOwn}"><img src="${own}">` } };
    expect(toSourceMessage(reply as never, at).attachments).toEqual([{ kind: 'image', url: replyOwn }]);
    // Another message's hosted content as an attachment is dropped the same way; with no place known, none is kept.
    const attached = { ...message('m1', 0), attachments: [{ id: 'x', contentType: 'image/png', contentUrl: others[0], name: 'x.png' }] };
    expect(toSourceMessage(attached as never, at).attachments).toEqual([]);
    expect(toSourceMessage({ ...message('m1', 0), body: { contentType: 'html', content: html } } as never, undefined).attachments).toEqual([]);

    // Read through the context source, and from a personal chat's own attachments: the same rule.
    server.use(http.get(`${CH}/messages/${ANCHOR_ID}`, () => HttpResponse.json(message(ANCHOR_ID, 0, { body: { contentType: 'html', content: `<img src="${own}">` } }))));
    expect((await createTeamsContextSource(graph).anchor(payload())).message.attachments).toEqual([]);
    const dm = payload(
      { channelId: 'a:1personal', rawPayloadSnapshot: { conversationType: 'personal', attachments: [{ contentType: 'image/png', contentUrl: own }] } },
      'teams-a:1personal-1790000100123',
    );
    expect((await createTeamsContextSource(graph).anchor(dm)).message.attachments).toEqual([]);
    expect(requests).toEqual([]);
  });
});
