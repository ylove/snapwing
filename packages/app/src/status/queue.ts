// The engineer's queue as a platform-neutral model (main 20.2, 15.2). `queueFor(viewer)` reads the
// incident projection and GitHub and returns what Slack Home and the Teams personal-chat card both
// render; neither adapter decides what is in a section.
//
// - An engineer sees four sections: Assigned to me (open incidents whose resolved owner is them),
//   Fixing now (fixer runs in flight on their surfaces, each with Stop), Waiting on you (PRs where they
//   are a requested reviewer, with Open PR and Merge) and Recently merged or reverted on their surfaces
//   (last 7 days). Empty sections say so.
// - Anyone else (a reporter, an unmapped user) sees a minimal view: their own open reports.
//
// Merge is offered when `authorize` would allow it for the viewer (a linked GitHub identity, a level
// that lets humans merge); the tap is authorized again by the interactivity path. Requested reviewers
// live on GitHub, so Waiting on you reads each candidate PR through the injected `pullRequest` (at most
// `PR_LOOKUPS` per queue). The viewer's login is their linked identity's, else their map handle, as
// `requestHumanReview` requests it (merge/human.ts).
//
// Text in the model is plain (nothing escaped); each adapter escapes for its own markup.

import type { IncidentStatus, IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { isTerminalStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { sameLogin, type ChatUserRef } from '@snapwing/pipeline/merge/human.ts';
import { authorize } from '@snapwing/pipeline/policy/authorize.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';

/** Most items a rendered section lists; the rest are counted. Keeps a Slack view under 100 blocks. */
export const HOME_SECTION_LIMIT = 8;
/** Most PRs read from GitHub for one queue. */
export const PR_LOOKUPS = 30;
/** "Recently" is the last seven days. */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const SUMMARY_MAX = 110;
/** Statuses in which a fixer run is in flight. */
const FIXING: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['fixing', 'fixing-retry']);
/** Statuses in which an open PR can be waiting on a reviewer. */
const REVIEWABLE: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['in-review', 'in-review-retry', 'ci', 'ci-retry', 'mergeable', 'held']);
/** Statuses that are done, one way or another: not in anyone's open queue. */
const FINISHED: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['merged', 'deployed:staging', 'deployed:production', 'reverted', 'stopped', 'deduped']);
const MERGED_OR_REVERTED: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['merged', 'deployed:staging', 'deployed:production', 'reverted']);

export type QueueSectionId = 'assigned' | 'fixing' | 'waiting' | 'recent' | 'reports';

/** A button on an item. `open_pr` is a link; `stop` and `merge` are taps on the interactivity paths. */
export type QueueButton = { kind: 'open_pr'; url: string } | { kind: 'stop' } | { kind: 'merge' };

export interface QueueItem {
  incidentId: string;
  /** The Jira key, else `incident <last six of the id>`. */
  label: string;
  /** Truncated to 110 characters. */
  summary: string;
  priority?: string;
  /** Plain tail after the summary: the status, `PR #31`, or `merged 2026-10-02, PR #41`. */
  detail: string;
  buttons: QueueButton[];
}

export interface QueueSection {
  id: QueueSectionId;
  title: string;
  /** What an empty section says. */
  empty: string;
  /** Every item; a renderer shows `HOME_SECTION_LIMIT` and counts the rest. */
  items: QueueItem[];
}

export interface Queue {
  /** `engineer` for a mapped engineer; `reporter` for everyone else (the minimal view). */
  kind: 'engineer' | 'reporter';
  title: string;
  sections: QueueSection[];
}

/** The slice of a GitHub pull request the queue reads; the app's `PullRequest` has all of it. */
export interface QueuePullRequest {
  state: 'open' | 'closed';
  merged: boolean;
  htmlUrl: string;
  requestedReviewers: readonly string[];
}

export interface QueueOptions {
  state: Pick<StatePort, 'findIncidents'>;
  workspaceId: string;
  /** The current workspace map; read per call so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** Linked GitHub identities (`GitHubOAuth` satisfies it). */
  identity: {
    getLinkedIdentity(user: ChatUserRef): Promise<{ githubLogin: string } | null>;
    isLinked(user: ChatUserRef): Promise<boolean>;
  };
  /** The incident's PR on GitHub (`repo` is the map's `github.com/owner/name`). */
  pullRequest: (repo: string, prNumber: number) => Promise<QueuePullRequest>;
  clock?: () => Date;
  /** Most incident rows read per queue. Default 500. */
  incidentLimit?: number;
  onError?: (error: unknown) => void;
}

export interface QueueModel {
  /** The viewer's queue. Throws only when state or the map cannot be read; a failed PR lookup is skipped. */
  queueFor(viewer: ChatUserRef): Promise<Queue>;
}

const bare = (handle: string): string => handle.replace(/^@/, '');

