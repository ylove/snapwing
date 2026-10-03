// What the orchestrator runs on (main 14.1): every port and stage input it needs, as one `EngineDeps`
// object, so tests pass fakes for each and #48 can drive the same engine end to end with MSW.

import type { ClarifyEvidence } from '../clarify/index.ts';
import { defaultPlaybook, type Playbook } from '../config/playbook.ts';
import type { ChatReader } from '../context/chat-reader.ts';
import type { Anchor, CollectPolicy } from '../context/collect.ts';
import type { LoadImage } from '../context/vision/index.ts';
import type { IngestionAdapter } from '../contracts/adapters.ts';
import type { NewEvent } from '../contracts/events.ts';
import type { CanonicalIncidentPayload, ChannelSource, Resolution } from '../contracts/incident.ts';
import type { OutboxItem } from '../contracts/state.ts';
import type { JiraSearch } from '../dedupe/index.ts';
import type { WorkspaceInstructions } from '../config/instructions.ts';
import type { WorkspaceMap } from '../map/types.ts';
import type { CachePort } from '../ports/cache.ts';
import type { ModelPort } from '../ports/model.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import type { RepoReader } from '../triage/scout.ts';

/** Any channel adapter. Adapter methods are declared as methods, so a typed adapter is assignable. */
export type AnyIngestionAdapter = IngestionAdapter<unknown, unknown>;

/**
 * The read side of a chat channel (main 5.2). Without one (CLI, Raycast, alerts, a DM share) the
 * anchor is the whole bundle and there is no scope preview.
 */
export interface ContextSource {
  /** Absent for a direct channel that still knows its anchor message (a DM share with an image). */
  reader?: ChatReader;
  /** The anchor message for a payload. Called again on every resumed delivery, so it must be deterministic. */
  anchor(payload: CanonicalIncidentPayload): Promise<Anchor>;
}

/**
 * Status loopback (main 12, phase 3): subscribes the reporter once the incident is filed, and posts
 * nothing; the status message comes from the outbox (`state/projections/outbox/status.ts`). The
 * implementation is `createStatusSubscriber` (`status/subscriber.ts`). Without one the engine posts a
 * `filed` status through the adapter.
 */
export interface StatusSubscriber {
  /** `note` says why the incident was filed the way it was (an unresolved surface, a tap that timed out). */
  subscribe(payload: CanonicalIncidentPayload, issueKey: string, note?: string): Promise<StatusSubscription>;
}

/**
 * What subscribing writes. The engine appends `events` and enqueues `outbox` in the transaction that
 * ends its after-filed step, so the subscription lands with the step's own events under one
 * `expectedSeq`.
 */
export interface StatusSubscription {
  /** Events the `subscriptions` projection folds into the subscription. */
  events: NewEvent[];
  /** Rows to enqueue with them (a status edit that carries the note). */
  outbox: OutboxItem[];
}

export interface EngineOptions {
  /** The first collection window. Default `DEFAULT_COLLECT_POLICY` (PT30M, 40). */
  collectPolicy?: CollectPolicy;
  /** How long a card waits for a tap before the default applies (B 5 interactive timeout). Default PT24H. */
  tapTimeout?: string;
  /** Widen or Narrow taps honored per incident; a later one counts as Looks right. Default 3. */
  maxScopeRounds?: number;
  /** Fetches image bytes for the vision pass. Default: inline `data:` URLs only. */
  loadImage?: LoadImage;
  /** Idempotency window per channel in seconds (main 14.2). Default 24 h for Raycast, 7 days otherwise. */
  idempotencyTtlSec?: Partial<Record<ChannelSource, number>>;
  /** `createdBy` on artifacts the engine writes. Default `orchestrator`. */
  agentName?: string;
  /**
   * The Jira project an incident with no resolved surface files to, at level 0 with
   * `needs-clarification` (ADR 0015). Default: the project every map surface shares, else the first
   * surface's project.
   */
  fallbackJiraProject?: string;
}

export interface EngineDeps {
  /** The install's workspace (single tenant). Stamped on every event, artifact, and outbox row. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  model: ModelPort;
  adapters: ReadonlyMap<ChannelSource, AnyIngestionAdapter>;
  context?: ReadonlyMap<ChannelSource, ContextSource>;
  jiraSearch: JiraSearch;
  /** The recent-incidents cache for dedupe (main 6). */
  cache: CachePort;
  /** The loaded workspace map, or a getter that returns the current one. */
  map: WorkspaceMap | (() => Promise<WorkspaceMap>);
  /**
   * The live playbook (A 6.2) and INSTRUCTIONS.md (A 6.3). Getters, never captured copies: a hot reload
   * swaps what they return, so call them at the point of use. Absent means the defaults and no
   * instructions. The instructions go to `plan(...)`, `maybeAsk(...)`, and `SynthesisContext` (#283).
   */
  playbook?: () => Playbook;
  instructions?: () => WorkspaceInstructions | undefined;
  /** A read-only view of the resolved repo for the triage scout; absent means no scout. */
  repoReader?: (resolution: Resolution) => RepoReader | undefined;
  status?: StatusSubscriber;
  /** Layer 1 evidence for the ask-back gate (reporters in the window, active alerts). */
  evidence?: (payload: CanonicalIncidentPayload, resolution: Resolution) => Promise<ClarifyEvidence>;
  clock: () => Date;
  options?: EngineOptions;
  /**
   * Starts the incident's fixer (`startFixer` in fixer/job.ts, attempt 1). Called when a claim's hold
   * ends and the configured level starts a fix (A 2.1): the issue may already be In Progress, where
   * the engine's transition fires no webhook. Absent, only the transition starts it.
   */
  startFixer?: (incidentId: string) => Promise<unknown>;
  /**
   * Called once the incident's `captured` event commits. Compose points it at the signal handler's
   * `adoptPendingSignals` (signals/handler.ts), which records reactions that landed on the anchor
   * before the incident existed (A 1.4). Best effort: a failure is ignored, and the handler adopts
   * them on the next signal on the anchor instead.
   */
  onCaptured?: (incidentId: string) => Promise<unknown>;
}

export const DEFAULT_TAP_TIMEOUT = 'PT24H';
export const DEFAULT_MAX_SCOPE_ROUNDS = 3;
export const DEFAULT_AGENT_NAME = 'orchestrator';
/** main 14.2: Raycast keys live 24 h; B 8 keeps other deliveries 7 days. */
export const RAYCAST_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 7 * 24 * 60 * 60;

export function idempotencyTtlSec(deps: EngineDeps, source: ChannelSource): number {
  return deps.options?.idempotencyTtlSec?.[source] ?? (source === 'raycast' ? RAYCAST_IDEMPOTENCY_TTL_SEC : DEFAULT_IDEMPOTENCY_TTL_SEC);
}

export async function currentMap(deps: EngineDeps): Promise<WorkspaceMap> {
  return typeof deps.map === 'function' ? deps.map() : deps.map;
}

export async function currentPlaybook(deps: EngineDeps): Promise<Playbook> {
  return deps.playbook?.() ?? defaultPlaybook();
}
