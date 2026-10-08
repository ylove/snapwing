// The chat seam (main 15.2 parity rule): the composed app reaches chat only through the router,
// which picks a surface by the incident's source. A fake second surface (`teams`) is plugged in through
// the compose seam next to Slack on MSW; thread posts, escalation posts, digests, and the PR card for a
// Teams incident reach the fake, the same effects for a Slack incident reach Slack, and an incident whose
// source has no surface is logged and skipped. Slack is optional: with no Slack secrets and another
// surface the app boots without any Slack piece; with no chat platform at all startup names the Slack
// group. No keys and no network. Runs on the dialect `SNAPWING_DB` selects.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { MidFlightCard } from '@snapwing/pipeline/fixer/claims.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { ChatTarget } from '@snapwing/pipeline/merge/human.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { MissingSecretsError, NO_CHAT_PLATFORM } from '../../src/server/compose.ts';
import type { ChatPosted, ChatRouter, ChatSurface } from '../../src/server/chat.ts';
import { bootComposed, BOT_USER, DEMO_MAP, EXAMPLE_CONFIG, fakeSecrets, slackWorld, WORKSPACE_DOMAIN, type Booted, type SlackWorld } from '../fixtures/e2e/world.ts';

const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the harness was not expected to run')) };
const SLACK_CHANNEL = 'C0WEBBUGS';
const TEAMS_CHANNEL = '19:web-bugs@thread.tacv2';
const TEAMS_LEAD = '29:teams-lead';

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

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-chat-seam-'));
  unhandled.length = 0;
});

