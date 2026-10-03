// Levels 1 and 2 end to end through the real app on MSW (#160; main 3, main 12, main 14.4, B 11): the
// pre-live proof that everything composes. It extends the compose contract test's level 0 run
// (compose.test.ts) past filing, through the same composed routes, jobs, and projectors: a Slack
// shortcut, card taps as interactivity payloads, the Jira projector filing with custom fields, the In
// Progress webhook starting the real local runner and generic harness adapter on a fake agent
// (fixtures/e2e/fake-harness.mjs) that reports through the fixer API, the review job (real checkout,
// real regression proof) approving, the PR card, a linked human merging, and the deploy webhooks. The
// status message is posted once and edited through every main 12 row on the way.
//
// No keys and no network: Slack, Jira, and GitHub are MSW; git remotes are local bare repositories
// (fixtures/e2e/github.ts). Runs on the dialect `SNAPWING_DB` selects (pg-boss on Postgres).

import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventType } from '@snapwing/pipeline/contracts/events.ts';
import { GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel, type Scenario } from '@snapwing/pipeline/demo/run.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createGitHubOAuth } from '../../src/github/oauth.ts';
import { FakeGitHub, type GitHubPerson } from '../fixtures/e2e/github.ts';
import { JiraWebhooks } from '../fixtures/e2e/jira.ts';
import {
  blockIds,
  bootComposed,
  DEMO_LEVELS,
  DEMO_MAP,
  EXAMPLE_CONFIG,
  fakeSecrets,
  githubSigned,
  messageText,
  slackWorld,
  type Booted,
  type SlackPostCall,
  type SlackWorld,
  WORKSPACE_DOMAIN,
} from '../fixtures/e2e/world.ts';

const HARNESS = fileURLToPath(new URL('../fixtures/e2e/fake-harness.mjs', import.meta.url));
const WEBHOOK_FIXTURES = new URL('../fixtures/github-webhooks/', import.meta.url);
/** The repository's test command for the regression proof: every `test/*.test.sh` must pass. */
const TEST_COMMAND = 'for t in test/*.test.sh; do sh "$t" || exit 1; done';
const WAIT = { timeout: 20_000, interval: 25 };

const server = setupServer();
const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:unhandled', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });
});
afterAll(() => server.close());

let tdb: TestDatabase;
let dir: string;
let booted: Booted | undefined;
let github: FakeGitHub | undefined;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-e2e-'));
  unhandled.length = 0;
});

