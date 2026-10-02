import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { parse as parseYaml } from 'yaml';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  ENV_FILE,
  SECRET_NAMES,
  USER_SCOPES,
  parseArgs,
  runCheck,
  runSecrets,
  runStore,
  type Deps,
  type Role,
} from '../../../../scripts/slack-test-users.ts';

const API = 'https://slack.test/api';
const AUTHORIZE = 'https://slack.test/oauth/v2/authorize';
const CHANNEL = 'C0TESTCHAN';
const TEAM = 'T0TEST';

// Fakes that do not look like real tokens.
const USERS: Record<string, { id: string; name: string; team: string; member: boolean }> = {
  'xoxp-test-reporter': { id: 'U0REPORTER', name: 'rita', team: TEAM, member: true },
  'xoxp-test-engineer': { id: 'U0ENGINEER', name: 'enzo', team: TEAM, member: true },
  'xoxp-test-outsider': { id: 'U0OUTSIDER', name: 'olga', team: 'T0OTHER', member: false },
  'xoxp-test-lurker': { id: 'U0LURKER', name: 'lex', team: TEAM, member: false },
};

interface Manifest {
  display_information: { name: string };
  features?: { bot_user?: unknown };
  oauth_config: { redirect_urls: string[]; scopes: { user: string[]; bot?: string[] } };
  settings: { event_subscriptions?: unknown; interactivity?: { is_enabled?: boolean }; socket_mode_enabled?: boolean };
}

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slack-test-users-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const BASE_ENV = [
  '# keep me',
  'SLACK_BOT_TOKEN=xoxb-test',
  'SLACK_TEST_DRIVER_CLIENT_ID=1234.5678',
  'SLACK_TEST_DRIVER_CLIENT_SECRET=driver-secret-test',
  `SLACK_TEST_CHANNEL=${CHANNEL}`,
  'JIRA_BASE_URL=https://example.test',
  '',
].join('\n');

async function writeEnv(text: string): Promise<void> {
  await writeFile(join(root, ENV_FILE), text);
}
const readEnv = (): Promise<string> => readFile(join(root, ENV_FILE), 'utf8');

/** What the Slack side does, keyed by the user token the test signs in with. */
function stubSlack(signedInAs: string): { exchanges: Record<string, string>[]; calls: string[] } {
  const state = { exchanges: [] as Record<string, string>[], calls: [] as string[] };
  const who = (req: Request): (typeof USERS)[string] | undefined => USERS[(req.headers.get('authorization') ?? '').replace('Bearer ', '')];
  server.use(
    http.post(`${API}/oauth.v2.access`, async ({ request }) => {
      state.calls.push('oauth.v2.access');
      state.exchanges.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ ok: true, authed_user: { id: USERS[signedInAs]?.id, access_token: signedInAs, token_type: 'user' } });
    }),
    http.post(`${API}/auth.test`, ({ request }) => {
      state.calls.push('auth.test');
      const u = who(request);
      return u === undefined
        ? HttpResponse.json({ ok: false, error: 'invalid_auth' })
        : HttpResponse.json({ ok: true, user_id: u.id, user: u.name, team_id: u.team });
    }),
    http.post(`${API}/conversations.info`, async ({ request }) => {
      state.calls.push('conversations.info');
      const u = who(request);
      const channel = new URLSearchParams(await request.text()).get('channel');
      if (u === undefined) return HttpResponse.json({ ok: false, error: 'invalid_auth' });
      if (channel !== CHANNEL) return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      return HttpResponse.json({ ok: true, channel: { id: CHANNEL, is_member: u.member, context_team_id: TEAM } });
    }),
  );
  return state;
}

/** The browser: follows the authorize URL by hitting the local callback the way Slack's redirect would. */
type Browser = (authorizeUrl: URL, callback: string) => Promise<void>;
const allow: Browser = async (url, callback) => {
  await fetch(`${callback}?code=code-test&state=${url.searchParams.get('state') ?? ''}`);
};

function makeDeps(browser: Browser, extra: Partial<Deps> = {}): { deps: Deps; log: string[]; opened: URL[]; browserDone: () => Promise<void> } {
  const log: string[] = [];
  const opened: URL[] = [];
  let pending: Promise<void> = Promise.resolve();
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    gh: () => Promise.resolve(''),
    root,
    env: {},
    log: (line) => log.push(line),
    openUrl: (url) => {
      const u = new URL(url);
      opened.push(u);
      pending = browser(u, u.searchParams.get('redirect_uri') ?? '');
    },
    apiBase: API,
    authorizeUrl: AUTHORIZE,
    ...extra,
  };
  return { deps, log, opened, browserDone: () => pending };
}

