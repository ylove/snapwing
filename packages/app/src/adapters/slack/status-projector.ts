// The Slack status projector (main 12, 20.1, B 7.1): the one writer of the pinned status message for
// a workspace. It drains `target='slack'` `update-status` rows in order and keeps one message per
// incident, edited in place. The drain loop, ordering, 429 pause, and retry policy are the Jira
// projector's (`jira/projector/drain.ts`); this file differs only in what a row does.
//
// A row's payload is `{ status }`, the whole message as it should now read (`outbox/status.ts`).
// The thread and the message to edit come from the incidents row, not the payload.
//
// - First row: post the message in the thread (none in a direct message), pin it, then append
//   `status-message-posted { messageId }` with `expectedSeq` (a conflict is retried from a fresh read),
//   with `bot-message-posted { role: 'status' }` in the same append (A 1.3, #287).
//   `incidents.status_msg_id` then names the message; a later row `chat.update`s it.
// - Deleted message (`message_not_found` on update): post a new one, pin it, append again.
// - Direct message incidents: once the incident resolves to a surface with a bug channel, the same
//   message is mirrored there (main 15.1) and edited in place; its ref is kept in the cache under
//   `slack-status-mirror:{incident}`. The mirror is best effort: a failure there is reported through
//   `onError` and never fails the row. It is not pinned. A new mirror is recorded as
//   `bot-message-posted { role: 'status' }`, best effort too.
// - `notify` rows (A 4.4, `outbox/notify.ts`, #329): a thread message that mentions the watchers, or a
//   DM to one watcher. Rows that share a `batch_key` and are due together merge into one message: the
//   union of their mentions once, then each row's line in order. They are posted, not pinned, in the
//   incident's thread. The reporter's staging request (`reason: request`) is recorded with
//   `bot-message-posted { role: 'staging-check' }` so a reaction on it resolves (A 1.3). Notify rows
//   never hold back, or wait behind, the status rows of their incident.
// - Rows of one incident that pile up (a paused drain) collapse to the latest: each row carries the
//   whole message, so the older ones are acked unsent.
// - Failures: HTTP 429 pauses the drain for `Retry-After`, the row untouched. A row that cannot be
//   sent (bad payload, no incident, channel gone) is parked at once; anything else is deferred with
//   a doubling delay and parked after `maxAttempts` sends.

import type { StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isExpectedSeqConflict, type IncidentView, type OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { botMessagePosted, recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import { buildStatusMessage, statusMrkdwn, type SlackUserFor } from './cards/status.ts';
import { SlackApiError, SlackRateLimitError, type SlackWeb } from './web.ts';

export const STATUS_OP = 'update-status';
export const NOTIFY_OP = 'notify';
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const POSTED_APPEND_TRIES = 5;
const METRICS_PARKED_LIMIT = 100;

/** Slack errors a resend cannot fix: the channel is gone or closed to the bot, or the blocks are rejected. */
const PERMANENT_SLACK_ERRORS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'is_archived',
  'not_in_channel',
  'invalid_blocks',
  'invalid_blocks_format',
  'msg_too_long',
  'restricted_action',
]);

/** A row whose payload or incident cannot be sent. Retrying never helps, so the drain parks it. */
export class SlackStatusRowError extends Error {
  override readonly name = 'SlackStatusRowError';
  constructor(row: Pick<OutboxItem, 'id' | 'op'>, problem: string) {
    super(`outbox row ${row.id} (${row.op}): ${problem}`);
  }
}

export interface SlackStatusProjectorOptions {
  state: StatePort;
  web: SlackWeb;
  /** Keeps the mirror message of a direct message incident (no TTL). */
  cache: CachePort;
  workspaceId: string;
  /** The current workspace map: bug channels for the mirror, people for mentions. Read per pass. */
  getMap?: () => Promise<WorkspaceMap>;
  now?: () => Date;
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Errors the loop survives, and best-effort failures (pin, mirror). */
  onError?: (error: unknown) => void;
}

