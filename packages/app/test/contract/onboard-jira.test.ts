// Onboarding step 2, Jira (main 22.2 and 22.3; #13), against MSW: the happy path, a refused login asked
// again (site and email too), Jira Cloud addresses only, the admin check, a saved login checked again on
// a resume or a rerun, a team-managed project, no public URL, a project missing a status category, a
// setup failure that is not about statuses, and what step 0 writes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { writeAppConfig } from '../../src/onboard/config-write.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type OnboardingStore } from '../../src/onboard/interview/state.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { checkSiteAddress } from '../../src/onboard/jira/site.ts';
import { jiraStep } from '../../src/onboard/steps/jira.ts';

const BASE = 'https://snapwing-test.atlassian.net';
const OTHER_BASE = 'https://other-test.atlassian.net';
const GOOD = 'ATATT-good-token-0123456789';
const BAD = 'ATATT-bad-token-9876543210';
const FRESH = 'ATATT-fresh-token-1122334455';
const EMAIL = 'owner@example.com';
const OTHER_EMAIL = 'second@example.com';
const OTHER = 'ATATT-other-token-1357924680';
const MEMBER_EMAIL = 'member@example.com';
const MEMBER = 'ATATT-member-token-2468013579';

interface FakeJira {
  /** The logins every fake site accepts, by email. */
  logins: Record<string, { token: string; admin: boolean }>;
  projects: { key: string; name: string; style?: string }[];
  /** `GET /project/:key` style, when it differs from the list (the list is a hint). */
  detailStyle: Record<string, string>;
  fields: { id: string; name: string; custom: boolean; schema?: { type: string; custom: string } }[];
  screenFields: Record<number, string[]>;
  statuses: { name: string; category: string }[];
  /** An error status `GET /project/:key/statuses` answers with, when set. */
  statusesStatus?: number;
  /** An error status `POST /field` answers with, when set. */
  createFieldStatus?: number;
  webhooks: { id: number; name: string; url: string }[];
  calls: string[];
  nextFieldId: number;
}
let jira: FakeJira;

/** Every request the step sent: its URL and the email of the login it carried. */
let requests: { url: string; login?: string }[];

/** The Basic login a request carries. */
function loginOf(request: Request): { email: string; token: string } | undefined {
  const m = /^Basic (.+)$/.exec(request.headers.get('authorization') ?? '');
  if (m?.[1] === undefined) return undefined;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const at = text.indexOf(':');
  return at === -1 ? undefined : { email: text.slice(0, at), token: text.slice(at + 1) };
}

/** The request's login, when the fake sites accept it. */
function accepted(request: Request): { email: string; admin: boolean } | undefined {
  const login = loginOf(request);
  const known = login === undefined ? undefined : jira.logins[login.email];
  return login !== undefined && known?.token === login.token ? { email: login.email, admin: known.admin } : undefined;
}

