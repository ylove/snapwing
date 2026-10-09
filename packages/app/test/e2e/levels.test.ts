// E2E tier: autonomy levels 1 and 2 on real Slack, Jira, and GitHub (main 14.4 e2e row, main 12).
// The phase 3 proof together with the live tier.
//
// Per level, exactly as main 14.4 says: the reporter user posts a bug-shaped message in the test
// channel, the engineer user reacts with the trigger emoji (:bug:), and then the test asserts that the
// Jira issue exists with the right fields, that the fixer opened a pull request against the fixture
// repository, and that the status message was edited. In between, the cards the engineer answers in
// Slack (scope preview, any dedupe or ask-back card, and at level 1 the Fix it tap) are tapped as the
// engineer: Slack has no API that presses a button, so the tap is a `block_actions` payload built from
// the real card and handed to the server's Socket Mode connection (helpers/server.ts). Everything else
// is real: `snapwing serve` in this process with the local runner, Socket Mode, the Jira projector and
// the Jira webhook through a Cloudflare quick tunnel, live models, the GitHub App.
//
// The fixer: the claude-code harness when `claude` is on PATH, else the generic harness with a scripted
// agent (helpers/fake-agent.mjs) that commits the real fix; the server pushes it to the fixture and
// opens a real pull request (#262).
// SNAPWING_E2E_FIXER=claude-code|scripted forces one. The review agent is always the scripted one,
// held until teardown, to keep live model calls to the pipeline and the fixer.
//
// Needs the secrets in helpers/env.ts (`.env.live` at the repository root or SNAPWING_ENV_LIVE, else the
// environment) and `cloudflared` on PATH; without them the file skips. Run with `pnpm test:e2e`.
//
// Hygiene: every Slack post and Jira summary starts with `[snapwing-test]`; the fixer's branch is its
// own `fix/<key>`; teardown (afterEach and afterAll, which run when an assertion failed too) stops the
// server, deletes the thread (bot replies, then the reporter's message), deletes the Jira issues, closes
// the pull requests and deletes their branches, deletes the run's Jira webhook, and stops the tunnel.
// No secret is logged or put in an assertion message.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { runBootstrap } from '../../../../scripts/jira-bootstrap.ts';
import { FIXTURE_REPO, loadLiveEnv, PREFIX } from './helpers/env.ts';
import { createGitHubDriver, pointGitHubWebhook, type GitHubDriver } from './helpers/github.ts';
import { createJiraDriver, prefixingFetch, type JiraDriver } from './helpers/jira.ts';
import { startServer, type RunningServer } from './helpers/server.ts';
import { blockActions, blockIdsOf, buttonsOf, createSlackDriver, textOf, type SlackDriver, type SlackMessage } from './helpers/slack.ts';
import { freePort, hasCloudflared, startTunnel, waitReachable, type Tunnel } from './helpers/tunnel.ts';

const FAKE_AGENT = fileURLToPath(new URL('./helpers/fake-agent.mjs', import.meta.url));
const TRIGGER_EMOJI = 'bug';
const MINUTE = 60_000;
/** Reaction to filed: context, resolution, triage, and the taps (live models). */
const FILE_WITHIN = 8 * MINUTE;
/** Filed to the PR row on the status message: the fixer's run. */
const PR_WITHIN = 25 * MINUTE;

const live = await loadLiveEnv();
const cloudflared = hasCloudflared();
const claudeOnPath = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
const fixerChoice = process.env.SNAPWING_E2E_FIXER ?? (claudeOnPath ? 'claude-code' : 'scripted');
/**
 * The pipeline's model provider and, when set, one model for every task. OpenAI `gpt-4.1` until the
 * adapters stop sending what the default models refuse (Anthropic's 5.5 models reject a forced
 * tool_choice and `temperature`, OpenAI's `gpt-5` rejects `temperature: 0`). With
 * SNAPWING_E2E_MODEL_PROVIDER and an empty SNAPWING_E2E_MODEL the provider's default models run.
 */
