// Applying a clarify answer to the resolution (main 4.4 step 8, main 7, ADR 0015). When the question
// asked which surface or component the reporter was on and the answer is that entry's map label, the
// answer settles it: the resolution takes the surface or component, with the owner, repo, and Jira
// project from the map, and `resolvedBy: 'clarify'`. Any other answer leaves the resolution alone.

import type { ClarifyQuestion, Resolution } from '../contracts/incident.ts';
import type { MapSurface, WorkspaceMap } from '../map/types.ts';
import { findSurface, ownerIdOf, probableOwner } from '../resolve/lookup.ts';
import { findGap } from './index.ts';

/** A reporter picked the entry from map options: about as strong as an explicit channel mapping. */
export const CLARIFY_CONFIDENCE = 0.9;

export interface AppliedAnswer {
  appliesTo: { field: 'surface' | 'component'; id: string };
  resolution: Resolution;
}

function sameLabel(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolutionFor(map: WorkspaceMap, surface: MapSurface, componentId: string | undefined, previousOwner?: string): Resolution {
  const owner = probableOwner(map, surface.id, componentId);
  const ownerId = owner === undefined ? previousOwner : ownerIdOf(owner);
  return {
    surfaceId: surface.id,
    ...(componentId === undefined ? {} : { componentId }),
    ...(ownerId === undefined ? {} : { ownerId }),
    repo: surface.repo,
    jiraProject: surface.jira.project,
    resolvedBy: 'clarify',
    confidence: CLARIFY_CONFIDENCE,
  };
}

/**
 * The resolution after `answer`, or undefined when the answer does not name a map entry for what was
 * asked. `asks` is the recorded question's subject; when absent (a log from before ADR 0015), the gap
 * layer 1 finds in `resolution` stands in for it.
 */
export function applyAnswer(
  asks: ClarifyQuestion['asks'],
  answer: string,
  resolution: Resolution,
  map: WorkspaceMap,
): AppliedAnswer | undefined {
  const subject = asks ?? findGap(resolution, map);
  if (subject === 'surface') {
    const surface = map.surfaces.find((s) => sameLabel(s.label, answer));
    if (surface === undefined) return undefined;
    return { appliesTo: { field: 'surface', id: surface.id }, resolution: resolutionFor(map, surface, undefined) };
  }
  if (subject === 'component') {
    const surface = resolution.surfaceId === undefined ? undefined : findSurface(map, resolution.surfaceId);
    const component = surface?.components.find((c) => sameLabel(c.label, answer));
    if (surface === undefined || component === undefined) return undefined;
    return {
      appliesTo: { field: 'component', id: component.id },
      resolution: resolutionFor(map, surface, component.id, resolution.ownerId),
    };
  }
  return undefined;
}
