// E2E tier: the Companion A rows on real Slack, Jira, and GitHub (A 8, the phase 4 proof, BUILDING.md 6;
// #308). Same harness as levels.test.ts (#162): `snapwing serve` in this process with the local runner
// and Socket Mode, a Cloudflare quick tunnel, a per-run Jira admin webhook, the GitHub App webhook
// pointed at the tunnel, live models, and every card tap a `block_actions` payload built from the real
// card and handed to the Socket Mode connection (Slack has no API that presses a button). Each row
// boots its own server and store; teardown (afterEach and afterAll, which run after a failed assertion
// too) deletes everything the row made.
//
// The six rows of A 8:
//
// - Claim hold (A 2.1). Level 2. The engineer reacts 🐛 and then 👀 on the report within 30 s of it:
//   the issue is filed, labeled human-claimed, and assigned to the engineer (the map gives them the Jira
//   account's email); the claim card replaces the fix preview; the read-only scout's diagnosis is a
//   Jira comment; no fixer starts.
// - Staging verification (A 1.3). Level 3. The fixer's pull request is reviewed, goes green, and is
//   merged by the agent; the test then acts as the fixture's deploy system (a real GitHub deployment to
//   `staging` with a success status, so GitHub sends the App a real `deployment_status`). The reporter
//   reacts 👍 on the staging check: `verified`, and "@e2eReporter verified on staging at <time>" on the
//   Jira issue and the pull request. The production deployment then lands as `deployed:production`
//   with the incident still at level 3 and nothing holding it.
// - Escalation (A 1.4). Five distinct people react 🔥 on the report before anyone files it, then the
//   engineer reacts 🐛: the reactions are counted the moment the incident exists, the ladder reaches
//   step 2 (priority Highest, the owner mentioned in the thread, the ask-back gate suppressed, so no
//   question card), and the Highest priority starts active monitoring. Two of the five are the test
//   users reacting for real. The workspace has no third person the run can act as and the bot's own
//   reactions are never signals, so the other three are `reaction_added` events for three people in the
//   test map (no Slack accounts) handed to the server's Socket Mode connection, as a tap is.
// - Status pull (A 4.3). After a filing, the reporter asks the bot "where are we with the cart thing" in
//   their direct message with it (another channel than the report's): the answer names the incident's
//   key, is reporter-shaped (plain language, the next step, no engineer timeline, no buttons), and the
//   server answered under 1 s from the moment Slack's envelope arrived to Slack accepting the reply.
// - User-side check (A 5.2). The reporter posts a screenshot whose URL bar shows `staging.` (the
//   committed helpers/staging-cart.png): the check is asked before filing, the reporter taps That fixed
//   it, nothing is filed, and `user-side` is in the log.
// - Stall (A 4.5, A 6.2). Level 2 on a surface the proof playbook marks critical. The fixer's pull
//   request targets a `test/` branch whose required check (`e2e/suppressed-ci`) nothing ever reports: CI
//   never answers, by webhook or by the monitor's poll. In CI, the heartbeat posts after
//   `monitor.heartbeat`, and after `monitor.stallAfter` plus the `stalled-fix` ladder's first step
//   (PT0M) the owner is mentioned in the thread. The proof playbook shortens 10 and 15 minutes to 1
//   and 3 (#301: steps count from the stall).
//
// The staging and stall rows merge or wait on CI without touching the fixture's `main`: the test makes
// a `test/` branch from `main`, protects it as the fixture's owner through `gh` (the App cannot
// administer branches), and the scripted fixer opens its pull request against it (helpers/fake-agent.mjs
// `pr-base`) with a regression test the review's proof runs (`regression-test`, SNAPWING_TEST_COMMAND).
// So these rows always use the scripted fixer, and they skip, with a warning, when `gh` cannot
// administer the fixture. The review agent is the scripted one in every row.
//
// Needs the secrets in helpers/env.ts (`.env.live` at the repository root or SNAPWING_ENV_LIVE, else the
// environment), `cloudflared` on PATH, and for the staging and stall rows `gh` logged in as the
// fixture's owner. Without the secrets or cloudflared the file skips. Run with `pnpm test:e2e` (one file
// at a time: two e2e files share the test channel, the App webhook, and the Socket Mode app).
//
// Hygiene: every Slack post in the test channel and every Jira summary starts with `[snapwing-test]`;
// the status question in the reporter's DM ends with it instead (a status question must start with the
// question). Teardown stops the server, deletes the thread (and the DM exchange, and the uploaded
// file), deletes the Jira issues, closes the pull requests and deletes their branches (only `fix/` and
// `test/`), removes the row's protection, deployments, and any deployment environment it created,
// deletes the run's Jira webhook, and stops the tunnel. No secret is logged or put in an assertion
// message.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventType, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { stallAnchor } from '@snapwing/pipeline/monitor/active.ts';
import { reporterViolations } from '@snapwing/pipeline/status/copy.ts';
import { runBootstrap } from '../../../../scripts/jira-bootstrap.ts';
import { loadLiveEnv, PREFIX } from './helpers/env.ts';
import { createFixtureAdmin, createGitHubDriver, ghAdministersFixture, pointGitHubWebhook, type FixtureAdmin, type GitHubDriver } from './helpers/github.ts';
import { adfText, createJiraDriver, type JiraDriver } from './helpers/jira.ts';
import { installRecorder, type Recorder, type SlackWrite } from './helpers/recorder.ts';
import { startServer, type RunningServer } from './helpers/server.ts';
import { blockActions, blockIdsOf, buttonsOf, createSlackDriver, textOf, type SlackDriver, type SlackMessage } from './helpers/slack.ts';
import { freePort, hasCloudflared, startTunnel, waitReachable, type Tunnel } from './helpers/tunnel.ts';