afterEach(async () => {
  await booted?.stop();
  booted = undefined;
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

// The fake second surface -----------------------------------------------------------------------

type FakeCall =
  | { kind: 'thread'; target: ChatTarget; text: string }
  | { kind: 'channel'; channel: string; text: string }
  | { kind: 'person'; person: string; text: string }
  | { kind: 'pr-ready'; target: ChatTarget; incidentId: string; canMerge: boolean }
  | { kind: 'link-prompt'; userId: string; incidentId: string }
  | { kind: 'mid-flight'; target: ChatTarget; incidentId: string }
  | { kind: 'members' };

/** A `teams` surface that records every effect; its mention markup is Teams-like. */
function fakeTeams(): ChatSurface & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let n = 0;
  const posted = (channel: string): ChatPosted => ({ channel, messageId: `teams-msg-${String(++n)}` });
  return {
    platform: 'teams',
    calls,
    threadPost: (target, text) => {
      calls.push({ kind: 'thread', target, text });
      return Promise.resolve(posted(target.channel));
    },
    channelPost: (channel, text) => {
      calls.push({ kind: 'channel', channel, text });
      return Promise.resolve();
    },
    personPost: (person, text) => {
      calls.push({ kind: 'person', person, text });
      return Promise.resolve();
    },
    mention: (map: WorkspaceMap, ref: string) => {
      const r = ref.replace(/^@/, '');
      const id = map.people.find((p) => p.teamsId === r || p.handle === r)?.teamsId;
      return id === undefined ? `@${r}` : `<at>${id}</at>`;
    },
    mentionUser: (userId) => `<at>${userId}</at>`,
    prReady: {
      postPrReady: (target, incidentId, _card, opts) => {
        calls.push({ kind: 'pr-ready', target, incidentId, canMerge: opts.canMerge });
        return Promise.resolve();
      },
      postLinkPrompt: (userId, _target, incidentId) => {
        calls.push({ kind: 'link-prompt', userId, incidentId });
        return Promise.resolve();
      },
    },
    textCards: {
      askResolution: () => Promise.resolve(),
      postScopeCard: () => Promise.resolve(undefined),
    },
    postMidFlightCard: (target, incidentId) => {
      calls.push({ kind: 'mid-flight', target, incidentId });
      return Promise.resolve(posted(target.channel));
    },
    refreshChannelMembers: () => {
      calls.push({ kind: 'members' });
      return Promise.resolve();
    },
    githubLinked: () => Promise.resolve(false),
  };
}

// The world -------------------------------------------------------------------------------------

/** The demo map plus a person who is on Teams only. */
async function writeMap(): Promise<string> {
  const xml = (await readFile(DEMO_MAP, 'utf8')).replace(
    '  </people>',
    `    <person teamsId="${TEAMS_LEAD}" handle="teamsLead" email="tl@example.com" role="engineer" />\n  </people>`,
  );
  const path = join(dir, 'workspace-context.xml');
  await writeFile(path, xml);
  return path;
}

async function boot(secrets: Record<string, string>, surfaces: readonly ChatSurface[]): Promise<Booted> {
  const playbook =
    '<playbook xmlns="urn:snapwing:playbook:v1" version="1"><notifications>' +
    '<digest to="@teamsLead" cron="0 9 * * 1-5"/><digest to="#web-bugs" cron="0 9 * * 1-5"/>' +
    '</notifications></playbook>';
  await writeFile(join(dir, 'playbook.xml'), playbook);
  booted = await bootComposed({
    state: await tdb.open(),
    configXml: await readFile(EXAMPLE_CONFIG, 'utf8'),
    secrets,
    dir,
    env: {
      SNAPWING_MAP: await writeMap(),
      SNAPWING_WORKDIR_ROOT: join(dir, 'work'),
      SNAPWING_PLAYBOOK: join(dir, 'playbook.xml'),
      SNAPWING_INSTRUCTIONS: join(dir, 'INSTRUCTIONS.md'),
    },
    overrides: { resolveHarness: () => idleHarness, slackBotUserId: BOT_USER, slackWorkspaceDomain: WORKSPACE_DOMAIN, chatSurfaces: surfaces },
  });
  return booted;
}

/** An incident captured from `source`, with its thread at `channel` / `anchor`. */
async function incident(b: Booted, source: 'slack' | 'teams' | 'cli', channel: string, anchor: string, root: string = anchor): Promise<string> {
  const workspaceId = await ensureInstallWorkspace(b.state);
  const id = ulid();
  const captured: NewEvent<'captured'> = {
    workspaceId,
    incidentId: id,
    type: 'captured',
    v: 1,
    source,
    occurredAt: new Date().toISOString(),
    payload: {
      kind: 'incident',
      idempotencyKey: `${source}-${id}`,
      source,
      reporter: { id: 'U0SALESLEAD', name: 'Pat', role: 'reporter' },
      anchorText: 'The cart total is blank',
      anchorId: anchor,
      channelId: channel,
      threadId: root,
    },
  };
  await b.state.append(id, [captured], 0);
  return id;
}

function router(b: Booted): ChatRouter {
  const chat = b.composed.deps?.chat;
  if (chat === undefined) throw new Error('compose exposes no chat router');
  return chat;
}

async function recorded(b: Booted, incidentId: string): Promise<unknown[]> {
  return (await b.state.read(incidentId)).filter((e) => e.type === 'bot-message-posted').map((e) => e.payload);
}

async function runDigest(b: Booted, name: 'digest.0' | 'digest.1'): Promise<void> {
  const module = b.composed.jobs.find((j) => j.name === name);
  if (module === undefined) throw new Error(`no ${name} job`);
  await module.handler({ id: ulid(), name, data: {}, attempt: 1 });
}

const CARD: PrReadyCard = {
  kind: 'pr-ready',
  prNumber: 7,
  prUrl: 'https://github.com/acme/web/pull/7',
  issueKey: 'WEB-1',
  reviewVerdict: 'approve',
  ciState: 'green',
  filesChanged: 1,
  additions: 2,
  deletions: 1,
  reviewerUserIds: [],
};

function slackPosts(slack: SlackWorld): Record<string, unknown>[] {
  return slack.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.body);
}

// Tests -----------------------------------------------------------------------------------------

