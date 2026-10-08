import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIELD_SPECS, parseEnvFile, runBootstrap, updateEnvText } from '../../../../scripts/jira-bootstrap.ts';

const BASE = 'https://snapwing-test.atlassian.net';
const TOKEN = 'ATATT-secret-token-123';
const ENV = {
  JIRA_BASE_URL: BASE,
  JIRA_EMAIL: 'owner@example.com',
  JIRA_API_TOKEN: TOKEN,
  JIRA_PROJECT_KEY: 'OAJ',
};
const CF = 'com.atlassian.jira.plugin.system.customfieldtypes';

interface FakeJira {
  fields: { id: string; name: string; custom: boolean; schema?: { type: string; custom: string } }[];
  screenFields: Record<number, string[]>;
  statuses: { name: string; category: string }[];
  /** `GET /project/OAJ`: `next-gen` is team-managed. */
  style: 'classic' | 'next-gen';
  webhooks: { id: number; name: string; url: string; events: string[]; filters: Record<string, string>; enabled: boolean }[];
  calls: string[];
  nextFieldId: number;
}
let jira: FakeJira;

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

function fresh(): FakeJira {
  return {
    fields: [{ id: 'summary', name: 'Summary', custom: false }],
    screenFields: { 1: ['summary'], 2: ['summary'] },
    // Jira Cloud's default Scrum workflow, as the owner's site answers.
    statuses: [
      { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
      { name: 'In Review', category: 'indeterminate' },
      { name: 'Done', category: 'done' },
    ],
    style: 'classic',
    webhooks: [],
    calls: [],
    nextFieldId: 10042,
  };
}

beforeEach(() => {
  jira = fresh();
  const log = (s: string): void => void jira.calls.push(s);
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: 'a1', displayName: 'Owner' })),
    http.get(`${BASE}/rest/api/3/field`, () => HttpResponse.json(jira.fields)),
    http.post(`${BASE}/rest/api/3/field`, async ({ request }) => {
      const body = (await request.json()) as { name: string; type: string };
      log(`create-field ${body.name}`);
      const f = { id: `customfield_${jira.nextFieldId++}`, name: body.name, custom: true, schema: { type: 'x', custom: body.type } };
      jira.fields.push(f);
      return HttpResponse.json(f);
    }),
    http.get(`${BASE}/rest/api/3/screens`, () =>
      HttpResponse.json({
        isLast: true,
        values: [
          { id: 1, name: 'OAJ: Scrum Default Issue Screen' },
          { id: 2, name: 'Default Issue Screen' },
          { id: 3, name: 'OTHER: Scrum Default Issue Screen' },
        ],
      }),
    ),
    http.get(`${BASE}/rest/api/3/screens/:id/tabs`, () => HttpResponse.json([{ id: 100, name: 'Field Tab' }])),
    http.get(`${BASE}/rest/api/3/screens/:id/tabs/:tab/fields`, ({ params }) =>
      HttpResponse.json((jira.screenFields[Number(params['id'])] ?? []).map((id) => ({ id }))),
    ),
    http.post(`${BASE}/rest/api/3/screens/:id/tabs/:tab/fields`, async ({ params, request }) => {
      const { fieldId } = (await request.json()) as { fieldId: string };
      log(`add-to-screen ${String(params['id'])} ${fieldId}`);
      jira.screenFields[Number(params['id'])]?.push(fieldId);
      return HttpResponse.json({ id: fieldId });
    }),
    http.get(`${BASE}/rest/api/3/project/OAJ`, () =>
      HttpResponse.json({ id: '10100', key: 'OAJ', name: 'Snapwing Test', style: jira.style, simplified: jira.style === 'next-gen' }),
    ),
    http.get(`${BASE}/rest/api/3/project/OAJ/statuses`, () =>
      HttpResponse.json([
        {
          id: '1',
          name: 'Task',
          statuses: jira.statuses.map((s, i) => ({ id: String(10100 + i), name: s.name, statusCategory: { id: i, key: s.category } })),
        },
      ]),
    ),
    http.get(`${BASE}/rest/webhooks/1.0/webhook`, () => HttpResponse.json(jira.webhooks)),
    http.delete(`${BASE}/rest/webhooks/1.0/webhook/:id`, ({ params }) => {
      log(`delete-webhook ${String(params['id'])}`);
      jira.webhooks = jira.webhooks.filter((w) => w.id !== Number(params['id']));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${BASE}/rest/webhooks/1.0/webhook`, async ({ request }) => {
      const body = (await request.json()) as Omit<FakeJira['webhooks'][number], 'id' | 'enabled'>;
      log(`register-webhook ${body.url}`);
      const id = (jira.webhooks.at(-1)?.id ?? 0) + 1;
      jira.webhooks.push({ id, enabled: true, ...body });
      return HttpResponse.json({ ...body, enabled: true, self: `${BASE}/rest/webhooks/1.0/webhook/${id}` }, { status: 201 });
    }),
  );
});
afterEach(() => server.resetHandlers());

function envFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'jira-bootstrap-')), '.env.live');
  writeFileSync(path, content);
  return path;
}

const ORIGINAL = [
  '# owner values',
  'JIRA_BASE_URL=https://snapwing-test.atlassian.net',
  'JIRA_EMAIL=owner@example.com',
  `JIRA_API_TOKEN=${TOKEN}`,
  'JIRA_PROJECT_KEY=OAJ',
  'SLACK_BOT_TOKEN=xoxb-keep-me',
  '',
].join('\n');

const writes = (): string[] => jira.calls.filter((c) => !c.startsWith('get'));

describe('first run', () => {
  it('creates the four fields, places them on the project screens, writes .env.live, and checks the workflow', async () => {
    const path = envFile(ORIGINAL);
    const report = await runBootstrap({ env: ENV, envFilePath: path });
    expect(report.ok).toBe(true);
    expect(jira.calls.filter((c) => c.startsWith('create-field')).sort()).toEqual(
      FIELD_SPECS.map((s) => `create-field ${s.name}`).sort(),
    );
    const types = Object.fromEntries(jira.fields.filter((f) => f.custom).map((f) => [f.name, f.schema?.custom]));
    expect(types).toEqual({
      'Implementation Prompt': `${CF}:textarea`,
      'Conversation Link': `${CF}:url`,
      'Autonomy Level': `${CF}:float`,
      'Agent Status': `${CF}:textfield`,
    });
    expect(jira.screenFields[1]).toHaveLength(5);
    expect(jira.screenFields[2]).toHaveLength(5);
    expect(jira.screenFields[3]).toBeUndefined();

    const text = readFileSync(path, 'utf8');
    const env = parseEnvFile(text);
    expect(env).toMatchObject({
      JIRA_FIELD_IMPL_PROMPT: 'customfield_10042',
      JIRA_FIELD_CONVERSATION: 'customfield_10043',
      JIRA_FIELD_AUTONOMY: 'customfield_10044',
      JIRA_FIELD_AGENT_STATUS: 'customfield_10045',
      SLACK_BOT_TOKEN: 'xoxb-keep-me',
    });
    expect(text.startsWith(ORIGINAL.trimEnd())).toBe(true);
  });

  it('opens with what it needs, closes with the next step, and never prints a secret', async () => {
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL) });
    expect(report.lines[0]).toBe('needs: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY in .env.live');
    expect(report.lines.at(-1)).toContain('pnpm jira:bootstrap webhook');
    expect(report.lines.at(-1)).toContain('SNAPWING_PUBLIC_URL');
    const all = report.lines.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('owner@example.com');
  });

  it('does not need SNAPWING_PUBLIC_URL and never touches webhooks', async () => {
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL) });
    expect(report.ok).toBe(true);
    expect(jira.calls.some((c) => c.includes('webhook'))).toBe(false);
  });
});

describe('re-run', () => {
  it('changes nothing in Jira or the env file', async () => {
    const path = envFile(ORIGINAL);
    await runBootstrap({ env: ENV, envFilePath: path });
    const afterFirst = readFileSync(path, 'utf8');
    jira.calls.length = 0;
    const report = await runBootstrap({ env: ENV, envFilePath: path });
    expect(report.ok).toBe(true);
    expect(writes()).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(afterFirst);
    expect(report.checks.find((c) => c.name === 'env-file')?.message).toBe('already up to date');
  });

  it('rewrites a stale id in place and keeps every other line', async () => {
    const path = envFile(`${ORIGINAL}JIRA_FIELD_AUTONOMY=customfield_99999\n# trailing note\n`);
    await runBootstrap({ env: ENV, envFilePath: path });
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines.filter((l) => l.startsWith('JIRA_FIELD_AUTONOMY='))).toEqual(['JIRA_FIELD_AUTONOMY=customfield_10044']);
    expect(lines).toContain('# trailing note');
    expect(lines).toContain('SLACK_BOT_TOKEN=xoxb-keep-me');
  });
});

