// The Teams status projector (main 12, 15.2, 20.1, B 7.1; #393): the one writer of the status message for
// a Teams install. It drains `target='teams'` `update-status` and `notify` rows in order and keeps one
// message per incident, edited in place. It mirrors `adapters/slack/status-projector.ts`: the drain
// loop, ordering, 429 pause, retry, and park policy are the same, and the constants, the notify merge,
// and the drain report are that file's. This file differs in what a row does.
//
// A row's payload is `{ status }`, the whole message as it should now read (`outbox/status.ts`). The
// conversation and the thread root come from the incident's `captured` event; the serviceUrl and the
// tenant from kv `teams-conversation:{channelId}` (fresh from the last activity), else the capture's
// snapshot, else the options.
//
// - First row: reply in the anchor's thread (a channel), or post in the chat, as an Adaptive Card,
//   then append `status-message-posted { messageId }` with `expectedSeq` (a conflict is retried from a
//   fresh read), with `bot-message-posted { platform: 'teams', role: 'status' }` in the same append
//   (A 1.3). The ref (conversation and activity) is kept in kv `teams-status:{incident}`. A later row
//   `updateActivity`s the same message. A bot cannot pin a channel message in Teams, so the message is
//   edited in place and never pinned.
// - Deleted activity (404 on update): post a new one, append again.
// - Personal-chat incidents: once the incident resolves to a surface with a bug channel, the same
//   message is mirrored there (main 15.1) and edited in place; its ref is kept in the cache under
//   `teams-status-mirror:{incident}`. Best effort: a failure there goes to `onError` and never fails
//   the row. A new mirror is recorded as `bot-message-posted { role: 'status' }`, best effort too.
// - `notify` rows (A 4.4, #329): rows that share a `batch_key` and are due together become one message,
//   the union of their mentions once (`<at>` with entities), then each row's line. A thread batch is
//   one message in the incident's thread. A DM batch goes to the watcher's personal chat when the bot
//   can open one (the app is installed for them); when it cannot, the watcher is mentioned in the
//   thread instead and that is logged once per watcher. A DM for an incident from another platform (a
//   Teams watcher of a Slack incident) opens the chat with the install's serviceUrl and tenant, and
//   falls back to the surface's Teams bug channel, since the incident has no Teams thread. The
//   reporter's staging request (`reason: request`) is recorded as `bot-message-posted { role:
//   'staging-check' }`. Notify rows never hold back, or wait behind, the status rows of their incident.
// - Rows of one incident that pile up (a paused drain) collapse to the latest status.
// - Failures: HTTP 429 pauses the drain for `Retry-After`, the row untouched. A row that cannot be sent
//   (bad payload, no incident, conversation gone, bot removed) is parked at once; anything else is
//   deferred with a doubling delay and parked after `maxAttempts` sends.
//
// Opening a personal chat sends `members: [{ id, aadObjectId }]`: the `29:` Teams id when an activity
// gave one (the reporter's, from the capture's snapshot), else the AAD object id (the connector's
// `createPersonalConversation`), with the bot's app id as `bot.id` (the connector's `botId`).

