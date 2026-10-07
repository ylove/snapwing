import { describe, expect, it } from 'vitest';
import type { ApprovalAction } from '../../src/contracts/incident.ts';
import type { AutonomyLevelId, JiraPriorityName, MapAutonomy } from '../../src/map/types.ts';
import { degrade, resolveAutonomy, triggerCap } from '../../src/policy/autonomy.ts';
import { authorize, authorizeStopCommand, type AuthorizeActor, type DenyReason } from '../../src/policy/authorize.ts';

// The main 4.2 example overrides, plus a level 3 surface (mobile) and a component override
// on a level 3 surface to exercise most-restrictive-wins.
const autonomy: MapAutonomy = {
  default: 1,
  levels: [],
  overrides: [
    { kind: 'surface', ref: 'web', level: 2 },
    { kind: 'surface', ref: 'admin', level: 1 },
    { kind: 'surface', ref: 'mobile', level: 3 },
    { kind: 'component', surface: 'web', ref: 'auth-web', level: 1 },
    { kind: 'component', surface: 'mobile', ref: 'payments', level: 0 },
    { kind: 'priority', atLeast: 'Highest', level: 1 },
  ],
};
const map = { policies: { autonomy } };

describe('resolveAutonomy', () => {
  const cases: [string, string | undefined, string | undefined, JiraPriorityName, AutonomyLevelId][] = [
    ['web surface override', 'web', undefined, 'Medium', 2],
    ['web component without override inherits surface', 'web', 'nav', 'Medium', 2],
    ['auth-web component override lowers the surface', 'web', 'auth-web', 'Medium', 1],
    ['admin surface override', 'admin', undefined, 'Medium', 1],
    ['mobile level 3 surface', 'mobile', undefined, 'High', 3],
    ['Highest priority on a level 3 surface gets level 1', 'mobile', undefined, 'Highest', 1],
    ['Highest priority on a level 2 surface gets level 1', 'web', 'nav', 'Highest', 1],
    ['component 0 beats surface 3', 'mobile', 'payments', 'Low', 0],
    ['component 0 beats Highest 1', 'mobile', 'payments', 'Highest', 0],
    ['unmatched surface falls to the default', 'ops', undefined, 'Medium', 1],
    ['unresolved surface falls to the default', undefined, undefined, 'Low', 1],
    ['component id on another surface does not match', 'admin', 'auth-web', 'Low', 1],
  ];

  it.each(cases)('%s', (_name, surfaceId, componentId, priority, expected) => {
    const resolution = {
      ...(surfaceId === undefined ? {} : { surfaceId }),
      ...(componentId === undefined ? {} : { componentId }),
    };
    expect(resolveAutonomy(resolution, { priority }, map)).toBe(expected);
  });

  it('reads the component from the plan when the resolution has none', () => {
    expect(resolveAutonomy({ surfaceId: 'web' }, { priority: 'Low', componentId: 'auth-web' }, map)).toBe(1);
  });

  it('uses the default when no override matches, whatever the default is', () => {
    const m = { policies: { autonomy: { ...autonomy, default: 3 as const, overrides: [] } } };
    expect(resolveAutonomy({ surfaceId: 'web' }, { priority: 'Highest' }, m)).toBe(3);
  });

  it('is order independent: the most restrictive match wins wherever it is listed', () => {
    const reversed = { policies: { autonomy: { ...autonomy, overrides: [...autonomy.overrides].reverse() } } };
    expect(resolveAutonomy({ surfaceId: 'mobile' }, { priority: 'Highest' }, reversed)).toBe(1);
  });
});

describe('resolveAutonomy under a trigger cap (#170)', () => {
  it('a guest-only trigger at level 2 resolves to 1', () => {
    expect(resolveAutonomy({ surfaceId: 'web' }, { priority: 'Medium' }, map, triggerCap(['guest']))).toBe(1);
  });

  it('an external-only trigger at level 3 resolves to 1', () => {
    expect(resolveAutonomy({ surfaceId: 'mobile' }, { priority: 'High' }, map, triggerCap(['external']))).toBe(1);
  });

  it('a member plus a guest at level 3 stays at 3', () => {
    expect(triggerCap(['guest', 'member'])).toBeUndefined();
    expect(resolveAutonomy({ surfaceId: 'mobile' }, { priority: 'High' }, map, triggerCap(['guest', 'member']))).toBe(3);
  });

  it('caps two guests, or a guest and an external user, at 1 with the reason', () => {
    expect(triggerCap(['guest', 'guest'])).toEqual({ level: 1, reason: 'guest-trigger' });
    expect(triggerCap(['guest', 'external'])).toEqual({ level: 1, reason: 'guest-trigger' });
  });

  it('never raises a lower level: the most restrictive rule still wins', () => {
    const cap = triggerCap(['guest']);
    expect(resolveAutonomy({ surfaceId: 'mobile', componentId: 'payments' }, { priority: 'Low' }, map, cap)).toBe(0);
    expect(resolveAutonomy({ surfaceId: 'admin' }, { priority: 'Low' }, map, cap)).toBe(1);
    expect(resolveAutonomy({ surfaceId: 'mobile' }, { priority: 'High' }, map, { level: 2 })).toBe(2);
  });
});

