// Read side of a chat adapter, as context assembly sees it (main 5.2).
import type { SourceMessage } from '../contracts/incident.ts';

export interface ChatReader {
  /**
   * Top-level channel messages with oldest <= timestamp <= latest (ISO 8601), oldest first,
   * at most `limit`. Thread replies are not expected here; `replies` fetches them.
   *
   * Over the limit, the `limit` messages nearest the midpoint of [oldest, latest] survive (ties go
   * to the earlier message). The collector calls with `anchor - half` and `anchor + half`, so the
   * midpoint is the anchor. Use `nearestMidpoint` to implement this.
   */
  history(channelId: string, oldest: string, latest: string, limit: number): Promise<SourceMessage[]>;
  /**
   * The thread under `parentId`: the parent first (when the platform returns it), then its
   * replies, oldest first. Empty when the message has no thread.
   */
  replies(channelId: string, parentId: string): Promise<SourceMessage[]>;
}

/** The `limit` messages nearest the midpoint of [oldest, latest], oldest first (ties keep the earlier). */
export function nearestMidpoint(messages: readonly SourceMessage[], oldest: string, latest: string, limit: number): SourceMessage[] {
  const mid = (Date.parse(oldest) + Date.parse(latest)) / 2;
  const byTime = (a: SourceMessage, b: SourceMessage): number =>
    Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id);
  return [...messages]
    .sort((a, b) => Math.abs(Date.parse(a.timestamp) - mid) - Math.abs(Date.parse(b.timestamp) - mid) || byTime(a, b))
    .slice(0, Math.max(0, limit))
    .sort(byTime);
}
