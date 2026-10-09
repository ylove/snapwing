// The engineer's queue in the Teams personal chat (main 15.2, 20.2). It renders the same model
// Slack Home does (`status/queue.ts`, `queueFor`) as one Adaptive Card, sent when the user types `queue`
// to the bot and when the app is first installed for them. The personal static tab (the console's queue
// page behind Teams SSO) waits for phase 6; the card is phase 5 parity.
//
// Buttons are `Action.Execute` with the interactivity verbs the other cards use (`stop`, `merge`) and
// `{ incidentId }` in `data`; `Open PR` is an `Action.OpenUrl`. A tap routes by verb plus data, not by
// block id. Each item's buttons sit in an `ActionSet` under its line, because card-level actions are
// capped at six.
//
// A command from a channel or a group chat is answered in the user's personal chat, never in the shared
// space (the queue is theirs). That chat is opened with the user's `29:` Teams id when the activity gave
// one (Teams expects it in `members[].id`), keeping the AAD object id in `aadObjectId`, and the bot's
// app id as `botId`.

import { HOME_SECTION_LIMIT, type Queue, type QueueButton, type QueueItem, type QueueModel, type QueueSection } from '../../status/queue.ts';
import { pinData } from '../shared/pr-pin.ts';
import type { TeamsConnector, TeamsOutgoingActivity } from './connector.ts';
import {
  MAX_CARD_BYTES,
  action,
  esc,
  textBlock,
  type CardAction,
  type ExecuteAction,
  type OpenUrlAction,
  type TextBlock,
} from './cards/elements.ts';

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

/** A row of buttons in the card body. */
export interface ActionSetElement {
  type: 'ActionSet';
  actions: (ExecuteAction | OpenUrlAction)[];
}

export type QueueCardElement = TextBlock | ActionSetElement;

export interface QueueCard {
  type: 'AdaptiveCard';
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  version: '1.5';
  fallbackText: string;
  body: QueueCardElement[];
}

const REPORTER_INTRO = 'Fix it from here. Send me a bug in a message, or type `queue` to see where your reports stand.';

function buttonAction(button: QueueButton, incidentId: string): CardAction {
  switch (button.kind) {
    case 'open_pr':
      return action(incidentId, { title: 'Open PR', verb: 'open_pr', url: button.url });
    case 'merge':
      // The PR and head the queue showed (#264).
      return action(incidentId, { title: 'Merge', verb: 'merge', style: 'positive', data: pinData(button.pin) });
    case 'stop':
      return action(incidentId, { title: 'Stop', verb: 'stop', style: 'destructive' });
  }
}

function line(item: QueueItem): string {
  const priority = item.priority === undefined ? '' : ` (${esc(item.priority)})`;
  return `**${esc(item.label)}** ${esc(item.summary)}${priority}${item.detail === '' ? '' : ` · ${esc(item.detail)}`}`;
}

function sectionElements(s: QueueSection, perSection: number): QueueCardElement[] {
  const count = s.items.length === 0 ? '' : ` (${String(s.items.length)})`;
  const out: QueueCardElement[] = [textBlock(`${s.title}${count}`, { weight: 'Bolder', spacing: 'Small' })];
  if (s.items.length === 0) {
    out.push(textBlock(s.empty, { isSubtle: true, size: 'Small' }));
    return out;
  }
  for (const it of s.items.slice(0, perSection)) {
    out.push(textBlock(line(it)));
    if (it.buttons.length > 0) out.push({ type: 'ActionSet', actions: it.buttons.map((b) => buttonAction(b, it.incidentId) as ExecuteAction | OpenUrlAction) });
  }
  if (s.items.length > perSection) out.push(textBlock(`and ${String(s.items.length - perSection)} more`, { isSubtle: true, size: 'Small' }));
  return out;
}

function fallbackOf(queue: Queue): string {
  if (queue.kind === 'reporter') {
    const n = queue.sections[0]?.items.length ?? 0;
    return `Your reports: ${n === 0 ? 'none open' : `${String(n)} open`}`;
  }
  return `${queue.title}: ${queue.sections.map((s) => `${String(s.items.length)} ${s.title.toLowerCase()}`).join(', ')}`;
}

function build(queue: Queue, perSection: number): QueueCard {
  const body: QueueCardElement[] = [textBlock(queue.title, { weight: 'Bolder' })];
  if (queue.kind === 'reporter') body.push(textBlock(REPORTER_INTRO));
  for (const s of queue.sections) body.push(...sectionElements(s, perSection));
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    fallbackText: fallbackOf(queue),
    body,
  };
}

/**
 * The queue as an Adaptive Card. Each section lists at most `HOME_SECTION_LIMIT` items and counts the
 * rest; a card still over Teams' 28 KB cap lists fewer per section until it fits.
 */
export function buildQueueCard(queue: Queue): QueueCard {
  for (let per = HOME_SECTION_LIMIT; per >= 1; per -= 1) {
    const c = build(queue, per);
    if (new TextEncoder().encode(JSON.stringify(c)).length <= MAX_CARD_BYTES) return c;
  }
  throw new RangeError('a card payload must stay under 28 KB');
}

