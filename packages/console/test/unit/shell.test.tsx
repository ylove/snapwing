// The console shell (#348): the route table, the reserved routes, the API client's 401 and 403
// paths, and the shell's landmarks, navigation and focus, on happy-dom.

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE, createApiClient, describeProblem, type ApiClient, type ApiProblem } from '../../src/api.ts';
import { ROUTES, appPath, hrefFor, incidentPath, matchRoute, type PageProps, type RouteDef } from '../../src/routes.ts';
import { Shell, routedHref } from '../../src/shell.tsx';

const BASE = '/console/';
const SHA = 'ab'.repeat(32);

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake `fetch` answering every call with one status and body, recording what it was asked. */
function fakeFetch(status: number, body?: unknown, raw?: string) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const text = raw ?? (body === undefined ? '' : JSON.stringify(body));
    return new Response(status === 204 ? null : text, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetch };
}

const QUEUE = {
  kind: 'engineer',
  title: 'Your queue',
  sections: [
    { id: 'assigned', title: 'Assigned to me', empty: 'Nothing assigned to you.', items: [] },
    {
      id: 'fixing',
      title: 'Fixing now',
      empty: 'Nothing being fixed.',
      items: [{ incidentId: '01JTEST', label: 'WEB-1', summary: 'Cart total wrong', detail: 'PR #31', buttons: [{ kind: 'stop' }] }],
    },
  ],
};

describe('route table', () => {
  it('matches each page and passes decoded params', () => {
    expect(matchRoute('/queue')?.route.id).toBe('queue');
    expect(matchRoute('/queue/')?.route.id).toBe('queue');
    expect(matchRoute('/corrections')?.route.id).toBe('corrections');
    const incident = matchRoute('/incidents/WEB-1042');
    expect(incident?.route.id).toBe('incident');
    expect(incident?.params).toEqual({ ref: 'WEB-1042' });
    expect(matchRoute('/incidents/team%2FWEB%201')?.params).toEqual({ ref: 'team/WEB 1' });
  });

  it('matches nothing for other paths, extra or missing segments, and a segment that does not decode', () => {
    for (const path of ['/', '/nope', '/incidents', '/incidents/', '/incidents/a/b', '/queue/x', 'queue', '/Queue', '/incidents/%E0%A4%A']) {
      expect(matchRoute(path), path).toBeUndefined();
    }
  });

  it('passes a stored patch digest to the incident page, lowercased, and drops anything else', () => {
    expect(matchRoute('/incidents/WEB-1', `?patch=${SHA}`)?.query).toEqual({ patch: SHA });
    expect(matchRoute('/incidents/WEB-1', `?patch=${SHA.toUpperCase()}&x=1`)?.query).toEqual({ patch: SHA });
    expect(matchRoute('/incidents/WEB-1', '?patch=abc')?.query).toEqual({});
    expect(matchRoute('/incidents/WEB-1', `?patch=${SHA}0`)?.query).toEqual({});
    expect(matchRoute('/incidents/WEB-1')?.query).toEqual({});
    expect(matchRoute('/queue', `?patch=${SHA}`)?.query).toEqual({});
    expect(incidentPath('WEB 1', SHA)).toBe(`/incidents/WEB%201?patch=${SHA}`);
  });

  it('reserves /runs and /runs/:id, outside the navigation', () => {
    expect(matchRoute('/runs')?.route.id).toBe('runs');
    const run = matchRoute('/runs/01JRUN');
    expect(run?.route.id).toBe('run');
    expect(run?.params).toEqual({ id: '01JRUN' });
    expect(ROUTES.filter((r) => r.nav !== undefined).map((r) => r.id)).toEqual(['queue', 'corrections']);
  });

  it('maps browser paths under the base to app paths and back', () => {
    expect(appPath('/console/queue', BASE)).toBe('/queue');
    expect(appPath('/console/', BASE)).toBe('/');
    expect(appPath('/console', BASE)).toBe('/');
    expect(appPath('/consoles/queue', BASE)).toBeUndefined();
    expect(appPath('/healthz', BASE)).toBeUndefined();
    expect(hrefFor('/queue', BASE)).toBe('/console/queue');
    expect(hrefFor('/queue', '/console')).toBe('/console/queue');
  });
});

