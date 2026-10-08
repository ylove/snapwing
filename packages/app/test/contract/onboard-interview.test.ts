// The whole paste-path interview as an installer scripts it: `snapwing onboard --answers <file>` with
// every real step, in registry order, against the four empty sandboxes on MSW (fixtures/onboard/): a
// Slack workspace with no app, a Teams tenant with no install, a Jira site with no Snapwing fields, and
// a GitHub account with no App. No keys and no network.
//
// The interview runs three times, as it would for a real install:
//   1. The installer answers up to GitHub and stops: Slack waits on its admin to approve the install,
//      Teams installs in reduced mode (the owner has not granted the channel history), Jira and GitHub
//      are set up. The run ends at the first question with no answer.
//   2. With the approval still pending, the run picks up at the products and finishes every step that
//      does not need the Slack bot. The test drive cannot start Snapwing without the bot token yet.
//   3. The admin has approved and the team owner has granted the history: Slack picks up at the
//      install, and the test drive starts `snapwing serve` and follows one sample bug on each platform
//      to an open pull request, the test playing the installer in Slack and Teams.
// Across the runs no step repeats a write, and no fake secret appears in the map, the config, the
// state document, stdout, or a log line. Runs on the dialect `SNAPWING_DB` selects.

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAppConfig, validateAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import { createGenericHarness } from '@snapwing/pipeline/harness/generic/index.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import { parseDotenv } from '@snapwing/pipeline/providers/local/secrets.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { EXIT_UNANSWERED, EXIT_WAITING, runOnboard } from '../../src/cli/onboard.ts';
import type { Prompter } from '../../src/cli/prompt.ts';
import { ONBOARDING_STATE_KEY, parseOnboardingState, type OnboardingState } from '../../src/onboard/interview/state.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { ONBOARD_STEPS } from '../../src/onboard/steps/index.ts';
import { createTestDriveStep, sampleBug } from '../../src/onboard/steps/test-drive.ts';
import { compose, REQUIRED_SECRETS, SLACK_SECRETS, TEAMS_DEFAULT_SERVICE_URL, TEAMS_SECRETS, type TeamsInject } from '../../src/server/compose.ts';
import { runServe } from '../../src/server/serve.ts';
import { cardOf, cardTap, graphMessage, messageChanged, TEAM, type TeamsPerson, type TeamsThread } from '../fixtures/e2e/teams.ts';
import { blockIds, BOT_USER, slackSigned, TEAM_ID, type SlackPostCall } from '../fixtures/e2e/world.ts';
import { pullState } from '../fixtures/onboard/drive.ts';
import {
  emptySandboxes,
  OWNER,
  PROJECT,
  REPO,
  SLACK_CHANNEL,
  SLACK_INSTALLER,
  SLACK_SAMPLE_TS,
  TEAM_NAME,
  TEAMS_CHANNEL,
  type OnboardSandboxes,
} from '../fixtures/onboard/sandboxes.ts';

const HARNESS = fileURLToPath(new URL('../fixtures/e2e/fake-harness.mjs', import.meta.url));
/** The repository's test command for the regression proof: every `test/*.test.sh` must pass. */
const TEST_COMMAND = 'for t in test/*.test.sh; do sh "$t" || exit 1; done';
const WAIT_MS = 45_000;
const SAMPLE = sampleBug(REPO);
/** The Graph id of the installer's own post of the sample in Teams. */
const TEAMS_POST = '1790900200000';
const TEAMS_OWNER: TeamsPerson = { aad: OWNER.aad, botId: '29:1pat-admin-teams-id', name: OWNER.name };
/** The fix the fake agent makes for each drive's ticket, and its regression test (fails before, passes after). */
const PLAN = {
  summary: 'append the usage rows to the CSV export',
  files: {
    'src/reports/csv-export.ts':
      "export function usageCsv(rows: UsageRow[]): string {\n  const header = 'account,seats,usage';\n  return [header, ...rows.map((r) => [r.account, r.seats, r.usage].join(','))].join('\\n');\n}\n",
    'test/csv-export.test.sh': "grep -q 'rows.map' src/reports/csv-export.ts\n",
  },
  test: 'test/csv-export.test.sh',
  reviewGate: false,
};
/** Nobody at the keyboard: a question the answers file does not answer ends the run there. */
const NOBODY: Prompter = { line: () => Promise.resolve(undefined), hidden: () => Promise.resolve(undefined) };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

let tdb: TestDatabase;
/** The installer's working directory, where `snapwing onboard` writes everything. */
let workdir: string;
/** Everything else: the answers files, the fake GitHub's pull requests, the fixer's checkouts. */
let scratch: string;
let world: OnboardSandboxes;

