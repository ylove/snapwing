// Slack App Home: the engineer's queue (main 20.2, #297). `app_home_opened` publishes a Home view for
// the user who opened it, shaped by their role in the workspace map:
//
// - An engineer sees four sections: Assigned to me (open incidents whose resolved owner is them),
//   Fixing now (fixer runs in flight on their surfaces, each with Stop), Waiting on you (PRs where they
//   are a requested reviewer, with Open PR and Merge) and Recently merged or reverted on their surfaces
//   (last 7 days). Empty sections say so.
// - Anyone else (a reporter, an unmapped user) sees a minimal view: their own open reports.
//
// The buttons reuse the interactivity paths: Stop and Merge carry the same action ids and the incident id
// as the cards, in blocks whose ids are the cards' block ids plus `:<incidentId>` (a view cannot repeat a
// block id; interactivity strips the suffix). Merge is shown when `authorize` would allow it for the
// viewer (a linked GitHub identity, a level that lets humans merge); the tap is authorized again.
//
// Requested reviewers live on GitHub, so Waiting on you reads each candidate PR through the injected
// `pullRequest` (at most `PR_LOOKUPS` per view). The viewer's login is their linked identity's, else
// their map handle, as `requestHumanReview` requests it (merge/human.ts).

import type { IncidentStatus, IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { isTerminalStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { sameLogin, type ChatUserRef } from '@snapwing/pipeline/merge/human.ts';
import { authorize } from '@snapwing/pipeline/policy/authorize.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { actions, esc, section, type ButtonSpec, type SlackBlock } from './cards/blocks.ts';
import type { SlackWeb } from './web.ts';

/** Most items a section lists; the rest are counted. Keeps the view under Slack's 100 blocks. */
export const HOME_SECTION_LIMIT = 8;
/** Most PRs read from GitHub for one view. */
export const PR_LOOKUPS = 30;
/** "Recently" is the last seven days. */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const SUMMARY_MAX = 110;
/** Statuses in which a fixer run is in flight. */
const FIXING: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['fixing', 'fixing-retry']);
/** Statuses in which an open PR can be waiting on a reviewer. */
const REVIEWABLE: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['in-review', 'in-review-retry', 'ci', 'ci-retry', 'mergeable', 'held']);
/** Statuses that are done, one way or another: not in anyone's open queue. */
const FINISHED: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
  'merged',
  'deployed:staging',
  'deployed:production',
  'reverted',
  'stopped',
  'deduped',
]);
const MERGED_OR_REVERTED: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['merged', 'deployed:staging', 'deployed:production', 'reverted']);

/** Home view blocks: the card blocks plus the two Home adds. */
export type HomeBlock = SlackBlock | { type: 'header'; text: { type: 'plain_text'; text: string } } | { type: 'divider' };

export interface HomeView {
  type: 'home';
  blocks: HomeBlock[];
}

/** The slice of a GitHub pull request the view reads; the app's `PullRequest` has all of it. */
export interface HomePullRequest {
  state: 'open' | 'closed';
  merged: boolean;
  htmlUrl: string;
  requestedReviewers: readonly string[];
}

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

const bare = (handle: string): string => handle.replace(/^@/, '');

function owns(person: MapPerson, incident: IncidentView): boolean {
  if (incident.surfaceId === undefined) return false;
  return person.owns.some((o) => o.surface === incident.surfaceId && (o.component === undefined || o.component === incident.componentId));
}

function label(incident: IncidentView): string {
  return incident.jiraKey ?? `incident ${incident.id.slice(-6)}`;
}

