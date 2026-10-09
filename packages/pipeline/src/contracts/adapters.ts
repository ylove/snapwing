// Adapter interface: main spec section 13.

import type { CanonicalIncidentPayload, TriageResolutionPlan, ClarifyQuestion } from './incident.ts';

export interface IngestionAdapter<TRaw, TAck> {
  readonly channelSource: CanonicalIncidentPayload['source'];

  /** Cryptographic authenticity. Must be constant-time where a secret is compared. */
  authenticateRequest(raw: TRaw): Promise<boolean>;

  /** Fast, synchronous shape check plus idempotency key. Must complete well under 1s. */
  normalizePayload(raw: TRaw): Promise<CanonicalIncidentPayload>;

  /** Immediate acknowledgement to the platform (HTTP 200, ephemeral "working on it"). */
  acknowledge(raw: TRaw, payload: CanonicalIncidentPayload): Promise<TAck>;

  /** Post the scope preview, dedupe prompt, clarify question, or fix preview card. */
  postInteractive(payload: CanonicalIncidentPayload, card: InteractiveCard): Promise<void>;

  /** Post or edit the pinned status message. */
  postStatus(payload: CanonicalIncidentPayload, status: StatusUpdate): Promise<void>;
}

export type InteractiveCard =
  | { kind: 'scope-preview'; summary: string }
  | { kind: 'dedupe'; issueKey: string; summary: string; assignee?: string; openSince?: string }
  | { kind: 'clarify'; question: ClarifyQuestion }
  | { kind: 'fix-preview'; plan: TriageResolutionPlan; surface?: string; ownerUserId?: string }
  | ClaimedCard
  | PrReadyCard
  | FileConfirmCard;

/**
 * main 15.3, 15.4: a capture source's lookup when dedupe found nothing and the surface resolved:
 * "New. Looks like the website (from src/cart/... in the trace). File it?" Choices `FILE_CONFIRM_CHOICES`:
 * File it files, Not this surface asks the surface question, Cancel ends the capture unfiled. Only the
 * capture adapter holds it for its client; chat adapters render it for exhaustiveness and never post it.
 */
export interface FileConfirmCard {
  kind: 'file-confirm';
  surfaceId: string;
  /** The map label ("Website"). */
  surfaceLabel: string;
  /** What the inference matched, when it can say: the repo-relative path a `file-path` resolution found. */
  evidence?: string;
}

/** The `file-confirm` card's choices, as `TapInput.choice`. */
export const FILE_CONFIRM_CHOICES = ['file-it', 'not-this-surface', 'cancel'] as const;
export type FileConfirmChoice = (typeof FILE_CONFIRM_CHOICES)[number];

/**
 * The choice that cancels a capture source's surface question (a `clarify` card whose options are the
 * map's surface labels). Any capture card's timeout files nothing either.
 */
export const CAPTURE_CANCEL_CHOICE = 'cancel';

/**
 * A 2.1: replaces the fix preview when an engineer claimed the incident before the fixer started.
 * "Filed as WEB-1042 and assigned to @dana, since she's on it." Buttons: `let-agent-take` (Let the
 * agent take it) and `dismiss` (Not a bug).
 */
export interface ClaimedCard {
  kind: 'claimed';
  issueKey: string;
  /** Chat user id of the claimer. */
  claimerUserId: string;
}

/**
 * The pull request and the commit a PR button acts on (#264): the head the card showed for Merge and
 * Request changes, the merge commit for Revert. The button carries it back with the tap, and the action
 * is refused when either no longer matches, so a tap never acts on a PR or a commit its card did not show.
 */
export interface PrPin {
  prNumber: number;
  sha: string;
}

/** main 11.2: the card posted when a pull request is ready for a human. */
export interface PrReadyCard {
  kind: 'pr-ready';
  prNumber: number;
  /** The head commit the card shows; its Merge and Request changes act on this commit only (#264). */
  headSha: string;
  prUrl: string;
  issueKey: string;
  reviewVerdict: 'approve' | 'request-changes' | 'escalate';
  ciState: 'green' | 'red' | 'pending';
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Chat user ids of the requested reviewers. */
  reviewerUserIds: string[];
}

/** main 12: the stages of the pinned status message. */
export type StatusStage =
  | 'filed'
  | 'clarified'
  | 'fixing'
  | 'pr-open'
  | 'review-passed'
  | 'held'
  | 'merged'
  | 'stopped'
  | 'failed'
  | 'staging'
  | 'production'
  | 'reverted';

export interface StatusUpdate {
  issueKey: string;
  stage: StatusStage;
  text: string;
  mentionUserId?: string;
  /** Buttons on the status message: `stop` while a fix runs, `revert` after an autopilot merge. */
  actions?: ('stop' | 'revert')[];
  /** With `revert`: the merged PR and its merge commit, which the Revert button carries (#264). */
  pin?: PrPin;
}