const modelProvider = process.env.SNAPWING_E2E_MODEL_PROVIDER ?? 'openai';
const modelName = process.env.SNAPWING_E2E_MODEL ?? (modelProvider === 'openai' ? 'gpt-4.1' : '');
const MODEL_TASKS = ['triage', 'segmentation', 'vision', 'clarify', 'scout', 'review'] as const;
const PROVIDER_KEY: Readonly<Record<string, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GOOGLE_API_KEY'>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY' };
const needKeys = [PROVIDER_KEY[modelProvider] ?? 'OPENAI_API_KEY', ...(fixerChoice === 'claude-code' ? (['ANTHROPIC_API_KEY'] as const) : [])];
const missing = [...live.missing, ...needKeys.filter((k) => live.values[k] === '')];
const ready = missing.length === 0 && cloudflared;
if (!ready) {
  const why = [...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []), ...(cloudflared ? [] : ['cloudflared is not on PATH'])];
  console.warn(`e2e levels: skipping (${why.join('; ')})`);
}

const v = live.values;
const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const WEBHOOK_NAME = `${PREFIX} e2e`;
const RUN_WEBHOOK = `${WEBHOOK_NAME} ${runId}`;

/** The text of a Jira field: a string as is, an ADF document as its text nodes (the client sends ADF). */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  };
  walk(value);
  return out.join('\n');
}

// The world -----------------------------------------------------------------------------------------

/** The test workspace map: the test channel on the fixture surface, the engineer owning it, the reporter. */
function workspaceMap(level: 1 | 2): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="snapwing-e2e" updated="2026-10-02T00:00:00Z">
  <surfaces>
    <surface id="fixture-web" label="Fixture storefront">
      <repo>github.com/${FIXTURE_REPO}</repo>
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
    <term surface="fixture-web">the cart</term>
  </vocabulary>
  <people>
    <person slackId="${v.SLACK_TEST_ENGINEER_ID}" handle="e2eEngineer" role="engineer">
      <owns surface="fixture-web" />
    </person>
    <person slackId="${v.SLACK_TEST_REPORTER_ID}" handle="e2eReporter" role="reporter" />
  </people>
  <policies>
    <askBack maxQuestionsPerIncident="1" suppressWhenReportersAtLeast="3" />
    <autonomy default="0">
      <level id="0" name="ticket-only" fixer="never" merge="none" />
      <level id="1" name="fix-on-tap" fixer="on-tap" merge="human" />
      <level id="2" name="fix-now" fixer="immediate" merge="human" />
      <level id="3" name="autopilot" fixer="immediate" merge="agent" requires="review-agent ci-green risk-gate" />
      <overrides>
        <surface ref="fixture-web" level="${level}" />
      </overrides>
    </autonomy>
    <riskGate maxFilesTouched="6" maxDiffLines="300">
      <forbiddenPath>.github/**</forbiddenPath>
    </riskGate>
  </policies>
</workspace>
`;
}

function appConfig(worldDir: string): string {
  const agent = (role: string): string =>
    `<generic id="e2e-${role}" command="${[process.execPath, FAKE_AGENT, worldDir, String(PR_WITHIN / 1000)].map((a) => `&quot;${a}&quot;`).join(' ')}" timeout="PT30M"/>`;
  const harness = fixerChoice === 'claude-code' ? `<harness fixer="claude-code" review="generic">${agent('review')}</harness>` : `<harness fixer="generic" review="generic">${agent('agent')}</harness>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<snapwing xmlns="urn:snapwing:config:v1" version="1">
  <runtime provider="local"/>
  <models default-provider="${modelProvider}">${modelName === '' ? '' : MODEL_TASKS.map((t) => `\n    <model task="${t}" provider="${modelProvider}" name="${modelName}"/>`).join('')}
  </models>
  ${harness}
  <jira/>
</snapwing>
`;
}

/** The bug-shaped message the reporter posts (the fixture's seeded bug, README of snapwing-fixture-web). */
function bugReport(level: number): string {
  return (
    'The cart discount is wrong on the fixture storefront: a 10% coupon on a $20.00 cart only takes 20 cents off, ' +
    `so the total shows $19.80 instead of $18.00 (25% off $20.00 shows $19.50). Every coupon is ten times too small. (e2e ${runId}, level ${level})`
  );
}

// Run state -----------------------------------------------------------------------------------------

