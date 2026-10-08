// The onboarding proof (`pnpm onboard:proof`, scripts/onboard-proof.ts): its checks and its teardown
// over MSW. The proof directory is made the way the script makes it, and the real interview runs in
// its work directory against the empty sandboxes of the whole-interview test (fixtures/onboard/), with
// the sandbox names and ids coming from the script's own scripted answers. Only the test drive is a
// stand-in: it opens one pull request and files one Jira issue per platform in the small sandboxes kept
// here, and records them the way the real drive does. The checks then read what the run left (the
// onboarding state, .env, the map, the config), and the teardown deletes what it can attribute to the
// run and nothing else: the sandboxes also hold a pull request, a Jira issue, a Slack app, a Teams
// install, and a catalog entry the run did not make. No real service is called (MSW errors on any
// request it does not handle), and no fake secret appears in what the script prints.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_JIRA_EMAIL, JIRA_BASE } from '@snapwing/pipeline/demo/msw/jira.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import {
  answersFor,
  main,
  parsePullUrl,
  newestProofDir,
  proofEnv,
  PROOF_DIR_PREFIX,
  readProofDir,
  runChecks,
  runTeardown,
  sandboxFrom,
  siteHost,
  USAGE,
  writeProofDir,
  type Platform,
  type ProofDeps,
  type ProofDir,
  type Sandbox,
} from '../../../../scripts/onboard-proof.ts';
import { runConfig } from '../../src/cli/config.ts';
import { runOnboard } from '../../src/cli/onboard.ts';
import { scriptedPrompter, type Prompter } from '../../src/cli/prompt.ts';
import { incidentLabel } from '../../src/jira/projector/ops.ts';
import type { JsonObject } from '../../src/onboard/interview/state.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { ONBOARD_STEPS } from '../../src/onboard/steps/index.ts';
import { APP_ID, GRAPH, TEAM, TENANT } from '../fixtures/e2e/teams.ts';
import { SLACK_API } from '../fixtures/e2e/world.ts';
import { GITHUB_API } from '../fixtures/onboard/github.ts';
import { loginOf } from '../fixtures/onboard/jira.ts';
import { emptySandboxes, OWNER, PROJECT, REPO, SLACK_CHANNEL, TEAM_NAME, TEAMS_CHANNEL, type OnboardSandboxes } from '../fixtures/onboard/sandboxes.ts';

/** The sandboxes as `.env.onboard` names them, for the fixtures' Jira site, GitHub account, workspace, and tenant. */
const SANDBOX: Sandbox = {
  jiraSite: 'acme-demo.atlassian.net',
  jiraProject: PROJECT,
  jiraEmail: DEMO_JIRA_EMAIL,
  githubOwner: 'acme',
  githubOwnerType: 'org',
  githubRepo: 'admin',
  slackWorkspace: 'Acme',
  teams: { tenantId: TENANT, appId: APP_ID, team: TEAM_NAME },
};
/** The phase 5 proof's sandboxes: `.env.onboard` without the Teams values. */
const { teams: _noTeams, ...SLACK_SANDBOX } = SANDBOX;
/** Who the run's GitHub App opens pull requests as (the fixture App's slug). */
const RUN_BOT = 'snapwing-acme[bot]';
/** The fresh configuration token the maintainer pastes at teardown. */
const TEARDOWN_CONFIG_TOKEN = 'xoxe-1-e2e-teardown-config-0042';
const OTHER_BOT = '99999999-0000-4000-8000-0000000000ff';

/** Everything the interview asks that `.env.onboard` does not name. */
const ANSWERS: Record<string, unknown> = {
  'runtime.where': 'local',
  'runtime.anthropic-have': 'yes',
  'runtime.anthropic-key': { env: 'E2E_ANTHROPIC_KEY' },
  'runtime.openai-have': 'no',
  'runtime.google-have': 'no',
  'runtime.public-url': 'no',
  'slack.config-token': { env: 'E2E_SLACK_CONFIG_TOKEN' },
  'slack.install': 'installed',
  'slack.bot-token': { env: 'E2E_SLACK_BOT_TOKEN' },
  'slack.app-token': { env: 'E2E_SLACK_APP_TOKEN' },
  'slack.channels': SLACK_CHANNEL.name,
  'slack.private': 'no',
  'teams.client-secret': { env: 'E2E_TEAMS_CLIENT_SECRET' },
  'teams.public-url': 'https://snapwing-e2e.example.test',
  'teams.channels': TEAMS_CHANNEL.name,
  'jira.token': { env: 'E2E_JIRA_TOKEN' },
  'github.name': '',
  'surfaces.confirm': 'yes',
  'words.more': 'usage export',
  'people.owners': 'keep',
  'people.backups': '',
  'trigger.emoji': '',
  'trigger.more': 'done',
  'autonomy.level': '',
  'autonomy.by': OWNER.email,
  'finish.token': 'none',
};

const NOBODY: Prompter = { line: () => Promise.resolve(undefined), hidden: () => Promise.resolve(undefined) };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

// ---- The sandboxes the stand-in drive writes to, and the teardown deletes from ---------------------

interface Pull {
  number: number;
  state: 'open' | 'closed';
  author: string;
  ref: string;
}