const FAKE_AGENT = fileURLToPath(new URL('./helpers/fake-agent.mjs', import.meta.url));
const SCREENSHOT = fileURLToPath(new URL('./helpers/staging-cart.png', import.meta.url));
const TRIGGER_EMOJI = 'bug';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** Reaction to filed: context, resolution, triage, and the taps (live models). */
const FILE_WITHIN = 8 * MINUTE;
/** Filed to merged, or to waiting on CI: the scripted fixer, the scripted review, the regression proof. */
const FIX_WITHIN = 12 * MINUTE;
/** How long a held review waits before approving on its own (rows that never release it). */
const REVIEW_HOLD_S = 30 * 60;
/** The review's regression proof: the scripted fixer's node:test file, no dependencies needed. */
const TEST_COMMAND = 'node --test test/discount.regression.test.ts';
/** The stall row's proof playbook: A 6.2's 10 and 15 minutes, shortened. */
const POLL = 15 * SECOND;
const HEARTBEAT = MINUTE;
const STALL_AFTER = 3 * MINUTE;
/** The required check nothing reports in the stall row (CI that never answers). */
const SUPPRESSED_CI = 'e2e/suppressed-ci';
/** People in the test map with no Slack account: the escalation row's other three reactors. */
const MAPPED_ONLY = ['U0E2EFIRE1', 'U0E2EFIRE2', 'U0E2EFIRE3'] as const;

const live = await loadLiveEnv();
const cloudflared = hasCloudflared();
/** As levels.test.ts: OpenAI `gpt-4.1` for every pipeline task unless SNAPWING_E2E_MODEL_PROVIDER says otherwise. */
const modelProvider = process.env.SNAPWING_E2E_MODEL_PROVIDER ?? 'openai';
const modelName = process.env.SNAPWING_E2E_MODEL ?? (modelProvider === 'openai' ? 'gpt-4.1' : '');
const MODEL_TASKS = ['triage', 'segmentation', 'vision', 'clarify', 'scout', 'review'] as const;
const PROVIDER_KEY: Readonly<Record<string, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GOOGLE_API_KEY'>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY' };
const missing = [...live.missing, ...[PROVIDER_KEY[modelProvider] ?? 'OPENAI_API_KEY'].filter((k) => live.values[k] === '')];
const ready = missing.length === 0 && cloudflared;
if (!ready) {
  const why = [...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []), ...(cloudflared ? [] : ['cloudflared is not on PATH'])];
  console.warn(`e2e companion A: skipping (${why.join('; ')})`);
}
const ghAdmin = ready && ghAdministersFixture();
if (ready && !ghAdmin) console.warn('e2e companion A: skipping the staging and stall rows (`gh` is not logged in with admin on the fixture repository)');

const v = live.values;
const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const WEBHOOK_NAME = `${PREFIX} e2e companion-a`;
const RUN_WEBHOOK = `${WEBHOOK_NAME} ${runId}`;

// The world -----------------------------------------------------------------------------------------

interface MapOptions {
  level: 0 | 1 | 2 | 3;
  /** The engineer's email, so a claim assigns the Jira account the API uses (the claim row). */
  engineerEmail?: boolean;
  /** The escalation row's three mapped people with no Slack account. */
  mappedOnly?: boolean;
}

/**
 * The test map: the test channel on the fixture surface, the engineer owning it, the reporter. "The
 * cart" is deliberately not a surface term, so "the cart thing" is matched against incident summaries
 * (A 4.3) rather than read as a question about the whole surface.
 */
function workspaceMap(o: MapOptions): string {
  const extra = o.mappedOnly === true ? MAPPED_ONLY.map((id, i) => `\n    <person slackId="${id}" handle="e2eFire${String(i + 1)}" role="reporter" />`).join('') : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="snapwing-e2e" updated="2026-10-03T00:00:00Z">
  <surfaces>
    <surface id="fixture-web" label="Fixture storefront">
      <repo>github.com/ylove/snapwing-fixture-web</repo>
      <jira project="${live.projectKey}" defaultIssueType="Bug" />
    </surface>
  </surfaces>
  <channels>
    <channel id="${v.SLACK_TEST_CHANNEL}" name="snapwing-test" surface="fixture-web" confidence="explicit" />
  </channels>
  <triggers>
    <messageAction label="Fix it from here" />
    <emoji slack="${TRIGGER_EMOJI}" teams="bug" />
  </triggers>
  <vocabulary>
    <term surface="fixture-web">the storefront</term>
  </vocabulary>
  <people>
    <person slackId="${v.SLACK_TEST_ENGINEER_ID}" handle="e2eEngineer"${o.engineerEmail === true ? ` email="${v.JIRA_EMAIL}"` : ''} role="engineer">
      <owns surface="fixture-web" />
    </person>
    <person slackId="${v.SLACK_TEST_REPORTER_ID}" handle="e2eReporter" role="reporter" />${extra}
  </people>
  <policies>
    <askBack maxQuestionsPerIncident="1" suppressWhenReportersAtLeast="3" />
    <autonomy default="0">
      <level id="0" name="ticket-only" fixer="never" merge="none" />
      <level id="1" name="fix-on-tap" fixer="on-tap" merge="human" />
      <level id="2" name="fix-now" fixer="immediate" merge="human" />
      <level id="3" name="autopilot" fixer="immediate" merge="agent" requires="review-agent ci-green risk-gate" />
      <overrides>
        <surface ref="fixture-web" level="${String(o.level)}" />
      </overrides>
    </autonomy>
    <riskGate maxFilesTouched="6" maxDiffLines="300">
      <forbiddenPath>.github/**</forbiddenPath>
    </riskGate>
  </policies>
</workspace>
`;
}

/** The app config: the scripted agent for the fixer and the review (fake-agent.mjs, SNAPWING_ROLE). */
function appConfig(worldDir: string): string {
  const command = [process.execPath, FAKE_AGENT, worldDir, String(REVIEW_HOLD_S)].map((a) => `&quot;${a}&quot;`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<snapwing xmlns="urn:snapwing:config:v1" version="1">
  <runtime provider="local"/>
  <models default-provider="${modelProvider}">${modelName === '' ? '' : MODEL_TASKS.map((t) => `\n    <model task="${t}" provider="${modelProvider}" name="${modelName}"/>`).join('')}
  </models>
  <harness fixer="generic" review="generic"><generic id="e2e-agent" command="${command}" timeout="PT30M"/></harness>
  <jira/>
</snapwing>
`;
}

/** The stall row's proof playbook (A 6.2 shape, shortened durations, the issue's PT0M first step). */
const STALL_PLAYBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<playbook xmlns="urn:snapwing:playbook:v1" version="1">
  <monitor interval="PT${POLL / SECOND}S" heartbeat="PT${HEARTBEAT / MINUTE}M" stallAfter="PT${STALL_AFTER / MINUTE}M">
    <critical surface="fixture-web" />
  </monitor>
  <escalation name="stalled-fix">
    <after duration="PT0M" mention="owner" />
    <applyWhen monitored="true" stalled="true" />
  </escalation>
</playbook>
`;

/** The bug-shaped message the reporter posts (the fixture's seeded bug, README of snapwing-fixture-web). */
function bugReport(row: string): string {
  return (
    'The cart discount is wrong on the fixture storefront: a 10% coupon on a $20.00 cart only takes 20 cents off, ' +
    `so the cart total shows $19.80 instead of $18.00. Every coupon is ten times too small. (e2e ${runId}, ${row})`
  );
}

// Run state -----------------------------------------------------------------------------------------

interface Row {
  name: string;
  dir: string;
  server?: RunningServer;
  anchorTs?: string;
  incidentId?: string;
  jiraKeys: Set<string>;
  pulls: Set<number>;
  /** `fix/` and `test/` branches to delete. */
  branches: Set<string>;
  /** `test/` branches this row protected. */
  protected: Set<string>;
  deployments: number[];
  /** Deployment environments this row's deployments created (absent before the row). */
  environments: Set<string>;
  /** The reporter's direct message with the bot, from the question on. */
  dm?: { channel: string; oldest: string };
  files: string[];
}

let tunnel: Tunnel | undefined;
let port = 0;
let jiraWebhookSecret = '';
let current: Row | undefined;
let slack: SlackDriver;
let jira: JiraDriver;
let github: GitHubDriver;
let admin: FixtureAdmin;
let recorder: Recorder | undefined;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined>, diagnose?: () => Promise<string>, every = 3 * SECOND): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${diagnose === undefined ? '' : `: ${await diagnose()}`}`);
    await sleep(every);
  }
}

async function incidentOf(r: Row): Promise<IncidentView | undefined> {
  const state = r.server?.state;
  if (state === undefined) return undefined;
  if (r.incidentId === undefined) {
    const [first] = await state.findIncidents({ limit: 5 });
    if (first === undefined) return undefined;
    r.incidentId = first.id;
  }
  return (await state.getIncident(r.incidentId)) ?? undefined;
}

async function logOf(r: Row): Promise<IncidentEvent[]> {
  const incident = await incidentOf(r);
  if (incident === undefined || r.server === undefined) return [];
  return r.server.state.read(incident.id);
}

async function eventsOf<T extends EventType>(r: Row, type: T): Promise<IncidentEvent<T>[]> {
  return (await logOf(r)).filter((e) => e.type === type) as unknown as IncidentEvent<T>[];
}

/** What went wrong, for a timeout: the incident's log, the server's last lines. */
async function diagnose(r: Row): Promise<string> {
  const parts: string[] = [];
  const incident = await incidentOf(r).catch(() => undefined);
  if (incident !== undefined && r.server !== undefined) {
    const log = await r.server.state.read(incident.id);
    parts.push(`status ${incident.status}; events ${log.map((e) => e.type).join(', ')}`);
    const notable = log.filter((e) => /failed|held|stopped|escalat|level-changed|review/.test(e.type));
    if (notable.length > 0) parts.push(notable.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`).join('; '));
  }
  parts.push(`server: ${(r.server?.lines ?? []).filter((x) => !/started|listening|state open/.test(x)).slice(-8).join(' | ')}`);
  return parts.join(' / ');
}