afterEach(async () => {
  await booted?.stop();
  booted = undefined;
  await github?.remove();
  github = undefined;
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

// The world ---------------------------------------------------------------------------------------

interface Plan {
  summary: string;
  files: Record<string, string>;
  test: string;
  hangAfterPr?: boolean;
  reviewGate?: boolean;
}

/** The fix and its regression test per recording: the test fails on the seeded bug and passes after. */
const FIXES: Readonly<Record<string, Omit<Plan, 'hangAfterPr' | 'reviewGate'>>> = {
  'acme/admin': {
    summary: 'append the usage rows to the CSV export',
    files: {
      'src/reports/csv-export.ts':
        "export function usageCsv(rows: UsageRow[]): string {\n  const header = 'account,seats,usage';\n  return [header, ...rows.map((r) => [r.account, r.seats, r.usage].join(','))].join('\\n');\n}\n",
      'test/csv-export.test.sh': "grep -q 'rows.map' src/reports/csv-export.ts\n",
    },
    test: 'test/csv-export.test.sh',
  },
  'acme/web': {
    summary: 'keep the order total when a coupon applies',
    files: {
      'src/checkout/coupon.ts': 'export function applyCoupon(cart: Cart, code: string): Cart {\n  const total = cart.total;\n  return { ...cart, code, total };\n}\n',
      'test/coupon.test.sh': "grep -q 'const total = cart.total' src/checkout/coupon.ts\n",
    },
    test: 'test/coupon.test.sh',
  },
};

/** The map's engineers and the GitHub accounts they link (main 11.2 step 3). Fakes only. */
const PEOPLE: Readonly<Record<string, GitHubPerson>> = {
  U0ADMDEV: { login: 'ari-acme', id: 7100001, token: 'test-user-token-ari', code: 'test-oauth-code-ari' },
  U0WEBDEV: { login: 'dana-acme', id: 7100002, token: 'test-user-token-dana', code: 'test-oauth-code-dana' },
};

interface World {
  booted: Booted;
  recording: Scenario;
  slack: SlackWorld;
  jira: JiraWorld;
  jiraHooks: JiraWebhooks;
  github: FakeGitHub;
  repo: string;
  /** The world dir the fake harness reads plans from and writes pull requests to. */
  harnessDir: string;
  /** Set once the scope card names it. */
  incidentId?: string;
}

async function world(file: string, issueKey: string, plan: Partial<Plan> = {}): Promise<World> {
  const recording = parseScenario(file, JSON.parse(await readFile(join(DEMO_LEVELS, file), 'utf8')));
  const channel = recording.channel.id;
  const slack = slackWorld(server, channel, recording.messages.map((m) => ({ type: 'message', ...m })));
  const jira = new JiraWorld(() => undefined);
  const jiraHooks = new JiraWebhooks(jira);
  const demoGitHub = new GitHubWorld(() => undefined);
  demoGitHub.addRepos(recording.github);
  const harnessDir = join(dir, 'harness');
  github = new FakeGitHub(harnessDir);
  github.people.push(...Object.values(PEOPLE));
  const [repo] = Object.keys(recording.github);
  const fix = repo === undefined ? undefined : FIXES[repo];
  if (repo === undefined || fix === undefined) throw new Error(`${file}: no fix planned for its repository`);
  for (const [name, files] of Object.entries(recording.github)) await github.addRepo(name, files);
  await mkdir(join(harnessDir, 'plans'), { recursive: true });
  await mkdir(join(harnessDir, 'gates'), { recursive: true });
  await writeFile(join(harnessDir, 'plans', `${issueKey}.json`), JSON.stringify({ ...fix, reviewGate: true, ...plan }));
  // The first matching handler wins: the e2e Jira workflow over the demo one, the fake GitHub before the demo reads.
  server.use(...jiraHooks.handlers(), ...github.handlers(), ...jiraHandlers(jira), ...githubHandlers(demoGitHub));

  // Generated per run, never committed: the App JWT is signed for real.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const secrets = { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
  // The example config with both harness roles on the fake agent through the generic adapter.
  const command = [process.execPath, HARNESS, harnessDir].map((a) => `&quot;${a}&quot;`).join(' ');
  const configXml = (await readFile(EXAMPLE_CONFIG, 'utf8')).replace(
    /<harness [\s\S]*?<\/harness>/,
    `<harness fixer="generic" review="generic"><generic id="fake-agent" command="${command}" timeout="PT2M"/></harness>`,
  );
  const model = new RecordedModel();
  model.use(recording.name, recording.model);
  booted = await bootComposed({
    state: await tdb.open(),
    configXml,
    secrets,
    dir,
    env: { SNAPWING_MAP: DEMO_MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work'), SNAPWING_TEST_COMMAND: TEST_COMMAND },
    overrides: { model: withValidation(model), projectorPollMs: 25, gitRemoteUrl: github.remoteUrl },
  });
  return { booted, recording, slack, jira, jiraHooks, github, repo, harnessDir };
}

// Steps -------------------------------------------------------------------------------------------

/** Links a Slack user's GitHub account through the composed OAuth routes, as at onboarding. */
async function linkGitHub(w: World, slackUserId: string): Promise<void> {
  const person = PEOPLE[slackUserId];
  if (person === undefined) throw new Error(`no GitHub person for ${slackUserId}`);
  const workspaceId = await ensureInstallWorkspace(w.booted.state);
  const oauth = createGitHubOAuth({ state: w.booted.state, secrets: w.booted.secrets, workspaceId });
  const link = new URL(await oauth.linkUrl({ chat: 'slack', userId: slackUserId }));
  const start = await w.booted.api.fetch(new Request(`http://snapwing.test${link.pathname}${link.search}`));
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location') ?? '');
  expect(authorize.origin).toBe('https://github.com');
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  // The user approves on GitHub, which redirects back with a code and the same state.
  const callback = new URL('http://snapwing.test/auth/github/callback');
  callback.searchParams.set('code', person.code);
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  const done = await w.booted.api.fetch(new Request(callback, { headers: { cookie } }));
  expect(done.status).toBe(200);
  expect(await done.text()).toContain(`@${person.login}`);
}

/** "Fix it from here" on the recording's anchor message, as the reporter. */
async function shortcut(w: World): Promise<void> {
  const { recording } = w;
  const response = await w.booted.interact({
    type: 'message_action',
    callback_id: 'fix_it_from_here',
    team: { domain: 'acme-test' },
    channel: { id: recording.channel.id, name: recording.channel.name },
    user: { id: recording.reporter.id, name: recording.reporter.name },
    message_ts: recording.anchor,
    message: recording.messages.find((m) => m.ts === recording.anchor),
  });
  expect(response.status).toBe(200);
}

/** The latest message posted with an actions block `blockId`. */
async function card(w: World, blockId: string): Promise<SlackPostCall> {
  return vi.waitFor(() => {
    const found = w.slack.calls.filter((c) => c.method === 'chat.postMessage' && blockIds(c.body).includes(blockId)).at(-1);
    if (found === undefined) throw new Error(`no ${blockId} card yet (${w.booted.logged.join('; ')})`);
    return found;
  }, WAIT);
}

function buttons(c: SlackPostCall, blockId: string): { action_id: string; value: string; text: { text: string } }[] {
  const blocks = c.body['blocks'] as { block_id?: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
  return blocks.find((b) => b.block_id === blockId)?.elements ?? [];
}

/** Taps `actionId` on a card as `userId`: a `block_actions` payload like Slack's. */
async function tap(w: World, c: SlackPostCall, blockId: string, actionId: string, userId: string): Promise<void> {
  const button = buttons(c, blockId).find((b) => b.action_id === actionId);
  if (button === undefined) throw new Error(`no ${actionId} button on the ${blockId} card`);
  const channel = String(c.body['channel']);
  const response = await w.booted.interact({
    type: 'block_actions',
    user: { id: userId },
    channel: { id: channel },
    container: { type: 'message', channel_id: channel, message_ts: c.ts },
    message: { ts: c.ts, thread_ts: w.recording.anchor, blocks: c.body['blocks'] },
    actions: [{ action_id: actionId, block_id: blockId, value: button.value, text: { type: 'plain_text', text: button.text.text } }],
  });
  expect(response.status).toBe(200);
}

/** Every text the pinned status message showed: the post, then each edit of that same message. */
function statusTexts(w: World, statusTs: string): string[] {
  return w.slack.calls.filter((c) => (c.method === 'chat.postMessage' || c.method === 'chat.update') && c.ts === statusTs).map((c) => messageText(c.body));
}

async function statusMessageTs(w: World, incidentId: string): Promise<string> {
  return vi.waitFor(async () => {
    const ts = (await w.booted.state.getIncident(incidentId))?.statusMsgId;
    if (ts === undefined) throw new Error('no status message yet');
    return ts;
  }, WAIT);
}

/** Waits until the status message's latest text contains `text`. */
async function statusShows(w: World, statusTs: string, text: string): Promise<void> {
  await vi.waitFor(async () => {
    const texts = statusTexts(w, statusTs);
    if (!(texts.at(-1) ?? '').includes(text)) throw new Error(`status shows "${texts.at(-1) ?? ''}", waiting for "${text}" (${await diagnose(w)})`);
  }, WAIT);
}

/** What went wrong, for a failed wait: logged errors and the failure events of the incident. */
async function diagnose(w: World): Promise<string> {
  const failures = w.incidentId === undefined ? [] : (await w.booted.state.read(w.incidentId)).filter((e) => /failed|held|stopped/.test(e.type));
  return [...w.booted.logged, ...w.booted.errors.map(String), ...failures.map((e) => `${e.type} ${JSON.stringify(e.payload)}`)].join('; ');
}

async function types(w: World, incidentId: string): Promise<EventType[]> {
  return (await w.booted.state.read(incidentId)).map((e) => e.type);
}

/** Sends the In Progress (or any queued) Jira webhook for `issueKey` to the composed route. */
async function deliverJira(w: World, issueKey: string): Promise<void> {
  await vi.waitFor(() => {
    if (!w.jiraHooks.queued.some((d) => d.issueKey === issueKey)) throw new Error(`no Jira transition of ${issueKey} yet`);
  }, WAIT);
  const statuses = await w.jiraHooks.deliver(issueKey, (body) =>
    w.booted.api.fetch(new Request('http://snapwing.test/webhooks/jira', { method: 'POST', headers: { 'content-type': 'application/json' }, body })),
  );
  expect(statuses.every((s) => s === 200)).toBe(true);
}

/** A GitHub webhook delivery from a recorded payload, patched for this repository. */
async function deliverGitHub(w: World, event: string, fixture: string, patch: (payload: Record<string, unknown>) => void): Promise<unknown> {
  const payload = JSON.parse(await readFile(new URL(fixture, WEBHOOK_FIXTURES), 'utf8')) as Record<string, unknown>;
  const [owner, name] = w.repo.split('/');
  payload['repository'] = { ...(payload['repository'] as object), name, full_name: w.repo, owner: { login: owner, type: 'Organization' } };
  patch(payload);
  const body = JSON.stringify(payload);
  const response = await w.booted.api.fetch(
    new Request('http://snapwing.test/webhooks/github', { method: 'POST', headers: githubSigned(event, body, 'test-webhook-secret', `delivery-${event}-${Date.now()}`), body }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

/** A deploy of the merge commit to `environment`. */
async function deploy(w: World, mergeSha: string, environment: 'staging' | 'production'): Promise<void> {
  await deliverGitHub(w, 'deployment_status', 'deployment-status-success.json', (p) => {
    p['deployment_status'] = { ...(p['deployment_status'] as object), environment, state: 'success' };
    p['deployment'] = { ...(p['deployment'] as object), sha: mergeSha, environment, production_environment: environment === 'production' };
  });
}

/** The incident the scope card names. */
function incidentOf(w: World, c: SlackPostCall): string {
  w.incidentId = buttons(c, 'scope_actions')[0]?.value ?? '';
  return w.incidentId;
}

/** Releases the review agent for `issueKey` (it waits so the PR row is on screen first). */
async function openReviewGate(w: World, issueKey: string): Promise<void> {
  await writeFile(join(w.harnessDir, 'gates', `review-${issueKey}`), 'go');
}

/** Nothing went wrong anywhere along the way. */
function clean(w: World): void {
  expect(w.slack.unknown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(w.booted.errors).toEqual([]);
  expect(w.booted.logged).toEqual([]);
}

/** The PR card's review, merge by the linked owner, the merge webhook, and both deploys (main 11.2, 12). */
async function reviewMergeDeploy(w: World, incidentId: string, issueKey: string, ownerId: string, statusTs: string): Promise<void> {
  const owner = PEOPLE[ownerId];
  await statusShows(w, statusTs, `A fix is up. Review requested from <@${ownerId}>.`);
  // The review job has read the PR from GitHub (the fake picks it up from the agent's write then).
  const pr = await vi.waitFor(() => {
    const found = w.github.pull(w.repo, 1);
    if (found === undefined) throw new Error('GitHub was not asked about the PR yet');
    return found;
  }, WAIT);
  expect(pr.state).toBe('open');
  await openReviewGate(w, issueKey);

  await statusShows(w, statusTs, 'Review passed, waiting on merge.');
  const prCard = await card(w, 'pr_actions');
  expect(messageText(prCard.body)).toContain(`PR #1 is ready* for ${issueKey} (review agent: approve, CI: green`);
  expect(buttons(prCard, 'pr_actions').map((b) => b.action_id)).toEqual(['open_pr', 'merge', 'request_changes', 'stop']);
  // The review agent's verdict reached GitHub as a COMMENT (the App cannot approve its own PR) and a green check.
  expect(pr.reviews.map((r) => r.event)).toEqual(['COMMENT']);
  expect(pr.reviews[0]?.body).toContain('Snapwing review agent: approve');
  expect(w.github.checkRuns.filter((r) => r.name === 'snapwing/review').map((r) => r.conclusion)).toEqual(['success']);
  expect(pr.requestedReviewers).toEqual([owner?.login]);

  await tap(w, prCard, 'pr_actions', 'merge', ownerId);
  await statusShows(w, statusTs, `Merged by <@${ownerId}>. Rolling out to staging.`);
  expect(pr.merged).toBe(true);
  expect(pr.mergedBy).toBe(owner?.login);
  // GitHub's own merge delivery arrives after the merge was recorded: nothing more happens.
  const mergedBefore = (await types(w, incidentId)).filter((t) => t === 'merged').length;
  await deliverGitHub(w, 'pull_request', 'pull-request-closed-merged.json', (p) => {
    const base = p['pull_request'] as Record<string, unknown>;
    p['number'] = 1;
    p['pull_request'] = { ...base, number: 1, merge_commit_sha: pr.mergeSha, head: { ...(base['head'] as object), ref: pr.head }, merged_by: { login: owner?.login, type: 'User' } };
    p['sender'] = { login: owner?.login, type: 'User' };
  });
  expect((await types(w, incidentId)).filter((t) => t === 'merged').length).toBe(mergedBefore);

  await deploy(w, pr.mergeSha ?? '', 'staging');
  await statusShows(w, statusTs, `Fix is on staging. <@${w.recording.reporter.id}>, can you check?`);
  await deploy(w, pr.mergeSha ?? '', 'production');
  await statusShows(w, statusTs, `Live. Closing ${issueKey}.`);
}

/** One status message, posted once and only ever edited after (main 12). */
async function postedOnce(w: World, incidentId: string, statusTs: string): Promise<void> {
  expect((await types(w, incidentId)).filter((t) => t === 'status-message-posted')).toHaveLength(1);
  const posts = w.slack.calls.filter((c) => c.method === 'chat.postMessage' && c.ts === statusTs);
  expect(posts).toHaveLength(1);
  // No other message in the thread ever carried a status line (the cards are not status posts).
  const others = w.slack.calls.filter((c) => c.method === 'chat.postMessage' && c.ts !== statusTs && blockIds(c.body).includes('status_actions'));
  expect(others).toEqual([]);
  expect(w.slack.calls.filter((c) => c.method === 'pins.add')).toHaveLength(1);
}

/** The distinct texts, in order, keeping the first of each run of repeats. */
function rows(texts: readonly string[]): string[] {
  return texts.filter((t, i) => i === 0 || t !== texts[i - 1]);
}

// Tests -------------------------------------------------------------------------------------------

describe('levels 1 and 2 end to end through the composed app', () => {
  it('level 1: shortcut, scope and Fix it taps, Jira, the fixer through the API, review, PR card, a linked merge, every status row', async () => {
    const w = await world('02-level-1-fix-on-tap.json', 'ADM-1');
    await linkGitHub(w, 'U0ADMDEV');
    await shortcut(w);

    const scope = await card(w, 'scope_actions');
    const incidentId = incidentOf(w, scope);
    await tap(w, scope, 'scope_actions', 'looks-right', w.recording.reporter.id);

    // Level 1: the fix preview offers Fix it to the engineer, who taps it.
    const preview = await card(w, 'triage_actions');
    expect(buttons(preview, 'triage_actions').map((b) => b.action_id)).toEqual(['approve_fix', 'ticket_only', 'dismiss']);
    await tap(w, preview, 'triage_actions', 'approve_fix', 'U0ADMDEV');

    // Filed in Jira with the custom fields, then the status message.
    await vi.waitFor(() => expect(w.jira.issues.get('ADM-1')?.custom['Agent Status']).toBeDefined(), WAIT);
    const issue = w.jira.issues.get('ADM-1');
    expect(issue?.summary).toBe('CSV usage export has a header row but no data');
    expect(issue?.custom['Autonomy Level']).toBe(1);
    expect(JSON.stringify(issue?.custom['Implementation Prompt'])).toContain('<implementation-request');
    expect(JSON.stringify(issue?.custom['Implementation Prompt'])).toContain('ADM-1');
    // The domain comes from the real `auth.test` at startup (the shortcut payload's team.domain is not needed).
    expect(issue?.custom['Conversation Link']).toBe(
      `https://${WORKSPACE_DOMAIN}.slack.com/archives/${w.recording.channel.id}/p${w.recording.anchor.replace('.', '')}`,
    );
    const statusTs = await statusMessageTs(w, incidentId);
    await statusShows(w, statusTs, 'Filed as ADM-1, assigned to <@U0ADMDEV>.');

    // Jira's In Progress webhook starts the fixer; the fake agent reports through the fixer API.
    await deliverJira(w, 'ADM-1');
    await statusShows(w, statusTs, 'Filed as ADM-1. Working on a fix now.');
    await reviewMergeDeploy(w, incidentId, 'ADM-1', 'U0ADMDEV', statusTs);

    const log = await w.booted.state.read(incidentId);
    const phases = log.flatMap((e) => (e.type === 'fixer-checkpoint' ? [e.payload.phase] : []));
    expect(phases).toEqual(['cloned', 'branched', 'implemented', 'tested', 'pushed', 'pr-opened']);
    expect(log.filter((e) => e.source === 'fixer').map((e) => e.type)).toEqual([...phases.map(() => 'fixer-checkpoint'), 'fixer-done', 'pr-opened']);
    expect(rows(statusTexts(w, statusTs))).toEqual([
      expect.stringContaining('Filed as ADM-1, assigned to <@U0ADMDEV>.'),
      expect.stringContaining('Filed as ADM-1. Working on a fix now.'),
      expect.stringContaining('A fix is up. Review requested from <@U0ADMDEV>.'),
      expect.stringContaining('Review passed, waiting on merge.'),
      expect.stringContaining('Merged by <@U0ADMDEV>. Rolling out to staging.'),
      expect.stringContaining(`Fix is on staging. <@${w.recording.reporter.id}>, can you check?`),
      expect.stringContaining('Live. Closing ADM-1.'),
    ]);
    await postedOnce(w, incidentId, statusTs);
    expect(w.jiraHooks.transitions[0]).toMatch(/^ADM-1: .* -> In Progress$/);
    clean(w);
  }, 60_000);

  it('level 2: no Fix it tap, the informational card carries Stop, and the same path runs to live', async () => {
    const w = await world('03-level-2-fix-now.json', 'WEB-1');
    await linkGitHub(w, 'U0WEBDEV');
    await shortcut(w);

    const scope = await card(w, 'scope_actions');
    const incidentId = incidentOf(w, scope);
    await tap(w, scope, 'scope_actions', 'looks-right', w.recording.reporter.id);
    const clarify = await card(w, 'clarify_actions');
    await tap(w, clarify, 'clarify_actions', 'Checkout', w.recording.reporter.id);

    // Level 2: the fix preview is informational, fixing now, with Stop and no Fix it.
    const preview = await card(w, 'triage_actions');
    expect(messageText(preview.body)).toContain('Fixing now.');
    expect(buttons(preview, 'triage_actions').map((b) => b.action_id)).toEqual(['stop', 'dismiss']);

    await vi.waitFor(() => expect(w.jira.issues.get('WEB-1')?.custom['Agent Status']).toBeDefined(), WAIT);
    expect(w.jira.issues.get('WEB-1')?.custom['Autonomy Level']).toBe(2);
    const statusTs = await statusMessageTs(w, incidentId);
    await statusShows(w, statusTs, 'Filed as WEB-1. Working on a fix now.');
    const fixing = w.slack.calls.find((c) => c.ts === statusTs && messageText(c.body).includes('Working on a fix now'));
    expect(fixing === undefined ? [] : buttons(fixing, 'status_actions').map((b) => b.action_id)).toEqual(['stop']);

    await deliverJira(w, 'WEB-1');
    await reviewMergeDeploy(w, incidentId, 'WEB-1', 'U0WEBDEV', statusTs);
    expect(rows(statusTexts(w, statusTs))).toEqual([
      expect.stringContaining('Filed as WEB-1. Working on a fix now.'),
      expect.stringContaining('A fix is up. Review requested from <@U0WEBDEV>.'),
      expect.stringContaining('Review passed, waiting on merge.'),
      expect.stringContaining('Merged by <@U0WEBDEV>. Rolling out to staging.'),
      expect.stringContaining(`Fix is on staging. <@${w.recording.reporter.id}>, can you check?`),
      expect.stringContaining('Live. Closing WEB-1.'),
    ]);
    await postedOnce(w, incidentId, statusTs);
    clean(w);
  }, 60_000);

  it('level 2: Stop mid-fix closes the PR the fixer opened and puts the ticket back in Backlog', async () => {
    const w = await world('03-level-2-fix-now.json', 'WEB-1', { hangAfterPr: true });
    await shortcut(w);
    const scope = await card(w, 'scope_actions');
    const incidentId = incidentOf(w, scope);
    await tap(w, scope, 'scope_actions', 'looks-right', w.recording.reporter.id);
    await tap(w, await card(w, 'clarify_actions'), 'clarify_actions', 'Checkout', w.recording.reporter.id);
    const preview = await card(w, 'triage_actions');
    const statusTs = await statusMessageTs(w, incidentId);
    await statusShows(w, statusTs, 'Filed as WEB-1. Working on a fix now.');
    await deliverJira(w, 'WEB-1');

    // The fixer pushed and opened its PR, then keeps working: Stop it from the informational card.
    await vi.waitFor(async () => {
      const log = await w.booted.state.read(incidentId);
      expect(log.some((e) => e.type === 'fixer-checkpoint' && e.payload.phase === 'pr-opened')).toBe(true);
    }, WAIT);
    const runId = (await w.booted.state.read(incidentId)).flatMap((e) => (e.type === 'fixer-started' ? [e.payload.runId] : []))[0] ?? '';
    expect(existsSync(join(dir, 'work', 'fixer', runId))).toBe(true);
    await tap(w, preview, 'triage_actions', 'stop', 'U0WEBDEV');

    await statusShows(w, statusTs, 'Stopped by <@U0WEBDEV>. Ticket back in Backlog.');
    await vi.waitFor(async () => {
      if (w.github.pull(w.repo, 1)?.state !== 'closed') throw new Error(`PR not closed (${await diagnose(w)}; github ${w.github.calls.join(', ')})`);
    }, WAIT);
    const pr = w.github.pull(w.repo, 1);
    expect(pr?.merged).toBe(false);
    expect(pr?.comments.join('\n')).toContain('Stopped by U0WEBDEV');
    await vi.waitFor(() => expect(w.jira.issues.get('WEB-1')?.status).toBe('Backlog'), WAIT);
    expect(w.jiraHooks.transitions).toEqual([expect.stringMatching(/^WEB-1: .* -> In Progress$/), 'WEB-1: In Progress -> Backlog']);
    // The agent's own Backlog transition comes back as an echo and starts nothing.
    await deliverJira(w, 'WEB-1');
    // The run was cancelled: the harness answered SIGTERM and the runner removed its checkout.
    await vi.waitFor(() => expect(existsSync(join(dir, 'work', 'fixer', runId))).toBe(false), WAIT);
    const log = await types(w, incidentId);
    expect(log).toContain('stopped');
    expect(log).not.toContain('fixer-done');
    expect(log.filter((t) => t === 'fixer-started')).toHaveLength(1);
    expect((await w.booted.state.getIncident(incidentId))?.status).toBe('stopped');
    expect(w.github.checkRuns).toEqual([]);
    expect(rows(statusTexts(w, statusTs)).at(-1)).toContain('Stopped by <@U0WEBDEV>. Ticket back in Backlog.');
    await postedOnce(w, incidentId, statusTs);
    clean(w);
  }, 60_000);
});
