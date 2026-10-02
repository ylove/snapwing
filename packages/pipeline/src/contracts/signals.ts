// Signal contracts: Companion A section 7.
import type { ApprovalAction, IncidentActor } from './incident.ts';

export type Intent =
  | 'trigger' | 'escalate' | 'claim' | 'release' | 'stop'
  | 'accept' | 'reject' | 'watch' | 'not-a-bug' | 'none';

export type TargetRole =
  | 'anchor' | 'scope-preview' | 'dedupe' | 'fix-preview' | 'pr' | 'staging-check' | 'status' | 'other';

export interface SignalEvent {
  incidentId?: string;             // absent if no incident exists yet
  intent: Intent;
  confidence: number;              // 1.0 for reactions and lexicon hits
  source: 'reaction' | 'reaction-removed' | 'message';
  platform: 'slack' | 'teams';
  actor: IncidentActor;            // includes role from the map
  target: { role: TargetRole; messageId: string };
  environment?: string;            // "staging", when the signal names one
  raw: string;                     // emoji name or message text
  timestamp: string;
}

export interface Claim {
  incidentId: string;
  claimer: IncidentActor;
  since: string;
  lastActivity: string;
  environmentHold?: { environment: string; since: string; expiresAt: string };
  expiresAt: string;
}

export interface EscalationScore {
  incidentId: string;
  intent: 'trigger' | 'escalate' | 'accept' | 'reject';
  uniqueReactors: string[];
  score: number;
  ladderStepReached?: number;
}

export type { IncidentEvent } from './events.ts';

export interface StatusQuery {
  asker: IncidentActor;
  text: string;
  context: { channelId?: string; threadId?: string };
}

export interface StatusAnswer {
  incidentId?: string;             // absent for surface-level answers
  audience: 'reporter' | 'engineer' | 'lead';
  text: string;                    // rendered per audience
  waitingOn: { kind: 'ci' | 'review' | 'human' | 'deploy' | 'hold' | 'nothing'; who?: string; since?: string };
  nextStep: string;
  actions: ApprovalAction[];
}
