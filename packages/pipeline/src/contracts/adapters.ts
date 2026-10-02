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
  | { kind: 'dedupe'; issueKey: string; summary: string; assignee?: string }
  | { kind: 'clarify'; question: ClarifyQuestion }
  | { kind: 'fix-preview'; plan: TriageResolutionPlan };

export interface StatusUpdate {
  issueKey: string;
  stage: 'filed' | 'pr-open' | 'review-passed' | 'merged' | 'staging' | 'production' | 'clarified';
  text: string;
  mentionUserId?: string;
}