describe('workflow check', () => {
  const NO_CONFIG = '/nonexistent/snapwing.config.xml';

  it('passes on a default Scrum project by category and prints the mapping', async () => {
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL), configPath: NO_CONFIG });
    expect(report.ok).toBe(true);
    expect(report.lines).toContain('ok   workflow: backlog -> To Do, in-progress -> In Progress, in-review -> In Review, done -> Done');
  });

  it('maps a Backlog project without In Review, and takes the config override', async () => {
    jira.statuses = [
      { name: 'Backlog', category: 'new' },
      { name: 'Selected for Development', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
      { name: 'Done', category: 'done' },
    ];
    const example = readFileSync(new URL('../../../../examples/snapwing.config.example.xml', import.meta.url), 'utf8');
    const configPath = join(mkdtempSync(join(tmpdir(), 'jira-bootstrap-')), 'snapwing.config.xml');
    writeFileSync(configPath, example.replace('<jira/>', '<jira><status logical="backlog" name="Selected for Development"/></jira>'));
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL), configPath });
    expect(report.ok).toBe(true);
    expect(report.lines).toContain(`ok   config: ${configPath} names the status for backlog`);
    expect(report.lines).toContain(
      'ok   workflow: backlog -> Selected for Development (from config), in-progress -> In Progress, in-review -> In Progress (no In Review status), done -> Done',
    );
  });

  it('fails naming what cannot map and the project statuses, and exits non-zero in the report', async () => {
    jira.statuses = [
      { name: 'Backlog', category: 'new' },
      { name: 'To Do', category: 'new' },
    ];
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL), configPath: NO_CONFIG });
    expect(report.ok).toBe(false);
    const line = report.lines.find((l) => l.startsWith('FAIL workflow'));
    expect(line).toContain('no status in category indeterminate for in-progress');
    expect(line).toContain('no status in category done for done');
    expect(line).toContain("OAJ's statuses: Backlog (new), To Do (new)");
    expect(line).not.toContain('for backlog');
    expect(report.lines.at(-1)).toContain('FAIL');
  });
});

