// Standing subscriptions (A 4.4): "keep me posted on the website" in a DM, or `<cli> watch web`, is a
// subscription to every incident on that surface, not to one incident, so it is not an event and no
// log carries it. `applyStandingWatch` writes the scope `surface` row (or scope `all`) through the
// StatePort; rebuild keeps those rows. The `watch` signal on one incident is the handler's and the
// `subscriptions` projection's (`foldIncidentSubscriptions`).
//
// Text is matched narrowly: only a phrase that asks to be kept posted (or to stop) counts, and only a
// target that resolves to a surface of the map (or "everything") is a subscription. Anything else is
// not handled, so a DM that is a bug report goes on to capture untouched.

import type { WorkspaceMap } from '../map/types.ts';
import type { StatePort } from '../ports/state.ts';

export interface StandingWatchRequest {
  action: 'watch' | 'unwatch';
  /** What the person named, lowercased: "the website", "web", "everything". */
  target: string;
  /** A bare `watch web` is a command; it is a request only when its target resolves (it may be a bug report). */
  command: boolean;
}

const KEEP =
  /^(?:please\s+|pls\s+|can you\s+|could you\s+)?(?:(?:keep|have)\s+me\s+(?:posted|updated|in the loop)|let me know|notify me|ping me|subscribe me)\s+(?:on|about|for|to|when|of)\s+(.+)$/i;
const STOP =
  /^(?:please\s+|pls\s+)?(?:stop\s+(?:keeping me posted|notifying me|pinging me|watching|telling me)|unsubscribe me from|unwatch)\s*(?:on|about|for|to|from|of)?\s*(.+)$/i;
const WATCH_CMD = /^(?:\/snapwing\s+)?watch\s+(.+)$/i;

/** The standing-watch request a text makes, or undefined. Pure; does not consult the map. */
export function parseStandingWatch(text: string): StandingWatchRequest | undefined {
  const t = text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\s]+$/, '');
  if (t === '') return undefined;
  const stop = STOP.exec(t);
  if (stop?.[1] !== undefined) return { action: 'unwatch', target: stop[1].trim().toLowerCase(), command: false };
  const keep = KEEP.exec(t);
  if (keep?.[1] !== undefined) return { action: 'watch', target: keep[1].trim().toLowerCase(), command: false };
  const command = WATCH_CMD.exec(t);
  if (command?.[1] !== undefined) return { action: 'watch', target: command[1].trim().toLowerCase(), command: true };
  return undefined;
}

const ALL_WORDS: ReadonlySet<string> = new Set(['everything', 'all', 'all incidents', 'all bugs', 'every incident', 'all of it', 'anything']);

/** `all`, a surface id, or undefined when `target` names neither. A surface matches by id or label, ignoring "the" and a trailing "site", "app", "page". */
export function resolveWatchTarget(map: WorkspaceMap, target: string): { kind: 'all' } | { kind: 'surface'; surfaceId: string; label: string } | undefined {
  const t = target.replace(/^(?:the|our)\s+/, '').replace(/\s+(?:site|app|page|surface|incidents|bugs|issues)$/, '').trim();
  if (ALL_WORDS.has(target) || ALL_WORDS.has(t)) return { kind: 'all' };
  const surface = map.surfaces.find((s) => s.id.toLowerCase() === t || s.label.toLowerCase() === t || s.label.toLowerCase() === target);
  return surface === undefined ? undefined : { kind: 'surface', surfaceId: surface.id, label: surface.label };
}

export type StandingWatchOutcome =
  | { handled: false }
  | { handled: true; changed: boolean; reply: string };

export interface StandingWatchInput {
  workspaceId: string;
  userId: string;
  text: string;
  /** Where the updates go: the thread, or a DM. A DM request asks for DMs. */
  channel: 'thread' | 'dm';
  now: Date;
}

/**
 * Applies a standing watch the text asks for. Not handled when the text is not a watch request. A
 * request whose target does not resolve is handled, with a reply that asks which surface is meant,
 * because the person did ask to be kept posted.
 */
export async function applyStandingWatch(
  state: Pick<StatePort, 'subscribe' | 'unsubscribe'>,
  map: WorkspaceMap,
  input: StandingWatchInput,
): Promise<StandingWatchOutcome> {
  const request = parseStandingWatch(input.text);
  if (request === undefined) return { handled: false };
  const target = resolveWatchTarget(map, request.target);
  if (target === undefined) {
    if (request.command) return { handled: false };
    const known = map.surfaces.map((s) => s.label).join(', ');
    return { handled: true, changed: false, reply: `I could not tell which surface you mean by "${request.target}".${known === '' ? '' : ` I know ${known}.`}` };
  }
  const scope = target.kind === 'all' ? { scopeKind: 'all' as const } : { scopeKind: 'surface' as const, scopeId: target.surfaceId };
  const what = target.kind === 'all' ? 'every incident' : `every incident on ${target.label}`;
  if (request.action === 'unwatch') {
    const removed = await state.unsubscribe({ workspaceId: input.workspaceId, userId: input.userId, ...scope });
    return { handled: true, changed: removed, reply: removed ? `Okay, I will stop updating you on ${what}.` : `You were not subscribed to ${what}.` };
  }
  await state.subscribe({ workspaceId: input.workspaceId, userId: input.userId, ...scope, channel: input.channel, createdAt: input.now.toISOString() });
  return { handled: true, changed: true, reply: `Done. I will keep you posted on ${what}.` };
}
