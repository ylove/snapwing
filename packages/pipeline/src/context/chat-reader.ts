// Read side of a chat adapter, as context assembly sees it (main 5.2).
import type { SourceMessage } from '../contracts/incident.ts';

export interface ChatReader {
  /**
   * Top-level channel messages with oldest <= timestamp <= latest (ISO 8601), oldest first,
   * at most `limit`. Thread replies are not expected here; `replies` fetches them.
   */
  history(channelId: string, oldest: string, latest: string, limit: number): Promise<SourceMessage[]>;
  /**
   * The thread under `parentId`: the parent first (when the platform returns it), then its
   * replies, oldest first. Empty when the message has no thread.
   */
  replies(channelId: string, parentId: string): Promise<SourceMessage[]>;
}
