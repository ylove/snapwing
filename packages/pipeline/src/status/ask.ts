// The status question, platform-neutral (A 4.3): load the incidents, resolve the question, load the log,
// claims and subscriptions of whatever the resolution named, and answer. Shared by the Slack and Teams
// adapters; anything chat-specific (who is asking, how the answer is drawn) stays in them.
//
// `createStatusQueries` is pure over a snapshot and `events(id)` is synchronous, and a thread can match
// through `captured.threadId`, which lives only in the log. So each question first loads the incident
// rows and the logs of the asking channel's open incidents, resolves, then loads the log, claims and
// subscriptions of whatever the resolution named and answers over that. A handful of indexed reads; the
// whole answer stays well under a second.
//
// With `access` (A 4.3, #272) an answer covers only what the asker may see: an incident from a channel
// they are in, one they reported or own, and one with no chat channel (a CLI or Raycast capture). A map
// person counts as in a channel when either of their ids is in it (#301): for an incident on the other
// platform, `access.other` checks the id the map gives them there. Anyone the map lists on one platform
// only never sees the other platform's channels. `askerMayAsk` is false for a guest or someone from
// another organization, whom the adapters answer with `GUESTS_GET_NO_STATUS` instead.

import type { IncidentEvent } from '../contracts/events.ts';
import type { StatusAnswer, StatusQuery } from '../contracts/signals.ts';
import type { IncidentActor } from '../contracts/incident.ts';
import type { Claim, IncidentView, Subscription } from '../contracts/state.ts';
import { isTerminalStatus } from '../lifecycle/machine.ts';
import type { MapPerson, WorkspaceMap } from '../map/types.ts';
import type { Membership } from '../policy/autonomy.ts';
import type { ChatPlatform, StatePort } from '../ports/state.ts';
import { createStatusQueries, type QueryResolution } from './query.ts';

/** The slice of the state port a status question reads. */
export type StatusReadState = Pick<StatePort, 'findIncidents' | 'read' | 'getClaims' | 'getSubscriptions'>;

export interface StatusAskOptions {
  state: StatusReadState;
  workspaceId: string;
  /** The current workspace map; read per question so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  clock?: () => Date;
  /** IANA zone for the wall-clock times in an answer. Default UTC. */
  timeZone?: string;
  /** Most incident rows read per question. Default 500. */
  incidentLimit?: number;
  /** Scopes each answer to what the asker may see (see the file header). Absent: everything. */
  access?: StatusAccess;
}

/** Who may hear about what (#272), on one chat platform. */
export interface StatusAccess {
  platform: ChatPlatform;
  /** Member, guest, or external; only a member gets status answers. */
  membership(userId: string): Promise<Membership>;
  /** Whether the user is in the channel now (a short cache is fine). */
  inChannel(channelId: string, userId: string): Promise<boolean>;
  /** The other chat platform's channel check, when it is configured (#301). */
  other?: Pick<StatusAccess, 'platform' | 'inChannel'>;
}

/** What a guest or external person is told when they ask for a status. */
export const GUESTS_GET_NO_STATUS = 'Status answers are for members of this workspace.';

/** Whether the asker gets status answers at all: true without `access`. */
export async function askerMayAsk(access: Pick<StatusAccess, 'membership'> | undefined, userId: string): Promise<boolean> {
  return access === undefined || (await access.membership(userId).catch(() => 'external' as const)) === 'member';
}

/** How long `briefMembers` trusts a channel's member list. */
export const MEMBERS_TTL_MS = 60_000;
/** Channels `briefMembers` remembers before the oldest is dropped. */
const MAX_CHANNELS = 500;

/**
 * `StatusAccess.inChannel` over a platform's live member list, remembered for `MEMBERS_TTL_MS`. A list
 * that cannot be read (any error) has nobody in it.
 */
export function briefMembers(list: (channelId: string) => Promise<Iterable<string>>, clock: () => Date = () => new Date()): StatusAccess['inChannel'] {
  const known = new Map<string, { at: number; members: Promise<ReadonlySet<string>> }>();
  return async (channelId, userId) => {
    const now = clock().getTime();
    let entry = known.get(channelId);
    if (entry === undefined || now - entry.at >= MEMBERS_TTL_MS) {
      entry = { at: now, members: list(channelId).then((m) => new Set(m), () => new Set<string>()) };
      known.delete(channelId);
      known.set(channelId, entry);
      if (known.size > MAX_CHANNELS) known.delete(known.keys().next().value as string);
    }
    return (await entry.members).has(userId);
  };
}