/** The sandbox repository's pull requests and branches. */
class RepoSandbox {
  readonly pulls = new Map<number, Pull>();
  readonly refs = new Set<string>(['main']);
  readonly closed: number[] = [];
  readonly deletedRefs: string[] = [];

  open(p: Omit<Pull, 'state'>): void {
    this.pulls.set(p.number, { ...p, state: 'open' });
    this.refs.add(p.ref);
  }

  private json(p: Pull): Record<string, unknown> {
    return {
      number: p.number,
      state: p.state,
      merged_at: null,
      user: { login: p.author },
      head: { ref: p.ref, repo: { full_name: REPO } },
      base: { ref: 'main', repo: { full_name: REPO, default_branch: 'main' } },
    };
  }

  handlers(token: string): HttpHandler[] {
    const base = `${GITHUB_API}/repos/${REPO}`;
    const ok = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${token}`;
    const denied = (): Response => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
    const refOf = (request: Request, marker: string): string => decodeURIComponent(new URL(request.url).pathname.split(marker)[1] ?? '');
    return [
      http.get(`${base}/pulls`, ({ request }) => {
        if (!ok(request)) return denied();
        const state = new URL(request.url).searchParams.get('state') ?? 'open';
        return HttpResponse.json([...this.pulls.values()].filter((p) => state === 'all' || p.state === state).map((p) => this.json(p)));
      }),
      http.get(`${base}/pulls/:n`, ({ request, params }) => {
        if (!ok(request)) return denied();
        const p = this.pulls.get(Number(params['n']));
        return p === undefined ? HttpResponse.json({ message: 'Not Found' }, { status: 404 }) : HttpResponse.json(this.json(p));
      }),
      http.patch(`${base}/pulls/:n`, async ({ request, params }) => {
        if (!ok(request)) return denied();
        const p = this.pulls.get(Number(params['n']));
        if (p === undefined) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
        if (((await request.json()) as { state?: string }).state === 'closed') {
          p.state = 'closed';
          this.closed.push(p.number);
        }
        return HttpResponse.json(this.json(p));
      }),
      http.get(`${base}/git/ref/heads/*`, ({ request }) => {
        if (!ok(request)) return denied();
        const ref = refOf(request, '/git/ref/heads/');
        return this.refs.has(ref) ? HttpResponse.json({ ref: `refs/heads/${ref}` }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      }),
      http.delete(`${base}/git/refs/heads/*`, ({ request }) => {
        if (!ok(request)) return denied();
        const ref = refOf(request, '/git/refs/heads/');
        if (!this.refs.delete(ref)) return HttpResponse.json({ message: 'Reference does not exist' }, { status: 422 });
        this.deletedRefs.push(ref);
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }
}

interface Issue {
  project: string;
  labels: string[];
  summary: string;
}

/** The Jira site's issues, read and deleted with the run's login. */
class IssueSandbox {
  readonly issues = new Map<string, Issue>();
  readonly deleted: string[] = [];

  handlers(token: string): HttpHandler[] {
    const ok = (request: Request): boolean => {
      const login = loginOf(request);
      return login?.email === DEMO_JIRA_EMAIL && login.token === token;
    };
    return [
      http.get(`${JIRA_BASE}/rest/api/3/issue/:key`, ({ request, params }) => {
        if (!ok(request)) return new HttpResponse(null, { status: 401 });
        const key = String(params['key']);
        const issue = this.issues.get(key);
        if (issue === undefined) return HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 });
        return HttpResponse.json({ key, fields: { summary: issue.summary, labels: issue.labels, project: { key: issue.project } } });
      }),
      http.delete(`${JIRA_BASE}/rest/api/3/issue/:key`, ({ request, params }) => {
        if (!ok(request)) return new HttpResponse(null, { status: 401 });
        const key = String(params['key']);
        if (!this.issues.delete(key)) return new HttpResponse(null, { status: 404 });
        this.deleted.push(key);
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }
}

/** Slack's app management with a configuration token: the run's app and another one. */
function slackAppHandlers(world: OnboardSandboxes, apps: Map<string, Record<string, unknown>>, deleted: string[]): HttpHandler[] {
  const tokenOk = (request: Request): boolean => world.slack.configTokens.has((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
  const appOf = async (request: Request): Promise<string> => new URLSearchParams(await request.text()).get('app_id') ?? '';
  return [
    http.post(`${SLACK_API}/apps.manifest.export`, async ({ request }) => {
      if (!tokenOk(request)) return HttpResponse.json({ ok: false, error: 'invalid_auth' });
      const manifest = apps.get(await appOf(request));
      return manifest === undefined ? HttpResponse.json({ ok: false, error: 'app_not_found' }) : HttpResponse.json({ ok: true, manifest });
    }),
    http.post(`${SLACK_API}/apps.manifest.delete`, async ({ request }) => {
      if (!tokenOk(request)) return HttpResponse.json({ ok: false, error: 'invalid_auth' });
      const id = await appOf(request);
      if (!apps.delete(id)) return HttpResponse.json({ ok: false, error: 'app_not_found' });
      deleted.push(id);
      return HttpResponse.json({ ok: true });
    }),
  ];
}

/**
 * Graph's removals with the admin's token, and, once `others.catalog` is set, a catalog that also lists
 * another tenant app (the fixture applies no filter, so the script has to).
 */
function teamsRemovalHandlers(world: OnboardSandboxes, removed: string[], others: { catalog: boolean }): HttpHandler[] {
  const tenant = world.teams;
  const ok = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${world.teamsIds.ownerToken}`;
  return [
    http.get(`${GRAPH}/appCatalogs/teamsApps`, () =>
      HttpResponse.json({
        value: [
          ...(tenant.catalog ? [{ id: tenant.catalog.id, externalId: APP_ID, displayName: 'Snapwing' }] : []),
          ...(others.catalog ? [{ id: 'cat-other', externalId: OTHER_BOT, displayName: 'Other bot' }] : []),
        ],
      }),
    ),
    http.delete(`${GRAPH}/teams/${TEAM}/installedApps/:id`, ({ request, params }) => {
      if (!ok(request)) return HttpResponse.json({ error: { code: 'Forbidden' } }, { status: 403 });
      const id = String(params['id']);
      const before = tenant.installed.length;
      tenant.installed = tenant.installed.filter((a) => a['id'] !== id);
      if (tenant.installed.length === before) return HttpResponse.json({ error: { code: 'NotFound' } }, { status: 404 });
      removed.push(`install ${id}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${GRAPH}/appCatalogs/teamsApps/:id`, ({ request, params }) => {
      if (!ok(request)) return HttpResponse.json({ error: { code: 'Forbidden' } }, { status: 403 });
      const id = String(params['id']);
      if (tenant.catalog?.id !== id) return HttpResponse.json({ error: { code: 'NotFound' } }, { status: 404 });
      delete tenant.catalog;
      removed.push(`catalog ${id}`);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

// ---- One proof run ---------------------------------------------------------------------------------

let tdb: TestDatabase;
let scratch: string;
let world: OnboardSandboxes;
let repo: RepoSandbox;
let jira: IssueSandbox;
let slackApps: Map<string, Record<string, unknown>>;
let slackDeleted: string[];
let teamsRemoved: string[];
let others: { catalog: boolean };
let proof: ProofDir;

/** Where the interview kept its state: the test's database, as `SNAPWING_DB` selects. */
function dbEnv(): Record<string, string> {
  return tdb.dialect === 'postgres' ? { SNAPWING_DB: 'postgres', DATABASE_URL: tdb.options.url ?? '' } : { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: tdb.options.url ?? '' };
}

/** The stand-in test drive: one pull request and one Jira issue per platform, recorded as the real drive records them. */
function standInDrive(): OnboardStep {
  const real = ONBOARD_STEPS.find((s) => s.id === 'test-drive');
  if (real === undefined) throw new Error('no test-drive step');
  return {
    id: real.id,
    title: real.title,
    needs: real.needs,
    run: (ctx) => {
      // A drive on each platform the interview connected, as the real drive does.
      const connected = (['slack', 'teams'] as const).filter((p) => (p === 'slack' ? ctx.data('slack')?.['installed'] === true : ctx.data('teams') !== undefined));
      const drives: JsonObject[] = connected.map((platform, i) => {
        const number = i + 1;
        const jiraKey = `${PROJECT}-${number}`;
        const incident = `01JPR00FDR1VE0000000000${number}`;
        repo.open({ number, author: RUN_BOT, ref: `snapwing/${jiraKey.toLowerCase()}-readme-last-line` });
        jira.issues.set(jiraKey, { project: PROJECT, labels: [incidentLabel(incident)], summary: `README.md is missing its last line (${platform})` });
        const channel = platform === 'slack' ? SLACK_CHANNEL : TEAMS_CHANNEL;
        return { platform, channel: channel.id, channelName: channel.name, incident, jiraKey, pr: `https://github.com/${REPO}/pull/${number}` };
      });
      return Promise.resolve({ status: 'done', data: { repo: REPO, surface: 'admin', level: 2, lifted: true, drives } });
    },
  };
}

/** The interview's output and the questions that fell back to the keyboard (none: every answer is scripted). */
let interview: { out: string[]; asked: readonly string[] };

/** One proof run: the sandboxes, the proof directory, and the interview in its work directory. */
async function proofRun(platform: Platform): Promise<void> {
  const sandbox = platform === 'slack' ? SLACK_SANDBOX : SANDBOX;
  tdb = await createTestDatabase();
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-onboard-proof-scratch-'));
  world = await emptySandboxes(server, scratch);
  repo = new RepoSandbox();
  jira = new IssueSandbox();
  slackApps = new Map();
  slackDeleted = [];
  teamsRemoved = [];
  others = { catalog: false };
  world.slack.configTokens.add(TEARDOWN_CONFIG_TOKEN);
  server.use(
    ...repo.handlers(world.secrets.githubInstallationToken),
    ...jira.handlers(world.secrets.jiraToken),
    ...slackAppHandlers(world, slackApps, slackDeleted),
    ...teamsRemovalHandlers(world, teamsRemoved, others),
  );

  // The proof directory, as `pnpm onboard:proof --platform <platform>` makes it (the tarballs are not
  // used here). Its name does not start with the script's prefix, so a real --teardown never finds it.
  const root = await mkdtemp(join(tmpdir(), 'snapwing-proof-test-'));
  proof = await writeProofDir(root, {
    kind: 'snapwing-onboard-proof',
    version: 1,
    platform,
    createdAt: new Date().toISOString(),
    sandbox,
    tarballs: { pipeline: join(root, 'tarballs', 'pipeline.tgz'), app: join(root, 'tarballs', 'app.tgz') },
  });

  // The interview, with the script's scripted answers: the chat platforms and the sandbox names and ids.
  const answers = join(scratch, 'answers.json');
  await writeFile(answers, JSON.stringify({ ...ANSWERS, ...answersFor(sandbox, platform) }, null, 2));
  const out: string[] = [];
  const err: string[] = [];
  const keyboard = scriptedPrompter([]);
  interview = { out, asked: keyboard.asked };
  const code = await runOnboard(
    ['--answers', answers],
    {
      env: {
        ...dbEnv(),
        E2E_ANTHROPIC_KEY: world.secrets.anthropicKey,
        E2E_SLACK_CONFIG_TOKEN: world.secrets.slackConfigToken,
        E2E_SLACK_BOT_TOKEN: world.secrets.slackBotToken,
        E2E_SLACK_APP_TOKEN: world.secrets.slackAppToken,
        E2E_TEAMS_CLIENT_SECRET: world.secrets.teamsClientSecret,
        E2E_JIRA_TOKEN: world.secrets.jiraToken,
      },
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    },
    { cwd: proof.work, prompter: keyboard, steps: ONBOARD_STEPS.map((s) => (s.id === 'test-drive' ? standInDrive() : s)), openUrl: world.browser.openUrl },
  );
  expect(err).toEqual([]);
  expect(code, out.join('\n')).toBe(0);
  expect(keyboard.asked).toEqual([]);

  // What the sandboxes hold besides the run's: another engineer's pull request, an older issue,
  // another Slack app, and another Teams app in the team and the catalog.
  repo.open({ number: 3, author: OWNER.login, ref: 'pat/fix-typo' });
  jira.issues.set(`${PROJECT}-9`, { project: PROJECT, labels: [], summary: 'An older bug' });
  const created = world.slack.created[0]?.manifest;
  if (created === undefined) throw new Error('the interview created no Slack app');
  slackApps.set(world.slack.app.appId, created);
  slackApps.set('A0OTHERAPP', { display_information: { name: 'Other app' } });
  world.teams.installed.push({ id: 'inst-other', teamsApp: { id: 'cat-other', externalId: OTHER_BOT, displayName: 'Other bot' } });
  others.catalog = true;
}

async function closeRun(): Promise<void> {
  await world.remove();
  server.resetHandlers();
  await tdb.drop();
  await rm(scratch, { recursive: true, force: true });
  await rm(proof.root, { recursive: true, force: true });
}

function deps(prompter: Prompter, lines: string[]): ProofDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    say: (line) => lines.push(line),
    prompter,
    now: () => new Date(),
    sleep: () => Promise.resolve(),
    stateEnv: dbEnv(),
    configCheck: async (p) => {
      const out: string[] = [];
      const code = await runConfig(
        ['check', '--map', join(p.work, 'workspace-context.xml'), '--playbook', join(p.work, 'playbook.xml'), '--instructions', join(p.work, 'INSTRUCTIONS.md')],
        { env: {}, stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
      );
      return { code, output: out.join('\n') };
    },
  };
}