beforeEach(async () => {
  tdb = await createTestDatabase();
  workdir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-interview-'));
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-onboard-scratch-'));
  world = await emptySandboxes(server, scratch);
  for (const key of [`${PROJECT}-1`, `${PROJECT}-2`]) await writeFile(join(scratch, 'harness', 'plans', `${key}.json`), JSON.stringify(PLAN));
});

afterEach(async () => {
  reader = undefined;
  await world.remove();
  server.resetHandlers();
  await tdb.drop();
  await rm(workdir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

// The installer's runs ---------------------------------------------------------------------------

/** The environment `snapwing onboard` runs in: the state store, and the secrets the answers files read by name. */
function baseEnv(): Record<string, string> {
  const db: Record<string, string> =
    tdb.dialect === 'postgres' ? { SNAPWING_DB: 'postgres', DATABASE_URL: tdb.options.url ?? '' } : { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: tdb.options.url ?? '' };
  return {
    ...db,
    E2E_ANTHROPIC_KEY: world.secrets.anthropicKey,
    E2E_SLACK_CONFIG_TOKEN: world.secrets.slackConfigToken,
    E2E_SLACK_BOT_TOKEN: world.secrets.slackBotToken,
    E2E_SLACK_APP_TOKEN: world.secrets.slackAppToken,
    E2E_TEAMS_CLIENT_SECRET: world.secrets.teamsClientSecret,
    E2E_JIRA_TOKEN: world.secrets.jiraToken,
  };
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

interface Drive {
  /** Serve's base URL once the test drive has started it. */
  readonly url: Promise<string>;
  /** Hands an activity or Graph notifications to serve's Teams dispatcher. */
  inject(input: Parameters<TeamsInject>[0]): ReturnType<TeamsInject>;
  /** Every line serve wrote (its log), and its exit codes. */
  readonly log: string[];
  readonly exits: Promise<number>[];
  /** Ctrl-C while the drive waits: it stops serve and leaves the step to resume. */
  stop(): void;
}

/** The registry, with the test drive's serve on the sandboxes' model and git remotes and the fake agent. */
function stepsWithDrive(): { steps: readonly OnboardStep[]; drive: Drive } {
  let markUrl: (url: string) => void = () => undefined;
  const url = new Promise<string>((r) => (markUrl = r));
  let inject: TeamsInject | undefined;
  const log: string[] = [];
  const exits: Promise<number>[] = [];
  const interrupts = new EventEmitter();
  const fakeAgent = createGenericHarness({ command: `"${process.execPath}" "${HARNESS}" "${join(scratch, 'harness')}"`, timeout: 'PT2M' });
  const testDrive = createTestDriveStep({
    serve: (args, io, deps) => {
      const logged = { ...io, stdout: (l: string) => (log.push(l), io.stdout(l)), stderr: (l: string) => (log.push(l), io.stderr(l)) };
      const run = runServe(args, logged, { ...deps, onReady: (info) => (info.url === undefined ? undefined : markUrl(info.url), deps.onReady?.(info)) });
      exits.push(run);
      return run;
    },
    compose: (deps) =>
      compose({
        ...deps,
        overrides: {
          model: withValidation(world.model),
          projectorPollMs: 25,
          gitRemoteUrl: world.fakeGitHub.remoteUrl,
          resolveHarness: () => fakeAgent,
          teamsInject: (fn) => (inject = fn),
        },
      }),
    interrupts,
    pollMs: 25,
  });
  return {
    steps: ONBOARD_STEPS.map((s) => (s.id === 'test-drive' ? testDrive : s)),
    drive: {
      url,
      inject: (input) => {
        if (inject === undefined) throw new Error('compose did not hand over the Teams seam');
        return inject(input);
      },
      log,
      exits,
      stop: () => void interrupts.emit('SIGINT'),
    },
  };
}

let runs = 0;
/** `snapwing onboard --answers <file> ...args` in the working directory, nobody at the keyboard. */
async function onboard(
  answers: Record<string, unknown>,
  options: { env?: Record<string, string>; args?: readonly string[]; steps?: readonly OnboardStep[]; out?: string[] } = {},
): Promise<Run> {
  runs += 1;
  const file = join(scratch, `answers-${runs}.json`);
  await writeFile(file, JSON.stringify(answers, null, 2));
  const out: string[] = options.out ?? [];
  const err: string[] = [];
  const code = await runOnboard(['--answers', file, ...(options.args ?? [])], { env: { ...baseEnv(), ...options.env }, stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, {
    cwd: workdir,
    prompter: NOBODY,
    steps: options.steps ?? ONBOARD_STEPS,
    openUrl: world.browser.openUrl,
  });
  return { code, out, err };
}

let reader: StateStore | undefined;
/** The onboarding state document as the store holds it. */
async function stateDocument(): Promise<{ text: string; state: OnboardingState }> {
  if (reader === undefined) {
    const opened = await tdb.open();
    if (!(opened instanceof StateStore)) throw new Error('expected the StateStore');
    reader = opened;
  }
  const text = (await reader.kvGet(ONBOARDING_STATE_KEY)) ?? '';
  return { text, state: parseOnboardingState(text) };
}

const readEnv = async (): Promise<Map<string, string>> => parseDotenv(await readFile(join(workdir, '.env'), 'utf8'), '.env');

/** What each sandbox has been asked to write so far. */
function writes(): Record<string, unknown> {
  return {
    slackApps: world.slack.created.length,
    slackJoins: [...world.slack.joined],
    teamsPublished: world.teams.published,
    teamsInstalls: world.teams.installed.length,
    jira: [...world.jira.calls],
    githubApps: [...world.github.conversions],
    githubHooks: world.github.hookConfigs.length,
  };
}

// The installer in chat, while the test drive runs -------------------------------------------------

/** Waits for `find` to return something while the run is still going. */
async function until<T>(what: string, running: () => boolean, lines: readonly string[], find: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = await find();
    if (found !== undefined) return found;
    if (!running()) throw new Error(`the run ended before ${what} (${lines.join(' | ')})`);
    if (Date.now() > deadline) throw new Error(`no ${what} yet (${lines.join(' | ')})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function buttons(c: SlackPostCall, blockId: string): { action_id: string; value: string; text: { text: string } }[] {
  const blocks = c.body['blocks'] as { block_id?: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
  return blocks.find((b) => b.block_id === blockId)?.elements ?? [];
}

/** Jira's webhook for the In Progress transition the agent made on `issueKey`. */
async function deliverJira(url: string, issueKey: string, wait: <T>(what: string, find: () => T | undefined) => Promise<T>): Promise<void> {
  await wait(`the In Progress transition of ${issueKey}`, () => (world.jiraHooks.queued.some((q) => q.issueKey === issueKey) ? true : undefined));
  const statuses = await world.jiraHooks.deliver(issueKey, (body) => fetch(`${url}/webhooks/jira`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  expect(statuses.every((s) => s === 200)).toBe(true);
}

/**
 * The installer through both drives. On Slack: reacts to the bot's sample with the bug and taps Looks
 * right. On Teams: posts the sample, reacts to it, and taps Looks right. Jira reports each ticket In
 * Progress.
 */
async function playTestDrive(drive: Drive, running: () => boolean, lines: readonly string[]): Promise<void> {
  const wait = <T>(what: string, find: () => T | undefined): Promise<T> => until(what, running, lines, find);
  let started: string | undefined;
  void drive.url.then((u) => (started = u));
  const url = await wait('serve to start', () => started);
  await playSlackDrive(url, wait);
  await playTeamsDrive(drive, url, lines, wait);
}

/** The Slack drive: the installer reacts to the bot's sample with the bug and taps Looks right. */
async function playSlackDrive(url: string, wait: <T>(what: string, find: () => T | undefined) => Promise<T>): Promise<void> {
  world.model.use('test drive on Slack', { ...world.answers, segmentation: { included: [SLACK_SAMPLE_TS], excluded: [], resolutionMessageId: '' } });
  await wait('the sample post in Slack', () => world.slackSamples[0]);
  const reaction = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM_ID,
    api_app_id: world.slack.app.appId,
    event_id: 'Ev0ONBOARD1',
    event_time: Math.floor(Date.now() / 1000),
    event: { type: 'reaction_added', user: SLACK_INSTALLER, reaction: 'bug', item: { type: 'message', channel: SLACK_CHANNEL.id, ts: SLACK_SAMPLE_TS }, item_user: BOT_USER, event_ts: '1790900160.000200' },
  });
  expect((await fetch(`${url}/slack/events`, { method: 'POST', headers: slackSigned(reaction), body: reaction })).status).toBe(200);
  const scope = await wait('the scope card in Slack', () =>
    world.slackWorld.calls.filter((c) => c.method === 'chat.postMessage' && blockIds(c.body).includes('scope_actions')).at(-1),
  );
  const looksRight = buttons(scope, 'scope_actions').find((b) => b.action_id === 'looks-right');
  if (looksRight === undefined) throw new Error('no Looks right on the Slack scope card');
  const payload = {
    type: 'block_actions',
    user: { id: SLACK_INSTALLER },
    channel: { id: SLACK_CHANNEL.id },
    container: { type: 'message', channel_id: SLACK_CHANNEL.id, message_ts: scope.ts },
    message: { ts: scope.ts, thread_ts: SLACK_SAMPLE_TS, blocks: scope.body['blocks'] },
    actions: [{ action_id: 'looks-right', block_id: 'scope_actions', value: looksRight.value, text: { type: 'plain_text', text: looksRight.text.text } }],
  };
  const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  expect((await fetch(`${url}/slack/interactivity`, { method: 'POST', headers: slackSigned(form, 'application/x-www-form-urlencoded'), body: form })).status).toBe(200);
  await deliverJira(url, `${PROJECT}-1`, wait);
}

/** The Teams drive: the installer posts the sample, reacts to it, and taps Looks right. */
async function playTeamsDrive(drive: Drive, url: string, lines: readonly string[], wait: <T>(what: string, find: () => T | undefined) => Promise<T>): Promise<void> {
  await wait('the ask to post the sample in Teams', () => (lines.some((l) => l.includes('post this message as yourself')) ? true : undefined));
  world.model.use('test drive on Teams', { ...world.answers, segmentation: { included: [TEAMS_POST], excluded: [], resolutionMessageId: '' } });
  const at = new Date().toISOString();
  world.teamsWorld.messages.push(graphMessage(TEAMS_POST, at, SAMPLE, OWNER.aad));
  world.teamsWorld.react(TEAMS_POST, OWNER.aad, '🐛');
  await drive.inject({ notifications: [messageChanged(TEAM, TEAMS_CHANNEL.id, TEAMS_POST)] });
  const thread: TeamsThread = { channel: TEAMS_CHANNEL.id, anchor: TEAMS_POST, anchorAt: at };
  const card = await wait('the scope card in Teams', () =>
    world.teamsWorld.connector.find((c) => c.kind === 'reply' && (cardOf(c.body)?.actions ?? []).some((a) => a.verb === 'looks-right')),
  );
  expect(card.conversation).toBe(`${TEAMS_CHANNEL.id};messageid=${TEAMS_POST}`);
  const data = cardOf(card.body)?.actions?.find((a) => a.verb === 'looks-right')?.data ?? {};
  // Teams names the default Connector in what it sends; nothing set TEAMS_SERVICE_URL.
  const activity = { ...cardTap(thread, TEAMS_OWNER, card.activityId, 'looks-right', data), serviceUrl: TEAMS_DEFAULT_SERVICE_URL };
  expect(await drive.inject({ activity })).toMatchObject({ status: 200 });
  await deliverJira(url, `${PROJECT}-2`, wait);
}

// The answers ------------------------------------------------------------------------------------

/** Run 1: up to GitHub. Slack needs its admin's approval; nothing answers the products. */
const UP_TO_GITHUB = {
  'runtime.where': 'local',
  'runtime.anthropic-have': 'yes',
  'runtime.anthropic-key': { env: 'E2E_ANTHROPIC_KEY' },
  'runtime.openai-have': 'no',
  'runtime.google-have': 'no',
  'runtime.public-url': 'no',
  'slack.use': 'yes',
  'slack.config-token': { env: 'E2E_SLACK_CONFIG_TOKEN' },
  'slack.install': 'approval',
  'teams.use': 'yes',
  'teams.app-id': '00000000-0000-4000-8000-0000000000b0',
  'teams.tenant-id': '7a0d5e6f-0000-4000-8000-0000000000c1',
  'teams.client-secret': { env: 'E2E_TEAMS_CLIENT_SECRET' },
  'teams.public-url': 'https://snapwing-e2e.example.test',
  'teams.channels': TEAMS_CHANNEL.name,
  'jira.site': 'acme-demo',
  'jira.email': 'demo-bot@example.com',
  'jira.token': { env: 'E2E_JIRA_TOKEN' },
  'jira.projects': PROJECT,
  'github.owner-type': 'org',
  'github.owner': 'acme',
  'github.name': '',
};

/** Run 2: the approval is still pending; the products to the map, and the test drive's first questions. */
const WITHOUT_SLACK = {
  'slack.install': 'approval',
  'surfaces.confirm': 'yes',
  'words.more': 'usage export',
  'people.owners': 'keep',
  'people.backups': '',
  'trigger.emoji': '',
  'trigger.more': 'done',
  'autonomy.level': '',
  'autonomy.by': OWNER.email,
  'finish.token': 'none',
  'test-drive.level': 'lift',
  'test-drive.teams-channel': TEAMS_CHANNEL.id,
};

/** Run 3: approved; Slack's tokens and channels, and the test drive on both platforms. */
const APPROVED = {
  'slack.install': 'installed',
  'slack.bot-token': { env: 'E2E_SLACK_BOT_TOKEN' },
  'slack.app-token': { env: 'E2E_SLACK_APP_TOKEN' },
  'slack.channels': SLACK_CHANNEL.name,
  'slack.private': 'no',
  'test-drive.level': 'lift',
  'test-drive.slack-channel': SLACK_CHANNEL.id,
  'test-drive.teams-channel': TEAMS_CHANNEL.id,
};

const status = (state: OnboardingState): Record<string, string | undefined> => Object.fromEntries(ONBOARD_STEPS.map((s) => [s.id, state.steps[s.id]?.status]));

// The interview -----------------------------------------------------------------------------------

describe('snapwing onboard --answers: the whole interview on empty sandboxes', () => {
  it('stops after GitHub, resumes without repeating a write, carries on while Slack waits for approval, reports Teams reduced mode, and ends with a valid map, config, .env, and a passing test drive', async () => {
    // ---- 1. Up to GitHub, then abandoned at the products ------------------------------------------
    const first = await onboard(UP_TO_GITHUB);
    expect(first.err).toEqual([]);
    expect(first.code, first.out.join('\n')).toBe(EXIT_UNANSWERED);
    expect(first.out).toContain('Stopped at Name your products; nothing you answered is lost. Run `snapwing onboard` again to pick up there.');
    let { state } = await stateDocument();
    expect(status(state)).toEqual({
      runtime: 'done',
      slack: 'blocked',
      teams: 'done',
      jira: 'done',
      github: 'done',
      surfaces: 'running',
      words: undefined,
      people: undefined,
      trigger: undefined,
      autonomy: undefined,
      finish: undefined,
      'test-drive': undefined,
    });
    // Slack waits on its admin, with the request link.
    expect(state.steps['slack']?.blocked).toMatchObject({ on: 'a Slack workspace admin', link: `https://api.slack.com/apps/${world.slack.app.appId}/install-on-team` });
    expect(first.out.join('\n')).toContain('Click "Request to install"');
    // Teams is installed in reduced mode, and the installer is told what the owner still has to approve.
    expect(state.steps['teams']?.data).toMatchObject({ mode: 'reduced', teams: [{ id: TEAM, name: TEAM_NAME, mode: 'reduced' }] });
    expect(first.out.find((l) => l.startsWith(`${TEAM_NAME}: reduced mode.`))).toMatch(/A team owner has to approve Snapwing reading channel messages/);
    // Jira got its fields; GitHub its App, installed on the repository.
    expect(world.jira.calls.filter((c) => c.startsWith('create-field'))).toEqual([
      'create-field Implementation Prompt',
      'create-field Conversation Link',
      'create-field Autonomy Level',
      'create-field Agent Status',
    ]);
    expect(state.steps['github']?.data).toMatchObject({ owner: 'acme', ownerType: 'org', installationId: '52017744', repos: [REPO] });
    // No public address (the runtime step left http://localhost): the App's webhook is the inactive placeholder.
    expect(world.github.manifests[0]?.['hook_attributes']).toEqual({ url: 'https://example.invalid/snapwing/webhooks/github', active: false });
    expect(world.github.hookConfigs).toEqual([]);
    expect(world.browser.errors).toEqual([]);
    const afterFirst = { writes: writes(), env: await readEnv() };

    // ---- 2. Resumed while the Slack approval is still pending -------------------------------------
    const blocked = stepsWithDrive();
    const second = await onboard(WITHOUT_SLACK, { steps: blocked.steps });
    expect(second.err).toEqual([]);
    expect(second.code, second.out.join('\n')).toBe(EXIT_WAITING);
    expect(second.out).toContain('Picking up where you left off: Name your products.');
    ({ state } = await stateDocument());
    // Everything from Jira to the owners is done, and so is the map; Slack still waits.
    expect(status(state)).toMatchObject({ slack: 'blocked', jira: 'done', github: 'done', surfaces: 'done', words: 'done', people: 'done', trigger: 'done', autonomy: 'done', finish: 'done' });
    // The test drive cannot start Snapwing without the Slack bot, and says which step sets it.
    expect(state.steps['test-drive']?.status).toBe('blocked');
    expect(state.steps['test-drive']?.blocked?.reason).toContain('SLACK_BOT_TOKEN');
    // Nothing written in the first run was written again.
    expect(writes()).toEqual(afterFirst.writes);
    const envAfterSecond = await readEnv();
    for (const [key, value] of afterFirst.env) expect(envAfterSecond.get(key), key).toBe(value);

    // ---- 3. Approved: Slack picks up at the install, and the test drive runs -----------------------
    world.grantChannelHistory();
    const { steps, drive } = stepsWithDrive();
    let running = true;
    const lines: string[] = [];
    const playing = playTestDrive(drive, () => running, lines).then(
      () => undefined,
      (e: unknown) => (drive.stop(), e),
    );
    // Serve on a free local port; Slack's events come over HTTP (the sandbox serves no Socket Mode WebSocket).
    const third = await onboard(APPROVED, {
      steps,
      out: lines,
      env: { PORT: '0', HOST: '127.0.0.1', SNAPWING_SLACK_TRANSPORT: 'http', SNAPWING_WORKDIR_ROOT: join(scratch, 'work'), SNAPWING_TEST_COMMAND: TEST_COMMAND },
    }).finally(() => (running = false));
    const failure = await playing;
    if (failure !== undefined) throw failure;
    expect(third.err).toEqual([]);
    expect(third.code, third.out.join('\n')).toBe(0);
    expect(third.out).toContain('The Slack app is already created; I will pick up at the install.');
    expect(third.out.some((l) => l.includes('app configuration token'))).toBe(false);
    expect(third.out).toContain('Onboarding is finished.');
    ({ state } = await stateDocument());
    expect(Object.values(status(state)).every((s) => s === 'done')).toBe(true);
    // Each step ran once, but Slack (blocked twice), the products (resumed), and the test drive (blocked once).
    expect(Object.fromEntries(ONBOARD_STEPS.map((s) => [s.id, state.steps[s.id]?.attempts]))).toEqual({
      runtime: 1,
      slack: 3,
      teams: 1,
      jira: 1,
      github: 1,
      surfaces: 2,
      words: 1,
      people: 1,
      trigger: 1,
      autonomy: 1,
      finish: 1,
      'test-drive': 2,
    });

    // No step repeated a write: one Slack app, one Teams publish and install, each Jira field and screen
    // placement once, one GitHub App; and no .env value written earlier changed.
    expect(writes()).toEqual({ ...afterFirst.writes, slackJoins: [SLACK_CHANNEL.name] });
    const env = await readEnv();
    for (const [key, value] of afterFirst.env) expect(env.get(key), key).toBe(value);

    // The test drive passed on both platforms, each with its own pull request.
    const driven = state.steps['test-drive']?.data;
    expect(driven).toMatchObject({ repo: REPO, surface: 'admin', level: 2, lifted: true });
    expect(driven?.['drives']).toEqual([
      { platform: 'slack', channel: SLACK_CHANNEL.id, channelName: SLACK_CHANNEL.name, incident: expect.any(String), jiraKey: `${PROJECT}-1`, pr: `https://github.com/${REPO}/pull/1` },
      { platform: 'teams', channel: TEAMS_CHANNEL.id, channelName: TEAMS_CHANNEL.name, incident: expect.any(String), jiraKey: `${PROJECT}-2`, pr: `https://github.com/${REPO}/pull/2` },
    ]);
    expect(await pullState(REPO, 1, world.secrets.githubInstallationToken)).toBe('open');
    expect(await pullState(REPO, 2, world.secrets.githubInstallationToken)).toBe('open');
    expect(await Promise.all(drive.exits)).toEqual([0]);
    // Serve read the working directory's playbook and instructions, the ones the map step checked.
    expect(drive.log).toContain(`snapwing serve: watching ${join(workdir, 'playbook.xml')} and ${join(workdir, 'INSTRUCTIONS.md')}`);

    // ---- The map, the config, and .env --------------------------------------------------------------
    const mapXml = await readFile(join(workdir, 'workspace-context.xml'), 'utf8');
    const map = await parseWorkspaceMap(mapXml);
    expect(map.surfaces).toEqual([
      { id: 'admin', label: 'Admin Portal', repo: `github.com/${REPO}`, jira: { project: PROJECT, defaultIssueType: 'Bug' }, components: [] },
    ]);
    // Slack was approved after the products and owners were confirmed, so the written map has neither its
    // channel nor the owner's Slack account until those steps and the map run again; the drive put the
    // Slack channel on the product for itself.
    expect(map.channels).toEqual([
      expect.objectContaining({ id: TEAMS_CHANNEL.id, name: TEAMS_CHANNEL.name, surface: 'admin', platform: 'teams', teamId: TEAM }),
    ]);
    expect(map.people).toEqual([{ handle: OWNER.login, email: OWNER.email, teamsId: OWNER.aad, role: 'engineer', owns: [{ surface: 'admin', primary: true }] }]);
    expect(map.vocabulary).toEqual([{ text: 'usage export', surface: 'admin' }]);
    expect(map.triggers.emoji).toEqual([{ slack: 'bug', teams: 'bug' }]);
    expect(map.policies.autonomy).toMatchObject({ default: 1, changedBy: OWNER.email });
    const configXml = await readFile(join(workdir, 'snapwing.config.xml'), 'utf8');
    expect((await validateAppConfig(configXml)).valid).toBe(true);
    expect(loadAppConfig(configXml)).toMatchObject({ runtime: { provider: 'local' }, models: { defaultProvider: 'anthropic' } });
    expect((await stat(join(workdir, '.env'))).mode & 0o777).toBe(0o600);
    for (const key of [...REQUIRED_SECRETS, ...SLACK_SECRETS, ...TEAMS_SECRETS, 'SLACK_APP_TOKEN', 'TEAMS_PUBLIC_URL', 'ANTHROPIC_API_KEY']) expect(env.get(key), key).toBeTruthy();

    // ---- --status numbers every step by its place, the runtime 0 -----------------------------------
    const shown = await onboard({}, { args: ['--status'] });
    expect(shown.code).toBe(0);
    expect(shown.out[0]).toBe('Onboarding:');
    expect(shown.out.slice(1).map((l) => l.trim().split(/\s+/)[0])).toEqual(ONBOARD_STEPS.map((_, i) => String(i)));
    expect(shown.out.slice(1).every((l) => l.endsWith('  done'))).toBe(true);

    // ---- No fake secret anywhere it may not be --------------------------------------------------------
    const document = (await stateDocument()).text;
    expect(document).not.toContain('[secret]');
    const fakes: Record<string, string> = {
      ...world.secrets,
      // The PEM's first line of key material, not its header.
      githubPrivateKey: world.secrets.githubPrivateKey.split('\n')[1] ?? '',
      encryptionKey: env.get('SNAPWING_ENCRYPTION_KEY') ?? '',
      fixerTokenSecret: env.get('SNAPWING_FIXER_TOKEN_SECRET') ?? '',
      githubWebhookSecret: env.get('GITHUB_WEBHOOK_SECRET') ?? '',
    };
    const places: Record<string, string> = {
      map: mapXml,
      config: configXml,
      'state document': document,
      stdout: [first, second, third, shown].flatMap((r) => [...r.out, ...r.err]).join('\n'),
      log: [...blocked.drive.log, ...drive.log].join('\n'),
    };
    for (const [what, value] of Object.entries(fakes)) {
      expect(value.length, what).toBeGreaterThan(5);
      for (const [where, text] of Object.entries(places)) expect(text.includes(value), `${what} in the ${where}`).toBe(false);
    }

    expect(world.browser.errors).toEqual([]);
    expect(world.slackWorld.unknown).toEqual([]);
    expect(world.teamsWorld.unknown).toEqual([]);
    expect(world.unhandled).toEqual([]);
  }, 240_000);
});

// A team that reports bugs in Slack only ----------------------------------------------------------

/** One run, Slack approved at once, Teams left out: every question the interview asks, answered. */
const SLACK_ONLY = {
  'runtime.where': 'local',
  'runtime.anthropic-have': 'yes',
  'runtime.anthropic-key': { env: 'E2E_ANTHROPIC_KEY' },
  'runtime.openai-have': 'no',
  'runtime.google-have': 'no',
  'runtime.public-url': 'no',
  'slack.use': 'yes',
  'slack.config-token': { env: 'E2E_SLACK_CONFIG_TOKEN' },
  'slack.install': 'installed',
  'slack.bot-token': { env: 'E2E_SLACK_BOT_TOKEN' },
  'slack.app-token': { env: 'E2E_SLACK_APP_TOKEN' },
  'slack.channels': SLACK_CHANNEL.name,
  'slack.private': 'no',
  'teams.use': 'no',
  'jira.site': 'acme-demo',
  'jira.email': 'demo-bot@example.com',
  'jira.token': { env: 'E2E_JIRA_TOKEN' },
  'jira.projects': PROJECT,
  'github.owner-type': 'org',
  'github.owner': 'acme',
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
  'test-drive.level': 'lift',
  'test-drive.slack-channel': SLACK_CHANNEL.id,
};

describe('snapwing onboard --answers: a team that leaves a chat platform out', () => {
  it('skips Teams, and ends with a valid Slack-only map and a passing test drive', async () => {
    const { steps, drive } = stepsWithDrive();
    let running = true;
    const lines: string[] = [];
    const playing = (async (): Promise<unknown> => {
      try {
        const wait = <T>(what: string, find: () => T | undefined): Promise<T> => until(what, () => running, lines, find);
        let started: string | undefined;
        void drive.url.then((u) => (started = u));
        const url = await wait('serve to start', () => started);
        world.model.use('test drive on Slack', { ...world.answers, segmentation: { included: [SLACK_SAMPLE_TS], excluded: [], resolutionMessageId: '' } });
        await playSlackDrive(url, wait);
        return undefined;
      } catch (e) {
        drive.stop();
        return e;
      }
    })();
    const run = await onboard(SLACK_ONLY, {
      steps,
      out: lines,
      env: { PORT: '0', HOST: '127.0.0.1', SNAPWING_SLACK_TRANSPORT: 'http', SNAPWING_WORKDIR_ROOT: join(scratch, 'work'), SNAPWING_TEST_COMMAND: TEST_COMMAND },
    }).finally(() => (running = false));
    const failure = await playing;
    if (failure !== undefined) throw failure;
    expect(run.err).toEqual([]);
    expect(run.code, run.out.join('\n')).toBe(0);
    expect(run.out).toContain('Leaving Teams out. Run `snapwing onboard --step teams` if your team starts using it.');
    expect(run.out).toContain('Onboarding is finished.');

    // Teams is skipped, with nothing written to the tenant; every other step is done.
    const { state } = await stateDocument();
    expect(state.steps['teams']).toMatchObject({ status: 'skipped', note: 'the installer does not use Teams' });
    expect(Object.entries(status(state)).filter(([id]) => id !== 'teams').every(([, s]) => s === 'done')).toBe(true);
    expect(world.teams.published).toBe(0);
    expect(world.teams.installed).toEqual([]);

    // The test drive followed one sample bug, on Slack only, to an open pull request.
    expect(state.steps['test-drive']?.data?.['drives']).toEqual([
      { platform: 'slack', channel: SLACK_CHANNEL.id, channelName: SLACK_CHANNEL.name, incident: expect.any(String), jiraKey: `${PROJECT}-1`, pr: `https://github.com/${REPO}/pull/1` },
    ]);
    expect(await pullState(REPO, 1, world.secrets.githubInstallationToken)).toBe('open');
    expect(await Promise.all(drive.exits)).toEqual([0]);

    // The map and the config are valid, and name Slack's channel and nothing from Teams.
    const map = await parseWorkspaceMap(await readFile(join(workdir, 'workspace-context.xml'), 'utf8'));
    expect(map.surfaces).toEqual([{ id: 'admin', label: 'Admin Portal', repo: `github.com/${REPO}`, jira: { project: PROJECT, defaultIssueType: 'Bug' }, components: [] }]);
    expect(map.channels).toEqual([expect.objectContaining({ id: SLACK_CHANNEL.id, name: SLACK_CHANNEL.name, surface: 'admin' })]);
    expect(map.channels.some((c) => c.platform === 'teams')).toBe(false);
    expect(map.people).toEqual([expect.objectContaining({ handle: OWNER.login, email: OWNER.email, role: 'engineer' })]);
    expect((await validateAppConfig(await readFile(join(workdir, 'snapwing.config.xml'), 'utf8'))).valid).toBe(true);
    const env = await readEnv();
    for (const key of [...REQUIRED_SECRETS, ...SLACK_SECRETS, 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY']) expect(env.get(key), key).toBeTruthy();
    for (const key of TEAMS_SECRETS) expect(env.has(key), key).toBe(false);
    expect(world.browser.errors).toEqual([]);
    expect(world.unhandled).toEqual([]);
  }, 240_000);

  it('says a chat platform is needed, and names the steps to run, when both are left out', async () => {
    const needsChat: OnboardStep = { id: 'needs-chat', title: 'Needs chat', needs: [['slack', 'teams']], run: () => Promise.resolve({ status: 'done' }) };
    const steps = [...ONBOARD_STEPS.filter((s) => ['runtime', 'slack', 'teams'].includes(s.id)), needsChat];
    const run = await onboard({ ...SLACK_ONLY, 'slack.use': 'no' }, { steps });
    expect(run.err).toEqual([]);
    expect(run.code, run.out.join('\n')).toBe(EXIT_WAITING);
    expect(run.out.filter((l) => l.startsWith('Snapwing needs a chat platform'))).toEqual([
      'Snapwing needs a chat platform, and every one was left out. Run `snapwing onboard --step slack` or `snapwing onboard --step teams` to set one up; the steps that need it wait until then.',
    ]);
    const { state } = await stateDocument();
    expect(state.steps['slack']?.status).toBe('skipped');
    expect(state.steps['teams']?.status).toBe('skipped');
    expect(state.steps['needs-chat']).toBeUndefined();
    expect(world.slack.created).toEqual([]);
  });
});
