// Thin typed client over `fetch` for the Bot Framework Connector REST calls Snapwing uses (main 15.2):
// post a card, reply in a channel thread, edit in place, delete, open a personal chat, read a member.
// No botbuilder SDK. The token source is injected (the bot's client-credentials token, or a test
// string); the token travels only in the `Authorization` header and never appears in an error.
// Every call goes to the activity's own `serviceUrl`, which must be https without credentials, and on a
// host `allowServiceUrl` accepts; compose passes `allowTeamsServiceUrl`, the documented Bot Connector hosts.

const DEFAULT_RETRY_AFTER_MS = 1000;

/**
 * The Bot Connector hosts Microsoft documents for Teams service URLs: the public cloud (its regional
 * service URLs, `/teams/`, `/amer/`, `/emea/`, `/apac/`, are paths on this one host), GCC, GCC High, and DoD.
 * The bot token goes to these hosts only, and to the host of a configured `TEAMS_SERVICE_URL`.
 */
export const TEAMS_SERVICE_HOSTS: readonly string[] = Object.freeze([
  'smba.trafficmanager.net',
  'smba.infra.gcc.teams.microsoft.com',
  'smba.infra.gov.teams.microsoft.us',
  'smba.infra.dod.teams.microsoft.us',
]);

/** True for an https URL on the default port whose host is exactly one of `hosts` (lower-cased). */
export function onTeamsServiceHost(url: URL, hosts: ReadonlySet<string>): boolean {
  return url.protocol === 'https:' && url.port === '' && hosts.has(url.hostname.toLowerCase());
}

/** The exact host allowlist: {@link TEAMS_SERVICE_HOSTS} plus `extra` (a configured service URL's host). */
export function teamsServiceHosts(extra: readonly string[] = []): ReadonlySet<string> {
  return new Set([...TEAMS_SERVICE_HOSTS, ...extra].map((h) => h.trim().toLowerCase()).filter((h) => h !== ''));
}

/** `allowServiceUrl` over {@link teamsServiceHosts}: nothing but an exact documented (or configured) host. */
export function allowTeamsServiceUrl(extra: readonly string[] = []): (url: URL) => boolean {
  const hosts = teamsServiceHosts(extra);
  return (url) => onTeamsServiceHost(url, hosts);
}

export class TeamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsError';
  }
}

/** Any HTTP status that is not 2xx and has no more specific class below. */
export class TeamsApiError extends TeamsError {
  readonly status: number;
  readonly code: string;
  readonly operation: string;

  constructor(operation: string, status: number, code: string, message?: string) {
    super(message ?? `teams ${operation} failed: ${status} ${code}`);
    this.name = 'TeamsApiError';
    this.status = status;
    this.code = code;
    this.operation = operation;
  }
}

/** HTTP 429. The caller pauses for `retryAfterMs`. */
export class TeamsRateLimitError extends TeamsApiError {
  readonly retryAfterMs: number;