interface Level {
  level: 1 | 2;
  dir: string;
  server?: RunningServer;
  anchorTs?: string;
  incidentId?: string;
  jiraKeys: Set<string>;
  pulls: Set<number>;
  branches: Set<string>;
}

let tunnel: Tunnel | undefined;
let port = 0;
let jiraWebhookSecret = '';
let current: Level | undefined;
let slack: SlackDriver;
let jira: JiraDriver;
let github: GitHubDriver;
let originalFetch: typeof fetch | undefined;
const restoreEnv: Record<string, string | undefined> = {};
/** Every text the app wrote to a Slack message, by ts (chat.postMessage and chat.update bodies). */
const slackWrites = new Map<string, string[]>();

/** Records the app's Slack writes (read only) and prefixes Jira summaries (helpers/jira.ts). */
function installFetch(): void {
  originalFetch = globalThis.fetch;
  const inner = originalFetch;
  const recording: typeof fetch = async (input, init) => {
    const res = await inner(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = /^https:\/\/slack\.com\/api\/(chat\.postMessage|chat\.update)$/.exec(url)?.[1];
    if (method !== undefined && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const reply = (await res.clone().json()) as Record<string, unknown>;
        const ts = String(method === 'chat.update' ? body['ts'] : reply['ts']);
        const text = textOf({ ts, ...(typeof body['text'] === 'string' ? { text: body['text'] } : {}), ...(Array.isArray(body['blocks']) ? { blocks: body['blocks'] as Record<string, unknown>[] } : {}) });
        slackWrites.set(ts, [...(slackWrites.get(ts) ?? []), text]);
      } catch {
        // Not a JSON write; nothing to record.
      }
    }
    return res;
  };
  globalThis.fetch = prefixingFetch(recording, v.JIRA_BASE_URL);
}

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined>, diagnose?: () => Promise<string>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${diagnose === undefined ? '' : `: ${await diagnose()}`}`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

async function incidentOf(l: Level): Promise<IncidentView | undefined> {
  const state = l.server?.state;
  if (state === undefined) return undefined;
  if (l.incidentId === undefined) {
    const [first] = await state.findIncidents({ limit: 5 });
    if (first === undefined) return undefined;
    l.incidentId = first.id;
  }
  return (await state.getIncident(l.incidentId)) ?? undefined;
}

/** What went wrong, for a timeout: the incident's log, the server's last lines, the thread's cards. */
async function diagnose(l: Level): Promise<string> {
  const parts: string[] = [];
  const incident = await incidentOf(l).catch(() => undefined);
  if (incident !== undefined && l.server !== undefined) {
    const log = await l.server.state.read(incident.id);
    parts.push(`status ${incident.status}; events ${log.map((e) => e.type).join(', ')}`);
    const failures = log.filter((e) => /failed|held|stopped|escalat/.test(e.type));
    if (failures.length > 0) parts.push(failures.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`).join('; '));
  }
  parts.push(`server: ${(l.server?.lines ?? []).filter((x) => !/started|listening|state open/.test(x)).slice(-8).join(' | ')}`);
  return parts.join(' / ');
}

// The steps -----------------------------------------------------------------------------------------

/**
 * Answers the cards the engineer gets until the incident is filed: the scope preview (Looks right), a
 * dedupe card (Create new anyway), an ask-back card (its first option), and the level 1 fix preview
 * (Fix it). At level 2 the fix preview is informational (Stop, Not a bug) and is not tapped.
 */