function line(incident: IncidentView, tail: string): string {
  const summary = incident.summary ?? '';
  const text = summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 3)}...` : summary;
  const priority = incident.priority === undefined ? '' : ` (${esc(incident.priority)})`;
  return `*${esc(label(incident))}* ${esc(text)}${priority}${tail === '' ? '' : ` · ${tail}`}`;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** One section's blocks: a heading, then each item (a line and its buttons), or the empty line. */
function sectionBlocks(title: string, empty: string, items: readonly { text: string; buttons: ButtonSpec[]; blockId: string }[]): HomeBlock[] {
  const out: HomeBlock[] = [section(`*${title}*${items.length === 0 ? '' : ` (${items.length})`}`)];
  if (items.length === 0) {
    out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: empty }] });
    return out;
  }
  for (const item of items.slice(0, HOME_SECTION_LIMIT)) {
    out.push(section(item.text));
    if (item.buttons.length > 0) out.push(actions(item.blockId, item.buttons));
  }
  if (items.length > HOME_SECTION_LIMIT) {
    out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `and ${items.length - HOME_SECTION_LIMIT} more` }] });
  }
  return out;
}

const header = (text: string): HomeBlock => ({ type: 'header', text: { type: 'plain_text', text } });
const divider: HomeBlock = { type: 'divider' };

export function createSlackHome(options: SlackHomeOptions): SlackHome {
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const limit = options.incidentLimit ?? 500;

  /** The incidents of the viewer's Waiting on you: an open PR whose requested reviewers include them. */
  async function waitingOnYou(
    person: MapPerson,
    userId: string,
    incidents: readonly IncidentView[],
  ): Promise<{ text: string; buttons: ButtonSpec[]; blockId: string }[]> {
    const user: ChatUserRef = { chat: 'slack', userId };
    const [identity, linked] = await Promise.all([options.identity.getLinkedIdentity(user), options.identity.isLinked(user)]);
    const login = identity?.githubLogin ?? bare(person.handle);
    const githubLinked = identity !== null && linked;
    const candidates = incidents
      .filter((i) => REVIEWABLE.has(i.status) && i.prNumber !== undefined && i.repo !== undefined)
      .slice(0, PR_LOOKUPS);
    const rows = await Promise.all(
      candidates.map(async (incident) => {
        try {
          const pr = await options.pullRequest(incident.repo as string, incident.prNumber as number);
          if (pr.state !== 'open' || pr.merged || !pr.requestedReviewers.some((r) => sameLogin(r, login))) return undefined;
          const buttons: ButtonSpec[] = [{ label: 'Open PR', actionId: 'open_pr', value: incident.id, url: pr.htmlUrl }];
          const merge = authorize('merge', { kind: 'human', role: person.role, githubLinked }, { level: incident.autonomyLevel ?? 1, fixerActive: true });
          if (merge.allowed) buttons.push({ label: 'Merge', actionId: 'merge', value: incident.id, style: 'primary' });
          return { text: line(incident, `PR #${incident.prNumber}`), buttons, blockId: `pr_actions:${incident.id}` };
        } catch (e) {
          onError(e);
          return undefined;
        }
      }),
    );
    return rows.filter((r): r is NonNullable<typeof r> => r !== undefined);
  }

  async function viewFor(userId: string): Promise<HomeView> {
    const map = await options.getMap();
    const person = map.people.find((p) => p.slackId === userId);
    const now = clock().getTime();
    const incidents = await options.state.findIncidents({ workspaceId: options.workspaceId, limit });
    const open = (i: IncidentView): boolean => !isTerminalStatus(i.status) && !FINISHED.has(i.status);

    if (person?.role !== 'engineer') {
      const mine = incidents.filter((i) => i.reporterId === userId && open(i));
      const items = mine.map((i) => ({ text: line(i, esc(i.status)), buttons: [] as ButtonSpec[], blockId: `reports:${i.id}` }));
      return {
        type: 'home',
        blocks: [
          header('Snapwing'),
          section('Fix it from here. React with the trigger emoji or use the *Fix it from here* shortcut on a message, and ask `/snapwing-status` where a report stands.'),
          divider,
          ...sectionBlocks('Your reports', "You have no open reports. When you file one it shows up here until it's fixed.", items),
        ],
      };
    }

    const handle = bare(person.handle);
    const assigned = incidents
      .filter((i) => open(i) && i.ownerRef !== undefined && sameLogin(bare(i.ownerRef), handle))
      .map((i) => ({ text: line(i, esc(i.status)), buttons: [] as ButtonSpec[], blockId: `assigned:${i.id}` }));
    const fixing = incidents
      .filter((i) => FIXING.has(i.status) && owns(person, i))
      .map((i) => ({
        text: line(i, esc(i.status)),
        buttons: [{ label: 'Stop', actionId: 'stop', value: i.id, style: 'danger' as const }],
        blockId: `status_actions:${i.id}`,
      }));
    const waiting = await waitingOnYou(person, userId, incidents);
    const recent = incidents
      .filter((i) => MERGED_OR_REVERTED.has(i.status) && owns(person, i) && now - Date.parse(i.updatedAt) <= RECENT_MS)
      .map((i) => ({
        text: line(i, `${i.status === 'reverted' ? 'reverted' : 'merged'} ${day(i.updatedAt)}${i.prNumber === undefined ? '' : `, PR #${i.prNumber}`}`),
        buttons: [] as ButtonSpec[],
        blockId: `recent:${i.id}`,
      }));

    return {
      type: 'home',
      blocks: [
        header('Your queue'),
        ...sectionBlocks('Assigned to me', 'Nothing is assigned to you.', assigned),
        divider,
        ...sectionBlocks('Fixing now', 'No fixer is running on your surfaces.', fixing),
        divider,
        ...sectionBlocks('Waiting on you', 'No pull request is waiting on your review.', waiting),
        divider,
        ...sectionBlocks('Recently merged or reverted', 'Nothing merged or reverted on your surfaces in the last 7 days.', recent),
      ],
    };
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
