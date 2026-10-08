// The Slack sandbox the onboarding tests run against: a workspace with no Snapwing app until the
// installer creates one. `slackOnboardHandlers` are the Web API methods the Slack step calls (the
// manifest, the install, the tokens, the channels); `slackDirectoryHandlers` are what the later
// steps ask Slack (people by email, custom emoji). The test drive's Slack (posts, threads, events) is
// `slackWorld` in ../e2e/world.ts. Every value here is a fake; none looks like a real credential.

import { http, HttpResponse, type HttpHandler } from 'msw';

export interface SlackSandboxChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
}

/** What `apps.manifest.create` answers with. */
export interface SlackSandboxApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

/** Who `auth.test` says the bot is. */
export interface SlackSandboxBot {
  userId: string;
  teamId: string;
  team: string;
}

export interface SlackSandbox {
  /** The tokens Slack accepts, by kind. */
  configTokens: Set<string>;
  botTokens: Set<string>;
  appTokens: Set<string>;
  channels: SlackSandboxChannel[];
  /** `users.list`. */
  members: Record<string, unknown>[];
  /** Every app created from a manifest. */
  created: { manifest: Record<string, unknown> }[];
  /** Names of the channels the bot joined. */
  joined: string[];
  /** Every `oauth.v2.access` form. */
  exchanged: Record<string, string>[];
  app: SlackSandboxApp;
  bot: SlackSandboxBot;
  /** The bot token `oauth.v2.access` hands out. */
  oauthToken: string;
  /** The bot token's scopes, as `auth.test` reports them in `x-oauth-scopes`. */
  scopes: string;
  /** People by email, for `users.lookupByEmail`. */
  users: Record<string, { id: string; name: string }>;
  /** The workspace's custom emoji, for `emoji.list`. */
  emoji: Record<string, string>;
}

export function slackSandbox(seed: Partial<SlackSandbox> & Pick<SlackSandbox, 'configTokens' | 'botTokens' | 'appTokens' | 'oauthToken'>): SlackSandbox {
  return {
    channels: [],
    members: [],
    created: [],
    joined: [],
    exchanged: [],
    app: { appId: 'A0APP', clientId: '111.222', clientSecret: 'client-secret-xyz', signingSecret: 'signing-secret-abc' },
    bot: { userId: 'UBOT', teamId: 'T1', team: 'Acme' },
    scopes: '',
    users: {},
    emoji: {},
    ...seed,
  };
}

const bearer = (request: Request): string => (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');

/** The methods the Slack step calls, at `api` (Slack's Web API base, no trailing slash). */
export function slackOnboardHandlers(api: string, slack: SlackSandbox): HttpHandler[] {
  return [
    http.post(`${api}/apps.manifest.validate`, ({ request }) =>
      slack.configTokens.has(bearer(request)) ? HttpResponse.json({ ok: true }) : HttpResponse.json({ ok: false, error: 'token_expired' }),
    ),
    http.post(`${api}/apps.manifest.create`, async ({ request }) => {
      if (!slack.configTokens.has(bearer(request))) return HttpResponse.json({ ok: false, error: 'token_expired' });
      const form = new URLSearchParams(await request.text());
      slack.created.push({ manifest: JSON.parse(form.get('manifest') ?? 'null') as Record<string, unknown> });
      const { appId, clientId, clientSecret, signingSecret } = slack.app;
      return HttpResponse.json({
        ok: true,
        app_id: appId,
        credentials: { client_id: clientId, client_secret: clientSecret, verification_token: 'v', signing_secret: signingSecret },
        oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=${clientId}`,
      });
    }),
    http.post(`${api}/oauth.v2.access`, async ({ request }) => {
      slack.exchanged.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ ok: true, access_token: slack.oauthToken, bot_user_id: slack.bot.userId, team: { id: slack.bot.teamId, name: slack.bot.team } });
    }),
    http.post(`${api}/auth.test`, ({ request }) =>
      slack.botTokens.has(bearer(request))
        ? HttpResponse.json(
            { ok: true, user_id: slack.bot.userId, team_id: slack.bot.teamId, team: slack.bot.team, url: `https://${slack.bot.team.toLowerCase()}.slack.com/` },
            { headers: { 'x-oauth-scopes': slack.scopes } },
          )
        : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
    http.post(`${api}/apps.connections.open`, ({ request }) =>
      slack.appTokens.has(bearer(request)) ? HttpResponse.json({ ok: true, url: 'wss://example.test/link' }) : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
    http.post(`${api}/users.list`, () => HttpResponse.json({ ok: true, members: slack.members })),
    http.post(`${api}/conversations.list`, () => HttpResponse.json({ ok: true, channels: slack.channels.filter((c) => !c.is_private || c.is_member) })),
    http.post(`${api}/conversations.join`, async ({ request }) => {
      const id = new URLSearchParams(await request.text()).get('channel') ?? '';
      const c = slack.channels.find((x) => x.id === id);
      if (c === undefined || c.is_private) return HttpResponse.json({ ok: false, error: 'method_not_supported_for_channel_type' });
      c.is_member = true;
      slack.joined.push(c.name);
      return HttpResponse.json({ ok: true });
    }),
  ];
}

/** What the later steps ask Slack with the bot token: people by email (`people`), custom emoji (`trigger`). */
export function slackDirectoryHandlers(api: string, slack: SlackSandbox): HttpHandler[] {
  return [
    http.get(`${api}/users.lookupByEmail`, ({ request }) => {
      if (!slack.botTokens.has(bearer(request))) return HttpResponse.json({ ok: false, error: 'invalid_auth' });
      const user = slack.users[new URL(request.url).searchParams.get('email') ?? ''];
      return user === undefined ? HttpResponse.json({ ok: false, error: 'users_not_found' }) : HttpResponse.json({ ok: true, user: { ...user, deleted: false, is_bot: false } });
    }),
    http.get(`${api}/emoji.list`, ({ request }) =>
      slack.botTokens.has(bearer(request)) ? HttpResponse.json({ ok: true, emoji: slack.emoji }) : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
  ];
}