async function answerCardsUntilFiled(l: Level): Promise<IncidentView & { jiraKey: string }> {
  const anchorTs = l.anchorTs ?? '';
  const tapped = new Set<string>();
  const seen: string[] = [];
  return waitFor(
    'the incident to be filed in Jira',
    FILE_WITHIN,
    async () => {
      const incident = await incidentOf(l);
      if (incident?.jiraKey !== undefined) return { ...incident, jiraKey: incident.jiraKey };
      const jobError = l.server?.lines.find((x) => x.includes('job error'));
      if (jobError !== undefined) throw new Error(`a pipeline job failed before filing: ${jobError}`);
      const bot = await slack.botUserId();
      const cards = (await slack.thread(anchorTs)).filter((m) => m.user === bot || m.bot_id !== undefined);
      for (const card of cards) {
        for (const [blockId, choose] of CHOICES) {
          if (!blockIdsOf(card).includes(blockId)) continue;
          const key = `${card.ts}:${blockId}`;
          const buttons = buttonsOf(card, blockId);
          if (!seen.includes(key)) seen.push(key);
          if (tapped.has(key) || buttons.length === 0) continue;
          const actionId = choose(buttons.map((b) => b.action_id), l.level);
          if (actionId === undefined) continue;
          tapped.add(key);
          l.server?.tap(blockActions({ userId: v.SLACK_TEST_ENGINEER_ID, channel: v.SLACK_TEST_CHANNEL, anchorTs, card, blockId, actionId }));
        }
      }
      return undefined;
    },
    async () => `cards seen ${seen.join(', ') || 'none'}; tapped ${[...tapped].join(', ') || 'none'}; ${await diagnose(l)}`,
  );
}

/** Which button the engineer taps on each card, by its actions block. */
const CHOICES: readonly [string, (actions: string[], level: number) => string | undefined][] = [
  ['scope_actions', (a) => (a.includes('looks-right') ? 'looks-right' : undefined)],
  ['dedupe_actions', (a) => (a.includes('create-anyway') ? 'create-anyway' : undefined)],
  ['clarify_actions', (a) => a[0]],
  ['triage_actions', (a, level) => (level === 1 && a.includes('approve_fix') ? 'approve_fix' : undefined)],
];

/** The status message's text as Slack shows it now, and whether Slack marks it edited. */
async function statusMessage(l: Level, ts: string): Promise<SlackMessage | undefined> {
  return slack.message(l.anchorTs ?? '', ts);
}

async function runLevel(level: 1 | 2): Promise<void> {
  const l: Level = { level, dir: await mkdtemp(join(tmpdir(), `snapwing-e2e-l${level}-`)), jiraKeys: new Set(), pulls: new Set(), branches: new Set() };
  current = l;
  l.server = await startServer({
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
      SNAPWING_SQLITE_PATH: join(l.dir, 'snapwing.db'),
      SNAPWING_WORKDIR_ROOT: join(l.dir, 'work'),
      SNAPWING_SLACK_TRANSPORT: 'socket',
    },
    configXml: appConfig(l.dir),
    mapXml: workspaceMap(level),
    dir: l.dir,
  });
  await waitReachable(tunnel?.url ?? '');

  // 1. The reporter posts a bug-shaped message; 2. the engineer reacts with the trigger emoji.
  l.anchorTs = await slack.reporterPosts(bugReport(level));
  await new Promise((r) => setTimeout(r, 1_500));
  await slack.engineerReacts(l.anchorTs, TRIGGER_EMOJI);

  // The cards, up to filing.
  const filed = await answerCardsUntilFiled(l);
  const key = filed.jiraKey;
  l.jiraKeys.add(key);

  // 3. The issue exists with the right fields.
  const issue = await waitFor(`${key} with its custom fields`, 2 * MINUTE, async () => {
    const got = await jira.issue(key);
    return got.fields[v.JIRA_FIELD_AGENT_STATUS] === null || got.fields[v.JIRA_FIELD_AGENT_STATUS] === undefined ? undefined : got;
  });
  expect(key.startsWith(`${live.projectKey}-`)).toBe(true);
  expect(String(issue.fields['summary'])).toMatch(/^\[snapwing-test\] \S/);
  expect(Number(issue.fields[v.JIRA_FIELD_AUTONOMY])).toBe(level);
  const prompt = fieldText(issue.fields[v.JIRA_FIELD_IMPL_PROMPT]);
  expect(prompt).toContain('<implementation-request');
  expect(prompt).toContain(key);
  expect(fieldText(issue.fields[v.JIRA_FIELD_CONVERSATION])).toMatch(new RegExp(`/archives/${v.SLACK_TEST_CHANNEL}/p${l.anchorTs.replace('.', '')}`));
  expect(fieldText(issue.fields[v.JIRA_FIELD_AGENT_STATUS])).not.toBe('');

  // 4. The fixer opened a pull request against the fixture repository.
  const prNumber = await waitFor(
    'the fixer to open a pull request',
    PR_WITHIN,
    async () => {
      const incident = await incidentOf(l);
      if (incident?.prNumber !== undefined) return incident.prNumber;
      if (incident !== undefined && ['ticket-only', 'stopped', 'failed', 'closed', 'not-a-bug'].includes(incident.status)) {
        throw new Error(`the incident ended without a PR: ${await diagnose(l)}`);
      }
      return undefined;
    },
    () => diagnose(l),
  );
  l.pulls.add(prNumber);
  const pr = await github.pull(prNumber);
  const head = String((pr['head'] as Record<string, unknown>)['ref']);
  l.branches.add(head);
  expect(pr['state']).toBe('open');
  expect((pr['base'] as Record<string, unknown>)['ref']).toBe('main');
  expect(String(((pr['base'] as Record<string, unknown>)['repo'] as Record<string, unknown>)['full_name'])).toBe(FIXTURE_REPO);
  expect(head).not.toBe('main');
  expect(await github.pullFiles(prNumber)).toContain('src/cart.ts');

  // 5. The status message was edited: one message, posted at filing, now showing the PR row.
  const incident = await incidentOf(l);
  const statusTs = incident?.statusMsgId;
  expect(statusTs).toBeDefined();
  const shown = await waitFor(
    'the status message to show the PR row',
    2 * MINUTE,
    async () => {
      const m = await statusMessage(l, statusTs ?? '');
      return m !== undefined && textOf(m).includes('A fix is up') ? m : undefined;
    },
    async () => `status texts ${JSON.stringify(slackWrites.get(statusTs ?? '') ?? [])}`,
  );
  expect(shown.edited).toBeDefined();
  const writes = (slackWrites.get(statusTs ?? '') ?? []).filter((t, i, all) => i === 0 || t !== all[i - 1]);
  const rows = level === 1 ? [`Filed as ${key}, assigned to`, `Filed as ${key}. Working on a fix now.`, 'A fix is up'] : [`Filed as ${key}. Working on a fix now.`, 'A fix is up'];
  let at = -1;
  for (const row of rows) {
    const next = writes.findIndex((t, i) => i > at && t.includes(row));
    expect(next, `status row "${row}" after ${JSON.stringify(writes.slice(0, at + 1))}`).toBeGreaterThan(at);
    at = next;
  }
  // Posted once (the first write), every later row an edit of that same message.
  expect((await l.server.state.read(l.incidentId ?? '')).filter((e) => e.type === 'status-message-posted')).toHaveLength(1);
}

