// Thin typed client over `fetch` for the Slack Web API methods Snapwing uses (main 15.1).
// The bot token travels only in the `Authorization` header, never in a URL or body, and never in an
// error message. Slack's `ok: false` becomes `SlackApiError`; HTTP 429 becomes `SlackRateLimitError`.

const DEFAULT_BASE_URL = 'https://slack.com/api/';
const DEFAULT_RETRY_AFTER_MS = 1000;

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackError';
  }
}

/** Slack answered `{ ok: false, error }`, or an HTTP status that is not 2xx or 429. */
export class SlackApiError extends SlackError {
  readonly error: string;
  readonly method: string;

  constructor(method: string, error: string) {
    super(`slack ${method} failed: ${error}`);
    this.name = 'SlackApiError';
    this.error = error;
    this.method = method;
  }
}

/** HTTP 429. The caller pauses for `retryAfterMs`. */
export class SlackRateLimitError extends SlackError {
  readonly retryAfterMs: number;
  readonly method: string;

  constructor(method: string, retryAfterMs: number) {
    super(`slack rate limited ${method}; retry after ${retryAfterMs} ms`);
    this.name = 'SlackRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.method = method;
  }
}

/** The bot is not in a private channel (or cannot join): the caller turns this into an invite request. */
export class SlackNotInvitedError extends SlackError {
  readonly channelId: string;

