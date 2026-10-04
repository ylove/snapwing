// The Teams IngestionAdapter (main 13, 14.1, 15.2; ADR 0019). It authenticates through the Bot Framework
// JWT verifier (#369), normalizes through `normalize.ts`, acknowledges without ephemerals (Teams has none),
// and posts the Adaptive Cards of #372 through the Bot Connector client of #370.
//
// Inbound requests reach the adapter as a `TeamsInbound`: a Bot Framework activity (the Authorization
// header plus the parsed body; the transport, #390, parses once to dispatch by type), or a reaction
// trigger the signals module (#392) found by diffing Graph's `reactions` after a change notification it
// already authenticated by its `clientState`. The adapter normalizes once per inbound (cached), so
// `normalizePayload` and the transport's own check agree on one `eventId`.
//
// Acknowledgement: the action command is answered with the invoke's task message "On it, pulling
// context"; a personal-chat capture with the same line in the personal chat; a reaction trigger with the
// same line in the reactor's personal chat (best effort: Teams opens one only where the app is installed
// for that person). The anchor gets no ✅: Graph's `setReaction` appears to be delegated only (PLAN open
// question 4), so the live tier settles it.
//
// Every authenticated activity refreshes the conversation record in kv `teams-conversation:{channelId}`
// (`conversations.ts`); posts read the serviceUrl from it, so a reaction trigger, which carries none, can
// still be answered. Every card and status message is recorded as `bot-message-posted { platform:
// 'teams' }` with its role (A 1.3) when the adapter has `state`; the record is best effort. A team in
// reduced mode (kv `teams-mode:{teamId}`, ADR 0005) gets the reduced-mode banner on every card.

import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage, roleOfCard, type PostedMessage } from '@snapwing/pipeline/signals/messages.ts';
import { buildCard, type CardOptions } from './cards/cards.ts';
import { card as adaptiveCard, mentionsFromMap, renderText, type AdaptiveCard, type MentionFor } from './cards/elements.ts';
import { buildStatusCard } from './cards/status.ts';
import { TeamsError, TeamsNotFoundError, type TeamsConnector, type TeamsOutgoingActivity } from './connector.ts';
import { conversationFromActivity, readTeamsConversation, readTeamsMode, rememberTeamsConversation } from './conversations.ts';
import { GraphPermissionError, type TeamsGraph } from './graph.ts';
import {
  normalizeTeams,
  teamsSnapshotOf,
  type TeamsIgnoreReason,
  type TeamsNormalizeResult,
  type TeamsReactionTrigger,
  type TeamsUserInfo,
} from './normalize.ts';

export const ACK_TEXT = 'On it, pulling context';
export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

/** Graph user lookups are cached this long (a miss for `USER_MISS_TTL_MS`). */
export const USER_CACHE_TTL_MS = 60 * 60 * 1000;
export const USER_MISS_TTL_MS = 5 * 60 * 1000;

/** A request as the adapter sees it. */
export type TeamsInbound =
  | { transport: 'http'; headers: Headers; activity: unknown }
  | { transport: 'graph'; trigger: TeamsReactionTrigger };

/** The invoke response that answers the action command with a task message. */
export interface TeamsTaskMessage {
  task: { type: 'message'; value: string };
}

/** What the adapter answers the platform with: an HTTP status and, for an invoke, its JSON body. */
export interface TeamsAck {
  status: number;
  body?: TeamsTaskMessage;
}

/**
 * The Bot Framework JWT check (#369's `verifyBotFrameworkJwt` has this shape): issuer, audience (the
 * app id), expiry, signature, and the token's serviceUrl claim against the activity's.
 */
export type TeamsJwtVerifier = (
  authorization: string | null,
  options: { appId: string; serviceUrl: string; channelId?: string },
) => Promise<{ ok: boolean }>;

/** `normalizePayload` was called on an inbound that normalizes to nothing (check `normalizeResult` first). */
export class TeamsIgnoredError extends Error {
  override readonly name = 'TeamsIgnoredError';
  constructor(readonly reason: TeamsIgnoreReason) {
    super(`teams activity ignored: ${reason}`);
  }
}