describe('degrade', () => {
  it.each([
    [3, 2],
    [2, 1],
    [1, 0],
    [0, 0],
  ] as [AutonomyLevelId, AutonomyLevelId][])('level %i drops to %i and keeps the reason', (from, to) => {
    expect(degrade(from, 'CI red')).toEqual({ level: to, reason: 'CI red' });
  });
});

describe('authorize', () => {
  const engineer: AuthorizeActor = { kind: 'human', role: 'engineer', githubLinked: true };
  const unlinkedEngineer: AuthorizeActor = { kind: 'human', role: 'engineer', githubLinked: false };
  const reporter: AuthorizeActor = { kind: 'human', role: 'reporter', githubLinked: false };
  const linkedReporter: AuthorizeActor = { kind: 'human', role: 'reporter', githubLinked: true };
  const stranger: AuthorizeActor = { kind: 'human', role: 'unknown', githubLinked: false };
  const agent: AuthorizeActor = { kind: 'agent', role: 'unknown', githubLinked: false };

  const cases: [string, ApprovalAction, AuthorizeActor, AutonomyLevelId, true | DenyReason, boolean?][] = [
    ['anyone may choose ticket only', 'ticket_only', stranger, 1, true],
    ['anyone may dismiss', 'dismiss', reporter, 2, true],
    ['engineer starts a fixer at level 1', 'approve_fix', engineer, 1, true],
    ['reporter cannot start a fixer', 'approve_fix', reporter, 1, 'engineer-required'],
    ['unknown actor cannot start a fixer', 'approve_fix', stranger, 1, 'engineer-required'],
    ['the Fix it tap does not exist at level 2', 'approve_fix', engineer, 2, 'level-disallows'],
    ['the Fix it tap does not exist at level 0', 'approve_fix', engineer, 0, 'level-disallows'],
    ['linked human merges at level 1', 'merge', linkedReporter, 1, true],
    ['linked human merges at level 2', 'merge', engineer, 2, true],
    ['unlinked engineer cannot merge at level 1', 'merge', unlinkedEngineer, 1, 'linked-identity-required'],
    ['the bot cannot merge at level 2', 'merge', agent, 2, 'linked-identity-required'],
    ['only the agent merges at level 3', 'merge', engineer, 3, 'agent-merges'],
    ['anyone may stop at level 2', 'stop', reporter, 2, true],
    ['stop at level 1 with nothing running', 'stop', engineer, 1, 'nothing-to-stop', false],
    ['stop at level 1 while a fixer runs', 'stop', reporter, 1, true, true],
    ['stop at level 0 has nothing to stop', 'stop', engineer, 0, 'nothing-to-stop', true],
  ];

  it('covers 16 cases', () => {
    expect(cases).toHaveLength(16);
  });

  it.each(cases)('%s', (_name, action, actor, level, expected, fixerActive = false) => {
    const decision = authorize(action, actor, { level, fixerActive });
    if (expected === true) {
      expect(decision).toEqual({ allowed: true });
    } else {
      expect(decision).toMatchObject({ allowed: false, reason: expected });
    }
  });

  it('tells a reporter tapping Fix it that the owner is asked', () => {
    expect(authorize('approve_fix', reporter, { level: 1, fixerActive: false })).toEqual({
      allowed: false,
      reason: 'engineer-required',
      askOwner: true,
    });
  });

  it('allows the agent to merge at level 3', () => {
    expect(authorize('merge', agent, { level: 3, fixerActive: false })).toEqual({ allowed: true });
  });

  it('nothing merges at level 0', () => {
    expect(authorize('merge', engineer, { level: 0, fixerActive: false })).toMatchObject({ allowed: false, reason: 'level-disallows' });
  });

  it('request_changes and revert follow the fixer and merge rules', () => {
    expect(authorize('request_changes', engineer, { level: 2, fixerActive: false })).toEqual({ allowed: true });
    expect(authorize('request_changes', reporter, { level: 2, fixerActive: false })).toMatchObject({ reason: 'engineer-required' });
    expect(authorize('revert', engineer, { level: 3, fixerActive: false })).toEqual({ allowed: true });
    expect(authorize('revert', reporter, { level: 3, fixerActive: false })).toMatchObject({ reason: 'linked-identity-required' });
  });

  it('the stop command (CLI, Raycast) is for engineers only, then follows the Stop button by level', () => {
    expect(authorizeStopCommand(engineer, { level: 2, fixerActive: false })).toEqual({ allowed: true });
    expect(authorizeStopCommand(unlinkedEngineer, { level: 1, fixerActive: true })).toEqual({ allowed: true });
    expect(authorizeStopCommand(reporter, { level: 2, fixerActive: true })).toMatchObject({ allowed: false, reason: 'engineer-required' });
    expect(authorizeStopCommand(stranger, { level: 3, fixerActive: true })).toMatchObject({ allowed: false, reason: 'engineer-required' });
    expect(authorizeStopCommand(engineer, { level: 0, fixerActive: false })).toMatchObject({ allowed: false, reason: 'nothing-to-stop' });
    expect(authorizeStopCommand(engineer, { level: 1, fixerActive: false })).toMatchObject({ allowed: false, reason: 'nothing-to-stop' });
  });
});
