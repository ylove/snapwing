// Status pull in Slack (A 4.3, main 15.1): "where are we with this?" asked four ways, answered in
// place through `createStatusQueries(...).respond`.
//
// - `@Snapwing where are we with this?` in a thread: answered in that thread. The thread's incident is
//   the one asked about.
// - `@Snapwing status on the checkout thing` anywhere: answered in a thread under the mention.
// - A direct message that reads as a status question ("what's open on the website?", a bare key):
//   answered in the DM. Any other DM is a capture and goes on to the pipeline untouched.
// - A direct message that asks to be kept posted ("keep me posted on the website", "stop updating me on
//   web"): a standing surface subscription (A 4.4, `signals/standing.ts`), confirmed in the DM. Only when
//   `standing` is given.
// - `/snapwing-status [key or words]` (A 4.3 says `/status`; Slack reserves that name): answered ephemerally to the asker through the command's `response_url`.
//
// `createStatusQueries` is pure over a snapshot and `events(id)` is synchronous, and a thread can match
// through `captured.threadId`, which lives only in the log. So each question first loads the incident
// rows and the logs of the asking channel's open incidents, resolves, then loads the log, claims and
// subscriptions of whatever the resolution named and answers over that. A handful of indexed reads;
// the whole answer stays well under a second.
//
// Only a person's message is a question: Snapwing's own and other bots' are ignored, and a person posting
// through an app (Slack stamps `bot_id` on it) is still a person (`authorship.ts`).
//
// The asker's role comes from the workspace map (`people[].slackId`); an unmapped user is `unknown`
// and so gets the reporter or lead shape, never the engineer one.

