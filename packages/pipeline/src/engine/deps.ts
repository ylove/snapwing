// What the orchestrator runs on (main 14.1): every port and stage input it needs, as one `EngineDeps`
// object, so tests pass fakes for each and #48 can drive the same engine end to end with MSW.

import type { ClarifyEvidence } from '../clarify/index.ts';
import type { ChatReader } from '../context/chat-reader.ts';
import type { Anchor, CollectPolicy } from '../context/collect.ts';
import type { LoadImage } from '../context/vision/index.ts';
import type { IngestionAdapter } from '../contracts/adapters.ts';
import type { CanonicalIncidentPayload, ChannelSource, Resolution } from '../contracts/incident.ts';
import type { JiraSearch } from '../dedupe/index.ts';
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

/** Status loopback (main 12, phase 3). Without one the engine posts a `filed` status through the adapter. */
export interface StatusSubscriber {
  subscribe(payload: CanonicalIncidentPayload, issueKey: string, note?: string): Promise<void>;
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
  /** A read-only view of the resolved repo for the triage scout; absent means no scout. */
  repoReader?: (resolution: Resolution) => RepoReader | undefined;
  status?: StatusSubscriber;
  /** Layer 1 evidence for the ask-back gate (reporters in the window, active alerts). */
  evidence?: (payload: CanonicalIncidentPayload, resolution: Resolution) => Promise<ClarifyEvidence>;
  clock: () => Date;
  options?: EngineOptions;
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
