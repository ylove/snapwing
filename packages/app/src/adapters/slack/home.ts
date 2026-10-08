// Slack App Home: the engineer's queue (main 20.2). `app_home_opened` publishes a Home view for
// the user who opened it, shaped by their role in the workspace map:
//
// - An engineer sees four sections: Assigned to me (open incidents whose resolved owner is them),
//   Fixing now (fixer runs in flight on their surfaces, each with Stop), Waiting on you (PRs where they
//   are a requested reviewer, with Open PR and Merge) and Recently merged or reverted on their surfaces
//   (last 7 days). Empty sections say so.
// - Anyone else (a reporter, an unmapped user) sees a minimal view: their own open reports.
//
// What the sections hold is decided once, in `status/queue.ts` (`queueFor`); this file renders that model
// as Block Kit. The buttons reuse the interactivity paths: Stop and Merge carry the same action ids and the incident id
// as the cards, in blocks whose ids are the cards' block ids plus `:<incidentId>` (a view cannot repeat a
// block id; interactivity strips the suffix). Merge is shown when `authorize` would allow it for the
// viewer; the tap is authorized again.

import type { ChatUserRef } from '@snapwing/pipeline/merge/human.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { createQueue, HOME_SECTION_LIMIT, type Queue, type QueueButton, type QueueItem, type QueuePullRequest, type QueueSection, type QueueSectionId } from '../../status/queue.ts';
import { actions, esc, section, type ButtonSpec, type SlackBlock } from './cards/blocks.ts';
import type { SlackWeb } from './web.ts';

export { HOME_SECTION_LIMIT, PR_LOOKUPS, RECENT_MS } from '../../status/queue.ts';

/** Home view blocks: the card blocks plus the two Home adds. */
export type HomeBlock = SlackBlock | { type: 'header'; text: { type: 'plain_text'; text: string } } | { type: 'divider' };

export interface HomeView {
  type: 'home';
  blocks: HomeBlock[];
}

/** The slice of a GitHub pull request the view reads; the app's `PullRequest` has all of it. */
export type HomePullRequest = QueuePullRequest;

export interface SlackHomeOptions {
  web: Pick<SlackWeb, 'viewsPublish'>;
  state: Pick<StatePort, 'findIncidents'>;
  workspaceId: string;
  /** The current workspace map; read per view so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** Linked GitHub identities (`GitHubOAuth` satisfies it). */
  identity: {
    getLinkedIdentity(user: ChatUserRef): Promise<{ githubLogin: string } | null>;
    isLinked(user: ChatUserRef): Promise<boolean>;
  };
  /** The incident's PR on GitHub (`repo` is the map's `github.com/owner/name`). */
  pullRequest: (repo: string, prNumber: number) => Promise<HomePullRequest>;
  clock?: () => Date;
  /** Most incident rows read per view. Default 500. */
  incidentLimit?: number;
  onError?: (error: unknown) => void;
}

export interface SlackHome {
  /** True when the Events API body (`event_callback`) is `app_home_opened` on the Home tab. */
  intercepts(parsed: unknown): boolean;
  /** Publishes the view for the user who opened it. Never throws; failures go to `onError`. */
  handleEvent(parsed: unknown): Promise<void>;
  /** Builds the user's view without publishing it. */
  viewFor(userId: string): Promise<HomeView>;
  /** Builds and publishes the user's view (also after a tap in it). Never throws. */
  publishFor(userId: string): Promise<void>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The block id prefix per section: the cards' block ids, so interactivity routes a tap the same way. */
const BLOCK_PREFIX: Readonly<Record<QueueSectionId, string>> = {
  assigned: 'assigned',
  fixing: 'status_actions',
  waiting: 'pr_actions',
  recent: 'recent',
  reports: 'reports',
};

function buttonSpec(button: QueueButton, incidentId: string): ButtonSpec {
  switch (button.kind) {
    case 'open_pr':
      return { label: 'Open PR', actionId: 'open_pr', value: incidentId, url: button.url };
    case 'merge':
      return { label: 'Merge', actionId: 'merge', value: incidentId, style: 'primary' };
    case 'stop':
      return { label: 'Stop', actionId: 'stop', value: incidentId, style: 'danger' };
  }
}

function line(item: QueueItem): string {
  const priority = item.priority === undefined ? '' : ` (${esc(item.priority)})`;
  return `*${esc(item.label)}* ${esc(item.summary)}${priority}${item.detail === '' ? '' : ` · ${esc(item.detail)}`}`;
}

/** One section's blocks: a heading, then each item (a line and its buttons), or the empty line. */
function sectionBlocks(s: QueueSection): HomeBlock[] {
  const out: HomeBlock[] = [section(`*${s.title}*${s.items.length === 0 ? '' : ` (${s.items.length})`}`)];
  if (s.items.length === 0) {
    out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: s.empty }] });
    return out;
  }
  for (const it of s.items.slice(0, HOME_SECTION_LIMIT)) {
    out.push(section(line(it)));
    if (it.buttons.length > 0) out.push(actions(`${BLOCK_PREFIX[s.id]}:${it.incidentId}`, it.buttons.map((b) => buttonSpec(b, it.incidentId))));
  }
  if (s.items.length > HOME_SECTION_LIMIT) {
    out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `and ${s.items.length - HOME_SECTION_LIMIT} more` }] });
  }
  return out;
}

const header = (text: string): HomeBlock => ({ type: 'header', text: { type: 'plain_text', text } });
const divider: HomeBlock = { type: 'divider' };

const REPORTER_INTRO =
  'Fix it from here. React with the trigger emoji or use the *Fix it from here* shortcut on a message, and ask `/snapwing-status` where a report stands.';

function blocksFor(queue: Queue): HomeBlock[] {
  const out: HomeBlock[] = [header(queue.title)];
  if (queue.kind === 'reporter') out.push(section(REPORTER_INTRO), divider);
  queue.sections.forEach((s, i) => {
    if (i > 0) out.push(divider);
    out.push(...sectionBlocks(s));
  });
  return out;
}

export function createSlackHome(options: SlackHomeOptions): SlackHome {
  const onError = options.onError ?? (() => undefined);
  const { queueFor } = createQueue({
    state: options.state,
    workspaceId: options.workspaceId,
    getMap: options.getMap,
    identity: options.identity,
    pullRequest: options.pullRequest,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.incidentLimit === undefined ? {} : { incidentLimit: options.incidentLimit }),
    onError,
  });

  async function viewFor(userId: string): Promise<HomeView> {
    return { type: 'home', blocks: blocksFor(await queueFor({ chat: 'slack', userId })) };
  }
  async function publishFor(userId: string): Promise<void> {
    try {
      await options.web.viewsPublish({ userId, view: await viewFor(userId) });
    } catch (e) {
      onError(e);
    }
  }

  function homeOpener(parsed: unknown): string | undefined {
    const body = rec(parsed);
    if (body['type'] !== 'event_callback') return undefined;
    const event = rec(body['event']);
    if (event['type'] !== 'app_home_opened') return undefined;
    const tab = str(event['tab']);
    const user = str(event['user']);
    return user === '' || (tab !== '' && tab !== 'home') ? undefined : user;
  }

  return {
    viewFor,
    publishFor,
    intercepts: (parsed) => homeOpener(parsed) !== undefined,
    async handleEvent(parsed) {
      const user = homeOpener(parsed);
      if (user !== undefined) await publishFor(user);
    },
  };
}
