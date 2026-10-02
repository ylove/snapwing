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
  | PrReadyCard;

/** main 11.2: the card posted when a pull request is ready for a human. */
export interface PrReadyCard {
  kind: 'pr-ready';
  prNumber: number;
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
}
