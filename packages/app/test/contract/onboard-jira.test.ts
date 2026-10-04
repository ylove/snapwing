// Onboarding step 2, Jira (main 22.2 and 22.3; #398), against MSW: the happy path, a bad token asked
// again, a team-managed project, no public URL, and a project missing a status category.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore } from '../../src/onboard/interview/state.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { jiraStep } from '../../src/onboard/steps/jira.ts';

const BASE = 'https://snapwing-test.atlassian.net';
const GOOD = 'ATATT-good-token-0123456789';
const BAD = 'ATATT-bad-token-9876543210';
const EMAIL = 'owner@example.com';

interface FakeJira {
  projects: { key: string; name: string; style?: string }[];
  /** `GET /project/:key` style, when it differs from the list (the list is a hint). */
  detailStyle: Record<string, string>;
  fields: { id: string; name: string; custom: boolean; schema?: { type: string; custom: string } }[];
  screenFields: Record<number, string[]>;
  statuses: { name: string; category: string }[];
  webhooks: { id: number; name: string; url: string }[];
  calls: string[];
  nextFieldId: number;
}
let jira: FakeJira;

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

beforeEach(() => {
  jira = {
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
  const log = (s: string): void => void jira.calls.push(s);
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, ({ request }) => {
      const expected = `Basic ${Buffer.from(`${EMAIL}:${GOOD}`).toString('base64')}`;
      return request.headers.get('authorization') === expected
        ? HttpResponse.json({ accountId: 'a1', displayName: 'Owner' })
        : new HttpResponse(null, { status: 401 });
    }),
    http.get(`${BASE}/rest/api/3/project/search`, () => HttpResponse.json({ isLast: true, values: jira.projects })),
    http.get(`${BASE}/rest/api/3/project/:key/statuses`, () =>
      HttpResponse.json([
        { id: '1', name: 'Task', statuses: jira.statuses.map((s, i) => ({ id: String(10100 + i), name: s.name, statusCategory: { id: i, key: s.category } })) },
      ]),
    ),
    http.get(`${BASE}/rest/api/3/project/:key`, ({ params }) => {
      const key = String(params['key']);
      const p = jira.projects.find((q) => q.key === key);
      if (!p) return new HttpResponse(null, { status: 404 });
      const style = jira.detailStyle[key] ?? p.style ?? 'classic';
      return HttpResponse.json({ id: '10100', key, name: p.name, style, simplified: style === 'next-gen' });
    }),
    http.get(`${BASE}/rest/api/3/field`, () => HttpResponse.json(jira.fields)),
    http.post(`${BASE}/rest/api/3/field`, async ({ request }) => {
      const body = (await request.json()) as { name: string; type: string };
      log(`create-field ${body.name}`);
      const f = { id: `customfield_${jira.nextFieldId++}`, name: body.name, custom: true, schema: { type: 'x', custom: body.type } };
      jira.fields.push(f);
      return HttpResponse.json(f);
    }),
    http.get(`${BASE}/rest/api/3/screens`, () =>
      HttpResponse.json({ isLast: true, values: [{ id: 1, name: 'OAJ: Scrum Default Issue Screen' }] }),
    ),
    http.get(`${BASE}/rest/api/3/screens/:id/tabs`, () => HttpResponse.json([{ id: 100, name: 'Field Tab' }])),
    http.get(`${BASE}/rest/api/3/screens/:id/tabs/:tab/fields`, ({ params }) =>
      HttpResponse.json((jira.screenFields[Number(params['id'])] ?? []).map((id) => ({ id }))),
    ),
    http.post(`${BASE}/rest/api/3/screens/:id/tabs/:tab/fields`, async ({ params, request }) => {
      const { fieldId } = (await request.json()) as { fieldId: string };
      log(`add-to-screen ${fieldId}`);
      jira.screenFields[Number(params['id'])]?.push(fieldId);
      return HttpResponse.json({ id: fieldId });
    }),
    http.get(`${BASE}/rest/webhooks/1.0/webhook`, () => HttpResponse.json(jira.webhooks)),
    http.post(`${BASE}/rest/webhooks/1.0/webhook`, async ({ request }) => {
      const body = (await request.json()) as { name: string; url: string };
      log('register-webhook');
      jira.webhooks.push({ id: jira.webhooks.length + 1, name: body.name, url: body.url });
      return HttpResponse.json({ ...body, enabled: true }, { status: 201 });
    }),
  );
});
afterEach(() => server.resetHandlers());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-jira-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runtime: OnboardStep = { id: 'runtime', number: 0, title: 'Runtime', needs: [], run: () => Promise.resolve({ status: 'done' }) };

async function interview(
  answers: readonly string[],
  env: Record<string, string> = {},
): Promise<{ result: InterviewResult; lines: string[]; envText: string; stateText: string; asked: readonly string[] }> {
  const raw = new Map<string, string>();
  const store = createKvOnboardingStore({
    kvGet: (k) => Promise.resolve(raw.get(k)),
    kvSet: (k, v) => {
      raw.set(k, v);
      return Promise.resolve();
    },
  });
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const result = await runInterview({ steps: [runtime, jiraStep], store, io, workdir: dir, env });
  let envText = '';
  try {
    envText = await readFile(join(dir, '.env'), 'utf8');
  } catch {
    // never written
  }
  return { result, lines, envText, stateText: [...raw.values()].join('\n'), asked: prompter.asked };
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

describe('onboarding step 2: Jira', () => {
  it('asks for the site, email, and token, then sets Jira up and registers the webhook', async () => {
    const { result, lines, envText, stateText, asked } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { SNAPWING_PUBLIC_URL: 'https://snap.example.com' });
    expect(result.outcome).toBe('complete');
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(result.state.steps['jira']?.data).toMatchObject({ site: BASE, email: EMAIL, projects: ['OAJ'], webhook: 'registered' });
    expect(asked.some((q) => q.includes('API token'))).toBe(true);

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

  it('asks again after a bad token, and the bad one is never stored or printed', async () => {
    const { result, lines, envText, stateText } = await interview(['snapwing-test.atlassian.net', EMAIL, BAD, GOOD, 'OAJ']);
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/did not accept that email and token/);
    expect(envText).toContain(`JIRA_API_TOKEN=${GOOD}`);
    expect(envText + stateText + lines.join('\n')).not.toContain(BAD);
    expectPlain(lines, GOOD, BAD);
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
    const { result, lines, envText } = await interview(['snapwing-test', EMAIL, GOOD, 'OAJ'], { SNAPWING_PUBLIC_URL: 'https://snap.example.com' });
    expect(result.state.steps['jira']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/OAJ has no status in the Done category/);
    expect(result.state.steps['jira']?.data).toMatchObject({ statusNotes: ['OAJ: no status in the Done category'], webhook: 'registered' });
    expect(envText).toMatch(/^JIRA_FIELD_AUTONOMY=customfield_/m);
    expectPlain(lines, GOOD);
  });
});