describe('the chat seam', () => {
  it('posts under the thread root saved at capture, not a reported reply', async () => {
    const slack = slackWorld(server, SLACK_CHANNEL, []);
    const teams = fakeTeams();
    const b = await boot(fakeSecrets(), [teams]);
    const chat = router(b);
    const midFlight: MidFlightCard = { kind: 'mid-flight', claimerUserId: TEAMS_LEAD, runId: ulid(), runAgeMs: 60_000, choices: ['let-it-finish', 'stop-it'], grace: 'PT10M' };
    const onTeams = await incident(b, 'teams', TEAMS_CHANNEL, 'teams-reply-2', 'teams-root-1');
    const onSlack = await incident(b, 'slack', SLACK_CHANNEL, '1790000000.000200', '1790000000.000100');

    await chat.threadPost(onTeams, { text: 'on it' });
    await chat.postMidFlightCard(onTeams, midFlight);
    await chat.escalation.post({ incidentId: onTeams, ladder: 'outage', step: 1, where: { kind: 'thread', channel: TEAMS_CHANNEL, threadId: 'teams-reply-2' }, mention: 'teamsLead', text: 'outage.' });
    const root = { channel: TEAMS_CHANNEL, threadId: 'teams-root-1' };
    expect(teams.calls).toContainEqual({ kind: 'thread', target: root, text: 'on it' });
    expect(teams.calls).toContainEqual({ kind: 'mid-flight', target: root, incidentId: onTeams });
    expect(teams.calls).toContainEqual({ kind: 'thread', target: root, text: `<at>${TEAMS_LEAD}</at> outage.` });
    expect(teams.calls.some((c) => JSON.stringify(c).includes('teams-reply-2'))).toBe(false);

    await chat.threadPost(onSlack, { text: 'on it' });
    await chat.escalation.post({ incidentId: onSlack, ladder: 'outage', step: 1, where: { kind: 'thread', channel: SLACK_CHANNEL, threadId: '1790000000.000200' }, mention: 'webDev', text: 'outage.' });
    const threads = slackPosts(slack).map((p) => p['thread_ts']);
    expect(threads).toEqual(['1790000000.000100', '1790000000.000100']);
  });

  it('routes thread posts, escalations, digests, and the PR card by incident source', async () => {
    const slack = slackWorld(server, SLACK_CHANNEL, []);
    const teams = fakeTeams();
    const b = await boot(fakeSecrets(), [teams]);
    const chat = router(b);
    expect(chat.platforms).toEqual(['slack', 'teams']);
    const onTeams = await incident(b, 'teams', TEAMS_CHANNEL, 'teams-anchor-1');
    const onSlack = await incident(b, 'slack', SLACK_CHANNEL, '1790000000.000100');

    // Thread posts: the `@handle` the text addresses becomes the platform's mention; each is recorded.
    await chat.threadPost(onTeams, { text: '@teamsLead, still on it?', mentionUserId: TEAMS_LEAD });
    await chat.threadPost(onSlack, { text: '@webDev, still on it?', mentionUserId: 'U0WEBDEV' });
    expect(teams.calls).toContainEqual({ kind: 'thread', target: { channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, text: `<at>${TEAMS_LEAD}</at>, still on it?` });
    expect(slackPosts(slack)).toContainEqual({ channel: SLACK_CHANNEL, text: '<@U0WEBDEV>, still on it?', thread_ts: '1790000000.000100' });
    expect(await recorded(b, onTeams)).toEqual([{ platform: 'teams', channel: TEAMS_CHANNEL, messageId: 'teams-msg-1', role: 'other' }]);
    expect(await recorded(b, onSlack)).toEqual([expect.objectContaining({ platform: 'slack', channel: SLACK_CHANNEL, role: 'other' })]);

    // The mid-flight card is a thread post too.
    const midFlight: MidFlightCard = { kind: 'mid-flight', claimerUserId: TEAMS_LEAD, runId: ulid(), runAgeMs: 60_000, choices: ['let-it-finish', 'stop-it'], grace: 'PT10M' };
    await chat.postMidFlightCard(onTeams, midFlight);
    expect(teams.calls).toContainEqual({ kind: 'mid-flight', target: { channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, incidentId: onTeams });

    // Escalation: a thread step goes to the incident's surface with the mention rendered there; a
    // `#channel` step goes to the channel's platform, Slack until the map names one.
    await chat.escalation.post({ incidentId: onTeams, ladder: 'outage', step: 1, where: { kind: 'thread', channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, mention: 'teamsLead', text: 'this looks like an outage.' });
    expect(teams.calls).toContainEqual({ kind: 'thread', target: { channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, text: `<at>${TEAMS_LEAD}</at> this looks like an outage.` });
    expect(await recorded(b, onTeams)).toHaveLength(3);
    await chat.escalation.post({ incidentId: onTeams, ladder: 'outage', step: 2, where: { kind: 'channel', channel: '#web-bugs' }, mention: 'webDev', text: 'paging the owner.' });
    expect(slackPosts(slack)).toContainEqual({ channel: SLACK_CHANNEL, text: '<@U0WEBDEV> paging the owner.' });

    // Digests: a person on Teams only gets theirs on Teams; a `#channel` digest goes to Slack.
    await runDigest(b, 'digest.0');
    expect(teams.calls.filter((c) => c.kind === 'person')).toEqual([{ kind: 'person', person: '@teamsLead', text: expect.any(String) as unknown }]);
    const before = slackPosts(slack).length;
    await runDigest(b, 'digest.1');
    expect(slackPosts(slack).slice(before)).toEqual([expect.objectContaining({ channel: SLACK_CHANNEL })]);

    // The PR card: on the incident's surface, for either platform.
    await chat.prReady.postPrReady({ channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, onTeams, CARD, { canMerge: false });
    await chat.prReady.postLinkPrompt(TEAMS_LEAD, { channel: TEAMS_CHANNEL }, onTeams, CARD, 'https://snapwing.example.com/auth/github/start?x=1');
    expect(teams.calls).toContainEqual({ kind: 'pr-ready', target: { channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, incidentId: onTeams, canMerge: false });
    expect(teams.calls).toContainEqual({ kind: 'link-prompt', userId: TEAMS_LEAD, incidentId: onTeams });
    const slackBefore = slackPosts(slack).length;
    await chat.prReady.postPrReady({ channel: SLACK_CHANNEL, threadId: '1790000000.000100' }, onSlack, CARD, { canMerge: false });
    expect(slackPosts(slack).slice(slackBefore)).toEqual([expect.objectContaining({ channel: SLACK_CHANNEL, thread_ts: '1790000000.000100' })]);
    expect(teams.calls.filter((c) => c.kind === 'pr-ready')).toHaveLength(1);

    // People are named on the incident's platform; a source with no surface falls back to the default.
    expect(chat.platformFor(await b.state.getIncident(onTeams))).toBe('teams');
    expect(chat.platformFor(await b.state.getIncident(onSlack))).toBe('slack');

    // Channel members: every surface refreshes.
    await chat.refreshChannelMembers();
    expect(teams.calls).toContainEqual({ kind: 'members' });

    expect(b.logged).toEqual([]);
    expect(slack.unknown).toEqual([]);
    expect(unhandled).toEqual([]);
  }, 60_000);

  it('skips, with a log line, an incident whose source has no chat surface', async () => {
    const slack = slackWorld(server, SLACK_CHANNEL, []);
    const teams = fakeTeams();
    const b = await boot(fakeSecrets(), [teams]);
    const chat = router(b);
    const fromCli = await incident(b, 'cli', 'cli', 'cli-1');
    expect(chat.chatFor(await b.state.getIncident(fromCli))).toBeUndefined();
    await chat.threadPost(fromCli, { text: 'still on it?' });
    await chat.escalation.post({ incidentId: fromCli, ladder: 'outage', step: 1, where: { kind: 'thread', channel: 'cli' }, text: 'outage' });
    await chat.prReady.postPrReady({ channel: 'cli' }, fromCli, CARD, { canMerge: false });
    expect(teams.calls.filter((c) => c.kind !== 'members')).toEqual([]);
    expect(slackPosts(slack)).toEqual([]);
    expect(await recorded(b, fromCli)).toEqual([]);
    expect(chat.platformFor(await b.state.getIncident(fromCli))).toBe('slack');
    expect(b.logged).toEqual([]);
  }, 60_000);

  it('boots without Slack when another surface is configured, and refuses to boot with no chat platform', async () => {
    const noSlack = fakeSecrets();
    for (const name of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) delete noSlack[name];

    await expect(boot(noSlack, [])).rejects.toThrow(MissingSecretsError);
    await expect(boot(noSlack, [])).rejects.toThrow(`${NO_CHAT_PLATFORM}: missing secrets: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET`);

    const teams = fakeTeams();
    const b = await boot(noSlack, [teams]);
    const chat = router(b);
    expect(chat.platforms).toEqual(['teams']);
    expect(b.composed.routes.some((r) => r.path.startsWith('/slack/'))).toBe(false);
    expect((b.composed.apiServices ?? []).map((s) => s.name)).not.toContainEqual(expect.stringMatching(/^slack/));
    expect((b.composed.workerServices ?? []).map((s) => s.name)).not.toContain('slack status projector');
    const onTeams = await incident(b, 'teams', TEAMS_CHANNEL, 'teams-anchor-1');
    await chat.threadPost(onTeams, { text: 'still on it?' });
    // With Teams the only surface, a `#channel` digest goes there too.
    await runDigest(b, 'digest.1');
    expect(teams.calls).toContainEqual({ kind: 'thread', target: { channel: TEAMS_CHANNEL, threadId: 'teams-anchor-1' }, text: 'still on it?' });
    expect(teams.calls).toContainEqual({ kind: 'channel', channel: '#web-bugs', text: expect.any(String) as unknown });
    expect(b.logged).toEqual([]);
    // Nothing called Slack.
    expect(unhandled.filter((u) => u.includes('slack.com'))).toEqual([]);
  }, 60_000);
});
