// The Slack IngestionAdapter (main 14.1, 15.1). It authenticates and normalizes through the functions
// of #127, acknowledges with an ephemeral "On it, pulling context", and posts cards and the status
// message through the Web API client of #128 using the Block Kit builders of #129.
//
// Inbound requests reach the adapter as a `SlackInbound`: an HTTP request (headers plus the exact
// signed body) or a Socket Mode payload (already authenticated by the socket the app token opened).
// The transport layer (`transport.ts`) parses nothing itself; it asks the adapter, which parses and
// normalizes once per request and caches the result so `authenticateRequest`, `normalizePayload`, and
// the transport's own check agree on one `eventId`.

import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { verifySlackSignature } from './auth.ts';
import { normalizeSlack, type SlackIgnoreReason, type SlackNormalizeResult } from './normalize.ts';
import { buildCard, type CardOptions } from './cards/cards.ts';
import { buildStatusMessage } from './cards/status.ts';
import { anchorTsOf } from './reader.ts';
import type { SlackWeb } from './web.ts';

export const ACK_TEXT = 'On it, pulling context';

/** A request as the adapter sees it. `body` is the exact bytes Slack signed. */
export type SlackInbound =
  | { transport: 'http'; headers: Headers; body: string }
  | { transport: 'socket'; payload: unknown };

/** What the adapter answers the platform with (HTTP status and body; Socket Mode ignores it). */
export interface SlackAck {
  status: number;
  body: string;
}

/** `normalizePayload` was called on a request that normalizes to nothing (check `normalizeResult` first). */
export class SlackIgnoredError extends Error {
  override readonly name = 'SlackIgnoredError';
  constructor(readonly reason: SlackIgnoreReason) {
    super(`slack payload ignored: ${reason}`);
  }
}

/** Where the pinned status message lives, so the next update edits it (B 3 `status_msg_id`). */
export interface SlackStatusStore {
  get(incidentId: string): Promise<{ channel: string; ts: string } | undefined>;
  set(incidentId: string, ref: { channel: string; ts: string }): Promise<void>;
}