/** Where an incident's status message lives, so the next update edits it in place (main 15.2). */
export interface TeamsStatusRef {
  channelId: string;
  /** The conversation the activity was posted to (a channel thread is `{channel};messageid={root}`). */
  conversationId: string;
  activityId: string;
}

export interface TeamsStatusStore {
  get(incidentId: string): Promise<TeamsStatusRef | undefined>;
  set(incidentId: string, ref: TeamsStatusRef): Promise<void>;
}

export const teamsStatusKey = (incidentId: string): string => `teams-status:${incidentId}`;

/** The default status store: kv `teams-status:{incidentId}`. */
export function createKvTeamsStatusStore(cache: Pick<CachePort, 'get' | 'set'>): TeamsStatusStore {
  return {
    async get(incidentId) {
      const raw = await cache.get(teamsStatusKey(incidentId));
      if (raw === null) return undefined;
      try {
        const v = JSON.parse(raw) as Partial<TeamsStatusRef>;
        if (typeof v.channelId !== 'string' || typeof v.conversationId !== 'string' || typeof v.activityId !== 'string') return undefined;
        return { channelId: v.channelId, conversationId: v.conversationId, activityId: v.activityId };
      } catch {
        return undefined;
      }
    },
    set: (incidentId, ref) => cache.set(teamsStatusKey(incidentId), JSON.stringify(ref)),
  };
}

export interface TeamsAdapterOptions {
  connector: TeamsConnector;
  /** Graph, for the AAD id to UPN and email lookup (main 15.2). Absent: the map's email only. */
  graph?: Pick<TeamsGraph, 'user'>;
  /** The bot's Microsoft app id: the token's audience, and the id of its own messages. */
  appId: string;
  verify: TeamsJwtVerifier;
  /** kv: conversation records, team modes, and the default status store. */
  cache: CachePort;
  /** The current workspace map; read per inbound so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** The install's tenant, for a reactor's personal chat when no activity named it. */
  tenantId?: string;
  /** The serviceUrl when no activity has named one for a conversation yet. */
  defaultServiceUrl?: string;
  /** The action command's id; default `TEAMS_ACTION_COMMAND_ID`. */
  commandId?: string;
  /** Per-card viewer options (who sees `Fix it`, who may merge). Mentions default to the map's people. */
  cardOptions?: (payload: CanonicalIncidentPayload, card: InteractiveCard) => CardOptions | Promise<CardOptions>;
  /** Default: kv `teams-status:{incidentId}`. */
  statusStore?: TeamsStatusStore;
  /** Records each posted card and status message as `bot-message-posted` (A 1.3). Absent: nothing is recorded. */
  state?: Pick<StatePort, 'read' | 'append'>;
  /** Errors from best-effort work (acknowledgements, records, kv refreshes). */
  onError?: (error: unknown) => void;
  clock?: () => Date;
  newEventId?: (nowMs: number) => string;
}

export interface TeamsAdapter extends IngestionAdapter<TeamsInbound, TeamsAck> {
  readonly channelSource: 'teams';
  /** Normalizes once per inbound (cached); an inbound that starts nothing is `ignored`. */
  normalizeResult(raw: TeamsInbound): Promise<TeamsNormalizeResult>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** An Adaptive Card as a message activity. */
export function cardActivity(card: AdaptiveCard): TeamsOutgoingActivity {
  return { type: 'message', attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: card }] };
}

interface Where {
  serviceUrl: string;
  channelId: string;
  /** A channel incident's thread root; undefined in a chat. */
  rootId?: string;
  teamId?: string;
  tenantId?: string;
}

