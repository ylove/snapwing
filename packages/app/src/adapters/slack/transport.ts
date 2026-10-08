// Slack transports (main 14.1, 15.1, ADR 0016): HTTP handlers for the Events API and interactivity,
// and a Socket Mode client, both feeding one dispatcher. The dispatcher only authenticates,
// normalizes, and calls `handleInbound`, so every request is answered inside Slack's 3 s budget; the
// slow work is a queued job behind `handleInbound`, and the "On it" reply is posted after the answer.
//
// - HTTP: `POST /slack/events`, `POST /slack/interactivity`, and `POST /slack/commands` (a `Route` each; `await req.text()` is
//   the exact signed body). `url_verification` is answered with the challenge once the signature checks.
// - Socket Mode: `apps.connections.open` with `SLACK_APP_TOKEN`, then a WebSocket; each envelope is
//   acknowledged by id before it is dispatched.
// - Interactivity payloads other than the message shortcut (button taps, modals) go to `onAction`.
// - The transport is chosen by `mode` ('http' | 'socket'); Socket Mode is for development (main 14.4).

import type { ChannelSource } from '@snapwing/pipeline/contracts/incident.ts';
import type { Route } from '../../server/http.ts';
import { parsedBodyOf, slackPayloadType, type SlackAdapter, type SlackInbound } from './adapter.ts';
import type { SlackHome } from './home.ts';
import type { SlackStatusQuery } from './status-query.ts';

export const SLACK_EVENTS_PATH = '/slack/events';
export const SLACK_INTERACTIVITY_PATH = '/slack/interactivity';
export const SLACK_COMMANDS_PATH = '/slack/commands';

/** Interactivity payload types that are not the message shortcut: taps, modal submits, other shortcuts. */
const ACTION_TYPES: ReadonlySet<string> = new Set(['block_actions', 'view_submission', 'view_closed', 'interactive_message', 'shortcut']);

export type SlackActionPayload = Readonly<Record<string, unknown>>;

export interface SlackDispatchResult {
  status: number;
  body: string;
  contentType?: string;
}

export interface SlackDispatcher {
  dispatch(raw: SlackInbound): Promise<SlackDispatchResult>;
  /** Resolves when the `onAction` calls started so far have settled (tests, shutdown). */
  idle(): Promise<void>;
}

export interface SlackDispatcherOptions {
  adapter: SlackAdapter;
  /** `IncidentOrchestrator.handleInbound`: authenticate, normalize, dedupe, enqueue, acknowledge. */
  handleInbound: (source: ChannelSource, raw: unknown) => Promise<unknown>;
  /** Button taps and other interactivity (the interactivity issue implements it). Not awaited by the answer. */
  onAction: (payload: SlackActionPayload) => Promise<void> | void;
  /**
   * Status pull (A 4.3): mentions, status-shaped DMs, and `/status` are answered by this and
   * never reach `handleInbound`. Absent, they are ignored or captured as before.
   */
  status?: SlackStatusQuery;
  /**
   * App Home (main 20.2): `app_home_opened` publishes the user's Home view, and a tap in the view
   * (after `onAction` ran) publishes it again so it shows the result. Absent, the event is ignored.
   */
  home?: SlackHome;
  onError?: (error: unknown) => void;
}

/** The user who tapped a button in their App Home, else undefined. */
function homeTapUser(payload: SlackActionPayload): string | undefined {
  const container = payload['container'];
  const inView = typeof container === 'object' && container !== null && (container as Record<string, unknown>)['type'] === 'view';
  const user = payload['user'];
  const id = typeof user === 'object' && user !== null ? (user as Record<string, unknown>)['id'] : undefined;
  return payload['type'] === 'block_actions' && inView && typeof id === 'string' && id !== '' ? id : undefined;
}

const empty = (status: number): SlackDispatchResult => ({ status, body: '' });

