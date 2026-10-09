// Typed workspace map (main 4.2). Mirrors schemas/workspace-context.xsd.

import type { ValidationError } from '../schemas/validate.ts';

export type MapActorRole = 'engineer' | 'reporter' | 'unknown';
export type AutonomyLevelId = 0 | 1 | 2 | 3;
export type FixerStart = 'never' | 'on-tap' | 'immediate';
export type MergeActor = 'none' | 'human' | 'agent';
export type AutonomyGate = 'review-agent' | 'ci-green' | 'risk-gate';
export type JiraPriorityName = 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
export type ChannelConfidence = 'explicit' | 'inferred';
export type ChannelPlatform = 'slack' | 'teams';

/** A channel's platform; the map omits it for Slack, so absent means `slack`. */
export function channelPlatform(channel: { platform?: ChannelPlatform }): ChannelPlatform {
  return channel.platform ?? 'slack';
}

/** The `surface` value of a channel whose surface comes from the alert payload. */
export const FROM_PAYLOAD = 'from-payload';

export interface MapComponent {
  id: string;
  label: string;
}

export interface MapSurface {
  id: string;
  label: string;
  repo: string;
  /** The branch this surface's fixes start from and open pull requests into (#310). Absent: the repository default. */
  repoBase?: string;
  jira: { project: string; defaultIssueType: string };
  components: MapComponent[];
}

export interface MapChannel {
  id: string;
  name: string;
  /** A surface id, or `from-payload`. */
  surface: string;
  confidence?: ChannelConfidence;
  /** Absent means `slack` (see `channelPlatform`). A Teams channel id is the Bot Framework and Graph id (`19:...@thread.tacv2`). */
  platform?: ChannelPlatform;
  /** The Teams team's group id; present exactly when `platform` is `teams`. */
  teamId?: string;
  /** Per-channel emoji overrides (reaction names). */
  triggerEmoji: string[];
}

export interface EmojiTrigger {
  slack: string;
  teams: string;
  minReactors?: number;
}

export interface MapTriggers {
  messageActions: { label: string }[];
  emoji: EmojiTrigger[];
  directMessage?: { images: boolean; text: boolean };
  cli?: { enabled: boolean };
}

export interface MapTerm {
  text: string;
  surface: string;
  component?: string;
}

export interface MapOwnership {
  surface: string;
  component?: string;
  primary: boolean;
}

export interface MapPerson {
  slackId?: string;
  teamsId?: string;
  handle: string;
  email?: string;
  role: MapActorRole;
  owns: MapOwnership[];
}

export interface AutonomyLevel {
  id: AutonomyLevelId;
  name: string;
  fixer: FixerStart;
  merge: MergeActor;
  requires: AutonomyGate[];
}

/** Who changed an autonomy level and when (main 4.6). `changedBy` is a map handle or an email; `changedAt` is ISO 8601. */
export interface AutonomyChange {
  changedBy?: string;
  changedAt?: string;
}

export type AutonomyOverride =
  | ({ kind: 'surface'; ref: string; level: AutonomyLevelId } & AutonomyChange)
  | ({ kind: 'component'; surface: string; ref: string; level: AutonomyLevelId } & AutonomyChange)
  | ({ kind: 'priority'; atLeast: JiraPriorityName; level: AutonomyLevelId } & AutonomyChange);

export interface MapAutonomy extends AutonomyChange {
  default: AutonomyLevelId;
  levels: AutonomyLevel[];
  overrides: AutonomyOverride[];
}

export interface MapRiskGate {
  maxFilesTouched: number;
  maxDiffLines: number;
  forbiddenPaths: string[];
}

export interface MapPolicies {
  askBack?: { maxQuestionsPerIncident: number; suppressWhenReportersAtLeast: number };
  autonomy: MapAutonomy;
  riskGate?: MapRiskGate;
}

export interface WorkspaceMap {
  org: string;
  /** ISO 8601 timestamp, as written in the document. */
  updated: string;
  surfaces: MapSurface[];
  /** Surface id whose Jira project takes reports that route nowhere (ADR 0015). Checked by Schematron. */
  fallbackSurface?: string;
  channels: MapChannel[];
  triggers: MapTriggers;
  vocabulary: MapTerm[];
  people: MapPerson[];
  policies: MapPolicies;
}

/** Thrown by `parseWorkspaceMap` for malformed, structurally invalid, or cross-reference-invalid input. */
export class InvalidMapError extends Error {
  readonly errors: readonly ValidationError[];

  constructor(errors: readonly ValidationError[]) {
    const first = errors[0];
    const head = first === undefined ? 'unknown error' : `${first.line === undefined ? '' : `line ${first.line}: `}${first.message}`;
    super(`Invalid workspace map (${errors.length} error${errors.length === 1 ? '' : 's'}): ${head}`);
    this.name = 'InvalidMapError';
    this.errors = errors;
  }
}