  constructor(operation: string, code: string, retryAfterMs: number) {
    super(operation, 429, code, `teams rate limited ${operation}; retry after ${retryAfterMs} ms`);
    this.name = 'TeamsRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP 404: the activity was deleted (or never existed), or the conversation is gone. */
export class TeamsNotFoundError extends TeamsApiError {
  constructor(operation: string, code: string) {
    super(operation, 404, code, `teams ${operation}: not found (${code}); the activity or conversation no longer exists`);
    this.name = 'TeamsNotFoundError';
  }
}

/** HTTP 403: the bot is not in the conversation (removed, blocked, or never installed). */
export class TeamsForbiddenError extends TeamsApiError {
  constructor(operation: string, code: string) {
    super(operation, 403, code, `teams ${operation}: forbidden (${code}); the bot is not in the conversation`);
    this.name = 'TeamsForbiddenError';
  }
}

/** The `serviceUrl` is not one the token may be sent to. */
export class TeamsServiceUrlError extends TeamsError {
  constructor(reason: string) {
    super(`teams serviceUrl refused: ${reason}`);
    this.name = 'TeamsServiceUrlError';
  }
}

export interface TeamsChannelAccount {
  id: string;
  name?: string;
  aadObjectId?: string;
  email?: string;
  userPrincipalName?: string;
  tenantId?: string;
  givenName?: string;
  surname?: string;
}

/** A Bot Framework activity as Snapwing sends it; extra fields (attachments, entities) pass through. */
export interface TeamsOutgoingActivity {
  type: 'message' | (string & {});
  text?: string;
  attachments?: unknown[];
  entities?: unknown[];
  [extra: string]: unknown;
}

export interface TeamsResourceResponse {
  id: string;
}

export interface TeamsConversationRef {
  /** The `serviceUrl` of the activity being answered. */
  serviceUrl: string;
  conversationId: string;
}

export interface TeamsActivityRef extends TeamsConversationRef {
  activityId: string;
}

export interface ReplyToActivityArgs extends TeamsActivityRef {
  /**
   * The root message of a channel thread. The reply goes through `<conversationId>;messageid=<rootId>`
   * so it lands in the thread; `activityId` is then the message being answered (often the root itself).
   */
  threadRootId?: string;
}

export interface CreatePersonalConversationArgs {
  serviceUrl: string;
  tenantId: string;
  aadObjectId: string;
  /** The user's Teams id (`29:...`) from an inbound activity's `from.id`; preferred in `members[].id` when given. */
  userId?: string;
  /** The bot's app id for this call; defaults to the connector's `botId`. */
  botId?: string;
}

export interface GetMemberArgs extends TeamsConversationRef {
  /** The member's Teams id (`29:...`) or AAD object id. */
  memberId: string;
}

export interface TeamsPersonalConversation {
  id: string;
  /** Present when the call also posted an activity. */
  activityId?: string;
  serviceUrl?: string;
}

export interface TeamsConnector {
  sendToConversation(ref: TeamsConversationRef, activity: TeamsOutgoingActivity): Promise<TeamsResourceResponse>;
  replyToActivity(args: ReplyToActivityArgs, activity: TeamsOutgoingActivity): Promise<TeamsResourceResponse>;
  /** Edit in place (`updateActivity`); the activity keeps its id. */
  updateActivity(ref: TeamsActivityRef, activity: TeamsOutgoingActivity): Promise<TeamsResourceResponse>;
  deleteActivity(ref: TeamsActivityRef): Promise<void>;
  /** Opens (or finds) the bot's 1:1 chat with a person; `id` is the conversation to post to. */
  createPersonalConversation(args: CreatePersonalConversationArgs): Promise<TeamsPersonalConversation>;
  getMember(args: GetMemberArgs): Promise<TeamsChannelAccount>;
}

export interface TeamsConnectorOptions {
  /** Resolved on every call, so a refreshing token source works. The value is never logged or put in an error. */
  token: () => Promise<string>;
  /** The bot's app id, sent as `bot.id` when opening a personal conversation. */
  botId?: string;
  /** Extra check on a `serviceUrl` (`allowTeamsServiceUrl` in compose); https and no credentials are always required. */
  allowServiceUrl?: (url: URL) => boolean;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

function parseRetryAfterMs(header: string | null, now: number): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return DEFAULT_RETRY_AFTER_MS;
}

/** The Connector's error envelope is `{ error: { code, message } }`; the message is never copied out. */
function errorCode(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null) {
      const code = (error as Record<string, unknown>)['code'];
      if (typeof code === 'string' && code !== '') return code.replace(/[^\w.-]/g, '_').slice(0, 80);
    }
  }
  return `http_${status}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function createTeamsConnector(options: TeamsConnectorOptions): TeamsConnector {
  // Resolved per call so a fetch patched after construction (MSW, instrumentation) is honored.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const seg = encodeURIComponent;

  function base(serviceUrl: string): string {
    let url: URL;
    try {
      url = new URL(serviceUrl);
    } catch {
      throw new TeamsServiceUrlError('not a URL');
    }
    if (url.protocol !== 'https:') throw new TeamsServiceUrlError('must be https');
    if (url.username !== '' || url.password !== '') throw new TeamsServiceUrlError('must not carry credentials');
    if (options.allowServiceUrl !== undefined && !options.allowServiceUrl(url)) {
      throw new TeamsServiceUrlError('host not allowed');
    }
    return `${url.origin}${url.pathname.replace(/\/?$/, '/')}v3/`;
  }

  async function call(
    operation: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await options.token();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch {
      // The underlying message is dropped: it is not ours to vouch for, and the header is ours to protect.
      throw new TeamsApiError(operation, 0, 'network_error', `teams ${operation} failed: network error`);
    }
    const text = await res.text();
    let parsed: unknown;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (res.ok) {
      if (text !== '' && parsed === undefined) throw new TeamsApiError(operation, res.status, 'invalid_json');
      return parsed;
    }
    const code = errorCode(parsed, res.status);
    if (res.status === 429) {
      throw new TeamsRateLimitError(operation, code, parseRetryAfterMs(res.headers.get('retry-after'), Date.now()));
    }
    if (res.status === 404) throw new TeamsNotFoundError(operation, code);
    if (res.status === 403) throw new TeamsForbiddenError(operation, code);
    throw new TeamsApiError(operation, res.status, code);
  }

  function idOf(operation: string, value: unknown): string {
    const id = asRecord(value)['id'];
    if (typeof id !== 'string' || id === '') throw new TeamsApiError(operation, 200, 'missing_id');
    return id;
  }

  return {
    async sendToConversation(ref, activity) {
      const url = `${base(ref.serviceUrl)}conversations/${seg(ref.conversationId)}/activities`;
      return { id: idOf('sendToConversation', await call('sendToConversation', 'POST', url, activity)) };
    },

    async replyToActivity(args, activity) {
      const conversation =
        args.threadRootId === undefined
          ? seg(args.conversationId)
          : `${seg(args.conversationId.split(';')[0] ?? args.conversationId)};messageid=${seg(args.threadRootId)}`;
      const url = `${base(args.serviceUrl)}conversations/${conversation}/activities/${seg(args.activityId)}`;
      const out = await call('replyToActivity', 'POST', url, { ...activity, replyToId: args.activityId });
      return { id: idOf('replyToActivity', out) };
    },

    async updateActivity(ref, activity) {
      const url = `${base(ref.serviceUrl)}conversations/${seg(ref.conversationId)}/activities/${seg(ref.activityId)}`;
      const out = await call('updateActivity', 'PUT', url, { ...activity, id: ref.activityId });
      return { id: idOf('updateActivity', out) };
    },

    async deleteActivity(ref) {
      const url = `${base(ref.serviceUrl)}conversations/${seg(ref.conversationId)}/activities/${seg(ref.activityId)}`;
      await call('deleteActivity', 'DELETE', url);
    },

    async createPersonalConversation(args) {
      const body: Record<string, unknown> = {
        isGroup: false,
        members: [{ id: args.userId ?? args.aadObjectId, aadObjectId: args.aadObjectId }],
        tenantId: args.tenantId,
        channelData: { tenant: { id: args.tenantId } },
      };
      const botId = args.botId ?? options.botId;
      if (botId !== undefined) body['bot'] = { id: botId };
      const out = await call('createPersonalConversation', 'POST', `${base(args.serviceUrl)}conversations`, body);
      const record = asRecord(out);
      const result: TeamsPersonalConversation = { id: idOf('createPersonalConversation', record) };
      if (typeof record['activityId'] === 'string') result.activityId = record['activityId'];
      if (typeof record['serviceUrl'] === 'string') result.serviceUrl = record['serviceUrl'];
      return result;
    },

    async getMember(args) {
      const url = `${base(args.serviceUrl)}conversations/${seg(args.conversationId)}/members/${seg(args.memberId)}`;
      const record = asRecord(await call('getMember', 'GET', url));
      const member: TeamsChannelAccount = { id: idOf('getMember', record) };
      for (const key of ['name', 'aadObjectId', 'email', 'userPrincipalName', 'tenantId', 'givenName', 'surname'] as const) {
        const value = record[key];
        if (typeof value === 'string') member[key] = value;
      }
      return member;
    },
  };
}
