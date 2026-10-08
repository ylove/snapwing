// The four empty sandboxes the whole paste-path interview runs against: a Slack workspace with no app,
// a Teams tenant with no install, a Jira site with no Snapwing fields, and a GitHub account with no
// App, plus the model provider's key check. Each sandbox is the one its step's own contract test uses
// (slack.ts, teams.ts, jira.ts, github.ts, models.ts here), joined to the worlds the test drive needs
// once `snapwing serve` runs: the Slack Web API over the bug channel and the Teams Connector and Graph
// (../e2e/world.ts, ../e2e/teams.ts), Jira's issues and webhooks (the demo world, ../e2e/jira.ts),
// GitHub's pull requests over local bare repositories (../e2e/github.ts), and the recorded model of
// the level 1 demo.
//
// Every value is a fake and none looks like a real credential. `secrets` names each fake secret the
// installer pastes or a service hands out, so a test can feed them to `--answers` through the
// environment and look for every one of them where none may appear.

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import type { SetupServer } from 'msw/node';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel } from '@snapwing/pipeline/demo/run.ts';
import { manifestRscPermissions } from '../../../src/onboard/teams/install.ts';
import { TEAMS_DEFAULT_SERVICE_URL } from '../../../src/server/compose.ts';
import { FakeGitHub, INSTALLATION_TOKEN } from '../e2e/github.ts';
import { AGENT_ACCOUNT, JiraWebhooks, WORKFLOW } from '../e2e/jira.ts';
import { ACCESS_TOKEN, APP_ID, APP_PASSWORD, GRAPH, LOGIN, TEAM, TENANT, teamsWorld, type TeamsWorld } from '../e2e/teams.ts';
import { BOT_USER, DEMO_LEVELS, SIGNING_SECRET, SLACK_API, slackWorld, TEAM_ID, type SlackWorld } from '../e2e/world.ts';
import { slackSampleHandlers } from './drive.ts';
import { githubAccount, githubOnboardHandlers, githubRepoHandlers, installerBrowser, type GitHubAccount } from './github.ts';
import { jiraOnboardHandlers, jiraSite, type JiraSite } from './jira.ts';
import { modelKeyHandlers } from './models.ts';
import { slackDirectoryHandlers, slackOnboardHandlers, slackSandbox, type SlackSandbox } from './slack.ts';
import { CHANNEL_HISTORY_GRANT, teamsDirectoryHandlers, teamsOnboardHandlers, teamsTenant, type TeamsTenant, type TeamsTenantIds } from './teams.ts';

/** The one repository the installer gives the GitHub App, and the Jira project its bugs go to. */
export const REPO = 'acme/admin';
export const PROJECT = 'ADM';
/** The workspace's bug channel in Slack, and the team's in Teams. */
export const SLACK_CHANNEL = { id: 'C0ADMBUGS', name: 'admin-bugs' } as const;
export const TEAMS_CHANNEL = { id: '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2', name: 'Admin bugs' } as const;
export const TEAM_NAME = 'Acme Engineering';
/** The product's owner: in CODEOWNERS on GitHub, a member of the tenant on Teams; in Slack as `SLACK_INSTALLER`. */
export const OWNER = { login: 'pat-admin', email: 'pat@acme.test', aad: '6f1c2a3b-0000-4000-8000-00000000a0a1', name: 'Pat Admin' } as const;
/** The installer's Slack user, who reacts to the sample in the test drive. */
export const SLACK_INSTALLER = 'U0ADMDEV';
export const GITHUB_INSTALLATION_ID = 52017744;
export const GITHUB_APP_ID = 424242;
/** The `ts` Slack gives the bot's sample post in the test drive. */
export const SLACK_SAMPLE_TS = '1790900100.000100';

/** The level 1 demo recording: the admin repository's files and the model's answers. */
export const RECORDING = '02-level-1-fix-on-tap.json';

/** Each fake secret the installer pastes or a service hands out. */
export interface FakeSecrets {
  readonly anthropicKey: string;
  readonly slackConfigToken: string;
  readonly slackBotToken: string;
  readonly slackAppToken: string;
  readonly slackClientSecret: string;
  readonly slackSigningSecret: string;
  readonly teamsClientSecret: string;
  readonly teamsOwnerToken: string;
  readonly teamsAppToken: string;
  readonly jiraToken: string;
  readonly githubClientSecret: string;
  readonly githubPrivateKey: string;
  readonly githubInstallationToken: string;
}

