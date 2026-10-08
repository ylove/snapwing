// Onboarding step 1, Teams (main 22.2, ADR 0005), against MSW: a full install, reduced mode, custom app
// upload turned off, an existing Snapwing, a bad secret asked again, and a saved bot checked again on a rerun.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPH_BASE_URL } from '../../src/adapters/teams/graph.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type OnboardingStore } from '../../src/onboard/interview/state.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { manifestRscPermissions, TEAMS_APP_VERSION } from '../../src/onboard/teams/install.ts';
import { createTeamsStep } from '../../src/onboard/steps/teams.ts';
import { installedSnapwing, teamsOnboardHandlers, teamsTenant, type TeamsTenant } from '../fixtures/onboard/teams.ts';

const G = GRAPH_BASE_URL;
const LOGIN = 'https://login.test';
const TENANT = 'aaaaaaaa-1111-2222-3333-444444444444';
const APP_ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'client-secret-value-0123';
const BAD_SECRET = 'wrong-secret-value-9876';
const OWNER_TOKEN = 'owner-token-secret';
const PUBLIC = 'https://snap.example.test';
const TEAM = 'team-1';
const RSC = manifestRscPermissions();

let tenant: TeamsTenant;

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

beforeEach(() => {
  tenant = teamsTenant({
    secrets: new Set([SECRET]),
    teams: [{ id: TEAM, displayName: 'Acme Engineering' }],
    channels: [
      { id: '19:bugs@thread.tacv2', displayName: 'Bugs' },
      { id: '19:general@thread.tacv2', displayName: 'General' },
    ],
  });
  server.use(...teamsOnboardHandlers(tenant, { login: LOGIN, graph: G, tenantId: TENANT, appId: APP_ID, team: TEAM, appToken: 'app-token', ownerToken: OWNER_TOKEN }));
});
afterEach(() => server.resetHandlers());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-teams-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runtime: OnboardStep = { id: 'runtime', title: 'Runtime', needs: [], run: () => Promise.resolve({ status: 'done' }) };
const later: OnboardStep = { id: 'later', title: 'Later', needs: ['runtime'], run: () => Promise.resolve({ status: 'done' }) };

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

interface InterviewOptions {
  readonly env?: Record<string, string>;
  readonly memory?: MemoryStore;
  readonly only?: string;
}