export function createSlackDispatcher(options: SlackDispatcherOptions): SlackDispatcher {
  const { adapter } = options;
  const onError = options.onError ?? (() => undefined);
  const inFlight = new Set<Promise<void>>();

  function runAction(work: () => Promise<void> | void): void {
    const task = Promise.resolve()
      .then(work)
      .catch(onError)
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

  return {
    async dispatch(raw) {
      // A slash command is a form body (HTTP) or a bare payload (Socket Mode), not a JSON event.
      const command = options.status?.commandOf(raw);
      if (command !== undefined && options.status !== undefined) {
        if (!(await adapter.authenticateRequest(raw))) return empty(401);
        const status = options.status;
        runAction(() => status.handleCommand(command));
        return empty(200);
      }
      const parsed = parsedBodyOf(raw);
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return empty(400);
      if (!(await adapter.authenticateRequest(raw))) return empty(401);
      const type = slackPayloadType(parsed);

      if (type === 'url_verification') {
        const challenge = (parsed as Record<string, unknown>)['challenge'];
        return {
          status: 200,
          body: JSON.stringify({ challenge: typeof challenge === 'string' ? challenge : '' }),
          contentType: 'application/json',
        };
      }
      if (ACTION_TYPES.has(type)) {
        const payload = parsed as SlackActionPayload;
        const home = options.home;
        const homeUser = home === undefined ? undefined : homeTapUser(payload);
        runAction(async () => {
          await options.onAction(payload);
          if (home !== undefined && homeUser !== undefined) await home.publishFor(homeUser);
        });
        return empty(200);
      }
      if (type === 'event_callback' && options.home?.intercepts(parsed) === true) {
        const home = options.home;
        runAction(() => home.handleEvent(parsed));
        return empty(200);
      }
      if (type === 'event_callback' && options.status?.intercepts(parsed) === true) {
        const status = options.status;
        runAction(() => status.handleEvent(parsed));
        return empty(200);
      }
      try {
        const result = await adapter.normalizeResult(raw);
        if (result.kind === 'ignored') return empty(200);
        await options.handleInbound('slack', raw);
        return empty(200);
      } catch (e) {
        onError(e);
        // Slack retries a failed delivery; the idempotency key makes the retry safe.
        return empty(500);
      }
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

function toResponse(r: SlackDispatchResult): Response {
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.contentType ?? 'text/plain; charset=utf-8' } });
}

/** The two HTTP routes. The handler reads the body as text, which is exactly what Slack signed. */
export function createSlackRoutes(dispatcher: SlackDispatcher): Route[] {
  const handler = async (req: Request): Promise<Response> =>
    toResponse(await dispatcher.dispatch({ transport: 'http', headers: req.headers, body: await req.text() }));
  return [
    { method: 'POST', path: SLACK_EVENTS_PATH, handler },
    { method: 'POST', path: SLACK_INTERACTIVITY_PATH, handler },
    { method: 'POST', path: SLACK_COMMANDS_PATH, handler },
  ];
}

// Socket Mode -------------------------------------------------------------------------------------

/** The slice of the WebSocket API the client uses (the global `WebSocket` satisfies it). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error' | 'open', listener: (event: unknown) => void): void;
}

export interface SocketModeOptions {
  /** `SLACK_APP_TOKEN` (`xapp-...`). */
  appToken: string;
  dispatcher: SlackDispatcher;
  fetch?: typeof fetch;
  /** Defaults to the global `WebSocket`. */
  openSocket?: (url: string) => SocketLike;
  /** Defaults to `https://slack.com/api/`. */
  baseUrl?: string;
  /** First reconnect delay; doubles to `maxReconnectDelayMs`. Default 1000. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onError?: (error: unknown) => void;
}

export interface SocketModeClient {
  /** Opens the connection; resolves once the socket is open. Reconnects on its own after that. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSocketModeClient(options: SocketModeOptions): SocketModeClient {
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const base = (options.baseUrl ?? 'https://slack.com/api/').replace(/\/?$/, '/');
  const onError = options.onError ?? (() => undefined);
  const firstDelay = options.reconnectDelayMs ?? 1000;
  const maxDelay = options.maxReconnectDelayMs ?? 30_000;
  let socket: SocketLike | undefined;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = firstDelay;

  async function connectionUrl(): Promise<string> {
    const res = await doFetch(`${base}apps.connections.open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
    if (body.ok !== true || typeof body.url !== 'string') throw new Error(`slack apps.connections.open failed: ${body.error ?? `http_${res.status}`}`);
    return body.url;
  }

  function handleMessage(ws: SocketLike, data: unknown): void {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = envelope['type'];
    if (type === 'hello') {
      delay = firstDelay;
      return;
    }
    if (type === 'disconnect') {
      ws.close();
      return;
    }
    const id = envelope['envelope_id'];
    // Acknowledge first: Slack redelivers an envelope that is not acknowledged within 3 s.
    if (typeof id === 'string') ws.send(JSON.stringify({ envelope_id: id }));
    if (type !== 'events_api' && type !== 'interactive' && type !== 'slash_commands') return;
    void options.dispatcher.dispatch({ transport: 'socket', payload: envelope['payload'] }).catch(onError);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      connect().catch((e: unknown) => {
        onError(e);
        scheduleReconnect();
      });
    }, delay);
    delay = Math.min(delay * 2, maxDelay);
  }

  async function connect(): Promise<void> {
    const ws = openSocket(await connectionUrl());
    socket = ws;
    ws.addEventListener('message', (event) => handleMessage(ws, event.data));
    ws.addEventListener('error', onError);
    ws.addEventListener('close', () => {
      if (socket === ws) socket = undefined;
      scheduleReconnect();
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(e instanceof Error ? e : new Error('slack socket error')));
    });
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      try {
        await connect();
      } catch (e) {
        stopped = true;
        throw e;
      }
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      socket?.close();
      socket = undefined;
      await options.dispatcher.idle();
    },
  };
}

// Transport choice --------------------------------------------------------------------------------

export type SlackTransportOptions = SlackDispatcherOptions &
  (
    | { mode: 'http' }
    | { mode: 'socket'; appToken: string; fetch?: typeof fetch; openSocket?: (url: string) => SocketLike; reconnectDelayMs?: number }
  );

export interface SlackTransport {
  readonly dispatcher: SlackDispatcher;
  /** HTTP routes to mount on the API process; empty in Socket Mode. */
  readonly routes: readonly Route[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Builds the dispatcher and the transport the config chose. Both transports share the dispatcher. */
export function createSlackTransport(options: SlackTransportOptions): SlackTransport {
  const dispatcher = createSlackDispatcher(options);
  if (options.mode === 'http') {
    return { dispatcher, routes: createSlackRoutes(dispatcher), start: () => Promise.resolve(), stop: () => dispatcher.idle() };
  }
  if (options.appToken === '') throw new Error('slack socket mode needs SLACK_APP_TOKEN');
  const client = createSocketModeClient({
    appToken: options.appToken,
    dispatcher,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.openSocket === undefined ? {} : { openSocket: options.openSocket }),
    ...(options.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: options.reconnectDelayMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { dispatcher, routes: [], start: () => client.start(), stop: () => client.stop() };
}