export interface OnboardSandboxes {
  readonly slack: SlackSandbox;
  /** The Slack Web API the composed app calls over the bug channel, and its recorded messages. */
  readonly slackWorld: SlackWorld;
  readonly slackMessages: Record<string, unknown>[];
  /** The bot's sample posts in the test drive. */
  readonly slackSamples: Record<string, unknown>[];
  readonly teams: TeamsTenant;
  readonly teamsIds: TeamsTenantIds;
  readonly teamsWorld: TeamsWorld;
  readonly jira: JiraSite;
  readonly jiraWorld: JiraWorld;
  readonly jiraHooks: JiraWebhooks;
  readonly github: GitHubAccount;
  readonly fakeGitHub: FakeGitHub;
  readonly model: RecordedModel;
  /** The recording's model answers, for `model.use` once the drive's anchor is known. */
  readonly answers: Readonly<Record<string, unknown>>;
  readonly browser: ReturnType<typeof installerBrowser>;
  /** The fake secrets, by what they are; see the file header. */
  readonly secrets: FakeSecrets;
  /** Requests no handler answered (other than to 127.0.0.1); a test expects none. */
  readonly unhandled: string[];
  /** The team owner grants the channel history: the team leaves reduced mode. */
  grantChannelHistory(): void;
  remove(): Promise<void>;
}