/** The incidents `asker` may hear about (see the file header). */
export async function visibleTo(
  access: StatusAccess,
  asker: IncidentActor,
  incidents: readonly IncidentView[],
  map?: Pick<WorkspaceMap, 'people'>,
): Promise<IncidentView[]> {
  // The asker's id on each platform: theirs here, and the map's on the other one (#301).
  const idOn = (platform: ChatPlatform, person: MapPerson): string | undefined => (platform === 'slack' ? person.slackId : person.teamsId);
  const person = map?.people.find((p) => idOn(access.platform, p) === asker.id);
  const elsewhere = access.other !== undefined && person !== undefined ? idOn(access.other.platform, person) : undefined;
  const checks = new Map<string, Promise<boolean>>();
  const inChannel = (check: Pick<StatusAccess, 'platform' | 'inChannel'>, channelId: string, userId: string): Promise<boolean> => {
    const key = `${check.platform}:${channelId}`;
    let known = checks.get(key);
    if (known === undefined) {
      known = check.inChannel(channelId, userId).catch(() => false);
      checks.set(key, known);
    }
    return known;
  };
  const mine = (id: string | undefined): boolean => id !== undefined && (id === asker.id || id === elsewhere);
  const seen = await Promise.all(
    incidents.map(async (i) => {
      const chat = i.source === 'slack' || i.source === 'teams';
      if (!chat || i.channelId === undefined || mine(i.reporterId) || (i.ownerRef !== undefined && i.ownerRef === asker.name)) return true;
      if (i.source === access.platform) return inChannel(access, i.channelId, asker.id);
      return access.other?.platform === i.source && elsewhere !== undefined && elsewhere !== '' && (await inChannel(access.other, i.channelId, elsewhere));
    }),
  );
  return incidents.filter((_, n) => seen[n] === true);
}

const JIRA_KEY_ONLY = /^[A-Z][A-Z0-9]+-\d+\s*[?!.]*$/i;
const STATUS_WORDS =
  /^(?:(?:hey|hi|hello|please|pls|can you|could you|tell me|do you know)[,\s]+)*(?:status(?=\s*[?!.]*$|\s+(?:of|on|for)\b|\s+[A-Z][A-Z0-9]+-\d+)|what'?s (?:the )?(?:status|open|up|going on|happening|left|blocking)|what is (?:the )?(?:status|open|going on|happening|left|blocking)|what are we|where (?:are|do) we|where'?s |where is |how'?s |how is |how are we|any (?:update|news|progress)|updates? on|progress on|is .+ (?:fixed|done|live|merged|deployed)\b|did .+ (?:merge|ship|deploy|land)\b)/i;

/**
 * Whether DM text reads as a status question rather than a bug report to capture. `status` counts only
 * as the whole text, with a `?`, a Jira key, "of/on/for", or (given `surfaces`) exactly a surface id or
 * name after it: "status page is down" is a report.
 */
export function looksLikeStatusQuestion(text: string, surfaces?: readonly string[]): boolean {
  const t = text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === '') return false;
  if (JIRA_KEY_ONLY.test(t) || STATUS_WORDS.test(t)) return true;
  if (surfaces === undefined || surfaces.length === 0) return false;
  // `status web`, `status Website?`: the words after `status` are exactly a surface id or name.
  const named = /^(?:(?:hey|hi|hello|please|pls|can you|could you|tell me|do you know)[,\s]+)*status\s+(.+?)\s*[?!.]*$/i.exec(t);
  return named?.[1] !== undefined && surfaces.some((name) => name.toLowerCase() === named[1]?.toLowerCase());
}

/** The ids and names of the map's surfaces, for `looksLikeStatusQuestion`. */
export function surfaceWords(map: WorkspaceMap): string[] {
  return map.surfaces.flatMap((s) => [s.id, s.label]);
}

/** The incidents a resolution is about, whose logs, claims and watchers the answer reads. */
function involved(found: QueryResolution): IncidentView[] {
  switch (found.kind) {
    case 'incident':
      return [found.incident];
    case 'surface':
      return found.incidents;
    case 'tie':
      return [];
    case 'none':
      return [];
  }
}

/** The status question as a function of the asker's query. */
export function createStatusAsk(options: StatusAskOptions): (query: StatusQuery) => Promise<StatusAnswer> {
  const { state } = options;
  const clock = options.clock ?? (() => new Date());
  const limit = options.incidentLimit ?? 500;

  async function logsOf(incidents: readonly IncidentView[], into: Map<string, IncidentEvent[]>): Promise<void> {
    const missing = incidents.filter((i) => !into.has(i.id));
    const reads = await Promise.all(missing.map(async (i) => [i.id, await state.read(i.id)] as const));
    for (const [id, events] of reads) into.set(id, events);
  }

  return async (query) => {
    const map = await options.getMap();
    const rows = await state.findIncidents({ workspaceId: options.workspaceId, limit });
    const incidents = options.access === undefined ? rows : await visibleTo(options.access, query.asker, rows, map);
    const logs = new Map<string, IncidentEvent[]>();
    // The asking channel's open incidents: a thread can match only through `captured.threadId` in the log.
    const channelId = query.context.channelId;
    await logsOf(
      incidents.filter((i) => !isTerminalStatus(i.status) && (channelId === undefined || i.channelId === undefined || i.channelId === channelId)),
      logs,
    );
    const base = { incidents, map, now: clock(), ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }) };
    const events = (id: string): readonly IncidentEvent[] => logs.get(id) ?? [];
    const found = createStatusQueries({ ...base, events }).resolveQuery(query);

    // Second pass: what the answer itself reads, for the incidents it names.
    const named = involved(found);
    await logsOf(named, logs);
    const claims: Claim[] = [];
    const subscriptions: Subscription[] = [];
    await Promise.all(
      named.map(async (i) => {
        const [c, s] = await Promise.all([state.getClaims(i.id), state.getSubscriptions(i.id)]);
        claims.push(...c);
        for (const sub of s) {
          if (!subscriptions.some((x) => x.userId === sub.userId && x.scopeKind === sub.scopeKind && x.scopeId === sub.scopeId)) subscriptions.push(sub);
        }
      }),
    );
    return createStatusQueries({ ...base, events, claims, subscriptions }).respond(query);
  };
}
