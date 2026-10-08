// Microsoft Graph client for the Teams adapter (main 15.2, 22.4; ADR 0005, 0006).
// One factory over `fetch`: bearer token (a string or a function, so a delegated user token and the
// app's client-credentials token share the client), paging over `@odata.nextLink`, and typed errors.
// A 403 names the permission the call needs (`GraphPermissionError`) so callers fall back to reduced
// mode; a 429 carries `retryAfterMs` (`GraphRateLimitError`). The token never reaches an error.

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/** Permissions each call needs (RSC where the spec says so, else the Graph permission). */
export const GRAPH_PERMISSIONS = {
  history: 'ChannelMessage.Read.Group',
  files: 'ChannelMessage.Read.Group',
  user: 'User.Read.All',
  teams: 'Team.ReadBasic.All',
  channels: 'Channel.ReadBasic.All',
  members: 'ChannelMember.Read.All',
  installedApps: 'TeamsAppInstallation.ReadForTeam.All',
  rscGrants: 'TeamSettings.Read.All',
  catalogRead: 'AppCatalog.Read.All',
  catalogWrite: 'AppCatalog.Submit',
  install: 'TeamsAppInstallation.ReadWriteForTeam.All',
  subscriptions: 'ChannelMessage.Read.Group',
} as const;

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Graph ${status}${code ? ` ${code}` : ''}: ${message}`);
    this.name = 'GraphApiError';
  }
}

/** A 403: the app lacks `permission`. Callers degrade (reduced mode) rather than fail. */
export class GraphPermissionError extends GraphApiError {
  constructor(
    readonly permission: string,
    code: string,
    detail: string,
  ) {
    super(403, code, `missing permission ${permission}${detail ? ` (${detail})` : ''}`);
    this.name = 'GraphPermissionError';
  }
}

export class GraphRateLimitError extends GraphApiError {
  constructor(readonly retryAfterMs: number) {
    super(429, 'TooManyRequests', `retry after ${retryAfterMs} ms`);
    this.name = 'GraphRateLimitError';
  }
}

export class GraphAuthError extends GraphApiError {
  constructor(code: string, detail: string) {
    super(401, code, detail || 'token rejected');
    this.name = 'GraphAuthError';
  }
}

export type GraphToken = string | (() => string | Promise<string>);

export interface TeamsGraphOptions {
  token: GraphToken;
  /** Defaults to the v1.0 endpoint. Requests and next links must stay on this origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Page cap for any one listing (default 50). */
  maxPages?: number;
}

export interface GraphIdentity {
  user?: { id: string; displayName?: string; userIdentityType?: string };
  application?: { id: string; displayName?: string };
}

export interface GraphAttachment {
  id: string;
  contentType: string;
  contentUrl?: string | null;
  name?: string | null;
}

export interface GraphReaction {
  reactionType: string;
  createdDateTime: string;
  user: GraphIdentity;
}

export interface GraphMessage {
  id: string;
  replyToId?: string | null;
  messageType?: string;
  createdDateTime: string;
  lastModifiedDateTime?: string | null;
  deletedDateTime?: string | null;
  webUrl?: string;
  from?: GraphIdentity | null;
  body?: { contentType: 'text' | 'html'; content: string };
  attachments?: GraphAttachment[];
  mentions?: { id: number; mentionText: string; mentioned: GraphIdentity }[];
  reactions?: GraphReaction[];
}

export interface GraphUser {
  id: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
  mail?: string | null;
  /** `Guest` for a guest account, `Member` otherwise. */
  userType?: string | null;
}

export interface GraphTeam {
  id: string;
  displayName?: string | null;
}

export interface GraphChannel {
  id: string;
  displayName?: string | null;
  membershipType?: string;
  webUrl?: string;
}

export interface GraphMember {
  id: string;
  displayName?: string | null;
  userId?: string | null;
  email?: string | null;
  roles: string[];
}

export interface GraphTeamsApp {
  id: string;
  externalId?: string | null;
  displayName?: string | null;
  distributionMethod?: string;
}

export interface GraphInstalledApp {
  id: string;
  teamsApp?: GraphTeamsApp;
  teamsAppDefinition?: { id?: string; teamsAppId?: string; displayName?: string; version?: string };
}

export interface GraphPermissionGrant {
  id: string;
  clientAppId: string;
  permission: string;
  permissionType: string;
  resourceAppId?: string;
}

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string | null;
  lifecycleNotificationUrl?: string | null;
}

export interface CreateSubscriptionInput {
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
  lifecycleNotificationUrl?: string;
  includeResourceData?: boolean;
}

export interface MessageListOptions {
  /** `$top`, 1 to 50 for channel messages. */
  top?: number;
  /** Time floor: only messages modified after this instant (ISO 8601). */
  since?: string;
}

export interface TeamsGraph {
  channelMessages(teamId: string, channelId: string, opts?: MessageListOptions): Promise<GraphMessage[]>;
  channelReplies(teamId: string, channelId: string, messageId: string, opts?: MessageListOptions): Promise<GraphMessage[]>;
  /** One message with its `reactions`; pass `replyId` for a reply. */
  message(teamId: string, channelId: string, messageId: string, replyId?: string): Promise<GraphMessage>;
  hostedContent(teamId: string, channelId: string, messageId: string, hostedContentId: string, replyId?: string): Promise<Uint8Array>;
  /** Downloads a SharePoint file named by an attachment's `contentUrl` (driveItem content). */
  downloadAttachment(contentUrl: string): Promise<Uint8Array>;
  user(aadObjectId: string): Promise<GraphUser>;
  /** The user whose `mail` or `userPrincipalName` is `email`, or undefined. */
  userByEmail(email: string): Promise<GraphUser | undefined>;
  /** Teams of the tenant, or the signed-in user's with `{ joined: true }` (delegated token). */
  teams(opts?: { joined?: boolean }): Promise<GraphTeam[]>;
  channels(teamId: string): Promise<GraphChannel[]>;
  channelMembers(teamId: string, channelId: string): Promise<GraphMember[]>;
  installedApps(teamId: string): Promise<GraphInstalledApp[]>;
  rscGrants(teamId: string): Promise<GraphPermissionGrant[]>;
  catalogApps(opts?: { externalId?: string }): Promise<GraphTeamsApp[]>;
  /** Publishes an app package (zip bytes) to the tenant catalog. */
  publishApp(zip: Uint8Array): Promise<GraphTeamsApp>;
  /** The versions a catalog app holds (`appCatalogs/teamsApps/{id}/appDefinitions`), as the manifests say them. */
  appVersions(teamsAppId: string): Promise<string[]>;
  /** Uploads a new version of a catalog app (`appCatalogs/teamsApps/{id}/appDefinitions`). */
  updateApp(teamsAppId: string, zip: Uint8Array): Promise<void>;
  /** Installs a catalog app in a team; `rscPermissions` are consented at install (team owner). */
  installApp(teamId: string, teamsAppId: string, opts?: { rscPermissions?: string[] }): Promise<void>;
  createSubscription(input: CreateSubscriptionInput): Promise<GraphSubscription>;
  renewSubscription(id: string, expirationDateTime: string): Promise<GraphSubscription>;
  deleteSubscription(id: string): Promise<void>;
  subscriptions(): Promise<GraphSubscription[]>;
}

function parseRetryAfterMs(header: string | null): number {
  if (header === null) return 1000;
  const secs = Number(header);
  return Number.isFinite(secs) ? Math.max(0, Math.round(secs * 1000)) : 1000;
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return { code: '', message: '' };
    const err = (body as Record<string, unknown>)['error'];
    if (typeof err !== 'object' || err === null) return { code: '', message: '' };
    const rec = err as Record<string, unknown>;
    return {
      code: typeof rec['code'] === 'string' ? rec['code'] : '',
      message: typeof rec['message'] === 'string' ? rec['message'] : '',
    };
  } catch {
    return { code: '', message: '' };
  }
}

const seg = encodeURIComponent;
const odataString = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** `u!` plus base64url of the URL: the sharing token Graph's `/shares` takes. */
export function shareToken(url: string): string {
  const b64 = Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
  return `u!${b64}`;
}

interface Page<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

export function createTeamsGraph(options: TeamsGraphOptions): TeamsGraph {
  const base = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const maxPages = options.maxPages ?? 50;

  async function token(): Promise<string> {
    return typeof options.token === 'function' ? options.token() : options.token;
  }

  async function send(
    method: string,
    pathOrUrl: string,
    permission: string,
    init: { body?: string | Uint8Array; contentType?: string; accept?: string } = {},
  ): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${base}${pathOrUrl}`;
    if (new URL(url).origin !== origin) throw new GraphApiError(0, 'ForeignOrigin', 'refusing to send the token off the Graph origin');
    const headers: Record<string, string> = { Authorization: `Bearer ${await token()}`, Accept: init.accept ?? 'application/json' };
    if (init.contentType) headers['Content-Type'] = init.contentType;
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, ...(init.body !== undefined ? { body: init.body as BodyInit } : {}) });
    } catch {
      throw new GraphApiError(0, 'NetworkError', `${method} ${new URL(url).pathname}`);
    }
    if (res.ok) return res;
    if (res.status === 429) throw new GraphRateLimitError(parseRetryAfterMs(res.headers.get('Retry-After')));
    const { code, message } = await readError(res);
    if (res.status === 403) throw new GraphPermissionError(permission, code, message);
    if (res.status === 401) throw new GraphAuthError(code, message);
    throw new GraphApiError(res.status, code, message || `${method} ${new URL(url).pathname}`);
  }

  async function json<T>(method: string, path: string, permission: string, body?: unknown): Promise<T> {
    const res = await send(method, path, permission, body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' });
    return (await res.json()) as T;
  }

  async function list<T>(path: string, permission: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next !== undefined && page < maxPages; page++) {
      const body = (await (await send('GET', next, permission)).json()) as Page<T>;
      out.push(...(body.value ?? []));
      next = body['@odata.nextLink'];
    }
    return out;
  }

  async function bytes(path: string, permission: string): Promise<Uint8Array> {
    const res = await send('GET', path, permission, { accept: '*/*' });
    return new Uint8Array(await res.arrayBuffer());
  }

  function messageQuery(opts: MessageListOptions | undefined): string {
    const q: string[] = [];
    if (opts?.top !== undefined) q.push(`$top=${Math.max(1, Math.floor(opts.top))}`);
    if (opts?.since !== undefined) {
      q.push(`$filter=${encodeURIComponent(`lastModifiedDateTime gt ${opts.since}`)}`);
      q.push(`$orderby=${encodeURIComponent('lastModifiedDateTime desc')}`);
    }
    return q.length > 0 ? `?${q.join('&')}` : '';
  }

  const channelPath = (teamId: string, channelId: string): string => `/teams/${seg(teamId)}/channels/${seg(channelId)}`;
  const messagePath = (teamId: string, channelId: string, messageId: string, replyId?: string): string =>
    `${channelPath(teamId, channelId)}/messages/${seg(messageId)}${replyId ? `/replies/${seg(replyId)}` : ''}`;

  return {
    channelMessages: (teamId, channelId, opts) =>
      list<GraphMessage>(`${channelPath(teamId, channelId)}/messages${messageQuery(opts)}`, GRAPH_PERMISSIONS.history),
    channelReplies: (teamId, channelId, messageId, opts) =>
      list<GraphMessage>(`${messagePath(teamId, channelId, messageId)}/replies${messageQuery(opts)}`, GRAPH_PERMISSIONS.history),
    message: (teamId, channelId, messageId, replyId) =>
      json<GraphMessage>('GET', messagePath(teamId, channelId, messageId, replyId), GRAPH_PERMISSIONS.history),
    hostedContent: (teamId, channelId, messageId, hostedContentId, replyId) =>
      bytes(`${messagePath(teamId, channelId, messageId, replyId)}/hostedContents/${seg(hostedContentId)}/$value`, GRAPH_PERMISSIONS.files),
    downloadAttachment: (contentUrl) => bytes(`/shares/${shareToken(contentUrl)}/driveItem/content`, GRAPH_PERMISSIONS.files),
    user: (id) => json<GraphUser>('GET', `/users/${seg(id)}?$select=id,displayName,userPrincipalName,mail,userType`, GRAPH_PERMISSIONS.user),
    async userByEmail(email) {
      const filter = `mail eq ${odataString(email)} or userPrincipalName eq ${odataString(email)}`;
      const found = await list<GraphUser>(
        `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,userPrincipalName,mail&$top=2`,
        GRAPH_PERMISSIONS.user,
      );
      return found[0];
    },
    teams: (opts) =>
      opts?.joined
        ? list<GraphTeam>('/me/joinedTeams', GRAPH_PERMISSIONS.teams)
        : list<GraphTeam>(
            `/groups?$filter=${encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')")}&$select=id,displayName`,
            GRAPH_PERMISSIONS.teams,
          ),
    channels: (teamId) => list<GraphChannel>(`/teams/${seg(teamId)}/channels`, GRAPH_PERMISSIONS.channels),
    channelMembers: (teamId, channelId) => list<GraphMember>(`${channelPath(teamId, channelId)}/members`, GRAPH_PERMISSIONS.members),
    installedApps: (teamId) =>
      list<GraphInstalledApp>(`/teams/${seg(teamId)}/installedApps?$expand=teamsApp`, GRAPH_PERMISSIONS.installedApps),
    rscGrants: (teamId) => list<GraphPermissionGrant>(`/teams/${seg(teamId)}/permissionGrants`, GRAPH_PERMISSIONS.rscGrants),
    catalogApps: (opts) => {
      const filter = opts?.externalId ? `externalId eq ${odataString(opts.externalId)}` : "distributionMethod eq 'organization'";
      return list<GraphTeamsApp>(`/appCatalogs/teamsApps?$filter=${encodeURIComponent(filter)}`, GRAPH_PERMISSIONS.catalogRead);
    },
    async publishApp(zip) {
      const res = await send('POST', '/appCatalogs/teamsApps', GRAPH_PERMISSIONS.catalogWrite, { body: zip, contentType: 'application/zip' });
      return (await res.json()) as GraphTeamsApp;
    },
    async appVersions(teamsAppId) {
      const defs = await list<{ version?: string | null }>(`/appCatalogs/teamsApps/${seg(teamsAppId)}/appDefinitions`, GRAPH_PERMISSIONS.catalogRead);
      return defs.flatMap((d) => (typeof d.version === 'string' && d.version !== '' ? [d.version] : []));
    },
    async updateApp(teamsAppId, zip) {
      await send('POST', `/appCatalogs/teamsApps/${seg(teamsAppId)}/appDefinitions`, GRAPH_PERMISSIONS.catalogWrite, {
        body: zip,
        contentType: 'application/zip',
      });
    },
    async installApp(teamId, teamsAppId, opts) {
      const body: Record<string, unknown> = { 'teamsApp@odata.bind': `${base}/appCatalogs/teamsApps/${seg(teamsAppId)}` };
      if (opts?.rscPermissions && opts.rscPermissions.length > 0) {
        body['consentedPermissionSet'] = {
          resourceSpecificPermissions: opts.rscPermissions.map((permissionValue) => ({ permissionValue, permissionType: 'Application' })),
        };
      }
      await send('POST', `/teams/${seg(teamId)}/installedApps`, GRAPH_PERMISSIONS.install, {
        body: JSON.stringify(body),
        contentType: 'application/json',
      });
    },
    createSubscription: (input) => json<GraphSubscription>('POST', '/subscriptions', GRAPH_PERMISSIONS.subscriptions, input),
    renewSubscription: (id, expirationDateTime) =>
      json<GraphSubscription>('PATCH', `/subscriptions/${seg(id)}`, GRAPH_PERMISSIONS.subscriptions, { expirationDateTime }),
    async deleteSubscription(id) {
      await send('DELETE', `/subscriptions/${seg(id)}`, GRAPH_PERMISSIONS.subscriptions);
    },
    subscriptions: () => list<GraphSubscription>('/subscriptions', GRAPH_PERMISSIONS.subscriptions),
  };
}
