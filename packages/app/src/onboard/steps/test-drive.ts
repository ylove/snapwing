// Onboarding step `test-drive` (main 22.2): one real report, end to end, before anyone relies on
// Snapwing. It starts `snapwing serve` in this process from the written config (`runServe`, with a
// signal source of its own, so the step and not the process decides when it stops), posts a sample
// bug in a sandbox channel on each connected chat platform, asks the installer to react to it with
// the bug reaction, and follows the incident's event log until a pull request opens in the sample
// repository. Each stage is said in plain words as it happens; a failure names the stage that
// stopped and what to do about it. The server is always stopped before the step returns: when the
// drive passes, when it fails, and when the installer stops it (a question left unanswered, or
// Ctrl-C while it waits).
//
// The sample repository is one the GitHub step listed, so the App is installed there; the step never
// creates a repository. The drive runs on a copy of the workspace map in a temporary directory that
// differs from the written map only for the drive: the sandbox channels belong to the product whose
// repository is the sample (or, when no product uses it, to one product whose fix goes there for the
// drive), and that product runs at its own level, lifted to Fix now (level 2) only when the installer
// agrees. At Ask (level 1) the installer is asked to tap Fix it. The written map and the config are
// never changed, and the config cache gets the written map back before the server stops.
//
// The sandbox channel: on Slack, one the bot is in (from the Slack step), another the installer names
// (joined when it is public), or a new one when the bot token carries `channels:manage` (Snapwing's
// manifest does not ask for it, so that choice is usually absent). On Teams, a Teams channel in the
// map, or one whose link the installer pastes; Snapwing has no permission to create Teams channels.
//
// Who posts the sample: the Slack normalizer accepts a trigger reaction on the bot's own message (it
// ignores only the bot's own reactions), so on Slack the bot posts it. The Teams signals never capture
// a reaction on a bot's message, and Snapwing holds no Teams user token, so on Teams the installer
// posts the sample text and reacts to their own post.
//
// Everything read back from chat or the model (channel names, a question the model asks, the plan's
// summary, a failure reason) is untrusted: it is stripped of control characters and shortened before
// it is printed, and nothing read back is run or used as a path.
//
// Reads (interview state): `finish.map`, `github.repos`, `slack` (`installed`, `channels`), `teams`
// (connected when it left data; its `channels` when they carry `{ id, name, teamId }`), `jira.webhook`.
// Its own data: { repo, surface, level, lifted, drives: [{ platform, channel, channelName, incident,
// jiraKey?, pr }] }.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import { LOG_START } from '@snapwing/pipeline/contracts/state.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { AutonomyLevelId, AutonomyOverride, MapChannel, MapSurface, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { writeWorkspaceMap } from '@snapwing/pipeline/map/write.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { repoFullName } from '@snapwing/pipeline/util/repo.ts';
import { createSlackWeb, SlackApiError } from '../../adapters/slack/web.ts';
import { TEAMS_REACTION_TABLE } from '../../adapters/teams/reactions.ts';
import type { CliIo } from '../../cli/state.ts';
import type { ComposeFn } from '../../server/compose.ts';
import type { ServeDeps, SignalSource } from '../../server/serve.ts';
import { CONFIG_FILE } from '../config-write.ts';
import { InterviewAborted, type Choice, type SecretValue } from '../interview/io.ts';
import type { JsonObject, JsonValue } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import { DEFAULT_API_BASE, joinChannel, listChannels } from '../slack/install.ts';

type Platform = 'slack' | 'teams';

/** Where a drive can be, in order. A failure names the stage it stopped at. */
export type DriveStage = 'start' | 'post' | 'capture' | 'read' | 'file' | 'begin' | 'fix';

const STAGES: readonly DriveStage[] = ['start', 'post', 'capture', 'read', 'file', 'begin', 'fix'];

const STAGE_NAMES: Readonly<Record<DriveStage, string>> = {
  start: 'starting Snapwing',
  post: 'posting the sample bug',
  capture: 'seeing your reaction',
  read: 'reading the conversation',
  file: 'filing the ticket in Jira',
  begin: 'starting the fix',
  fix: 'making the fix and opening the pull request',
};

/** What a stage that ran out of time did not do. */
const STAGE_TIMEOUTS: Readonly<Record<DriveStage, string>> = {
  start: 'Snapwing did not start',
  post: 'the sample was not posted',
  capture: 'no reaction to the sample reached Snapwing',
  read: 'Snapwing did not get from the conversation to a plan',
  file: 'Jira did not confirm the ticket',
  begin: 'the fix did not start',
  fix: 'no pull request opened',
};

/** How long each stage may take before the drive asks whether to keep waiting. */
const DEFAULT_WAITS: Readonly<Record<DriveStage, number>> = {
  start: 0,
  post: 0,
  capture: 10 * 60_000,
  read: 10 * 60_000,
  file: 5 * 60_000,
  begin: 20 * 60_000,
  fix: 30 * 60_000,
};

const PHASES: Readonly<Record<string, string>> = {
  cloned: 'Cloned the repository.',
  branched: 'Made a branch.',
  implemented: 'Made the change.',
  tested: 'Ran the tests.',
  pushed: 'Pushed the branch.',
  'pr-opened': 'Opening the pull request.',
};

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { slack: 'Slack', teams: 'Teams' };
const LEVEL_NAMES: readonly string[] = ['Note only', 'Ask', 'Fix now', 'Autopilot'];
const MAP_FILE = 'workspace-context.xml';
const SQLITE_FILE = 'snapwing.sqlite';
const SANDBOX_NAME = 'snapwing-test-drive';
const RERUN = 'snapwing onboard --step test-drive';
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEAMS_CHANNEL_ID = /^19:[A-Za-z0-9_.-]+@thread\.(?:tacv2|skype)$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface TestDriveDeps {
  /** Runs `snapwing serve`. Default `runServe`. */
  readonly serve?: (args: readonly string[], io: CliIo, deps: ServeDeps) => Promise<number>;
  /** The composition root serve calls. Default `compose`; tests add their seams here. */
  readonly compose?: ComposeFn;
  /** Slack's Web API base; tests point it at a fake. */
  readonly slackApiBase?: string;
  /** Ctrl-C while the drive waits stops it cleanly. Default `process`. */
  readonly interrupts?: SignalSource;
  /** How often the drive reads the event log. Default 1 second. */
  readonly pollMs?: number;
  /** How long a stage may take before the drive asks whether to keep waiting, by stage. */
  readonly waitMs?: Partial<Record<DriveStage, number>>;
}

