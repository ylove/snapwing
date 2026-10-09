// Teams transport (main 14.1, 15.2, ADR 0016): the HTTP handlers for the Bot Framework messaging
// endpoint and the Graph change notifications, mirroring `adapters/slack/transport.ts`. Teams has no
// Socket Mode, so a local run needs a dev tunnel (`devtunnel` or `ngrok`, main 15.2 local development row)
// pointing at these routes.
//
// - `POST /teams/messages`: authenticates first (the adapter's Bot Framework JWT check, with the
//   activity's `serviceUrl` and `channelId: 'msteams'`; any other channel, a body that is not an activity,
//   or a token that fails is 401 and touches nothing), then dispatches by activity type to injected handlers:
//   - `message`: the bot's own messages are dropped; then the status pull (@mention status questions,
//     status-shaped personal messages), the bot commands (`queue`), a personal-chat capture through
//     `handleInbound`, and last the signals (channel thread replies, read under the RSC grant).
//   - `invoke` `adaptiveCard/action` (Universal Actions): the interactivity, answered with the refreshed
//     card it returns. `composeExtension/fetchTask` and `submitAction`: `handleInbound`, answered with the
//     adapter's task message. Any other invoke is 501, as the Bot Framework SDK answers it.
//   - `messageReaction` (Bot Framework sends it only for the bot's own messages): the signals.
//   - `installationUpdate` and `conversationUpdate`: the RSC mode check (`createTeamsModeCheck`) and the
//     queue's first card on a personal install.
// - Budget: Teams waits 5 s for an invoke. The dispatcher only authenticates, normalizes, and hands off; an
//   invoke's downstream is raced against `invokeBudgetMs` (default 4 s, leaving room for the network), and
//   when it is slower the invoke is answered anyway (the interactivity with "Working on it", the action
//   command with the adapter's "On it" task message) while the work finishes behind the answer. The
//   interactivity is told (`TeamsInvokeBudget`), so a refusal that lands after "Working on it" reaches the
//   tapper in their personal chat instead of on a card nobody sees. Handlers
//   that answer nothing (status, commands, signals, mode check) run after the 200, as Slack's do.
// - Tenant: with `tenantId` (the install's, `TEAMS_TENANT_ID`), an authenticated activity whose tenant
//   (`channelData.tenant.id`, `conversation.tenantId`) is another, or that names none, is ignored: a 200
//   and one log line; nothing is captured, tapped, read as a signal, or answered (#269).
// - `POST /teams/notifications` and `POST /teams/lifecycle` (Graph): the `validationToken` handshake
//   is answered with the token (capped and checked, `subscriptions.ts`); otherwise only notifications whose `clientState` matches are kept (a body
//   where none matches is 403 and touches nothing) and Graph gets its 202 at once. Change notifications go
//   to the signals (#7 diffs the reactions); lifecycle notifications to `handleLifecycle`, whose outcomes
//   (a `missed` one means resync) go to `onLifecycle`.
//
// The RSC mode check writes kv `teams-mode:{teamId}` (`full` or `reduced`, `conversations.ts`), which puts
// the reduced-mode banner on every card in that team (ADR 0005). It reads the team's RSC grants for this
// app; without the permission to read grants it probes one channel's messages instead.

import type { ChannelSource } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import { SMALL_BODY_BYTES, type Route } from '../../server/http.ts';
import { ACK_TEXT, ADAPTIVE_CARD_CONTENT_TYPE, type TeamsAck, type TeamsAdapter, type TeamsInbound } from './adapter.ts';
import { writeTeamsMode, type TeamsMode } from './conversations.ts';
import { GRAPH_PERMISSIONS, GraphPermissionError, type TeamsGraph } from './graph.ts';
import { TEAMS_FETCH_TASK, TEAMS_SUBMIT_ACTION } from './normalize.ts';
import type { TeamsQueue } from './queue.ts';
import type { LifecycleOutcome, TeamsSubscriptions, VerifiedNotification } from './subscriptions.ts';

export const TEAMS_MESSAGES_PATH = '/teams/messages';
export const TEAMS_NOTIFICATIONS_PATH = '/teams/notifications';
export const TEAMS_LIFECYCLE_PATH = '/teams/lifecycle';