  constructor(channelId: string) {
    super(`the bot is not a member of channel ${channelId} and cannot join it; an invite is needed`);
    this.name = 'SlackNotInvitedError';
    this.channelId = channelId;
  }
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackReaction {
  name: string;
  count?: number;
  users?: string[];
}

export interface SlackLinkAttachment {
  from_url?: string;
  title_link?: string;
  original_url?: string;
  title?: string;
  text?: string;
  fallback?: string;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
  files?: SlackFile[];
  attachments?: SlackLinkAttachment[];
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { email?: string; display_name?: string; real_name?: string };
}

export interface SlackPage {
  /** Slack's `response_metadata.next_cursor`; absent on the last page. */
  nextCursor?: string;
}

export interface PostMessageArgs {
  channel: string;
  text?: string;
  blocks?: unknown[];
  thread_ts?: string;
  unfurl_links?: boolean;
  [extra: string]: unknown;
}

export interface UpdateMessageArgs {
  channel: string;
  ts: string;
  text?: string;
  blocks?: unknown[];
  [extra: string]: unknown;
}

export interface PostEphemeralArgs {
  channel: string;
  user: string;
  text?: string;
  blocks?: unknown[];
  thread_ts?: string;
  [extra: string]: unknown;
}

export interface HistoryArgs {
  channel: string;
  /** Slack ts, seconds with microseconds. */
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
  limit?: number;
  cursor?: string;
}

export interface RepliesArgs extends HistoryArgs {
  ts: string;
}

export interface MessagesPage extends SlackPage {
  messages: SlackMessage[];
}

export interface ReactionsGetResult {
  reactions: SlackReaction[];
  /** The message `reactions.get` returned; absent when Slack sent none. */
  message?: SlackMessage;
}

export interface DownloadedFile {
  bytes: Uint8Array;
  /** The response `Content-Type` without parameters, lowercased; empty when absent. */
  contentType: string;
}

export interface SlackWeb {
  postMessage(args: PostMessageArgs): Promise<{ channel: string; ts: string }>;
  updateMessage(args: UpdateMessageArgs): Promise<{ channel: string; ts: string }>;
  postEphemeral(args: PostEphemeralArgs): Promise<{ messageTs?: string }>;
  /** `views.publish`: sets a user's App Home tab (`view` is `{ type: 'home', blocks }`). */
  viewsPublish(args: { userId: string; view: { type: 'home'; blocks: readonly unknown[] } }): Promise<void>;
  pinsAdd(channel: string, timestamp: string): Promise<void>;
  reactionsAdd(channel: string, timestamp: string, name: string): Promise<void>;
  /** The reactions on one message, with the reactors, and the message Slack sends with them (text, ts, thread_ts, files). */
  reactionsGet(channel: string, timestamp: string): Promise<ReactionsGetResult>;
  conversationsHistory(args: HistoryArgs): Promise<MessagesPage>;
  conversationsReplies(args: RepliesArgs): Promise<MessagesPage>;
  conversationsJoin(channel: string): Promise<void>;
  usersInfo(user: string): Promise<SlackUser>;
  usersList(args?: { cursor?: string; limit?: number }): Promise<SlackPage & { members: SlackUser[] }>;
  /** GET a `url_private_download` with the bot token in the `Authorization` header. */
  downloadFile(url: string): Promise<DownloadedFile>;
}

export interface SlackWebOptions {
  /** The bot token (`SLACK_BOT_TOKEN`). */
  token: string;
  /** Defaults to `https://slack.com/api/`. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

type Params = Record<string, string | number | boolean | undefined>;

function parseRetryAfterMs(header: string | null): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : DEFAULT_RETRY_AFTER_MS;
}

/** Hosts that may receive the bot token on a file download. */
function isSlackFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

export function createSlackWeb(options: SlackWebOptions): SlackWeb {
  // Resolved per call so a fetch patched after construction (MSW, instrumentation) is honored.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, '/');
  const authorization = `Bearer ${options.token}`;

  async function request(method: string, init: RequestInit, url: string): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), authorization };
    const res = await doFetch(url, { ...init, headers });
    if (res.status === 429) throw new SlackRateLimitError(method, parseRetryAfterMs(res.headers.get('retry-after')));
    return res;
  }

  async function parse(method: string, res: Response): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SlackApiError(method, res.ok ? 'invalid_json' : `http_${res.status}`);
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (record['ok'] !== true) {
      const error = typeof record['error'] === 'string' ? record['error'] : res.ok ? 'unknown_error' : `http_${res.status}`;
      throw new SlackApiError(method, error);
    }
    return record;
  }

  /** Write methods: a JSON body. */
  async function post(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await request(
      method,
      { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) },
      `${base}${method}`,
    );
    return parse(method, res);
  }

  /** Read methods: query parameters (Slack read methods do not take JSON). The token stays in the header. */
  async function get(method: string, params: Params): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const qs = query.toString();
    const res = await request(method, { method: 'GET' }, `${base}${method}${qs === '' ? '' : `?${qs}`}`);
    return parse(method, res);
  }

  function nextCursor(record: Record<string, unknown>): string | undefined {
    const meta = record['response_metadata'];
    if (typeof meta !== 'object' || meta === null) return undefined;
    const cursor = (meta as Record<string, unknown>)['next_cursor'];
    return typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
  }

  function messagesPage(record: Record<string, unknown>): MessagesPage {
    const messages = Array.isArray(record['messages']) ? (record['messages'] as SlackMessage[]) : [];
    const cursor = nextCursor(record);
    return cursor === undefined ? { messages } : { messages, nextCursor: cursor };
  }

  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  return {
    async postMessage(args) {
      const r = await post('chat.postMessage', args);
      return { channel: str(r['channel']), ts: str(r['ts']) };
    },
    async updateMessage(args) {
      const r = await post('chat.update', args);
      return { channel: str(r['channel']), ts: str(r['ts']) };
    },
    async postEphemeral(args) {
      const r = await post('chat.postEphemeral', args);
      const ts = str(r['message_ts']);
      return ts === '' ? {} : { messageTs: ts };
    },
    async viewsPublish(args) {
      await post('views.publish', { user_id: args.userId, view: args.view });
    },
    async pinsAdd(channel, timestamp) {
      await post('pins.add', { channel, timestamp });
    },
    async reactionsAdd(channel, timestamp, name) {
      await post('reactions.add', { channel, timestamp, name });
    },
    async reactionsGet(channel, timestamp) {
      const r = await get('reactions.get', { channel, timestamp, full: true });
      const raw = r['message'];
      if (typeof raw !== 'object' || raw === null) return { reactions: [] };
      const message = raw as SlackMessage;
      return { reactions: message.reactions ?? [], message };
    },
    async conversationsHistory(args) {
      return messagesPage(await get('conversations.history', { ...args }));
    },
    async conversationsReplies(args) {
      return messagesPage(await get('conversations.replies', { ...args }));
    },
    async conversationsJoin(channel) {
      await post('conversations.join', { channel });
    },
    async usersInfo(user) {
      const r = await get('users.info', { user });
      return r['user'] as SlackUser;
    },
    async usersList(args = {}) {
      const r = await get('users.list', { ...args });
      const members = Array.isArray(r['members']) ? (r['members'] as SlackUser[]) : [];
      const cursor = nextCursor(r);
      return cursor === undefined ? { members } : { members, nextCursor: cursor };
    },
    async downloadFile(url) {
      if (!isSlackFileUrl(url)) throw new SlackApiError('files.download', 'untrusted_file_host');
      const res = await request('files.download', { method: 'GET' }, url);
      if (!res.ok) throw new SlackApiError('files.download', `http_${res.status}`);
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
    },
  };
}