export function createTeamsAdapter(options: TeamsAdapterOptions): TeamsAdapter {
  const { connector, cache } = options;
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const statusStore = options.statusStore ?? createKvTeamsStatusStore(cache);
  const results = new WeakMap<object, Promise<TeamsNormalizeResult>>();
  const users = new Map<string, { value: TeamsUserInfo | undefined; until: number }>();

  async function userOf(aadObjectId: string): Promise<TeamsUserInfo | undefined> {
    if (options.graph === undefined) return undefined;
    const now = clock().getTime();
    const hit = users.get(aadObjectId);
    if (hit !== undefined && hit.until > now) return hit.value;
    let value: TeamsUserInfo | undefined;
    try {
      const u = await options.graph.user(aadObjectId);
      value = {
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(u.userPrincipalName ? { userPrincipalName: u.userPrincipalName } : {}),
        ...(u.mail ? { mail: u.mail } : {}),
      };
    } catch (err) {
      // No `User.Read.All` is the reduced path, not an error; the map's email stands in.
      if (!(err instanceof GraphPermissionError)) onError(err);
      value = undefined;
    }
    users.set(aadObjectId, { value, until: now + (value === undefined ? USER_MISS_TTL_MS : USER_CACHE_TTL_MS) });
    return value;
  }

  function normalizeResult(raw: TeamsInbound): Promise<TeamsNormalizeResult> {
    const cached = results.get(raw);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<TeamsNormalizeResult> =>
      normalizeTeams(raw.transport === 'graph' ? { kind: 'reaction', trigger: raw.trigger } : { kind: 'activity', activity: raw.activity }, {
        map: await options.getMap(),
        botAppId: options.appId,
        userOf,
        ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
        ...(options.newEventId === undefined ? {} : { newEventId: options.newEventId }),
      }))();
    results.set(raw, pending);
    return pending;
  }

  /** Where to talk back for an incident: the kv record (fresh from the last activity), else the snapshot. */
  async function where(payload: CanonicalIncidentPayload): Promise<Where> {
    const snap = teamsSnapshotOf(payload);
    const record = await readTeamsConversation(cache, snap.channelId).catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    const serviceUrl = record?.serviceUrl ?? snap.serviceUrl ?? options.defaultServiceUrl;
    if (serviceUrl === undefined) throw new TeamsError(`no serviceUrl known for conversation ${snap.channelId}`);
    const teamId = snap.teamId ?? record?.teamId;
    const tenantId = snap.tenantId ?? record?.tenantId ?? options.tenantId;
    const rootId = snap.conversationType === 'channel' ? (snap.threadRootId ?? payload.context.threadId ?? snap.anchorId) : undefined;
    return {
      serviceUrl,
      channelId: snap.channelId,
      ...(rootId === undefined || rootId === '' ? {} : { rootId }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(tenantId === undefined ? {} : { tenantId }),
    };
  }

  async function reduced(at: Where): Promise<boolean> {
    if (at.teamId === undefined) return false;
    try {
      return (await readTeamsMode(cache, at.teamId)) === 'reduced';
    } catch (err) {
      onError(err);
      return false;
    }
  }

  /** Posts in the incident's thread (a channel) or its chat; returns where it landed. */
  async function post(at: Where, activity: TeamsOutgoingActivity): Promise<TeamsStatusRef> {
    if (at.rootId !== undefined) {
      const out = await connector.replyToActivity(
        { serviceUrl: at.serviceUrl, conversationId: at.channelId, activityId: at.rootId, threadRootId: at.rootId },
        activity,
      );
      return { channelId: at.channelId, conversationId: `${at.channelId};messageid=${at.rootId}`, activityId: out.id };
    }
    const out = await connector.sendToConversation({ serviceUrl: at.serviceUrl, conversationId: at.channelId }, activity);
    return { channelId: at.channelId, conversationId: at.channelId, activityId: out.id };
  }

  async function record(incidentId: string, posted: TeamsStatusRef, role: PostedMessage['role']): Promise<void> {
    if (options.state === undefined) return;
    await recordBotMessage(options.state, incidentId, { platform: 'teams', channel: posted.channelId, messageId: posted.activityId, role }, clock).catch(
      onError,
    );
  }

  async function mentions(override: MentionFor | undefined): Promise<MentionFor> {
    return override ?? mentionsFromMap((await options.getMap()).people);
  }

  /** Says "On it" in the reactor's personal chat; Teams opens one only where the app is installed for them. */
  async function ackInPersonalChat(payload: CanonicalIncidentPayload): Promise<void> {
    const at = await where(payload);
    if (at.tenantId === undefined) throw new TeamsError('no tenant known for the personal chat acknowledgement');
    const chat = await connector.createPersonalConversation({ serviceUrl: at.serviceUrl, tenantId: at.tenantId, aadObjectId: payload.reporter.id });
    await connector.sendToConversation({ serviceUrl: chat.serviceUrl ?? at.serviceUrl, conversationId: chat.id }, { type: 'message', text: ACK_TEXT });
  }

  return {
    channelSource: 'teams',
    normalizeResult,

    async authenticateRequest(raw) {
      // A reaction trigger comes from a Graph notification the transport authenticated by its clientState.
      if (raw.transport === 'graph') return true;
      const activity = rec(raw.activity);
      const serviceUrl = str(activity['serviceUrl']);
      if (serviceUrl === '') return false;
      const channelId = str(activity['channelId']);
      const verdict = await options.verify(raw.headers.get('authorization'), {
        appId: options.appId,
        serviceUrl,
        ...(channelId === '' ? {} : { channelId }),
      });
      if (!verdict.ok) return false;
      // Only an authenticated activity may move a conversation's serviceUrl (the token names it).
      try {
        const map = await options.getMap();
        const channel = splitChannel(activity);
        const fallbackTeam = map.channels.find((c) => c.id === channel)?.teamId;
        const recordNow = conversationFromActivity(activity, clock(), fallbackTeam);
        if (recordNow !== undefined) await rememberTeamsConversation(cache, recordNow);
      } catch (err) {
        onError(err);
      }
      return true;
    },

    async normalizePayload(raw) {
      const result = await normalizeResult(raw);
      if (result.kind === 'ignored') throw new TeamsIgnoredError(result.reason);
      return result.payload;
    },

    acknowledge(raw, payload) {
      const snap = teamsSnapshotOf(payload);
      if (snap.type === 'action-command') {
        return Promise.resolve({ status: 200, body: { task: { type: 'message', value: ACK_TEXT } } });
      }
      // Not awaited: Teams' 5 s invoke budget never waits on a Connector call.
      if (snap.type === 'personal-message' && raw.transport === 'http') {
        const serviceUrl = str(rec(raw.activity)['serviceUrl']);
        void connector.sendToConversation({ serviceUrl, conversationId: snap.channelId }, { type: 'message', text: ACK_TEXT }).catch(onError);
      } else if (snap.type === 'reaction') {
        void ackInPersonalChat(payload).catch(onError);
      }
      return Promise.resolve({ status: 200 });
    },

    async postInteractive(payload, card) {
      const at = await where(payload);
      const viewer = options.cardOptions === undefined ? {} : await options.cardOptions(payload, card);
      const built = buildCard(payload.eventId, card, { ...viewer, mentions: await mentions(viewer.mentions), reduced: await reduced(at) });
      const posted = await post(at, cardActivity(built));
      await record(payload.eventId, posted, roleOfCard(card.kind));
    },

    async postStatus(payload, status: StatusUpdate) {
      const at = await where(payload);
      const opts = { mentions: await mentions(undefined), reduced: await reduced(at) };
      if (status.issueKey === '') {
        // A note about an incident with no issue (#305, #360): a plain card in the thread, no stage emoji,
        // never the incident's status message.
        const note = adaptiveCard(status.text, [renderText(status.text, opts.mentions)], [], opts);
        await record(payload.eventId, await post(at, cardActivity(note)), 'other');
        return;
      }
      const activity = cardActivity(buildStatusCard(payload.eventId, status, opts));
      const known = await statusStore.get(payload.eventId);
      if (known !== undefined) {
        try {
          await connector.updateActivity({ serviceUrl: at.serviceUrl, conversationId: known.conversationId, activityId: known.activityId }, activity);
          return;
        } catch (err) {
          // Someone deleted the status message: post a new one below.
          if (!(err instanceof TeamsNotFoundError)) throw err;
        }
      }
      const posted = await post(at, activity);
      await statusStore.set(payload.eventId, posted);
      await record(payload.eventId, posted, 'status');
    },
  };
}

/** The channel (or chat) an activity belongs to, for the map lookup of its team. */
function splitChannel(activity: Rec): string {
  const fromData = str(rec(rec(activity['channelData'])['channel'])['id']);
  if (fromData !== '') return fromData;
  return str(rec(activity['conversation'])['id']).split(';')[0] ?? '';
}
