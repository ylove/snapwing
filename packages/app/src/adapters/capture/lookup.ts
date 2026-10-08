// A capture's lookup-first response (main 15.3, 15.4; ADR 0022), read from the engine's log, the
// incidents row, and the card the capture adapter kept in kv. The engine's cards map to the wire's
// kinds (#377):
//
//   dedupe card                         tracked        (kept for a card already waiting; a new capture that
//                                                      matches an issue links at once and answers not-filed)
//   file-confirm                        new            choices File it, Not this surface, Cancel
//   clarify asking `surface`            which-surface  one choice per map surface (its id), then Cancel
//   fix-preview (level 1, pre-filing)   fix-preview    Fix it and Ticket only for an engineer, Ticket
//                                                      only for anyone else (only engineers start a fix)
//   an issue filed                      filed
//   capture-cancelled, or another end   not-filed      with the reason
//   anything else                       pending        (the engine is working, or a card is on its way)
//
// A kept card counts only while the engine still waits on a card of that kind (`pendingCard`, the
// check `handleTap` makes), so an answered card is never shown again; until the next one is posted
// the capture is `pending`. The choices can depend on who looks (the fix preview's), so a lookup takes
// the caller's map role.

import type { Choice, LookupResponse, TicketStatus } from '@snapwing/capture-client/wire.ts';
import { CAPTURE_CANCEL_CHOICE, FILE_CONFIRM_CHOICES, type FileConfirmChoice, type InteractiveCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { ApprovalAction } from '@snapwing/pipeline/contracts/incident.ts';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { foldCursor, nextPhase, pendingCard, type CardKind } from '@snapwing/pipeline/engine/cursor.ts';
import { isTerminalStatus, type LifecycleStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { MapActorRole, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { repoFullName } from '../../github/repo.ts';
import { readCaptureCard } from './adapter.ts';

export interface LookupDeps {
  readonly state: StatePort;
  readonly cache: CachePort;
  readonly map: () => Promise<WorkspaceMap>;
  /** The Jira issue's browse URL. */
  readonly issueUrl: (issueKey: string) => string;
}

/** What a capture waits on, with the card behind it when one is pending. */
export interface CaptureLookup {
  readonly response: LookupResponse;
  /** The engine's card the response shows; set only for tracked, new, which-surface, and fix-preview. */
  readonly card?: { readonly kind: CardKind; readonly card: InteractiveCard };
}

const FILE_CONFIRM_LABELS: Readonly<Record<FileConfirmChoice, string>> = { 'file-it': 'File it', 'not-this-surface': 'Not this surface', cancel: 'Cancel' };
export const CANCEL_CHOICE: Choice = { id: CAPTURE_CANCEL_CHOICE, label: 'Cancel' };

/** The fix preview's choices, by the engine's tap choices (the Slack card's `Fix it` and `Ticket only`). */
const FIX_IT = { id: 'approve_fix', label: 'Fix it' } as const satisfies Choice & { id: ApprovalAction };
const TICKET_ONLY = { id: 'ticket_only', label: 'Ticket only' } as const satisfies Choice & { id: ApprovalAction };

/** Fix it starts a fixer, so only an engineer is offered it; anyone may file the ticket only. */
export function fixPreviewChoices(role: MapActorRole): Choice[] {
  return role === 'engineer' ? [FIX_IT, TICKET_ONLY] : [TICKET_ONLY];
}

/** The surface question's choices: each option as its map surface (id and label), then Cancel. */
export function surfaceChoices(options: readonly string[], map: WorkspaceMap): Choice[] {
  return [
    ...options.map((label) => ({ id: map.surfaces.find((s) => s.label === label)?.id ?? label, label })),
    CANCEL_CHOICE,
  ];
}

function lastOf<T extends IncidentEvent['type']>(log: readonly IncidentEvent[], type: T): IncidentEvent<T> | undefined {
  return log.findLast((e) => e.type === type) as IncidentEvent<T> | undefined;
}

/** Why a capture that ended filed nothing. */
function notFiledReason(incident: IncidentView, log: readonly IncidentEvent[]): string {
  const cancelled = lastOf(log, 'capture-cancelled');
  if (cancelled !== undefined) return cancelled.payload.timedOut === true ? 'Nobody answered in time, so nothing was filed.' : 'Cancelled, so nothing was filed.';
  if (incident.status === 'linked-to-existing' && incident.jiraKey !== undefined) return `Added this report to ${incident.jiraKey}.`;
  if (incident.status === 'stopped') return 'Stopped before it was filed.';
  return 'Nothing to file.';
}

/** The capture's lookup as `role` (the caller's map role) sees it. */
export async function lookupCapture(deps: LookupDeps, captureId: string, role: MapActorRole): Promise<CaptureLookup> {
  const pending: CaptureLookup = { response: { kind: 'pending', captureId } };
  const incident = await deps.state.getIncident(captureId);
  if (incident === null) return pending;
  const filed = incident.jiraKey !== undefined && incident.status !== 'linked-to-existing';
  if (filed && incident.jiraKey !== undefined) {
    return { response: { kind: 'filed', captureId, issueKey: incident.jiraKey, url: deps.issueUrl(incident.jiraKey) } };
  }
  const log = await deps.state.read(captureId);
  if (isTerminalStatus(incident.status) || incident.status === 'stopped') {
    return { response: { kind: 'not-filed', captureId, reason: notFiledReason(incident, log) } };
  }
  const waiting = pendingCard(nextPhase(foldCursor(captureId, log), { scopePreview: false, capture: true }));
  const card = waiting === undefined ? undefined : await readCaptureCard(deps.cache, captureId);
  if (waiting === undefined || card === undefined || card.kind !== waiting) return pending;
  const response = await responseFor(deps, captureId, card, role);
  return response === undefined ? pending : { response, card: { kind: waiting, card } };
}

async function responseFor(deps: LookupDeps, captureId: string, card: InteractiveCard, role: MapActorRole): Promise<LookupResponse | undefined> {
  switch (card.kind) {
    case 'dedupe':
      return {
        kind: 'tracked',
        captureId,
        issueKey: card.issueKey,
        summary: card.summary === '' ? card.issueKey : card.summary,
        // Dedupe only offers open issues (main 6).
        status: 'open',
        ...(card.assignee === undefined || card.assignee === '' ? {} : { assignee: card.assignee }),
        url: deps.issueUrl(card.issueKey),
      };
    case 'file-confirm':
      return {
        kind: 'new',
        captureId,
        surface: { id: card.surfaceId, label: card.surfaceLabel },
        ...(card.evidence === undefined || card.evidence === '' ? {} : { evidence: card.evidence }),
        choices: FILE_CONFIRM_CHOICES.map((id) => ({ id, label: FILE_CONFIRM_LABELS[id] })),
      };
    case 'clarify': {
      if (card.question.asks !== 'surface') return undefined;
      return { kind: 'which-surface', captureId, choices: surfaceChoices(card.question.options ?? [], await deps.map()) };
    }
    case 'fix-preview':
      return { kind: 'fix-preview', captureId, summary: card.plan.summary === '' ? 'the new ticket' : card.plan.summary, choices: fixPreviewChoices(role) };
    default:
      return undefined;
  }
}

/**
 * The engine's tap choice for a client's `choiceId` on the card a capture shows, or undefined when it
 * offers none such to `role` (the caller's map role): a reporter's Fix it is refused here, as it is
 * never offered.
 */
export function tapChoice(card: InteractiveCard, choiceId: string, map: WorkspaceMap, role: MapActorRole): string | undefined {
  switch (card.kind) {
    case 'dedupe':
      // The client opens the ticket itself, which changes nothing. The engine links a tracked capture
      // at once, so this card is never answered.
      return undefined;
    case 'file-confirm':
      return (FILE_CONFIRM_CHOICES as readonly string[]).includes(choiceId) ? choiceId : undefined;
    case 'clarify': {
      if (choiceId === CAPTURE_CANCEL_CHOICE) return choiceId;
      return surfaceChoices(card.question.options ?? [], map).find((c) => c.id === choiceId || c.label === choiceId)?.label;
    }
    case 'fix-preview':
      return fixPreviewChoices(role).some((c) => c.id === choiceId) ? choiceId : undefined;
    default:
      return undefined;
  }
}

// The status loopback for one ticket (`GET /issues/:key/status`) ------------------------------------

const STATUS_WORDS: Readonly<Record<LifecycleStatus, string>> = {
  captured: 'being filed',
  assembling: 'being filed',
  resolved: 'being filed',
  deduped: 'being filed',
  planned: 'being filed',
  filed: 'open',
  claimed: 'claimed',
  'human-fixing': 'being fixed',
  fixing: 'fixing',
  'fixing-retry': 'fixing',
  'in-review': 'in review',
  'in-review-retry': 'in review',
  ci: 'waiting on CI',
  'ci-retry': 'waiting on CI',
  mergeable: 'ready to merge',
  held: 'held',
  merged: 'merged',
  'deployed:staging': 'on staging',
  'deployed:production': 'in production',
  reverted: 'reverted',
  stopped: 'stopped',
  escalated: 'escalated',
  closed: 'closed',
  'not-filed': 'not filed',
  'not-a-bug': 'closed as not a bug',
  'linked-to-existing': 'linked to another ticket',
};

const PR_MERGED: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['merged', 'deployed:staging', 'deployed:production', 'reverted']);
const PR_CLOSED: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['stopped', 'closed', 'not-a-bug']);

/**
 * The map handle of the person `ref` names (a handle, an email, or a chat user id), or undefined when
 * no one in the map matches, as for a Jira account id.
 */
export function personHandle(map: WorkspaceMap, ref: string): string | undefined {
  const want = ref.trim().toLowerCase();
  if (want === '') return undefined;
  return map.people.find((p) => [p.handle, p.email, p.slackId, p.teamsId].some((id) => id !== undefined && id.toLowerCase() === want))?.handle;
}

/**
 * The incident behind a Jira key as the wire's `TicketStatus`. `assignee` is the Jira assignee when it
 * is someone in the map (the row may hold a bare Jira account id, which says nothing to a reader, so
 * then there is none), else the resolved owner.
 */
export function ticketStatus(incident: IncidentView & { jiraKey: string }, map: WorkspaceMap, issueUrl: (key: string) => string): TicketStatus {
  const who = incident.assigneeId === undefined ? incident.ownerRef : personHandle(map, incident.assigneeId);
  const pr =
    incident.prNumber === undefined || incident.repo === undefined
      ? undefined
      : { url: `https://github.com/${repoFullName(incident.repo)}/pull/${incident.prNumber}`, state: PR_MERGED.has(incident.status) ? 'merged' : PR_CLOSED.has(incident.status) ? 'closed' : 'open' };
  return {
    issueKey: incident.jiraKey,
    summary: incident.summary === undefined || incident.summary === '' ? incident.jiraKey : incident.summary,
    status: STATUS_WORDS[incident.status],
    ...(who === undefined || who === '' ? {} : { assignee: who }),
    url: issueUrl(incident.jiraKey),
    ...(pr === undefined ? {} : { pullRequest: pr }),
  };
}