/** The bot's messages in the row's thread. */
async function botReplies(r: Row): Promise<SlackMessage[]> {
  const bot = await slack.botUserId();
  return (await slack.thread(r.anchorTs ?? '')).filter((m) => m.ts !== r.anchorTs && (m.user === bot || m.bot_id !== undefined));
}

/** Thread posts the app made in the row's thread, from the recorder (oldest first). */
function threadWrites(r: Row): SlackWrite[] {
  return (recorder?.writes ?? []).filter((w) => w.method === 'chat.postMessage' && w.threadTs === r.anchorTs);
}

// The steps -----------------------------------------------------------------------------------------

interface BootOptions extends MapOptions {
  playbook?: string;
  /** The review's regression proof command (SNAPWING_TEST_COMMAND). */
  testCommand?: string;
}

async function boot(name: string, o: BootOptions, before?: (r: Row) => Promise<void>): Promise<Row> {
  const r: Row = {
    name,
    dir: await mkdtemp(join(tmpdir(), `snapwing-e2e-a-${name}-`)),
    jiraKeys: new Set(),
    pulls: new Set(),
    branches: new Set(),
    protected: new Set(),
    deployments: [],
    environments: new Set(),
    files: [],
  };
  current = r;
  if (before !== undefined) await before(r);
  // Absent files mean the defaults: no playbook, no instructions, whatever the working directory holds.
  const playbookPath = join(r.dir, 'playbook.xml');
  if (o.playbook !== undefined) await writeFile(playbookPath, o.playbook);
  r.server = await startServer({
    port,
    envFile: live.file,
    overlay: {
      SNAPWING_PUBLIC_URL: tunnel?.url ?? '',
      SNAPWING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SNAPWING_FIXER_TOKEN_SECRET: randomBytes(32).toString('hex'),
      JIRA_WEBHOOK_SECRET: jiraWebhookSecret,
    },
    env: {
      SNAPWING_DB: 'sqlite',
      SNAPWING_SQLITE_PATH: join(r.dir, 'snapwing.db'),
      SNAPWING_WORKDIR_ROOT: join(r.dir, 'work'),
      SNAPWING_SLACK_TRANSPORT: 'socket',
      SNAPWING_PLAYBOOK: playbookPath,
      SNAPWING_INSTRUCTIONS: join(r.dir, 'INSTRUCTIONS.md'),
      ...(o.testCommand === undefined ? {} : { SNAPWING_TEST_COMMAND: o.testCommand }),
    },
    configXml: appConfig(r.dir),
    mapXml: workspaceMap(o),
    dir: r.dir,
  });
  await waitReachable(tunnel?.url ?? '');
  return r;
}

/**
 * A `test/` branch at `main`'s head, protected with `contexts` as its required checks, as the scripted
 * fixer's pull request base (`pr-base`), with the regression test it adds (`regression-test`) and the
 * review released up front (`release-review`), so the review approves straight away.
 */
async function testBase(r: Row, suffix: string, contexts: readonly string[]): Promise<string> {
  const branch = `test/e2e-${runId}-${suffix}`;
  await github.createTestBranch(branch, await github.branchSha('main'));
  r.branches.add(branch);
  await admin.protect(branch, contexts);
  r.protected.add(branch);
  await writeFile(join(r.dir, 'pr-base'), branch);
  await writeFile(join(r.dir, 'regression-test'), 'yes');
  await writeFile(join(r.dir, 'release-review'), 'go');
  return branch;
}

