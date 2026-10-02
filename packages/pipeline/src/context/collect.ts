// Context collection: main 5.1 and 5.2. The anchor is a starting point, not a boundary.
import type { ContextBundle, SourceMessage } from '../contracts/incident.ts';
import { formatDuration, parseDuration } from '../util/duration.ts';
import type { ChatReader } from './chat-reader.ts';

export interface CollectPolicy {
  /** Half-width of the window around the anchor, ISO 8601 duration. */
  window: string;
  /** Maximum channel-history messages read. Thread replies are collected on top of the cap. */
  cap: number;
}

export const DEFAULT_COLLECT_POLICY: CollectPolicy = { window: 'PT30M', cap: 40 };

export interface Anchor {
  channelId: string;
  message: SourceMessage;
  /** A DM, CLI send, or phone share: there is no surrounding channel conversation. */
  direct?: boolean;
}

export function isImageOnly(message: SourceMessage): boolean {
  return (
    message.text.trim() === '' &&
    message.attachments.length > 0 &&
    message.attachments.every((a) => a.kind === 'image')
  );
}

function byTime(a: SourceMessage, b: SourceMessage): number {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id);
}

/** Doubles the window and the cap, so a wider window is not silently clipped by the old cap. */
export function widenPolicy(policy: CollectPolicy): CollectPolicy {
  return { window: formatDuration(parseDuration(policy.window) * 2), cap: policy.cap * 2 };
}

export async function collectWindow(
  anchor: Anchor,
  reader: ChatReader,
  policy: CollectPolicy = DEFAULT_COLLECT_POLICY,
): Promise<ContextBundle> {
  const { channelId, message } = anchor;
  const anchorMs = Date.parse(message.timestamp);
  const halfMs = parseDuration(policy.window);
  const oldest = new Date(anchorMs - halfMs).toISOString();
  const latest = new Date(anchorMs + halfMs).toISOString();

  if (anchor.direct === true && isImageOnly(message)) {
    return {
      anchorId: message.id,
      included: [message],
      excluded: [],
      windowUsed: { oldest: message.timestamp, latest: message.timestamp, cap: policy.cap },
    };
  }

  const excluded: { id: string; reason: string }[] = [];
  const byId = new Map<string, SourceMessage>([[message.id, message]]);

  // Channel window, capped. Over the cap, keep the messages nearest the anchor in time.
  const history = await reader.history(channelId, oldest, latest, policy.cap);
  const inWindow = history.filter((m) => {
    const t = Date.parse(m.timestamp);
    return t >= anchorMs - halfMs && t <= anchorMs + halfMs;
  });
  const candidates = inWindow.filter((m) => m.id !== message.id);
  const room = Math.max(0, policy.cap - 1);
  const ranked = [...candidates].sort(
    (a, b) => Math.abs(Date.parse(a.timestamp) - anchorMs) - Math.abs(Date.parse(b.timestamp) - anchorMs),
  );
  const kept = new Set(ranked.slice(0, room).map((m) => m.id));
  for (const m of candidates) {
    if (kept.has(m.id)) byId.set(m.id, m);
    else excluded.push({ id: m.id, reason: 'over-cap' });
  }

  // Sub-threads of top-level messages in the window that have replies, plus the anchor's own thread.
  // replyCount 0 means no thread (skip the rate-limited call); absent means unknown, so expand.
  const parents = [...byId.values()].filter(
    (m) => m.threadParentId === undefined && (m.replyCount === undefined || m.replyCount > 0),
  );
  // When the anchor is in a thread, its parent and siblings come from that thread.
  const threadRoots = new Set(parents.map((m) => m.id));
  if (message.threadParentId !== undefined) threadRoots.add(message.threadParentId);
  const threads = await Promise.all([...threadRoots].map((id) => reader.replies(channelId, id)));
  for (const thread of threads) {
    for (const m of thread) if (!byId.has(m.id)) byId.set(m.id, m);
  }

  const included = [...byId.values()].sort(byTime);
  return {
    anchorId: message.id,
    included,
    excluded,
    windowUsed: { oldest, latest, cap: policy.cap },
  };
}
