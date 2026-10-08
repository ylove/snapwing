// Onboarding step 1, Slack (main 22.2 and 22.4), against MSW: the paste path, the OAuth redirect, an
// install that needs an admin, an existing Snapwing bot, an invite to a private channel, an expired
// configuration token asked again, and a saved connection checked again on a resume.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDotenv } from '../../../pipeline/src/providers/local/secrets.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type OnboardingStore } from '../../src/onboard/interview/state.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import type { RedirectListener } from '../../src/onboard/slack/install.ts';
import { createSlackStep } from '../../src/onboard/steps/slack.ts';

const API = 'https://slack.test/api';
const CONFIG = 'xoxe-1-good-config-token';
const EXPIRED = 'xoxe-1-old-config-token';
const BOT = 'xoxb-good-bot-token-0123';
const BAD_BOT = 'xoxb-bad-bot-token-9876';
const OTHER_BOT = 'xoxb-second-bot-token-5555';
const APP = 'xapp-1-good-app-token-0123';
const BAD_APP = 'xapp-1-bad-app-token-9876';

interface FakeSlack {
  configTokens: Set<string>;
  botTokens: Set<string>;
  appTokens: Set<string>;
  channels: { id: string; name: string; is_private: boolean; is_member: boolean }[];
  members: Record<string, unknown>[];
  created: { manifest: Record<string, unknown> }[];
  joined: string[];
  exchanged: Record<string, string>[];
}
let slack: FakeSlack;

const bearer = (request: Request): string => (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

beforeEach(() => {
  slack = {
    configTokens: new Set([CONFIG]),
    botTokens: new Set([BOT, OTHER_BOT]),
    appTokens: new Set([APP]),
    channels: [
      { id: 'C1', name: 'bugs', is_private: false, is_member: false },
      { id: 'C2', name: 'general', is_private: false, is_member: false },
      { id: 'G1', name: 'secret-bugs', is_private: true, is_member: false },
    ],
    members: [{ id: 'UBOT', is_bot: true, name: 'snapwing', real_name: 'Snapwing' }],
    created: [],
    joined: [],
    exchanged: [],
  };
  server.use(
    http.post(`${API}/apps.manifest.validate`, ({ request }) =>
      slack.configTokens.has(bearer(request)) ? HttpResponse.json({ ok: true }) : HttpResponse.json({ ok: false, error: 'token_expired' }),
    ),
    http.post(`${API}/apps.manifest.create`, async ({ request }) => {
      if (!slack.configTokens.has(bearer(request))) return HttpResponse.json({ ok: false, error: 'token_expired' });
      const form = new URLSearchParams(await request.text());
      slack.created.push({ manifest: JSON.parse(form.get('manifest') ?? 'null') as Record<string, unknown> });
      return HttpResponse.json({
        ok: true,
        app_id: 'A0APP',
        credentials: { client_id: '111.222', client_secret: 'client-secret-xyz', verification_token: 'v', signing_secret: 'signing-secret-abc' },
        oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=111.222',
      });
    }),
    http.post(`${API}/oauth.v2.access`, async ({ request }) => {
      slack.exchanged.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ ok: true, access_token: BOT, bot_user_id: 'UBOT', team: { id: 'T1', name: 'Acme' } });
    }),
    http.post(`${API}/auth.test`, ({ request }) =>
      slack.botTokens.has(bearer(request))
        ? HttpResponse.json({ ok: true, user_id: 'UBOT', team_id: 'T1', team: 'Acme' })
        : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
    http.post(`${API}/apps.connections.open`, ({ request }) =>
      slack.appTokens.has(bearer(request)) ? HttpResponse.json({ ok: true, url: 'wss://example.test/link' }) : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
    http.post(`${API}/users.list`, () => HttpResponse.json({ ok: true, members: slack.members })),
    http.post(`${API}/conversations.list`, () => HttpResponse.json({ ok: true, channels: slack.channels.filter((c) => !c.is_private || c.is_member) })),
    http.post(`${API}/conversations.join`, async ({ request }) => {
      const id = new URLSearchParams(await request.text()).get('channel') ?? '';
      const c = slack.channels.find((x) => x.id === id);
      if (c === undefined || c.is_private) return HttpResponse.json({ ok: false, error: 'method_not_supported_for_channel_type' });
      c.is_member = true;
      slack.joined.push(c.name);
      return HttpResponse.json({ ok: true });
    }),
  );
});
afterEach(() => server.resetHandlers());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-slack-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runtime: OnboardStep = { id: 'runtime', number: 0, title: 'Runtime', needs: [], run: () => Promise.resolve({ status: 'done' }) };
const later: OnboardStep = { id: 'later', number: 2, title: 'Later', needs: ['runtime'], run: () => Promise.resolve({ status: 'done' }) };

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
  readonly listener?: RedirectListener;
}

