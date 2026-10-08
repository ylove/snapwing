// src/signals/ux-friction.ts: when user error is a product bug (A 5.3).
//
// `userSide/@uxFrictionThreshold` different reporters landing on the same indicator kind on the same
// surface within `userSide/@uxFrictionWindow` is a UX defect, not that many mistakes. The agent files
// one Task labeled `ux-friction` that summarizes the pattern without naming anyone ("3 reporters
// landed on a test environment on Web app") and posts it to the surface's bug channel.
//
// The input is the log: a reporter's "That fixed it" is a `user-side` event whose actor is the
// reporter and whose payload carries `kind` and `surfaceId`. Events with no actor or no surface are
// not counted (there is no reporter, or no surface to say it about). One reporter tapping twice counts
// once. Off when `userSide check="false"`: `scan` reads nothing and files nothing, and the log it
// skipped is read when the check comes back on.
//
// Once per pattern per window: the filing takes `ux-friction:{surface}:{kind}` from the cache with a
// TTL of the window (`setIfAbsent`), so a pattern that is still true on the next scan files nothing,
// and files again after a full window. A filer that throws gives the key back, so the next scan tries
// again. The cursor and the counted events are in memory; a restart replays the log from its start,
// and the cache key keeps the replay from filing twice.
//
// A factory over injected interfaces; compose wires the filer (a Jira Task through the outbox, plus
// the chat post) and calls `scan` on a timer. Nothing here talks to Jira or chat.

import type { Playbook } from '../config/playbook.ts';
import type { IncidentEvent } from '../contracts/events.ts';
import type { UserSideKind } from '../contracts/incident.ts';
import { LOG_START } from '../contracts/state.ts';
import type { WorkspaceMap } from '../map/types.ts';
import type { CachePort } from '../ports/cache.ts';
import type { StatePort } from '../ports/state.ts';
import { parseDuration } from '../util/duration.ts';

/** The label the Task carries. */
export const UX_FRICTION_LABEL = 'ux-friction';

/** What each indicator kind means as a clause that follows "N reporters"; names nobody. */
const WHAT: Readonly<Record<UserSideKind, string>> = {
  'wrong-environment': 'landed on a test environment instead of the live site',
  'wrong-account': 'were signed in with a different account than they meant',
  'stale-cache': 'saw an out-of-date page until they reloaded it',
  'extension-interference': 'were blocked by a browser add-on',
  'input-mode': 'ran into an input mode problem such as caps lock',
  'expired-session': 'hit an expired session',
  network: 'hit a connection problem',
  'wrong-surface': 'were on a different page than they meant',
  other: 'tried again and it worked',
};

/** One detected pattern. */
export interface FrictionPattern {
  kind: UserSideKind;
  surfaceId: string;
  /** Distinct reporters in the window. */
  reporters: number;
  /** ISO 8601: the earliest and latest counted event. */
  firstAt: string;
  lastAt: string;
  /** The window as the playbook states it (`P30D`). */
  window: string;
}

/** The Task to file. Carries no reporter id and no reporter name. */
export interface UxFrictionTask {
  workspaceId: string;
  surfaceId: string;
  kind: UserSideKind;
  issueType: 'Task';
  labels: [typeof UX_FRICTION_LABEL];
  summary: string;
  description: string;
  /** The surface's bug channel (a map channel id), when the map has one. */
  channelId?: string;
  /** `channelId`'s name, for the post. */
  channelName?: string;
  pattern: FrictionPattern;
}

/** Files the Task and posts it to the channel. Rejects when it could not; the pattern is then retried. */
export type FileUxFriction = (task: UxFrictionTask) => Promise<void>;

export interface UxFrictionDeps {
  state: Pick<StatePort, 'readSince'>;
  /** Idempotency keys; a TTL cache (the `kv` table or Redis). */
  cache: CachePort;
  clock: () => Date;
  /** Read at the point of use so a hot-reloaded playbook applies (A 6.1). */
  playbook: () => Pick<Playbook, 'userSide'>;
  /** The live workspace map, for surface labels and bug channels. */
  map: () => Pick<WorkspaceMap, 'surfaces' | 'channels'> | undefined;
  file: FileUxFriction;
  onError?: (error: unknown) => void;
  /** Events per `readSince` page. Default 500. */
  pageSize?: number;
}

export interface UxFriction {
  /** Reads new `user-side` events and files a Task for each pattern now at threshold and not filed this window. Resolves to what it filed. */
  scan(): Promise<UxFrictionTask[]>;
}

/** The cache key of a pattern; one per surface and kind. */
export function frictionKey(surfaceId: string, kind: UserSideKind): string {
  return `ux-friction:${surfaceId}:${kind}`;
}