/** The proof directory again, as a proof of another platform. */
async function asPlatform(platform: 'slack' | 'teams' | 'both'): Promise<ProofDir> {
  const marker = { ...proof.marker, platform };
  await writeFile(join(proof.root, 'proof.json'), JSON.stringify(marker));
  return readProofDir(proof.root);
}

/** Every fake secret, and where one could slip into the script's output. */
function expectNoSecrets(lines: readonly string[], extra: readonly string[] = []): void {
  const text = lines.join('\n');
  const fakes = { ...world.secrets, githubPrivateKey: world.secrets.githubPrivateKey.split('\n')[1] ?? '', teardownConfigToken: TEARDOWN_CONFIG_TOKEN, ownerToken: world.teamsIds.ownerToken };
  for (const [what, value] of [...Object.entries(fakes), ...extra.map((v, i) => [`extra ${i}`, v] as const)]) {
    expect(value.length, what).toBeGreaterThan(5);
    expect(text.includes(value), `${what} in the output`).toBe(false);
  }
}

const verdicts = (lines: readonly string[]): string[] => lines.filter((l) => /^(PASS|FAIL) {2}/.test(l)).map((l) => l.replace(/: .*$/, ''));

// ---- The checks ------------------------------------------------------------------------------------

describe('onboard:proof checks', () => {
  beforeEach(() => proofRun('both'), 120_000);
  afterEach(closeRun);

  it('passes every item after the interview, names the platforms each proof checks, and fails an item the sandbox lacks', async () => {
    const lines: string[] = [];
    const both = await runChecks(proof, deps(NOBODY, lines));
    expect(both.filter((l) => !l.ok)).toEqual([]);
    expect(verdicts(lines)).toEqual([
      'PASS  map and config validate',
      'PASS  snapwing config check passes',
      "PASS  the test drive's PR exists on the sandbox repository",
      "PASS  the test drive's PR exists on the sandbox repository",
      'PASS  the Jira fields exist on the sandbox site',
      'PASS  the Slack app exists',
      'PASS  the Teams install exists',
    ]);
    expect(lines).toContain(`PASS  the test drive's PR exists on the sandbox repository: Slack: ${REPO}#1 (open)`);
    expect(lines).toContain(`PASS  the test drive's PR exists on the sandbox repository: Teams: ${REPO}#2 (open)`);
    expect(lines).toContain(`PASS  the Slack app exists: app ${world.slack.app.appId}, installed in Acme`);
    expect(lines.find((l) => l.startsWith('PASS  the Teams install exists'))).toContain(`${TEAM_NAME}, reduced mode`);
    expect(lines.at(-1)).toBe('All 7 checks passed.');

    // The phase 5 proof is Slack only: no Teams pull request or install is checked.
    const slackLines: string[] = [];
    await runChecks(await asPlatform('slack'), deps(NOBODY, slackLines));
    expect(verdicts(slackLines)).toEqual([
      'PASS  map and config validate',
      'PASS  snapwing config check passes',
      "PASS  the test drive's PR exists on the sandbox repository",
      'PASS  the Jira fields exist on the sandbox site',
      'PASS  the Slack app exists',
    ]);

    // The sandboxes lose what the run made: each check says what is missing.
    repo.pulls.delete(1);
    world.jira.fields = world.jira.fields.filter((f) => f.name !== 'Agent Status');
    world.slack.botTokens.clear();
    world.teams.installed = world.teams.installed.filter((a) => a['id'] !== 'inst-1');
    const failed: string[] = [];
    const after = await runChecks(await asPlatform('both'), deps(NOBODY, failed));
    expect(after.map((l) => l.ok)).toEqual([true, true, false, true, false, false, false]);
    expect(failed).toContain(`FAIL  the test drive's PR exists on the sandbox repository: GitHub answered 404 for ${REPO}#1`);
    expect(failed).toContain('FAIL  the Jira fields exist on the sandbox site: acme-demo.atlassian.net has no Agent Status');
    expect(failed).toContain(`FAIL  the Slack app exists: Slack refused the bot token of app ${world.slack.app.appId}`);
    expect(failed).toContain(`FAIL  the Teams install exists: the app is not installed in ${TEAM_NAME}`);
    expect(failed.at(-1)).toBe('4 of 7 checks failed.');

    // A run that went somewhere other than the sandbox fails, whatever it holds.
    await writeFile(join(proof.root, 'proof.json'), JSON.stringify({ ...proof.marker, sandbox: { ...SANDBOX, jiraSite: 'acme-prod.atlassian.net', githubRepo: 'web', slackWorkspace: 'Acme Prod' } }));
    const elsewhere: string[] = [];
    await runChecks(await readProofDir(proof.root), deps(NOBODY, elsewhere));
    expect(elsewhere).toContain(`FAIL  the test drive's PR exists on the sandbox repository: the pull request is on ${REPO}, not the sandbox repository acme/web`);
    expect(elsewhere).toContain('FAIL  the Jira fields exist on the sandbox site: the run connected acme-demo.atlassian.net, not the sandbox site acme-prod.atlassian.net');

    expectNoSecrets([...lines, ...slackLines, ...failed, ...elsewhere]);
    expect(world.unhandled).toEqual([]);
  }, 120_000);
});