interface Sandbox {
  readonly platform: Platform;
  readonly id: string;
  readonly name: string;
  /** A Teams channel's team (group id). */
  readonly teamId?: string;
}

interface Failure {
  readonly stage: DriveStage;
  readonly what: string;
  readonly fix: string;
}

interface Passed {
  readonly platform: Platform;
  readonly channel: string;
  readonly channelName: string;
  readonly incident: string;
  readonly jiraKey?: string;
  readonly pr: string;
}

const isFailure = (v: unknown): v is Failure => typeof v === 'object' && v !== null && 'stage' in v && 'fix' in v;

// Small pieces -----------------------------------------------------------------------------------

/** Untrusted text (chat, the model, a failure reason) made safe to print: one line, no control characters, short. */
export function printable(text: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** The sample bug: a small, harmless change any repository can take. */
export function sampleBug(repo: string): string {
  return `Sample bug for the Snapwing test drive: README.md in ${repo} is missing its last line. It should end with the line "Checked by Snapwing." Please add it.`;
}

/**
 * A Teams channel from its link (the channel's "..." menu, "Get link to channel"): the `19:` channel
 * id and the team's group id. Undefined unless both are well formed.
 */
export function parseTeamsChannelLink(text: string): { id: string; name: string; teamId: string } | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !['teams.microsoft.com', 'teams.cloud.microsoft'].includes(url.hostname)) return undefined;
  const parts = url.pathname.split('/').filter((p) => p !== '');
  if (parts[0] !== 'l' || parts[1] !== 'channel' || parts[2] === undefined) return undefined;
  let id: string;
  let name: string;
  try {
    id = decodeURIComponent(parts[2]);
    name = printable(decodeURIComponent(parts[3] ?? ''), 80);
  } catch {
    return undefined;
  }
  const teamId = url.searchParams.get('groupId') ?? '';
  if (!TEAMS_CHANNEL_ID.test(id) || !UUID.test(teamId)) return undefined;
  return { id, name: name === '' ? 'the channel' : name, teamId };
}

const obj = (v: JsonValue | undefined): { readonly [k: string]: JsonValue } | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as { readonly [k: string]: JsonValue }) : undefined;
const text = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The level a product runs at in `map`: its own override, else the default. */
function surfaceLevel(map: WorkspaceMap, surfaceId: string): AutonomyLevelId {
  const own = map.policies.autonomy.overrides.find((o) => o.kind === 'surface' && o.ref === surfaceId);
  return own?.level ?? map.policies.autonomy.default;
}

/** The reaction that files a bug in one channel, as that platform names it, and how many people it takes. */
function triggerFor(map: WorkspaceMap, sandbox: Sandbox): { name: string; people: number } {
  const rows = [...map.triggers.emoji].sort((a, b) => (a.minReactors ?? 1) - (b.minReactors ?? 1));
  const override = map.channels.find((c) => c.id === sandbox.id)?.triggerEmoji ?? [];
  if (override[0] !== undefined) {
    const row = rows.find((r) => r[sandbox.platform] === override[0]);
    return { name: override[0], people: row?.minReactors ?? 1 };
  }
  const row = rows[0];
  return { name: row === undefined ? 'bug' : row[sandbox.platform], people: row?.minReactors ?? 1 };
}

/** A reaction as the installer sees it: `:bug:` on Slack, the picture and its name on Teams. */
function reactionLabel(platform: Platform, name: string): string {
  if (platform === 'slack') return `:${name}:`;
  const entry = TEAMS_REACTION_TABLE.find((e) => e.name === name || (e.aliases ?? []).includes(name));
  return entry === undefined ? name : `${entry.emoji} (${name})`;
}

/** Which onboarding step sets a secret, for the fix when serve names it missing. */
function stepForSecret(name: string): string {
  if (name.startsWith('SLACK_')) return 'slack';
  if (name.startsWith('TEAMS_')) return 'teams';
  if (name.startsWith('JIRA_')) return 'jira';
  if (name.startsWith('GITHUB_')) return 'github';
  return 'runtime';
}

/** One Slack Web API call that also returns the headers (`auth.test` reports the token's scopes there). Never throws. */
async function slackCall(base: string, token: string, method: string, body: Record<string, unknown> = {}): Promise<{ ok: true; body: Record<string, unknown>; headers: Headers } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (parsed['ok'] !== true) return { ok: false, error: typeof parsed['error'] === 'string' ? parsed['error'] : `http_${res.status}` };
    return { ok: true, body: parsed, headers: res.headers };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

// The step ----------------------------------------------------------------------------------------

