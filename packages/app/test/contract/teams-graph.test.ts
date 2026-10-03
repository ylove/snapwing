import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import {
  GRAPH_BASE_URL,
  GRAPH_PERMISSIONS,
  GraphApiError,
  GraphAuthError,
  GraphPermissionError,
  GraphRateLimitError,
  createTeamsGraph,
  shareToken,
} from '../../src/adapters/teams/graph.ts';

const G = GRAPH_BASE_URL;
const TOKEN = 'graph-token-test';
const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function fixture(name: string): Record<string, JsonBodyType> {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/graph/${name}`, import.meta.url), 'utf8'));
}

const graph = createTeamsGraph({ token: TOKEN });

describe('channel history', () => {
  it('pages channel messages over @odata.nextLink with $top and a time floor', async () => {
    const seen: URL[] = [];
    const auth: (string | null)[] = [];
    server.use(
      http.get(`${G}/teams/T1/channels/C1/messages`, ({ request }) => {
        const url = new URL(request.url);
        seen.push(url);
        auth.push(request.headers.get('authorization'));
        return HttpResponse.json(url.searchParams.has('$skiptoken') ? fixture('messages-page2.json') : fixture('messages-page1.json'));
      }),
    );
    const messages = await graph.channelMessages('T1', 'C1', { top: 2, since: '2026-10-03T09:00:00Z' });
    expect(messages.map((m) => m.id)).toEqual(['1700000000002', '1700000000001', '1700000000000']);
    expect(messages[0]?.attachments?.[0]?.contentUrl).toContain('sharepoint.com');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.searchParams.get('$top')).toBe('2');
    expect(seen[0]?.searchParams.get('$filter')).toBe('lastModifiedDateTime gt 2026-10-03T09:00:00Z');
    expect(seen[0]?.searchParams.get('$orderby')).toBe('lastModifiedDateTime desc');
    expect(seen[1]?.searchParams.get('$skiptoken')).toBe('page2');
    expect(auth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it('pages replies of one message', async () => {
    server.use(
      http.get(`${G}/teams/T1/channels/C1/messages/M1/replies`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('$skiptoken') === 'r2') return HttpResponse.json({ value: [{ id: 'r3', replyToId: 'M1', createdDateTime: 'x' }] });
        return HttpResponse.json({
          '@odata.nextLink': `${G}/teams/T1/channels/C1/messages/M1/replies?$skiptoken=r2`,
          value: [{ id: 'r1', replyToId: 'M1', createdDateTime: 'x' }, { id: 'r2', replyToId: 'M1', createdDateTime: 'x' }],
        });
      }),
    );
    const replies = await graph.channelReplies('T1', 'C1', 'M1');
    expect(replies.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('gets one message with reactions, and one reply', async () => {
    server.use(
      http.get(`${G}/teams/T1/channels/C1/messages/1700000000002`, () => HttpResponse.json(fixture('message-reactions.json'))),
      http.get(`${G}/teams/T1/channels/C1/messages/M1/replies/R1`, () =>
        HttpResponse.json({ id: 'R1', replyToId: 'M1', createdDateTime: 'x' }),
      ),
    );
    const message = await graph.message('T1', 'C1', '1700000000002');
    expect(message.reactions?.map((r) => [r.reactionType, r.user.user?.id])).toEqual([
      ['like', 'aad-user-2'],
      ['1f41e_ladybeetle', 'aad-user-3'],
    ]);
    expect((await graph.message('T1', 'C1', 'M1', 'R1')).replyToId).toBe('M1');
  });

  it('downloads hosted content bytes', async () => {
    server.use(
      http.get(`${G}/teams/T1/channels/C1/messages/M1/hostedContents/H1/$value`, () =>
        HttpResponse.arrayBuffer(new Uint8Array([137, 80, 78, 71]).buffer, { headers: { 'Content-Type': 'image/png' } }),
      ),
    );
    expect(Array.from(await graph.hostedContent('T1', 'C1', 'M1', 'H1'))).toEqual([137, 80, 78, 71]);
  });

  it('downloads a SharePoint file from an attachment contentUrl through the shares driveItem', async () => {
    const contentUrl = 'https://contoso.sharepoint.com/sites/team/Shared Documents/General/screen.png';
    let path = '';
    server.use(
      http.get(`${G}/shares/:token/driveItem/content`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer);
      }),
    );
    expect(Array.from(await graph.downloadAttachment(contentUrl))).toEqual([1, 2, 3]);
    expect(path).toBe(`/v1.0/shares/${shareToken(contentUrl)}/driveItem/content`);
    expect(shareToken('https://a.test/x?y=1')).toBe('u!aHR0cHM6Ly9hLnRlc3QveD95PTE');
  });
});

describe('identity', () => {
  it('reads a user by AAD id with userPrincipalName and mail', async () => {
    let select: string | null = null;
    server.use(
      http.get(`${G}/users/aad-user-1`, ({ request }) => {
        select = new URL(request.url).searchParams.get('$select');
        return HttpResponse.json(fixture('user.json'));
      }),
    );
    const user = await graph.user('aad-user-1');
    expect(user).toMatchObject({ userPrincipalName: 'dana@contoso.onmicrosoft.com', mail: 'dana@contoso.com' });
    expect(select).toBe('id,displayName,userPrincipalName,mail');
  });

  it('finds a user by email, escaping quotes, and returns undefined when none match', async () => {
    const filters: (string | null)[] = [];
    server.use(
      http.get(`${G}/users`, ({ request }) => {
        const filter = new URL(request.url).searchParams.get('$filter');
        filters.push(filter);
        return HttpResponse.json({ value: filter?.includes("o''brien") ? [] : [fixture('user.json')] });
      }),
    );
    expect((await graph.userByEmail('dana@contoso.com'))?.id).toBe('aad-user-1');
    expect(filters[0]).toBe("mail eq 'dana@contoso.com' or userPrincipalName eq 'dana@contoso.com'");
    expect(await graph.userByEmail("o'brien@contoso.com")).toBeUndefined();
    expect(filters[1]).toContain("'o''brien@contoso.com'");
  });
});

describe('teams, channels, members, apps', () => {
  it('lists teams (tenant and joined), channels, and members with paging', async () => {
    server.use(
      http.get(`${G}/groups`, () => HttpResponse.json({ value: [{ id: 'T1', displayName: 'Eng' }] })),
      http.get(`${G}/me/joinedTeams`, () => HttpResponse.json({ value: [{ id: 'T2', displayName: 'Ops' }] })),
      http.get(`${G}/teams/T1/channels`, () =>
        HttpResponse.json({ value: [{ id: 'C1', displayName: 'General' }, { id: 'C2', displayName: 'Bugs' }] }),
      ),
      http.get(`${G}/teams/T1/channels/C1/members`, ({ request }) => {
        if (new URL(request.url).searchParams.has('$skiptoken')) {
          return HttpResponse.json({ value: [{ id: 'm2', userId: 'aad-user-2', roles: [] }] });
        }
        return HttpResponse.json({
          '@odata.nextLink': `${G}/teams/T1/channels/C1/members?$skiptoken=n`,
          value: [{ id: 'm1', userId: 'aad-user-1', roles: ['owner'] }],
        });
      }),
    );
    expect((await graph.teams()).map((t) => t.id)).toEqual(['T1']);
    expect((await graph.teams({ joined: true })).map((t) => t.id)).toEqual(['T2']);
    expect((await graph.channels('T1')).map((c) => c.displayName)).toEqual(['General', 'Bugs']);
    expect((await graph.channelMembers('T1', 'C1')).map((m) => [m.userId, m.roles])).toEqual([
      ['aad-user-1', ['owner']],
      ['aad-user-2', []],
    ]);
  });

  it('lists a team\'s installed apps and RSC permission grants', async () => {
    let expand: string | null = null;
    server.use(
      http.get(`${G}/teams/T1/installedApps`, ({ request }) => {
        expand = new URL(request.url).searchParams.get('$expand');
        return HttpResponse.json(fixture('installed-apps.json'));
      }),
      http.get(`${G}/teams/T1/permissionGrants`, () =>
        HttpResponse.json({
          value: [{ id: 'g1', clientAppId: 'bot-app', permission: 'ChannelMessage.Read.Group', permissionType: 'Application' }],
        }),
      ),
    );
    const apps = await graph.installedApps('T1');
    expect(apps[0]?.teamsApp?.displayName).toBe('Snapwing');
    expect(expand).toBe('teamsApp');
    expect((await graph.rscGrants('T1')).map((g) => g.permission)).toEqual(['ChannelMessage.Read.Group']);
  });
});

describe('app catalog and install', () => {
  it('lists the organization catalog, or one app by external id', async () => {
    const filters: (string | null)[] = [];
    server.use(
      http.get(`${G}/appCatalogs/teamsApps`, ({ request }) => {
        filters.push(new URL(request.url).searchParams.get('$filter'));
        return HttpResponse.json({ value: [{ id: 'catalog-app-1', externalId: 'ext-1', displayName: 'Snapwing' }] });
      }),
    );
    expect(await graph.catalogApps()).toHaveLength(1);
    await graph.catalogApps({ externalId: 'ext-1' });
    expect(filters).toEqual(["distributionMethod eq 'organization'", "externalId eq 'ext-1'"]);
  });

  it('publishes and updates a package as application/zip', async () => {
    const calls: { path: string; type: string | null; size: number }[] = [];
    server.use(
      http.post(`${G}/appCatalogs/teamsApps`, async ({ request }) => {
        calls.push({ path: new URL(request.url).pathname, type: request.headers.get('content-type'), size: (await request.arrayBuffer()).byteLength });
        return HttpResponse.json({ id: 'catalog-app-1', displayName: 'Snapwing' }, { status: 201 });
      }),
      http.post(`${G}/appCatalogs/teamsApps/catalog-app-1/appDefinitions`, async ({ request }) => {
        calls.push({ path: new URL(request.url).pathname, type: request.headers.get('content-type'), size: (await request.arrayBuffer()).byteLength });
        return HttpResponse.json({ id: 'def-2' }, { status: 201 });
      }),
    );
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 9]);
    expect((await graph.publishApp(zip)).id).toBe('catalog-app-1');
    await graph.updateApp('catalog-app-1', zip);
    expect(calls).toEqual([
      { path: '/v1.0/appCatalogs/teamsApps', type: 'application/zip', size: 5 },
      { path: '/v1.0/appCatalogs/teamsApps/catalog-app-1/appDefinitions', type: 'application/zip', size: 5 },
    ]);
  });

  it('installs an app in a team, consenting the RSC permissions at install', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${G}/teams/T1/installedApps`, async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 201 });
      }),
    );
    await graph.installApp('T1', 'catalog-app-1', { rscPermissions: ['ChannelMessage.Read.Group'] });
    await graph.installApp('T1', 'catalog-app-1');
    expect(bodies).toEqual([
      {
        'teamsApp@odata.bind': `${G}/appCatalogs/teamsApps/catalog-app-1`,
        consentedPermissionSet: { resourceSpecificPermissions: [{ permissionValue: 'ChannelMessage.Read.Group', permissionType: 'Application' }] },
      },
      { 'teamsApp@odata.bind': `${G}/appCatalogs/teamsApps/catalog-app-1` },
    ]);
  });
});