export interface StatusDrainReport {
  /** Row ids sent and acked. */
  sent: string[];
  /** Rows acked unsent because a later row of the same incident carries the whole message. */
  superseded: string[];
  deferred: string[];
  parked: string[];
  /** Set while the drain is paused by a 429. */
  pausedUntil?: string;
  drained: number;
}

export interface SlackStatusProjector {
  drainOnce(): Promise<StatusDrainReport>;
  start(): void;
  stop(): Promise<void>;
  pausedUntil(): Date | undefined;
  /** Prometheus text: the pause, and each parked row with its error. */
  metrics(): Promise<string>;
}

type Rec = Record<string, unknown>;
type Body = { text: string; blocks: unknown[] };

function parseStatus(row: OutboxItem): StatusUpdate {
  if (row.op !== STATUS_OP) throw new SlackStatusRowError(row, 'unknown op for target slack');
  const s = row.payload['status'];
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new SlackStatusRowError(row, 'payload.status must be an object');
  const r = s as Rec;
  for (const k of ['issueKey', 'stage', 'text'] as const) {
    if (typeof r[k] !== 'string') throw new SlackStatusRowError(row, `payload.status.${k} must be a string`);
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
    throw new SlackStatusRowError(row, 'notify payload needs delivery, text and reason');
  }
  const mentions = Array.isArray(p['mentions']) ? p['mentions'].filter((m): m is string => typeof m === 'string') : [];
  return { delivery: p['delivery'], mentions, text: p['text'], reason: p['reason'] };
}

const LEADING_MENTIONS = /^(?:<@[^>\s]+>\s*)+/;

/** One message from rows of a batch: the mentions of every row once, then each row's line in order. */
export function mergeNotifyText(rows: readonly NotifyPayload[]): string {
  const [first] = rows;
  if (rows.length === 1 && first !== undefined) return first.text;
  const mentions = [...new Set(rows.flatMap((r) => r.mentions))];
  const lines = rows.map((r) => (r.delivery === 'thread' ? r.text.replace(LEADING_MENTIONS, '') : r.text));
  const prefix = mentions.map((m) => `<@${m}>`).join(' ');
  return [prefix, ...lines].filter((l) => l !== '').join('\n');
}

const SLACK_ID = /^[UW][A-Z0-9]{2,}$/;

function userForMap(map: WorkspaceMap | undefined): SlackUserFor {
  return (ref) => {
    const person = map?.people.find((p) => p.slackId === ref || p.handle === ref);
    if (person?.slackId !== undefined) return person.slackId;
    return SLACK_ID.test(ref) ? ref : undefined;
  };
}

/** A direct message channel id starts with `D`. */
export function isDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith('D');
}

export function mirrorKey(incidentId: string): string {
  return `slack-status-mirror:${incidentId}`;
}

function parseRef(raw: string): { channel: string; ts: string } {
  return JSON.parse(raw) as { channel: string; ts: string };
}

