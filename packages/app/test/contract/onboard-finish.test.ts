// Onboarding trigger, autonomy, and finish steps (main 22.2, 4.3, 4.6; #18): the default reaction accepted,
// a reaction Teams lacks, a reaction Slack lacks (standard and custom), a second reaction, a channel
// override, the autonomy levels and who chose them, then the map written and validated, an invalid map
// that names the step to fix and writes nothing, and the rerun with a map already on disk. The steps
// before these are seeded: each stand-in returns the data the real step saves.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type JsonObject, type OnboardingStore } from '../../src/onboard/interview/state.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import { autonomyStep } from '../../src/onboard/steps/autonomy.ts';
import { finishStep, stepForError } from '../../src/onboard/steps/finish.ts';
import { parseReactionName, teamsNameFor, triggerStep } from '../../src/onboard/steps/trigger.ts';

const SLACK_TOKEN = 'xoxb-test-token-0123456789';
const WHEN = new Date('2026-10-08T12:00:00.000Z');

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let dir: string;
let emojiListCalls: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-finish-'));
  emojiListCalls = 0;
  server.use(
    http.get('https://slack.com/api/emoji.list', ({ request }) => {
      emojiListCalls += 1;
      if (request.headers.get('authorization') !== `Bearer ${SLACK_TOKEN}`) return HttpResponse.json({ ok: false, error: 'invalid_auth' });
      return HttpResponse.json({ ok: true, emoji: { partyparrot: 'https://emoji.example/partyparrot.gif', shipit: 'alias:rocket' } });
    }),
  );
});
afterEach(async () => {
  server.resetHandlers();
  await rm(dir, { recursive: true, force: true });
});

