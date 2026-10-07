// Action authorization (ADR 0007, main 16, main 8.2). A pure function of
// (action, role, linked identity, level). Anyone may trigger; only engineers start a fixer;
// only linked humans merge at levels 1 and 2.

import type { ApprovalAction } from '../contracts/incident.ts';
import type { AutonomyLevelId, MapActorRole } from '../map/types.ts';

export interface AuthorizeActor {
  /** `agent` is the autopilot merge step; everything else is a human. */
  kind: 'human' | 'agent';
  /** Resolved from the workspace map. */
  role: MapActorRole;
  /** True when the actor has a linked GitHub identity. */
  githubLinked: boolean;
}

export interface AuthorizeContext {
  level: AutonomyLevelId;
  /** True while a fixer run or an agent PR is active (at level 1 this follows an engineer's Fix it tap). */
  fixerActive: boolean;
}

export type DenyReason =
  | 'engineer-required'
  | 'linked-identity-required'
  | 'agent-merges'
  | 'level-disallows'
  | 'nothing-to-stop';

export type AuthorizeDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: DenyReason;
      /** A reporter asking for `Fix it` gets "I've asked the owner to approve" (main 8.2). */
      askOwner?: boolean;
    };

const ALLOW: AuthorizeDecision = { allowed: true };

function deny(reason: DenyReason, askOwner?: boolean): AuthorizeDecision {
  return askOwner === true ? { allowed: false, reason, askOwner } : { allowed: false, reason };
}

export function authorize(action: ApprovalAction, actor: AuthorizeActor, ctx: AuthorizeContext): AuthorizeDecision {
  const { level } = ctx;
  switch (action) {
    case 'ticket_only':
    case 'dismiss':
      return ALLOW;

    case 'approve_fix':
      // The tap only exists at level 1; at 2 and 3 the fixer already started, at 0 it never does.
      if (level !== 1) return deny('level-disallows');
      return actor.role === 'engineer' ? ALLOW : deny('engineer-required', true);

    case 'request_changes':
      // Sends the fixer back to work, so it is a fixer start.
      if (level === 0) return deny('level-disallows');
      return actor.role === 'engineer' ? ALLOW : deny('engineer-required');

    case 'stop':
      // Always available at levels 2 and 3; at level 1 once a tapped fixer is running.
      if (level >= 2) return ALLOW;
      return level === 1 && ctx.fixerActive ? ALLOW : deny('nothing-to-stop');

    case 'merge':
      if (level === 0) return deny('level-disallows');
      if (level === 3) return actor.kind === 'agent' ? ALLOW : deny('agent-merges');
      if (actor.kind !== 'human' || !actor.githubLinked) return deny('linked-identity-required');
      return ALLOW;

    case 'revert':
      // One-tap revert acts as the linked human, never as the bot.
      if (level === 0) return deny('level-disallows');
      return actor.kind === 'human' && actor.githubLinked ? ALLOW : deny('linked-identity-required');
  }
}

/**
 * main 15.4, ADR 0022 (#385): Stop as a typed command (the capture API's `stop`, which the CLI and
 * Raycast send with a ticket key) rather than the Stop button on the incident's own card or status
 * message: engineers only, then the button's rule for the level.
 */
export function authorizeStopCommand(actor: AuthorizeActor, ctx: AuthorizeContext): AuthorizeDecision {
  if (actor.kind !== 'human' || actor.role !== 'engineer') return deny('engineer-required');
  return authorize('stop', actor, ctx);
}
