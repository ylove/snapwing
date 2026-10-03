import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { SLACK_SHORTCUT_CALLBACK_ID } from '../../src/adapters/slack/normalize.ts';
import {
  DEFAULT_MANIFEST_PATH,
  formatReport,
  parseEnvFile,
  runBootstrap,
} from '../../../../scripts/slack-bootstrap.ts';

const API = 'https://slack.test/api';
const ENV = { SLACK_CONFIG_TOKEN: 'xoxe-test', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' };

interface Manifest {
  display_information: { name: string };
  features: {
    app_home: { messages_tab_enabled: boolean };
    slash_commands: { command: string }[];
    shortcuts: { type: string; name: string; callback_id: string }[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    socket_mode_enabled: boolean;
  };
}
const manifest = parseYaml(readFileSync(DEFAULT_MANIFEST_PATH, 'utf8')) as Manifest;
const botScopes = manifest.oauth_config.scopes.bot;

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface Stubs {
  validate?: Record<string, unknown>;
  scopes?: readonly string[];
  members?: Record<string, unknown>[];
  socket?: Record<string, unknown>;
}

function stub(s: Stubs = {}): { validatedManifest: () => unknown } {
  let validated: unknown;
  server.use(
    http.post(`${API}/apps.manifest.validate`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      validated = JSON.parse(form.get('manifest') ?? 'null');
      return HttpResponse.json(s.validate ?? { ok: true });
    }),
    http.post(`${API}/auth.test`, () =>
      HttpResponse.json({ ok: true, user_id: 'UBOT' }, { headers: { 'x-oauth-scopes': (s.scopes ?? botScopes).join(',') } }),
    ),
    http.post(`${API}/apps.connections.open`, () =>
      HttpResponse.json(s.socket ?? { ok: true, url: 'wss://example.test/link' }),
    ),
    http.post(`${API}/users.list`, () => HttpResponse.json({ ok: true, members: s.members ?? [] })),
  );
  return { validatedManifest: () => validated };
}

const run = () => runBootstrap({ env: ENV, apiBase: API });
const failed = (r: Awaited<ReturnType<typeof run>>) => r.checks.filter((c) => !c.ok);

describe('manifest.yaml', () => {
  it('has the name, shortcut, scopes, events, interactivity, Socket Mode, and messages tab', () => {
    expect(manifest.display_information.name).toBe('Snapwing');
    expect(manifest.features.shortcuts).toEqual([
      expect.objectContaining({ type: 'message', name: 'Fix it from here', callback_id: SLACK_SHORTCUT_CALLBACK_ID }),
    ]);
    expect([...botScopes].sort()).toEqual(
      [
        'commands', 'app_mentions:read', 'chat:write', 'channels:history', 'channels:join', 'groups:history', 'reactions:read',
        'reactions:write', 'users:read', 'users:read.email', 'files:read', 'im:history', 'im:write', 'pins:write',
      ].sort(),
    );
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['message.im', 'app_mention', 'reaction_added', 'reaction_removed', 'file_shared']);
    expect(manifest.features.slash_commands).toEqual([expect.objectContaining({ command: '/snapwing-status' })]);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
  });
});

describe('slack bootstrap checks', () => {
  it('passes every check and sends the manifest to apps.manifest.validate', async () => {
    const s = stub();
    const report = await run();
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(['manifest-file', 'manifest-validate', 'scopes', 'socket-mode']);
    expect(report.warnings).toEqual([]);
    expect(s.validatedManifest()).toMatchObject({ display_information: { name: 'Snapwing' } });
  });

  it('is idempotent: a second run gives the same report', async () => {
    stub();
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
  });

  it('fails when Slack rejects the manifest, with one line naming the error', async () => {
    stub({ validate: { ok: false, error: 'invalid_manifest', errors: [{ message: 'bad scope', pointer: '/oauth_config/scopes/bot/0' }] } });
    const report = await run();
    const f = failed(report);
    expect(f).toHaveLength(1);
    expect(f[0]?.name).toBe('manifest-validate');
    expect(f[0]?.message).toContain('invalid_manifest');
    expect(f[0]?.message).toContain('bad scope');
    expect(f[0]?.message).not.toContain('\n');
  });

  it('prints the scopes the installed app is missing', async () => {
    stub({ scopes: botScopes.filter((s) => s !== 'pins:write' && s !== 'files:read') });
    const report = await run();
    const f = failed(report);
    expect(f).toHaveLength(1);
    expect(f[0]?.name).toBe('scopes');
    expect(f[0]?.message).toContain('pins:write');
    expect(f[0]?.message).toContain('files:read');
    expect(f[0]?.message).not.toContain('chat:write');
  });

  it('fails when Socket Mode cannot open', async () => {
    stub({ socket: { ok: false, error: 'invalid_auth' } });
    const f = failed(await run());
    expect(f).toHaveLength(1);
    expect(f[0]?.name).toBe('socket-mode');
    expect(f[0]?.message).toContain('invalid_auth');
  });

  it('warns, but does not fail, on a duplicate Snapwing bot', async () => {
    stub({
      members: [
        { id: 'UBOT', is_bot: true, name: 'snapwing' },
        { id: 'UOLD', is_bot: true, name: 'snapwing', profile: { display_name: 'Snapwing' } },
        { id: 'UHUMAN', is_bot: false, name: 'Snapwing' },
        { id: 'UGONE', is_bot: true, deleted: true, name: 'snapwing' },
        { id: 'UOTHER', is_bot: true, name: 'jirabot' },
      ],
    });
    const report = await run();
    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('UOLD');
    expect(report.warnings[0]).not.toContain('UGONE');
    expect(report.warnings[0]).not.toContain('UHUMAN');
  });

  it('fails one line per missing token and never prints a token', async () => {
    stub();
    const report = await runBootstrap({ env: {}, apiBase: API });
    const f = failed(report);
    expect(f.map((c) => c.name)).toEqual(['manifest-validate', 'scopes', 'socket-mode']);
    expect(f.map((c) => c.message)).toEqual([
      'SLACK_CONFIG_TOKEN is not set',
      'SLACK_BOT_TOKEN is not set',
      'SLACK_APP_TOKEN is not set',
    ]);
  });

  it('scrubs tokens from failure text', async () => {
    server.use(http.post(`${API}/apps.manifest.validate`, () => HttpResponse.text('boom', { status: 500 })));
    stub({});
    server.use(http.post(`${API}/apps.manifest.validate`, () => HttpResponse.json({ ok: false, error: 'bad xoxe-test token xoxb-secret1' })));
    const report = await run();
    const text = formatReport(report).join('\n');
    expect(text).not.toMatch(/xox[a-z]-/);
    expect(text).not.toContain('xapp-');
    expect(failed(report)[0]?.message).toContain('[token]');
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, quotes, export, and comments', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two"\nC=\'x y\'\n\nbad line\n')).toEqual({ A: '1', B: 'two', C: 'x y' });
  });
});