export function createSlackStatusProjector(options: SlackStatusProjectorOptions): SlackStatusProjector {
  const { state, web, cache, workspaceId } = options;
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const onError = options.onError ?? (() => undefined);

  let paused: Date | undefined;
  let inFlight: Promise<StatusDrainReport> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const iso = (ms: number): string => new Date(ms).toISOString();

  async function recordPosted(row: OutboxItem, incidentId: string, channel: string, messageId: string): Promise<void> {
    for (let i = 0; i < POSTED_APPEND_TRIES; i++) {
      const log: IncidentEvent[] = await state.read(incidentId);
      const posted: NewEvent<'status-message-posted'> = {
        workspaceId: row.workspaceId,
        incidentId,
        type: 'status-message-posted',
        v: 1,
        source: 'slack',
        occurredAt: now().toISOString(),
        payload: { messageId },
      };
      try {
        const bot = botMessagePosted(row.workspaceId, incidentId, { platform: 'slack', channel, messageId, role: 'status' }, posted.occurredAt);
        await state.append(incidentId, [posted, bot], log.at(-1)?.seq ?? 0);
        return;
      } catch (err) {
        if (!isExpectedSeqConflict(err)) throw err;
      }
    }
    throw new Error(`status-message-posted for ${incidentId} kept conflicting after ${POSTED_APPEND_TRIES} tries`);
  }

  /** The thread the message goes in: none in a direct message, else the captured thread or the anchor. */
  async function threadOf(incident: IncidentView, channel: string): Promise<{ thread_ts?: string }> {
    if (isDirectMessageChannel(channel)) return {};
    const captured = (await state.read(incident.id)).find((e) => e.type === 'captured');
    const threadId = captured?.type === 'captured' ? captured.payload.threadId : undefined;
    const ts = threadId ?? incident.anchorId;
    return ts === undefined ? {} : { thread_ts: ts };
  }

  async function postAndPin(row: OutboxItem, incident: IncidentView, channel: string, body: Body): Promise<void> {
    const posted = await web.postMessage({ channel, ...body, ...(await threadOf(incident, channel)) });
    await web.pinsAdd(posted.channel, posted.ts).catch((err: unknown) => {
      if (err instanceof SlackRateLimitError) throw err;
      onError(err);
    });
    await recordPosted(row, incident.id, posted.channel, posted.ts);
  }

  async function mirror(incident: IncidentView, body: Body, map: WorkspaceMap | undefined): Promise<void> {
    if (incident.channelId === undefined || !isDirectMessageChannel(incident.channelId)) return;
    const key = mirrorKey(incident.id);
    const known = await cache.get(key);
    const bug = incident.surfaceId === undefined ? undefined : map?.channels.find((c) => c.surface === incident.surfaceId);
    let channel = bug?.id;
    if (known !== null) {
      const ref = parseRef(known);
      try {
        await web.updateMessage({ channel: ref.channel, ts: ref.ts, ...body });
        return;
      } catch (err) {
        if (!(err instanceof SlackApiError && err.error === 'message_not_found')) throw err;
        channel ??= ref.channel;
      }
    }
    if (channel === undefined) return;
    const posted = await web.postMessage({ channel, ...body });
    await cache.set(key, JSON.stringify({ channel: posted.channel, ts: posted.ts }));
    await recordBotMessage(state, incident.id, { platform: 'slack', channel: posted.channel, messageId: posted.ts, role: 'status' }, now);
  }

  async function send(row: OutboxItem, map: WorkspaceMap | undefined): Promise<void> {
    const status = parseStatus(row);
    if (row.incidentId === undefined) throw new SlackStatusRowError(row, 'no incident');
    const incident = await state.getIncident(row.incidentId);
    if (incident === null) throw new SlackStatusRowError(row, `unknown incident ${row.incidentId}`);
    if (incident.channelId === undefined) throw new SlackStatusRowError(row, 'the incident has no channel');
    const channel = incident.channelId;
    const message = buildStatusMessage(incident.id, status, userForMap(map));
    const body: Body = { text: message.text, blocks: message.blocks };
    if (incident.statusMsgId === undefined) {
      await postAndPin(row, incident, channel, body);
    } else {
      try {
        await web.updateMessage({ channel, ts: incident.statusMsgId, ...body });
      } catch (err) {
        if (!(err instanceof SlackApiError && err.error === 'message_not_found')) throw err;
        await postAndPin(row, incident, channel, body); // deleted: repost, re-pin
      }
    }
    await mirror(incident, body, map).catch((err: unknown) => {
      if (err instanceof SlackRateLimitError) throw err;
      onError(err);
    });
  }

  /** Sends the rows of one notify batch (one thread message, or one DM) as a single message. */
  async function sendNotify(rows: readonly OutboxItem[], map: WorkspaceMap | undefined): Promise<void> {
    const [head] = rows;
    if (head === undefined) return;
    const parsed = rows.map(parseNotify);
    const kinds = new Set(parsed.map((p) => p.delivery));
    if (kinds.size > 1) throw new SlackStatusRowError(head, 'one batch mixes thread and DM rows');
    const delivery = parsed[0]?.delivery ?? 'thread';
    const userFor = userForMap(map);
    const text = statusMrkdwn(mergeNotifyText(parsed), userFor);
    const body: Body = { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
    if (delivery === 'dm') {
      const ref = parsed[0]?.mentions[0];
      const user = ref === undefined ? undefined : userFor(ref);
      if (user === undefined) throw new SlackStatusRowError(head, 'a DM notification needs a user that resolves to a Slack id');
      await web.postMessage({ channel: user, ...body });
      return;
    }
    if (head.incidentId === undefined) throw new SlackStatusRowError(head, 'no incident');
    const incident = await state.getIncident(head.incidentId);
    if (incident === null) throw new SlackStatusRowError(head, `unknown incident ${head.incidentId}`);
    if (incident.channelId === undefined) throw new SlackStatusRowError(head, 'the incident has no channel');
    const posted = await web.postMessage({ channel: incident.channelId, ...body, ...(await threadOf(incident, incident.channelId)) });
    if (parsed.some((p) => p.reason === 'request')) {
      // The reporter's staging request: a reaction on it is the verification (A 1.3).
      await recordBotMessage(state, incident.id, { platform: 'slack', channel: posted.channel, messageId: posted.ts, role: 'staging-check' }, now);
    }
  }

  function permanent(err: unknown): boolean {
    return err instanceof SlackStatusRowError || (err instanceof SlackApiError && PERMANENT_SLACK_ERRORS.has(err.error));
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Defers or parks a row whose send failed. Resolves true when the row was parked. */
  async function failed(row: OutboxItem, err: unknown): Promise<boolean> {
    const attempts = row.attempts + 1;
    if (permanent(err)) {
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
    const rows = await state.drainOutbox('slack', batchSize, workspaceId);
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
          if (err instanceof SlackRateLimitError) {
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
        if (err instanceof SlackRateLimitError) {
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
      const parked = (await state.listParkedOutbox('slack', METRICS_PARKED_LIMIT)).filter((r) => r.workspaceId === workspaceId);
      return renderSlackProjectorMetrics(workspaceId, parked, pausedUntil(), now());
    },
  };
}

function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text for one workspace's Slack projector (same shape as the Jira one). */
export function renderSlackProjectorMetrics(workspaceId: string, parked: readonly OutboxItem[], pausedUntil: Date | undefined, at: Date): string {
  const ws = `workspace="${label(workspaceId)}"`;
  const pause = pausedUntil === undefined ? 0 : Math.max(0, (pausedUntil.getTime() - at.getTime()) / 1000);
  const lines = [
    '# HELP snapwing_slack_drain_paused_seconds Seconds left in the Slack drain pause after an HTTP 429; 0 when draining.',
    '# TYPE snapwing_slack_drain_paused_seconds gauge',
    `snapwing_slack_drain_paused_seconds{${ws}} ${pause}`,
    '# HELP snapwing_outbox_parked_rows Outbox rows parked (given up on), per target and workspace.',
    '# TYPE snapwing_outbox_parked_rows gauge',
    `snapwing_outbox_parked_rows{target="slack",${ws}} ${parked.length}`,
    '# HELP snapwing_outbox_parked_row One parked outbox row with its error; the value is its attempts.',
    '# TYPE snapwing_outbox_parked_row gauge',
    ...parked.map(
      (r) =>
        `snapwing_outbox_parked_row{target="slack",${ws},id="${label(r.id)}",op="${label(r.op)}",incident="${label(r.incidentId ?? '')}",error="${label(r.lastError ?? '')}"} ${r.attempts}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
