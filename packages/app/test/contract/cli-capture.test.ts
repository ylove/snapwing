// Drives every capture command through `main` (the command table) against an MSW capture API whose
// routes are capture-client's `CAPTURE_ROUTES` and whose bodies are its wire types, so the CLI and
// the server contract cannot drift. The endpoint is plain http on localhost on purpose.

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clientConfigPath, loadClientConfig } from '@snapwing/capture-client/config.ts';
import {
  CAPTURE_ROUTES,
  validateAnswerRequest,
  validateCaptureRequest,
  type CaptureRequest,
  type HealthResult,
  type LookupResponse,
  type QueueView,
  type StopResult,
  type TicketStatus,
} from '@snapwing/capture-client/wire.ts';
import type { CaptureEnv } from '../../src/cli/capture.ts';
import { main, USAGE } from '../../src/cli/main.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import type { CommandResult } from '../../src/cli/screenshot.ts';

const BASE = 'http://localhost:4380';
const TOKEN = 'swc_cli_contract_token';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const newResponse: LookupResponse = {
  kind: 'new',
  captureId: 'cap-1',
  surface: { id: 'web', label: 'the website' },
  evidence: 'src/cart/total.ts',
  choices: [
    { id: 'file', label: 'File it' },
    { id: 'other-surface', label: 'Another surface' },
  ],
};
const whichSurface: LookupResponse = {
  kind: 'which-surface',
  captureId: 'cap-1',
  choices: [
    { id: 'web', label: 'Website' },
    { id: 'ios', label: 'iOS app' },
  ],
};
const filed: LookupResponse = { kind: 'filed', captureId: 'cap-1', issueKey: 'WEB-1042', url: 'http://jira.test/browse/WEB-1042' };
const tracked: LookupResponse = {
  kind: 'tracked',
  captureId: 'cap-1',
  issueKey: 'WEB-830',
  summary: 'Cart total blank',
  status: 'open',
  assignee: 'Dana',
  url: 'http://jira.test/browse/WEB-830',
};
const pending: LookupResponse = { kind: 'pending', captureId: 'cap-1' };
const ticket: TicketStatus = {
  issueKey: 'WEB-1042',
  summary: 'Checkout total is blank after promo',
  status: 'In Progress',
  assignee: 'Dana',
  url: 'http://jira.test/browse/WEB-1042',
  pullRequest: { url: 'http://github.test/acme/web/pull/7', state: 'open' },
};

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly auth: string | null;
  readonly body: unknown;
}

let seen: Seen[] = [];
/** What `POST /capture` answers, then each `POST /capture/:id/answer` and `GET /capture/:id` in turn. */
let first: LookupResponse = newResponse;
let next: LookupResponse[] = [];

async function record(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  const body = text === '' ? undefined : (JSON.parse(text) as unknown);
  seen.push({ method: request.method, path: new URL(request.url).pathname, auth: request.headers.get('authorization'), body });
  return body;
}

function authorized(request: Request): boolean {
  return request.headers.get('authorization') === `Bearer ${TOKEN}`;
}

function shift(): LookupResponse {
  const r = next.shift();
  if (r === undefined) throw new Error('the test scripted no further response');
  return r;
}

