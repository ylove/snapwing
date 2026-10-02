// Map lookups shared by the resolution steps (main 4.4). Pure functions over a WorkspaceMap.

import type { MapPerson, MapSurface, WorkspaceMap } from '../map/types.ts';

export function findSurface(map: WorkspaceMap, surfaceId: string): MapSurface | undefined {
  return map.surfaces.find((s) => s.id === surfaceId);
}

export function hasComponent(surface: MapSurface, componentId: string): boolean {
  return surface.components.some((c) => c.id === componentId);
}

/** Matches a person by Slack ID, Teams ID, or handle (case-insensitive for handles). */
export function findPerson(map: WorkspaceMap, ref: string): MapPerson | undefined {
  const lower = ref.toLowerCase();
  return map.people.find((p) => p.slackId === ref || p.teamsId === ref || p.handle.toLowerCase() === lower);
}

/** Stable identity for an owner in a Resolution: the handle, which every person has. */
export function ownerIdOf(person: MapPerson): string {
  return person.handle;
}

/**
 * The probable owner for a surface and optional component: the primary owner of the component, else the
 * primary owner of the surface, else the only person who owns the surface. Ambiguity yields undefined.
 */
export function probableOwner(map: WorkspaceMap, surfaceId: string, componentId?: string): MapPerson | undefined {
  const owners = map.people.filter((p) => p.owns.some((o) => o.surface === surfaceId));
  if (componentId !== undefined) {
    const forComponent = owners.filter((p) => p.owns.some((o) => o.surface === surfaceId && o.component === componentId && o.primary));
    if (forComponent.length === 1) return forComponent[0];
  }
  const forSurface = owners.filter((p) => p.owns.some((o) => o.surface === surfaceId && o.component === undefined && o.primary));
  if (forSurface.length === 1) return forSurface[0];
  const engineers = owners.filter((p) => p.role === 'engineer');
  return engineers.length === 1 ? engineers[0] : undefined;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `term` appears in `text` as a whole word or phrase, ignoring case. */
export function containsTerm(text: string, term: string): boolean {
  const trimmed = term.trim();
  if (trimmed === '') return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}