/** The map person for a chat user: Slack by `slackId`, Teams by `teamsId` (the AAD object id). */
function personOf(map: WorkspaceMap, viewer: ChatUserRef): MapPerson | undefined {
  return map.people.find((p) => (viewer.chat === 'slack' ? p.slackId : p.teamsId) === viewer.userId);
}

/**
 * Whether `reporterId` is this viewer. A capture from the CLI or Raycast files under the map handle
 * and one from chat under the chat id, so a person counts under every identity the map gives them (#275).
 */
function reportedBy(reporterId: string | undefined, person: MapPerson | undefined, viewer: ChatUserRef): boolean {
  if (reporterId === undefined) return false;
  if (reporterId === viewer.userId) return true;
  if (person === undefined) return false;
  return reporterId === person.slackId || reporterId === person.teamsId || reporterId.toLowerCase() === person.handle.toLowerCase();
}

function owns(person: MapPerson, incident: IncidentView): boolean {
  if (incident.surfaceId === undefined) return false;
  return person.owns.some((o) => o.surface === incident.surfaceId && (o.component === undefined || o.component === incident.componentId));
}

function item(incident: IncidentView, detail: string, buttons: QueueButton[] = []): QueueItem {
  const summary = incident.summary ?? '';
  return {
    incidentId: incident.id,
    label: incident.jiraKey ?? `incident ${incident.id.slice(-6)}`,
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 3)}...` : summary,
    ...(incident.priority === undefined ? {} : { priority: incident.priority }),
    detail,
    buttons,
  };
}

const day = (iso: string): string => iso.slice(0, 10);

export function createQueue(options: QueueOptions): QueueModel {
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const limit = options.incidentLimit ?? 500;

  /** The viewer's Waiting on you: an open PR whose requested reviewers include them. */
  async function waitingOnYou(person: MapPerson, viewer: ChatUserRef, incidents: readonly IncidentView[]): Promise<QueueItem[]> {
    const [identity, linked] = await Promise.all([options.identity.getLinkedIdentity(viewer), options.identity.isLinked(viewer)]);
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
          const buttons: QueueButton[] = [{ kind: 'open_pr', url: pr.htmlUrl }];
          const merge = authorize('merge', { kind: 'human', role: person.role, githubLinked }, { level: incident.autonomyLevel ?? 1, fixerActive: true });
          if (merge.allowed) buttons.push({ kind: 'merge' });
          return item(incident, `PR #${incident.prNumber}`, buttons);
        } catch (e) {
          onError(e);
          return undefined;
        }
      }),
    );
    return rows.filter((r): r is QueueItem => r !== undefined);
  }

  async function queueFor(viewer: ChatUserRef): Promise<Queue> {
    const map = await options.getMap();
    const person = personOf(map, viewer);
    const now = clock().getTime();
    const incidents = await options.state.findIncidents({ workspaceId: options.workspaceId, limit });
    const open = (i: IncidentView): boolean => !isTerminalStatus(i.status) && !FINISHED.has(i.status);

    if (person?.role !== 'engineer') {
      return {
        kind: 'reporter',
        title: 'Snapwing',
        sections: [
          {
            id: 'reports',
            title: 'Your reports',
            empty: "You have no open reports. When you file one it shows up here until it's fixed.",
            items: incidents.filter((i) => reportedBy(i.reporterId, person, viewer) && open(i)).map((i) => item(i, i.status)),
          },
        ],
      };
    }

    const handle = bare(person.handle);
    return {
      kind: 'engineer',
      title: 'Your queue',
      sections: [
        {
          id: 'assigned',
          title: 'Assigned to me',
          empty: 'Nothing is assigned to you.',
          items: incidents.filter((i) => open(i) && i.ownerRef !== undefined && sameLogin(bare(i.ownerRef), handle)).map((i) => item(i, i.status)),
        },
        {
          id: 'fixing',
          title: 'Fixing now',
          empty: 'No fixer is running on your surfaces.',
          items: incidents.filter((i) => FIXING.has(i.status) && owns(person, i)).map((i) => item(i, i.status, [{ kind: 'stop' }])),
        },
        {
          id: 'waiting',
          title: 'Waiting on you',
          empty: 'No pull request is waiting on your review.',
          items: await waitingOnYou(person, viewer, incidents),
        },
        {
          id: 'recent',
          title: 'Recently merged or reverted',
          empty: 'Nothing merged or reverted on your surfaces in the last 7 days.',
          items: incidents
            .filter((i) => MERGED_OR_REVERTED.has(i.status) && owns(person, i) && now - Date.parse(i.updatedAt) <= RECENT_MS)
            .map((i) => item(i, `${i.status === 'reverted' ? 'reverted' : 'merged'} ${day(i.updatedAt)}${i.prNumber === undefined ? '' : `, PR #${i.prNumber}`}`)),
        },
      ],
    };
  }

  return { queueFor };
}