/** The Bot Framework channel id of every Teams activity; the JWT key must endorse it. */
export const TEAMS_CHANNEL_ID = 'msteams';
/** Teams gives an invoke 5 s; the dispatcher answers within this much and lets the rest finish after. */
export const TEAMS_INVOKE_BUDGET_MS = 4000;
export const TEAMS_CARD_ACTION = 'adaptiveCard/action';
/** The invoke answer when the interactivity is slower than the budget. */
export const TEAMS_BUSY_TEXT = 'Working on it';
/** The invoke answer when the interactivity failed. */
export const TEAMS_FAILED_TEXT = 'Something went wrong. Try again in a moment.';
/** The RSC permissions without which a team runs in reduced mode (main 15.2, ADR 0005). */
export const TEAMS_REQUIRED_RSC: readonly string[] = [GRAPH_PERMISSIONS.history];

/** An Adaptive Card the interactivity answers a tap with (cards from `cards/` and the queue card both fit). */
export interface TeamsInvokeCard {
  type: 'AdaptiveCard';
}

/** The body of an `adaptiveCard/action` invoke response (Universal Actions). */
export type TeamsInvokeResponse =
  | { statusCode: 200; type: typeof ADAPTIVE_CARD_CONTENT_TYPE; value: TeamsInvokeCard }
  | { statusCode: 200; type: 'application/vnd.microsoft.activity.message'; value: string }
  | { statusCode: 500; type: 'application/vnd.microsoft.error'; value: { code: string; message: string } };

/** A handler the dispatcher picks by a synchronous check after authentication. */
export interface TeamsActivityRoute {
  intercepts(activity: unknown): boolean;
  /** Runs after the answer; a throw goes to `onError`. */
  handle(activity: unknown): Promise<void> | void;
}

/** What the dispatcher tells a tap's handler about the invoke it is answering. */
export interface TeamsInvokeBudget {
  /** True once the invoke was answered without the handler's card ("Working on it", past the budget). */
  expired(): boolean;
}

/** Universal Actions taps (#6). */
export interface TeamsInteractivity {
  /**
   * The refreshed card (who chose what, or the same card with a one-line reason); undefined answers with no
   * card. `budget` says whether that card can still be shown: past it, a refusal must reach the tapper another way.
   */
  onAction(activity: unknown, budget?: TeamsInvokeBudget): Promise<TeamsInvokeCard | undefined>;
}

/** Signals (#7): reactions on the bot's messages, channel thread replies, and the Graph reaction diff. */
export interface TeamsSignalsRoute {
  /** True for a `message` activity the signals read (a person's channel thread reply). */
  observes(activity: unknown): boolean;
  /** A `messageReaction` activity, or a message `observes` accepted. */
  onActivity(activity: unknown): Promise<void> | void;
  /** Change notifications whose `clientState` matched. */
  onNotifications(notifications: readonly VerifiedNotification[]): Promise<void> | void;
}

export interface TeamsDispatchResult {
  status: number;
  /** Serialized as JSON when present. */
  body?: unknown;
}

export interface TeamsDispatcherOptions {
  adapter: Pick<TeamsAdapter, 'authenticateRequest' | 'normalizeResult'>;
  /** `IncidentOrchestrator.handleInbound`: authenticate, normalize, dedupe, enqueue, acknowledge (a `TeamsAck`). */
  handleInbound: (source: ChannelSource, raw: TeamsInbound) => Promise<unknown>;
  /** Status questions (#9): @mentions, status-shaped personal messages, the `status` command. */
  status?: TeamsActivityRoute;
  /** Bot commands (`queue`), checked in order after the status pull. */
  commands?: readonly TeamsActivityRoute[];
  interactivity?: TeamsInteractivity;
  signals?: TeamsSignalsRoute;
  /** Installation and conversation updates: the RSC mode check, the queue's install card. Every match runs. */
  installs?: readonly TeamsActivityRoute[];
  /** Graph change-notification subscriptions. Absent: the notification routes answer 404. */
  subscriptions?: Pick<TeamsSubscriptions, 'handleValidation' | 'verifyNotification' | 'handleLifecycle'>;
  /** Lifecycle outcomes (a `missed` one means the signals should resync). */
  onLifecycle?: (outcomes: readonly LifecycleOutcome[]) => Promise<void> | void;
  /** Default {@link TEAMS_INVOKE_BUDGET_MS}. */
  invokeBudgetMs?: number;
  /** The install's tenant (`TEAMS_TENANT_ID`). An activity from any other tenant, or naming none, is ignored. Absent: not checked. */
  tenantId?: string;
  /** One line for each activity the tenant check ignores. */
  log?: (line: string) => void;
  onError?: (error: unknown) => void;
}

