// Status pull in Teams (A 4.3, A 4.4, main 15.2): "where are we with this?" asked four ways, answered in
// place through `createStatusQueries(...).respond`, mirroring `adapters/slack/status-query.ts` (#296).
//
// - `@Snapwing where are we with this?` in a channel thread: answered in that thread. The thread's
//   incident is the one asked about.
// - `@Snapwing status on the checkout thing` anywhere (a channel post, a group chat): answered under the
//   mention (in a channel, a reply to it; the mention's own message starts the thread).
// - A personal-chat message that reads as a status question ("what's open on the website?", a bare key):
//   answered in the personal chat. Any other personal-chat message is a capture and is not intercepted.
// - The `status [key or words]` bot command in the personal chat: answered there. With no words it lists
//   the open incidents on the surface, as Slack's `/snapwing-status` does. `status` counts only alone or
//   with a `?`, a key, or "of/on/for" after it: "status page is down" is a report and is captured.
// - A personal-chat message that asks to be kept posted ("keep me posted on the website", "stop updating
//   me on web"): a standing surface subscription (A 4.4, `signals/standing.ts`), confirmed in the chat.
//   Only when `standing` is given.
//
// `handle(activity)` and `intercepts(activity)` are the shape the transport's `status` route takes
// (`TeamsActivityRoute`).
//
// Only a person's message is a question: Snapwing's own and another bot's (a `28:` id, role `bot`, or no
// AAD object id) are ignored.
//
// The asker's role comes from the workspace map (`people[].teamsId`, the AAD object id); an unmapped
// user is `unknown` and so gets the reporter or lead shape, never the engineer one. A person the answer
// mentions who is not in the map is named as Teams names them (their user record, with `cache`).
//
// `createStatusQueries` is pure over a snapshot and `events(id)` is synchronous, so each question first
// loads the incident rows and the logs of the asking channel's open incidents, resolves, then loads the
// log, claims and subscriptions of whatever the resolution named and answers over that. A handful of
// indexed reads; the whole answer stays well under a second.