const surfaces: JsonObject = {
  surfaces: [
    { id: 'web', label: 'Web app', repo: 'acme/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [{ id: 'nav', label: 'Navigation' }] },
    { id: 'admin', label: 'Admin', repo: 'acme/admin', jira: { project: 'ADM', defaultIssueType: 'Bug' }, components: [] },
  ],
  channels: [
    { id: 'C1', name: 'web-bugs', surface: 'web', confidence: 'explicit', triggerEmoji: [] },
    { id: 'C2', name: 'alerts', surface: 'from-payload', triggerEmoji: [] },
  ],
};
const words: JsonObject = { vocabulary: [{ text: 'the portal', surface: 'admin' }] };
const people: JsonObject = {
  people: [{ slackId: 'U1', handle: 'webDev1', email: 'dana@example.com', role: 'engineer', owns: [{ surface: 'web', primary: true }] }],
};

const stub = (id: string, number: number, data: JsonObject | undefined, needs: OnboardStep['needs'] = []): OnboardStep => ({
  id,
  number,
  title: id,
  needs,
  run: () => Promise.resolve(data === undefined ? { status: 'skipped', reason: 'not used' } : { status: 'done', data }),
});

interface Seed {
  slack?: boolean;
  teams?: boolean;
  surfaces?: JsonObject;
  words?: JsonObject;
  people?: JsonObject;
}

function steps(seed: Seed = {}): OnboardStep[] {
  return [
    stub('slack', 1, seed.slack === false ? undefined : { workspace: 'acme' }),
    stub('teams', 1, seed.teams === true ? { tenant: 'acme' } : undefined),
    stub('surfaces', 4, seed.surfaces ?? surfaces),
    stub('words', 5, seed.words ?? words),
    stub('people', 6, seed.people ?? people),
    triggerStep,
    autonomyStep,
    finishStep,
  ];
}

interface MemoryStore {
  readonly store: OnboardingStore;
  readonly raw: Map<string, string>;
}
function memoryStore(): MemoryStore {
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

async function interview(
  answers: readonly string[],
  options: { seed?: Seed; env?: Record<string, string>; memory?: MemoryStore; only?: string } = {},
): Promise<{ result: InterviewResult; lines: string[]; asked: readonly string[]; stateText: string }> {
  const memory = options.memory ?? memoryStore();
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const result = await runInterview({
    steps: steps(options.seed),
    store: memory.store,
    io,
    workdir: dir,
    env: { SNAPWING_SQLITE_PATH: join(dir, 'snapwing.sqlite'), ...options.env },
    now: () => WHEN,
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  return { result, lines, asked: prompter.asked, stateText: [...memory.raw.values()].join('\n') };
}

/** Choice questions are typed by position, 1 first: level N is position N + 1. */
const pick = (level: number): string => String(level + 1);
const mapPath = (): string => join(dir, 'workspace-context.xml');
const readMap = async () => parseWorkspaceMap(await readFile(mapPath(), 'utf8'));
const mapExists = (): Promise<boolean> => stat(mapPath()).then(() => true, () => false);

describe('onboarding trigger, autonomy, and finish', () => {
  it('accepts the defaults: bug, Ask for everything, then writes, checks, and shows the map', async () => {
    // trigger: reaction, anything else; autonomy: level, any different, who; finish: capture token.
    const { result, lines, stateText } = await interview(['', '', '', '', 'owner@example.com', '']);
    expect(result.outcome).toBe('complete');
    for (const id of ['trigger', 'autonomy', 'finish']) expect(result.state.steps[id]?.status, id).toBe('done');
    expect(result.state.steps['trigger']?.data).toMatchObject({ emoji: [{ slack: 'bug', teams: 'bug' }], channelOverrides: [] });

    const map = await readMap();
    expect(map.triggers.emoji).toEqual([{ slack: 'bug', teams: 'bug' }]);
    expect(map.policies.autonomy).toMatchObject({ default: 1, changedBy: 'owner@example.com', changedAt: WHEN.toISOString(), overrides: [] });
    expect(map.updated).toBe(WHEN.toISOString());
    expect(map.surfaces.map((s) => s.id)).toEqual(['web', 'admin']);
    expect(map.vocabulary).toEqual([{ text: 'the portal', surface: 'admin' }]);
    expect(map.people.map((p) => p.handle)).toEqual(['webDev1']);

    const text = lines.join('\n');
    expect(text).toMatch(/Ask \(level 1\)/);
    expect(text).toMatch(/Recorded: Ask for everything/);
    expect(text).toContain('ok: ' + mapPath());
    expect(text).toMatch(/\d+ errors?, \d+ warnings?|0 errors, 0 warnings/);
    expect(text).toMatch(/surfaces\n\s+id\s+label/);
    expect(text).toMatch(/triggers\n/);
    expect(stateText).not.toContain(SLACK_TOKEN);
  });

  it('says no step numbers to the installer', async () => {
    const { lines } = await interview(['', '', '', '', 'owner@example.com', '']);
    expect(lines.join('\n')).not.toMatch(/\bsteps? \d/i);
  });

  it('finds the reaction on both platforms before accepting it', async () => {
    const { result, lines } = await interview(['', '', '', '', 'owner@example.com', ''], { seed: { teams: true } });
    expect(result.state.steps['trigger']?.data).toMatchObject({ platforms: ['slack', 'teams'] });
    expect(lines.join('\n')).not.toMatch(/Teams has no reaction/);
  });

  it('a reaction Teams lacks: pick another for everyone, or name the one Teams people use', async () => {
    const again = await interview(['rocket', 'again', '', '', '', '', 'owner@example.com', ''], { seed: { teams: true } });
    expect(again.lines.join('\n')).toMatch(/Teams has no reaction called rocket/);
    expect((await readMap()).triggers.emoji).toEqual([{ slack: 'bug', teams: 'bug' }]);

    await rm(mapPath());
    const mapped = await interview(['rocket', 'map', 'ladybug', '', '', '', 'owner@example.com', ''], { seed: { teams: true } });
    expect(mapped.result.state.steps['trigger']?.data).toMatchObject({ emoji: [{ slack: 'rocket', teams: 'ladybug' }] });
    expect((await readMap()).triggers.emoji).toEqual([{ slack: 'rocket', teams: 'ladybug' }]);

    // Teams only needs a name in its own table.
    const refused = await interview(['rocket', 'map', 'rocket', 'fire', '', '', '', 'owner@example.com', ''], { seed: { teams: true } });
    expect(refused.lines.join('\n')).toMatch(/Teams has no such reaction/);
  });

  it('checks a Slack reaction against the workspace custom emoji, and asks again for one it does not have', async () => {
    const { result, lines, stateText } = await interview(['nopenope', 'again', 'partyparrot', '', '', '', 'owner@example.com', ''], {
      env: { SLACK_BOT_TOKEN: SLACK_TOKEN },
    });
    expect(emojiListCalls).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/Slack does not have a reaction called nopenope/);
    expect(result.state.steps['trigger']?.data).toMatchObject({ emoji: [{ slack: 'partyparrot', teams: 'partyparrot' }] });
    expect(stateText).not.toContain(SLACK_TOKEN);
    expect((await readMap()).triggers.emoji).toEqual([{ slack: 'partyparrot', teams: 'partyparrot' }]);
  });

  it('uses a Slack name it cannot confirm when the installer says so, and says when it could not look', async () => {
    const kept = await interview(['nopenope', 'keep', '', '', '', 'owner@example.com', ''], { env: { SLACK_BOT_TOKEN: SLACK_TOKEN } });
    expect(kept.result.state.steps['trigger']?.data).toMatchObject({ unchecked: ['slack'] });

    await rm(mapPath());
    const noToken = await interview(['nopenope', '', '', '', 'owner@example.com', '']);
    expect(noToken.lines.join('\n')).toMatch(/Could not read your Slack custom emoji/);
  });

  it('offers a second reaction with the number of people it takes', async () => {
    const { result } = await interview(['', 'second', 'fire', '3', '', '', '', 'owner@example.com', '']);
    expect(result.state.steps['trigger']?.data).toMatchObject({ emoji: [{ slack: 'bug', teams: 'bug' }, { slack: 'fire', teams: 'fire', minReactors: 3 }] });
    expect((await readMap()).triggers.emoji).toEqual([
      { slack: 'bug', teams: 'bug' },
      { slack: 'fire', teams: 'fire', minReactors: 3 },
    ]);
  });

  it('will not take the same reaction twice or one that is not a reaction name', async () => {
    const { lines } = await interview(['', 'second', 'bug', 'two words', 'fire', '', '', '', '', 'owner@example.com', '']);
    expect(lines.join('\n')).toMatch(/bug is already a trigger/);
    expect(lines.join('\n')).toMatch(/Type the reaction by its name/);
  });

  it('offers a channel override only when asked, and writes it on that channel', async () => {
    const plain = await interview(['', '', '', '', 'owner@example.com', '']);
    expect(plain.asked.some((q) => q.startsWith('Which channel?'))).toBe(false);

    await rm(mapPath());
    // Channel 1 is web-bugs.
    const { result } = await interview(['', 'channel', '1', 'ladybug', '', '', '', 'owner@example.com', '']);
    expect(result.state.steps['trigger']?.data).toMatchObject({ channelOverrides: [{ channel: 'C1', emoji: ['ladybug'] }] });
    const map = await readMap();
    expect(map.channels.find((c) => c.id === 'C1')?.triggerEmoji).toEqual(['ladybug']);
    expect(map.channels.find((c) => c.id === 'C2')?.triggerEmoji).toEqual([]);
  });

  it('describes the four levels, recommends Ask, and records who chose a level per product and when', async () => {
    // level Ask, some products differ, web at Fix now (position 3), admin as is, who.
    const { result, lines } = await interview(['', '', '', 'yes', pick(2), '', 'owner@example.com', '']);
    const text = lines.join('\n');
    for (const name of ['Note only (level 0)', 'Ask (level 1)', 'Fix now (level 2)', 'Autopilot (level 3)']) expect(text).toContain(name);
    expect(text).toMatch(/Ask is where to start/);
    expect(result.state.steps['autonomy']?.data).toMatchObject({
      default: 1,
      changedBy: 'owner@example.com',
      overrides: [{ kind: 'surface', ref: 'web', level: 2, changedBy: 'owner@example.com', changedAt: WHEN.toISOString() }],
    });
    const { autonomy } = (await readMap()).policies;
    expect(autonomy.default).toBe(1);
    expect(autonomy.overrides).toEqual([{ kind: 'surface', ref: 'web', level: 2, changedBy: 'owner@example.com', changedAt: WHEN.toISOString() }]);
  });

  it('warns about a start above Ask and about Autopilot', async () => {
    const { lines } = await interview(['', '', pick(3), '', 'owner@example.com', '']);
    expect(lines.join('\n')).toMatch(/Autopilot is your choice\. Starting at Ask/);
    expect(lines.join('\n')).toMatch(/Autopilot merges code without a person reading it/);
    expect((await readMap()).policies.autonomy.default).toBe(3);
  });

  it('keeps the saved levels on a rerun, or asks again', async () => {
    const memory = memoryStore();
    await interview(['', '', '', '', 'owner@example.com', ''], { memory });
    const kept = await interview([''], { memory, only: 'autonomy' });
    expect(kept.lines.join('\n')).toMatch(/Saved: Ask for everything.*chosen by owner@example\.com/);
    expect(kept.asked.filter((q) => q.includes('Choose'))).toHaveLength(1);
    const changed = await interview(['change', pick(0), '', 'second@example.com'], { memory, only: 'autonomy' });
    expect(changed.result.state.steps['autonomy']?.data).toMatchObject({ default: 0, changedBy: 'second@example.com' });
  });

  it('writes a map that validates, with the XSD and the Schematron', async () => {
    await interview(['', '', '', '', 'owner@example.com', '']);
    const xml = await readFile(mapPath(), 'utf8');
    expect(xml).toContain('xmlns="urn:snapwing:workspace:v1"');
    await expect(parseWorkspaceMap(xml)).resolves.toMatchObject({ org: 'workspace' });
    expect((await stat(mapPath())).isFile()).toBe(true);
  });

  it('writes nothing and names the step to fix when a channel names a product that is not there', async () => {
    const bad: JsonObject = { ...surfaces, channels: [{ id: 'C1', name: 'web-bugs', surface: 'ghost', triggerEmoji: [] }] };
    const { result, lines } = await interview(['', '', '', '', 'owner@example.com'], { seed: { surfaces: bad } });
    expect(await mapExists()).toBe(false);
    const finish = result.state.steps['finish'];
    expect(finish?.status).toBe('blocked');
    expect(finish?.blocked?.link).toBe('snapwing onboard --step surfaces');
    expect(lines.join('\n')).toMatch(/ghost.*go back to: surfaces/);
    expect(lines.join('\n')).toMatch(/Nothing was written/);
    expect(result.outcome).toBe('waiting');
  });

  it('sends the installer to the people step when an owner names a product that is not there', async () => {
    const bad: JsonObject = { people: [{ handle: 'webDev1', role: 'engineer', owns: [{ surface: 'nowhere' }] }] };
    const { result } = await interview(['', '', '', '', 'owner@example.com'], { seed: { people: bad } });
    expect(await mapExists()).toBe(false);
    expect(result.state.steps['finish']?.blocked?.link).toBe('snapwing onboard --step people');
  });

  it('sends the installer back to surfaces when none were saved or a saved row cannot be read', async () => {
    const none = await interview(['', '', '', '', 'owner@example.com'], { seed: { surfaces: { surfaces: [], channels: [] } } });
    expect(none.result.state.steps['finish']?.blocked?.link).toBe('snapwing onboard --step surfaces');
    const garbled = await interview(['', '', '', '', 'owner@example.com'], { seed: { surfaces: { surfaces: ['web'], channels: [] } } });
    expect(garbled.result.state.steps['finish']?.blocked?.link).toBe('snapwing onboard --step surfaces');
    expect(await mapExists()).toBe(false);
  });

  it('names the step for each kind of finding', () => {
    expect(stepForError({ message: 'x', rule: 'owns-surface-exists' })).toBe('people');
    expect(stepForError({ message: 'x', rule: 'override-component-ref' })).toBe('autonomy');
    expect(stepForError({ message: 'x', rule: 'channel-teams-needs-team' })).toBe('surfaces');
    expect(stepForError({ message: 'Element term has a bad attribute' })).toBe('words');
    expect(stepForError({ message: 'Element emoji is missing attribute teams' })).toBe('trigger');
    expect(stepForError({ message: 'something else' })).toBe('surfaces');
  });

  it('asks before replacing a map that is already there, and keeps it when told to', async () => {
    const memory = memoryStore();
    await interview(['', '', '', '', 'owner@example.com', ''], { memory });
    const before = await readFile(mapPath(), 'utf8');

    const kept = await interview(['keep'], { memory, only: 'finish' });
    expect(kept.result.state.steps['finish']?.data).toMatchObject({ written: false });
    expect(await readFile(mapPath(), 'utf8')).toBe(before);

    const replaced = await interview(['replace', ''], { memory, only: 'finish' });
    expect(replaced.result.state.steps['finish']?.data).toMatchObject({ written: true });
  });

  it('offers the installer a capture token, shown once and never saved', async () => {
    const { result, lines, stateText } = await interview(['', '', '', '', 'owner@example.com', '2']);
    expect(result.state.steps['finish']?.data).toMatchObject({ tokenFor: 'webDev1' });
    const at = lines.findIndex((l) => l.startsWith('They run'));
    expect(at).toBeGreaterThan(2);
    const token = lines[at - 2] ?? '';
    expect(token.length).toBeGreaterThan(16);
    expect(lines.join('\n')).toMatch(/snapwing login --url/);
    expect(stateText).not.toContain(token);
  });

  it('parses reaction names as typed', () => {
    expect(parseReactionName(':Bug:')).toBe('bug');
    expect(parseReactionName('🐛')).toBe('bug');
    expect(parseReactionName('two words')).toBeUndefined();
    expect(teamsNameFor('octagonal_sign')).toBe('stop');
    expect(teamsNameFor('rocket')).toBeUndefined();
  });
});