import type { IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import type { StatusAnswer, StatusQuery } from '@snapwing/pipeline/contracts/signals.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { applyStandingWatch, parseStandingWatch } from '@snapwing/pipeline/signals/standing.ts';
import { createStatusAsk, looksLikeStatusQuestion, surfaceWords, type StatusReadState } from '@snapwing/pipeline/status/ask.ts';
import { statusMrkdwn, type SlackUserFor } from './cards/status.ts';
import { actions, section, type SlackBlock } from './cards/blocks.ts';
import { isUnlinkGithub, unlinkGithubReply } from '../shared/unlink-github.ts';
import type { GitHubOAuth } from '../../github/oauth.ts';
import { createSlackAuthorOf, type SlackAuthorOf } from './authorship.ts';
import type { SlackWeb } from './web.ts';

/**
 * The manifest's command. Slack reserves `/status` (it sets your own status) and rejects it in
 * `apps.manifest.validate`, so the app registers `/snapwing-status`; `/status` is still accepted for a
 * workspace that routes it here some other way.
 */
export const STATUS_COMMAND = '/snapwing-status';
const STATUS_COMMANDS: ReadonlySet<string> = new Set([STATUS_COMMAND, '/status']);

export type { StatusReadState };

// Re-exported for callers that import the matcher from the Slack module.
export { looksLikeStatusQuestion, surfaceWords };

export interface SlackStatusQueryOptions {
  web: SlackWeb;
  state: StatusReadState;
  workspaceId: string;
  /** The current workspace map; read per question so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** Writes standing subscriptions asked for in a DM; without it such a DM is not intercepted. */
  standing?: Pick<StatePort, 'subscribe' | 'unsubscribe'>;
  /** Answers `unlink github` in a DM (main 11.2); without it such a DM is not intercepted. */
  identity?: Pick<GitHubOAuth, 'disconnect'>;
  /** The bot's own user id (`auth.test`): its messages are ignored and its mention is stripped. */
  botUserId: string;
  /** Who wrote a message (`authorship.ts`). Default: the map and `botUserId` only. */
  authorOf?: SlackAuthorOf;
  clock?: () => Date;
  /** IANA zone for the wall-clock times in an answer. Default UTC. */
  timeZone?: string;
  /** Posts a slash command's reply to its `response_url`. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Most incident rows read per question. Default 500. */
  incidentLimit?: number;
  onError?: (error: unknown) => void;
}

/** A parsed slash command (the fields Slack sends that the answer needs). */
export interface SlackSlashCommand {
  command: string;
  text: string;
  userId: string;
  channelId: string;
  responseUrl: string;
}

export interface SlackStatusQuery {
  /** True when the Events API body (`event_callback`) is a mention or a status-shaped DM this handles. */
  intercepts(parsed: unknown): boolean;
  /** Answers an intercepted event. Never throws; failures go to `onError`. */
  handleEvent(parsed: unknown): Promise<void>;
  /** The `/status` command in a Socket Mode payload or a form body; undefined for anything else. */
  commandOf(raw: { transport: 'http'; body: string } | { transport: 'socket'; payload: unknown }): SlackSlashCommand | undefined;
  /** Answers a slash command. Never throws. */
  handleCommand(command: SlackSlashCommand): Promise<void>;
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

const SLACK_ID = /^[UW][A-Z0-9]{2,}$/;

/** Splits a form body into its fields. */
function formFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function slashCommandOf(fields: Rec): SlackSlashCommand | undefined {
  const command = str(fields['command']);
  if (!STATUS_COMMANDS.has(command)) return undefined;
  const userId = str(fields['user_id']);
  const channelId = str(fields['channel_id']);
  if (userId === '' || channelId === '') return undefined;
  return { command, text: str(fields['text']), userId, channelId, responseUrl: str(fields['response_url']) };
}

interface Request {
  asker: string;
  channelId: string;
  /** The thread the asker is in; absent for a top-level message. */
  threadId?: string;
  /** Where a mention's answer goes: the thread it is in, or the thread its own message starts. */
  replyThread?: string;
  text: string;
  /** A DM that asks for a standing subscription rather than a status. */
  standing?: boolean;
  /** A DM that asks to unlink the asker's GitHub account. */
  unlink?: boolean;
}

export function createSlackStatusQuery(options: SlackStatusQueryOptions): SlackStatusQuery {
  const { web } = options;
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const ask = createStatusAsk(options);
  const seen = new Set<string>();
  const authorOf = options.authorOf ?? createSlackAuthorOf({ botUserId: options.botUserId });

  const mentionOfBot = new RegExp(`<@${options.botUserId.replace(/[^A-Za-z0-9]/g, '')}(?:\\|[^>]*)?>`, 'g');

  function userForMap(map: WorkspaceMap): SlackUserFor {
    return (ref) => {
      const person = map.people.find((p) => p.slackId === ref || p.handle === ref);
      if (person?.slackId !== undefined) return person.slackId;
      return SLACK_ID.test(ref) ? ref : undefined;
    };
  }

  function actorFor(map: WorkspaceMap, slackUserId: string): IncidentActor {
    const person = map.people.find((p) => p.slackId === slackUserId);
    return {
      id: slackUserId,
      name: person?.handle ?? slackUserId,
      ...(person?.email === undefined ? {} : { email: person.email }),
      role: person?.role ?? 'unknown',
    };
  }

  function blocksFor(answer: StatusAnswer, map: WorkspaceMap): { text: string; blocks: SlackBlock[] } {
    const text = statusMrkdwn(answer.text, userForMap(map));
    const blocks: SlackBlock[] = [section(text)];
    // Stop and Revert are the buttons the interactivity handler owns; the rest live on the cards.
    if (answer.audience === 'engineer' && answer.incidentId !== undefined) {
      const id = answer.incidentId;
      const buttons = answer.actions.flatMap((a) =>
        a === 'stop'
          ? [{ label: 'Stop', actionId: 'stop', value: id, style: 'danger' as const }]
          : a === 'revert'
            ? [{ label: 'Revert', actionId: 'revert', value: id }]
            : [],
      );
      if (buttons.length > 0) blocks.push(actions('status_actions', buttons));
    }
    return { text, blocks };
  }

  async function replyTo(request: Request, post: (message: { text: string; blocks: SlackBlock[] }) => Promise<void>): Promise<void> {
    const map = await options.getMap();
    const answer = await ask({
      asker: actorFor(map, request.asker),
      text: request.text,
      context: { channelId: request.channelId, ...(request.threadId === undefined ? {} : { threadId: request.threadId }) },
    });
    await post(blocksFor(answer, map));
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

  /** The request an Events API body carries, or undefined when it is not ours. */
  function requestOf(parsed: unknown): Request | undefined {
    const surfaces = surfaceList;
    const body = rec(parsed);
    if (body['type'] !== 'event_callback') return undefined;
    const event = rec(body['event']);
    const user = str(event['user']);
    const channel = str(event['channel']);
    const ts = str(event['ts']);
    if (user === '' || channel === '' || ts === '' || authorOf.plainly(event) !== undefined) return undefined;
    if (str(event['subtype']) !== '') return undefined;
    const raw = str(event['text']);
    const text = raw.replace(mentionOfBot, ' ').replace(/\s+/g, ' ').trim();
    const threadTs = str(event['thread_ts']);
    if (event['type'] === 'app_mention') {
      return { asker: user, channelId: channel, ...(threadTs === '' ? {} : { threadId: threadTs }), replyThread: threadTs === '' ? ts : threadTs, text };
    }
    if (event['type'] === 'message' && str(event['channel_type']) === 'im' && options.identity !== undefined && isUnlinkGithub(text)) {
      return { asker: user, channelId: channel, text, unlink: true };
    }
    if (event['type'] === 'message' && str(event['channel_type']) === 'im' && options.standing !== undefined && parseStandingWatch(text)?.command === false) {
      return { asker: user, channelId: channel, text, standing: true };
    }
    if (event['type'] === 'message' && str(event['channel_type']) === 'im' && looksLikeStatusQuestion(raw, surfaces)) {
      return { asker: user, channelId: channel, text };
    }
    return undefined;
  }

  return {
    ask,

    intercepts: (parsed) => {
      void refreshSurfaces();
      return requestOf(parsed) !== undefined;
    },

    async handleEvent(parsed) {
      await refreshSurfaces();
      const request = requestOf(parsed);
      if (request === undefined) return;
      const eventId = str(rec(parsed)['event_id']);
      if (eventId !== '') {
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (seen.size > 1000) seen.delete(seen.values().next().value as string);
      }
      try {
        // `intercepts` is synchronous; a `bot_id` on a message from someone the map does not name is
        // settled here, and another bot's question goes unanswered (capture would drop it too).
        if ((await authorOf(rec(rec(parsed)['event']), await options.getMap())) !== 'person') return;
        if (request.unlink === true && options.identity !== undefined) {
          await web.postMessage({ channel: request.channelId, text: await unlinkGithubReply(options.identity, 'slack', request.asker) });
          return;
        }
        if (request.standing === true && options.standing !== undefined) {
          const outcome = await applyStandingWatch(options.standing, await options.getMap(), {
            workspaceId: options.workspaceId,
            userId: request.asker,
            text: request.text,
            channel: 'dm',
            platform: 'slack',
            now: clock(),
          });
          if (outcome.handled) await web.postMessage({ channel: request.channelId, text: outcome.reply });
          return;
        }
        await replyTo(request, async ({ text, blocks }) => {
          // A mention answers in its thread (the mention's own ts starts one); a DM answers in the DM.
          const inThread = request.replyThread === undefined ? {} : { thread_ts: request.replyThread };
          await web.postMessage({ channel: request.channelId, text, blocks, ...inThread });
        });
      } catch (e) {
        onError(e);
      }
    },

    commandOf(raw) {
      if (raw.transport === 'socket') return slashCommandOf(rec(raw.payload));
      return raw.body.startsWith('payload=') || raw.body.startsWith('{') ? undefined : slashCommandOf(formFields(raw.body));
    },

    async handleCommand(command) {
      try {
        await replyTo({ asker: command.userId, channelId: command.channelId, text: command.text.trim() }, async ({ text, blocks }) => {
          if (command.responseUrl !== '') {
            const res = await doFetch(command.responseUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ response_type: 'ephemeral', text, blocks }),
            });
            if (!res.ok) throw new Error(`slack response_url answered ${res.status}`);
            return;
          }
          await web.postEphemeral({ channel: command.channelId, user: command.userId, text, blocks });
        });
      } catch (e) {
        onError(e);
      }
    },
  };
}