describe('manifests/slack/test-driver.manifest.yaml', () => {
  it('is a user-scope-only app: no bot, no events, no interactivity, one localhost redirect', async () => {
    const m = parseYaml(await readFile(new URL('../../../../manifests/slack/test-driver.manifest.yaml', import.meta.url), 'utf8')) as Manifest;
    expect(m.display_information.name).toBe('Snapwing Test Driver');
    expect(m.oauth_config.scopes.user).toEqual(['chat:write', 'reactions:write', 'files:write', 'channels:history', 'channels:read']);
    expect(m.oauth_config.scopes.user).toEqual([...USER_SCOPES]);
    expect(m.oauth_config.scopes.bot).toBeUndefined();
    expect(m.features?.bot_user).toBeUndefined();
    expect(m.settings.event_subscriptions).toBeUndefined();
    expect(m.settings.interactivity?.is_enabled).toBe(false);
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.oauth_config.redirect_urls).toEqual([`http://localhost:${DEFAULT_PORT}/callback`]);
  });
});

describe('slack:test-users <role>', () => {
  it('runs the user OAuth, checks the workspace, and writes token and id without printing the token', async () => {
    await writeEnv(BASE_ENV);
    const slack = stubSlack('xoxp-test-reporter');
    const { deps, log, opened, browserDone } = makeDeps(allow);
    const result = await runStore(deps, 'reporter', { port: 0 });
    await browserDone();

    expect(result).toEqual({ role: 'reporter', userId: 'U0REPORTER', inChannel: true });
    const url = opened[0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
    expect(url.searchParams.get('client_id')).toBe('1234.5678');
    expect(url.searchParams.get('user_scope')).toBe(USER_SCOPES.join(','));
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(slack.exchanges[0]).toMatchObject({ client_id: '1234.5678', client_secret: 'driver-secret-test', code: 'code-test', redirect_uri: url.searchParams.get('redirect_uri') });
    expect(slack.calls).toEqual(['oauth.v2.access', 'auth.test', 'conversations.info']);

    const env = await readEnv();
    expect(env).toContain('SLACK_TEST_REPORTER_TOKEN=xoxp-test-reporter\n');
    expect(env).toContain('SLACK_TEST_REPORTER_ID=U0REPORTER\n');
    for (const keep of BASE_ENV.split('\n').filter((l) => l !== '')) expect(env).toContain(keep);

    const out = log.join('\n');
    expect(out).not.toContain('xoxp-test-reporter');
    expect(out).not.toContain('driver-secret-test');
    expect(log[0]).toMatch(/^Needs .*SLACK_TEST_DRIVER_CLIENT_ID.*SLACK_TEST_DRIVER_CLIENT_SECRET.*SLACK_TEST_CHANNEL.*as the reporter/);
    expect(log.at(-1)).toBe('Next: sign in to Slack as the engineer and run `pnpm slack:test-users engineer`.');
  });

  it('keeps the other role and points at --check once both are stored; replaces on rerun', async () => {
    await writeEnv(`${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-old\nSLACK_TEST_REPORTER_ID=U0OLD\n`);
    stubSlack('xoxp-test-engineer');
    const { deps, log, browserDone } = makeDeps(allow);
    await runStore(deps, 'engineer', { port: 0 });
    await browserDone();
    const env = await readEnv();
    expect(env).toContain('SLACK_TEST_REPORTER_TOKEN=xoxp-old\n');
    expect(env).toContain('SLACK_TEST_ENGINEER_ID=U0ENGINEER\n');
    expect(log.at(-1)).toBe('Next: run `pnpm slack:test-users --check`, then `pnpm slack:test-users secrets`.');

    stubSlack('xoxp-test-engineer');
    const again = makeDeps(allow);
    await runStore(again.deps, 'engineer', { port: 0 });
    await again.browserDone();
    expect((await readEnv()).match(/^SLACK_TEST_ENGINEER_TOKEN=/gm)).toHaveLength(1);
  });

  it('ignores a callback with the wrong state, then accepts the real one', async () => {
    await writeEnv(BASE_ENV);
    stubSlack('xoxp-test-reporter');
    const statuses: number[] = [];
    const { deps, browserDone } = makeDeps(async (url, callback) => {
      statuses.push((await fetch(`${callback}?code=evil&state=nope`)).status);
      await allow(url, callback);
    });
    await runStore(deps, 'reporter', { port: 0 });
    await browserDone();
    expect(statuses).toEqual([400]);
    expect(await readEnv()).toContain('SLACK_TEST_REPORTER_ID=U0REPORTER');
  });

  it('fails when the user is in another workspace, and writes nothing', async () => {
    await writeEnv(BASE_ENV);
    stubSlack('xoxp-test-outsider');
    const { deps, browserDone } = makeDeps(allow);
    await expect(runStore(deps, 'reporter', { port: 0 })).rejects.toThrow(/T0OTHER.*does not own C0TESTCHAN.*nothing was written/);
    await browserDone();
    expect(await readEnv()).toBe(BASE_ENV);
  });

  it('warns, but still stores, a workspace member who is not in the channel yet', async () => {
    await writeEnv(BASE_ENV);
    stubSlack('xoxp-test-lurker');
    const { deps, log, browserDone } = makeDeps(allow);
    expect((await runStore(deps, 'engineer', { port: 0 })).inChannel).toBe(false);
    await browserDone();
    expect(log.some((l) => l.startsWith('warn ') && l.includes('not in C0TESTCHAN'))).toBe(true);
    expect(await readEnv()).toContain('SLACK_TEST_ENGINEER_ID=U0LURKER');
  });

  it('refuses to store the same Slack user for both roles', async () => {
    await writeEnv(`${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-test-reporter\nSLACK_TEST_REPORTER_ID=U0REPORTER\n`);
    stubSlack('xoxp-test-reporter');
    const { deps, browserDone } = makeDeps(allow);
    await expect(runStore(deps, 'engineer', { port: 0 })).rejects.toThrow(/already stored as the reporter/);
    await browserDone();
    expect(await readEnv()).not.toContain('SLACK_TEST_ENGINEER');
  });

  it('fails clearly when Allow is denied, and never leaks the client secret', async () => {
    await writeEnv(BASE_ENV);
    stubSlack('xoxp-test-reporter');
    const { deps, browserDone } = makeDeps(async (url, callback) => {
      await fetch(`${callback}?error=access_denied&state=${url.searchParams.get('state') ?? ''}`);
    });
    const err: unknown = await runStore(deps, 'reporter', { port: 0 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    await browserDone();
    const message = err instanceof Error ? err.message : '';
    expect(message).toMatch(/cancelled or denied/);
    expect(message).not.toContain('driver-secret-test');
    expect(await readEnv()).toBe(BASE_ENV);
  });

  it('names the missing setting and never starts a server when .env.live lacks the driver credentials', async () => {
    await writeEnv('SLACK_TEST_CHANNEL=C0TESTCHAN\n');
    const { deps, opened } = makeDeps(allow);
    await expect(runStore(deps, 'reporter', { port: 0 })).rejects.toThrow('SLACK_TEST_DRIVER_CLIENT_ID is not set in .env.live');
    expect(opened).toHaveLength(0);
  });

  it('surfaces a Slack exchange error by code only', async () => {
    await writeEnv(BASE_ENV);
    server.use(http.post(`${API}/oauth.v2.access`, () => HttpResponse.json({ ok: false, error: 'bad_client_secret' })));
    const { deps, browserDone } = makeDeps(allow);
    await expect(runStore(deps, 'reporter', { port: 0 })).rejects.toThrow('oauth.v2.access failed: bad_client_secret');
    await browserDone();
  });
});

describe('slack:test-users --check', () => {
  const stored = `${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-test-reporter\nSLACK_TEST_REPORTER_ID=U0REPORTER\nSLACK_TEST_ENGINEER_TOKEN=xoxp-test-engineer\nSLACK_TEST_ENGINEER_ID=U0ENGINEER\n`;

  it('verifies identity and channel membership for both users and changes nothing', async () => {
    await writeEnv(stored);
    stubSlack('xoxp-test-reporter');
    const { deps } = makeDeps(allow);
    const result = await runCheck(deps);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(/^Needs /);
    expect(result.lines.filter((l) => l.startsWith('ok '))).toHaveLength(2);
    expect(result.lines.at(-1)).toBe('Next: run `pnpm slack:test-users secrets` to copy them to repository secrets.');
    expect(await readEnv()).toBe(stored);
  });

  it('reports a revoked token, a missing channel membership, and an id mismatch, with no token in the output', async () => {
    await writeEnv(
      `${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-test-revoked\nSLACK_TEST_REPORTER_ID=U0REPORTER\nSLACK_TEST_ENGINEER_TOKEN=xoxp-test-lurker\nSLACK_TEST_ENGINEER_ID=U0ENGINEER\n`,
    );
    stubSlack('xoxp-test-reporter');
    const { deps } = makeDeps(allow);
    const result = await runCheck(deps);
    expect(result.ok).toBe(false);
    const out = result.lines.join('\n');
    expect(out).toContain('FAIL reporter: auth.test failed: invalid_auth');
    expect(out).toContain('FAIL engineer: SLACK_TEST_ENGINEER_ID is U0ENGINEER but the token belongs to U0LURKER');
    expect(out).not.toMatch(/xoxp-/);
    expect(result.lines.at(-1)).toBe('Next: fix the FAIL lines above, then rerun `pnpm slack:test-users --check`.');

    await writeEnv(`${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-test-lurker\nSLACK_TEST_REPORTER_ID=U0LURKER\nSLACK_TEST_ENGINEER_TOKEN=xoxp-test-engineer\nSLACK_TEST_ENGINEER_ID=U0ENGINEER\n`);
    const member = await runCheck(deps);
    expect(member.lines.join('\n')).toContain('FAIL reporter: lex is not a member of C0TESTCHAN; invite them');
  });

  it('points at the role command when a token is missing, and flags the same user twice', async () => {
    await writeEnv(BASE_ENV);
    const { deps } = makeDeps(allow);
    const missing = await runCheck(deps);
    expect(missing.ok).toBe(false);
    expect(missing.lines.join('\n')).toContain('FAIL engineer: SLACK_TEST_ENGINEER_TOKEN is not set; run `pnpm slack:test-users engineer`');

    await writeEnv(`${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-test-reporter\nSLACK_TEST_REPORTER_ID=U0REPORTER\nSLACK_TEST_ENGINEER_TOKEN=xoxp-test-reporter\nSLACK_TEST_ENGINEER_ID=U0REPORTER\n`);
    stubSlack('xoxp-test-reporter');
    const same = await runCheck(deps);
    expect(same.lines.join('\n')).toContain('FAIL reporter and engineer are the same Slack user');
  });
});

describe('slack:test-users secrets', () => {
  it('copies the test-user values to repository secrets by name, value on stdin only', async () => {
    await writeEnv(
      `${BASE_ENV}SLACK_TEST_REPORTER_TOKEN=xoxp-test-reporter\nSLACK_TEST_REPORTER_ID=U0REPORTER\nSLACK_TEST_ENGINEER_TOKEN=xoxp-test-engineer\nSLACK_TEST_ENGINEER_ID=U0ENGINEER\n`,
    );
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    const { deps, log } = makeDeps(allow, {
      gh: (args, input) => {
        calls.push({ args, input });
        return Promise.resolve('');
      },
    });
    expect(await runSecrets(deps, 'ylove/snapwing')).toEqual([...SECRET_NAMES]);
    expect(calls.map((c) => c.args)).toEqual(SECRET_NAMES.map((n) => ['secret', 'set', n, '--repo', 'ylove/snapwing']));
    expect(calls[1]?.input).toBe('xoxp-test-reporter');
    expect(log.join('\n')).not.toContain('xoxp-');
    expect(SECRET_NAMES).not.toContain('SLACK_TEST_DRIVER_CLIENT_SECRET');
  });

  it('sets nothing when a value is missing', async () => {
    await writeEnv(BASE_ENV);
    const calls: unknown[] = [];
    const { deps } = makeDeps(allow, { gh: (a) => (calls.push(a), Promise.resolve('')) });
    await expect(runSecrets(deps)).rejects.toThrow(/missing SLACK_TEST_REPORTER_TOKEN.*nothing was set/);
    expect(calls).toHaveLength(0);
  });
});

describe('argument parsing', () => {
  it('accepts a role, --check, secrets, and flags; rejects the rest', () => {
    expect(parseArgs(['reporter'])).toEqual({ command: 'store', role: 'reporter', open: true });
    expect(parseArgs(['engineer', '--port', '4000', '--no-open'])).toEqual({ command: 'store', role: 'engineer' satisfies Role, port: 4000, open: false });
    expect(parseArgs(['--check']).command).toBe('check');
    expect(parseArgs(['secrets', '--repo', 'a/b'])).toMatchObject({ command: 'secrets', repo: 'a/b' });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['admin'])).toThrow(/usage/);
    expect(() => parseArgs(['reporter', '--nope'])).toThrow(/unknown argument/);
  });
});
