// Autonomy dial resolution (main 4.6). Pure functions over the workspace map.

import type { LevelCap, Resolution, TriageResolutionPlan } from '../contracts/incident.ts';
import type { AutonomyLevelId, JiraPriorityName, WorkspaceMap } from '../map/types.ts';

const PRIORITY_RANK: Record<JiraPriorityName, number> = {
  Lowest: 0,
  Low: 1,
  Medium: 2,
  High: 3,
  Highest: 4,
};

/** The specificity order of override kinds, most specific first (main 4.6). */
export const OVERRIDE_ORDER = ['component', 'surface', 'priority'] as const;

export interface AutonomyInput {
  surfaceId?: Resolution['surfaceId'];
  componentId?: Resolution['componentId'];
}

export interface PlanPriority {
  priority: TriageResolutionPlan['priority'];
  componentId?: TriageResolutionPlan['componentId'];
}

/**
 * Resolve the autonomy level for one incident. Overrides are considered most specific first
 * (component, surface, priority), then the map default. When several overrides match, the most
 * restrictive (lowest level) wins, so a `Highest` bug on a level 3 surface still gets a human. A
 * `cap` from capture (#170) is one more such rule: it lowers the level, never raises it.
 */
export function resolveAutonomy(
  resolution: AutonomyInput,
  plan: PlanPriority,
  map: Pick<WorkspaceMap, 'policies'>,
  cap?: Pick<LevelCap, 'level'>,
): AutonomyLevelId {
  const { autonomy } = map.policies;
  const componentId = resolution.componentId ?? plan.componentId;
  let result: AutonomyLevelId | undefined;
  for (const kind of OVERRIDE_ORDER) {
    for (const o of autonomy.overrides) {
      if (o.kind !== kind) continue;
      const matches =
        o.kind === 'component'
          ? resolution.surfaceId === o.surface && componentId === o.ref
          : o.kind === 'surface'
            ? resolution.surfaceId === o.ref
            : PRIORITY_RANK[plan.priority] >= PRIORITY_RANK[o.atLeast];
      if (matches && (result === undefined || o.level < result)) result = o.level;
    }
  }
  const level = result ?? autonomy.default;
  return cap !== undefined && cap.level < level ? cap.level : level;
}

/** Who someone is to the workspace, as a chat adapter classifies the people behind a trigger (#170). */
export type Membership = 'member' | 'guest' | 'external';

/** The highest level a trigger with no member among its counted reactors may reach (#170). */
export const GUEST_TRIGGER_LEVEL = 1;

/**
 * The cap a trigger's counted reactors put on the level (#170): none when a member is among them,
 * else level 1, so an engineer's `Fix it` starts the fixer. Guests and external users still count
 * toward `minReactors`; only a member lifts the cap.
 */
export function triggerCap(reactors: readonly Membership[]): LevelCap | undefined {
  return reactors.includes('member') ? undefined : { level: GUEST_TRIGGER_LEVEL, reason: 'guest-trigger' };
}

export interface Degradation {
  level: AutonomyLevelId;
  /** Goes into the status message: degradation is never silent. */
  reason: string;
}

/** Drop one level (never below 0) and carry the reason for the status message. */
export function degrade(level: AutonomyLevelId, reason: string): Degradation {
  const next: AutonomyLevelId = level === 3 ? 2 : level === 2 ? 1 : 0;
  return { level: next, reason };
}