export interface SlackAdapterOptions {
  web: SlackWeb;
  signingSecret: string;
  /** The bot's own user id (`auth.test`); its reactions and messages are ignored. */
  botUserId: string;
  /** The current workspace map; read per request so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  workspaceDomain?: string;
  /** Per-card viewer options (who sees `Fix it`, who may merge). Default: none. */
  cardOptions?: (payload: CanonicalIncidentPayload, card: InteractiveCard) => CardOptions | Promise<CardOptions>;
  statusStore?: SlackStatusStore;
  /** Errors from work that runs after the acknowledgement (the ephemeral post). */
  onError?: (error: unknown) => void;
  clock?: () => Date;
  newEventId?: (nowMs: number) => string;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

/** Parses an interactivity form body (`payload=<json>`) or a JSON body. Undefined when it is neither. */
export function parseSlackBody(body: string): unknown {
  try {
    if (body.startsWith('payload=')) {
      const payload = new URLSearchParams(body).get('payload');
      return payload === null ? undefined : (JSON.parse(payload) as unknown);
    }
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The parsed body of a request, or undefined when it cannot be parsed. */
export function parsedBodyOf(raw: SlackInbound): unknown {
  return raw.transport === 'socket' ? raw.payload : parseSlackBody(raw.body);
}

export interface SlackAdapter extends IngestionAdapter<SlackInbound, SlackAck> {
  readonly channelSource: 'slack';
  /** Normalizes once per request (cached); a payload that starts nothing is `ignored`. */
  normalizeResult(raw: SlackInbound): Promise<SlackNormalizeResult>;
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  const { web } = options;
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const results = new WeakMap<object, Promise<SlackNormalizeResult>>();

  /** The thread a reply goes to: the anchor's thread, or none in a direct message. */
  const threadFor = (payload: CanonicalIncidentPayload): string | undefined => {
    if (payload.context.rawPayloadSnapshot['type'] === 'message.im') return undefined;
    return payload.context.threadId ?? anchorTsOf(payload);
  };
  const withThread = (payload: CanonicalIncidentPayload): { thread_ts?: string } => {
    const ts = threadFor(payload);
    return ts === undefined ? {} : { thread_ts: ts };
  };

  async function reactionsGet(channel: string, ts: string) {
    const [reactions, anchor] = await Promise.all([
      web.reactionsGet(channel, ts),
      // `reactions.get` through the client returns only the reactions; the anchor text and thread come from history.
      web
        .conversationsHistory({ channel, latest: ts, oldest: ts, inclusive: true, limit: 1 })
        .then((page) => page.messages.find((m) => m.ts === ts))
        .catch(() => undefined),
    ]);
    return {
      ...(anchor?.text === undefined ? {} : { text: anchor.text }),
      ...(anchor?.thread_ts === undefined ? {} : { threadTs: anchor.thread_ts }),
      reactions: reactions.map((r) => ({ name: r.name, users: r.users ?? [] })),
    };
  }

  function normalizeResult(raw: SlackInbound): Promise<SlackNormalizeResult> {
    const cached = results.get(raw);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<SlackNormalizeResult> => {
      const parsed = parsedBodyOf(raw);
      if (parsed === undefined) return { kind: 'ignored', reason: 'unsupported-payload' };
      return normalizeSlack(parsed, {
        map: await options.getMap(),
        botUserId: options.botUserId,
        reactionsGet,
        ...(options.workspaceDomain === undefined ? {} : { workspaceDomain: options.workspaceDomain }),
        ...(options.newEventId === undefined ? {} : { newEventId: options.newEventId }),
      });
    })();
    results.set(raw, pending);
    return pending;
  }

  return {
    channelSource: 'slack',
    normalizeResult,

    authenticateRequest(raw) {
      // A Socket Mode payload arrives on a connection opened with the app token; nothing is signed.
      if (raw.transport === 'socket') return Promise.resolve(true);
      return Promise.resolve(verifySlackSignature(raw.body, raw.headers, options.signingSecret, clock()));
    },

    async normalizePayload(raw) {
      const result = await normalizeResult(raw);
      if (result.kind === 'ignored') throw new SlackIgnoredError(result.reason);
      return result.payload;
    },

    acknowledge(_raw, payload) {
      // Not awaited: the platform's 3 s budget never waits on a Web API call.
      void web
        .postEphemeral({
          channel: payload.context.channelId,
          user: payload.reporter.id,
          text: ACK_TEXT,
          ...withThread(payload),
        })
        .catch(onError);
      return Promise.resolve({ status: 200, body: '' });
    },

    async postInteractive(payload, card) {
      const viewer = options.cardOptions === undefined ? {} : await options.cardOptions(payload, card);
      const message = buildCard(payload.eventId, card, viewer);
      await web.postMessage({
        channel: payload.context.channelId,
        text: message.text,
        blocks: message.blocks,
        ...withThread(payload),
      });
    },

    async postStatus(payload, status: StatusUpdate) {
      const message = buildStatusMessage(payload.eventId, status);
      const body = { text: message.text, blocks: message.blocks };
      const known = await options.statusStore?.get(payload.eventId);
      if (known !== undefined) {
        await web.updateMessage({ channel: known.channel, ts: known.ts, ...body });
        return;
      }
      const posted = await web.postMessage({ channel: payload.context.channelId, ...body, ...withThread(payload) });
      await web.pinsAdd(posted.channel, posted.ts).catch(onError);
      await options.statusStore?.set(payload.eventId, { channel: posted.channel, ts: posted.ts });
    },
  };
}

/** The `type` of a parsed Slack payload, or ''. */
export function slackPayloadType(parsed: unknown): string {
  const t = asRec(parsed)['type'];
  return typeof t === 'string' ? t : '';
}