import type { IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import type { StatusAnswer, StatusQuery } from '@snapwing/pipeline/contracts/signals.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { isUnlinkGithub, unlinkGithubReply } from '../shared/unlink-github.ts';
import type { GitHubOAuth } from '../../github/oauth.ts';
import { applyStandingWatch, parseStandingWatch } from '@snapwing/pipeline/signals/standing.ts';
import { createStatusAsk, looksLikeStatusQuestion, surfaceWords, type StatusReadState } from '@snapwing/pipeline/status/ask.ts';
import { ADAPTIVE_CARD_CONTENT_TYPE } from './adapter.ts';
import type { TeamsConnector, TeamsOutgoingActivity } from './connector.ts';
import { rememberedNames, splitConversationId } from './conversations.ts';
import { actionSet, card, mentionsFromMap, mentionsOr, renderText, type ActionSpec } from './cards/elements.ts';
import { teamsHtmlToText } from './normalize.ts';

/** The slice of the state port a status question reads. */
export type TeamsStatusReadState = StatusReadState;

export interface TeamsStatusQueryOptions {
  connector: Pick<TeamsConnector, 'sendToConversation' | 'replyToActivity'>;
  state: TeamsStatusReadState;
  workspaceId: string;
  /** The current workspace map; read per question so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** Writes standing subscriptions asked for in the personal chat; without it such a message is not intercepted. */
  standing?: Pick<StatePort, 'subscribe' | 'unsubscribe'>;
  /** Answers `unlink github` in the personal chat (main 11.2); without it such a message is not intercepted. */
  identity?: Pick<GitHubOAuth, 'disconnect'>;
  /** kv: the names Teams gave people the map does not list (their user records). Absent: such a person is `@id`. */
  cache?: Pick<CachePort, 'get'>;
  clock?: () => Date;
  /** IANA zone for the wall-clock times in an answer. Default UTC. */
  timeZone?: string;
  /** Most incident rows read per question. Default 500. */
  incidentLimit?: number;
  onError?: (error: unknown) => void;
}

export interface TeamsStatusQuery {
  /** True for a `message` activity this answers: a mention, a status-shaped personal message, a `status` command, a standing watch. */
  intercepts(activity: unknown): boolean;
  /** Answers an intercepted activity. Never throws; failures go to `onError`. */
  handle(activity: unknown): Promise<void>;
  /** The question itself, for callers that have already resolved who is asking and where. */
  ask(query: StatusQuery): Promise<StatusAnswer>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const STATUS_COMMAND = /^status(?:\s+(.*))?$/i;

interface Request {
  asker: string;
  serviceUrl: string;
  /** Where the question was asked: the bare channel id, or the chat's conversation id. */
  channelId: string;
  /** The channel thread the asker is in; absent for a top-level message and in a chat. */
  threadId?: string;
  text: string;
  kind: 'mention' | 'personal' | 'command' | 'standing' | 'unlink';
  /** The activity answered (a mention's answer is a reply to it). */
  activityId: string;
  /** Mention in a channel: the thread the answer goes in (the thread asked in, else the one the mention starts). */
  replyRoot?: string;
}

export function createTeamsStatusQuery(options: TeamsStatusQueryOptions): TeamsStatusQuery {
  const { connector } = options;
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const ask = createStatusAsk(options);
  const seen = new Set<string>();

  function actorFor(map: WorkspaceMap, aadObjectId: string): IncidentActor {
    const person = map.people.find((p) => p.teamsId === aadObjectId);
    return {
      id: aadObjectId,
      name: person?.handle ?? aadObjectId,
      ...(person?.email === undefined ? {} : { email: person.email }),
      role: person?.role ?? 'unknown',
    };
  }

  /** The answer as a message with one Adaptive Card; an engineer's answer to one incident carries Stop and Revert. */
  async function messageFor(answer: StatusAnswer, map: WorkspaceMap): Promise<TeamsOutgoingActivity> {
    const fromMap = mentionsFromMap(map.people);
    const names =
      options.cache === undefined ? new Map<string, string>() : await rememberedNames(options.cache, answer.text, (id) => fromMap(id) !== undefined);
    const rendered = renderText(answer.text, mentionsOr(fromMap, names));
    // The card's own fallback keeps the escapes, so user markdown (a summary's link) is never live there.
    const fallback = renderText(answer.text, () => undefined).text;
    const wanted: ActionSpec[] =
      answer.audience === 'engineer'
        ? answer.actions.flatMap((a): ActionSpec[] =>
            a === 'stop' ? [{ title: 'Stop', verb: 'stop', style: 'destructive' }] : a === 'revert' ? [{ title: 'Revert', verb: 'revert' }] : [],
          )
        : [];
    const actions = answer.incidentId === undefined || wanted.length === 0 ? [] : actionSet(answer.incidentId, wanted);
    const content = card(fallback, [rendered], actions);
    return { type: 'message', attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content }] };
  }

  /** Whether the activity names this bot in its `entities` (a mention is an entity, not just the `<at>` text). */
  function mentionsBot(activity: Rec): boolean {
    const bot = str(rec(activity['recipient'])['id']);
    const entities = Array.isArray(activity['entities']) ? activity['entities'] : [];
    return bot !== '' && entities.some((e) => str(rec(e)['type']) === 'mention' && str(rec(rec(e)['mentioned'])['id']) === bot);
  }

  /** The message text without the bot's own `<at>` tag, as plain text. */
  function textOf(activity: Rec): string {
    const raw = str(activity['text']);
    const bot = str(rec(activity['recipient'])['id']);
    const name = str(rec(activity['recipient'])['name']);
    const own = (tag: string): boolean => {
      const inner = tag.replace(/<\/?at[^>]*>/gi, '').trim();
      return inner === '' || (name !== '' && inner.toLowerCase() === name.toLowerCase()) || inner === bot;
    };
    const withoutBot = raw.replace(/<at[^>]*>.*?<\/at>/gis, (tag) => (own(tag) ? ' ' : tag));
    return teamsHtmlToText(withoutBot).replace(/\s+/g, ' ').trim();
  }

  // `intercepts` is synchronous, so it reads the surfaces of the last map seen; each call refreshes them.
  let surfaceList: string[] = [];
  async function refreshSurfaces(): Promise<void> {
    try {
      surfaceList = surfaceWords(await options.getMap());
    } catch {
      // keep the last list; the question path reports map errors itself
    }
  }
  void refreshSurfaces();

  /** The request an activity carries, or undefined when it is not ours. */
  function requestOf(activity: unknown): Request | undefined {
    const surfaces = surfaceList;
    const a = rec(activity);
    if (str(a['type']) !== 'message') return undefined;
    const from = rec(a['from']);
    const fromId = str(from['id']);
    const asker = str(from['aadObjectId']);
    // A person has an AAD object id; Snapwing's own messages, `28:` bots, and role `bot` do not count.
    if (asker === '' || fromId === str(rec(a['recipient'])['id']) || fromId.startsWith('28:') || str(from['role']) === 'bot') return undefined;
    const serviceUrl = str(a['serviceUrl']);
    const activityId = str(a['id']);
    const conversation = rec(a['conversation']);
    const conversationId = str(conversation['id']);
    if (serviceUrl === '' || conversationId === '') return undefined;
    const conversationType = str(conversation['conversationType']);
    const text = textOf(a);
    const base = { asker, serviceUrl, activityId };

    if (conversationType === 'personal') {
      if (options.identity !== undefined && isUnlinkGithub(text)) return { ...base, channelId: conversationId, text, kind: 'unlink' };
      if (options.standing !== undefined && parseStandingWatch(text)?.command === false) {
        return { ...base, channelId: conversationId, text, kind: 'standing' };
      }
      const command = STATUS_COMMAND.exec(text);
      if (command !== null && looksLikeStatusQuestion(text, surfaces)) return { ...base, channelId: conversationId, text: (command[1] ?? '').trim(), kind: 'command' };
      if (looksLikeStatusQuestion(text, surfaces)) return { ...base, channelId: conversationId, text, kind: 'personal' };
      return undefined;
    }

    // A channel or group chat: only a message that names the bot is a question.
    if (!mentionsBot(a)) return undefined;
    // Only a status question or a bare key is ours; any other mention (`queue`, "I'll take this") falls through
    // to the commands and the signals, as Slack's plain `message` event does.
    if (!looksLikeStatusQuestion(text, surfaces)) return undefined;
    if (conversationType === 'groupChat') return { ...base, channelId: conversationId, text, kind: 'mention' };
    const split = splitConversationId(conversationId);
    const channelId = str(rec(rec(a['channelData'])['channel'])['id']) || split.channelId;
    // A reply carries its thread root; a top-level post's own id is the root of the thread it starts.
    const threadId = str(a['replyToId']) || (split.threadRootId !== undefined && split.threadRootId !== activityId ? split.threadRootId : '');
    return {
      ...base,
      channelId,
      ...(threadId === '' ? {} : { threadId }),
      text,
      kind: 'mention',
      replyRoot: threadId === '' ? activityId : threadId,
    };
  }

  async function post(request: Request, message: TeamsOutgoingActivity): Promise<void> {
    if (request.kind !== 'mention') {
      await connector.sendToConversation({ serviceUrl: request.serviceUrl, conversationId: request.channelId }, message);
      return;
    }
    await connector.replyToActivity(
      {
        serviceUrl: request.serviceUrl,
        conversationId: request.channelId,
        activityId: request.activityId,
        ...(request.replyRoot === undefined ? {} : { threadRootId: request.replyRoot }),
      },
      message,
    );
  }

  return {
    ask,

    intercepts: (activity) => {
      void refreshSurfaces();
      return requestOf(activity) !== undefined;
    },

    async handle(activity) {
      await refreshSurfaces();
      const request = requestOf(activity);
      if (request === undefined) return;
      // Teams redelivers an activity it did not get a timely 200 for.
      if (request.activityId !== '') {
        const key = `${request.channelId}:${request.activityId}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > 1000) seen.delete(seen.values().next().value as string);
      }
      try {
        const map = await options.getMap();
        if (request.kind === 'unlink' && options.identity !== undefined) {
          await post(request, { type: 'message', text: await unlinkGithubReply(options.identity, 'teams', request.asker) });
          return;
        }
        if (request.kind === 'standing' && options.standing !== undefined) {
          const outcome = await applyStandingWatch(options.standing, map, {
            workspaceId: options.workspaceId,
            userId: request.asker,
            text: request.text,
            channel: 'dm',
            platform: 'teams',
            now: clock(),
          });
          if (outcome.handled) await post(request, { type: 'message', text: outcome.reply });
          return;
        }
        // `status` alone has no channel to read a surface from; a one-surface workspace means that surface.
        const only = map.surfaces.length === 1 ? map.surfaces[0] : undefined;
        const text = request.kind === 'command' && request.text === '' && only !== undefined ? only.label : request.text;
        const answer = await ask({
          asker: actorFor(map, request.asker),
          text,
          context: { channelId: request.channelId, ...(request.threadId === undefined ? {} : { threadId: request.threadId }) },
        });
        await post(request, await messageFor(answer, map));
      } catch (e) {
        onError(e);
      }
    },
  };
}