/** The card as the message activity Teams takes. */
export function queueActivity(queue: Queue): TeamsOutgoingActivity {
  const content = buildQueueCard(queue);
  return { type: 'message', text: content.fallbackText, attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content }] };
}

// The inbound side ---------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Where the queue goes, read from an inbound activity. */
interface Asker {
  serviceUrl: string;
  tenantId: string;
  /** The user's AAD object id: the key for the map, identity links, and reports. */
  aadObjectId: string;
  /** The user's `29:` Teams id, when the activity carried one. */
  teamsUserId?: string;
  conversationId: string;
  personal: boolean;
}

function askerOf(activity: unknown): Asker | undefined {
  const a = rec(activity);
  const from = rec(a['from']);
  const conversation = rec(a['conversation']);
  const serviceUrl = str(a['serviceUrl']);
  const aadObjectId = str(from['aadObjectId']);
  const tenantId = str(conversation['tenantId']) || str(rec(rec(a['channelData'])['tenant'])['id']);
  if (serviceUrl === '' || aadObjectId === '' || tenantId === '') return undefined;
  const fromId = str(from['id']);
  return {
    serviceUrl,
    tenantId,
    aadObjectId,
    ...(fromId.startsWith('29:') ? { teamsUserId: fromId } : {}),
    conversationId: str(conversation['id']),
    personal: str(conversation['conversationType']) === 'personal' && str(conversation['id']) !== '',
  };
}

/** The message text without the bot's `<at>` mention, lower-cased and trimmed. */
function commandOf(activity: unknown): string {
  return str(rec(activity)['text'])
    .replace(/<at>[^<]*<\/at>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .toLowerCase();
}

export interface TeamsQueueOptions {
  connector: Pick<TeamsConnector, 'sendToConversation' | 'createPersonalConversation'>;
  queue: QueueModel;
  /** The bot's app id, passed as `botId` when opening a personal chat. */
  botId?: string;
  onError?: (error: unknown) => void;
}

export interface TeamsQueue {
  /** The viewer's queue as a card, without sending it. */
  cardFor(aadObjectId: string): Promise<QueueCard>;
  /** True for a `message` activity whose text is the `queue` command (the bot mention is ignored). */
  isQueueCommand(activity: unknown): boolean;
  /** True for the app being installed for a user (`installationUpdate` add, or the bot added in a personal chat). */
  isInstall(activity: unknown): boolean;
  /** Sends the asker their queue card in their personal chat. Never throws; failures go to `onError`. */
  handleCommand(activity: unknown): Promise<void>;
  /** Sends the first queue card when the app is installed for the user. Never throws. */
  handleInstall(activity: unknown): Promise<void>;
  /** Routes an inbound activity: the `queue` command or an install. Returns true when it was handled. */
  handle(activity: unknown): Promise<boolean>;
}

export function createTeamsQueue(options: TeamsQueueOptions): TeamsQueue {
  const onError = options.onError ?? (() => undefined);

  async function cardFor(aadObjectId: string): Promise<QueueCard> {
    return buildQueueCard(await options.queue.queueFor({ chat: 'teams', userId: aadObjectId }));
  }

  async function send(activity: unknown): Promise<void> {
    try {
      const asker = askerOf(activity);
      if (asker === undefined) return;
      const message = queueActivity(await options.queue.queueFor({ chat: 'teams', userId: asker.aadObjectId }));
      if (asker.personal) {
        await options.connector.sendToConversation({ serviceUrl: asker.serviceUrl, conversationId: asker.conversationId }, message);
        return;
      }
      const chat = await options.connector.createPersonalConversation({
        serviceUrl: asker.serviceUrl,
        tenantId: asker.tenantId,
        aadObjectId: asker.aadObjectId,
        ...(asker.teamsUserId === undefined ? {} : { userId: asker.teamsUserId }),
        ...(options.botId === undefined ? {} : { botId: options.botId }),
      });
      await options.connector.sendToConversation({ serviceUrl: chat.serviceUrl ?? asker.serviceUrl, conversationId: chat.id }, message);
    } catch (e) {
      onError(e);
    }
  }

  function isQueueCommand(activity: unknown): boolean {
    return str(rec(activity)['type']) === 'message' && commandOf(activity) === 'queue';
  }

  function isInstall(activity: unknown): boolean {
    const a = rec(activity);
    const type = str(a['type']);
    if (type === 'installationUpdate') return str(a['action']) === 'add' && str(rec(a['conversation'])['conversationType']) !== 'channel';
    if (type !== 'conversationUpdate' || str(rec(a['conversation'])['conversationType']) !== 'personal') return false;
    const recipient = str(rec(a['recipient'])['id']);
    const added = Array.isArray(a['membersAdded']) ? a['membersAdded'] : [];
    return added.some((m) => str(rec(m)['id']) === recipient);
  }

  return {
    cardFor,
    isQueueCommand,
    isInstall,
    handleCommand: send,
    handleInstall: send,
    async handle(activity) {
      if (isQueueCommand(activity)) {
        await send(activity);
        return true;
      }
      if (isInstall(activity)) {
        await send(activity);
        return true;
      }
      return false;
    },
  };
}