import type { StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isExpectedSeqConflict, type IncidentView, type OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import { channelPlatform, type WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { botMessagePosted, recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_DELAY_MS,
  mergeNotifyText,
  NOTIFY_OP,
  STATUS_OP,
  type StatusDrainReport,
} from '../slack/status-projector.ts';
import { cardActivity, createKvTeamsStatusStore, type TeamsStatusRef, type TeamsStatusStore } from './adapter.ts';
import { buildStatusCard } from './cards/status.ts';
import { card as adaptiveCard, mentionsFromMap, renderText, type MentionFor } from './cards/elements.ts';
import {
  TeamsApiError,
  TeamsForbiddenError,
  TeamsNotFoundError,
  TeamsRateLimitError,
  TeamsServiceUrlError,
  type TeamsConnector,
  type TeamsOutgoingActivity,
} from './connector.ts';
import { readTeamsConversation, readTeamsMode, type TeamsConversationType } from './conversations.ts';

export { DEFAULT_BATCH_SIZE, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_RETRY_DELAY_MS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_RETRY_DELAY_MS, NOTIFY_OP, STATUS_OP };
export type { StatusDrainReport };

const POSTED_APPEND_TRIES = 5;
const METRICS_PARKED_LIMIT = 100;
const AAD_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENTION_TOKEN = /<@([^<>\s]+)>/g;

/** A row whose payload or incident cannot be sent. Retrying never helps, so the drain parks it. */
export class TeamsStatusRowError extends Error {
  override readonly name = 'TeamsStatusRowError';
  constructor(row: Pick<OutboxItem, 'id' | 'op'>, problem: string) {
    super(`outbox row ${row.id} (${row.op}): ${problem}`);
  }
}

export interface TeamsStatusProjectorOptions {
  state: StatePort;
  connector: TeamsConnector;
  /** kv: conversation records, team modes, the mirror message of a personal-chat incident (no TTL). */
  cache: CachePort;
  workspaceId: string;
  /** The current workspace map: bug channels for the mirror, people for mentions. Read per pass. */
  getMap?: () => Promise<WorkspaceMap>;
  /** Default: kv `teams-status:{incidentId}` (the adapter's store, so both edit the same message). */
  statusStore?: TeamsStatusStore;
  /** The serviceUrl when no activity has named one for a conversation yet. */
  defaultServiceUrl?: string;
  /** The install's tenant, for a watcher's personal chat when no activity named it. */
  tenantId?: string;
  /** The bot's app id, sent as `bot.id` when a personal chat is opened (overrides the connector's). */
  botId?: string;
  now?: () => Date;
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Errors the loop survives, best-effort failures (mirror, records), and the once-per-watcher install notes. */
  onError?: (error: unknown) => void;
}

export interface TeamsStatusProjector {
  drainOnce(): Promise<StatusDrainReport>;
  start(): void;
  stop(): Promise<void>;
  pausedUntil(): Date | undefined;
  /** Prometheus text: the pause, and each parked row with its error. */
  metrics(): Promise<string>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseStatus(row: OutboxItem): StatusUpdate {
  if (row.op !== STATUS_OP) throw new TeamsStatusRowError(row, 'unknown op for target teams');
  const s = row.payload['status'];
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new TeamsStatusRowError(row, 'payload.status must be an object');
  const r = s as Rec;
  for (const k of ['issueKey', 'stage', 'text'] as const) {
    if (typeof r[k] !== 'string') throw new TeamsStatusRowError(row, `payload.status.${k} must be a string`);
  }
  return r as unknown as StatusUpdate;
}

interface NotifyPayload {
  delivery: 'thread' | 'dm';
  mentions: string[];
  text: string;
  reason: string;
}

function parseNotify(row: OutboxItem): NotifyPayload {
  const p = row.payload;
  if ((p['delivery'] !== 'thread' && p['delivery'] !== 'dm') || typeof p['text'] !== 'string' || typeof p['reason'] !== 'string') {
    throw new TeamsStatusRowError(row, 'notify payload needs delivery, text and reason');
  }
  const mentions = Array.isArray(p['mentions']) ? p['mentions'].filter((m): m is string => typeof m === 'string') : [];
  return { delivery: p['delivery'], mentions, text: p['text'], reason: p['reason'] };
}

/** The notification fallback of a message: the text with each mention token as `@ref`. */
function plain(text: string): string {
  return text.replace(MENTION_TOKEN, '@$1');
}

export function mirrorKey(incidentId: string): string {
  return `teams-status-mirror:${incidentId}`;
}

interface MirrorRef {
  serviceUrl: string;
  channelId: string;
  activityId: string;
}

function parseMirror(raw: string): MirrorRef | undefined {
  try {
    const v = rec(JSON.parse(raw));
    return str(v['serviceUrl']) === '' || str(v['channelId']) === '' || str(v['activityId']) === ''
      ? undefined
      : { serviceUrl: str(v['serviceUrl']), channelId: str(v['channelId']), activityId: str(v['activityId']) };
  } catch {
    return undefined;
  }
}

/** Where an incident's messages go. */
interface Where {
  serviceUrl: string;
  channelId: string;
  conversationType: TeamsConversationType;
  /** A channel incident's thread root; undefined in a chat. */
  rootId?: string;
  teamId?: string;
  tenantId?: string;
  /** The reporter's `29:` id, when the capture's activity gave one. */
  reporterTeamsId?: string;
  reporterAadId?: string;
}

function isPermanent(err: unknown): boolean {
  return (
    err instanceof TeamsStatusRowError ||
    err instanceof TeamsForbiddenError ||
    err instanceof TeamsNotFoundError ||
    err instanceof TeamsServiceUrlError ||
    (err instanceof TeamsApiError && err.status === 400)
  );
}

export function createTeamsStatusProjector(options: TeamsStatusProjectorOptions): TeamsStatusProjector {
  const { state, connector, cache, workspaceId } = options;
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const onError = options.onError ?? (() => undefined);
  const statusStore = options.statusStore ?? createKvTeamsStatusStore(cache);
  /** Watchers already noted as without a personal install. */
  const noted = new Set<string>();

  let paused: Date | undefined;
  let inFlight: Promise<StatusDrainReport> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const iso = (ms: number): string => new Date(ms).toISOString();

  async function recordPosted(row: OutboxItem, incidentId: string, ref: TeamsStatusRef): Promise<void> {
    for (let i = 0; i < POSTED_APPEND_TRIES; i++) {
      const log: IncidentEvent[] = await state.read(incidentId);
      const posted: NewEvent<'status-message-posted'> = {
        workspaceId: row.workspaceId,
        incidentId,
        type: 'status-message-posted',
        v: 1,
        source: 'teams',
        occurredAt: now().toISOString(),
        payload: { messageId: ref.activityId },
      };
      try {
        const bot = botMessagePosted(
          row.workspaceId,
          incidentId,
          { platform: 'teams', channel: ref.channelId, messageId: ref.activityId, role: 'status' },
          posted.occurredAt,
        );
        await state.append(incidentId, [posted, bot], log.at(-1)?.seq ?? 0);
        return;
      } catch (err) {
        if (!isExpectedSeqConflict(err)) throw err;
      }
    }
    throw new Error(`status-message-posted for ${incidentId} kept conflicting after ${POSTED_APPEND_TRIES} tries`);
  }

  /** The conversation, thread, serviceUrl, and tenant of an incident (see the file header). */
  async function whereOf(row: Pick<OutboxItem, 'id' | 'op'>, incident: IncidentView): Promise<Where> {
    if (incident.channelId === undefined) throw new TeamsStatusRowError(row, 'the incident has no channel');
    const channelId = incident.channelId;
    const captured = (await state.read(incident.id)).find((e) => e.type === 'captured');
    const payload = captured?.type === 'captured' ? captured.payload : undefined;
    const snap = rec(payload?.rawPayloadSnapshot);
    const record = await readTeamsConversation(cache, channelId).catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    const snapType = str(snap['conversationType']);
    const conversationType: TeamsConversationType =
      record?.conversationType ?? (snapType === 'personal' || snapType === 'groupChat' ? snapType : 'channel');
    const serviceUrl = record?.serviceUrl ?? (str(snap['serviceUrl']) || options.defaultServiceUrl);
    if (serviceUrl === undefined || serviceUrl === '') {
      throw new TeamsStatusRowError(row, `no serviceUrl known for conversation ${channelId}`);
    }
    const rootId =
      conversationType === 'channel'
        ? (str(snap['threadRootId']) || (payload?.threadId ?? '') || (incident.anchorId ?? '') || undefined)
        : undefined;
    const teamId = str(snap['teamId']) || record?.teamId || undefined;
    const tenantId = str(snap['tenantId']) || record?.tenantId || options.tenantId || undefined;
    const reporterTeamsId = str(snap['reporterTeamsId']) || undefined;
    return {
      serviceUrl,
      channelId,
      conversationType,
      ...(rootId === undefined ? {} : { rootId }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(reporterTeamsId === undefined ? {} : { reporterTeamsId }),
      ...(payload?.reporter.id === undefined ? {} : { reporterAadId: payload.reporter.id }),
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

  async function postStatus(row: OutboxItem, incident: IncidentView, at: Where, activity: TeamsOutgoingActivity): Promise<void> {
    const ref = await post(at, activity);
    await statusStore.set(incident.id, ref);
    await recordPosted(row, incident.id, ref);
  }

  /** The Teams bug channel of the incident's surface, if the map lists one (a Slack channel for the same surface never counts). */
  function teamsBugChannel(incident: IncidentView, map: WorkspaceMap | undefined) {
    if (incident.surfaceId === undefined) return undefined;
    return map?.channels.find((c) => c.surface === incident.surfaceId && channelPlatform(c) === 'teams');
  }

  async function mirror(incident: IncidentView, at: Where, activity: TeamsOutgoingActivity, map: WorkspaceMap | undefined): Promise<void> {
    if (at.conversationType !== 'personal') return;
    const key = mirrorKey(incident.id);
    const known = await cache.get(key);
    const bug = teamsBugChannel(incident, map);
    let target = bug === undefined ? undefined : { channelId: bug.id, serviceUrl: undefined as string | undefined };
    const ref = known === null ? undefined : parseMirror(known);
    if (ref !== undefined) {
      try {
        await connector.updateActivity({ serviceUrl: ref.serviceUrl, conversationId: ref.channelId, activityId: ref.activityId }, activity);
        return;
      } catch (err) {
        if (!(err instanceof TeamsNotFoundError)) throw err;
        target ??= { channelId: ref.channelId, serviceUrl: ref.serviceUrl };
      }
    }
    if (target === undefined) return;
    const record = await readTeamsConversation(cache, target.channelId).catch(() => undefined);
    const serviceUrl = record?.serviceUrl ?? target.serviceUrl ?? at.serviceUrl;
    const out = await connector.sendToConversation({ serviceUrl, conversationId: target.channelId }, activity);
    await cache.set(key, JSON.stringify({ serviceUrl, channelId: target.channelId, activityId: out.id }));
    await recordBotMessage(state, incident.id, { platform: 'teams', channel: target.channelId, messageId: out.id, role: 'status' }, now);
  }

  async function send(row: OutboxItem, map: WorkspaceMap | undefined): Promise<void> {
    const status = parseStatus(row);
    if (row.incidentId === undefined) throw new TeamsStatusRowError(row, 'no incident');
    const incident = await state.getIncident(row.incidentId);
    if (incident === null) throw new TeamsStatusRowError(row, `unknown incident ${row.incidentId}`);
    const at = await whereOf(row, incident);
    const mentions: MentionFor = mentionsFromMap(map?.people ?? []);
    const activity = cardActivity(buildStatusCard(incident.id, status, { mentions, reduced: await reduced(at) }));
    if (incident.statusMsgId === undefined) {
      // A message posted by an earlier try whose append failed: edit it, never post a second one.
      const orphan = await statusStore.get(incident.id);
      let adopted = false;
      if (orphan !== undefined) {
        try {
          await connector.updateActivity({ serviceUrl: at.serviceUrl, conversationId: orphan.conversationId, activityId: orphan.activityId }, activity);
          await recordPosted(row, incident.id, orphan);
          adopted = true;
        } catch (err) {
          if (!(err instanceof TeamsNotFoundError)) throw err;
        }
      }
      if (!adopted) await postStatus(row, incident, at, activity);
    } else {
      const known = await statusStore.get(incident.id);
      const conversationId = known?.conversationId ?? (at.rootId === undefined ? at.channelId : `${at.channelId};messageid=${at.rootId}`);
      try {
        await connector.updateActivity({ serviceUrl: at.serviceUrl, conversationId, activityId: incident.statusMsgId }, activity);
      } catch (err) {
        if (!(err instanceof TeamsNotFoundError)) throw err;
        await postStatus(row, incident, at, activity); // deleted: post a new one
      }
    }
    await mirror(incident, at, activity, map).catch((err: unknown) => {
      if (err instanceof TeamsRateLimitError) throw err;
      onError(err);
    });
  }

  /** The AAD object id and `29:` id a watcher ref names, or undefined when the ref resolves to nobody. */
  function watcherIds(ref: string, at: Where | undefined, map: WorkspaceMap | undefined): { aadObjectId: string; userId?: string } | undefined {
    const person = mentionsFromMap(map?.people ?? [])(ref);
    const aadObjectId = person?.id ?? (AAD_OBJECT_ID.test(ref) ? ref : undefined);
    if (aadObjectId === undefined) return undefined;
    const userId = at?.reporterTeamsId !== undefined && at.reporterAadId === aadObjectId ? at.reporterTeamsId : undefined;
    return { aadObjectId, ...(userId === undefined ? {} : { userId }) };
  }

  /** Sends the rows of one notify batch (one thread message, or one DM) as a single message. */
  async function sendNotify(rows: readonly OutboxItem[], map: WorkspaceMap | undefined): Promise<void> {
    const [head] = rows;
    if (head === undefined) return;
    const parsed = rows.map(parseNotify);
    if (new Set(parsed.map((p) => p.delivery)).size > 1) throw new TeamsStatusRowError(head, 'one batch mixes thread and DM rows');
    const delivery = parsed[0]?.delivery ?? 'thread';
    const mentions = mentionsFromMap(map?.people ?? []);
    const bodyOf = (text: string, opts: { reduced?: boolean } = {}) => cardActivity(adaptiveCard(plain(text), [renderText(text, mentions)], [], opts));
    if (head.incidentId === undefined) throw new TeamsStatusRowError(head, 'no incident');
    const incident = await state.getIncident(head.incidentId);
    if (incident === null) throw new TeamsStatusRowError(head, `unknown incident ${head.incidentId}`);
    const text = mergeNotifyText(parsed);

    if (delivery === 'dm') {
      const ref = parsed[0]?.mentions[0];
      if (ref === undefined) throw new TeamsStatusRowError(head, 'a DM notification needs a watcher');
      // An incident from another platform (a Teams watcher of a Slack incident) has no Teams
      // conversation: the install's serviceUrl and tenant open the watcher's chat.
      const at = incident.source === 'teams' ? await whereOf(head, incident) : undefined;
      const serviceUrl = at?.serviceUrl ?? options.defaultServiceUrl;
      const tenantId = at === undefined ? options.tenantId : at.tenantId;
      const ids = watcherIds(ref, at, map);
      let why: string | undefined;
      if (ids === undefined) why = 'it resolves to no Teams user';
      else if (serviceUrl === undefined) why = 'no serviceUrl is known to open a personal chat';
      else if (tenantId === undefined) why = 'no tenant is known to open a personal chat';
      else {
        try {
          const chat = await connector.createPersonalConversation({
            serviceUrl,
            tenantId,
            aadObjectId: ids.aadObjectId,
            ...(ids.userId === undefined ? {} : { userId: ids.userId }),
            ...(options.botId === undefined ? {} : { botId: options.botId }),
          });
          await connector.sendToConversation({ serviceUrl: chat.serviceUrl ?? serviceUrl, conversationId: chat.id }, bodyOf(text));
          return;
        } catch (err) {
          // No per-user install (or the chat is closed to the bot): mention them in the thread instead.
          if (!(err instanceof TeamsApiError) || err instanceof TeamsRateLimitError || err.status >= 500 || err.status === 0) throw err;
          why = `the personal chat could not be opened (${err.status} ${err.code})`;
        }
      }
      // The fallback is the incident's Teams thread. A personal chat is the reporter's 1:1 chat, and an
      // incident from another platform has no Teams thread: never post another person's notification
      // there; use the surface's Teams bug channel instead.
      const thread = at !== undefined && at.conversationType !== 'personal' ? at : undefined;
      const bug = thread === undefined ? teamsBugChannel(incident, map) : undefined;
      const noThread = at === undefined ? 'the incident has no Teams thread' : 'the incident is in a personal chat';
      const where = thread !== undefined ? 'mentioned in the thread instead' : bug === undefined ? `not posted (${noThread} and no Teams bug channel is mapped)` : 'mentioned in the bug channel instead';
      if (!noted.has(ref)) {
        noted.add(ref);
        onError(new Error(`teams notify: ${ref} has no personal install, ${where}: ${why}`));
      }
      const mention = `<@${ref}>`;
      const fallback = mergeNotifyText([{ delivery: 'thread', mentions: [ref], text: text.startsWith(mention) ? text : `${mention} ${text}`, reason: parsed[0]?.reason ?? 'watch' }]);
      if (thread !== undefined) {
        await post(thread, bodyOf(fallback, { reduced: await reduced(thread) }));
      } else if (bug !== undefined) {
        const record = await readTeamsConversation(cache, bug.id).catch(() => undefined);
        const bugServiceUrl = record?.serviceUrl ?? serviceUrl;
        if (bugServiceUrl === undefined) throw new TeamsStatusRowError(head, `no serviceUrl known for conversation ${bug.id}`);
        const isReduced = bug.teamId === undefined ? false : await readTeamsMode(cache, bug.teamId).then((m) => m === 'reduced').catch(() => false);
        await connector.sendToConversation({ serviceUrl: bugServiceUrl, conversationId: bug.id }, bodyOf(fallback, { reduced: isReduced }));
      }
      return;
    }

    const at = await whereOf(head, incident);
    const posted = await post(at, bodyOf(text, { reduced: await reduced(at) }));
    if (parsed.some((p) => p.reason === 'request')) {
      // The reporter's staging request: a reaction on it is the verification (A 1.3).
      await recordBotMessage(state, incident.id, { platform: 'teams', channel: posted.channelId, messageId: posted.activityId, role: 'staging-check' }, now);
    }
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Defers or parks a row whose send failed. Resolves true when the row was parked. */
  async function failed(row: OutboxItem, err: unknown): Promise<boolean> {
    const attempts = row.attempts + 1;
    if (isPermanent(err)) {
      await state.parkOutbox(row.id, message(err));
      return true;
    }
    if (attempts >= maxAttempts) {
      await state.parkOutbox(row.id, `gave up after ${attempts} attempts: ${message(err)}`);
      return true;
    }
    const delay = Math.min(retryDelayMs * 2 ** (attempts - 1), maxRetryDelayMs);
    await state.deferOutbox(row.id, iso(now().getTime() + delay), message(err));
    return false;
  }

  async function pass(): Promise<StatusDrainReport> {
    const report: StatusDrainReport = { sent: [], superseded: [], deferred: [], parked: [], drained: 0 };
    if (paused !== undefined) {
      if (now().getTime() < paused.getTime()) {
        report.pausedUntil = paused.toISOString();
        return report;
      }
      paused = undefined;
    }
    const rows = await state.drainOutbox('teams', batchSize, workspaceId);
    report.drained = rows.length;
    const map = options.getMap === undefined || rows.length === 0 ? undefined : await options.getMap();
    // Rows come oldest first; the last row of an (incident, batch_key) carries the whole message.
    const keyOf = (row: OutboxItem): string => `${row.incidentId ?? ''}\n${row.batchKey ?? ''}`;
    const latest = new Map<string, string>();
    for (const row of rows) if (row.batchKey !== undefined && row.op === STATUS_OP) latest.set(keyOf(row), row.id);
    // Notify rows of one (incident, batch_key) go out as one message, at the first of them.
    const batches = new Map<string, OutboxItem[]>();
    for (const row of rows) {
      if (row.op !== NOTIFY_OP) continue;
      const key = keyOf(row);
      const list = batches.get(key);
      if (list === undefined) batches.set(key, [row]);
      else list.push(row);
    }
    const blocked = new Set<string>();
    for (const row of rows) {
      if (row.op === NOTIFY_OP) {
        const batch = batches.get(keyOf(row));
        if (batch === undefined || batch[0]?.id !== row.id) continue; // sent with the first row of its batch
        try {
          await sendNotify(batch, map);
          await state.ackOutbox(batch.map((r) => r.id));
          report.sent.push(...batch.map((r) => r.id));
        } catch (err) {
          if (err instanceof TeamsRateLimitError) {
            paused = new Date(now().getTime() + err.retryAfterMs);
            report.pausedUntil = paused.toISOString();
            return report;
          }
          for (const r of batch) {
            if (await failed(r, err)) report.parked.push(r.id);
            else report.deferred.push(r.id);
          }
        }
        continue;
      }
      const lane = row.incidentId;
      if (lane !== undefined && blocked.has(lane)) continue;
      try {
        if (row.batchKey !== undefined && row.op === STATUS_OP && latest.get(keyOf(row)) !== row.id) {
          await state.ackOutbox([row.id]);
          report.superseded.push(row.id);
          continue;
        }
        await send(row, map);
        await state.ackOutbox([row.id]);
        report.sent.push(row.id);
      } catch (err) {
        if (err instanceof TeamsRateLimitError) {
          paused = new Date(now().getTime() + err.retryAfterMs);
          report.pausedUntil = paused.toISOString();
          return report;
        }
        if (await failed(row, err)) {
          report.parked.push(row.id);
        } else {
          report.deferred.push(row.id);
          if (lane !== undefined) blocked.add(lane);
        }
      }
    }
    return report;
  }

  function pausedUntil(): Date | undefined {
    return paused !== undefined && now().getTime() < paused.getTime() ? paused : undefined;
  }

  function drainOnce(): Promise<StatusDrainReport> {
    inFlight ??= pass().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function schedule(delayMs: number): void {
    if (!running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void loop();
    }, delayMs);
  }

  async function loop(): Promise<void> {
    let delay = pollIntervalMs;
    try {
      const report = await drainOnce();
      if (report.pausedUntil !== undefined) delay = Math.max(0, Date.parse(report.pausedUntil) - now().getTime());
      else if (report.drained >= batchSize) delay = 0;
    } catch (err) {
      onError(err);
    }
    schedule(delay);
  }

  return {
    drainOnce,
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inFlight?.catch(() => undefined);
    },
    pausedUntil,
    async metrics() {
      const parked = (await state.listParkedOutbox('teams', METRICS_PARKED_LIMIT)).filter((r) => r.workspaceId === workspaceId);
      return renderTeamsProjectorMetrics(workspaceId, parked, pausedUntil(), now());
    },
  };
}

function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text for one workspace's Teams projector (same shape as the Slack and Jira ones). */
export function renderTeamsProjectorMetrics(workspaceId: string, parked: readonly OutboxItem[], pausedUntil: Date | undefined, at: Date): string {
  const ws = `workspace="${label(workspaceId)}"`;
  const pause = pausedUntil === undefined ? 0 : Math.max(0, (pausedUntil.getTime() - at.getTime()) / 1000);
  const lines = [
    '# HELP snapwing_teams_drain_paused_seconds Seconds left in the Teams drain pause after an HTTP 429; 0 when draining.',
    '# TYPE snapwing_teams_drain_paused_seconds gauge',
    `snapwing_teams_drain_paused_seconds{${ws}} ${pause}`,
    '# HELP snapwing_outbox_parked_rows Outbox rows parked (given up on), per target and workspace.',
    '# TYPE snapwing_outbox_parked_rows gauge',
    `snapwing_outbox_parked_rows{target="teams",${ws}} ${parked.length}`,
    '# HELP snapwing_outbox_parked_row One parked outbox row with its error; the value is its attempts.',
    '# TYPE snapwing_outbox_parked_row gauge',
    ...parked.map(
      (r) =>
        `snapwing_outbox_parked_row{target="teams",${ws},id="${label(r.id)}",op="${label(r.op)}",incident="${label(r.incidentId ?? '')}",error="${label(r.lastError ?? '')}"} ${r.attempts}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