describe('API client', () => {
  it('calls /console/api on the same origin with credentials and validates the answer', async () => {
    const { calls, fetch } = fakeFetch(200, QUEUE);
    const result = await createApiClient({ fetch }).queue();
    expect(result).toEqual({ ok: true, value: QUEUE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE}/queue`);
    expect(calls[0]?.url.startsWith('/console/api/')).toBe(true);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('refuses a 2xx body that does not validate, or is not JSON', async () => {
    const bad = await createApiClient({ fetch: fakeFetch(200, { kind: 'engineer', title: 'Q', sections: [{ id: 'nope' }] }).fetch }).queue();
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problem).toMatchObject({ kind: 'invalid-response', error: expect.stringContaining('sections[0].id') });
    const html = await createApiClient({ fetch: fakeFetch(200, undefined, '<html>sign in</html>').fetch }).queue();
    expect(html).toEqual({ ok: false, problem: { kind: 'invalid-response', error: 'the body is not JSON' } });
  });

  it('sends a JSON body on a write', async () => {
    const { calls, fetch } = fakeFetch(200, { done: true });
    const validate = (v: unknown) => (typeof v === 'object' && v !== null ? { ok: true as const, value: v } : { ok: false as const, error: 'no' });
    const result = await createApiClient({ fetch }).request('/things/1', { method: 'POST', body: { a: 1 }, need: 'admin', validate });
    expect(result.ok).toBe(true);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('refuses a path that is not under the console API', async () => {
    const api = createApiClient({ fetch: fakeFetch(200, {}).fetch });
    const validate = (v: unknown) => ({ ok: true as const, value: v });
    for (const path of ['queue', '//evil.example/x', '/../healthz', '/a/./b']) {
      await expect(api.request(path, { need: 'engineer', validate }), path).rejects.toThrow(TypeError);
    }
  });

  it('turns a 401 into how to get a sign-in link from chat', async () => {
    const result = await createApiClient({ fetch: fakeFetch(401, { need: 'engineer' }).fetch }).queue();
    expect(result).toEqual({ ok: false, problem: { kind: 'signed-out' } });
    const text = describeProblem({ kind: 'signed-out' });
    const all = [text.title, ...text.lines].join(' ');
    expect(all).toContain('Sign in from chat');
    expect(all).toContain("Snapwing's Home tab");
    expect(all).toContain('Open console');
    expect(all).toContain('Teams');
    expect(all).toContain('queue card');
  });

  it('turns a 403 into the role needed: the one the server names, else the one the call needs', async () => {
    const named = await createApiClient({ fetch: fakeFetch(403, { need: 'admin' }).fetch }).queue();
    expect(named).toEqual({ ok: false, problem: { kind: 'forbidden', need: 'admin' } });
    const bare = await createApiClient({ fetch: fakeFetch(403).fetch }).queue();
    expect(bare).toEqual({ ok: false, problem: { kind: 'forbidden', need: 'engineer' } });
    const unknown = await createApiClient({ fetch: fakeFetch(403, { need: 'owner' }).fetch }).queue();
    expect(unknown).toEqual({ ok: false, problem: { kind: 'forbidden', need: 'engineer' } });

    const admin = describeProblem({ kind: 'forbidden', need: 'admin' });
    expect(admin.title).toBe('Admin role needed');
    expect(admin.lines.join(' ')).toContain('admin flag');
    expect(describeProblem({ kind: 'forbidden', need: 'engineer' }).title).toBe('Engineer role needed');
  });

  it('words the other failures and keeps a short server message', async () => {
    const conflict = await createApiClient({ fetch: fakeFetch(409, { message: 'Already decided.' }).fetch }).queue();
    expect(conflict).toEqual({ ok: false, problem: { kind: 'conflict', message: 'Already decided.' } });
    const failed = await createApiClient({ fetch: fakeFetch(500, { error: 'x'.repeat(1000) }).fetch }).queue();
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.problem.kind === 'failed') {
      expect(failed.problem.status).toBe(500);
      expect(failed.problem.message?.length).toBe(300);
    } else expect.fail('expected a failed problem');
    const offline = await createApiClient({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    }).queue();
    expect(offline).toEqual({ ok: false, problem: { kind: 'network' } });

    const kinds: ApiProblem[] = [
      { kind: 'not-found' },
      { kind: 'conflict' },
      { kind: 'failed', status: 502 },
      { kind: 'invalid-response', error: 'kind must be engineer or reporter' },
      { kind: 'network' },
    ];
    for (const p of kinds) {
      const text = describeProblem(p);
      expect(text.title.length, p.kind).toBeGreaterThan(0);
      expect(text.lines.length, p.kind).toBeGreaterThan(0);
    }
  });
});

describe('shell', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => render(null, container));
    container.remove();
  });

  function at(path: string): void {
    window.history.replaceState(null, '', path);
  }

  async function mount(api: ApiClient, routes?: readonly RouteDef[]): Promise<void> {
    await act(() => render(<Shell api={api} base={BASE} {...(routes === undefined ? {} : { routes })} />, container));
    await settle();
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function click(el: Element): Promise<void> {
    await act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
  }

  const heading = () => container.querySelector('h1')?.textContent;
  const current = () => container.querySelector('nav a[aria-current="page"]')?.textContent;

  it('has the landmarks in focus order: skip link, banner with navigation, main', async () => {
    at('/console/queue');
    await mount(createApiClient({ fetch: fakeFetch(200, QUEUE).fetch }));
    const focusable = [...container.querySelectorAll('a[href], [tabindex]')];
    expect(focusable[0]?.textContent).toBe('Skip to content');
    expect(focusable[0]?.getAttribute('href')).toBe('#main');
    expect(container.querySelector('header nav[aria-label="Console"]')).not.toBeNull();
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelector('main')?.id).toBe('main');
    expect([...container.querySelectorAll('nav a')].map((a) => a.getAttribute('href'))).toEqual(['/console/queue', '/console/corrections']);
    expect(current()).toBe('Queue');
    expect(heading()).toBe('Queue');
    expect(document.title).toBe('Queue - Snapwing console');
    expect(container.textContent).toContain('Fixing now: 1');
  });

  it('shows how to get a sign-in link from chat when the API answers 401', async () => {
    at('/console/queue');
    await mount(createApiClient({ fetch: fakeFetch(401, { need: 'engineer' }).fetch }));
    const problem = container.querySelector('[data-problem="signed-out"]');
    expect(problem).not.toBeNull();
    expect(problem?.querySelector('h2')?.textContent).toBe('Sign in from chat');
    expect(problem?.textContent).toContain("In Slack, open Snapwing's Home tab and choose Open console.");
    expect(problem?.textContent).toContain('In Teams, send queue to Snapwing and choose Open console on the queue card.');
    expect(problem?.getAttribute('aria-labelledby')).toBe(problem?.querySelector('h2')?.id);
  });

  it('says which role is needed when the API answers 403', async () => {
    at('/console/queue');
    await mount(createApiClient({ fetch: fakeFetch(403, { need: 'engineer' }).fetch }));
    const problem = container.querySelector('[data-problem="forbidden"]');
    expect(problem?.querySelector('h2')?.textContent).toBe('Engineer role needed');
    expect(problem?.textContent).toContain('needs the engineer role');
  });

  it('renders the reserved routes as not built yet', async () => {
    const { calls, fetch } = fakeFetch(200, QUEUE);
    at('/console/runs');
    await mount(createApiClient({ fetch }));
    expect(heading()).toBe('Runs');
    expect(container.querySelector('main')?.textContent).toContain('not built yet');
    expect(current()).toBeUndefined();
    act(() => render(null, container));

    at('/console/runs/01JRUN');
    await mount(createApiClient({ fetch }));
    expect(heading()).toBe('Run 01JRUN');
    expect(container.querySelector('main')?.textContent).toContain('not built yet');
    expect(calls).toHaveLength(0);
  });

  it('passes the incident ref and a stored patch to the incident page', async () => {
    at(`/console/incidents/WEB-1042?patch=${SHA}`);
    await mount(createApiClient({ fetch: fakeFetch(200, {}).fetch }));
    expect(heading()).toBe('Incident WEB-1042');
    expect(container.textContent).toContain('snapwing trace WEB-1042');
    expect(container.textContent).toContain(`Stored patch ${SHA}`);
  });

  it('sends the bare base path to the queue and shows a not-found page elsewhere', async () => {
    at('/console/');
    await mount(createApiClient({ fetch: fakeFetch(200, QUEUE).fetch }));
    expect(window.location.pathname).toBe('/console/queue');
    expect(heading()).toBe('Queue');
    act(() => render(null, container));

    at('/console/nowhere');
    await mount(createApiClient({ fetch: fakeFetch(200, QUEUE).fetch }));
    expect(heading()).toBe('Not found');
    expect(container.querySelector('main a')?.getAttribute('href')).toBe('/console/queue');
  });

  it('routes a link click in the page, moves focus to the new heading, and follows the back button', async () => {
    at('/console/queue');
    await mount(createApiClient({ fetch: fakeFetch(200, QUEUE).fetch }));
    const link = [...container.querySelectorAll('nav a')].find((a) => a.textContent === 'Corrections');
    expect(link).toBeDefined();
    await click(link as Element);
    expect(window.location.pathname).toBe('/console/corrections');
    expect(heading()).toBe('Corrections');
    expect(current()).toBe('Corrections');
    expect(document.activeElement).toBe(container.querySelector('h1'));

    await act(() => {
      window.history.replaceState(null, '', '/console/queue');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(heading()).toBe('Queue');
    expect(current()).toBe('Queue');
  });

  it('adds a page with one row', async () => {
    function HelloPage({ params }: PageProps) {
      return <p>Hello {params['name']}</p>;
    }
    const routes: readonly RouteDef[] = [
      ...ROUTES,
      { id: 'hello', pattern: '/hello/:name', title: (p) => `Hello ${p['name'] ?? ''}`, nav: 'Hello', page: HelloPage },
    ];
    expect(matchRoute('/hello/ada', '', routes)?.route.id).toBe('hello');
    at('/console/hello/ada');
    await mount(createApiClient({ fetch: fakeFetch(200, QUEUE).fetch }), routes);
    expect(heading()).toBe('Hello ada');
    expect(container.querySelector('main p')?.textContent).toBe('Hello ada');
    expect([...container.querySelectorAll('nav a')].map((a) => a.textContent)).toEqual(['Queue', 'Corrections', 'Hello']);
  });

  it('leaves other origins, new tabs, modified clicks, downloads and in-page anchors to the browser', () => {
    at('/console/queue');
    const probe = (attrs: Record<string, string>, init: MouseEventInit = {}): string | undefined => {
      const a = document.createElement('a');
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      document.body.appendChild(a);
      let seen: string | undefined;
      a.addEventListener('click', (e) => {
        seen = routedHref(e, BASE);
        e.preventDefault();
      });
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
      a.remove();
      return seen;
    };
    expect(probe({ href: '/console/incidents/WEB-1' })).toBe('/console/incidents/WEB-1');
    expect(probe({ href: 'https://jira.example.com/browse/WEB-1' })).toBeUndefined();
    expect(probe({ href: '/healthz' })).toBeUndefined();
    expect(probe({ href: '/console/queue', target: '_blank' })).toBeUndefined();
    expect(probe({ href: '/console/queue', download: '' })).toBeUndefined();
    expect(probe({ href: '#main' })).toBeUndefined();
    expect(probe({ href: '/console/queue' }, { metaKey: true })).toBeUndefined();
    expect(probe({ href: '/console/queue' }, { button: 1 })).toBeUndefined();
  });
});