describe('team-managed project', () => {
  it('fails up front with one line asking for a company-managed project, before any field or screen call', async () => {
    jira.style = 'next-gen';
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL) });
    expect(report.ok).toBe(false);
    expect(report.lines.filter((l) => l.startsWith('FAIL'))).toEqual([
      'FAIL project: OAJ is a team-managed project, which Snapwing cannot set up; create a company-managed project and set JIRA_PROJECT_KEY to its key',
    ]);
    expect(report.checks.map((c) => c.name)).toEqual(['credentials', 'project']);
    expect(jira.calls).toEqual([]);
  });

  it('names JIRA_PROJECT_KEY when the project does not exist', async () => {
    server.use(http.get(`${BASE}/rest/api/3/project/OAJ`, () => HttpResponse.json({ errorMessages: ['No project could be found with key'] }, { status: 404 })));
    const report = await runBootstrap({ env: ENV, envFilePath: envFile(ORIGINAL) });
    expect(report.lines).toContain('FAIL project: no project OAJ (check JIRA_PROJECT_KEY)');
  });
});

describe('--dry-run', () => {
  it('prints the plan and writes nothing', async () => {
    const path = envFile(ORIGINAL);
    const report = await runBootstrap({ env: ENV, envFilePath: path, dryRun: true });
    expect(report.ok).toBe(true);
    expect(writes()).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(ORIGINAL);
    const plan = report.lines.filter((l) => l.startsWith('plan '));
    expect(plan.filter((l) => l.includes('create custom field'))).toHaveLength(4);
  });

  it('does not create the env file when absent', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jira-bootstrap-')), '.env.live');
    await runBootstrap({ env: ENV, envFilePath: path, dryRun: true });
    expect(existsSync(path)).toBe(false);
  });
});