function handlersFor(base: string) {
  const log = (s: string): void => void jira.calls.push(s);
  return [
    http.get(`${base}/rest/api/3/myself`, ({ request }) =>
      accepted(request) ? HttpResponse.json({ accountId: 'a1', displayName: 'Owner' }) : new HttpResponse(null, { status: 401 }),
    ),
    http.get(`${base}/rest/api/3/mypermissions`, ({ request }) => {
      const login = accepted(request);
      if (login === undefined) return new HttpResponse(null, { status: 401 });
      return HttpResponse.json({ permissions: { ADMINISTER: { id: '0', key: 'ADMINISTER', type: 'GLOBAL', havePermission: login.admin } } });
    }),
    http.get(`${base}/rest/api/3/project/search`, () => HttpResponse.json({ isLast: true, values: jira.projects })),
    http.get(`${base}/rest/api/3/project/:key/statuses`, () =>
      jira.statusesStatus !== undefined
        ? new HttpResponse(null, { status: jira.statusesStatus })
        : HttpResponse.json([
            { id: '1', name: 'Task', statuses: jira.statuses.map((s, i) => ({ id: String(10100 + i), name: s.name, statusCategory: { id: i, key: s.category } })) },
          ]),
    ),
    http.get(`${base}/rest/api/3/project/:key`, ({ params }) => {
      const key = String(params['key']);
      const p = jira.projects.find((q) => q.key === key);
      if (!p) return new HttpResponse(null, { status: 404 });
      const style = jira.detailStyle[key] ?? p.style ?? 'classic';
      return HttpResponse.json({ id: '10100', key, name: p.name, style, simplified: style === 'next-gen' });
    }),
    http.get(`${base}/rest/api/3/field`, () => HttpResponse.json(jira.fields)),
    http.post(`${base}/rest/api/3/field`, async ({ request }) => {
      if (jira.createFieldStatus !== undefined) return new HttpResponse(null, { status: jira.createFieldStatus });
      const body = (await request.json()) as { name: string; type: string };
      log(`create-field ${body.name}`);
      const f = { id: `customfield_${jira.nextFieldId++}`, name: body.name, custom: true, schema: { type: 'x', custom: body.type } };
      jira.fields.push(f);
      return HttpResponse.json(f);
    }),
    http.get(`${base}/rest/api/3/screens`, () => HttpResponse.json({ isLast: true, values: [{ id: 1, name: 'OAJ: Scrum Default Issue Screen' }] })),
    http.get(`${base}/rest/api/3/screens/:id/tabs`, () => HttpResponse.json([{ id: 100, name: 'Field Tab' }])),
    http.get(`${base}/rest/api/3/screens/:id/tabs/:tab/fields`, ({ params }) =>
      HttpResponse.json((jira.screenFields[Number(params['id'])] ?? []).map((id) => ({ id }))),
    ),
    http.post(`${base}/rest/api/3/screens/:id/tabs/:tab/fields`, async ({ params, request }) => {
      const { fieldId } = (await request.json()) as { fieldId: string };
      log(`add-to-screen ${fieldId}`);
      jira.screenFields[Number(params['id'])]?.push(fieldId);
      return HttpResponse.json({ id: fieldId });
    }),
    http.get(`${base}/rest/webhooks/1.0/webhook`, () => HttpResponse.json(jira.webhooks)),
    http.post(`${base}/rest/webhooks/1.0/webhook`, async ({ request }) => {
      const body = (await request.json()) as { name: string; url: string };
      log('register-webhook');
      jira.webhooks.push({ id: jira.webhooks.length + 1, name: body.name, url: body.url });
      return HttpResponse.json({ ...body, enabled: true }, { status: 201 });
    }),
  ];
}

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