export interface TeamsDispatcher {
  /** `POST /teams/messages`: the Authorization header and the exact body. */
  dispatch(raw: { headers: Headers; body: string }): Promise<TeamsDispatchResult>;
  /**
   * Routes an activity that is already authenticated. Test seam for the e2e world (#20), which hands
   * activities past authentication as the Slack e2e hands envelopes to Socket Mode; never mounted.
   */
  route(inbound: Extract<TeamsInbound, { transport: 'http' }>): Promise<TeamsDispatchResult>;
  /** `POST /teams/notifications`. */
  notifications(req: Request): Promise<Response>;
  /** `POST /teams/lifecycle`. */
  lifecycle(req: Request): Promise<Response>;
  /** Resolves when the work started so far has settled (tests, shutdown). */
  idle(): Promise<void>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const empty = (status: number): TeamsDispatchResult => ({ status });

function cardResponse(card: TeamsInvokeCard): TeamsInvokeResponse {
  return { statusCode: 200, type: ADAPTIVE_CARD_CONTENT_TYPE, value: card };
}
function messageResponse(text: string): TeamsInvokeResponse {
  return { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: text };
}
const failedResponse: TeamsInvokeResponse = { statusCode: 500, type: 'application/vnd.microsoft.error', value: { code: 'InternalError', message: TEAMS_FAILED_TEXT } };

/** True when this bot sent the activity (its `from` is the recipient, `28:{appId}`). Other bots are normalize's to drop. */
function fromBot(activity: Rec): boolean {
  const from = str(rec(activity['from'])['id']);
  return from !== '' && from === str(rec(activity['recipient'])['id']);
}

/** The tenants an activity names (`channelData.tenant.id`, `conversation.tenantId`), lower-cased, once each; empty when it names none. */
function tenantsOf(activity: Rec): string[] {
  const named = [str(rec(rec(activity['channelData'])['tenant'])['id']), str(rec(activity['conversation'])['tenantId'])];
  return [...new Set(named.filter((t) => t !== '').map((t) => t.toLowerCase()))];
}

function isAck(v: unknown): v is TeamsAck {
  return typeof rec(v)['status'] === 'number';
}

type Raced<T> = { done: true; value: T } | { done: false };

export function createTeamsDispatcher(options: TeamsDispatcherOptions): TeamsDispatcher {
  const { adapter } = options;
  const onError = options.onError ?? (() => undefined);
  const budgetMs = options.invokeBudgetMs ?? TEAMS_INVOKE_BUDGET_MS;
  const installTenant = options.tenantId?.trim().toLowerCase() || undefined;
  const inFlight = new Set<Promise<unknown>>();

  /** True when the activity is from the install's tenant (or no tenant is configured). */
  function fromInstallTenant(activity: Rec): boolean {
    if (installTenant === undefined) return true;
    const tenants = tenantsOf(activity);
    return tenants.length > 0 && tenants.every((t) => t === installTenant);
  }

  function track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
    return work;
  }

  /** Runs `work` after the answer; a throw goes to `onError`. */
  function runAfter(work: () => Promise<void> | void): void {
    track(Promise.resolve().then(work)).catch(onError);
  }