async function interview(
  answers: readonly string[],
  options: InterviewOptions = {},
): Promise<{ result: InterviewResult; lines: string[]; envText: string; stateText: string; asked: readonly string[] }> {
  const memory = options.memory ?? memoryStore();
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const step = createTeamsStep({ loginHost: LOGIN, sleep: () => Promise.resolve() });
  const result = await runInterview({
    steps: [runtime, step, later],
    store: memory.store,
    io,
    workdir: dir,
    env: options.env ?? { SNAPWING_PUBLIC_URL: PUBLIC },
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  let envText = '';
  try {
    envText = await readFile(join(dir, '.env'), 'utf8');
  } catch {
    // never written
  }
  return { result, lines, envText, stateText: [...memory.raw.values()].join('\n'), asked: prompter.asked };
}

/** Never a secret in what the installer reads or in the saved state. */
function expectNoSecrets(texts: readonly string[], ...secrets: string[]): void {
  const text = texts.join('\n');
  for (const s of secrets) expect(text).not.toContain(s);
}

// Use Teams (the default), app id, tenant id, client secret, then the bug channel.
const FRESH = ['', APP_ID, TENANT, SECRET, 'Bugs'];

describe('onboarding step 1: Teams', () => {
  it('reads the bot, signs the owner in, installs with the grants, and reports full mode', async () => {
    const { result, lines, envText, stateText, asked } = await interview(FRESH);
    expect(result.outcome).toBe('complete');
    expect(result.state.steps['teams']?.status).toBe('done');
    expect(result.state.steps['teams']?.data).toEqual({
      appId: APP_ID,
      tenantId: TENANT,
      registered: true,
      teams: [{ id: TEAM, name: 'Acme Engineering', mode: 'full' }],
      teamId: TEAM,
      teamIds: [TEAM],
      mode: 'full',
      channels: [{ id: '19:bugs@thread.tacv2', name: 'Bugs', teamId: TEAM }],
    });
    expect(tenant.published).toBe(1);
    expect(tenant.grants).toEqual(RSC);
    expect(tenant.ownerSignIns).toBe(1);

    expect(envText).toContain(`TEAMS_APP_ID=${APP_ID}`);
    expect(envText).toContain(`TEAMS_TENANT_ID=${TENANT}`);
    expect(envText).toContain(`TEAMS_APP_PASSWORD=${SECRET}`);
    expect(envText).not.toContain('TEAMS_PUBLIC_URL');
    expect(envText).not.toContain(OWNER_TOKEN);
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);

    const text = lines.join('\n');
    expect(text).toMatch(/Microsoft has no API for that without an Azure subscription/);
    expect(text).toContain('https://dev.teams.microsoft.com/bots');
    expect(text).toMatch(/enter the code ABCD-1234/);
    expect(text).toMatch(/Acme Engineering: full mode/);
    expect(asked.some((q) => q.includes('client secret'))).toBe(true);
    expectNoSecrets([stateText, text], SECRET, OWNER_TOKEN);
    expect(text).not.toMatch(/\bstep \d/i);
  });

  it('asks for the address when nothing names one, and saves it as the Teams address', async () => {
    const { result, envText } = await interview([...FRESH.slice(0, 4), 'https://teams.example.test/', 'Bugs'], { env: {} });
    expect(result.state.steps['teams']?.status).toBe('done');
    expect(envText).toContain('TEAMS_PUBLIC_URL=https://teams.example.test');
  });

  it('reports reduced mode with the one-sentence grant and the owner link when the grant is missing', async () => {
    tenant.grantOnInstall = RSC.filter((p) => p !== 'ChannelMessage.Read.Group');
    const { result, lines } = await interview(FRESH);
    expect(result.state.steps['teams']?.status).toBe('done');
    expect(result.state.steps['teams']?.data).toMatchObject({ mode: 'reduced', teams: [{ id: TEAM, mode: 'reduced' }] });
    const reduced = lines.find((l) => l.includes('reduced mode'));
    expect(reduced).toMatch(/A team owner has to approve Snapwing reading channel messages, by adding it to the team from https:\/\/teams\.microsoft\.com\/l\/app\/cat-1;/);
  });

  it('prints the admin center steps and blocks when custom app upload is off, and the later steps run', async () => {
    tenant.uploadDisabled = true;
    const first = await interview(FRESH);
    expect(first.result.outcome).toBe('waiting');
    const record = first.result.state.steps['teams'];
    expect(record?.status).toBe('blocked');
    expect(record?.blocked).toMatchObject({ on: 'a Teams admin' });
    expect(record?.data).toMatchObject({ appId: APP_ID, channels: [{ name: 'Bugs', teamId: TEAM }] });
    expect(first.result.state.steps['later']?.status).toBe('done');

    const text = first.lines.join('\n');
    expect(text).toMatch(/custom app upload or install is turned off/);
    expect(text).toMatch(/1\. Open the Teams admin center/);
    expect(text).toMatch(/2\. In Teams, open the team/);
    expect(text).toContain(join(dir, 'snapwing-teams-app.zip'));
    expect((await stat(join(dir, 'snapwing-teams-app.zip'))).size).toBeGreaterThan(0);
    expect(tenant.published).toBe(0);
  });

  it('warns about another Snapwing in the team and carries on with the existing install', async () => {
    tenant.catalog = { id: 'cat-1', versions: [TEAMS_APP_VERSION] };
    tenant.installed = [installedSnapwing(APP_ID), { id: 'inst-9', teamsApp: { id: 'cat-9', externalId: 'other', displayName: 'Snapwing' } }];
    tenant.grants = RSC;
    const { result, lines } = await interview(FRESH);
    expect(result.state.steps['teams']?.status).toBe('done');
    expect(result.state.steps['teams']?.data).toMatchObject({ mode: 'full' });
    expect(tenant.published).toBe(0);
    expect(lines.join('\n')).toMatch(/Heads up: another app named Snapwing is installed in the team \(cat-9\)/);
  });

  it('asks again after Microsoft refuses the secret, and saves only the one it accepts', async () => {
    const { result, lines, envText, stateText } = await interview(['', APP_ID, TENANT, BAD_SECRET, SECRET, 'Bugs']);
    expect(result.state.steps['teams']?.status).toBe('done');
    const text = lines.join('\n');
    expect(text).toMatch(/Microsoft did not accept that secret for this app id and tenant id/);
    expect(envText).toContain(`TEAMS_APP_PASSWORD=${SECRET}`);
    expect(envText).not.toContain(BAD_SECRET);
    expectNoSecrets([stateText, text], BAD_SECRET, SECRET);
  });

  it('asks again for an id that is not an id and a channel that is not in the list', async () => {
    const { result, lines } = await interview(['', 'not-an-id', APP_ID, TENANT, SECRET, 'Nope', 'bugs']);
    expect(result.state.steps['teams']?.status).toBe('done');
    expect(result.state.steps['teams']?.data).toMatchObject({ channels: [{ name: 'Bugs' }] });
    const text = lines.join('\n');
    expect(text).toMatch(/An app id looks like/);
    expect(text).toMatch(/I do not see "Nope" in the list/);
  });

  it('checks the saved bot again on a rerun: kept on a yes, asked again when Microsoft refuses it', async () => {
    const memory = memoryStore();
    await interview(FRESH, { memory });

    const kept = await interview(['', 'Bugs'], { memory, only: 'teams' });
    expect(kept.result.state.steps['teams']?.status).toBe('done');
    expect(kept.lines).toContain('Teams: keep using the saved bot registration?');
    expect(kept.asked.some((q) => q.includes('client secret'))).toBe(false);
    expect(tenant.published).toBe(1);

    tenant.secrets = new Set(['rotated-secret-value-4321']);
    const refused = await interview([APP_ID, TENANT, 'rotated-secret-value-4321', 'Bugs'], { memory, only: 'teams' });
    expect(refused.result.state.steps['teams']?.status).toBe('done');
    expect(refused.lines).toContain("Microsoft no longer accepts the saved bot secret, so I need the bot's details again.");
    expect(refused.envText).toContain('TEAMS_APP_PASSWORD=rotated-secret-value-4321');
    expect(refused.envText).not.toContain(`TEAMS_APP_PASSWORD=${SECRET}`);
  });

  it('leaves Teams out on a no, touches nothing, and asks again on --step', async () => {
    const memory = memoryStore();
    const left = await interview(['2'], { memory });
    expect(left.result.state.steps['teams']).toMatchObject({ status: 'skipped', note: 'the installer does not use Teams' });
    expect(left.result.state.steps['later']?.status).toBe('done');
    expect(left.lines).toContain('Leaving Teams out. Run `snapwing onboard --step teams` if your team starts using it.');
    expect(tenant.published).toBe(0);
    expect(left.envText).toBe('');

    // A plain rerun leaves a skipped step alone; `--step teams` offers it again.
    const rerun = await interview([], { memory });
    expect(rerun.asked).toEqual([]);
    const again = await interview(FRESH, { memory, only: 'teams' });
    expect(again.lines).toContain('Does your team report bugs in Microsoft Teams?');
    expect(again.result.state.steps['teams']?.status).toBe('done');
  });

  it('does not ask whether the team uses Teams again once the bot is registered', async () => {
    const memory = memoryStore();
    await interview(FRESH, { memory });
    const kept = await interview(['', 'Bugs'], { memory, only: 'teams' });
    expect(kept.lines).not.toContain('Does your team report bugs in Microsoft Teams?');
  });
});