beforeEach(() => {
  jira = {
    logins: {
      [EMAIL]: { token: GOOD, admin: true },
      [OTHER_EMAIL]: { token: OTHER, admin: true },
      [MEMBER_EMAIL]: { token: MEMBER, admin: false },
    },
    projects: [
      { key: 'OAJ', name: 'Web app', style: 'classic' },
      { key: 'TEAM', name: 'Team board', style: 'next-gen' },
      { key: 'SIMP', name: 'Simple board', style: 'classic' },
    ],
    detailStyle: { SIMP: 'next-gen' },
    fields: [{ id: 'summary', name: 'Summary', custom: false }],
    screenFields: { 1: ['summary'] },
    statuses: [
      { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
      { name: 'Done', category: 'done' },
    ],
    webhooks: [],
    calls: [],
    nextFieldId: 10042,
  };
  requests = [];
  server.use(...handlersFor(BASE), ...handlersFor(OTHER_BASE));
  server.events.on('request:start', ({ request }) => {
    const login = loginOf(request)?.email;
    requests.push({ url: request.url, ...(login === undefined ? {} : { login }) });
  });
});
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-jira-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runtime: OnboardStep = { id: 'runtime', number: 0, title: 'Runtime', needs: [], run: () => Promise.resolve({ status: 'done' }) };

interface MemoryStore {
  readonly store: OnboardingStore;
  readonly raw: Map<string, string>;
}

function memoryStore(): MemoryStore {
  const raw = new Map<string, string>();
  const store = createKvOnboardingStore({
    kvGet: (k) => Promise.resolve(raw.get(k)),
    kvSet: (k, v) => {
      raw.set(k, v);
      return Promise.resolve();
    },
  });
  return { store, raw };
}

interface InterviewOptions {
  readonly env?: Record<string, string>;
  /** Kept across runs, for a resume or a rerun. */
  readonly memory?: MemoryStore;
  readonly only?: string;
  readonly steps?: readonly OnboardStep[];
}

async function interview(
  answers: readonly string[],
  options: InterviewOptions = {},
): Promise<{ result: InterviewResult; lines: string[]; envText: string; stateText: string; asked: readonly string[] }> {
  const memory = options.memory ?? memoryStore();
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const result = await runInterview({
    steps: options.steps ?? [runtime, jiraStep],
    store: memory.store,
    io,
    workdir: dir,
    env: options.env ?? {},
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  let envText = '';
  try {
    envText = await readFile(join(dir, '.env'), 'utf8');
  } catch {
    // never written
  }
  return { result, lines, envText, stateText: [...memory.raw.values()].join('\n'), asked: prompter.asked };
}

/** Main 22.3: never a field id, a webhook URL, a transition name, or a secret in what the installer reads. */
function expectPlain(lines: readonly string[], ...secrets: string[]): void {
  const text = lines.join('\n');
  expect(text).not.toMatch(/customfield_/);
  expect(text).not.toMatch(/\/webhooks?\//i);
  expect(text).not.toMatch(/rest\/api|transition/i);
  expect(text).not.toMatch(/webhook url/i);
  for (const s of secrets) expect(text).not.toContain(s);
}

const siteQuestions = (asked: readonly string[]): string[] => asked.filter((q) => q.startsWith('Which Jira site?'));
const emailQuestions = (asked: readonly string[]): string[] => asked.filter((q) => q.startsWith('Which email'));
const tokenQuestions = (asked: readonly string[]): string[] => asked.filter((q) => q.includes('API token'));

describe('onboarding step 2: Jira', () => {
  it('asks for the site, email, and token, then sets Jira up and registers the webhook', async () => {
    const { result, lines, envText, stateText, asked } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { env: { SNAPWING_PUBLIC_URL: 'https://snap.example.com' } });
    expect(result.outcome).toBe('complete');
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(result.state.steps['jira']?.data).toMatchObject({ site: BASE, email: EMAIL, projects: ['OAJ'], webhook: 'registered' });
    expect(tokenQuestions(asked)).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/works with Jira Cloud only/);

    expect(envText).toContain(`JIRA_BASE_URL=${BASE}`);
    expect(envText).toContain(`JIRA_EMAIL=${EMAIL}`);
    expect(envText).toContain(`JIRA_API_TOKEN=${GOOD}`);
    expect(envText).toContain('JIRA_PROJECT_KEY=OAJ');
    for (const k of ['JIRA_FIELD_IMPL_PROMPT', 'JIRA_FIELD_CONVERSATION', 'JIRA_FIELD_AUTONOMY', 'JIRA_FIELD_AGENT_STATUS']) expect(envText).toMatch(new RegExp(`^${k}=customfield_`, 'm'));
    const secret = /^JIRA_WEBHOOK_SECRET=(\S+)$/m.exec(envText)?.[1];
    expect(secret).toBeDefined();
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);

    expect(jira.calls.filter((c) => c.startsWith('create-field'))).toHaveLength(4);
    expect(jira.screenFields[1]).toHaveLength(5);
    expect(jira.webhooks).toHaveLength(1);
    expect(jira.webhooks[0]?.url).toBe(`https://snap.example.com/webhooks/jira?secret=${secret ?? ''}`);

    expect(stateText).not.toContain(GOOD);
    expect(stateText).not.toContain(secret ?? 'x');
    expectPlain(lines, GOOD, secret ?? 'x');
  });

  it('asks for the site, email, and token again after a refused login, and the bad token is never stored or printed', async () => {
    // Enter keeps the site and the email given the first time.
    const { result, lines, envText, stateText, asked } = await interview(['snapwing-test.atlassian.net', EMAIL, BAD, '', '', GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/did not accept that email and token/);
    expect(siteQuestions(asked)).toHaveLength(2);
    expect(siteQuestions(asked)[1]).toContain('Press Enter for snapwing-test.atlassian.net');
    expect(emailQuestions(asked)[1]).toContain(`Press Enter for ${EMAIL}`);
    expect(envText).toContain(`JIRA_BASE_URL=${BASE}`);
    expect(envText).toContain(`JIRA_API_TOKEN=${GOOD}`);
    expect(envText + stateText + lines.join('\n')).not.toContain(BAD);
    expectPlain(lines, GOOD, BAD);
  });

  it('lets a mistyped email be fixed after the login is refused', async () => {
    const { result, envText, asked } = await interview(['snapwing-test', 'owner@exmaple.com', GOOD, '', EMAIL, GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(result.state.steps['jira']?.data).toMatchObject({ email: EMAIL });
    expect(emailQuestions(asked)).toHaveLength(2);
    expect(envText).toContain(`JIRA_EMAIL=${EMAIL}`);
    expect(envText).not.toContain('exmaple');
  });

  it('refuses a Jira Server or Data Center address, saying only Jira Cloud is supported', async () => {
    const { result, lines } = await interview(['https://jira.acme.example/jira', 'snapwing-test', EMAIL, GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines).toContain(
      'An address with a path such as /jira is Jira Server or Data Center. Snapwing works with Jira Cloud only, at an address like acme.atlassian.net; Jira Server and Data Center are not supported.',
    );
    expect(requests.some((r) => r.url.includes('acme.example'))).toBe(false);
  });

  it('refuses a lookalike domain and localhost before any authenticated request', async () => {
    const { result, lines } = await interview(['acme.atlasian.net', 'http://localhost', 'snapwing-test', EMAIL, GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.filter((l) => l.startsWith('That is not a Jira Cloud address.'))).toHaveLength(2);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(new URL(r.url).origin).toBe(BASE);
  });

  it('takes only https://<name>.atlassian.net, from a name, a host, or a link on that site', () => {
    const acme = { ok: true, baseUrl: 'https://acme.atlassian.net' };
    expect(checkSiteAddress('acme')).toEqual(acme);
    expect(checkSiteAddress(' ACME.atlassian.net/ ')).toEqual(acme);
    expect(checkSiteAddress('https://acme.atlassian.net/jira/software/projects/OAJ/boards/1')).toEqual(acme);
    for (const refused of [
      '',
      'acme.atlasian.net',
      'localhost',
      'http://localhost',
      'http://127.0.0.1:8080',
      'http://acme.atlassian.net',
      'https://acme.atlassian.net.evil.example',
      'https://acme.atlassian.net@evil.example',
      'https://acme.atlassian.net:8443',
      'https://jira.acme.example',
      'https://jira.acme.example/jira',
    ]) {
      expect(checkSiteAddress(refused).ok, refused).toBe(false);
    }
  });

  it('refuses an account that is not a Jira admin before saving or setting anything up', async () => {
    const { result, lines, envText, stateText } = await interview(['snapwing-test', MEMBER_EMAIL, MEMBER, '', EMAIL, GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    const text = lines.join('\n');
    expect(text).toMatch(/That account signed in, but it is not a Jira admin\. Snapwing needs a Jira admin account/);
    // The member login was only checked: no project list, no setup, nothing saved.
    const asMember = requests.filter((r) => r.login === MEMBER_EMAIL).map((r) => new URL(r.url).pathname);
    expect(asMember).toEqual(['/rest/api/3/myself', '/rest/api/3/mypermissions']);
    expect(envText).not.toContain(MEMBER);
    expect(envText).not.toContain(MEMBER_EMAIL);
    expect(stateText).not.toContain(MEMBER_EMAIL);
    expect(envText).toContain(`JIRA_EMAIL=${EMAIL}`);
    expectPlain(lines, MEMBER, GOOD);
  });

  it('checks the saved login again on a resume, and asks again when Jira no longer accepts it', async () => {
    const memory = memoryStore();
    jira.statusesStatus = 503;
    const first = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { memory });
    expect(first.result.state.steps['jira']?.status).toBe('failed');

    delete jira.statusesStatus;
    jira.logins[EMAIL] = { token: FRESH, admin: true }; // GOOD is revoked
    const { result, lines, envText, asked } = await interview(['', '', FRESH, 'OAJ'], { memory });
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines).toContain(`Jira no longer accepts the saved login for snapwing-test.atlassian.net (${EMAIL}), so I need it again.`);
    expect(siteQuestions(asked)[0]).toContain('Press Enter for snapwing-test.atlassian.net');
    expect(envText).toContain(`JIRA_API_TOKEN=${FRESH}`);
    expect(envText).not.toContain(GOOD);
    expectPlain(lines, GOOD, FRESH);
  });

  it('asks for the login again when the saved account is no longer a Jira admin', async () => {
    const memory = memoryStore();
    await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { memory });
    jira.logins[EMAIL] = { token: GOOD, admin: false };
    const { result, lines, envText } = await interview(['', OTHER_EMAIL, OTHER, 'OAJ'], { memory, only: 'jira' });
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(new RegExp(`${EMAIL} is not a Jira admin on snapwing-test.atlassian.net`));
    expect(envText).toContain(`JIRA_EMAIL=${OTHER_EMAIL}`);
  });

  it('on a rerun keeps the saved login on Enter, or switches to another site and account', async () => {
    const memory = memoryStore();
    await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { memory });

    const kept = await interview(['', 'OAJ'], { memory, only: 'jira' });
    expect(kept.result.state.steps['jira']?.status).toBe('done');
    expect(kept.lines).toContain(`Jira: keep using snapwing-test.atlassian.net as ${EMAIL}?`);
    expect(tokenQuestions(kept.asked)).toHaveLength(0);

    const switched = await interview(['2', 'other-test', OTHER_EMAIL, OTHER, 'OAJ'], { memory, only: 'jira' });
    expect(switched.result.state.steps['jira']?.status).toBe('done');
    expect(switched.result.state.steps['jira']?.data).toMatchObject({ site: OTHER_BASE, email: OTHER_EMAIL, credentials: 'ok' });
    expect(switched.envText).toContain(`JIRA_BASE_URL=${OTHER_BASE}`);
    expect(switched.envText).toContain(`JIRA_EMAIL=${OTHER_EMAIL}`);
    expect(switched.envText).toContain(`JIRA_API_TOKEN=${OTHER}`);
    expect(switched.envText).not.toContain(GOOD);
    expect(requests.some((r) => r.url.startsWith(`${OTHER_BASE}/rest/api/3/field`))).toBe(true);
    expectPlain(switched.lines, GOOD, OTHER);
  });

  it('clears the saved login when the setup gets a 403, so the next run asks for one again', async () => {
    const memory = memoryStore();
    jira.createFieldStatus = 403;
    const first = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { memory });
    expect(first.result.outcome).toBe('failed');
    expect(first.result.state.steps['jira']?.status).toBe('failed');
    expect(first.result.state.steps['jira']?.data?.['credentials']).toBeNull();
    expect(first.lines.join('\n')).toMatch(/Jira refused part of the setup for OAJ with this login\. Snapwing needs a Jira admin account/);

    delete jira.createFieldStatus;
    const { result, lines, asked } = await interview(['', '', GOOD, 'OAJ'], { memory });
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.some((l) => l.startsWith('Jira: keep using'))).toBe(false);
    expect(tokenQuestions(asked)).toHaveLength(1);
  });

  it('stops, instead of finishing as done, when the statuses cannot be read', async () => {
    jira.statusesStatus = 503;
    const { result, lines } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ']);
    expect(result.outcome).toBe('failed');
    expect(result.state.steps['jira']?.status).toBe('failed');
    expect(result.failure?.message).toMatch(/could not set up Jira for OAJ/);
    expect(lines.join('\n')).not.toMatch(/has no status in/);
    expect(lines).not.toContain('OAJ is ready.');
  });

  it('explains a team-managed project in one sentence and asks for another', async () => {
    // TEAM is flagged by the list; SIMP only by its own record, so both paths are covered.
    const { result, lines, asked } = await interview(['snapwing-test', EMAIL, GOOD, 'TEAM', 'SIMP', 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(result.state.steps['jira']?.data).toMatchObject({ projects: ['OAJ'] });
    expect(lines.filter((l) => /team-managed/.test(l))).toHaveLength(2);
    expect(asked.filter((q) => q.includes('Which projects')).length).toBe(3);
    expect(jira.calls.filter((c) => c.startsWith('create-field')).length).toBe(4);
    expectPlain(lines, GOOD);
  });

  it('blocks, naming who must act, when every project is team-managed', async () => {
    jira.projects = [{ key: 'TEAM', name: 'Team board', style: 'next-gen' }];
    const { result } = await interview(['snapwing-test', EMAIL, GOOD]);
    expect(result.state.steps['jira']?.status).toBe('blocked');
    expect(result.state.steps['jira']?.blocked?.on).toBe('a Jira site admin');
  });

  it('finishes without the webhook when there is no public URL, and says so', async () => {
    const { result, lines, envText } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(result.state.steps['jira']?.data).toMatchObject({ webhook: 'waiting' });
    expect(jira.webhooks).toHaveLength(0);
    expect(jira.calls).not.toContain('register-webhook');
    expect(envText).not.toContain('JIRA_WEBHOOK_SECRET');
    expect(lines.join('\n')).toMatch(/no public https address yet/);
    expectPlain(lines, GOOD);
  });

  it('says which status category a project lacks and continues', async () => {
    jira.statuses = [
      { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
    ];
    const { result, lines, envText } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { env: { SNAPWING_PUBLIC_URL: 'https://snap.example.com' } });
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/OAJ has no status in the Done category/);
    expect(result.state.steps['jira']?.data).toMatchObject({ statusNotes: ['OAJ: no status in the Done category'], webhook: 'registered' });
    expect(envText).toMatch(/^JIRA_FIELD_AUTONOMY=customfield_/m);
    expectPlain(lines, GOOD);
  });

  it.each([
    { publicUrl: 'https://snap.example.com/base', webhook: 'registered' },
    { publicUrl: 'http://localhost:3000', webhook: 'waiting' },
  ])('reads the config file and SNAPWING_PUBLIC_URL as step 0 writes them ($publicUrl)', async ({ publicUrl, webhook }) => {
    // Step 0 writes snapwing.config.xml and SNAPWING_PUBLIC_URL (http://localhost:<port> without a public address).
    const stepZero: OnboardStep = {
      ...runtime,
      run: async (ctx) => {
        await writeAppConfig(ctx.workdir, { provider: 'local' }, 'anthropic');
        await ctx.writeEnv({ SNAPWING_PUBLIC_URL: publicUrl });
        return { status: 'done' };
      },
    };
    const { result, envText } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { steps: [stepZero, jiraStep] });
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(result.state.steps['jira']?.data).toMatchObject({ webhook });
    if (webhook === 'registered') {
      const secret = /^JIRA_WEBHOOK_SECRET=(\S+)$/m.exec(envText)?.[1] ?? '';
      expect(jira.webhooks.map((w) => w.url)).toEqual([`${publicUrl}/webhooks/jira?secret=${secret}`]);
    } else {
      expect(jira.webhooks).toHaveLength(0);
    }
  });
});