// Teardown ------------------------------------------------------------------------------------------

async function cleanupLevel(l: Level): Promise<string[]> {
  const failures: string[] = [];
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // Release the held review so the worker drains, then stop the server before deleting anything.
  await step('release the review', () => writeFile(join(l.dir, 'release-review'), 'go'));
  const incident = await incidentOf(l).catch(() => undefined);
  if (incident?.jiraKey !== undefined) l.jiraKeys.add(incident.jiraKey);
  if (incident?.prNumber !== undefined) l.pulls.add(incident.prNumber);
  await step('stop the server', async () => {
    const code = await Promise.race([l.server?.stop() ?? Promise.resolve(0), new Promise<number>((r) => setTimeout(() => r(-1), 2 * MINUTE))]);
    if (code !== 0) throw new Error(`serve exited ${code}`);
  });
  if (l.anchorTs !== undefined) {
    const anchorTs = l.anchorTs;
    await step('delete the Slack thread', async () => {
      const left = await slack.cleanupThread(anchorTs);
      if (left.length > 0) throw new Error(left.join('; '));
    });
    // An issue this run filed that the store did not record yet: its Conversation Link names the anchor.
    await step('find the run\'s Jira issues', async () => {
      const found = await jira.search(`project = ${live.projectKey} AND created >= -2h ORDER BY created DESC`, [v.JIRA_FIELD_CONVERSATION, 'summary']);
      for (const i of found) if (fieldText(i.fields[v.JIRA_FIELD_CONVERSATION]).includes(`p${anchorTs.replace('.', '')}`)) l.jiraKeys.add(i.key);
    });
  }
  for (const key of l.jiraKeys) {
    l.branches.add(`fix/${key}`);
    await step(`find PRs from fix/${key}`, async () => {
      for (const n of await github.openPullsFrom(`fix/${key}`)) l.pulls.add(n);
    });
  }
  for (const n of l.pulls) {
    await step(`close PR #${n}`, async () => {
      const pr = await github.pull(n);
      const head = String((pr['head'] as Record<string, unknown>)['ref']);
      if (/^(fix|test)\//.test(head)) l.branches.add(head);
      if (pr['state'] === 'open') await github.closePull(n);
    });
  }
  for (const b of l.branches) {
    if (!/^(fix|test)\//.test(b)) {
      failures.push(`branch ${b} was left in place (not fix/ or test/)`);
      continue;
    }
    await step(`delete branch ${b}`, async () => {
      await github.deleteBranch(b);
    });
  }
  for (const key of l.jiraKeys) {
    await step(`delete ${key}`, async () => {
      // Without Delete Issues in the project the issue is closed instead; said loudly, not a failure.
      if ((await jira.deleteIssue(key)) === 'closed') console.warn(`${PREFIX} could not delete ${key} (the Jira account lacks Delete Issues in ${live.projectKey}); closed it instead.`);
    });
  }
  await step('remove the temp dir', () => rm(l.dir, { recursive: true, force: true }));
  return failures;
}

// The suite -----------------------------------------------------------------------------------------

describe.skipIf(!ready)(`e2e levels 1 and 2 on Slack (fixer: ${fixerChoice})`, () => {
  beforeAll(async () => {
    slack = createSlackDriver({
      botToken: v.SLACK_BOT_TOKEN,
      channel: v.SLACK_TEST_CHANNEL,
      reporter: { token: v.SLACK_TEST_REPORTER_TOKEN, id: v.SLACK_TEST_REPORTER_ID },
      engineer: { token: v.SLACK_TEST_ENGINEER_TOKEN, id: v.SLACK_TEST_ENGINEER_ID },
    });
    jira = createJiraDriver({ baseUrl: v.JIRA_BASE_URL, email: v.JIRA_EMAIL, apiToken: v.JIRA_API_TOKEN });
    github = createGitHubDriver(live.secrets);
    // The claude-code harness copies the key from the server's environment (local runner).
    if (fixerChoice === 'claude-code' && (process.env.ANTHROPIC_API_KEY ?? '') === '') {
      restoreEnv['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = v.ANTHROPIC_API_KEY;
    }
    installFetch();

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

    // `pnpm github:bootstrap webhook`: the App's webhook to this run's tunnel (levels 1 and 2 need no
    // GitHub delivery: the fixer reports its PR through the fixer API).
    if (live.fileExists && basename(live.file) === '.env.live') {
      const hook = await pointGitHubWebhook(live.file, tunnel.url);
      if (hook.needsActivation) console.warn(`e2e levels: the GitHub App webhook is not active yet.\n${hook.lines.join('\n')}`);
    }
  }, 3 * MINUTE);

  afterEach(async () => {
    const l = current;
    current = undefined;
    if (l === undefined) return;
    const failures = await cleanupLevel(l);
    if (failures.length > 0) throw new Error(`level ${l.level} teardown incomplete: ${failures.join('; ')}`);
  }, 5 * MINUTE);

  afterAll(async () => {
    const failures: string[] = [];
    try {
      for (const self of await jira.webhooksNamed(RUN_WEBHOOK)) await jira.deleteWebhook(self);
    } catch (e) {
      failures.push(`delete the Jira webhook: ${e instanceof Error ? e.message : String(e)}`);
    }
    await tunnel?.stop();
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    for (const [k, val] of Object.entries(restoreEnv)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
    if (failures.length > 0) throw new Error(`teardown incomplete: ${failures.join('; ')}`);
  }, 2 * MINUTE);

  it('level 1: reaction, scope and Fix it taps, the issue with its fields, the fixer\'s PR, the status message edited', async () => {
    await runLevel(1);
  }, FILE_WITHIN + PR_WITHIN + 6 * MINUTE);

  it('level 2: reaction, scope tap, no Fix it, the issue with its fields, the fixer\'s PR, the status message edited', async () => {
    await runLevel(2);
  }, FILE_WITHIN + PR_WITHIN + 6 * MINUTE);
});
