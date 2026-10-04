// A capture's lookup-first response (main 15.3, 15.4; ADR 0022), read from the engine's log, the
// incidents row, and the card the capture adapter kept in kv. The engine's cards map to the wire's
// kinds (#377, journal 2026-10-03-capture-lookup):
//
//   dedupe card                         tracked        (the client adds Open it and Not now itself)
//   file-confirm                        new            choices File it, Not this surface, Cancel
//   clarify asking `surface`            which-surface  one choice per map surface (its id), then Cancel
//   an issue filed                      filed
//   capture-cancelled, or another end   not-filed      with the reason
//   anything else                       pending        (the engine is working, or a card is on its way)
//
// A kept card counts only while the engine still waits on a card of that kind (`pendingCard`, the
// check `handleTap` makes), so an answered card is never shown again; until the next one is posted
// the capture is `pending`.

import type { Choice, LookupResponse, TicketStatus } from '@snapwing/capture-client/wire.ts';
import { CAPTURE_CANCEL_CHOICE, FILE_CONFIRM_CHOICES, type FileConfirmChoice, type InteractiveCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { foldCursor, nextPhase, pendingCard, type CardKind } from '@snapwing/pipeline/engine/cursor.ts';
import { isTerminalStatus, type LifecycleStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
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
  /** The engine's card the response shows; set only for tracked, new, and which-surface. */
  readonly card?: { readonly kind: CardKind; readonly card: InteractiveCard };
}

const FILE_CONFIRM_LABELS: Readonly<Record<FileConfirmChoice, string>> = { 'file-it': 'File it', 'not-this-surface': 'Not this surface', cancel: 'Cancel' };
export const CANCEL_CHOICE: Choice = { id: CAPTURE_CANCEL_CHOICE, label: 'Cancel' };

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

export async function lookupCapture(deps: LookupDeps, captureId: string): Promise<CaptureLookup> {
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
  const response = await responseFor(deps, captureId, card);
  return response === undefined ? pending : { response, card: { kind: waiting, card } };
}

async function responseFor(deps: LookupDeps, captureId: string, card: InteractiveCard): Promise<LookupResponse | undefined> {
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
    default:
      return undefined;
  }
}

/** The engine's tap choice for a client's `choiceId` on the card a capture shows, or undefined when it offers none such. */
export function tapChoice(card: InteractiveCard, choiceId: string, map: WorkspaceMap): string | undefined {
  switch (card.kind) {
    case 'dedupe':
      // The client opens the ticket itself; a client may still link the report, or file anyway.
      return ['link', 'create-anyway', 'not-related'].includes(choiceId) ? choiceId : undefined;
    case 'file-confirm':
      return (FILE_CONFIRM_CHOICES as readonly string[]).includes(choiceId) ? choiceId : undefined;
    case 'clarify': {
      if (choiceId === CAPTURE_CANCEL_CHOICE) return choiceId;
      return surfaceChoices(card.question.options ?? [], map).find((c) => c.id === choiceId || c.label === choiceId)?.label;
    }
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

/** The incident behind a Jira key as the wire's `TicketStatus`; `who` names the assignee, else the resolved owner. */
export function ticketStatus(incident: IncidentView & { jiraKey: string }, issueUrl: (key: string) => string): TicketStatus {
  const who = incident.assigneeId ?? incident.ownerRef;
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
