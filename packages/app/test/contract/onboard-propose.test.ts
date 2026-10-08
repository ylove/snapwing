// Onboarding steps `surfaces` and `people` (main 22.2, main 4.1 and 4.3: auto-propose, then confirm)
// against MSW: three repositories and two Jira projects proposed as products, channels matched by
// name, the installer renaming, re-pointing, merging, and leaving out, a rerun checked against what
// changed, untrusted names, and the owners from CODEOWNERS (a team among them) and Jira component
// leads matched to Slack and Teams by email, with one platform, both, or neither, and an owner with
// no chat account. The saved data is written as a workspace map at the end, which must validate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MapChannel, MapPerson, MapSurface, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { writeWorkspaceMap } from '@snapwing/pipeline/map/write.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type JsonObject, type OnboardingStore } from '../../src/onboard/interview/state.ts';
import type { OnboardStep, StepNeed } from '../../src/onboard/interview/step.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import { codeownersEntries, proposeOwners } from '../../src/onboard/propose/people.ts';
import { cleanText, matchChannel, proposeSurfaces, type ProjectDetail } from '../../src/onboard/propose/surfaces.ts';
import { peopleStep } from '../../src/onboard/steps/people.ts';
import { surfacesStep } from '../../src/onboard/steps/surfaces.ts';

const JIRA = 'https://acme-test.atlassian.net';
const GH = 'https://api.github.com';
const SLACK = 'https://slack.com/api';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

const JIRA_TOKEN = 'ATATT-test-token-0123456789';
const SLACK_TOKEN = 'xoxb-test-bot-token';
const TEAMS_PASSWORD = 'teams-password-0123456789';
const PEM = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

// The Jira admin is also an owner: their email must survive in what the step saves.
const JIRA_ENV = { JIRA_BASE_URL: JIRA, JIRA_EMAIL: 'dana@acme.test', JIRA_API_TOKEN: JIRA_TOKEN };
const GITHUB_ENV = { GITHUB_APP_ID: '1234567', GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_INSTALLATION_ID: '87654321' };
const SLACK_ENV = { SLACK_BOT_TOKEN: SLACK_TOKEN };
const TEAMS_ENV = { TEAMS_APP_ID: '00000000-0000-4000-8000-00000000a99a', TEAMS_APP_PASSWORD: TEAMS_PASSWORD, TEAMS_TENANT_ID: '00000000-0000-4000-8000-00000000c0de' };
const ALL_ENV = { ...JIRA_ENV, ...GITHUB_ENV, ...SLACK_ENV, ...TEAMS_ENV };

interface World {
  /** Jira projects by key: name and the raw components Jira answers with. */
  projects: Record<string, { name: string; components: unknown[] }>;
  /** CODEOWNERS text by `owner/name` and location. */
  codeowners: Record<string, Record<string, string>>;
  /** Public emails by GitHub login (null: none shown). */
  githubUsers: Record<string, string | null>;
  slackUsers: Record<string, { id: string; name: string }>;
  teamsUsers: Record<string, { id: string; displayName: string }>;
  calls: string[];
}
let world: World;