/** The four empty sandboxes on `server`. `dir` holds the fake GitHub's pull requests and the fake agent's plans. */
export async function emptySandboxes(server: SetupServer, dir: string): Promise<OnboardSandboxes> {
  const recording = parseScenario(RECORDING, JSON.parse(await readFile(join(DEMO_LEVELS, RECORDING), 'utf8')));
  const repoFiles: Record<string, string> = { ...(recording.github[REPO] ?? {}), '.github/CODEOWNERS': `* @${OWNER.login}\n` };
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const secrets: FakeSecrets = {
    anthropicKey: 'sk-ant-e2e-sandbox-key-0042',
    slackConfigToken: 'xoxe-1-e2e-config-token-0042',
    // The composed app's Slack world (../e2e/world.ts) answers this bot token and this signing secret.
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-1-e2e-app-token-0042',
    slackClientSecret: 'e2e-slack-client-secret-0042',
    slackSigningSecret: SIGNING_SECRET,
    teamsClientSecret: APP_PASSWORD,
    teamsOwnerToken: 'e2e-teams-owner-token-0042',
    teamsAppToken: ACCESS_TOKEN,
    jiraToken: DEMO_JIRA_TOKEN,
    githubClientSecret: 'e2e-github-client-secret-0042',
    githubPrivateKey: privateKey,
    githubInstallationToken: INSTALLATION_TOKEN,
  };

  // ---- Slack: a workspace with no app ----------------------------------------------------------
  const slack = slackSandbox({
    configTokens: new Set([secrets.slackConfigToken]),
    botTokens: new Set([secrets.slackBotToken]),
    appTokens: new Set([secrets.slackAppToken]),
    oauthToken: secrets.slackBotToken,
    app: { appId: 'A0SNAPWING', clientId: '1111.2222', clientSecret: secrets.slackClientSecret, signingSecret: secrets.slackSigningSecret },
    bot: { userId: BOT_USER, teamId: TEAM_ID, team: 'Acme' },
    scopes: 'commands,app_mentions:read,chat:write,channels:history,channels:join,channels:read,groups:history,groups:read,reactions:read,reactions:write,users:read,users:read.email,files:read,im:history,im:write,pins:write',
    channels: [
      { id: SLACK_CHANNEL.id, name: SLACK_CHANNEL.name, is_private: false, is_member: false },
      { id: 'C0GENERAL', name: 'general', is_private: false, is_member: false },
    ],
    users: { [OWNER.email]: { id: SLACK_INSTALLER, name: OWNER.login } },
  });
  const slackMessages: Record<string, unknown>[] = [];
  const slackSamples: Record<string, unknown>[] = [];

  // ---- Teams: a tenant with no install -----------------------------------------------------------
  const teamsIds: TeamsTenantIds = { login: LOGIN, graph: GRAPH, tenantId: TENANT, appId: APP_ID, team: TEAM, appToken: secrets.teamsAppToken, ownerToken: secrets.teamsOwnerToken };
  const teams = teamsTenant({
    secrets: new Set([secrets.teamsClientSecret]),
    teams: [{ id: TEAM, displayName: TEAM_NAME }],
    channels: [
      { id: TEAMS_CHANNEL.id, displayName: TEAMS_CHANNEL.name },
      { id: '19:0a1b2c3d4e5f@thread.tacv2', displayName: 'General' },
    ],
    // The owner installs, but the team does not grant the channel history yet: reduced mode.
    grantOnInstall: manifestRscPermissions().filter((p) => p !== CHANNEL_HISTORY_GRANT),
    users: { [OWNER.email]: { id: OWNER.aad, displayName: OWNER.name } },
  });

  // ---- Jira: a site with no Snapwing fields ------------------------------------------------------
  const jira = jiraSite({
    logins: { [DEMO_JIRA_EMAIL]: { token: secrets.jiraToken, admin: true } },
    projects: [{ key: PROJECT, name: 'Admin Portal', style: 'classic' }],
    screens: [{ id: 1, name: `${PROJECT}: Scrum Default Issue Screen` }],
    screenFields: { 1: ['summary'] },
    statuses: WORKFLOW.map((s) => ({ name: s.name, category: s.category })),
    account: AGENT_ACCOUNT,
    // The demo world files its issues with these field ids, in the order the bootstrap creates them.
    nextFieldId: 10050,
  });
  const jiraWorld = new JiraWorld(() => undefined);
  const jiraHooks = new JiraWebhooks(jiraWorld);

  // ---- GitHub: an account with no App ------------------------------------------------------------
  const github = githubAccount({
    account: 'acme',
    repos: [REPO],
    slug: 'snapwing-acme',
    app: { id: GITHUB_APP_ID, clientId: 'Iv1.e2eclientid', clientSecret: secrets.githubClientSecret, pem: privateKey },
    installationId: GITHUB_INSTALLATION_ID,
    installationToken: secrets.githubInstallationToken,
    files: { [REPO]: repoFiles },
    users: { [OWNER.login]: OWNER.email },
  });
  const harnessDir = join(dir, 'harness');
  const fakeGitHub = new FakeGitHub(harnessDir);
  await fakeGitHub.addRepo(REPO, repoFiles);
  await mkdir(join(harnessDir, 'plans'), { recursive: true });
  await mkdir(join(harnessDir, 'gates'), { recursive: true });
  const searchWorld = new GitHubWorld(() => undefined);
  searchWorld.addRepos({ [REPO]: repoFiles });

  // ---- Wiring: the drive's worlds first, each sandbox's own handlers over them ------------------
  // A later `server.use` wins over an earlier one; within one call, the first handler that answers wins.
  const slackDrive = slackWorld(server, SLACK_CHANNEL.id, slackMessages, { members: [SLACK_INSTALLER] });
  const teamsDrive = teamsWorld(server, [], { channel: TEAMS_CHANNEL.id, members: [OWNER.aad], serviceUrl: TEAMS_DEFAULT_SERVICE_URL });
  server.use(...jiraHooks.handlers(), ...fakeGitHub.handlers(), ...jiraHandlers(jiraWorld), ...githubHandlers(searchWorld));
  server.use(
    ...slackSampleHandlers(SLACK_CHANNEL.id, slackMessages, slackSamples, { token: secrets.slackBotToken, ts: SLACK_SAMPLE_TS, reactor: SLACK_INSTALLER }),
    ...slackOnboardHandlers(SLACK_API, slack),
    ...slackDirectoryHandlers(SLACK_API, slack),
    ...teamsOnboardHandlers(teams, teamsIds),
    ...teamsDirectoryHandlers(teams, teamsIds),
    ...jiraOnboardHandlers(JIRA_BASE, jira),
    ...githubOnboardHandlers(github),
    ...githubRepoHandlers(github),
    ...modelKeyHandlers({ anthropic: secrets.anthropicKey }),
    // The demo Jira's search reads only a project clause; the projector finds an incident's issue by its label.
    http.post(`${JIRA_BASE}/rest/api/3/search/jql`, async ({ request }) => {
      const jql = String(((await request.clone().json()) as { jql?: unknown }).jql ?? '');
      const label = /labels\s*=\s*"([^"]+)"/.exec(jql)?.[1];
      if (label === undefined) return undefined;
      const issues = [...jiraWorld.issues.values()].filter((i) => i.labels.includes(label)).map((i) => ({ key: i.key, fields: { summary: i.summary, attachment: [] } }));
      return HttpResponse.json({ issues, isLast: true });
    }),
    // Graph validates nothing here: Snapwing's subscription is granted once the team grants the history.
    http.post(`${GRAPH}/subscriptions`, () =>
      teams.grants.includes(CHANNEL_HISTORY_GRANT) ? undefined : HttpResponse.json({ error: { code: 'Forbidden', message: 'RSC grant missing' } }, { status: 403 }),
    ),
  );

  const unhandled: string[] = [];
  server.events.on('request:unhandled', ({ request }) => {
    if (new URL(request.url).hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });

  const model = new RecordedModel();
  return {
    slack,
    slackWorld: slackDrive,
    slackMessages,
    slackSamples,
    teams,
    teamsIds,
    teamsWorld: teamsDrive,
    jira,
    jiraWorld,
    jiraHooks,
    github,
    fakeGitHub,
    model,
    answers: recording.model,
    browser: installerBrowser(github),
    secrets,
    unhandled,
    grantChannelHistory: () => {
      for (const p of manifestRscPermissions()) if (!teams.grants.includes(p)) teams.grants.push(p);
    },
    remove: async () => {
      server.events.removeAllListeners('request:unhandled');
      await fakeGitHub.remove();
    },
  };
}