  /**
   * Races `work` against the invoke budget; `onExpired` runs the moment the budget wins. A throw inside the
   * budget rejects; one after it goes to `onError`.
   */
  async function withinBudget<T>(work: Promise<T>, onExpired?: () => void): Promise<Raced<T>> {
    const tracked = track(work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Raced<T>>((resolve) => {
      timer = setTimeout(() => {
        onExpired?.();
        resolve({ done: false });
      }, budgetMs);
    });
    try {
      const finished = tracked.then((value): Raced<T> => ({ done: true, value }));
      const raced = await Promise.race([finished, timeout]);
      // The answer has gone; a later failure has no one to tell but `onError`.
      if (!raced.done) finished.catch(onError);
      return raced;
    } finally {
      clearTimeout(timer);
    }
  }

  async function capture(inbound: TeamsInbound): Promise<TeamsDispatchResult> {
    try {
      const result = await adapter.normalizeResult(inbound);
      if (result.kind === 'ignored') return empty(200);
      await options.handleInbound('teams', inbound);
      return empty(200);
    } catch (e) {
      onError(e);
      return empty(500);
    }
  }

  async function actionCommand(inbound: TeamsInbound): Promise<TeamsDispatchResult> {
    const ackOf = (v: unknown): TeamsDispatchResult => (isAck(v) ? { status: v.status, ...(v.body === undefined ? {} : { body: v.body }) } : empty(200));
    const handOff = (async (): Promise<TeamsDispatchResult> => {
      const result = await adapter.normalizeResult(inbound);
      if (result.kind === 'ignored') return empty(200);
      return ackOf(await options.handleInbound('teams', inbound));
    })();
    try {
      const raced = await withinBudget(handOff);
      // Slower than the budget: the capture is still on its way (the idempotency key makes it safe), so
      // answer the way the adapter would have.
      return raced.done ? raced.value : { status: 200, body: { task: { type: 'message', value: ACK_TEXT } } };
    } catch (e) {
      onError(e);
      return empty(500);
    }
  }

  async function cardAction(activity: unknown): Promise<TeamsDispatchResult> {
    const interactivity = options.interactivity;
    if (interactivity === undefined) return empty(501);
    // Set before "Working on it" goes out, so a refusal that lands later knows its card will never be shown.
    let expired = false;
    const budget: TeamsInvokeBudget = { expired: () => expired };
    try {
      const raced = await withinBudget(
        Promise.resolve().then(() => interactivity.onAction(activity, budget)),
        () => {
          expired = true;
        },
      );
      if (!raced.done) return { status: 200, body: messageResponse(TEAMS_BUSY_TEXT) };
      return { status: 200, body: raced.value === undefined ? messageResponse('') : cardResponse(raced.value) };
    } catch (e) {
      onError(e);
      return { status: 200, body: failedResponse };
    }
  }

  async function message(inbound: Extract<TeamsInbound, { transport: 'http' }>, activity: Rec): Promise<TeamsDispatchResult> {
    if (fromBot(activity)) return empty(200);
    const status = options.status;
    if (status?.intercepts(activity) === true) {
      runAfter(() => status.handle(activity));
      return empty(200);
    }
    const command = options.commands?.find((c) => c.intercepts(activity));
    if (command !== undefined) {
      runAfter(() => command.handle(activity));
      return empty(200);
    }
    const signals = options.signals;
    if (signals?.observes(activity) === true) {
      // A person's channel thread reply is never a capture (normalize ignores it), so it goes to the signals.
      runAfter(() => signals.onActivity(activity));
      return empty(200);
    }
    return capture(inbound);
  }

  async function route(inbound: Extract<TeamsInbound, { transport: 'http' }>): Promise<TeamsDispatchResult> {
    const activity = rec(inbound.activity);
    const type = str(activity['type']);
    if (!fromInstallTenant(activity)) {
      const named = tenantsOf(activity).map((t) => t.replace(/[^\w-]/g, '?').slice(0, 64));
      options.log?.(`teams: ignored a ${type.replace(/[^\w]/g, '?').slice(0, 32) || 'typeless'} activity from ${named.length === 0 ? 'no tenant' : `tenant ${named.join(', ')}`}, not the install's`);
      return empty(200);
    }
    if (type === 'message') return message(inbound, activity);
    if (type === 'invoke') {
      const name = str(activity['name']);
      if (name === TEAMS_CARD_ACTION) return cardAction(activity);
      if (name === TEAMS_FETCH_TASK || name === TEAMS_SUBMIT_ACTION) return actionCommand(inbound);
      return empty(501);
    }
    if (type === 'messageReaction') {
      const signals = options.signals;
      if (signals !== undefined && !fromBot(activity)) runAfter(() => signals.onActivity(activity));
      return empty(200);
    }
    if (type === 'installationUpdate' || type === 'conversationUpdate') {
      for (const install of options.installs ?? []) {
        if (install.intercepts(activity)) runAfter(() => install.handle(activity));
      }
      return empty(200);
    }
    return empty(200);
  }

  /** The verified notifications of a Graph POST, or the response that ends it (handshake, bad body, forged). */
  async function graphBody(req: Request): Promise<{ response: Response } | { body: unknown; verified: VerifiedNotification[] }> {
    const subscriptions = options.subscriptions;
    if (subscriptions === undefined) return { response: new Response('', { status: 404 }) };
    const handshake = subscriptions.handleValidation(req);
    if (handshake !== undefined) return { response: handshake };
    const body = parseJson(await req.text());
    if (!Array.isArray(rec(body)['value'])) return { response: new Response('', { status: 400 }) };
    const verified = subscriptions.verifyNotification(body);
    // Nothing carries our clientState: not from Graph, so nothing is read or written.
    if (verified.length === 0) return { response: new Response('', { status: 403 }) };
    return { body, verified };
  }

  const accepted = (): Response => new Response('', { status: 202 });

  return {
    async dispatch(raw) {
      const activity = parseJson(raw.body);
      if (typeof activity !== 'object' || activity === null || Array.isArray(activity)) return empty(401);
      // Teams only: the key must endorse `msteams`, and an activity naming another channel never reaches the check.
      if (str((activity as Rec)['channelId']) !== TEAMS_CHANNEL_ID) return empty(401);
      const inbound = { transport: 'http' as const, headers: raw.headers, activity };
      if (!(await adapter.authenticateRequest(inbound))) return empty(401);
      return route(inbound);
    },
    route,
    async notifications(req) {
      const parsed = await graphBody(req);
      if ('response' in parsed) return parsed.response;
      const signals = options.signals;
      // Graph wants its 2xx within 3 s; the diff runs after.
      if (signals !== undefined) runAfter(() => signals.onNotifications(parsed.verified));
      return accepted();
    },
    async lifecycle(req) {
      const parsed = await graphBody(req);
      if ('response' in parsed) return parsed.response;
      const subscriptions = options.subscriptions;
      if (subscriptions !== undefined) {
        runAfter(async () => {
          const outcomes = await subscriptions.handleLifecycle(parsed.body);
          await options.onLifecycle?.(outcomes);
        });
      }
      return accepted();
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

function toResponse(r: TeamsDispatchResult): Response {
  if (r.body === undefined) return new Response('', { status: r.status });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** The three routes. The messaging endpoint reads the body as text once and parses that. */
export function createTeamsRoutes(dispatcher: TeamsDispatcher): Route[] {
  return [
    {
      method: 'POST',
      path: TEAMS_MESSAGES_PATH,
      handler: async (req) => toResponse(await dispatcher.dispatch({ headers: req.headers, body: await req.text() })),
      maxBodyBytes: SMALL_BODY_BYTES,
    },
    { method: 'POST', path: TEAMS_NOTIFICATIONS_PATH, handler: (req) => dispatcher.notifications(req), maxBodyBytes: SMALL_BODY_BYTES },
    { method: 'POST', path: TEAMS_LIFECYCLE_PATH, handler: (req) => dispatcher.lifecycle(req), maxBodyBytes: SMALL_BODY_BYTES },
  ];
}

export interface TeamsTransport {
  readonly dispatcher: TeamsDispatcher;
  /** HTTP routes for the API process (there is no Socket Mode for Teams). */
  readonly routes: readonly Route[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The dispatcher and its routes; `stop` waits for the work started behind the answers. */
export function createTeamsTransport(options: TeamsDispatcherOptions): TeamsTransport {
  const dispatcher = createTeamsDispatcher(options);
  return { dispatcher, routes: createTeamsRoutes(dispatcher), start: () => Promise.resolve(), stop: () => dispatcher.idle() };
}

/** The queue as the dispatcher's routes: the `queue` command and the personal install card. */
export function teamsQueueRoutes(queue: Pick<TeamsQueue, 'isQueueCommand' | 'handleCommand' | 'isInstall' | 'handleInstall'>): {
  command: TeamsActivityRoute;
  install: TeamsActivityRoute;
} {
  return {
    command: { intercepts: (a) => queue.isQueueCommand(a), handle: (a) => queue.handleCommand(a) },
    install: { intercepts: (a) => queue.isInstall(a), handle: (a) => queue.handleInstall(a) },
  };
}

// The RSC mode check ------------------------------------------------------------------------------

export interface TeamsModeCheckOptions {
  graph: Pick<TeamsGraph, 'rscGrants' | 'channelMessages'>;
  cache: Pick<CachePort, 'set'>;
  /** The bot's Microsoft app id: the grants' `clientAppId`. */
  appId: string;
  /** The team of a channel the activity does not name a team for. */
  getMap?: () => Promise<WorkspaceMap>;
  /** Default {@link TEAMS_REQUIRED_RSC}. */
  required?: readonly string[];
  onError?: (error: unknown) => void;
}

export interface TeamsModeCheck extends TeamsActivityRoute {
  /** Reads the team's grants and writes kv `teams-mode:{teamId}`; undefined (nothing written) when Graph cannot say. */
  check(teamId: string, channelId?: string): Promise<TeamsMode | undefined>;
}

/** The team and a channel of an installation or conversation update in a team, else undefined. */
function teamOf(activity: Rec): { teamId?: string; channelId?: string } | undefined {
  const channelData = rec(activity['channelData']);
  const team = rec(channelData['team']);
  const conversation = rec(activity['conversation']);
  const inTeam = Object.keys(team).length > 0 || str(conversation['conversationType']) === 'channel';
  if (!inTeam) return undefined;
  const channelId = str(rec(channelData['channel'])['id']) || str(team['id']) || (str(conversation['id']).split(';')[0] ?? '');
  const teamId = str(team['aadGroupId']);
  return { ...(teamId === '' ? {} : { teamId }), ...(channelId === '' ? {} : { channelId }) };
}

/** An install that can change the grants: the app added or upgraded in a team, or the bot added to one. */
function isTeamInstall(activity: Rec): boolean {
  const type = str(activity['type']);
  if (teamOf(activity) === undefined) return false;
  if (type === 'installationUpdate') return str(activity['action']).startsWith('add');
  if (type !== 'conversationUpdate') return false;
  const bot = str(rec(activity['recipient'])['id']);
  const added = Array.isArray(activity['membersAdded']) ? (activity['membersAdded'] as unknown[]) : [];
  return bot !== '' && added.some((m) => str(rec(m)['id']) === bot);
}

export function createTeamsModeCheck(options: TeamsModeCheckOptions): TeamsModeCheck {
  const required = options.required ?? TEAMS_REQUIRED_RSC;
  const onError = options.onError ?? (() => undefined);

  async function check(teamId: string, channelId?: string): Promise<TeamsMode | undefined> {
    let mode: TeamsMode;
    try {
      const grants = await options.graph.rscGrants(teamId);
      const granted = new Set(grants.filter((g) => g.clientAppId === options.appId).map((g) => g.permission));
      mode = required.every((p) => granted.has(p)) ? 'full' : 'reduced';
    } catch (e) {
      // Reading grants needs its own permission; without it, try what the grant allows.
      if (!(e instanceof GraphPermissionError)) throw e;
      if (channelId === undefined) return undefined;
      try {
        await options.graph.channelMessages(teamId, channelId, { top: 1 });
        mode = 'full';
      } catch (probe) {
        if (!(probe instanceof GraphPermissionError)) throw probe;
        mode = 'reduced';
      }
    }
    await writeTeamsMode(options.cache, teamId, mode);
    return mode;
  }

  return {
    check,
    intercepts: (activity) => isTeamInstall(rec(activity)),
    async handle(activity) {
      const at = teamOf(rec(activity));
      if (at === undefined) return;
      let teamId = at.teamId;
      if (teamId === undefined && at.channelId !== undefined && options.getMap !== undefined) {
        teamId = (await options.getMap()).channels.find((c) => c.id === at.channelId)?.teamId;
      }
      if (teamId === undefined) {
        onError(new Error('teams mode check: the activity names no team'));
        return;
      }
      await check(teamId, at.channelId);
    },
  };
}