// ---- The phase 5 proof: Slack only -----------------------------------------------------------------

describe('onboard:proof --platform slack', () => {
  beforeEach(() => proofRun('slack'), 120_000);
  afterEach(closeRun);

  it('leaves Teams out without asking: no Teams question is reached, the Slack checks pass, and the teardown has nothing in Teams', async () => {
    // The scripted `teams.use` no skips the step before its first real question; nothing fell back to the keyboard.
    expect(interview.asked).toEqual([]);
    expect(interview.out).toContain('Leaving Teams out. Run `snapwing onboard --step teams` if your team starts using it.');
    const teamsQuestions = ["What is the bot's app (client) id?", 'What is your tenant id?', 'Paste the client secret.', 'What public https address does Teams reach Snapwing at?'];
    for (const q of teamsQuestions) expect(interview.out.some((l) => l.includes(q)), q).toBe(false);
    expect(interview.out.some((l) => l.includes('Does your team report bugs in Slack?'))).toBe(true);
    expect(world.teams.published).toBe(0);
    expect(world.teams.installed).toEqual([{ id: 'inst-other', teamsApp: { id: 'cat-other', externalId: OTHER_BOT, displayName: 'Other bot' } }]);

    const lines: string[] = [];
    const checks = await runChecks(proof, deps(NOBODY, lines));
    expect(checks.filter((l) => !l.ok)).toEqual([]);
    expect(verdicts(lines)).toEqual([
      'PASS  map and config validate',
      'PASS  snapwing config check passes',
      "PASS  the test drive's PR exists on the sandbox repository",
      'PASS  the Jira fields exist on the sandbox site',
      'PASS  the Slack app exists',
    ]);
    expect(lines).toContain(`PASS  the test drive's PR exists on the sandbox repository: Slack: ${REPO}#1 (open)`);

    // The teardown: the Slack drive's pull request, branch and issue, the Slack app, the directory; no Teams sign-in.
    const torn: string[] = [];
    expect(await runTeardown(proof, deps(scriptedPrompter([TEARDOWN_CONFIG_TOKEN]), torn), { yes: true })).toBe(0);
    expect(torn.filter((l) => l.startsWith('done  ')).map((l) => l.replace(/ \(.*$/, '').replace(proof.root, '<proof>'))).toEqual([
      `done  close pull request ${REPO}#1`,
      `done  delete branch snapwing/adm-1-readme-last-line on ${REPO}`,
      'done  delete Jira issue ADM-1 on acme-demo.atlassian.net',
      `done  delete the Slack app ${world.slack.app.appId}`,
      'done  delete the proof directory <proof>',
    ]);
    expect(torn.some((l) => /Teams/.test(l))).toBe(false);
    expect(world.teams.ownerSignIns).toBe(0);
    expect(teamsRemoved).toEqual([]);
    expectNoSecrets([...interview.out, ...lines, ...torn]);
    expect(world.unhandled).toEqual([]);
  }, 120_000);
});

// ---- The teardown ----------------------------------------------------------------------------------

describe('onboard:proof --teardown', () => {
  beforeEach(() => proofRun('both'), 120_000);
  afterEach(closeRun);

  it("lists every deletion and deletes nothing without a yes; then closes the run's pull requests, deletes their branches, the Jira issues, the Slack app, the Teams install and catalog entry, and the directory, and lists what only a person can remove", async () => {
    // Asked, and answered no: nothing is deleted.
    const declined: string[] = [];
    const prompter = scriptedPrompter([TEARDOWN_CONFIG_TOKEN, 'no']);
    expect(await runTeardown(proof, deps(prompter, declined), { yes: false })).toBe(1);
    expect(prompter.asked).toEqual([
      'Paste the configuration token (it will not show), or press Enter to delete the app by hand: ',
      'Go ahead with these 10 steps? Type yes to go on: ',
    ]);
    const listed = declined.slice(declined.indexOf(`Teardown of ${proof.root} will:`) + 1, declined.indexOf('Left alone:'));
    expect(listed).toEqual([
      `  1. close pull request ${REPO}#1 (opened by ${RUN_BOT})`,
      `  2. delete branch snapwing/adm-1-readme-last-line on ${REPO} (the head of #1)`,
      `  3. close pull request ${REPO}#2 (opened by ${RUN_BOT})`,
      `  4. delete branch snapwing/adm-2-readme-last-line on ${REPO} (the head of #2)`,
      '  5. delete Jira issue ADM-1 on acme-demo.atlassian.net (README.md is missing its last line (slack))',
      '  6. delete Jira issue ADM-2 on acme-demo.atlassian.net (README.md is missing its last line (teams))',
      `  7. delete the Slack app ${world.slack.app.appId} (Snapwing) with apps.manifest.delete`,
      `  8. remove the Teams app install inst-1 from ${TEAM_NAME}`,
      `  9. delete the Teams catalog entry cat-1 (Snapwing, the run's bot ${APP_ID})`,
      `  10. delete the proof directory ${proof.root} (the run's .env, state, map and config, and the packed CLI)`,
    ]);
    expect(declined.at(-1)).toBe('Nothing was deleted.');
    expect({ closed: repo.closed, refs: repo.deletedRefs, issues: jira.deleted, slack: slackDeleted, teams: teamsRemoved }).toEqual({ closed: [], refs: [], issues: [], slack: [], teams: [] });
    expect(existsSync(proof.root)).toBe(true);

    // With --yes: everything the run made goes, and nothing else.
    const lines: string[] = [];
    expect(await runTeardown(proof, deps(scriptedPrompter([TEARDOWN_CONFIG_TOKEN]), lines), { yes: true })).toBe(0);
    expect(repo.closed).toEqual([1, 2]);
    expect(repo.deletedRefs).toEqual(['snapwing/adm-1-readme-last-line', 'snapwing/adm-2-readme-last-line']);
    expect(repo.pulls.get(3)?.state).toBe('open');
    expect(repo.refs.has('pat/fix-typo')).toBe(true);
    expect(jira.deleted).toEqual(['ADM-1', 'ADM-2']);
    expect([...jira.issues.keys()]).toEqual([`${PROJECT}-9`]);
    expect(slackDeleted).toEqual([world.slack.app.appId]);
    expect([...slackApps.keys()]).toEqual(['A0OTHERAPP']);
    expect(teamsRemoved).toEqual(['install inst-1', 'catalog cat-1']);
    expect(world.teams.installed.map((a) => a['id'])).toEqual(['inst-other']);
    expect(existsSync(proof.root)).toBe(false);
    expect(lines.filter((l) => l.startsWith('done  '))).toHaveLength(10);
    // What only a person can remove: the GitHub App and the Teams bot registration.
    const byHand = lines.slice(lines.indexOf('Only you can remove these:') + 1, -1);
    expect(byHand).toEqual([
      '  - The GitHub App snapwing-acme: GitHub has no API to delete an App. Open https://github.com/organizations/acme/settings/apps/snapwing-acme, then Advanced, then Delete GitHub App.',
      `  - The Teams bot registration ${APP_ID}, if no later proof needs it: delete it in the Teams Developer Portal, https://dev.teams.microsoft.com/bots (Microsoft has no API for it without an Azure subscription).`,
    ]);
    expect(lines.at(-1)).toBe('Teardown finished.');
    expectNoSecrets([...declined, ...lines]);
    expect(world.unhandled).toEqual([]);
  }, 120_000);

  it('leaves alone what it cannot attribute to the run, keeps the Slack app for a person when no token is given, and keeps the directory when a deletion fails', async () => {
    // Another engineer's pull request recorded as the drive's, an issue without the run's label, and
    // a Jira site that refuses one deletion.
    repo.pulls.set(2, { number: 2, state: 'open', author: OWNER.login, ref: 'pat/other-work' });
    repo.refs.add('pat/other-work');
    const adm1 = jira.issues.get(`${PROJECT}-1`);
    if (adm1 !== undefined) adm1.labels = [];
    server.use(http.delete(`${JIRA_BASE}/rest/api/3/issue/:key`, () => new HttpResponse(null, { status: 403 })));

    const lines: string[] = [];
    expect(await runTeardown(proof, deps(scriptedPrompter(['']), lines), { yes: true })).toBe(1);
    expect(lines.slice(lines.indexOf('Left alone:') + 1, lines.indexOf('Left alone:') + 3)).toEqual([
      `  - ${REPO}#2: opened by ${OWNER.login}, not this run's App ${RUN_BOT}.`,
      "  - The Snapwing fields on acme-demo.atlassian.net (Implementation Prompt, Conversation Link, Autonomy Level, Agent Status): the next proof reuses them, so they stay.",
    ]);
    expect(lines).toContain(`  - Jira issue ${PROJECT}-1: it does not carry the run's label ${incidentLabel('01JPR00FDR1VE00000000001')} in a project the run connected.`);
    expect(repo.closed).toEqual([1]);
    expect(repo.pulls.get(2)?.state).toBe('open');
    expect(repo.refs.has('pat/other-work')).toBe(true);
    expect(jira.issues.has(`${PROJECT}-1`)).toBe(true);
    expect(lines).toContain('FAIL  delete Jira issue ADM-2 on acme-demo.atlassian.net (README.md is missing its last line (teams)): Jira answered 403 (the account needs the Delete Issues permission)');
    // No token: the Slack app is for a person to delete.
    expect(slackDeleted).toEqual([]);
    expect(lines).toContain(`  - The Slack app ${world.slack.app.appId}: open https://api.slack.com/apps/${world.slack.app.appId}/general and choose Delete App.`);
    // A deletion failed: the directory stays, so a rerun can read its ids.
    expect(existsSync(proof.root)).toBe(true);
    expect(lines).toContain(`kept ${proof.root}: a deletion failed, and a rerun of --teardown reads its ids from there`);
    expect(lines.at(-1)).toBe('Teardown finished with 1 failed deletion.');
    expectNoSecrets(lines);
  }, 120_000);
});

// ---- The sandbox values and the command line -------------------------------------------------------

describe('onboard:proof sandbox values', () => {
  const values = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));
  const SLACK_VALUES = { JIRA_SITE: 'acme-sandbox', JIRA_PROJECT: 'SBX', GITHUB_OWNER: 'acme', GITHUB_REPO: 'sandbox-web', SLACK_WORKSPACE: 'Acme Sandbox' };

  it('reads the Slack proof from names and ids, and hands them to the interview as answers, with Teams left out', () => {
    const { sandbox, problems } = sandboxFrom(values(SLACK_VALUES), 'slack');
    expect(problems).toEqual([]);
    expect(sandbox).toEqual({ jiraSite: 'acme-sandbox.atlassian.net', jiraProject: 'SBX', githubOwner: 'acme', githubRepo: 'sandbox-web', slackWorkspace: 'Acme Sandbox' });
    expect(answersFor(sandbox as Sandbox, 'slack')).toEqual({
      'slack.use': 'yes',
      'teams.use': 'no',
      'jira.site': 'acme-sandbox.atlassian.net',
      'jira.projects': 'SBX',
      'github.owner': 'acme',
    });
    expect(siteHost('https://Acme-Sandbox.atlassian.net/jira/your-work')).toBe('acme-sandbox.atlassian.net');
    expect(parsePullUrl('https://github.com/acme/sandbox-web/pull/12')).toEqual({ repo: 'acme/sandbox-web', number: 12 });
    expect(parsePullUrl('https://github.com/acme/sandbox-web/issues/12')).toBeUndefined();
  });

  it('stops teams and both with a clear message while the Teams sandbox values are absent', () => {
    for (const platform of ['teams', 'both'] as const) {
      const { sandbox, problems } = sandboxFrom(values(SLACK_VALUES), platform);
      expect(sandbox).toBeUndefined();
      expect(problems).toEqual([
        `--platform ${platform} needs the Teams sandbox, and .env.onboard has no TEAMS_TENANT_ID, TEAMS_APP_ID, TEAMS_TEAM. There is no live Teams tenant in this build: run the proof with --platform slack, or add the Teams sandbox's values first.`,
      ]);
    }
    const withTeams = sandboxFrom(values({ ...SLACK_VALUES, TEAMS_TENANT_ID: TENANT, TEAMS_APP_ID: APP_ID, TEAMS_TEAM: TEAM_NAME }), 'both');
    expect(withTeams.problems).toEqual([]);
    expect(withTeams.sandbox?.teams).toEqual({ tenantId: TENANT, appId: APP_ID, team: TEAM_NAME });
    expect(answersFor(withTeams.sandbox as Sandbox, 'both')).toMatchObject({ 'slack.use': 'yes', 'teams.use': 'yes', 'teams.app-id': APP_ID, 'teams.tenant-id': TENANT });
    const teamsOnly = sandboxFrom(values({ ...SLACK_VALUES, TEAMS_TENANT_ID: TENANT, TEAMS_APP_ID: APP_ID, TEAMS_TEAM: TEAM_NAME }), 'teams');
    expect(teamsOnly.sandbox?.slackWorkspace).toBeUndefined();
    expect(answersFor(teamsOnly.sandbox as Sandbox, 'teams')).toMatchObject({ 'slack.use': 'no', 'teams.use': 'yes', 'teams.app-id': APP_ID });
  });

  it('refuses a missing file, missing keys, malformed values, and anything shaped like a secret', () => {
    expect(sandboxFrom(undefined, 'slack').problems).toEqual([
      '.env.onboard was not found at the repository root. Create it with the sandbox names and ids listed in the header of scripts/onboard-proof.ts.',
    ]);
    expect(sandboxFrom(values({ JIRA_SITE: 'jira.acme.example', GITHUB_OWNER: 'acme', SLACK_WORKSPACE: 'xoxb-1-not-a-name' }), 'slack').problems).toEqual([
      '.env.onboard is missing JIRA_PROJECT, GITHUB_REPO (see the header of scripts/onboard-proof.ts).',
      '.env.onboard: SLACK_WORKSPACE looks like a secret. The file holds names and ids only; paste tokens into the interview instead.',
      '.env.onboard: JIRA_SITE should be a Jira Cloud site, such as acme-sandbox.atlassian.net.',
    ]);
  });

  it("gives the interview none of the shell's tokens or Snapwing and npm settings", () => {
    const env = proofEnv('/tmp/proof', {
      PATH: '/usr/bin',
      HOME: '/home/maintainer',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.example:3128',
      SLACK_BOT_TOKEN: 'xoxb-from-the-shell',
      JIRA_API_TOKEN: 'from-the-shell',
      ANTHROPIC_API_KEY: 'sk-ant-from-the-shell',
      SNAPWING_DB: 'postgres',
      DATABASE_URL: 'postgres://elsewhere',
      npm_config_registry: 'https://registry.example',
      NODE_OPTIONS: '--require something',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/maintainer',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.example:3128',
      npm_config_cache: join('/tmp/proof', 'npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_loglevel: 'error',
    });
  });

  it('finds only directories the script marked: the newest one for --check and --teardown without --dir', async () => {
    const base = await mkdtemp(join(tmpdir(), 'snapwing-onboard-proof-base-'));
    try {
      const marker = { kind: 'snapwing-onboard-proof', version: 1, platform: 'slack', createdAt: '2026-10-08T00:00:00.000Z', sandbox: SANDBOX, tarballs: { pipeline: 'p.tgz', app: 'a.tgz' } } as const;
      const older = await writeProofDir(join(base, `${PROOF_DIR_PREFIX}older`), marker);
      await new Promise((r) => setTimeout(r, 20));
      const newer = await writeProofDir(join(base, `${PROOF_DIR_PREFIX}newer`), marker);
      await new Promise((r) => setTimeout(r, 20));
      // Newer still, but not the script's: no marker, or not its prefix.
      await writeFile(join(base, `${PROOF_DIR_PREFIX}unmarked`), '');
      const foreign = join(base, 'other-proof');
      await writeProofDir(foreign, marker);
      expect(await newestProofDir(base)).toBe(newer.root);
      expect((await readProofDir(older.root)).marker.platform).toBe('slack');
      await writeFile(join(older.root, 'proof.json'), JSON.stringify({ kind: 'something-else' }));
      await expect(readProofDir(older.root)).rejects.toThrow(/is not a proof directory/);
      await expect(readProofDir(join(base, 'missing'))).rejects.toThrow(/no readable proof.json/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('prints the usage for --help, and the Teams failure for --platform teams before packing anything', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(['--help'], { out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(0);
    expect(out).toEqual([USAGE]);

    const dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-proof-env-'));
    try {
      const file = join(dir, '.env.onboard');
      await writeFile(file, Object.entries(SLACK_VALUES).map(([k, v]) => `${k}=${v}`).join('\n'));
      const teams: string[] = [];
      expect(await main(['--platform', 'teams'], { onboardEnvPath: file, out: (l) => teams.push(l), err: (l) => teams.push(l) })).toBe(1);
      expect(teams).toEqual([
        "onboard:proof: --platform teams needs the Teams sandbox, and .env.onboard has no TEAMS_TENANT_ID, TEAMS_APP_ID, TEAMS_TEAM. There is no live Teams tenant in this build: run the proof with --platform slack, or add the Teams sandbox's values first.",
      ]);
      const bad: string[] = [];
      expect(await main(['--platform', 'chat'], { out: (l) => bad.push(l), err: (l) => bad.push(l) })).toBe(1);
      expect(bad[0]).toContain('--platform must be slack, teams, or both');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