/** The reporter posts the report; a moment later the engineer reacts with the trigger emoji. */
async function reportAndTrigger(r: Row, text: string): Promise<string> {
  r.anchorTs = await slack.reporterPosts(text);
  await sleep(1_500);
  await slack.engineerReacts(r.anchorTs, TRIGGER_EMOJI);
  return r.anchorTs;
}

/** Which button a card gets, and as whom; `undefined` leaves it; a string fails the row with that reason. */
type Choice = (actions: string[]) => { actionId: string; as: 'engineer' | 'reporter' } | string | undefined;

/**
 * The engineer's answers before filing, as in levels.test.ts: the scope preview (Looks right), a dedupe
 * card (Create new anyway), an ask-back card (its first option). The fix preview is never tapped.
 */
const DEFAULT_CHOICES: Readonly<Record<string, Choice>> = {
  scope_actions: (a) => (a.includes('looks-right') ? { actionId: 'looks-right', as: 'engineer' } : undefined),
  dedupe_actions: (a) => (a.includes('create-anyway') ? { actionId: 'create-anyway', as: 'engineer' } : undefined),
  clarify_actions: (a) => (a[0] === undefined ? undefined : { actionId: a[0], as: 'engineer' }),
};

/** Answers the row's cards with `choices` until `done` gives a value. */
async function answerCardsUntil<T>(r: Row, what: string, ms: number, choices: Readonly<Record<string, Choice>>, done: () => Promise<T | undefined>): Promise<T> {
  const anchorTs = r.anchorTs ?? '';
  const tapped = new Set<string>();
  const seen: string[] = [];
  return waitFor(
    what,
    ms,
    async () => {
      const got = await done();
      if (got !== undefined) return got;
      const jobError = r.server?.lines.find((x) => x.includes('job error'));
      if (jobError !== undefined) throw new Error(`a pipeline job failed: ${jobError}`);
      for (const card of await botReplies(r)) {
        for (const [blockId, choose] of Object.entries(choices)) {
          if (!blockIdsOf(card).includes(blockId)) continue;
          const key = `${card.ts}:${blockId}`;
          const buttons = buttonsOf(card, blockId);
          if (!seen.includes(key)) seen.push(key);
          if (tapped.has(key) || buttons.length === 0) continue;
          const choice = choose(buttons.map((b) => b.action_id));
          if (choice === undefined) continue;
          if (typeof choice === 'string') throw new Error(`${choice} (card ${blockId}: ${textOf(card).slice(0, 300)})`);
          tapped.add(key);
          const userId = choice.as === 'engineer' ? v.SLACK_TEST_ENGINEER_ID : v.SLACK_TEST_REPORTER_ID;
          r.server?.tap(blockActions({ userId, channel: v.SLACK_TEST_CHANNEL, anchorTs, card, blockId, actionId: choice.actionId }));
        }
      }
      return undefined;
    },
    async () => `cards seen ${seen.join(', ') || 'none'}; tapped ${[...tapped].join(', ') || 'none'}; ${await diagnose(r)}`,
  );
}

/** Answers the cards until the incident is filed in Jira; resolves with its key. */
async function untilFiled(r: Row, choices: Readonly<Record<string, Choice>> = DEFAULT_CHOICES): Promise<string> {
  const key = await answerCardsUntil(r, 'the incident to be filed in Jira', FILE_WITHIN, choices, async () => (await incidentOf(r))?.jiraKey);
  r.jiraKeys.add(key);
  return key;
}

/** Waits for the lifecycle to reach `status`, failing early when it ends somewhere else. */
async function untilStatus(r: Row, status: IncidentView['status'], ms: number, dead: readonly string[]): Promise<IncidentView> {
  return waitFor(
    `status ${status}`,
    ms,
    async () => {
      const incident = await incidentOf(r);
      if (incident?.prNumber !== undefined) r.pulls.add(incident.prNumber);
      if (incident?.status === status) return incident;
      if (incident !== undefined && dead.includes(incident.status)) throw new Error(`the incident went to ${incident.status} instead of ${status}: ${await diagnose(r)}`);
      return undefined;
    },
    () => diagnose(r),
  );
}

const ENDED = ['ticket-only', 'stopped', 'failed', 'closed', 'not-a-bug', 'not-filed', 'escalated', 'fixing-retry', 'in-review-retry', 'ci-retry', 'held'] as const;

// Teardown ------------------------------------------------------------------------------------------

