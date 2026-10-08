// `snapwing status` with no key prints the health line, then the caller's queue from `GET /queue`.
// The MSW server answers with capture-client's `QueueView` at `CAPTURE_ROUTES.queue`, so the CLI and
// the server contract cannot drift. The endpoint is plain http on localhost on purpose.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_ROUTES, validateQueueView, type QueueView } from '@snapwing/capture-client/wire.ts';
import type { CaptureEnv } from '../../src/cli/capture.ts';
import { main } from '../../src/cli/main.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';

const BASE = 'http://localhost:4381';
const TOKEN = 'swc_cli_queue_token';

const engineerQueue: QueueView = {
  kind: 'engineer',
  title: 'Your queue',
  sections: [
    {
      id: 'assigned',
      title: 'Assigned to me',
      empty: 'Nothing is assigned to you.',
      items: [{ incidentId: 'inc-1', label: 'WEB-1042', summary: 'Checkout total is blank', priority: 'High', detail: 'open', buttons: [] }],
    },
    {
      id: 'fixing',
      title: 'Fixing now',
      empty: 'No fixer is running on your surfaces.',
      items: [{ incidentId: 'inc-2', label: 'WEB-1050', summary: 'Cart badge stuck', detail: 'fixing', buttons: [{ kind: 'stop' }] }],
    },
    {
      id: 'waiting',
      title: 'Waiting on you',
      empty: 'No pull request is waiting on your review.',
      items: [
        {
          incidentId: 'inc-3',
          label: 'WEB-1060',
          summary: 'Promo code rejected',
          detail: 'PR #31',
          buttons: [{ kind: 'open_pr', url: 'http://github.test/acme/web/pull/31' }, { kind: 'merge' }],
        },
      ],
    },
    {
      id: 'recent',
      title: 'Recently merged or reverted',
      empty: 'Nothing merged or reverted on your surfaces in the last 7 days.',
      items: [{ incidentId: 'inc-4', label: 'WEB-1001', summary: 'Footer link broken', detail: 'merged 2026-10-02, PR #41', buttons: [] }],
    },
  ],
};

const emptyQueue: QueueView = {
  ...engineerQueue,
  sections: engineerQueue.sections.map((s) => ({ ...s, items: [] })),
};

const reporterQueue: QueueView = {
  kind: 'reporter',
  title: 'Snapwing',
  sections: [
    {
      id: 'reports',
      title: 'Your reports',
      empty: "You have no open reports. When you file one it shows up here until it's fixed.",
      items: [{ incidentId: 'inc-5', label: 'WEB-1070', summary: 'Login button missing', detail: 'open', buttons: [] }],
    },
  ],
};

let served: unknown = engineerQueue;
let queueAuth: (string | null)[] = [];

const server = setupServer(
  http.get(`${BASE}${CAPTURE_ROUTES.queue}`, ({ request }) => {
    queueAuth.push(request.headers.get('authorization'));
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) return new HttpResponse(null, { status: 401 });
    return HttpResponse.json(served as Record<string, string>);
  }),
  http.get(`${BASE}${CAPTURE_ROUTES.health}`, () => HttpResponse.json({ ok: true })),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let home: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'snapwing-cli-queue-'));
  served = engineerQueue;
  queueAuth = [];
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(argv: readonly string[]): Promise<number> {
  const env: CaptureEnv = {
    home,
    cwd: home,
    platform: 'darwin',
    prompter: scriptedPrompter([]),
    readStdin: () => Promise.resolve(''),
    stdinIsTTY: false,
    run: () => Promise.resolve(undefined),
    openUrl: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  };
  return main(argv, { env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, { capture: () => env });
}

async function login(): Promise<void> {
  expect(await run(['login', '--url', BASE, '--token', TOKEN])).toBe(0);
  out = [];
  err = [];
}

const stdout = (): string => out.join('\n');

describe('snapwing status shows the queue', () => {
  it('the wire fixtures are valid QueueViews', () => {
    for (const q of [engineerQueue, emptyQueue, reporterQueue]) expect(validateQueueView(q)).toEqual({ ok: true, value: q });
  });

  it('prints the health line, then each of the engineer sections', async () => {
    await login();
    expect(await run(['status'])).toBe(0);
    expect(stdout()).toBe(
      [
        `Snapwing at ${BASE}: healthy`,
        '',
        'Your queue',
        '',
        'Assigned to me (1)',
        '  WEB-1042 Checkout total is blank (High) · open',
        '',
        'Fixing now (1)',
        '  WEB-1050 Cart badge stuck · fixing',
        '',
        'Waiting on you (1)',
        '  WEB-1060 Promo code rejected · PR #31',
        '    http://github.test/acme/web/pull/31',
        '',
        'Recently merged or reverted (1)',
        '  WEB-1001 Footer link broken · merged 2026-10-02, PR #41',
      ].join('\n'),
    );
    expect(queueAuth).toEqual([`Bearer ${TOKEN}`]);
  });

  it('an empty queue says so in each section', async () => {
    served = emptyQueue;
    await login();
    expect(await run(['status'])).toBe(0);
    expect(stdout()).toContain('Assigned to me\n  Nothing is assigned to you.');
    expect(stdout()).toContain('Fixing now\n  No fixer is running on your surfaces.');
    expect(stdout()).toContain('Waiting on you\n  No pull request is waiting on your review.');
    expect(stdout()).toContain('Recently merged or reverted\n  Nothing merged or reverted on your surfaces in the last 7 days.');
  });

  it('a reporter sees Your reports only', async () => {
    served = reporterQueue;
    await login();
    expect(await run(['status'])).toBe(0);
    expect(stdout()).toContain('Your reports (1)\n  WEB-1070 Login button missing · open');
    for (const title of ['Assigned to me', 'Fixing now', 'Waiting on you', 'Recently merged']) expect(stdout()).not.toContain(title);
  });

  it('counts the items past the section limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ incidentId: `i${i}`, label: `WEB-${i}`, summary: 's', detail: 'open', buttons: [] }));
    served = { ...reporterQueue, sections: [{ ...reporterQueue.sections[0], items }] };
    await login();
    expect(await run(['status'])).toBe(0);
    expect(stdout()).toContain('Your reports (10)');
    expect(stdout()).toContain('  and 2 more');
    expect(stdout()).not.toContain('WEB-8');
  });

  it('--json prints the raw QueueView', async () => {
    served = { ...engineerQueue, extra: 'kept by --json' };
    await login();
    expect(await run(['status', '--json'])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ ...engineerQueue, extra: 'kept by --json' });
  });

  it('a token the server refuses is reported', async () => {
    await login();
    server.use(http.get(`${BASE}${CAPTURE_ROUTES.queue}`, () => new HttpResponse(null, { status: 401 })));
    expect(await run(['status'])).toBe(1);
    expect(err.join('\n')).not.toBe('');
  });

  it('a body that is not a QueueView is reported', async () => {
    served = { kind: 'engineer', title: 'Your queue', sections: [{ id: 'nope', title: 'x', empty: '', items: [] }] };
    await login();
    expect(await run(['status'])).toBe(1);
    expect(err.join('\n')).toContain('Unexpected response');
  });
});