describe('missing values', () => {
  it('names each missing key and calls nothing', async () => {
    const report = await runBootstrap({ env: { JIRA_BASE_URL: BASE }, envFilePath: envFile('') });
    expect(report.ok).toBe(false);
    expect(report.lines[1]).toContain('JIRA_EMAIL');
    expect(report.lines[1]).toContain('JIRA_PROJECT_KEY');
    expect(jira.calls).toEqual([]);
  });
});

describe('webhook', () => {
  const WH = { ...ENV, SNAPWING_PUBLIC_URL: 'https://abc.ngrok.app/' };

  it('requires SNAPWING_PUBLIC_URL', async () => {
    const report = await runBootstrap({ env: ENV, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toContain('SNAPWING_PUBLIC_URL');
    expect(report.lines[1]).toContain('SNAPWING_PUBLIC_URL');
    expect(jira.calls).toEqual([]);
  });

  it('registers the webhook for issue_updated and comment_created filtered to the project', async () => {
    const report = await runBootstrap({ env: WH, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    expect(report.ok).toBe(true);
    expect(jira.webhooks).toEqual([
      expect.objectContaining({
        name: 'Snapwing',
        filters: { 'issue-related-events-section': 'project = OAJ' },
        events: ['jira:issue_updated', 'comment_created'],
        url: 'https://abc.ngrok.app/webhooks/jira',
      }),
    ]);
  });

  it('appends the URL-encoded ?secret= when JIRA_WEBHOOK_SECRET is set and never prints it', async () => {
    const report = await runBootstrap({ env: { ...WH, JIRA_WEBHOOK_SECRET: 'ZQ9 w&x' }, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    expect(report.ok).toBe(true);
    expect(jira.webhooks[0]?.url).toBe('https://abc.ngrok.app/webhooks/jira?secret=ZQ9%20w%26x');
    const out = report.lines.join('\n');
    expect(out).not.toContain('ZQ9');
    expect(out).toContain('(with ?secret)');
  });

  it('leaves an identical webhook alone on re-run', async () => {
    await runBootstrap({ env: WH, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    const report = await runBootstrap({ env: WH, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    expect(report.lines.join('\n')).toContain('already registered');
    expect(jira.webhooks).toHaveLength(1);
    expect(jira.calls.filter((c) => c.startsWith('register-webhook'))).toHaveLength(1);
  });

  it('does not touch a webhook it does not own', async () => {
    jira.webhooks.push({ id: 7, name: 'Someone else', url: 'https://x.example/hook', events: ['jira:issue_updated'], filters: { 'issue-related-events-section': 'project = OAJ' }, enabled: true });
    await runBootstrap({ env: WH, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    expect(jira.webhooks.map((w) => w.name).sort()).toEqual(['Snapwing', 'Someone else']);
  });

  it('on re-run with a new URL leaves exactly one webhook', async () => {
    await runBootstrap({ env: WH, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    await runBootstrap({ env: { ...ENV, SNAPWING_PUBLIC_URL: 'https://def.ngrok.app' }, mode: 'webhook', envFilePath: envFile(ORIGINAL) });
    expect(jira.webhooks).toHaveLength(1);
    expect(jira.webhooks[0]?.url).toBe('https://def.ngrok.app/webhooks/jira');
  });

  it('--dry-run registers nothing', async () => {
    const report = await runBootstrap({ env: WH, mode: 'webhook', dryRun: true, envFilePath: envFile(ORIGINAL) });
    expect(report.ok).toBe(true);
    expect(jira.webhooks).toEqual([]);
    expect(report.lines.some((l) => l.startsWith('plan register webhook https://abc.ngrok.app/webhooks/jira'))).toBe(true);
  });
});

describe('updateEnvText', () => {
  it('appends missing keys after existing content with one trailing newline', () => {
    expect(updateEnvText('A=1\n', { B: '2' })).toBe('A=1\nB=2\n');
    expect(updateEnvText('', { B: '2' })).toBe('B=2\n');
  });
});