describe('subscriptions', () => {
  it('creates, renews, lists, and deletes', async () => {
    const seen: { method: string; body?: unknown }[] = [];
    server.use(
      http.post(`${G}/subscriptions`, async ({ request }) => {
        seen.push({ method: 'POST', body: await request.json() });
        return HttpResponse.json(fixture('subscription.json'), { status: 201 });
      }),
      http.patch(`${G}/subscriptions/sub-1`, async ({ request }) => {
        seen.push({ method: 'PATCH', body: await request.json() });
        return HttpResponse.json({ ...fixture('subscription.json'), expirationDateTime: '2026-10-03T12:00:00.0000000Z' });
      }),
      http.get(`${G}/subscriptions`, () => HttpResponse.json({ value: [fixture('subscription.json')] })),
      http.delete(`${G}/subscriptions/sub-1`, () => {
        seen.push({ method: 'DELETE' });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const input = {
      resource: '/teams/T1/channels/C1/messages',
      changeType: 'created,updated',
      notificationUrl: 'https://snapwing.example.test/teams/graph',
      expirationDateTime: '2026-10-03T11:00:00.0000000Z',
      clientState: 'secret-state',
    };
    expect((await graph.createSubscription(input)).id).toBe('sub-1');
    expect((await graph.renewSubscription('sub-1', '2026-10-03T12:00:00.0000000Z')).expirationDateTime).toContain('12:00:00');
    expect((await graph.subscriptions()).map((s) => s.id)).toEqual(['sub-1']);
    await graph.deleteSubscription('sub-1');
    expect(seen).toEqual([
      { method: 'POST', body: input },
      { method: 'PATCH', body: { expirationDateTime: '2026-10-03T12:00:00.0000000Z' } },
      { method: 'DELETE' },
    ]);
  });
});

describe('errors', () => {
  const forbidden = (): Response =>
    HttpResponse.json({ error: { code: 'Forbidden', message: 'Insufficient privileges to complete the operation.' } }, { status: 403 });

  it('a 403 on channel history is a GraphPermissionError naming the RSC permission', async () => {
    server.use(http.get(`${G}/teams/T1/channels/C1/messages`, forbidden));
    const err = await graph.channelMessages('T1', 'C1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphPermissionError);
    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphPermissionError).permission).toBe('ChannelMessage.Read.Group');
    expect((err as GraphPermissionError).message).toContain('ChannelMessage.Read.Group');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('a 403 names the permission of the call that failed', async () => {
    server.use(
      http.get(`${G}/users/u1`, forbidden),
      http.get(`${G}/teams/T1/installedApps`, forbidden),
      http.post(`${G}/subscriptions`, forbidden),
    );
    const perm = async (p: Promise<unknown>): Promise<string> => ((await p.catch((e: unknown) => e)) as GraphPermissionError).permission;
    expect(await perm(graph.user('u1'))).toBe(GRAPH_PERMISSIONS.user);
    expect(await perm(graph.installedApps('T1'))).toBe(GRAPH_PERMISSIONS.installedApps);
    expect(
      await perm(graph.createSubscription({ resource: 'r', changeType: 'updated', notificationUrl: 'https://x.test', expirationDateTime: 'x' })),
    ).toBe(GRAPH_PERMISSIONS.subscriptions);
  });

  it('a 429 is a GraphRateLimitError with retryAfterMs, also on a later page', async () => {
    let calls = 0;
    server.use(
      http.get(`${G}/teams/T1/channels/C1/messages`, ({ request }) => {
        calls++;
        if (new URL(request.url).searchParams.has('$skiptoken')) {
          return new HttpResponse(null, { status: 429, headers: { 'Retry-After': '7' } });
        }
        return HttpResponse.json(fixture('messages-page1.json'));
      }),
    );
    const err = await graph.channelMessages('T1', 'C1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphRateLimitError);
    expect((err as GraphRateLimitError).retryAfterMs).toBe(7000);
    expect(calls).toBe(2);
  });

  it('a 429 without Retry-After defaults to one second', async () => {
    server.use(http.get(`${G}/users/u1`, () => new HttpResponse(null, { status: 429 })));
    const err = (await graph.user('u1').catch((e: unknown) => e)) as GraphRateLimitError;
    expect(err.retryAfterMs).toBe(1000);
  });

  it('a 401 is a GraphAuthError and a 404 a plain GraphApiError with the code', async () => {
    server.use(
      http.get(`${G}/users/u1`, () => HttpResponse.json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, { status: 401 })),
      http.get(`${G}/users/u2`, () => HttpResponse.json({ error: { code: 'Request_ResourceNotFound', message: 'gone' } }, { status: 404 })),
    );
    expect(await graph.user('u1').catch((e: unknown) => e)).toBeInstanceOf(GraphAuthError);
    const notFound = (await graph.user('u2').catch((e: unknown) => e)) as GraphApiError;
    expect(notFound).not.toBeInstanceOf(GraphPermissionError);
    expect([notFound.status, notFound.code]).toEqual([404, 'Request_ResourceNotFound']);
  });

  it('refuses a next link that leaves the Graph origin, so the token never goes there', async () => {
    server.use(
      http.get(`${G}/teams/T1/channels`, () =>
        HttpResponse.json({ '@odata.nextLink': 'https://evil.test/steal', value: [{ id: 'C1' }] }),
      ),
    );
    const err = (await graph.channels('T1').catch((e: unknown) => e)) as GraphApiError;
    expect(err.code).toBe('ForeignOrigin');
  });
});

describe('token source', () => {
  it('takes a function, read on every request, for delegated and app tokens alike', async () => {
    const used: (string | null)[] = [];
    let n = 0;
    const g = createTeamsGraph({ token: () => `delegated-${++n}` });
    server.use(
      http.get(`${G}/users/u1`, ({ request }) => {
        used.push(request.headers.get('authorization'));
        return HttpResponse.json(fixture('user.json'));
      }),
    );
    await g.user('u1');
    await g.user('u1');
    expect(used).toEqual(['Bearer delegated-1', 'Bearer delegated-2']);
  });
});