async function cleanupRow(r: Row): Promise<string[]> {
  const failures: string[] = [];
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // Release a held review so the worker drains, then stop the server before deleting anything.
  await step('release the review', () => writeFile(join(r.dir, 'release-review'), 'go'));
  const incident = await incidentOf(r).catch(() => undefined);
  if (incident?.jiraKey !== undefined) r.jiraKeys.add(incident.jiraKey);
  if (incident?.prNumber !== undefined) r.pulls.add(incident.prNumber);
  await step('stop the server', async () => {
    const code = await Promise.race([r.server?.stop() ?? Promise.resolve(0), new Promise<number>((res) => setTimeout(() => res(-1), 2 * MINUTE))]);
    if (code !== 0) throw new Error(`serve exited ${code}`);
  });
  if (r.dm !== undefined) {
    const dm = r.dm;
    await step('delete the DM exchange', async () => {
      const left = await slack.cleanupDm(dm.channel, dm.oldest);
      if (left.length > 0) throw new Error(left.join('; '));
    });
  }
  if (r.anchorTs !== undefined) {
    const anchorTs = r.anchorTs;
    await step('delete the Slack thread', async () => {
      const left = await slack.cleanupThread(anchorTs);
      if (left.length > 0) throw new Error(left.join('; '));
    });
    // An issue this row filed that the store did not record yet: its Conversation Link names the anchor.
    await step("find the row's Jira issues", async () => {
      const found = await jira.search(`project = ${live.projectKey} AND created >= -2h ORDER BY created DESC`, [v.JIRA_FIELD_CONVERSATION, 'summary']);
      for (const i of found) if (adfText(i.fields[v.JIRA_FIELD_CONVERSATION]).includes(`p${anchorTs.replace('.', '')}`)) r.jiraKeys.add(i.key);
    });
  }
  for (const id of r.files) await step(`delete file ${id}`, () => slack.deleteReporterFile(id));
  for (const key of r.jiraKeys) {
    r.branches.add(`fix/${key}`);
    await step(`find PRs from fix/${key}`, async () => {
      for (const n of await github.openPullsFrom(`fix/${key}`)) r.pulls.add(n);
    });
  }
  for (const n of r.pulls) {
    await step(`close PR #${n}`, async () => {
      const pr = await github.pull(n);
      const head = String((pr['head'] as Record<string, unknown>)['ref']);
      if (/^(fix|test)\//.test(head)) r.branches.add(head);
      if (pr['state'] === 'open') await github.closePull(n);
    });
  }
  for (const id of r.deployments) await step(`remove deployment ${id}`, () => admin.removeDeployment(id));
  for (const name of r.environments) await step(`delete environment ${name}`, () => admin.deleteEnvironment(name));
  for (const b of r.protected) await step(`unprotect ${b}`, () => admin.unprotect(b));
  for (const b of r.branches) {
    if (!/^(fix|test)\//.test(b)) {
      failures.push(`branch ${b} was left in place (not fix/ or test/)`);
      continue;
    }
    await step(`delete branch ${b}`, async () => {
      await github.deleteBranch(b);
    });
  }
  for (const key of r.jiraKeys) {
    await step(`delete ${key}`, async () => {
      // Without Delete Issues in the project the issue is closed instead; said loudly, not a failure.
      if ((await jira.deleteIssue(key)) === 'closed') console.warn(`${PREFIX} could not delete ${key} (the Jira account lacks Delete Issues in ${live.projectKey}); closed it instead.`);
    });
  }
  await step('remove the temp dir', () => rm(r.dir, { recursive: true, force: true }));
  return failures;
}

// The suite -----------------------------------------------------------------------------------------

describe.skipIf(!ready)('e2e Companion A rows on Slack (A 8)', () => {
  beforeAll(async () => {
    slack = createSlackDriver({
      botToken: v.SLACK_BOT_TOKEN,
      channel: v.SLACK_TEST_CHANNEL,
      reporter: { token: v.SLACK_TEST_REPORTER_TOKEN, id: v.SLACK_TEST_REPORTER_ID },
      engineer: { token: v.SLACK_TEST_ENGINEER_TOKEN, id: v.SLACK_TEST_ENGINEER_ID },
    });
    jira = createJiraDriver({ baseUrl: v.JIRA_BASE_URL, email: v.JIRA_EMAIL, apiToken: v.JIRA_API_TOKEN });
    github = createGitHubDriver(live.secrets);
    admin = createFixtureAdmin();
    recorder = installRecorder(v.JIRA_BASE_URL);

    // A webhook left by a run that died before its teardown.
    for (const self of await jira.webhooksNamed(WEBHOOK_NAME)) await jira.deleteWebhook(self);

    port = await freePort();
    tunnel = await startTunnel(port);
    jiraWebhookSecret = randomBytes(24).toString('hex');
    // `pnpm jira:bootstrap webhook` under this run's name, with its secret as ?secret=.
    const registered = await runBootstrap({
      env: { JIRA_BASE_URL: v.JIRA_BASE_URL, JIRA_EMAIL: v.JIRA_EMAIL, JIRA_API_TOKEN: v.JIRA_API_TOKEN, JIRA_PROJECT_KEY: live.projectKey, SNAPWING_PUBLIC_URL: tunnel.url, JIRA_WEBHOOK_SECRET: jiraWebhookSecret },
      mode: 'webhook',
      webhookName: RUN_WEBHOOK,
    });
    if (!registered.ok) throw new Error(`jira:bootstrap webhook failed: ${registered.lines.join(' | ')}`);

    // `pnpm github:bootstrap webhook`: the App's webhook to this run's tunnel (the staging row needs the
    // `deployment_status` and the merge rows the review and CI deliveries).
    if (live.fileExists && basename(live.file) === '.env.live') {
      const hook = await pointGitHubWebhook(live.file, tunnel.url);
      if (hook.needsActivation) console.warn(`e2e companion A: the GitHub App webhook is not active yet.\n${hook.lines.join('\n')}`);
    }
  }, 3 * MINUTE);

  afterEach(async () => {
    const r = current;
    current = undefined;
    if (r === undefined) return;
    const failures = await cleanupRow(r);
    if (failures.length > 0) throw new Error(`${r.name} teardown incomplete: ${failures.join('; ')}`);
  }, 5 * MINUTE);

  afterAll(async () => {
    const failures: string[] = [];
    try {
      for (const self of await jira.webhooksNamed(RUN_WEBHOOK)) await jira.deleteWebhook(self);
    } catch (e) {
      failures.push(`delete the Jira webhook: ${e instanceof Error ? e.message : String(e)}`);
    }
    await tunnel?.stop();
    recorder?.restore();
    if (failures.length > 0) throw new Error(`teardown incomplete: ${failures.join('; ')}`);
  }, 2 * MINUTE);

  it('claim hold: 👀 from the engineer within 30 s at level 2 files the ticket assigned to them, with the scout comment and no fixer', async () => {
    const r = await boot('claim', { level: 2, engineerEmail: true });
    const anchorTs = await reportAndTrigger(r, bugReport('claim hold'));
    await slack.engineerReacts(anchorTs, 'eyes');
    expect(Date.now() - Number(anchorTs) * SECOND, 'the claim lands within 30 s of the report').toBeLessThan(30 * SECOND);

    const key = await untilFiled(r);
    const claimed = await eventsOf(r, 'claimed');
    expect(claimed.map((e) => e.actor?.id)).toContain(v.SLACK_TEST_ENGINEER_ID);

    // The claim card in place of the fix preview: filed and assigned to the engineer.
    const card = await waitFor('the claim card', 2 * MINUTE, async () => (await botReplies(r)).find((m) => blockIdsOf(m).includes('claim_actions')), () => diagnose(r));
    expect(textOf(card)).toContain(`Filed as *${key}* and assigned to <@${v.SLACK_TEST_ENGINEER_ID}>`);
    expect(buttonsOf(card, 'claim_actions').map((b) => b.action_id)).toEqual(['let-agent-take', 'dismiss']);
    expect((await botReplies(r)).some((m) => buttonsOf(m, 'triage_actions').some((b) => b.action_id === 'stop'))).toBe(false);

    // On the ticket: labeled human-claimed, assigned to the engineer's Jira account.
    const me = await jira.myself();
    const issue = await waitFor(
      `${key} labeled and assigned`,
      2 * MINUTE,
      async () => {
        const got = await jira.issue(key);
        const labels = (got.fields['labels'] as string[] | undefined) ?? [];
        const assignee = (got.fields['assignee'] as { accountId?: string } | null | undefined)?.accountId;
        return labels.includes('human-claimed') && assignee !== undefined ? got : undefined;
      },
      async () => `fields ${JSON.stringify((await jira.issue(key)).fields['labels'])}; ${await diagnose(r)}`,
    );
    expect(String(issue.fields['summary'])).toMatch(/^\[snapwing-test\] \S/);
    expect((issue.fields['assignee'] as { accountId?: string }).accountId).toBe(me.accountId);

    // The read-only scout's diagnosis, for the human who took it.
    const scout = await waitFor(
      'the scout comment on the ticket',
      2 * MINUTE,
      async () => (await jira.comments(key)).find((c) => c.text.includes('read-only scout')),
      async () => `comments: ${(await jira.comments(key)).map((c) => c.text.slice(0, 120)).join(' | ') || 'none'}`,
    );
    expect(scout.text).toContain('@e2eEngineer is on this');

    // No fixer: a minute after the card, nothing started and no branch was pushed.
    await sleep(MINUTE);
    const log = await logOf(r);
    expect(log.filter((e) => e.type === 'fixer-started')).toEqual([]);
    expect(['claimed', 'filed']).toContain((await incidentOf(r))?.status);
    expect(await github.openPullsFrom(`fix/${key}`)).toEqual([]);
  }, FILE_WITHIN + 8 * MINUTE);

  it.skipIf(!ghAdmin)('staging verification: the reporter 👍 on the staging check is verified on the ticket and the PR, and production follows at level 3', async () => {
    let base = '';
    const r = await boot('staging', { level: 3, testCommand: TEST_COMMAND }, async (row) => {
      base = await testBase(row, 'staging', ['snapwing/review']);
      for (const env of ['staging', 'production']) if (!(await admin.hasEnvironment(env))) row.environments.add(env);
    });
    await reportAndTrigger(r, bugReport('staging verification'));
    const key = await untilFiled(r);

    // Autopilot: the fixer's PR, the review, the required check, the agent's merge.
    await untilStatus(r, 'merged', FIX_WITHIN, ENDED);
    const [merged] = await eventsOf(r, 'merged');
    expect(merged?.payload.levelAtMergeTime).toBe(3);
    const mergeSha = merged?.payload.mergeCommitSha ?? '';
    const pr = await github.pull(merged?.payload.prNumber ?? 0);
    expect(pr['merged']).toBe(true);
    expect((pr['base'] as Record<string, unknown>)['ref']).toBe(base);

    // The fixture's deploy system puts the merge commit on staging; GitHub tells the App.
    r.deployments.push(await admin.deploy(mergeSha, 'staging'));
    await untilStatus(r, 'deployed:staging', 3 * MINUTE, ENDED);

    // The staging check, mentioning the reporter, recorded with its role so a reaction on it resolves.
    const check = await waitFor(
      'the staging check',
      3 * MINUTE,
      async () => (await eventsOf(r, 'bot-message-posted')).find((e) => e.payload.role === 'staging-check'),
      () => diagnose(r),
    );
    const shown = await waitFor('the staging check in the thread', MINUTE, async () => (await slack.message(r.anchorTs ?? '', check.payload.messageId)) ?? undefined);
    expect(textOf(shown)).toContain(`<@${v.SLACK_TEST_REPORTER_ID}>`);

    // The reporter's 👍 is the verification.
    await slack.reporterReacts(check.payload.messageId, '+1');
    const verified = await waitFor('verified', 2 * MINUTE, async () => (await eventsOf(r, 'verified'))[0], () => diagnose(r));
    expect(verified.payload.env).toBe('staging');
    expect(verified.actor?.id).toBe(v.SLACK_TEST_REPORTER_ID);
    const comment = (await eventsOf(r, 'comment')).find((e) => e.payload.effect === 'verify');
    expect(comment?.payload.intent).toBe('accept');

    const verifiedOn = /@\S+ verified on staging at \d{1,2}:\d{2}/;
    await waitFor(
      'the verification comment on the ticket',
      3 * MINUTE,
      async () => (await jira.comments(key)).find((c) => verifiedOn.test(c.text)),
      async () => `comments: ${(await jira.comments(key)).map((c) => c.text.slice(0, 120)).join(' | ') || 'none'}`,
    );
    await waitFor(
      'the verification comment on the pull request',
      3 * MINUTE,
      async () => (await github.issueComments(merged?.payload.prNumber ?? 0)).find((c) => verifiedOn.test(c)),
      async () => `PR comments: ${(await github.issueComments(merged?.payload.prNumber ?? 0)).map((c) => c.slice(0, 120)).join(' | ') || 'none'}`,
    );

    // Production proceeds at level 3: nothing holds the deploy, and the level never dropped.
    r.deployments.push(await admin.deploy(mergeSha, 'production'));
    const done = await untilStatus(r, 'deployed:production', 3 * MINUTE, ENDED);
    expect(done.autonomyLevel).toBe(3);
    const log = await logOf(r);
    expect(log.filter((e) => e.type === 'level-changed' || e.type === 'held')).toEqual([]);
    expect(log.map((e) => e.type).indexOf('verified')).toBeLessThan(log.map((e) => e.type).indexOf('deployed:production'));
  }, FILE_WITHIN + FIX_WITHIN + 16 * MINUTE);

  it('escalation: five distinct people react 🔥, then the 🐛: priority Highest, the owner mentioned, ask-back suppressed, monitoring on', async () => {
    const r = await boot('escalation', { level: 0, mappedOnly: true });
    r.anchorTs = await slack.reporterPosts(bugReport('escalation'));
    const anchorTs = r.anchorTs;
    await sleep(1_500);
    // Two real people react, then the three mapped people with no Slack account (their events handed to
    // the Socket Mode connection, as Slack would deliver them).
    await slack.reporterReacts(anchorTs, 'fire');
    await slack.engineerReacts(anchorTs, 'fire');
    for (const [i, user] of MAPPED_ONLY.entries()) {
      const now = (Date.now() / SECOND).toFixed(6);
      r.server?.event({
        type: 'event_callback',
        event_id: `Ev0E2E${runId.toUpperCase()}${String(i)}`,
        event_time: Math.floor(Date.now() / SECOND),
        event: { type: 'reaction_added', user, reaction: 'fire', item_user: v.SLACK_TEST_REPORTER_ID, item: { type: 'message', channel: v.SLACK_TEST_CHANNEL, ts: anchorTs }, event_ts: now },
      });
      await sleep(500);
    }
    await sleep(3 * SECOND);
    // Nothing is filed yet: the reactions wait for an incident, which the trigger now creates.
    expect(await r.server?.state.findIncidents({ limit: 5 })).toEqual([]);
    await slack.engineerReacts(anchorTs, TRIGGER_EMOJI);

    // Counted the moment the incident exists: steps 1 and 2 before any card is answered.
    const steps = await waitFor(
      'the reaction ladder to reach step 2',
      3 * MINUTE,
      async () => {
        const got = await eventsOf(r, 'escalated');
        return got.some((e) => e.payload.step === 2) ? got : undefined;
      },
      () => diagnose(r),
    );
    expect(steps.map((e) => e.payload.step)).toEqual([1, 2]);
    expect(steps[1]?.payload).toMatchObject({ step: 2, priority: 'Highest', mentionOwner: true, suppressAskBack: true, reactors: 5 });
    const escalate = (await eventsOf(r, 'comment')).filter((e) => e.payload.intent === 'escalate');
    expect(new Set(escalate.map((e) => e.actor?.id))).toEqual(new Set([v.SLACK_TEST_REPORTER_ID, v.SLACK_TEST_ENGINEER_ID, ...MAPPED_ONLY]));

    // No question card: it is an incident, not a question.
    const key = await untilFiled(r, { ...DEFAULT_CHOICES, clarify_actions: () => 'an ask-back card was posted although step 2 suppresses it' });
    expect(await eventsOf(r, 'clarified')).toEqual([]);

    // The owner is mentioned in the thread.
    const mention = await waitFor(
      'the owner mention in the thread',
      2 * MINUTE,
      async () => (await botReplies(r)).find((m) => textOf(m).includes('Priority raised to Highest')),
      async () => `thread posts: ${threadWrites(r).map((w) => w.text.slice(0, 120)).join(' | ') || 'none'}`,
    );
    // Steps 1 and 2 fire together at adoption, so one post carries both: the count, then the new priority.
    expect(textOf(mention)).toMatch(new RegExp(`^<@${v.SLACK_TEST_ENGINEER_ID}> 5 people are reporting this\\. Priority raised to Highest\\.$`));

    // Highest on the incident and on the ticket.
    expect((await incidentOf(r))?.priority).toBe('Highest');
    await waitFor(
      `${key} at Highest`,
      2 * MINUTE,
      async () => ((await jira.issue(key)).fields['priority'] as { name?: string } | undefined)?.name === 'Highest' || undefined,
      async () => `priority ${JSON.stringify((await jira.issue(key)).fields['priority'])}`,
    );

    // Highest qualifies the incident for active monitoring (A 4.5).
    const started = await waitFor('monitoring to start', 2 * MINUTE, async () => (await eventsOf(r, 'monitoring-started'))[0], () => diagnose(r));
    expect(started.payload.qualifiedBy).toBe('priority');
    expect((await incidentOf(r))?.monitored).toBe(true);
  }, FILE_WITHIN + 8 * MINUTE);

  it('status pull: "where are we with the cart thing" in the reporter\'s DM names the incident, reporter-shaped, under 1 s', async () => {
    const r = await boot('status', { level: 0 });
    await reportAndTrigger(r, bugReport('status pull'));
    const key = await untilFiled(r);
    await waitFor('the status message', 2 * MINUTE, async () => (await incidentOf(r))?.statusMsgId, () => diagnose(r));

    const bot = await slack.botUserId();
    const dm = await slack.openBotDm(v.SLACK_TEST_REPORTER_ID);
    const asked = await slack.reporterPostsIn(dm, `<@${bot}> where are we with the cart thing? ${PREFIX}`);
    r.dm = { channel: dm, oldest: asked };

    const reply = await waitFor(
      'the answer in the DM',
      MINUTE,
      async () => (await slack.history(dm, asked)).find((m) => m.ts !== asked && (m.user === bot || m.bot_id !== undefined)),
      async () => `server: ${(r.server?.lines ?? []).slice(-5).join(' | ')}`,
      SECOND,
    );

    // Timed from the moment Slack's envelope reached the server to Slack accepting the answer.
    const envelope = r.server?.received.find((e) => {
      const event = e.payload['event'] as Record<string, unknown> | undefined;
      return e.type === 'events_api' && event?.['ts'] === asked && event['channel'] === dm;
    });
    expect(envelope, 'the question arrived over Socket Mode').toBeDefined();
    const answered = recorder?.writes.find((w) => w.method === 'chat.postMessage' && w.channel === dm && w.ts === reply.ts);
    expect(answered, 'the answer went out through chat.postMessage').toBeDefined();
    const serverMs = (answered?.at ?? 0) - (envelope?.at ?? 0);
    const slackMs = Math.round((Number(reply.ts) - Number(asked)) * SECOND);
    console.info(`e2e companion A: status answer in ${serverMs} ms at the server, ${slackMs} ms between the two messages in Slack`);
    expect(serverMs).toBeGreaterThanOrEqual(0);
    expect(serverMs).toBeLessThan(SECOND);

    // The right incident, in the reporter's shape: plain language, the next step, no timeline, no buttons.
    const text = textOf(reply);
    expect(text).toMatch(new RegExp(`^\\*?${key}\\b`));
    expect(text).toContain('Next: ');
    expect(text).toMatch(/Nothing needed from you right now\.$|Waiting on you: /);
    expect(text).not.toContain('\n');
    expect(text).not.toContain(' · ');
    expect(reporterViolations(text)).toEqual([]);
    expect(blockIdsOf(reply)).not.toContain('status_actions');
    // Asked, not reported: the question opened no incident of its own.
    expect(await r.server?.state.findIncidents({ limit: 5 })).toHaveLength(1);
  }, FILE_WITHIN + 4 * MINUTE);

  it('user-side check: a screenshot of staging. is asked about before filing; That fixed it files nothing and logs user-side', async () => {
    const r = await boot('user-side', { level: 2 });
    const upload = await slack.reporterUploads(
      `The cart total is wrong on the storefront: my 10% coupon only took 20 cents off a $20.00 cart, see the screenshot. (e2e ${runId}, user-side check)`,
      { name: 'cart.png', bytes: new Uint8Array(await readFile(SCREENSHOT)), title: 'Cart' },
    );
    r.files.push(upload.fileId);
    r.anchorTs = upload.ts;
    await sleep(1_500);
    await slack.engineerReacts(upload.ts, TRIGGER_EMOJI);

    // The check is the one question: the reporter taps That fixed it. A gap question instead fails.
    const choices: Record<string, Choice> = {
      ...DEFAULT_CHOICES,
      clarify_actions: (a) => (a.includes('That fixed it') ? { actionId: 'That fixed it', as: 'reporter' } : `no user-side check, a gap question instead (buttons ${a.join(', ')})`),
    };
    const sided = await answerCardsUntil(r, 'the user-side event', FILE_WITHIN, choices, async () => (await eventsOf(r, 'user-side'))[0]);
    expect(sided.payload.kind).toBe('wrong-environment');
    expect(sided.payload.evidence).toMatch(/staging/i);
    expect(sided.actor?.id).toBe(v.SLACK_TEST_REPORTER_ID);

    // Asked before filing, as a user-side check, and nothing filed after.
    const asked = await eventsOf(r, 'clarified');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload.userSide?.kind).toBe('wrong-environment');
    const note = await waitFor('the thread note', MINUTE, async () => (await botReplies(r)).find((m) => textOf(m).startsWith('Great, no bug then.')), () => diagnose(r));
    expect(textOf(note)).not.toContain(v.SLACK_TEST_REPORTER_ID);
    await sleep(30 * SECOND);
    const log = await logOf(r);
    expect(log.filter((e) => e.type === 'planned' || e.type === 'filed')).toEqual([]);
    expect((await incidentOf(r))?.jiraKey).toBeUndefined();
    const linked = await jira.search(`project = ${live.projectKey} AND created >= -1h ORDER BY created DESC`, [v.JIRA_FIELD_CONVERSATION]);
    expect(linked.filter((i) => adfText(i.fields[v.JIRA_FIELD_CONVERSATION]).includes(`p${upload.ts.replace('.', '')}`))).toEqual([]);
  }, FILE_WITHIN + 4 * MINUTE);

  it.skipIf(!ghAdmin)('stall: CI that never reports gets the heartbeat after monitor.heartbeat and the owner mention after monitor.stallAfter', async () => {
    const r = await boot('stall', { level: 2, playbook: STALL_PLAYBOOK, testCommand: TEST_COMMAND }, async (row) => {
      await testBase(row, 'stall', [SUPPRESSED_CI]);
    });
    await reportAndTrigger(r, bugReport('stall'));
    const key = await untilFiled(r);
    const started = await waitFor('monitoring to start', 2 * MINUTE, async () => (await eventsOf(r, 'monitoring-started'))[0], () => diagnose(r));
    expect(started.payload.qualifiedBy).toBe('critical-surface');

    // The fix is reviewed and waits on CI that never answers.
    await untilStatus(r, 'ci', FIX_WITHIN, ENDED);
    const passed = (await eventsOf(r, 'review-passed')).at(-1);
    const inCi = Math.max(Date.parse(passed?.occurredAt ?? ''), Date.parse(passed?.recordedAt ?? ''));

    // The heartbeat, one `monitor.heartbeat` into CI.
    const heartbeat = await waitFor(
      'the heartbeat in the thread',
      HEARTBEAT + 2 * MINUTE,
      async () => threadWrites(r).find((w) => w.text.startsWith('Still in CI,')),
      async () => `thread posts: ${threadWrites(r).map((w) => w.text.slice(0, 100)).join(' | ') || 'none'}; ${await diagnose(r)}`,
    );
    expect(heartbeat.text).toMatch(/^Still in CI, \d+ minutes?\b.*Watching\.$/);
    expect(heartbeat.at - inCi).toBeGreaterThanOrEqual(HEARTBEAT - 2 * SECOND);
    expect(heartbeat.at - inCi).toBeLessThan(HEARTBEAT + POLL + 45 * SECOND);

    // The stall: `monitor.stallAfter` after the last progress, plus the PT0M first step, mentions the owner.
    const step = await waitFor(
      'the stalled-fix step',
      STALL_AFTER + 2 * MINUTE,
      async () => (await eventsOf(r, 'escalation-ladder')).find((e) => e.payload.phase === 'step' && e.payload.ladder === 'stalled-fix'),
      () => diagnose(r),
    );
    const log = await logOf(r);
    const ladderStart = (await eventsOf(r, 'escalation-ladder')).find((e) => e.payload.phase === 'started' && e.payload.ladder === 'stalled-fix');
    expect(ladderStart).toBeDefined();
    const anchor = stallAnchor(log.filter((e) => e.seq < (ladderStart?.seq ?? 0))) ?? 0;
    expect(anchor).toBeGreaterThanOrEqual(inCi);
    const stalledAt = Date.parse(step.occurredAt);
    expect(stalledAt - anchor).toBeGreaterThanOrEqual(STALL_AFTER - SECOND);
    expect(stalledAt - anchor).toBeLessThan(STALL_AFTER + POLL + 45 * SECOND);
    expect(step.payload).toMatchObject({ phase: 'step', ladder: 'stalled-fix', step: 1, mentioned: 'e2eEngineer', posted: true });
    const mention = await waitFor('the owner mention in the thread', MINUTE, async () => (await botReplies(r)).find((m) => textOf(m).includes('Escalating (stalled-fix, step 1 of 1)')));
    expect(textOf(mention)).toMatch(new RegExp(`^<@${v.SLACK_TEST_ENGINEER_ID}> Escalating \\(stalled-fix, step 1 of 1\\): ${key} `));

    // Still waiting on the suppressed check: no CI result arrived by webhook or by poll.
    expect((await incidentOf(r))?.status).toBe('ci');
    expect(log.filter((e) => e.type === 'ci-green' || e.type === 'ci-red')).toEqual([]);
  }, FILE_WITHIN + FIX_WITHIN + HEARTBEAT + STALL_AFTER + 8 * MINUTE);
});
