/**
 * The console's routes as one table (main 20.3, #348). A row is a path pattern, a heading, an optional
 * header link, the query values it accepts, and the page that renders it, so adding a page is adding a
 * row. Paths are relative to the base the server mounts the build under (`/console/`, #355); every
 * other path under it is the same `index.html`, and this table decides what it shows.
 *
 * `/runs` and `/runs/:id` are reserved for the run list and render "not built yet" until it exists.
 * The incident page takes an optional `?patch=<sha256>` for a stored patch (#358).
 */

import type { ComponentType } from 'preact';
import { CorrectionsPage } from './pages/corrections.tsx';
import { IncidentPage } from './pages/incident.tsx';
import { NotBuiltPage } from './pages/not-built.tsx';
import { QueuePage } from './pages/queue.tsx';

export interface PageProps {
  /** The pattern's `:name` segments, decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** The query values the row accepts, each one checked by its pattern; others are dropped. */
  readonly query: Readonly<Record<string, string>>;
}

export interface RouteDef {
  /** Stable name, for tests and `aria-current`. */
  readonly id: string;
  /** `/queue`, `/incidents/:ref`. Literal segments match exactly; `:name` matches one non-empty segment. */
  readonly pattern: string;
  /** The page's heading and the document title. */
  readonly title: (params: Readonly<Record<string, string>>) => string;
  /** The header link's label, for pages reachable without a parameter. */
  readonly nav?: string;
  /** Accepted query keys and the pattern a value must match (lowercased first). */
  readonly query?: Readonly<Record<string, RegExp>>;
  readonly page: ComponentType<PageProps>;
}

/** A SHA-256 digest in lowercase hex: how a stored patch is named. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Where the bare base path goes. */
export const HOME_PATH = '/queue';

export const ROUTES: readonly RouteDef[] = [
  { id: 'queue', pattern: '/queue', title: () => 'Queue', nav: 'Queue', page: QueuePage },
  { id: 'corrections', pattern: '/corrections', title: () => 'Corrections', nav: 'Corrections', page: CorrectionsPage },
  {
    id: 'incident',
    pattern: '/incidents/:ref',
    title: (p) => `Incident ${p['ref'] ?? ''}`.trim(),
    query: { patch: SHA256_HEX },
    page: IncidentPage,
  },
  { id: 'runs', pattern: '/runs', title: () => 'Runs', page: NotBuiltPage },
  { id: 'run', pattern: '/runs/:id', title: (p) => `Run ${p['id'] ?? ''}`.trim(), page: NotBuiltPage },
];

export interface RouteMatch {
  readonly route: RouteDef;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * The row for an app path (`/incidents/WEB-1`, already relative to the base) and its search string,
 * or undefined. A trailing slash is ignored; a segment that does not decode matches nothing.
 */
export function matchRoute(path: string, search = '', routes: readonly RouteDef[] = ROUTES): RouteMatch | undefined {
  const segments = splitPath(path);
  if (segments === undefined) return undefined;
  for (const route of routes) {
    const params = matchPattern(route.pattern, segments);
    if (params !== undefined) return { route, params, query: acceptedQuery(route, search) };
  }
  return undefined;
}

function splitPath(path: string): string[] | undefined {
  if (!path.startsWith('/')) return undefined;
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed === '/' ? [] : trimmed.slice(1).split('/');
}

function matchPattern(pattern: string, segments: readonly string[]): Record<string, string> | undefined {
  const parts = pattern === '/' ? [] : pattern.slice(1).split('/');
  if (parts.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    const segment = segments[i] ?? '';
    if (part.startsWith(':')) {
      if (segment === '') return undefined;
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
      params[part.slice(1)] = decoded;
    } else if (part !== segment) {
      return undefined;
    }
  }
  return params;
}

function acceptedQuery(route: RouteDef, search: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (route.query === undefined) return out;
  const given = new URLSearchParams(search);
  for (const [key, pattern] of Object.entries(route.query)) {
    const value = given.get(key)?.toLowerCase();
    if (value !== undefined && pattern.test(value)) out[key] = value;
  }
  return out;
}

/** The app path for a browser pathname under `base` (`/console/queue` to `/queue`), or undefined outside it. */
export function appPath(pathname: string, base: string): string | undefined {
  const root = base.endsWith('/') ? base : `${base}/`;
  if (pathname === root || pathname === root.slice(0, -1)) return '/';
  return pathname.startsWith(root) ? `/${pathname.slice(root.length)}` : undefined;
}

/** The browser href for an app path (`/queue` to `/console/queue`). */
export function hrefFor(path: string, base: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${path.replace(/^\/+/, '')}`;
}

/** The app path of an incident page, with the stored patch when one is named. */
export function incidentPath(ref: string, patch?: string): string {
  const path = `/incidents/${encodeURIComponent(ref)}`;
  return patch === undefined ? path : `${path}?patch=${encodeURIComponent(patch)}`;
}
