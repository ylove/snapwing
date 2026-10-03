// Scope preview: main 5.5. The agent shows its work before any downstream action.
import type { ContextBundle, SourceMessage } from '../contracts/incident.ts';
import type { ChatReader } from './chat-reader.ts';
import {
  DEFAULT_COLLECT_POLICY,
  collectWindow,
  widenPolicy,
  type Anchor,
  type CollectPolicy,
} from './collect.ts';

export const SCOPE_ACTIONS = ['Looks right', 'Widen', 'Narrow'] as const;
export type ScopeAction = (typeof SCOPE_ACTIONS)[number];

export interface ScopePreview {
  text: string;
  actions: readonly ScopeAction[];
}

export interface ScopePreviewOptions {
  /** Author id to display name. Unknown ids are shown as the id. */
  names?: Readonly<Record<string, string>>;
  /** IANA zone for the time range. Default UTC. */
  timeZone?: string;
  /** Why only part of the conversation was read (main 15.2); the preview says so. */
  limitation?: 'anchor-only';
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone })
    .format(new Date(iso))
    .replace(/^0/, '');
}

function join(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function scopePreview(bundle: ContextBundle, options: ScopePreviewOptions = {}): ScopePreview {
  const names = options.names ?? {};
  const tz = options.timeZone ?? 'UTC';
  const who = (m: SourceMessage): string => names[m.authorId] ?? m.authorId;
  const msgs = bundle.included;
  const n = msgs.length;
  const times = msgs.map((m) => Date.parse(m.timestamp));
  const noun = n === 1 ? 'message' : 'messages';

  let head = `Reading ${n} ${noun}`;
  if (n > 0) {
    const from = clock(new Date(Math.min(...times)).toISOString(), tz);
    const to = clock(new Date(Math.max(...times)).toISOString(), tz);
    head += from === to ? ` at ${from}` : ` from ${from} to ${to}`;
  }

  const notable: string[] = [];
  for (const m of msgs) {
    const images = m.attachments.filter((a) => a.kind === 'image').length;
    const files = m.attachments.filter((a) => a.kind === 'file').length;
    if (images > 0) notable.push(images === 1 ? `${who(m)}'s screenshot` : `${who(m)}'s ${images} screenshots`);
    if (files > 0) notable.push(files === 1 ? `${who(m)}'s file` : `${who(m)}'s ${files} files`);
  }
  const threadParents = new Set(msgs.map((m) => m.threadParentId).filter((id): id is string => id !== undefined));
  const threads = msgs
    .filter((m) => threadParents.has(m.id))
    .map((m) => `the thread under ${who(m)}'s message`);
  // A thread whose parent is not in the bundle still counts as a thread.
  const included = new Set(msgs.map((m) => m.id));
  const orphans = [...threadParents].filter((id) => !included.has(id));
  if (orphans.length > 0) threads.push(orphans.length === 1 ? 'a thread' : `${orphans.length} threads`);

  const extras = [...notable, ...threads];
  const read = `${head}${extras.length > 0 ? `, including ${join(extras)}` : ''}.`;
  const text = options.limitation === 'anchor-only' ? `${read} I could only read this message.` : read;
  return { text, actions: SCOPE_ACTIONS };
}

/** Widen: the same collection over a doubled window (and cap), main 5.5. */
export function widen(
  anchor: Anchor,
  reader: ChatReader,
  policy: CollectPolicy = DEFAULT_COLLECT_POLICY,
): Promise<ContextBundle> {
  return collectWindow(anchor, reader, widenPolicy(policy));
}

/** Narrow: only the anchor's own thread. A top-level anchor is its thread's parent. */
export async function narrow(
  anchor: Anchor,
  reader: ChatReader,
  policy: CollectPolicy = DEFAULT_COLLECT_POLICY,
): Promise<ContextBundle> {
  const { channelId, message } = anchor;
  const thread = await reader.replies(channelId, message.threadParentId ?? message.id);
  const byId = new Map<string, SourceMessage>([[message.id, message]]);
  for (const m of thread) if (!byId.has(m.id)) byId.set(m.id, m);
  const included = [...byId.values()].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id),
  );
  const first = included[0] ?? message;
  const last = included[included.length - 1] ?? message;
  return {
    anchorId: message.id,
    included,
    excluded: [],
    windowUsed: { oldest: first.timestamp, latest: last.timestamp, cap: policy.cap },
  };
}