export function createTestDriveStep(deps: TestDriveDeps = {}): OnboardStep {
  const slackBase = (deps.slackApiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const pollMs = deps.pollMs ?? 1000;
  const waits: Record<DriveStage, number> = { ...DEFAULT_WAITS, ...deps.waitMs };

  /** The Slack channel for the sample: one the bot is in, one the installer names, or a new one where allowed. */
  async function slackSandbox(ctx: StepContext, token: SecretValue): Promise<Sandbox> {
    const { io } = ctx;
    const saved: { id: string; name: string }[] = [];
    for (const c of Array.isArray(ctx.data('slack')?.['channels']) ? (ctx.data('slack')?.['channels'] as JsonValue[]) : []) {
      const id = text(obj(c)?.['id']);
      const name = text(obj(c)?.['name']);
      if (id !== undefined && name !== undefined && !saved.some((s) => s.id === id)) saved.push({ id, name: printable(name, 80) });
    }
    const auth = await slackCall(slackBase, token.reveal(), 'auth.test');
    const scopes = auth.ok ? (auth.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()) : [];
    const canCreate = scopes.includes('channels:manage');

    for (;;) {
      const choices: Choice[] = [
        ...saved.map((c) => ({ id: c.id, label: `#${c.name}` })),
        { id: 'other', label: 'Another channel (type its name)' },
        ...(canCreate ? [{ id: 'create', label: `Create #${SANDBOX_NAME}` }] : []),
      ];
      const quiet = saved.find((c) => /test|sandbox|snapwing/.test(c.name));
      const pick = await io.choose({
        id: 'slack-channel',
        text: 'Which Slack channel should the sample bug go in? Pick a quiet one: everyone in it sees the drive.',
        choices,
        default: quiet?.id ?? (canCreate ? 'create' : (saved[0]?.id ?? 'other')),
        why: canCreate
          ? 'Snapwing posts a sample bug there and you react to it. It can also make a new channel for this.'
          : 'Snapwing posts a sample bug there and you react to it. It cannot create channels in your workspace (that needs the channels:manage permission, which Snapwing does not ask for), so pick one or make one yourself and invite Snapwing.',
      });

      if (pick === 'create') {
        const made = await slackCall(slackBase, token.reveal(), 'conversations.create', { name: SANDBOX_NAME });
        const id = made.ok ? text(obj(made.body['channel'] as JsonValue)?.['id']) : undefined;
        if (id !== undefined) {
          io.say(`Created #${SANDBOX_NAME}.`);
          return { platform: 'slack', id, name: SANDBOX_NAME };
        }
        if (!made.ok && made.error === 'name_taken') {
          io.say(`#${SANDBOX_NAME} already exists; I will use it.`);
          const found = await findSlackChannel(ctx, token, SANDBOX_NAME);
          if (found !== undefined) return found;
          continue;
        }
        io.say(`Slack would not create the channel (${made.ok ? 'no channel in the answer' : printable(made.error, 60)}). Pick another.`);
        continue;
      }
      if (pick === 'other') {
        const name = (
          await io.ask({
            id: 'slack-channel-name',
            text: 'Which channel? Type its name, such as snapwing-test.',
            validate: (a) => (SLACK_CHANNEL_NAME.test(a.trim().replace(/^#/, '').toLowerCase()) ? undefined : 'Slack channel names use lowercase letters, numbers, dashes, and underscores.'),
          })
        )
          .trim()
          .replace(/^#/, '')
          .toLowerCase();
        const found = await findSlackChannel(ctx, token, name);
        if (found !== undefined) return found;
        continue;
      }
      const chosen = saved.find((c) => c.id === pick);
      if (chosen !== undefined) return { platform: 'slack', id: chosen.id, name: chosen.name };
    }
  }

  /** A channel by name, joined when it is public and the bot is not in it yet; undefined (said why) otherwise. */
  async function findSlackChannel(ctx: StepContext, token: SecretValue, name: string): Promise<Sandbox | undefined> {
    const { io } = ctx;
    let channels;
    try {
      channels = await listChannels(slackBase, token);
    } catch {
      io.say('I could not reach Slack to look the channel up. Check the connection and pick again.');
      return undefined;
    }
    const found = channels.find((c) => c.name === name);
    if (found === undefined) {
      io.say(`I cannot see #${name}. If it is private, invite Snapwing to it first (type /invite @Snapwing there), then pick it again.`);
      return undefined;
    }
    if (!found.isMember) {
      if (found.isPrivate) {
        io.say(`#${name} is private and Snapwing is not in it. Type /invite @Snapwing there, then pick it again.`);
        return undefined;
      }
      if (!(await joinChannel(slackBase, token, found.id))) {
        io.say(`Snapwing could not join #${name}. Invite it there (type /invite @Snapwing), then pick it again.`);
        return undefined;
      }
      io.say(`Snapwing joined #${name}.`);
    }
    return { platform: 'slack', id: found.id, name };
  }

  /** The Teams channel for the sample: one from the map (or the Teams step), or one whose link is pasted. */
  async function teamsSandbox(ctx: StepContext, map: WorkspaceMap): Promise<Sandbox> {
    const { io } = ctx;
    const known: { id: string; name: string; teamId: string }[] = [];
    for (const c of map.channels) {
      if (c.platform === 'teams' && c.teamId !== undefined) known.push({ id: c.id, name: printable(c.name, 80), teamId: c.teamId });
    }
    for (const c of Array.isArray(ctx.data('teams')?.['channels']) ? (ctx.data('teams')?.['channels'] as JsonValue[]) : []) {
      const id = text(obj(c)?.['id']);
      const name = text(obj(c)?.['name']);
      const teamId = text(obj(c)?.['teamId']);
      if (id !== undefined && name !== undefined && teamId !== undefined && TEAMS_CHANNEL_ID.test(id) && UUID.test(teamId) && !known.some((k) => k.id === id)) {
        known.push({ id, name: printable(name, 80), teamId });
      }
    }
    const pick = await io.choose({
      id: 'teams-channel',
      text: 'Which Teams channel should the sample bug go in? Pick a quiet one: everyone in it sees the drive.',
      choices: [...known.map((c) => ({ id: c.id, label: c.name })), { id: 'link', label: 'Another channel (paste its link from Teams)' }],
      default: known.find((c) => /test|sandbox|snapwing/i.test(c.name))?.id ?? known[0]?.id ?? 'link',
      why: 'You post the sample bug there and react to it. Snapwing cannot create Teams channels, so pick one or make one yourself; Snapwing has to be added to its team.',
    });
    const chosen = known.find((c) => c.id === pick);
    if (chosen !== undefined) return { platform: 'teams', ...chosen };
    let parsed: { id: string; name: string; teamId: string } | undefined;
    await io.ask({
      id: 'teams-channel-link',
      text: 'Paste the channel link: in Teams, open the channel\'s "..." menu and choose "Get link to channel".',
      validate: (a) => {
        parsed = parseTeamsChannelLink(a);
        return parsed === undefined ? 'That is not a Teams channel link. It starts with https://teams.microsoft.com/l/channel/ and names the team.' : undefined;
      },
    });
    if (parsed === undefined) throw new Error('the Teams channel link was not read');
    return { platform: 'teams', ...parsed };
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const blocked = (reason: string, step: string): StepOutcome => {
      io.say(`${reason} Run \`snapwing onboard --step ${step}\`, then \`${RERUN}\`.`);
      return { status: 'blocked', on: 'you, finishing an earlier step', reason, link: `snapwing onboard --step ${step}` };
    };

    // ---- what the drive needs ----------------------------------------------------------------------
    const configEnv = ctx.env['SNAPWING_CONFIG']?.trim() ?? '';
    const configPath = configEnv === '' ? join(ctx.workdir, CONFIG_FILE) : resolve(ctx.workdir, configEnv);
    if (!(await exists(configPath))) return blocked(`There is no ${CONFIG_FILE} to start Snapwing from.`, 'runtime');
    const mapFile = text(ctx.data('finish')?.['map']) ?? MAP_FILE;
    const mapPath = isAbsolute(mapFile) ? mapFile : join(ctx.workdir, mapFile);
    let mapXml: string;
    try {
      mapXml = await readFile(mapPath, 'utf8');
    } catch {
      return blocked(`There is no ${MAP_FILE} yet.`, 'finish');
    }
    let map: WorkspaceMap;
    try {
      map = await parseWorkspaceMap(mapXml);
    } catch (e) {
      io.say(`${MAP_FILE} does not pass its checks: ${printable(e instanceof Error ? e.message : String(e), 200)}`);
      return { status: 'blocked', on: 'you, fixing the workspace map', reason: 'the workspace map does not pass its checks', link: 'snapwing config check' };
    }
    const repos = (Array.isArray(ctx.data('github')?.['repos']) ? (ctx.data('github')?.['repos'] as JsonValue[]) : []).filter((r): r is string => typeof r === 'string' && REPO.test(r));
    if (repos.length === 0) return blocked('The GitHub App can reach no repository yet, so there is nowhere to open the sample fix.', 'github');
    const platforms: Platform[] = [];
    const slackToken = await ctx.readEnv('SLACK_BOT_TOKEN');
    if (ctx.data('slack')?.['installed'] === true && slackToken !== undefined) platforms.push('slack');
    if (ctx.data('teams') !== undefined) platforms.push('teams');
    if (platforms.length === 0) return blocked('No chat platform is connected, so there is nowhere to post the sample bug.', 'slack');

    const last = ctx.data('test-drive');
    const lastPrs = (Array.isArray(last?.['drives']) ? last['drives'] : []).map((d) => text(obj(d)?.['pr'])).filter((p): p is string => p !== undefined);
    if (lastPrs.length > 0) io.say(`The last test drive passed (${lastPrs.join(', ')}). This runs it again.`);
    io.say('Now a test drive: one sample bug, reported the way your team will, followed all the way to a pull request.');

    // ---- the sample repository ---------------------------------------------------------------------
    const suggested = repos.find((r) => /sandbox|test|demo|playground/i.test(r)) ?? repos[0];
    const repo =
      repos.length === 1
        ? (repos[0] as string)
        : await io.choose({
            id: 'repo',
            text: 'Which repository should the sample fix go to? Pick one where a small change to the README is fine.',
            choices: repos.map((r) => ({ id: r, label: r })),
            ...(suggested === undefined ? {} : { default: suggested }),
            why: 'The drive files a real ticket and opens a real pull request there. Only the repositories the GitHub App is installed on are listed; the drive never creates a repository.',
          });
    if (repos.length === 1) io.say(`The sample fix goes to ${repo}, the one repository the GitHub App can reach.`);

    // ---- the product, and its level ----------------------------------------------------------------
    const owning = map.surfaces.find((s) => repoFullName(s.repo).toLowerCase() === repo.toLowerCase());
    const host = owning ?? map.surfaces.find((s) => s.id === map.fallbackSurface) ?? map.surfaces[0];
    if (host === undefined) return blocked('The workspace map has no products.', 'surfaces');
    if (owning === undefined) io.say(`No product in the map uses ${repo}, so for the drive only, ${host.label} sends its fix there.`);
    const level = surfaceLevel(map, host.id);
    let driveLevel: AutonomyLevelId = level;
    if (level === 1) {
      const lift = await io.choose({
        id: 'level',
        text: `${host.label} is at Ask: Snapwing waits for an engineer to tap Fix it. For this drive only, start the fix on its own (Fix now)?`,
        choices: [
          { id: 'keep', label: 'No, keep Ask; I will tap Fix it' },
          { id: 'lift', label: 'Yes, Fix now for this drive only' },
        ],
        default: 'keep',
        why: 'The drive runs on a copy of the map; the level you chose stays as it is. At Ask, an engineer from the map taps Fix it on the card Snapwing posts in the thread.',
      });
      if (lift === 'lift') driveLevel = 2;
    } else if (level === 0) {
      const lift = await io.choose({
        id: 'level',
        text: `${host.label} is at Note only: Snapwing never starts a fix there, so the drive could not reach a pull request. Use Fix now for this drive only?`,
        choices: [
          { id: 'lift', label: 'Yes, Fix now for this drive only' },
          { id: 'stop', label: 'No, skip the drive for now' },
        ],
        default: 'lift',
        why: 'The drive runs on a copy of the map; the level you chose stays as it is.',
      });
      if (lift === 'stop') {
        io.say(`Run \`${RERUN}\` when you want to try it.`);
        return { status: 'blocked', on: 'you, choosing a level that starts a fix', reason: `${host.label} is at Note only, so the drive cannot reach a pull request`, link: RERUN };
      }
      driveLevel = 2;
    } else if (level === 3) {
      io.say(`${host.label} is at Autopilot: once review and the checks pass, Snapwing may merge the sample fix by itself.`);
    }
    const lifted = driveLevel !== level;

    // ---- the sandbox channels ----------------------------------------------------------------------
    const sandboxes: Sandbox[] = [];
    for (const platform of platforms) {
      sandboxes.push(platform === 'slack' && slackToken !== undefined ? await slackSandbox(ctx, slackToken) : await teamsSandbox(ctx, map));
    }

    // ---- the drive map -----------------------------------------------------------------------------
    const surface: MapSurface = { ...host, repo: owning === undefined ? `github.com/${repo}` : host.repo };
    const drive = driveMap(map, surface, sandboxes, driveLevel, ctx.now());
    const written = await writeWorkspaceMap(drive);
    if (!written.ok) {
      for (const e of written.errors) io.say(`  ${printable(e.message, 200)}`);
      return { status: 'blocked', on: 'you, fixing the workspace map', reason: "the drive's copy of the workspace map does not pass its checks", link: 'snapwing config check' };
    }

    const base: JsonObject = { repo, surface: host.id, level: driveLevel, lifted };
    const tmp = await mkdtemp(join(tmpdir(), 'snapwing-test-drive-'));
    const interrupts = deps.interrupts ?? process;
    let interrupted = false;
    let wake: () => void = () => undefined;
    const onInterrupt = (): void => {
      interrupted = true;
      wake();
    };
    interrupts.once('SIGINT', onInterrupt);
    const sleep = (ms: number): Promise<void> =>
      new Promise((done) => {
        const timer = setTimeout(done, ms);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });

    let server: Running | undefined;
    const passed: Passed[] = [];
    try {
      const drivePath = join(tmp, MAP_FILE);
      await writeFile(drivePath, written.xml, 'utf8');

      io.say(`Starting Snapwing here for the drive${lifted ? `, with ${host.label} at Fix now for the drive only` : ''}. It stops again when the drive ends.`);
      const started = await startServe(ctx, configPath, drivePath);
      if (isFailure(started)) return failed(ctx, undefined, started, [], base);
      server = started;
      io.say('Snapwing is running.');

      for (const sandbox of sandboxes) {
        const result = await driveOne(ctx, server, sandbox, { map: drive, surface, repo, level: driveLevel, slackToken, interrupted: () => interrupted, sleep });
        if (isFailure(result)) return failed(ctx, sandbox, result, server.errors(), base, passed);
        passed.push(result);
        io.say(`The test drive passed on ${PLATFORM_NAMES[sandbox.platform]}: the pull request is open at ${result.pr}`);
      }
    } finally {
      interrupts.off('SIGINT', onInterrupt);
      if (server !== undefined) {
        io.say(passed.length > 0 ? 'Stopping Snapwing. It first finishes what it already started, such as reviewing the pull request.' : 'Stopping Snapwing.');
        await server.stop(mapXml);
      }
      await rm(tmp, { recursive: true, force: true });
    }

    io.say('Snapwing is stopped again. Run `snapwing serve` to keep it running.');
    return { status: 'done', data: { ...base, drives: passed.map(passedJson) } };
  }

  /** Says the failure (the stage, what happened, what to do) and returns the blocked outcome. */
  function failed(ctx: StepContext, sandbox: Sandbox | undefined, failure: Failure, errors: readonly string[], base: JsonObject, passed: readonly Passed[] = []): StepOutcome {
    const { io } = ctx;
    const where = sandbox === undefined ? '' : ` on ${PLATFORM_NAMES[sandbox.platform]}`;
    io.say(`The test drive stopped at ${STAGE_NAMES[failure.stage]}${where}.`);
    io.say(`What happened: ${failure.what}.`);
    io.say(`What to do: ${failure.fix}`);
    if (errors.length > 0) {
      io.say("Snapwing's log said:");
      for (const line of errors.slice(-5)) io.say(`  ${printable(line, 240)}`);
    }
    return {
      status: 'blocked',
      on: 'you, fixing what stopped the test drive',
      reason: `the drive stopped at ${STAGE_NAMES[failure.stage]}${where}: ${failure.what}`,
      link: RERUN,
      data: { ...base, drives: passed.map(passedJson), stoppedAt: failure.stage },
    };
  }

  // ---- serve, in this process ----------------------------------------------------------------------

  interface Running {
    readonly state: OpenedState;
    /** Lines serve wrote to stderr after it was ready, but the local runner warning. */
    errors(): readonly string[];
    /** Puts the written map back in the config cache, stops serve, and waits until it has stopped. */
    stop(mapXml: string): Promise<void>;
  }

  async function startServe(ctx: StepContext, configPath: string, mapPath: string): Promise<Running | Failure> {
    const serveModule = await import('../../server/serve.ts');
    const composeFn = deps.compose ?? (await import('../../server/compose.ts')).compose;
    const serve = deps.serve ?? serveModule.runServe;

    // Serve reads its secrets itself, from the `.env` this interview writes (`snapwing serve`'s own
    // default: SNAPWING_ENV_FILE, else `.env` in the working directory). They are not read here, so
    // none of them passes through the interview.
    const envFile = resolve(ctx.workdir, ctx.env['SNAPWING_ENV_FILE']?.trim() || '.env');
    const env: Record<string, string | undefined> = { ...ctx.env };
    for (const key of ['SNAPWING_DB', 'DATABASE_URL', 'SNAPWING_SQLITE_PATH', 'PORT', 'HOST']) {
      const value = (await ctx.readEnv(key))?.reveal();
      if (value !== undefined) env[key] = value;
    }
    env['SNAPWING_SQLITE_PATH'] = resolve(ctx.workdir, env['SNAPWING_SQLITE_PATH']?.trim() || SQLITE_FILE);
    env['SNAPWING_MAP'] = mapPath;

    const signals = new EventEmitter();
    const stderr: string[] = [];
    let state: OpenedState | undefined;
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((r) => (markReady = r));
    const served = serve(
      ['--config', configPath, '--env-file', envFile],
      { env, stdout: () => undefined, stderr: (line) => stderr.push(line) },
      {
        signals,
        onReady: () => markReady(),
        compose: (composeDeps) => {
          state = composeDeps.state;
          return composeFn(composeDeps);
        },
      },
    );
    const outcome = await Promise.race([ready.then(() => ({ ready: true as const })), served.then((code) => ({ code }))]);
    if ('code' in outcome || state === undefined) {
      const lines = stderr.filter((l) => !l.includes(serveModule.LOCAL_RUNNER_WARNING)).map((l) => l.replace(/^snapwing serve: /, ''));
      if ('ready' in outcome) {
        signals.emit('SIGTERM');
        await served;
      }
      return startFailure(lines);
    }
    const readyAt = stderr.length;
    const opened = state;
    let stopping: Promise<void> | undefined;
    return {
      state: opened,
      errors: () => stderr.slice(readyAt).filter((l) => !l.includes(serveModule.LOCAL_RUNNER_WARNING)).map((l) => l.replace(/^snapwing serve: /, '')),
      stop: (mapXml) =>
        (stopping ??= (async () => {
          // The drive's map went to the config cache when serve loaded it; the written one goes back.
          await opened.putConfigVersion('map', createHash('sha256').update(mapXml).digest('hex'), mapXml).catch(() => undefined);
          signals.emit('SIGTERM');
          await served;
        })()),
    };
  }

  function startFailure(lines: readonly string[]): Failure {
    const all = lines.join('\n');
    const missing = /missing secrets: ([A-Z0-9_, ]+)/.exec(all)?.[1]?.split(',').map((s) => s.trim()).filter((s) => s !== '') ?? [];
    if (missing.length > 0) {
      const steps = [...new Set(missing.map(stepForSecret))];
      return {
        stage: 'start',
        what: `these settings are missing from .env: ${missing.join(', ')}`,
        fix: `Run ${steps.map((s) => `\`snapwing onboard --step ${s}\``).join(', then ')}, then \`${RERUN}\`.`,
      };
    }
    if (/EADDRINUSE|address already in use/i.test(all)) {
      return {
        stage: 'start',
        what: 'another program, perhaps a running `snapwing serve`, already uses the port',
        fix: `Stop it, or set PORT in .env to a free port, then run \`${RERUN}\`.`,
      };
    }
    return {
      stage: 'start',
      what: printable(lines.at(-1) ?? 'it stopped without saying why', 240),
      fix: `Run \`snapwing config check\` and fix what it reports, then run \`${RERUN}\`.`,
    };
  }

  // ---- one platform ----------------------------------------------------------------------------------

  interface DriveContext {
    readonly map: WorkspaceMap;
    readonly surface: MapSurface;
    readonly repo: string;
    readonly level: AutonomyLevelId;
    readonly slackToken: SecretValue | undefined;
    interrupted(): boolean;
    sleep(ms: number): Promise<void>;
  }

  async function driveOne(ctx: StepContext, server: Running, sandbox: Sandbox, d: DriveContext): Promise<Passed | Failure> {
    const { io } = ctx;
    const where = sandbox.platform === 'slack' ? `#${sandbox.name}` : sandbox.name;
    const trigger = triggerFor(d.map, sandbox);
    const reaction = reactionLabel(sandbox.platform, trigger.name);
    const people = trigger.people > 1 ? ` (it counts once ${trigger.people} people have added it, so ask a teammate too)` : '';
    const sample = sampleBug(d.repo);
    const cursor = await logEnd(server.state);
    const webhook = ctx.data('jira')?.['webhook'] === 'registered';
    const facts: FollowFacts = { sandbox, where, reaction, repo: d.repo, webhook };

    let anchor: string | undefined;
    if (sandbox.platform === 'slack') {
      try {
        const web = createSlackWeb({ token: d.slackToken?.reveal() ?? '', baseUrl: `${slackBase}/` });
        anchor = (await web.postMessage({ channel: sandbox.id, text: sample, unfurl_links: false })).ts;
      } catch (e) {
        const why = e instanceof SlackApiError ? e.error : 'no answer';
        return {
          stage: 'post',
          what: `Slack refused the post (${printable(why, 60)})`,
          fix: `Make sure Snapwing is in ${where} (type /invite @Snapwing there), or pick another channel, then run \`${RERUN}\`.`,
        };
      }
      io.say(`Snapwing posted a sample bug in ${where}. React to it with ${reaction}${people}.`);
    } else {
      io.say(`In ${where} on Teams, post this message as yourself, then react to your post with ${reaction}${people}:`);
      io.say(`  ${sample}`);
      io.say('Teams does not let Snapwing count a reaction on its own post, so the sample has to be yours.');
    }
    io.say('I will follow it from here and say what happens. Press Ctrl-C to stop the drive.');
    return follow(ctx, server, d, facts, cursor, anchor);
  }

  interface FollowFacts {
    readonly sandbox: Sandbox;
    /** The channel as the installer sees it (`#name` on Slack). */
    readonly where: string;
    readonly reaction: string;
    readonly repo: string;
    readonly webhook: boolean;
  }

  /** What to do about a stage that stopped. */
  function fixFor(stage: DriveStage, f: FollowFacts, level: number, ref: string | undefined): string {
    const trace = ref === undefined ? '' : ` \`snapwing trace ${ref}\` shows every step it took.`;
    switch (stage) {
      case 'start':
      case 'post':
        return `Run \`${RERUN}\` again.`;
      case 'capture':
        return f.sandbox.platform === 'slack'
          ? `React to the sample in ${f.where} with ${f.reaction}. If you did, Snapwing is not getting Slack's events: check that SLACK_APP_TOKEN is in your .env file (\`snapwing onboard --step slack\` sets it), and that no other \`snapwing serve\` is running for this workspace (Slack may hand the reaction to that one). Then run \`${RERUN}\`.`
          : `Post the sample in ${f.where} and react to your post with ${f.reaction}. If you did, Microsoft is not reaching Snapwing: TEAMS_PUBLIC_URL (or SNAPWING_PUBLIC_URL) has to be a tunnel to this machine, and the team has to let Snapwing read its channel messages. Then run \`${RERUN}\`.`;
      case 'read':
        return `In the sample's thread, tap Looks right on Snapwing's card, and answer its question if it asked one.${trace} Then run \`${RERUN}\`.`;
      case 'file':
        return `Run \`snapwing onboard --step jira\` to check the Jira connection and the project, then \`${RERUN}\`.${trace}`;
      case 'begin':
        return (
          (level === 1 ? 'An engineer from the workspace map has to tap Fix it on the card in the thread. ' : '') +
          (f.webhook
            ? 'Check in Jira that the ticket reached In Progress.'
            : 'Without a Jira webhook, Snapwing sees In Progress only on its check every 15 minutes; `snapwing onboard --step jira` sets the webhook up once Snapwing has a public address.') +
          `${trace} Then run \`${RERUN}\`.`
        );
      case 'fix':
        return `${trace.trim()} Check that the GitHub App can push to ${f.repo} (\`snapwing onboard --step github\`) and that the model keys work (\`snapwing onboard --step runtime\`), then run \`${RERUN}\`.`.trim();
    }
  }

  /** Follows the event log from `cursor` to the capture of the sample, then that incident to its pull request. */
  async function follow(ctx: StepContext, server: Running, d: DriveContext, f: FollowFacts, start: string, anchor: string | undefined): Promise<Passed | Failure> {
    const { io } = ctx;
    const { state } = server;
    let stage: DriveStage = 'capture';
    let since = Date.now();
    let cursor = start;
    let incident: string | undefined;
    let next = 1;
    let jiraKey: string | undefined;
    let level: number = d.level;
    let reporterRole = 'unknown';
    const said = new Set<string>();
    const sayOnce = (key: string, line: string): void => {
      if (said.has(key)) return;
      said.add(key);
      io.say(line);
    };
    const move = (to: DriveStage): void => {
      if (STAGES.indexOf(to) > STAGES.indexOf(stage)) {
        stage = to;
        since = Date.now();
      }
    };
    const fail = (at: DriveStage, what: string, fix?: string): Failure => ({ stage: at, what, fix: fix ?? fixFor(at, f, level, jiraKey ?? incident) });
    const pass = (prNumber: number): Passed => ({
      platform: f.sandbox.platform,
      channel: f.sandbox.id,
      channelName: f.sandbox.name,
      incident: incident ?? '',
      ...(jiraKey === undefined ? {} : { jiraKey }),
      pr: `https://github.com/${f.repo}/pull/${prNumber}`,
    });
    const ours = (e: IncidentEvent): boolean => {
      if (e.type !== 'captured' || e.payload.kind !== 'incident' || e.payload.source !== f.sandbox.platform || e.payload.channelId !== f.sandbox.id) return false;
      return anchor === undefined || e.payload.anchorId === anchor || e.payload.idempotencyKey.includes(anchor);
    };
    const engineers = (): string => {
      const owners = d.map.people.filter((p) => p.role === 'engineer' && p.owns.some((o) => o.surface === d.surface.id)).map((p) => p.handle);
      const all = owners.length > 0 ? owners : d.map.people.filter((p) => p.role === 'engineer').map((p) => p.handle);
      return all.length === 0 ? 'an engineer' : all.slice(0, 3).join(' or ');
    };

    /** One event of the drive's incident: what to say, and the drive's end when it ends it. */
    const on = (e: IncidentEvent): Passed | Failure | undefined => {
      switch (e.type) {
        case 'captured':
          reporterRole = e.payload.reporter.role;
          io.say('Saw the reaction. Snapwing is reading the conversation.');
          move('read');
          return undefined;
        case 'bot-message-posted':
          if (e.payload.role === 'scope-preview') sayOnce('scope', 'Snapwing posted what it read as a card in the thread. Tap Looks right on it.');
          if (e.payload.role === 'dedupe') sayOnce('dedupe', 'Snapwing found a ticket that looks like this one. Tap Create anyway on its card: the drive needs a ticket of its own.');
          if (e.payload.role === 'fix-preview' && level === 1) {
            sayOnce('fix-it', 'Tap Fix it on the card in the thread to start the fix.');
            if (reporterRole !== 'engineer') sayOnce('fix-it-who', `Fix it takes an engineer from the workspace map, such as ${engineers()}. Ask one of them to tap it.`);
          }
          return undefined;
        case 'clarified':
          io.say(`Snapwing asked in the thread: "${printable(e.payload.question)}" Answer it there.`);
          return undefined;
        case 'tapped':
          if (e.payload.card === 'fix-preview' && e.payload.choice === 'approve_fix') {
            sayOnce('fixing', 'Got Fix it.');
            if (!f.webhook) sayOnce('in-progress', 'Next, Jira has to report the ticket In Progress. Without a Jira webhook Snapwing checks every 15 minutes, so this can take a while.');
          }
          return undefined;
        case 'resolved': {
          const went = e.payload.repo === undefined ? undefined : repoFullName(e.payload.repo);
          if (went !== undefined && went.toLowerCase() !== f.repo.toLowerCase()) {
            return fail('read', `the report went to ${printable(went, 80)}, not ${f.repo}`, `Check the map with \`snapwing map show\`, then run \`${RERUN}\`.`);
          }
          if (e.payload.surfaceId !== undefined) sayOnce('resolved', `It is about ${printable(d.map.surfaces.find((s) => s.id === e.payload.surfaceId)?.label ?? e.payload.surfaceId, 80)}; the fix goes to ${f.repo}.`);
          return undefined;
        }
        case 'planned': {
          if (e.payload.action !== 'create_issue') return fail('read', 'Snapwing decided not to file a ticket for the sample');
          level = e.payload.autonomyLevel ?? level;
          if (level === 0) {
            return fail(
              'file',
              e.payload.capped === undefined ? 'it was planned at Note only, which never starts a fix' : 'only a guest reacted, so it was held back to a level that never starts a fix',
              `React with ${f.reaction} as a member of the workspace, and use Fix now for the drive, then run \`${RERUN}\`.`,
            );
          }
          sayOnce('planned', `Planned "${printable(e.payload.summary ?? 'the sample bug', 120)}" at ${LEVEL_NAMES[level] ?? `level ${level}`}.`);
          // At Ask the ticket is filed once Fix it is tapped, so the wait from here is for the tap.
          move(level === 1 ? 'begin' : 'file');
          return undefined;
        }
        case 'filed':
          jiraKey = e.payload.jiraKey;
          io.say(`Filed ${printable(jiraKey, 40)} in Jira.`);
          move('begin');
          if (level >= 2 && !f.webhook) sayOnce('in-progress', 'Next, Jira has to report the ticket In Progress. Without a Jira webhook Snapwing checks every 15 minutes, so this can take a while.');
          return undefined;
        case 'jira-transitioned':
          io.say(`${printable(e.payload.jiraKey, 40)} moved to ${printable(e.payload.to, 40)}.`);
          return undefined;
        case 'fixer-started':
          io.say('Snapwing started the fix.');
          move('fix');
          return undefined;
        case 'fixer-checkpoint': {
          const line = PHASES[e.payload.phase];
          if (line !== undefined) io.say(line);
          return undefined;
        }
        case 'pr-opened':
          return pass(e.payload.prNumber);
        case 'fixer-done':
          return pass(e.payload.prNumber);
        case 'fixer-failed':
          return fail('fix', `the fix failed: ${printable(e.payload.reason, 200)}`);
        case 'stopped':
          return fail(stage, 'someone tapped Stop', `Run \`${RERUN}\` again and let it run.`);
        case 'not-a-bug':
          return fail(stage, 'it was marked not a bug', `Run \`${RERUN}\` again.`);
        case 'linked-to-existing':
          return fail('read', `Snapwing linked it to ${printable(e.payload.issueKey, 40)} instead of filing a new ticket`, `Run \`${RERUN}\` again and tap Create anyway on the card that offers the existing ticket.`);
        case 'resolution-signal':
          return fail('read', 'Snapwing read the thread as already fixed', `Run \`${RERUN}\` again and leave the sample's thread as it is.`);
        case 'capture-cancelled':
          return fail('read', 'the report was cancelled', `Run \`${RERUN}\` again.`);
        case 'closed':
          return fail(stage, 'the incident was closed before a pull request opened', `Run \`${RERUN}\` again.`);
        default:
          return undefined;
      }
    };

    for (;;) {
      if (d.interrupted()) throw new InterviewAborted('test-drive.drive', 'stopped');
      if (incident === undefined) {
        const page = await state.readSince(cursor, 200);
        cursor = page.cursor;
        const captured = page.events.find(ours);
        if (captured !== undefined) {
          incident = captured.incidentId;
          next = captured.seq;
        }
      }
      if (incident !== undefined) {
        const events = await state.read(incident, next);
        for (const e of events) {
          next = e.seq + 1;
          const end = on(e);
          if (end !== undefined) return end;
        }
      }
      if (Date.now() - since >= waits[stage]) {
        const keep = await io.choose({
          id: 'keep-waiting',
          text: `Still waiting on ${STAGE_NAMES[stage]}. Keep waiting?`,
          choices: [
            { id: 'wait', label: 'Yes, keep waiting' },
            { id: 'stop', label: 'No, stop the test drive' },
          ],
          default: 'wait',
          why: fixFor(stage, f, level, jiraKey ?? incident),
        });
        if (keep === 'stop') return fail(stage, `${STAGE_TIMEOUTS[stage]} (you stopped waiting)`);
        since = Date.now();
      }
      await d.sleep(pollMs);
      if (d.interrupted()) throw new InterviewAborted('test-drive.drive', 'stopped');
    }
  }

  return { id: 'test-drive', number: 9, title: 'Try it once', needs: ['finish', ['slack', 'teams']], run };
}

/** The end of the event log now: the drive reads only what comes after it. */
async function logEnd(state: OpenedState): Promise<string> {
  let cursor = LOG_START;
  for (;;) {
    const page = await state.readSince(cursor, 1000);
    if (page.events.length === 0) return page.cursor;
    cursor = page.cursor;
  }
}

/**
 * The drive's copy of the map: the sandbox channels belong to `surface` (whose repository is the
 * sample), and `surface` runs at `level`. Other products' channels and levels are as written; the
 * priority and component overrides that could move the drive's level are left out.
 */
function driveMap(map: WorkspaceMap, surface: MapSurface, sandboxes: readonly Sandbox[], level: AutonomyLevelId, now: Date): WorkspaceMap {
  const sandboxIds = new Set(sandboxes.map((s) => s.id));
  const channels: MapChannel[] = [
    ...map.channels.filter((c) => !sandboxIds.has(c.id)),
    ...sandboxes.map((s): MapChannel => {
      const before = map.channels.find((c) => c.id === s.id);
      return {
        id: s.id,
        name: before?.name ?? s.name,
        surface: surface.id,
        confidence: 'explicit',
        ...(s.platform === 'teams' ? { platform: 'teams' as const, teamId: s.teamId ?? before?.teamId ?? '' } : {}),
        triggerEmoji: [...(before?.triggerEmoji ?? [])],
      };
    }),
  ];
  const overrides: AutonomyOverride[] = [
    ...map.policies.autonomy.overrides.filter((o) => o.kind === 'surface' && o.ref !== surface.id),
    { kind: 'surface', ref: surface.id, level },
  ];
  return {
    ...map,
    updated: now.toISOString(),
    surfaces: map.surfaces.map((s) => (s.id === surface.id ? surface : s)),
    channels,
    policies: { ...map.policies, autonomy: { ...map.policies.autonomy, overrides } },
  };
}

function passedJson(p: Passed): JsonObject {
  return {
    platform: p.platform,
    channel: p.channel,
    channelName: p.channelName,
    incident: p.incident,
    ...(p.jiraKey === undefined ? {} : { jiraKey: p.jiraKey }),
    pr: p.pr,
  };
}

export const testDriveStep: OnboardStep = createTestDriveStep();