/** The surface's bug channel: the first explicit channel mapped to it, else the first inferred one. */
export function bugChannelFor(map: Pick<WorkspaceMap, 'channels'>, surfaceId: string): { id: string; name: string } | undefined {
  const mine = map.channels.filter((c) => c.surface === surfaceId);
  const pick = mine.find((c) => c.confidence !== 'inferred') ?? mine[0];
  return pick === undefined ? undefined : { id: pick.id, name: pick.name };
}

/** The Task's summary and description for a pattern. Names no reporter. */
export function describePattern(pattern: FrictionPattern, surfaceLabel: string, channelName: string | undefined): { summary: string; description: string } {
  const count = `${pattern.reporters} reporters`;
  const what = WHAT[pattern.kind];
  const summary = `${count} ${what} on ${surfaceLabel}`;
  const description = [
    `${count} ${what} on ${surfaceLabel} within ${pattern.window}, between ${pattern.firstAt} and ${pattern.lastAt}.`,
    `Each of them was asked to try one thing first (indicator: ${pattern.kind}) and it fixed the problem, so no bug was filed for them. Several people making the same mistake on the same surface points to something in the product that invites it.`,
    channelName === undefined ? undefined : `Posted to ${channelName}.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n\n');
  return { summary, description };
}

interface Bucket {
  workspaceId: string;
  surfaceId: string;
  kind: UserSideKind;
  hits: { reporter: string; at: number }[];
}

export function createUxFriction(deps: UxFrictionDeps): UxFriction {
  const pageSize = deps.pageSize ?? 500;
  let cursor = LOG_START;
  const buckets = new Map<string, Bucket>();

  function observe(event: IncidentEvent): void {
    if (event.type !== 'user-side') return;
    const { kind, surfaceId } = event.payload;
    if (surfaceId === undefined || event.actor === undefined) return;
    const key = frictionKey(surfaceId, kind);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { workspaceId: event.workspaceId, surfaceId, kind, hits: [] };
      buckets.set(key, bucket);
    }
    bucket.workspaceId = event.workspaceId;
    bucket.hits.push({ reporter: event.actor.id, at: Date.parse(event.occurredAt) });
  }

  async function drain(): Promise<void> {
    for (;;) {
      const page = await deps.state.readSince(cursor, pageSize);
      for (const event of page.events) observe(event);
      const moved = page.cursor !== cursor;
      cursor = page.cursor;
      if (!moved || page.events.length === 0) return;
    }
  }

  async function scan(): Promise<UxFrictionTask[]> {
    const { userSide } = deps.playbook();
    if (!userSide.check) return [];
    await drain();

    const windowMs = parseDuration(userSide.uxFrictionWindow);
    const now = deps.clock().getTime();
    const filed: UxFrictionTask[] = [];

    for (const [key, bucket] of [...buckets]) {
      bucket.hits = bucket.hits.filter((h) => h.at > now - windowMs);
      if (bucket.hits.length === 0) {
        buckets.delete(key);
        continue;
      }
      const reporters = new Set(bucket.hits.map((h) => h.reporter));
      if (reporters.size < userSide.uxFrictionThreshold) continue;

      const times = bucket.hits.map((h) => h.at);
      const pattern: FrictionPattern = {
        kind: bucket.kind,
        surfaceId: bucket.surfaceId,
        reporters: reporters.size,
        firstAt: new Date(Math.min(...times)).toISOString(),
        lastAt: new Date(Math.max(...times)).toISOString(),
        window: userSide.uxFrictionWindow,
      };

      const ttlSec = Math.max(1, Math.ceil(windowMs / 1000));
      if (!(await deps.cache.setIfAbsent(key, pattern.lastAt, ttlSec))) continue;

      const map = deps.map();
      const surfaceLabel = map?.surfaces.find((s) => s.id === bucket.surfaceId)?.label ?? bucket.surfaceId;
      const channel = map === undefined ? undefined : bugChannelFor(map, bucket.surfaceId);
      const task: UxFrictionTask = {
        workspaceId: bucket.workspaceId,
        surfaceId: bucket.surfaceId,
        kind: bucket.kind,
        issueType: 'Task',
        labels: [UX_FRICTION_LABEL],
        ...describePattern(pattern, surfaceLabel, channel?.name),
        ...(channel === undefined ? {} : { channelId: channel.id, channelName: channel.name }),
        pattern,
      };
      try {
        await deps.file(task);
        filed.push(task);
      } catch (error) {
        // Give the key back (a one second hold: the cache port has no delete) so the next scan retries.
        await deps.cache.set(key, 'retry', 1).catch(() => undefined);
        deps.onError?.(error);
      }
    }
    return filed;
  }

  return { scan };
}