async function interview(
  answers: readonly string[],
  options: InterviewOptions = {},
): Promise<{ result: InterviewResult; lines: string[]; envText: string; stateText: string; asked: readonly string[] }> {
  const memory = options.memory ?? memoryStore();
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const listener = options.listener;
  const step = createSlackStep({
    apiBase: API,
    redirectWaitMs: 50,
    listen: () => Promise.resolve(listener),
  });
  const result = await runInterview({
    steps: [runtime, step, later],
    store: memory.store,
    io,
    workdir: dir,
    env: options.env ?? {},
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

/** Never a token or a secret in what the installer reads or in the saved state. */
function expectNoSecrets(texts: readonly string[], ...secrets: string[]): void {
  const text = texts.join('\n');
  for (const s of secrets) expect(text).not.toContain(s);
}

// Config token, "it is installed" (1), bot token, app token, public channels, no private channels (1).
const PASTE = [CONFIG, '1', BOT, APP, 'bugs', '1'];

describe('onboarding step 1: Slack', () => {
  it('creates the app from the manifest, takes the tokens by paste, and joins the bug channels', async () => {
    const { result, lines, envText, stateText, asked } = await interview(PASTE);
    expect(result.outcome).toBe('complete');
    expect(result.state.steps['slack']?.status).toBe('done');
    expect(result.state.steps['slack']?.data).toMatchObject({
      appId: 'A0APP',
      team: 'Acme',
      installed: true,
      channels: [{ id: 'C1', name: 'bugs', private: false }],
    });
    expect(slack.joined).toEqual(['bugs']);

    // The manifest sent is the file's, with no redirect address (nothing can catch one).
    expect(slack.created).toHaveLength(1);
    const manifest = slack.created[0]?.manifest as { display_information: { name: string }; oauth_config: { scopes: { bot: string[] }; redirect_urls?: string[] } };
    expect(manifest.display_information.name).toBe('Snapwing');
    expect(manifest.oauth_config.scopes.bot).toContain('channels:join');
    expect(manifest.oauth_config.redirect_urls).toBeUndefined();

    expect(envText).toContain(`SLACK_BOT_TOKEN=${BOT}`);
    expect(envText).toContain(`SLACK_APP_TOKEN=${APP}`);
    expect(envText).toContain('SLACK_SIGNING_SECRET=signing-secret-abc');
    expect(envText).not.toContain(CONFIG);
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);

    const text = lines.join('\n');
    expect(text).toMatch(/expires after 12 hours/);
    expect(text).toMatch(/Slack has no API for the app-level token/);
    expect(asked.some((q) => q.includes('bot token'))).toBe(true);
    expectNoSecrets([stateText, text], CONFIG, BOT, APP, 'signing-secret-abc', 'client-secret-xyz');
    // Extensible: no step numbers in what the installer reads.
    expect(text).not.toMatch(/\bstep \d/i);
  });

  it('asks for the configuration token again when Slack says it expired', async () => {
    const { result, lines, asked, stateText } = await interview([EXPIRED, CONFIG, '1', BOT, APP, 'bugs', '1']);
    expect(result.state.steps['slack']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/Configuration tokens expire after 12 hours/);
    expect(asked.filter((q) => q.includes('configuration token'))).toHaveLength(2);
    expect(slack.created).toHaveLength(1);
    expectNoSecrets([stateText, lines.join('\n')], EXPIRED, CONFIG);
  });

  it('asks for the bot token and the app-level token again after a refusal', async () => {
    const { result, lines, envText, stateText } = await interview([CONFIG, '1', 'not-a-bot-token', BAD_BOT, BOT, BAD_APP, APP, 'bugs', '1']);
    expect(result.state.steps['slack']?.status).toBe('done');
    const text = lines.join('\n');
    expect(text).toMatch(/A bot token starts with xoxb-/);
    expect(text).toMatch(/Slack did not accept that token\. Copy it again/);
    expect(text).toMatch(/Check that it has the connections:write scope/);
    expect(envText).toContain(`SLACK_BOT_TOKEN=${BOT}`);
    expectNoSecrets([stateText, text], BAD_BOT, BAD_APP, BOT, APP);
    expect(envText).not.toContain(BAD_BOT);
    expect(envText).not.toContain(BAD_APP);
  });

  it('takes the bot token from the OAuth redirect when Snapwing has a public https address', async () => {
    let closed = false;
    const listener: RedirectListener = { wait: () => Promise.resolve('the-code'), close: () => void (closed = true) };
    const { result, lines, asked, envText } = await interview([CONFIG, '1', APP, 'bugs', '1'], {
      env: { SNAPWING_PUBLIC_URL: 'https://snap.example.com' },
      listener,
    });
    expect(result.state.steps['slack']?.status).toBe('done');
    const manifest = slack.created[0]?.manifest as { oauth_config: { redirect_urls?: string[] } };
    expect(manifest.oauth_config.redirect_urls).toEqual(['https://snap.example.com/slack/oauth/callback']);
    expect(slack.exchanged).toEqual([
      expect.objectContaining({ code: 'the-code', client_id: '111.222', redirect_uri: 'https://snap.example.com/slack/oauth/callback' }),
    ]);
    expect(asked.some((q) => q.includes('bot token'))).toBe(false);
    expect(envText).toContain(`SLACK_BOT_TOKEN=${BOT}`);
    expect(lines.some((l) => l.includes('https://slack.com/oauth/v2/authorize?') && l.includes('redirect_uri='))).toBe(true);
    expect(closed).toBe(true);
  });

  it('falls back to a paste when the redirect never arrives', async () => {
    const listener: RedirectListener = { wait: () => Promise.resolve(undefined), close: () => undefined };
    const { result, lines } = await interview([CONFIG, '1', BOT, APP, 'bugs', '1'], { env: { SNAPWING_PUBLIC_URL: 'https://snap.example.com' }, listener });
    expect(result.state.steps['slack']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/did not send the install back to Snapwing/);
  });

  it('blocks on an admin when the install needs approval, prints the request link, and lets the later steps run', async () => {
    const memory = memoryStore();
    const first = await interview([CONFIG, '2'], { memory });
    expect(first.result.outcome).toBe('waiting');
    expect(first.result.state.steps['slack']?.status).toBe('blocked');
    expect(first.result.state.steps['slack']?.blocked).toMatchObject({ on: 'a Slack workspace admin', link: 'https://api.slack.com/apps/A0APP/install-on-team' });
    expect(first.lines.join('\n')).toMatch(/Request to install/);
    expect(first.result.state.steps['later']?.status).toBe('done');
    expect(first.envText).not.toContain('SLACK_BOT_TOKEN');

    // After the approval the app is not created twice, and the config token is not asked for again.
    const second = await interview(['1', BOT, APP, 'bugs', '1'], { memory });
    expect(second.result.state.steps['slack']?.status).toBe('done');
    expect(slack.created).toHaveLength(1);
    expect(second.asked.some((q) => q.includes('configuration token'))).toBe(false);
  });

  it('warns, and carries on, when another bot named Snapwing is already in the workspace', async () => {
    slack.members.push({ id: 'UOLD', is_bot: true, name: 'snapwing-old', real_name: 'Snapwing', profile: { display_name: 'snapwing' } });
    const { result, lines } = await interview(PASTE);
    expect(result.state.steps['slack']?.status).toBe('done');
    expect(lines.join('\n')).toMatch(/another bot user named Snapwing already exists \(UOLD\)/);
  });

  it('asks about private channels and for an invite, and records the ones not yet joined', async () => {
    // Bugs, then private "yes", the private name, "Not yet" (2).
    const notYet = await interview([CONFIG, '1', BOT, APP, 'bugs', '2', 'secret-bugs', '2']);
    expect(notYet.result.state.steps['slack']?.status).toBe('done');
    expect(notYet.lines.join('\n')).toMatch(/type \/invite @Snapwing/);
    expect(notYet.result.state.steps['slack']?.data).toMatchObject({ waitingForInvite: ['secret-bugs'], channels: [{ name: 'bugs' }] });
    expect(slack.joined).toEqual(['bugs']);

    // Invited this time: the bot sees the private channel and keeps it.
    slack.channels[2]!.is_member = true;
    dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-slack-'));
    const invited = await interview([CONFIG, '1', BOT, APP, 'bugs', '2', 'secret-bugs', '1']);
    expect(invited.result.state.steps['slack']?.data).toMatchObject({ channels: [{ name: 'bugs', private: false }, { name: 'secret-bugs', private: true }] });
    expect(invited.result.state.steps['slack']?.data?.['waitingForInvite']).toBeUndefined();
    expect(slack.joined).not.toContain('secret-bugs');
  });

  it('asks again for a channel name that is not in the list', async () => {
    const { result, lines } = await interview([CONFIG, '1', BOT, APP, 'nope', '#general', '1']);
    expect(result.state.steps['slack']?.data).toMatchObject({ channels: [{ name: 'general' }] });
    expect(lines.join('\n')).toMatch(/I do not see #nope in the list/);
  });

  it('checks the saved connection again on a rerun: kept on a yes, asked again when Slack refuses it', async () => {
    const memory = memoryStore();
    await interview(PASTE, { memory });

    const kept = await interview(['', 'bugs', '1'], { memory, only: 'slack' });
    expect(kept.result.state.steps['slack']?.status).toBe('done');
    expect(kept.lines).toContain('Slack: keep using the saved connection to Acme?');
    expect(kept.asked.some((q) => q.includes('bot token'))).toBe(false);
    expect(slack.created).toHaveLength(1);

    slack.botTokens.delete(BOT);
    slack.botTokens.add(OTHER_BOT);
    const refused = await interview(['1', OTHER_BOT, 'bugs', '1'], { memory, only: 'slack' });
    expect(refused.result.state.steps['slack']?.status).toBe('done');
    expect(refused.lines).toContain('Slack no longer accepts the saved bot token, so I need it again.');
    expect(refused.envText).toContain(`SLACK_BOT_TOKEN=${OTHER_BOT}`);
    expect(refused.envText).not.toContain(`SLACK_BOT_TOKEN=${BOT}`);
    expect(slack.created).toHaveLength(1);
  });

  it('hands the generated secrets to the redactor, so a later step cannot leak them', async () => {
    const leak: OnboardStep = {
      id: 'leak',
      number: 3,
      title: 'Leak',
      needs: ['slack'],
      run: async () => {
        const env = parseDotenv(await readFile(join(dir, '.env'), 'utf8'), '.env');
        throw new Error(`oops ${env.get('SLACK_SIGNING_SECRET') ?? ''} ${env.get('SLACK_CLIENT_SECRET') ?? ''}`);
      },
    };
    const io = createTerminalIO({ prompter: scriptedPrompter(PASTE), say: () => undefined });
    const result = await runInterview({
      steps: [runtime, createSlackStep({ apiBase: API, listen: () => Promise.resolve(undefined) }), leak],
      store: memoryStore().store,
      io,
      workdir: dir,
      env: {},
    });
    expect(result.outcome).toBe('failed');
    expect(result.failure?.message).toBe('oops [secret] [secret]');
  });
});