const server = setupServer(
  http.post(`${BASE}${CAPTURE_ROUTES.send}`, async ({ request }) => {
    const body = await record(request);
    if (!authorized(request)) return new HttpResponse(null, { status: 401 });
    if (!validateCaptureRequest(body).ok) return new HttpResponse(null, { status: 400 });
    return HttpResponse.json(first);
  }),
  http.post(`${BASE}${CAPTURE_ROUTES.answer('cap-1')}`, async ({ request }) => {
    const body = await record(request);
    if (!validateAnswerRequest(body).ok) return new HttpResponse(null, { status: 400 });
    return HttpResponse.json(shift());
  }),
  http.get(`${BASE}${CAPTURE_ROUTES.poll('cap-1')}`, async ({ request }) => {
    await record(request);
    return HttpResponse.json(shift());
  }),
  http.get(`${BASE}${CAPTURE_ROUTES.status('WEB-1042')}`, async ({ request }) => {
    await record(request);
    return HttpResponse.json({ ...ticket, extra: 'kept by --json' });
  }),
  http.post(`${BASE}${CAPTURE_ROUTES.stop('WEB-1042')}`, async ({ request }) => {
    await record(request);
    const result: StopResult = { issueKey: 'WEB-1042', stopped: true };
    return HttpResponse.json(result);
  }),
  http.get(`${BASE}${CAPTURE_ROUTES.queue}`, async ({ request }) => {
    await record(request);
    const queue: QueueView = {
      kind: 'reporter',
      title: 'Snapwing',
      sections: [{ id: 'reports', title: 'Your reports', empty: 'You have no open reports.', items: [] }],
    };
    return HttpResponse.json(queue);
  }),
  http.get(`${BASE}${CAPTURE_ROUTES.health}`, async ({ request }) => {
    await record(request);
    const health: HealthResult = { ok: true };
    return HttpResponse.json({
      ...health,
      platforms: [
        { id: 'slack', ok: true, mode: 'full' },
        { id: 'teams', ok: true, mode: 'reduced', detail: 'RSC not consented' },
      ],
    });
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let home: string;
let out: string[];
let err: string[];
let opened: string[];
let stdinText: string;
let runner: (command: string, args: readonly string[]) => CommandResult | undefined;
let processEnv: Record<string, string | undefined>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'snapwing-cli-capture-'));
  seen = [];
  first = newResponse;
  next = [];
  out = [];
  err = [];
  opened = [];
  stdinText = '';
  runner = () => undefined;
  processEnv = {};
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function env(answers: readonly string[] = [], over: Partial<CaptureEnv> = {}): CaptureEnv {
  return {
    home,
    cwd: home,
    platform: 'darwin',
    prompter: scriptedPrompter(answers),
    readStdin: () => Promise.resolve(stdinText),
    stdinIsTTY: false,
    run: (command, args) => Promise.resolve(runner(command, args)),
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    ...over,
  };
}

function run(argv: readonly string[], answers: readonly string[] = [], over: Partial<CaptureEnv> = {}): Promise<number> {
  const captureEnv = env(answers, over);
  return main(argv, { env: processEnv, stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, { capture: () => captureEnv });
}

async function login(): Promise<void> {
  expect(await run(['login', '--url', BASE, '--token', TOKEN])).toBe(0);
  out = [];
  err = [];
}

const stdout = (): string => out.join('\n');
const sends = (): Seen[] => seen.filter((s) => s.path === CAPTURE_ROUTES.send);
const answers = (): unknown[] => seen.filter((s) => s.path === CAPTURE_ROUTES.answer('cap-1')).map((s) => s.body);

afterEach(() => {
  // The token travels in the header only; no command ever prints it.
  expect([...out, ...err].join('\n')).not.toContain(TOKEN);
});

describe('the command table', () => {
  it('lists every command; bare snapwing prints the usage and exits 1; an unknown command is refused', async () => {
    for (const name of ['serve', 'config check', 'state rebuild', 'login', 'logout', 'shot', 'say', 'log', 'status', 'stop']) {
      expect(USAGE).toContain(`  ${name}`);
    }
    expect(await run([])).toBe(1);
    expect(stdout()).toBe(USAGE);
    expect(await run(['nope'])).toBe(1);
    expect(err.join('\n')).toContain('unknown command "nope"');
    expect(await run(['constructor'])).toBe(1);
  });
});

describe('login and logout', () => {
  it('stores the endpoint and token through capture-client, 0600, and forgets them', async () => {
    await login();
    expect(await loadClientConfig({ env: {}, home })).toEqual({ endpoint: BASE, token: TOKEN });
    expect((await stat(clientConfigPath(home))).mode & 0o777).toBe(0o600);

    expect(await run(['logout'])).toBe(0);
    expect(await loadClientConfig({ env: {}, home })).toBeUndefined();
    expect(await run(['logout'])).toBe(0);
    expect(stdout()).toContain('Not logged in.');
  });

  it('asks for the token without echo when --token is absent', async () => {
    const prompter = scriptedPrompter([` ${TOKEN} `]);
    expect(await run(['login', '--url', BASE], [], { prompter })).toBe(0);
    expect(prompter.asked).toEqual(['Capture token: ']);
    expect((await loadClientConfig({ env: {}, home }))?.token).toBe(TOKEN);
  });

  it('refuses a missing url, an empty token, and an endpoint that is not http', async () => {
    expect(await run(['login', '--token', TOKEN])).toBe(1);
    expect(await run(['login', '--url', BASE], [''])).toBe(1);
    expect(await run(['login', '--url', 'ftp://x', '--token', TOKEN])).toBe(1);
    expect(err.join('\n')).toContain('not an https URL');
  });

  it('refuses an http endpoint off loopback, and allows https and loopback http', async () => {
    expect(await run(['login', '--url', 'http://snapwing.example.com', '--token', TOKEN])).toBe(1);
    expect(err.join('\n')).toContain('not an https URL');
    expect(await run(['login', '--url', 'https://snapwing.example.com', '--token', TOKEN])).toBe(0);
    expect(await run(['login', '--url', 'http://127.0.0.1:3000', '--token', TOKEN])).toBe(0);
    expect(await run(['login', '--url', 'http://[::1]:3000', '--token', TOKEN])).toBe(0);
  });

  it('reads the token from stdin with --token -', async () => {
    stdinText = `${TOKEN}\n`;
    expect(await run(['login', '--url', BASE, '--token', '-'])).toBe(0);
    expect((await loadClientConfig({ env: {}, home }))?.token).toBe(TOKEN);
  });

  it('the capture commands say how to log in when there is no config, and read SNAPWING_URL and SNAPWING_TOKEN', async () => {
    expect(await run(['say', 'hello'])).toBe(1);
    expect(err.join('\n')).toContain('snapwing login --url');
    processEnv = { SNAPWING_URL: BASE, SNAPWING_TOKEN: TOKEN };
    first = filed;
    expect(await run(['say', 'hello'])).toBe(0);
  });
});

describe('say, log, shot', () => {
  it('say: prints the lookup-first response with numbered choices, sends the answer, prints the outcome', async () => {
    await login();
    next = [filed];
    expect(await run(['say', 'checkout total is blank', 'after promo'], ['1'])).toBe(0);
    expect(stdout()).toBe(
      [
        'New. Looks like the website (from src/cart/total.ts). File it?',
        '1. File it',
        '2. Another surface',
        'Filed as WEB-1042.',
        'http://jira.test/browse/WEB-1042',
      ].join('\n'),
    );
    const body = sends()[0]?.body as CaptureRequest;
    expect(body).toEqual({ source: 'cli', text: 'checkout total is blank after promo' });
    expect(sends()[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(answers()).toEqual([{ choiceId: 'file' }]);
  });

  it('which-surface, then pending while it works, then filed; --surface goes in the request', async () => {
    await login();
    first = whichSurface;
    next = [pending, pending, filed];
    expect(await run(['say', 'blank total', '--surface', 'web'], ['ios'])).toBe(0);
    expect((sends()[0]?.body as CaptureRequest).surface).toBe('web');
    expect(answers()).toEqual([{ choiceId: 'ios' }]);
    expect(seen.filter((s) => s.method === 'GET').length).toBe(2);
    expect(stdout()).toContain('New. Which surface?\n1. Website\n2. iOS app');
    expect(out.filter((l) => l === 'Working on it.')).toHaveLength(1);
    expect(stdout()).toContain('Filed as WEB-1042.');
  });

  it('gives up polling after the timeout with exit 2', async () => {
    await login();
    first = pending;
    next = [pending, pending, pending];
    expect(await run(['say', 'x'], [], { pollIntervalMs: 10, pollTimeoutMs: 20 })).toBe(2);
    expect(err.join('\n')).toContain('Still working on capture cap-1');
  });

  it('tracked: "Open it" opens the ticket locally and asks the server nothing more', async () => {
    await login();
    first = tracked;
    expect(await run(['say', 'cart blank'], ['1'])).toBe(0);
    expect(stdout()).toContain('Already tracked as WEB-830 (open, assigned to Dana). Open it?\n1. Open it\n2. Not now');
    expect(opened).toEqual([tracked.url]);
    expect(answers()).toEqual([]);

    opened = [];
    expect(await run(['say', 'cart blank'], ['2'])).toBe(0);
    expect(opened).toEqual([]);
  });

  it('strips control characters other than newline from server text before printing', async () => {
    await login();
    first = { kind: 'not-filed', captureId: 'cap-1', reason: 'src/a.ts\u001b[2J\u001b]0;pwned\u0007\rok' };
    expect(await run(['say', 'x'])).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(stdout()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(stdout()).toContain('src/a.ts[2J]0;pwnedok');
  });

  it('not filed is an outcome, exit 0', async () => {
    await login();
    next = [{ kind: 'not-filed', captureId: 'cap-1', reason: 'Not a bug.' }];
    expect(await run(['say', 'x'], ['2'])).toBe(0);
    expect(stdout()).toContain('Not filed. Not a bug.');
  });

  it('no answer at the prompt exits 2 and points at --choice', async () => {
    await login();
    expect(await run(['say', 'x'], [])).toBe(2);
    expect(err.join('\n')).toContain('--choice');
    expect(answers()).toEqual([]);
  });

  it('log: sends stdin as text', async () => {
    await login();
    first = filed;
    stdinText = 'TypeError: total is undefined\n    at cart.ts:12\n\n';
    expect(await run(['log'])).toBe(0);
    expect((sends()[0]?.body as CaptureRequest)).toEqual({ source: 'cli', text: 'TypeError: total is undefined\n    at cart.ts:12' });
    stdinText = '  \n';
    expect(await run(['log'])).toBe(1);
    expect(err.join('\n')).toContain('nothing on stdin');
  });

  it('shot <file>: sends the file as a base64 image', async () => {
    await login();
    first = filed;
    await writeFile(join(home, 'error.png'), PNG);
    expect(await run(['shot', 'error.png', '--surface', 'web'])).toBe(0);
    const body = sends()[0]?.body as CaptureRequest;
    expect(body).toEqual({ source: 'cli', surface: 'web', image: PNG.toString('base64'), mimeType: 'image/png' });
    expect(err.join('\n')).toContain(`Sending ${join(home, 'error.png')}.`);
  });

  it('shot: the clipboard image when no file is named', async () => {
    await login();
    first = filed;
    runner = (command) =>
      command === 'osascript' ? { code: 0, stdout: Buffer.from(`«data PNGf${PNG.toString('hex')}»`) } : undefined;
    expect(await run(['shot'])).toBe(0);
    expect((sends()[0]?.body as { image: string }).image).toBe(PNG.toString('base64'));
    expect(err.join('\n')).toContain('Sending the clipboard image.');
  });

  it('shot: a file that is not an image is refused before anything is sent', async () => {
    await login();
    await writeFile(join(home, 'notes.txt'), 'hello');
    expect(await run(['shot', 'notes.txt'])).toBe(1);
    expect(sends()).toEqual([]);
  });
});

describe('--json and --choice, for scripts', () => {
  it('--choice answers without a prompt, in order', async () => {
    await login();
    first = whichSurface;
    next = [newResponse, filed];
    const prompter = scriptedPrompter([]);
    expect(await run(['say', 'x', '--choice', 'web', '--choice', '1'], [], { prompter })).toBe(0);
    expect(prompter.asked).toEqual([]);
    expect(answers()).toEqual([{ choiceId: 'web' }, { choiceId: 'file' }]);
    expect(stdout()).toContain('> Website');
  });

  it('--choice that names no choice exits 1; running out of choices exits 2', async () => {
    await login();
    expect(await run(['say', 'x', '--choice', 'bogus'])).toBe(1);
    expect(err.join('\n')).toContain('file, other-surface');
    first = whichSurface;
    next = [newResponse];
    expect(await run(['say', 'x', '--choice', 'web'])).toBe(2);
  });

  it('--json prints each raw response as one JSON line and never prompts', async () => {
    await login();
    server.use(
      http.post(`${BASE}${CAPTURE_ROUTES.send}`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ...newResponse, serverOnly: 1 });
      }),
    );
    next = [filed];
    const prompter = scriptedPrompter(['1']);
    expect(await run(['say', 'x', '--json', '--choice', 'file'], [], { prompter })).toBe(0);
    expect(out.map((l) => JSON.parse(l) as unknown)).toEqual([{ ...newResponse, serverOnly: 1 }, filed]);
    expect(prompter.asked).toEqual([]);

    out = [];
    expect(await run(['say', 'x', '--json'], [], { prompter })).toBe(2);
    expect(out).toHaveLength(1);
    expect(prompter.asked).toEqual([]);
  });
});

describe('status and stop', () => {
  it('status <KEY> prints the status loopback; --json prints the raw body', async () => {
    await login();
    expect(await run(['status', 'WEB-1042'])).toBe(0);
    expect(stdout()).toBe(
      [
        'WEB-1042: Checkout total is blank after promo',
        'In Progress, assigned to Dana',
        'Pull request: http://github.test/acme/web/pull/7 (open)',
        'http://jira.test/browse/WEB-1042',
      ].join('\n'),
    );
    out = [];
    expect(await run(['status', 'WEB-1042', '--json'])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ ...ticket, extra: 'kept by --json' });
  });

  it('status with no key prints the health of each chat platform, Teams in reduced mode, then the queue', async () => {
    await login();
    expect(await run(['status'])).toBe(0);
    expect(stdout().split('\n\n')[0]).toBe(
      [
        `Snapwing at ${BASE}: healthy`,
        '  slack: ok',
        '  teams: ok, reduced mode (action command and personal chat only), RSC not consented',
      ].join('\n'),
    );
  });

  it('status with no key: a server that is not healthy exits 1', async () => {
    await login();
    server.use(http.get(`${BASE}${CAPTURE_ROUTES.health}`, () => HttpResponse.json({ ok: false })));
    expect(await run(['status'])).toBe(1);
    expect(stdout()).toBe(`Snapwing at ${BASE}: not healthy`);
    server.use(http.get(`${BASE}${CAPTURE_ROUTES.health}`, () => new HttpResponse('state store not open', { status: 503 })));
    out = [];
    expect(await run(['status'])).toBe(1);
    expect(stdout()).toBe(`Snapwing at ${BASE}: not healthy`);
    expect(err.join('\n')).toContain('503');
  });

  it('stop <KEY> stops it; the server refusing a reporter is reported as engineers only', async () => {
    await login();
    expect(await run(['stop', 'WEB-1042'])).toBe(0);
    expect(stdout()).toBe('Stopped WEB-1042.');
    expect(seen.at(-1)).toMatchObject({ method: 'POST', path: CAPTURE_ROUTES.stop('WEB-1042'), auth: `Bearer ${TOKEN}` });

    server.use(http.post(`${BASE}${CAPTURE_ROUTES.stop('WEB-1042')}`, () => new HttpResponse(null, { status: 403 })));
    expect(await run(['stop', 'WEB-1042'])).toBe(1);
    expect(err.join('\n')).toContain('stopping a ticket is for engineers');

    expect(await run(['stop'])).toBe(1);
  });

  it('a rejected token says to log in again', async () => {
    expect(await run(['login', '--url', BASE, '--token', 'swc_revoked'])).toBe(0);
    expect(await run(['say', 'x'])).toBe(1);
    expect(err.join('\n')).toContain('Run snapwing login again');
  });
});
