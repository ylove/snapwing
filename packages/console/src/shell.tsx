/**
 * The console shell (main 20.3, #348): the landmarks (a skip link, the banner with the console's
 * navigation, one main region), client-side routing over the route table, and focus. Links are plain
 * `<a href>`s; a click on one under the base path is routed here without a page load, anything else
 * (another origin, a new tab, a download, an in-page anchor) is left to the browser.
 *
 * After a navigation, focus moves to the page heading so a screen reader announces the new page and
 * keyboard focus starts at the top of it; the first load leaves focus where the browser put it.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from './api.ts';
import { ApiContext } from './components/api-state.tsx';
import { HOME_PATH, ROUTES, appPath, hrefFor, matchRoute, type RouteDef } from './routes.ts';

export interface ShellProps {
  readonly api: ApiClient;
  /** The path the build is served under. Defaults to the build's base, `/console/`. */
  readonly base?: string;
  readonly routes?: readonly RouteDef[];
}

interface Place {
  /** Relative to the base; undefined when the address is outside it. */
  readonly path: string | undefined;
  readonly search: string;
}

function readPlace(base: string): Place {
  return { path: appPath(window.location.pathname, base), search: window.location.search };
}

export function Shell({ api, base = import.meta.env.BASE_URL, routes = ROUTES }: ShellProps) {
  const [place, setPlace] = useState<Place>(() => readPlace(base));
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const go = useCallback(
    (href: string, how: 'push' | 'replace') => {
      if (how === 'push') window.history.pushState(null, '', href);
      else window.history.replaceState(window.history.state, '', href);
      setPlace(readPlace(base));
    },
    [base],
  );

  // The bare base path shows the home page under its own address.
  useEffect(() => {
    if (place.path === '/') go(`${hrefFor(HOME_PATH, base)}${place.search}`, 'replace');
  }, [place, base, go]);

  useEffect(() => {
    const onPop = () => {
      moved.current = true;
      setPlace(readPlace(base));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [base]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onClick = (event: MouseEvent) => {
      const href = routedHref(event, base);
      if (href === undefined) return;
      event.preventDefault();
      moved.current = true;
      go(href, 'push');
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [base, go]);

  const path = place.path === '/' ? HOME_PATH : place.path;
  const match = path === undefined ? undefined : matchRoute(path, place.search, routes);
  const title = match === undefined ? 'Not found' : match.route.title(match.params);

  useEffect(() => {
    document.title = `${title} - Snapwing console`;
    if (moved.current) headingRef.current?.focus();
  }, [title, place]);

  const Page = match?.route.page;
  return (
    <ApiContext.Provider value={api}>
      <div class="shell" ref={rootRef}>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <header class="masthead">
          <a class="brand" href={hrefFor(HOME_PATH, base)}>
            Snapwing <span class="brand-sub">console</span>
          </a>
          <nav aria-label="Console">
            <ul>
              {routes.map((route) =>
                route.nav === undefined ? null : (
                  <li key={route.id}>
                    <a href={hrefFor(route.pattern, base)} aria-current={match?.route.id === route.id ? 'page' : undefined}>
                      {route.nav}
                    </a>
                  </li>
                ),
              )}
            </ul>
          </nav>
        </header>
        <main id="main" tabIndex={-1}>
          <h1 ref={headingRef} tabIndex={-1}>
            {title}
          </h1>
          {match === undefined || Page === undefined ? (
            <NotFound base={base} />
          ) : (
            <Page key={`${path ?? ''}${place.search}`} params={match.params} query={match.query} />
          )}
        </main>
      </div>
    </ApiContext.Provider>
  );
}

function NotFound({ base }: { readonly base: string }) {
  return (
    <p>
      There is no console page at this address. <a href={hrefFor(HOME_PATH, base)}>Go to the queue</a>.
    </p>
  );
}

/** The href to route in the page for a click, or undefined to leave the click to the browser. */
export function routedHref(event: MouseEvent, base: string): string | undefined {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  const anchor = target.closest('a');
  if (anchor === null || anchor.hasAttribute('download')) return undefined;
  if (anchor.target !== '' && anchor.target !== '_self') return undefined;
  const raw = anchor.getAttribute('href');
  if (raw === null || raw.startsWith('#')) return undefined;
  let url: URL;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return undefined;
  }
  if (url.origin !== window.location.origin || appPath(url.pathname, base) === undefined) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}