const server = setupServer(
  http.get(`${JIRA}/rest/api/3/project/:key`, ({ params, request }) => {
    const key = String(params['key']);
    world.calls.push(`jira project ${key} as ${request.headers.get('authorization') === null ? 'nobody' : 'login'}`);
    const p = world.projects[key];
    return p === undefined ? HttpResponse.json({ errorMessages: ['No project'] }, { status: 404 }) : HttpResponse.json({ id: '10000', key, name: p.name, style: 'classic', components: p.components });
  }),
  http.post(`${GH}/app/installations/:id/access_tokens`, () => HttpResponse.json({ token: 'ghs_test_installation', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 })),
  http.get(`${GH}/repos/:owner/:repo/contents/*`, ({ params, request }) => {
    const repo = `${String(params['owner'])}/${String(params['repo'])}`;
    const location = decodeURIComponent(new URL(request.url).pathname.split('/contents/')[1] ?? '');
    world.calls.push(`github ${repo} ${location}`);
    const text = world.codeowners[repo]?.[location];
    return text === undefined ? HttpResponse.json({ message: 'Not Found' }, { status: 404 }) : new HttpResponse(text, { headers: { 'content-type': 'text/plain' } });
  }),
  http.get(`${GH}/users/:login`, ({ params }) => {
    const login = String(params['login']);
    world.calls.push(`github user ${login}`);
    return login in world.githubUsers ? HttpResponse.json({ login, email: world.githubUsers[login] }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),
  http.get(`${SLACK}/users.lookupByEmail`, ({ request }) => {
    const email = new URL(request.url).searchParams.get('email') ?? '';
    world.calls.push(`slack ${email}`);
    if (request.headers.get('authorization') !== `Bearer ${SLACK_TOKEN}`) return HttpResponse.json({ ok: false, error: 'invalid_auth' });
    const user = world.slackUsers[email];
    return user === undefined ? HttpResponse.json({ ok: false, error: 'users_not_found' }) : HttpResponse.json({ ok: true, user: { ...user, deleted: false, is_bot: false } });
  }),
  http.post(`${LOGIN}/:tenant/oauth2/v2.0/token`, () => HttpResponse.json({ access_token: 'graph-test-token', expires_in: 3600, token_type: 'Bearer' })),
  http.get(`${GRAPH}/users`, ({ request }) => {
    const filter = new URL(request.url).searchParams.get('$filter') ?? '';
    const email = /mail eq '([^']+)'/.exec(filter)?.[1] ?? '';
    world.calls.push(`teams ${email}`);
    const user = world.teamsUsers[email];
    return HttpResponse.json({ value: user === undefined ? [] : [{ id: user.id, displayName: user.displayName, mail: email }] });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
  world = {
    projects: {
      WEB: {
        name: 'Website',
        components: [
          { id: '1', name: 'Checkout', lead: { accountId: 'acc-mia', displayName: 'Mia Lopez', active: true } },
          { id: '2', name: 'Navigation', lead: { accountId: 'acc-dana', displayName: 'Dana Reyes', emailAddress: 'dana@acme.test' } },
        ],
      },
      APP: { name: 'Mobile App', components: [] },
    },
    codeowners: {
      'acme/web': { '.github/CODEOWNERS': '# web\n*  @dana-gh @acme/web-team\n/docs/ @quiet-gh\n' },
      'acme/mobile': { CODEOWNERS: '* marcus@acme.test\n' },
      'acme/admin': { 'docs/CODEOWNERS': '* @sam-gh\n' },
    },
    githubUsers: { 'dana-gh': 'dana@acme.test', 'quiet-gh': null, 'sam-gh': 'sam@acme.test' },
    slackUsers: {
      'dana@acme.test': { id: 'U0DANA', name: 'dana' },
      'marcus@acme.test': { id: 'U0MARCUS', name: 'marcus' },
      'lee@acme.test': { id: 'U0LEE', name: 'lee' },
    },
    teamsUsers: {
      'dana@acme.test': { id: 'aad-dana', displayName: 'Dana Reyes' },
      'mia@acme.test': { id: 'aad-mia', displayName: 'Mia Lopez' },
    },
    calls: [],
  };
});
afterEach(() => server.resetHandlers());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-propose-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fake = (id: string, needs: StepNeed[] = []): OnboardStep => ({ id, number: 0, title: id, needs, run: () => Promise.resolve({ status: 'done' }) });
const EARLIER: readonly OnboardStep[] = [fake('runtime'), fake('slack', ['runtime']), fake('teams', ['runtime']), fake('jira', ['runtime']), fake('github', ['runtime'])];

const REPOS = ['acme/web', 'acme/mobile', 'acme/admin'];
const SLACK_CHANNELS = [
  { id: 'C0WEB', name: 'web-bugs' },
  { id: 'C0MKT', name: 'market-bugs' },
  { id: 'C0ALERT', name: 'alerts' },
];
const TEAMS_CHANNELS = [{ id: '19:appbugs@thread.tacv2', name: 'App bugs', teamId: 'team-0001' }];

interface Memory {
  readonly store: OnboardingStore;
  readonly raw: Map<string, string>;
}

function memoryStore(): Memory {
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

/** Saves earlier steps as done with `data`, the way their own steps would. */
async function seed(memory: Memory, data: Record<string, JsonObject>): Promise<void> {
  for (const [id, d] of Object.entries(data)) await memory.store.saveStep(id, { status: 'done', attempts: 1, data: d }, new Date('2026-10-08T12:00:00Z'));
}

const EARLIER_DATA: Record<string, JsonObject> = {
  runtime: {},
  slack: { channels: SLACK_CHANNELS },
  teams: { channels: TEAMS_CHANNELS },
  jira: { site: JIRA, email: 'dana@acme.test', projects: ['WEB', 'APP'], webhook: 'waiting' },
  github: { repos: REPOS },
};

async function seeded(data: Record<string, JsonObject> = EARLIER_DATA): Promise<Memory> {
  const memory = memoryStore();
  await seed(memory, data);
  return memory;
}

interface Run {
  readonly result: InterviewResult;
  readonly lines: string[];
  readonly asked: readonly string[];
  readonly stateText: string;
}

async function interview(memory: Memory, answers: readonly string[], options: { env?: Record<string, string>; steps?: readonly OnboardStep[]; only?: string } = {}): Promise<Run> {
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const result = await runInterview({
    steps: options.steps ?? [...EARLIER, surfacesStep],
    store: memory.store,
    io,
    workdir: dir,
    env: options.env ?? ALL_ENV,
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  return { result, lines, asked: prompter.asked, stateText: [...memory.raw.values()].join('\n') };
}

const dataOf = (run: Run, step: string): JsonObject | undefined => run.result.state.steps[step]?.data;
const surfacesOf = (run: Run): MapSurface[] => (dataOf(run, 'surfaces')?.['surfaces'] ?? []) as unknown as MapSurface[];
const channelsOf = (run: Run): MapChannel[] => (dataOf(run, 'surfaces')?.['channels'] ?? []) as unknown as MapChannel[];
const peopleOf = (run: Run): MapPerson[] => (dataOf(run, 'people')?.['people'] ?? []) as unknown as MapPerson[];
const channel = (run: Run, id: string): MapChannel | undefined => channelsOf(run).find((c) => c.id === id);

/** The workspace map built from the two steps' data, written and validated (XSD and Schematron). */
async function writeMap(run: Run): Promise<Awaited<ReturnType<typeof writeWorkspaceMap>>> {
  const surfaces = dataOf(run, 'surfaces');
  const map: WorkspaceMap = {
    org: typeof surfaces?.['org'] === 'string' ? surfaces['org'] : 'acme',
    updated: '2026-10-08T12:00:00Z',
    surfaces: surfacesOf(run),
    ...(typeof surfaces?.['fallbackSurface'] === 'string' ? { fallbackSurface: surfaces['fallbackSurface'] } : {}),
    channels: channelsOf(run),
    triggers: { messageActions: [], emoji: [{ slack: 'bug', teams: 'bug' }] },
    vocabulary: [],
    people: peopleOf(run),
    policies: {
      autonomy: {
        default: 1,
        levels: [
          { id: 0, name: 'ticket-only', fixer: 'never', merge: 'none', requires: [] },
          { id: 1, name: 'fix-on-tap', fixer: 'on-tap', merge: 'human', requires: [] },
          { id: 2, name: 'fix-now', fixer: 'immediate', merge: 'human', requires: [] },
          { id: 3, name: 'autopilot', fixer: 'immediate', merge: 'agent', requires: ['review-agent', 'ci-green', 'risk-gate'] },
        ],
        overrides: [],
      },
    },
  };
  return writeWorkspaceMap(map);
}

describe('the proposal', () => {
  const projects: ProjectDetail[] = [
    { key: 'WEB', name: 'Website', components: [{ name: 'Checkout' }] },
    { key: 'APP', name: 'Mobile App', components: [] },
  ];

  it('proposes one product per repository, matches projects by key or name, and guesses for a repository nothing matches', () => {
    const draft = proposeSurfaces({ repos: REPOS, projects, channels: [] });
    expect(draft.surfaces.map((s) => [s.id, s.label, s.project, s.guessed])).toEqual([
      ['web', 'Website', 'WEB', false],
      ['mobile', 'Mobile App', 'APP', false],
      ['admin', 'Admin', 'WEB', true],
    ]);
    expect(draft.surfaces[0]?.components).toEqual([{ id: 'checkout', label: 'Checkout' }]);
    expect(draft.fallbackSurface).toBe('web');
  });

  it('gives a project nobody matched to a repository nobody matched', () => {
    const draft = proposeSurfaces({ repos: ['acme/web', 'acme/tools'], projects: [...projects, { key: 'OPS', name: 'Operations', components: [] }], channels: [] });
    expect(draft.surfaces.map((s) => [s.id, s.project, s.guessed])).toEqual([
      ['web', 'WEB', false],
      ['tools', 'APP', true],
    ]);
  });

  it('matches channels by the words in their names, ignoring bug words, and sends an alerts channel to the payload', () => {
    const { surfaces } = proposeSurfaces({ repos: REPOS, projects, channels: [] });
    expect(matchChannel('web-bugs', surfaces, projects)).toBe('web');
    expect(matchChannel('app-bugs', surfaces, projects)).toBe('mobile');
    expect(matchChannel('Admin Support', surfaces, projects)).toBe('admin');
    expect(matchChannel('webbugs', surfaces, projects)).toBe('web');
    expect(matchChannel('alerts', surfaces, projects)).toBe('from-payload');
    expect(matchChannel('market-bugs', surfaces, projects)).toBeUndefined();
    expect(matchChannel('bugs', surfaces, projects)).toBeUndefined();
  });

  it('makes untrusted names safe to show and keep', () => {
    expect(cleanText('\u001b[31mweb\u001b[0m-bugs\n<!channel> ‮evil​')).toBe('[31mweb [0m-bugs !channel evil');
    expect(cleanText('x'.repeat(200))).toHaveLength(80);
    expect(cleanText(42)).toBe('');
  });

  it('reads every CODEOWNERS owner once, users, teams, and emails, and merges a lead with the same email', () => {
    const entries = codeownersEntries('*  @dana-gh @acme/web-team\n/docs/ @dana-gh dana@acme.test\n/x not-an-owner\n');
    expect(entries).toEqual([
      { kind: 'user', login: 'dana-gh' },
      { kind: 'team', org: 'acme', slug: 'web-team' },
      { kind: 'email', email: 'dana@acme.test' },
    ]);
    const surface: MapSurface = { id: 'web', label: 'Website', repo: 'github.com/acme/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [{ id: 'navigation', label: 'Navigation' }] };
    const proposal = proposeOwners({
      surface,
      repo: 'acme/web',
      codeowners: entries,
      project: { key: 'WEB', name: 'Website', components: [{ name: 'Navigation', lead: { accountId: 'acc-dana', displayName: 'Dana', email: 'dana@acme.test' } }] },
      githubEmails: new Map([['dana-gh', 'dana@acme.test']]),
    });
    expect(proposal.teams.map((t) => t.name)).toEqual(['@acme/web-team']);
    expect(proposal.people).toHaveLength(1);
    expect(proposal.people[0]).toMatchObject({ email: 'dana@acme.test', githubLogin: 'dana-gh', jiraAccountId: 'acc-dana', surfaceOwner: true, components: ['navigation'] });
  });
});

describe('onboarding step: surfaces', () => {
  it('proposes products from three repositories and two Jira projects, and keeps them on yes', async () => {
    const memory = await seeded();
    const run = await interview(memory, ['']);
    expect(run.result.outcome).toBe('complete');
    expect(run.result.state.steps['surfaces']?.status).toBe('done');
    const text = run.lines.join('\n');
    expect(text).toContain('Here is what I think your products are, from your repositories and Jira projects.');
    expect(text).toContain('  Website: repository acme/web; Jira project WEB; Jira components Checkout and Navigation; channel #web-bugs (Slack)');
    expect(text).toContain('  Mobile App: repository acme/mobile; Jira project APP; channel App bugs (Teams)');
    expect(text).toContain('  Admin: repository acme/admin; Jira project WEB (a guess: no project name matched); Jira components Checkout and Navigation; no channel of its own');
    expect(text).toContain('Alerts, each saying which product it is about: #alerts (Slack)');
    expect(text).toContain('Reports that fit no product go to Website.');
    expect(text).toContain('No product matched the name of #market-bugs (Slack), so it goes to Website too.');
    expect(text).not.toMatch(/step \d/i);

    expect(dataOf(run, 'surfaces')).toMatchObject({ org: 'acme', fallbackSurface: 'web', skippedRepos: [], skippedChannels: [] });
    expect(surfacesOf(run)).toEqual([
      {
        id: 'web',
        label: 'Website',
        repo: 'github.com/acme/web',
        jira: { project: 'WEB', defaultIssueType: 'Bug' },
        components: [
          { id: 'checkout', label: 'Checkout' },
          { id: 'navigation', label: 'Navigation' },
        ],
      },
      { id: 'mobile', label: 'Mobile App', repo: 'github.com/acme/mobile', jira: { project: 'APP', defaultIssueType: 'Bug' }, components: [] },
      {
        id: 'admin',
        label: 'Admin',
        repo: 'github.com/acme/admin',
        jira: { project: 'WEB', defaultIssueType: 'Bug' },
        components: [
          { id: 'checkout', label: 'Checkout' },
          { id: 'navigation', label: 'Navigation' },
        ],
      },
    ]);
    expect(channelsOf(run)).toEqual([
      { id: 'C0WEB', name: 'web-bugs', surface: 'web', confidence: 'explicit', triggerEmoji: [] },
      { id: 'C0MKT', name: 'market-bugs', surface: 'web', confidence: 'inferred', triggerEmoji: [] },
      { id: 'C0ALERT', name: 'alerts', surface: 'from-payload', triggerEmoji: [] },
      { id: '19:appbugs@thread.tacv2', name: 'App bugs', surface: 'mobile', confidence: 'explicit', platform: 'teams', teamId: 'team-0001', triggerEmoji: [] },
    ]);
    expect(run.stateText).not.toContain(JIRA_TOKEN);
    expect(world.calls.filter((c) => c.startsWith('jira project'))).toEqual(['jira project WEB as login', 'jira project APP as login']);
  });

  it('lets the installer rename a product, send a guess to another project, place a channel, and pick the fallback', async () => {
    const memory = await seeded();
    // edit; Website keep; Mobile App rename to Phone App; Admin to project APP;
    // channels: web-bugs default, market-bugs to Website (1), alerts default, App bugs default; fallback Admin (3); then yes.
    const run = await interview(memory, ['edit', '', 'rename', 'Phone App', 'project', 'APP', '', '1', '', '', '3', '']);
    expect(run.result.state.steps['surfaces']?.status).toBe('done');
    expect(surfacesOf(run).map((s) => [s.id, s.label, s.jira.project, s.components.length])).toEqual([
      ['web', 'Website', 'WEB', 2],
      ['phone-app', 'Phone App', 'APP', 0],
      ['admin', 'Admin', 'APP', 0],
    ]);
    expect(channel(run, 'C0MKT')).toMatchObject({ surface: 'web', confidence: 'explicit' });
    expect(channel(run, '19:appbugs@thread.tacv2')).toMatchObject({ surface: 'phone-app', confidence: 'explicit', platform: 'teams' });
    expect(dataOf(run, 'surfaces')?.['fallbackSurface']).toBe('admin');
    // The draft is shown again after the edits and only kept on yes.
    expect(run.lines.filter((l) => l === 'Is that right?')).toHaveLength(2);
    expect(run.lines).toContain('  Admin: repository acme/admin; Jira project APP; no channel of its own');
  });

  it('merges a product into another and leaves a product and a channel out, keeping them to bring back later', async () => {
    const memory = await seeded();
    // edit; Website keep; Mobile App merge into Website; Admin leave out;
    // channels: web-bugs default, market-bugs out, alerts default, App bugs default (moved to Website); yes.
    const run = await interview(memory, ['edit', '', 'merge', '1', 'drop', '', 'out', '', '', '']);
    expect(run.result.state.steps['surfaces']?.status).toBe('done');
    expect(surfacesOf(run).map((s) => s.id)).toEqual(['web']);
    expect(dataOf(run, 'surfaces')).toMatchObject({ fallbackSurface: 'web', skippedRepos: ['acme/mobile', 'acme/admin'], skippedChannels: ['C0MKT'] });
    expect(channelsOf(run).map((c) => [c.id, c.surface])).toEqual([
      ['C0WEB', 'web'],
      ['C0ALERT', 'from-payload'],
      ['19:appbugs@thread.tacv2', 'web'],
    ]);
    expect(run.lines).toContain('Left out: repository acme/mobile, repository acme/admin, #market-bugs (Slack)');

    // A rerun shows them as left out and does not propose them again; editing can bring one back.
    // edit; Website keep; Mobile App back; Admin stays out; web-bugs, alerts, App bugs default; market-bugs (left out, listed last) to Mobile App; fallback Website; yes.
    const again = await interview(memory, ['edit', '', 'back', '', '', '', '', 'product:mobile', '1', ''], { only: 'surfaces' });
    expect(again.lines).toContain('These are the products you confirmed before; nothing has changed since.');
    expect(surfacesOf(again).map((s) => s.id)).toEqual(['web', 'mobile']);
    expect(channel(again, 'C0MKT')).toMatchObject({ surface: 'mobile', confidence: 'explicit' });
    expect(dataOf(again, 'surfaces')).toMatchObject({ skippedRepos: ['acme/admin'], skippedChannels: [] });
  });

  it('checks the saved products again on a rerun and names what changed', async () => {
    const memory = await seeded();
    await interview(memory, ['']);
    const unchanged = await interview(memory, [''], { only: 'surfaces' });
    expect(unchanged.lines).toContain('These are the products you confirmed before; nothing has changed since.');
    expect(surfacesOf(unchanged).map((s) => s.id)).toEqual(['web', 'mobile', 'admin']);

    await seed(memory, {
      github: { repos: ['acme/web', 'acme/mobile', 'acme/docs-site'] },
      slack: { channels: [...SLACK_CHANNELS.slice(0, 2), { id: 'C0DOCS', name: 'docs-bugs' }] },
      jira: { site: JIRA, email: 'dana@acme.test', projects: ['WEB'] },
    });
    const changed = await interview(memory, [''], { only: 'surfaces' });
    expect(changed.result.state.steps['surfaces']?.status).toBe('done');
    const text = changed.lines.join('\n');
    expect(text).toContain('These are the products you confirmed before. Since then:');
    expect(text).toContain('  Admin: the GitHub App no longer lists acme/admin, so it is left out.');
    expect(text).toContain('  Mobile App: Jira project APP is no longer one of the chosen projects, so I picked WEB instead.');
    expect(text).toContain('  New repository acme/docs-site: proposed as Docs Site.');
    expect(text).toContain('  #alerts (Slack) is no longer one of the bug channels, so it is left out.');
    expect(text).toContain('  New channel #docs-bugs (Slack).');
    expect(surfacesOf(changed).map((s) => [s.id, s.jira.project])).toEqual([
      ['web', 'WEB'],
      ['mobile', 'WEB'],
      ['docs-site', 'WEB'],
    ]);
    expect(channel(changed, 'C0DOCS')).toMatchObject({ surface: 'docs-site', confidence: 'explicit' });
    expect(channel(changed, 'C0MKT')).toMatchObject({ surface: 'web', confidence: 'inferred' });
    expect(channel(changed, 'C0ALERT')).toBeUndefined();
  });

  it('asks for the repositories when the GitHub step recorded none', async () => {
    const memory = await seeded({ ...EARLIER_DATA, github: {} });
    const run = await interview(memory, ['acme/web acme/../x', 'acme/web, acme/payments-api', '']);
    expect(run.result.state.steps['surfaces']?.status).toBe('done');
    expect(run.lines).toContain('I do not have a list of your repositories from GitHub yet.');
    expect(run.lines.some((l) => l.includes('is not a repository name like acme/web'))).toBe(true);
    expect(surfacesOf(run).map((s) => [s.id, s.repo, s.jira.project])).toEqual([
      ['web', 'github.com/acme/web', 'WEB'],
      ['payments-api', 'github.com/acme/payments-api', 'APP'],
    ]);
  });

  it('keeps project keys as names when Jira does not answer, and refuses to start without a chosen project', async () => {
    world.projects = {};
    const memory = await seeded();
    const run = await interview(memory, ['']);
    expect(run.lines).toContain('Jira did not answer for WEB and APP, so they go by the key for now.');
    expect(surfacesOf(run).map((s) => [s.id, s.jira.project, s.components.length])).toEqual([
      ['web', 'WEB', 0],
      ['mobile', 'APP', 0],
      ['admin', 'WEB', 0],
    ]);

    const none = await seeded({ ...EARLIER_DATA, jira: { site: JIRA, email: 'dana@acme.test', projects: [] } });
    const failed = await interview(none, []);
    expect(failed.result.outcome).toBe('failed');
    expect(failed.result.failure?.message).toMatch(/no Jira projects have been chosen yet/);
  });

  it('shows and keeps untrusted names only after cleaning them, and drops malformed ids', async () => {
    world.projects['WEB'] = { name: 'Web‮site\u0000 <script>alert(1)</script>', components: [{ name: '\u001b[2JCheckout', lead: { accountId: 'bad id with spaces', displayName: 'x' } }] };
    const memory = await seeded({
      ...EARLIER_DATA,
      slack: {
        channels: [
          { id: 'C0WEB', name: '\u001b[31mweb-bugs\u001b[0m\n<!channel>' },
          { id: 'C0 BAD', name: 'bad-id' },
          { id: 'C0NONAME', name: '​​' },
        ],
      },
      teams: { channels: [{ id: '19:x@thread.tacv2', name: 'no team id' }] },
      github: { repos: ['acme/web', 'acme/../etc', 'acme/web;rm -rf', { fullName: 'acme/mobile' }, 42] },
    });
    const run = await interview(memory, ['']);
    const text = run.lines.join('\n');
    for (const bad of ['\u001b', '‮', '\u0000', '<', '>', '​']) expect(text).not.toContain(bad);
    expect(surfacesOf(run).map((s) => [s.id, s.label])).toEqual([
      ['web', 'Web site script alert(1) /script'],
      ['mobile', 'Mobile App'],
    ]);
    expect(surfacesOf(run)[0]?.components).toEqual([{ id: '2jcheckout', label: '[2JCheckout' }]);
    expect(channelsOf(run).map((c) => [c.id, c.name])).toEqual([['C0WEB', '[31mweb-bugs [0m !channel']]);
    const map = await writeMap(run);
    expect(map.ok).toBe(true);
  });
});

describe('onboarding step: people', () => {
  const STEPS = [...EARLIER, surfacesStep, peopleStep];
  // Surfaces: yes. Website: keep; quiet-gh's email: leave out; Mia's email; the team's people; backup Marcus.
  // Mobile App: keep, no backup. Admin: keep (Mia is not asked again), no backup.
  const ANSWERS = ['', '', '', 'mia@acme.test', 'lee@acme.test, kim@acme.test', 'marcus@acme.test', '', '', '', ''];

  it('proposes owners from CODEOWNERS and Jira component leads, matches them in Slack and Teams by email, and asks for backups', async () => {
    const memory = await seeded();
    const run = await interview(memory, ANSWERS, { steps: STEPS });
    expect(run.result.outcome).toBe('complete');
    expect(run.result.state.steps['people']?.status).toBe('done');
    const text = run.lines.join('\n');
    expect(text).toContain('I will look each person up in Slack and Teams by email, so Snapwing can mention them there.');
    expect(text).toContain('Website (repository acme/web, Jira project WEB):');
    expect(text).toContain('  @dana-gh on GitHub, dana@acme.test: CODEOWNERS in acme/web and lead of the Jira component Navigation; in Slack and Teams');
    expect(text).toContain('  @quiet-gh on GitHub: CODEOWNERS in acme/web; email not known');
    expect(text).toContain('  Mia Lopez: lead of the Jira component Checkout; email not known');
    expect(text).toContain('  The team @acme/web-team: CODEOWNERS in acme/web; GitHub does not show Snapwing who is in it');
    expect(text).toContain('  marcus@acme.test: CODEOWNERS in acme/mobile; in Slack');
    expect(text).toContain('  @sam-gh on GitHub, sam@acme.test: CODEOWNERS in acme/admin; no chat account found');
    expect(run.asked.filter((q) => q.startsWith('What is the email of Mia Lopez'))).toHaveLength(1);
    expect(run.asked.filter((q) => q.startsWith('CODEOWNERS in acme/web names the team @acme/web-team'))).toHaveLength(1);

    expect(peopleOf(run)).toEqual([
      {
        slackId: 'U0DANA',
        teamsId: 'aad-dana',
        handle: 'dana-gh',
        email: 'dana@acme.test',
        role: 'engineer',
        owns: [
          { surface: 'web', primary: true },
          { surface: 'web', component: 'navigation', primary: true },
          { surface: 'admin', component: 'navigation', primary: true },
        ],
      },
      {
        teamsId: 'aad-mia',
        handle: 'mia',
        email: 'mia@acme.test',
        role: 'engineer',
        owns: [
          { surface: 'web', component: 'checkout', primary: true },
          { surface: 'admin', component: 'checkout', primary: true },
        ],
      },
      { slackId: 'U0LEE', handle: 'lee', email: 'lee@acme.test', role: 'engineer', owns: [{ surface: 'web', primary: true }] },
      { handle: 'kim', email: 'kim@acme.test', role: 'engineer', owns: [{ surface: 'web', primary: true }] },
      {
        slackId: 'U0MARCUS',
        handle: 'marcus',
        email: 'marcus@acme.test',
        role: 'engineer',
        owns: [
          { surface: 'web', primary: false },
          { surface: 'mobile', primary: true },
        ],
      },
      { handle: 'sam-gh', email: 'sam@acme.test', role: 'engineer', owns: [{ surface: 'admin', primary: true }] },
    ]);
    expect(text).toContain('Found in Slack: 3 of 6.');
    expect(text).toContain('Found in Teams: 2 of 6.');
    expect(text).toContain('No Slack or Teams account matches kim@acme.test and sam@acme.test, so they stay in the map by email and Snapwing cannot mention them in chat.');
    // The CODEOWNERS file is read where GitHub looks for it, first found wins.
    expect(world.calls.filter((c) => c.startsWith('github acme/admin'))).toEqual(['github acme/admin .github/CODEOWNERS', 'github acme/admin CODEOWNERS', 'github acme/admin docs/CODEOWNERS']);
    // Each email is looked up once per platform.
    expect(world.calls.filter((c) => c === 'slack dana@acme.test')).toHaveLength(1);
    expect(world.calls.filter((c) => c === 'teams mia@acme.test')).toHaveLength(1);

    const map = await writeMap(run);
    expect(map.ok, map.ok ? '' : JSON.stringify(map.errors)).toBe(true);
    for (const secret of [JIRA_TOKEN, SLACK_TOKEN, TEAMS_PASSWORD, 'BEGIN PRIVATE KEY']) expect(run.stateText + text).not.toContain(secret);
  });

  it('works with only Slack connected: no Teams ids, and Teams is never asked', async () => {
    const memory = await seeded({ ...EARLIER_DATA, teams: {} });
    const run = await interview(memory, ANSWERS, { steps: STEPS, env: { ...JIRA_ENV, ...GITHUB_ENV, ...SLACK_ENV } });
    expect(run.result.state.steps['people']?.status).toBe('done');
    expect(run.lines).toContain('I will look each person up in Slack by email, so Snapwing can mention them there.');
    expect(peopleOf(run).every((p) => p.teamsId === undefined)).toBe(true);
    expect(peopleOf(run).filter((p) => p.slackId !== undefined).map((p) => p.handle)).toEqual(['dana-gh', 'lee', 'marcus']);
    expect(world.calls.some((c) => c.startsWith('teams '))).toBe(false);
    expect(run.lines).toContain('No Slack account matches mia@acme.test, kim@acme.test and sam@acme.test, so they stay in the map by email and Snapwing cannot mention them in chat.');
  });

  it('works with only Teams connected', async () => {
    const memory = await seeded({ ...EARLIER_DATA, slack: {} });
    const run = await interview(memory, ANSWERS, { steps: STEPS, env: { ...JIRA_ENV, ...GITHUB_ENV, ...TEAMS_ENV } });
    expect(run.result.state.steps['people']?.status).toBe('done');
    expect(peopleOf(run).every((p) => p.slackId === undefined)).toBe(true);
    expect(peopleOf(run).filter((p) => p.teamsId !== undefined).map((p) => [p.handle, p.teamsId])).toEqual([
      ['dana-gh', 'aad-dana'],
      ['mia', 'aad-mia'],
    ]);
    expect(world.calls.some((c) => c.startsWith('slack '))).toBe(false);
    expect((await writeMap(run)).ok).toBe(true);
  });

  it('keeps people by email when no chat platform is connected, and fills their chat ids on a rerun once one is', async () => {
    const memory = await seeded();
    const first = await interview(memory, ANSWERS, { steps: STEPS, env: { ...JIRA_ENV, ...GITHUB_ENV } });
    expect(first.result.state.steps['people']?.status).toBe('done');
    expect(first.lines.join('\n')).toContain('No chat platform is connected yet, so people are kept by email for now.');
    expect(peopleOf(first).every((p) => p.slackId === undefined && p.teamsId === undefined)).toBe(true);

    // Rerun with both platforms: the saved owners are shown with their chat accounts, and kept on Enter.
    const again = await interview(memory, [''], { steps: STEPS, only: 'people' });
    expect(again.result.state.steps['people']?.status).toBe('done');
    const text = again.lines.join('\n');
    expect(text).toContain('These are the owners you confirmed before:');
    expect(text).toContain('  Website: dana@acme.test (in Slack and Teams), mia@acme.test (in Teams), lee@acme.test (in Slack), kim@acme.test (no chat account found); backups marcus@acme.test (in Slack)');
    expect(again.asked.filter((q) => q.startsWith('Choose'))).toHaveLength(1);
    expect(peopleOf(again).map((p) => [p.handle, p.slackId, p.teamsId])).toEqual([
      ['dana-gh', 'U0DANA', 'aad-dana'],
      ['mia', undefined, 'aad-mia'],
      ['lee', 'U0LEE', undefined],
      ['kim', undefined, undefined],
      ['marcus', 'U0MARCUS', undefined],
      ['sam-gh', undefined, undefined],
    ]);
  });

  it('on a rerun drops what points at a product that is gone and asks only about a new product', async () => {
    const memory = await seeded();
    await interview(memory, ANSWERS, { steps: STEPS });
    // Admin is left out and a docs repository is added.
    await seed(memory, { github: { repos: ['acme/web', 'acme/mobile', 'acme/docs'] } });
    world.codeowners['acme/docs'] = { CODEOWNERS: '* @sam-gh\n' };
    await interview(memory, [''], { steps: STEPS, only: 'surfaces' });
    // Keep the saved owners; Docs: keep sam, no backup.
    const run = await interview(memory, ['', '', ''], { steps: STEPS, only: 'people' });
    expect(run.result.state.steps['people']?.status).toBe('done');
    const text = run.lines.join('\n');
    expect(text).toContain('  dana@acme.test owned a product that is gone, so that is dropped.');
    expect(text).toContain('  No owners yet: Docs');
    expect(text).toContain('Docs (repository acme/docs, Jira project WEB):');
    const people = peopleOf(run);
    expect(people.find((p) => p.handle === 'sam-gh')?.owns).toEqual([{ surface: 'docs', primary: true }]);
    // Docs takes the Website project (a guess), so the Navigation lead owns that component there too.
    expect(people.find((p) => p.handle === 'dana-gh')?.owns).toEqual([
      { surface: 'web', primary: true },
      { surface: 'web', component: 'navigation', primary: true },
      { surface: 'docs', component: 'navigation', primary: true },
    ]);
    // Mia's email was typed on the first run and is not asked for again.
    expect(text).toContain('  Mia Lopez, mia@acme.test: lead of the Jira component Checkout; in Teams');
    expect(run.asked.some((q) => q.startsWith('What is the email of'))).toBe(false);
    expect((await writeMap(run)).ok).toBe(true);
  });

  it('takes a typed list of owners instead, or nobody, and says which products have no owner', async () => {
    const memory = await seeded();
    // Website: type the owners (one not an email first); no backup. Mobile App: nobody. Admin: nobody.
    const run = await interview(memory, ['', 'change', 'lee@acme.test, not-an-email', 'lee@acme.test, dana@acme.test', '', 'none', '', 'none', ''], { steps: STEPS });
    expect(run.result.state.steps['people']?.status).toBe('done');
    expect(run.lines).toContain('not-an-email does not look like an email address.');
    expect(peopleOf(run).map((p) => [p.handle, p.owns])).toEqual([
      ['lee', [{ surface: 'web', primary: true }]],
      [
        'dana-gh',
        [
          { surface: 'web', primary: true },
          { surface: 'web', component: 'navigation', primary: true },
        ],
      ],
    ]);
    expect(run.lines.join('\n')).toContain('Nobody owns Mobile App and Admin yet, so Snapwing will not know whom to ask about bugs there.');
  });

  it('carries on without a platform that refuses the lookup, and says why', async () => {
    const memory = await seeded();
    const run = await interview(memory, ANSWERS, { steps: STEPS, env: { ...ALL_ENV, SLACK_BOT_TOKEN: 'xoxb-revoked-token' } });
    expect(run.result.state.steps['people']?.status).toBe('done');
    expect(run.lines.join('\n')).toContain('I could not look people up in Slack: Slack did not accept the bot token.');
    expect(world.calls.filter((c) => c.startsWith('slack '))).toHaveLength(1);
    expect(peopleOf(run).every((p) => p.slackId === undefined)).toBe(true);
    expect(peopleOf(run).find((p) => p.handle === 'dana-gh')?.teamsId).toBe('aad-dana');
  });

  it('refuses to start before the products are confirmed', async () => {
    const memory = await seeded();
    const run = await interview(memory, [], { steps: [...EARLIER, fake('surfaces', ['jira', 'github']), peopleStep] });
    expect(run.result.outcome).toBe('failed');
    expect(run.result.failure?.message).toMatch(/the products have not been confirmed yet/);
  });
});
