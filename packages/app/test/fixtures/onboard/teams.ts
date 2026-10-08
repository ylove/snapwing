// The Teams sandbox the onboarding tests run against: a Microsoft 365 tenant with Snapwing in no team
// until the owner installs it. `teamsOnboardHandlers` are what the Teams step calls (the bot's token,
// the owner's device code sign-in, the owner's teams and channels, the tenant catalog, the install and
// its grants); `teamsDirectoryHandlers` are what the later steps ask Graph with the bot's own token
// (people by email, a channel's messages, which the tenant refuses until the team owner grants
// `ChannelMessage.Read.Group`). The test drive's Teams (the Bot Connector, change notifications) is
// `teamsWorld` in ../e2e/teams.ts. Every value here is a fake; none looks like a real credential.

import { http, HttpResponse, type HttpHandler } from 'msw';
import { TEAMS_APP_VERSION } from '../../../src/onboard/teams/install.ts';

/** The grant the bot needs to read channel messages: without it a team runs in reduced mode. */
export const CHANNEL_HISTORY_GRANT = 'ChannelMessage.Read.Group';

export interface TeamsTenant {
  /** The bot client secrets Microsoft accepts. */
  secrets: Set<string>;
  /** Snapwing in the tenant catalog, once published. */
  catalog?: { id: string; versions: string[] };
  /** The apps installed in the team. */
  installed: Record<string, unknown>[];
  /** The RSC permissions the team granted the bot. */
  grants: string[];
  uploadDisabled?: boolean;
  /** What the team grants at install; default every permission the install asks for. */
  grantOnInstall?: string[];
  teams: { id: string; displayName: string }[];
  channels: { id: string; displayName: string }[];
  ownerSignIns: number;
  published: number;
  /** People by email, for Graph's user lookup. */
  users: Record<string, { id: string; displayName: string }>;
}

export interface TeamsTenantIds {
  /** Microsoft's sign-in host, no trailing slash. */
  readonly login: string;
  /** Graph's base, such as https://graph.microsoft.com/v1.0. */
  readonly graph: string;
  readonly tenantId: string;
  /** The bot's app (client) id. */
  readonly appId: string;
  /** The team's group id. */
  readonly team: string;
  /** What the client credentials grant hands the bot. */
  readonly appToken: string;
  /** What the owner's device code sign-in hands out. */
  readonly ownerToken: string;
}

export function teamsTenant(seed: Partial<TeamsTenant> & Pick<TeamsTenant, 'secrets'>): TeamsTenant {
  return { installed: [], grants: [], teams: [], channels: [], ownerSignIns: 0, published: 0, users: {}, ...seed };
}

/** Snapwing's row in the team's installed apps. */
export const installedSnapwing = (appId: string): Record<string, unknown> => ({
  id: 'inst-1',
  teamsApp: { id: 'cat-1', externalId: appId, displayName: 'Snapwing' },
  teamsAppDefinition: { version: TEAMS_APP_VERSION },
});

/** What the Teams step calls. */
export function teamsOnboardHandlers(tenant: TeamsTenant, ids: TeamsTenantIds): HttpHandler[] {
  const { login, graph: G, tenantId, appId, team } = ids;
  return [
    http.post(`${login}/${tenantId}/oauth2/v2.0/token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') === 'client_credentials') {
        return tenant.secrets.has(form.get('client_secret') ?? '')
          ? HttpResponse.json({ access_token: ids.appToken, expires_in: 3600 })
          : HttpResponse.json({ error: 'invalid_client' }, { status: 401 });
      }
      tenant.ownerSignIns += 1;
      return HttpResponse.json({ access_token: ids.ownerToken, expires_in: 3600 });
    }),
    http.post(`${login}/${tenantId}/oauth2/v2.0/devicecode`, () =>
      HttpResponse.json({ device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: `${login}/device`, expires_in: 900, interval: 1 }),
    ),
    http.get(`${G}/me/joinedTeams`, () => HttpResponse.json({ value: tenant.teams })),
    http.get(`${G}/teams/${team}/channels`, () => HttpResponse.json({ value: tenant.channels })),
    http.get(`${G}/appCatalogs/teamsApps`, () =>
      HttpResponse.json({ value: tenant.catalog ? [{ id: tenant.catalog.id, externalId: appId, displayName: 'Snapwing' }] : [] }),
    ),
    http.post(`${G}/appCatalogs/teamsApps`, () => {
      if (tenant.uploadDisabled) return HttpResponse.json({ error: { code: 'Forbidden', message: 'custom apps are off' } }, { status: 403 });
      tenant.published += 1;
      tenant.catalog = { id: 'cat-1', versions: [TEAMS_APP_VERSION] };
      return HttpResponse.json({ id: 'cat-1', externalId: appId, displayName: 'Snapwing' });
    }),
    http.get(`${G}/appCatalogs/teamsApps/:id/appDefinitions`, () =>
      HttpResponse.json({ value: (tenant.catalog?.versions ?? []).map((version) => ({ id: `def-${version}`, version })) }),
    ),
    http.get(`${G}/teams/${team}/installedApps`, () => HttpResponse.json({ value: tenant.installed })),
    http.post(`${G}/teams/${team}/installedApps`, async ({ request }) => {
      const body = (await request.json()) as { consentedPermissionSet: { resourceSpecificPermissions: { permissionValue: string }[] } };
      tenant.grants = tenant.grantOnInstall ?? body.consentedPermissionSet.resourceSpecificPermissions.map((p) => p.permissionValue);
      tenant.installed.push(installedSnapwing(appId));
      return new HttpResponse(null, { status: 201 });
    }),
    http.get(`${G}/teams/${team}/permissionGrants`, () =>
      HttpResponse.json({ value: tenant.grants.map((permission, i) => ({ id: `g${i}`, clientAppId: appId, permission, permissionType: 'Application' })) }),
    ),
  ];
}

/**
 * What the later steps ask Graph with the bot's own token: a person by email (`people`), and a
 * channel's messages (`words`), refused while the team has not granted the channel history. A channel
 * the grant covers falls through to the next handler (the test drive's `teamsWorld`).
 */
export function teamsDirectoryHandlers(tenant: TeamsTenant, ids: TeamsTenantIds): HttpHandler[] {
  const G = ids.graph;
  return [
    http.get(`${G}/users`, ({ request }) => {
      const filter = new URL(request.url).searchParams.get('$filter') ?? '';
      const email = /mail eq '([^']+)'/.exec(filter)?.[1] ?? '';
      const user = tenant.users[email];
      return HttpResponse.json({ value: user === undefined ? [] : [{ id: user.id, displayName: user.displayName, mail: email }] });
    }),
    http.get(`${G}/teams/:team/channels/:channel/messages`, () => {
      if (tenant.grants.includes(CHANNEL_HISTORY_GRANT)) return undefined;
      return HttpResponse.json({ error: { code: 'Forbidden', message: 'Missing role permissions on the request.' } }, { status: 403 });
    }),
  ];
}
