import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createTeamsGraph, GRAPH_BASE_URL } from '../../src/adapters/teams/graph.ts';
import { SecretValue } from '../../src/onboard/interview/io.ts';
import {
  DeviceCodeError,
  TEAMS_APP_VERSION,
  compareVersions,
  duplicateAppWarning,
  formatReport,
  installTeamsApp,
  manifestRscPermissions,
  runTeamsBootstrap,
  signInByDeviceCode,
} from '../../../../scripts/teams-bootstrap.ts';

const G = GRAPH_BASE_URL;
const LOGIN = 'https://login.test';
const TENANT = 'tenant-1';
const APP_ID = '11111111-2222-3333-4444-555555555555';
const PASSWORD = 'app-password-secret';
const OWNER_TOKEN = 'owner-token-secret';
const TEAM = 'team-1';
const PUBLIC = 'https://snap.example.test';
const RSC = manifestRscPermissions();

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface Tenant {
  /** Catalog versions by catalog id; absent means the app is not in the catalog. */
  catalog?: { id: string; versions: string[] };
  installed: Record<string, unknown>[];
  grants: string[];
  uploadDisabled?: boolean;
  installDisabled?: boolean;
  /** Grants the install gives (default every consented one). */
  grantOnInstall?: string[];
  teams?: { id: string; displayName: string }[];
  channels?: { id: string; displayName: string }[];
  endpointStatus?: number;
}

const ours = (versions = '1.0.0') => ({
  id: 'inst-1',
  teamsApp: { id: 'cat-1', externalId: APP_ID, displayName: 'Snapwing' },
  teamsAppDefinition: { version: versions },
});

interface Seen {
  published: number;
  updated: number;
  installBodies: Record<string, unknown>[];
  tokenBodies: string[];
}

function tenant(t: Tenant): Seen {
  const seen: Seen = { published: 0, updated: 0, installBodies: [], tokenBodies: [] };
  server.use(
    http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, async ({ request }) => {
      seen.tokenBodies.push(await request.text());
      return HttpResponse.json({ access_token: 'app-token-secret', expires_in: 3600 });
    }),
    http.get(`${G}/appCatalogs/teamsApps`, () => HttpResponse.json({ value: t.catalog ? [{ id: t.catalog.id, externalId: APP_ID, displayName: 'Snapwing' }] : [] })),
    http.post(`${G}/appCatalogs/teamsApps`, () => {
      if (t.uploadDisabled) return HttpResponse.json({ error: { code: 'Forbidden', message: 'custom apps are off' } }, { status: 403 });
      seen.published += 1;
      t.catalog = { id: 'cat-1', versions: [TEAMS_APP_VERSION] };
      return HttpResponse.json({ id: 'cat-1', externalId: APP_ID, displayName: 'Snapwing' });
    }),
    http.get(`${G}/appCatalogs/teamsApps/:id/appDefinitions`, () =>
      HttpResponse.json({ value: (t.catalog?.versions ?? []).map((version) => ({ id: `def-${version}`, version })) }),
    ),
    http.post(`${G}/appCatalogs/teamsApps/:id/appDefinitions`, () => {
      if (t.uploadDisabled) return HttpResponse.json({ error: { code: 'Forbidden', message: 'custom apps are off' } }, { status: 403 });
      seen.updated += 1;
      t.catalog?.versions.push(TEAMS_APP_VERSION);
      return new HttpResponse(null, { status: 201 });
    }),
    http.get(`${G}/teams/${TEAM}/installedApps`, () => HttpResponse.json({ value: t.installed })),
    http.post(`${G}/teams/${TEAM}/installedApps`, async ({ request }) => {
      if (t.installDisabled) return HttpResponse.json({ error: { code: 'Forbidden', message: 'installs are blocked' } }, { status: 403 });
      const body = (await request.json()) as Record<string, unknown>;
      seen.installBodies.push(body);
      const consented = (body['consentedPermissionSet'] as { resourceSpecificPermissions: { permissionValue: string }[] }).resourceSpecificPermissions;
      t.grants = t.grantOnInstall ?? consented.map((p) => p.permissionValue);
      t.installed.push(ours());
      return new HttpResponse(null, { status: 201 });
    }),
    http.get(`${G}/teams/${TEAM}/permissionGrants`, () =>
      HttpResponse.json({ value: t.grants.map((permission, i) => ({ id: `g${i}`, clientAppId: APP_ID, permission, permissionType: 'Application' })) }),
    ),
    http.get(`${G}/groups`, () => HttpResponse.json({ value: t.teams ?? [{ id: TEAM, displayName: 'Snapwing test' }] })),
    http.get(`${G}/teams/${TEAM}/channels`, () =>
      HttpResponse.json({ value: t.channels ?? [{ id: '19:random@thread.tacv2', displayName: 'Random' }, { id: '19:general@thread.tacv2', displayName: 'General' }] }),
    ),
    http.post(`${PUBLIC}/teams/messages`, () => new HttpResponse(null, { status: t.endpointStatus ?? 401 })),
  );
  return seen;
}

const ownerGraph = () => createTeamsGraph({ token: OWNER_TOKEN });
const install = (version?: string) =>
  installTeamsApp({ graph: ownerGraph(), appId: APP_ID, publicUrl: PUBLIC, teamId: TEAM, ...(version === undefined ? {} : { version }) });

describe('installTeamsApp', () => {
  it('a fresh install publishes the package, consents every RSC permission, and reports full', async () => {
    const t: Tenant = { installed: [], grants: [] };
    const seen = tenant(t);
    const result = await install();
    expect(result).toMatchObject({ catalog: 'published', install: 'installed', mode: 'full', missing: [], warnings: [], adminSteps: [], teamsAppId: 'cat-1' });
    expect(seen.published).toBe(1);
    const body = seen.installBodies[0] as { 'teamsApp@odata.bind': string; consentedPermissionSet: { resourceSpecificPermissions: { permissionValue: string; permissionType: string }[] } };
    expect(body['teamsApp@odata.bind']).toBe(`${G}/appCatalogs/teamsApps/cat-1`);
    expect(body.consentedPermissionSet.resourceSpecificPermissions.map((p) => p.permissionValue)).toEqual(RSC);
    expect(RSC).toEqual(expect.arrayContaining(['ChannelMessage.Read.Group']));
  });

  it('an older catalog version is updated; an install already there is left alone', async () => {
    const t: Tenant = { catalog: { id: 'cat-1', versions: ['0.9.0'] }, installed: [ours('0.9.0')], grants: RSC };
    const seen = tenant(t);
    const result = await install();
    expect(result).toMatchObject({ catalog: 'updated', install: 'already', mode: 'full' });
    expect(seen).toMatchObject({ published: 0, updated: 1, installBodies: [] });
    // Run again: the catalog is current now and nothing is uploaded.
    expect(await install()).toMatchObject({ catalog: 'current', install: 'already' });
    expect(seen.updated).toBe(1);
  });

  it('with custom app upload off it returns the admin center steps and the package, and does not throw', async () => {
    const t: Tenant = { installed: [], grants: [], uploadDisabled: true };
    tenant(t);
    const result = await install();
    expect(result).toMatchObject({ catalog: 'unavailable', install: 'not-installed', mode: 'reduced', reason: 'the app is not installed in the team' });
    expect(result.adminSteps).toHaveLength(3);
    expect(result.adminSteps[0]).toContain('Upload new app');
    expect(result.packageZip?.[0]).toBe(0x50);
  });

  it('with the app uploaded but installs blocked it asks for the install step only', async () => {
    const t: Tenant = { catalog: { id: 'cat-1', versions: [TEAMS_APP_VERSION] }, installed: [], grants: [], installDisabled: true };
    tenant(t);
    const result = await install();
    expect(result).toMatchObject({ catalog: 'current', install: 'not-installed', mode: 'reduced' });
    expect(result.adminSteps).toHaveLength(2);
    expect(result.packageZip).toBeUndefined();
  });

  it('a missing grant is reported as reduced and names the grant', async () => {
    const t: Tenant = { installed: [], grants: [], grantOnInstall: RSC.filter((p) => p !== 'ChannelMessage.Read.Group') };
    tenant(t);
    const result = await install();
    expect(result).toMatchObject({ install: 'installed', mode: 'reduced', missing: ['ChannelMessage.Read.Group'] });
    expect(result.reason).toContain('ChannelMessage.Read.Group');
  });

  it('a grant outside the required set is missing but leaves the mode full', async () => {
    const t: Tenant = { installed: [], grants: [], grantOnInstall: ['ChannelMessage.Read.Group'] };
    tenant(t);
    const result = await install();
    expect(result.mode).toBe('full');
    expect(result.missing).toEqual(RSC.filter((p) => p !== 'ChannelMessage.Read.Group'));
  });

  it('warns, and still installs, when another app named Snapwing is in the team', async () => {
    const other = { id: 'inst-9', teamsApp: { id: 'cat-9', externalId: 'someone-else', displayName: 'Snapwing' } };
    const t: Tenant = { installed: [other], grants: [] };
    tenant(t);
    const result = await install();
    expect(result).toMatchObject({ install: 'installed', mode: 'full', warnings: [duplicateAppWarning(['cat-9'])] });
  });
});

describe('signInByDeviceCode', () => {
  const device = (answers: Record<string, unknown>[]) => {
    const polls: string[] = [];
    let i = 0;
    server.use(
      http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/devicecode`, () =>
        HttpResponse.json({ device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: 'https://login.test/device', expires_in: 900, interval: 5 }),
      ),
      http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, async ({ request }) => {
        polls.push(await request.text());
        const a = answers[Math.min(i++, answers.length - 1)] ?? {};
        return HttpResponse.json(a, { status: 'access_token' in a ? 200 : 400 });
      }),
    );
    return polls;
  };
  const slept: number[] = [];
  const base = { tenantId: TENANT, clientId: APP_ID, loginHost: LOGIN, sleep: async (ms: number) => void slept.push(ms) };

  it('prints the code and address, polls through pending and slow_down, and returns a secret', async () => {
    slept.length = 0;
    const polls = device([{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: OWNER_TOKEN }]);
    const prompts: unknown[] = [];
    const token = await signInByDeviceCode({ ...base, prompt: (p) => prompts.push(p) });
    expect(token).toBeInstanceOf(SecretValue);
    expect(token.reveal()).toBe(OWNER_TOKEN);
    expect(JSON.stringify(token)).not.toContain(OWNER_TOKEN);
    expect(prompts).toEqual([{ userCode: 'ABCD-1234', verificationUri: 'https://login.test/device', expiresIn: 900 }]);
    expect(slept).toEqual([5000, 5000, 10000]);
    expect(polls[0]).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(polls[0]).toContain('device_code=dev-code');
  });

  it('stops on a declined sign-in with the error code only', async () => {
    device([{ error: 'authorization_declined', error_description: 'secret detail' }]);
    const err = await signInByDeviceCode({ ...base, prompt: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceCodeError);
    expect((err as DeviceCodeError).message).toBe('device code sign-in failed: authorization_declined');
  });

  it('gives up when the code expires', async () => {
    device([{ error: 'authorization_pending' }]);
    let clock = 0;
    const err = await signInByDeviceCode({ ...base, prompt: () => undefined, now: () => (clock += 400_000) }).catch((e: unknown) => e);
    expect((err as DeviceCodeError).code).toBe('expired_token');
  });
});

describe('runTeamsBootstrap', () => {
  const ENV = {
    TEAMS_APP_ID: APP_ID,
    TEAMS_APP_PASSWORD: PASSWORD,
    TEAMS_TENANT_ID: TENANT,
    SNAPWING_PUBLIC_URL: PUBLIC,
  };
  const run = (env: Record<string, string | undefined> = ENV, file = { text: '' }) =>
    runTeamsBootstrap({
      env,
      loginHost: LOGIN,
      graphBaseUrl: G,
      readEnvFile: () => file.text,
      writeEnvFile: (text) => void (file.text = text),
    });
  const failed = (r: Awaited<ReturnType<typeof run>>) => r.checks.filter((c) => !c.ok);

  it('passes on an installed team, writes the test ids, and prints no secret', async () => {
    tenant({ installed: [ours()], grants: RSC });
    const file = { text: 'KEEP=1\n' };
    const report = await run(ENV, file);
    expect(failed(report)).toEqual([]);
    expect(report).toMatchObject({ ok: true, mode: { mode: 'full' }, warnings: [] });
    expect(report.checks.map((c) => c.name)).toEqual(['bot-token', 'graph-token', 'endpoint', 'test-team', 'installed', 'env']);
    expect(file.text).toBe(`KEEP=1\nTEAMS_TEST_TEAM_ID=${TEAM}\nTEAMS_TEST_CHANNEL_ID=19:general@thread.tacv2\n`);
    const out = formatReport(report).join('\n');
    for (const secret of [PASSWORD, 'app-token-secret']) expect(out).not.toContain(secret);
    // Run again: nothing changes.
    const again = await run(ENV, file);
    expect(again.wrote).toEqual({});
    expect(file.text).toContain(`TEAMS_TEST_TEAM_ID=${TEAM}`);
  });

  it('prefers TEAMS_PUBLIC_URL over SNAPWING_PUBLIC_URL and honors preset test ids', async () => {
    tenant({ installed: [ours()], grants: RSC });
    server.use(http.post('https://teams.example.test/teams/messages', () => new HttpResponse(null, { status: 401 })));
    const report = await run({ ...ENV, TEAMS_PUBLIC_URL: 'https://teams.example.test/', TEAMS_TEST_TEAM_ID: TEAM, TEAMS_TEST_CHANNEL_ID: '19:random@thread.tacv2' });
    expect(failed(report)).toEqual([]);
  });

  it('fails the endpoint check unless an unauthenticated POST answers 401', async () => {
    tenant({ installed: [ours()], grants: RSC, endpointStatus: 200 });
    const report = await run();
    expect(failed(report).map((c) => c.name)).toEqual(['endpoint']);
    expect(failed(report)[0]?.message).toContain('answered 200');
  });

  it('fails when the app is not installed, naming the step, and still reports the mode', async () => {
    tenant({ installed: [], grants: [] });
    const report = await run();
    expect(failed(report).map((c) => c.name)).toEqual(['installed']);
    expect(report.mode).toEqual({ mode: 'reduced', reason: 'the app is not installed in the team' });
    expect(formatReport(report)).toContain('mode reduced (the app is not installed in the team)');
  });

  it('fails with the missing grants named', async () => {
    tenant({ installed: [ours()], grants: ['TeamMember.Read.Group'] });
    const report = await run();
    expect(failed(report)[0]?.message).toContain('ChannelMessage.Read.Group');
    expect(report.mode?.mode).toBe('reduced');
  });

  it('warns about another app named Snapwing without failing', async () => {
    const other = { id: 'inst-9', teamsApp: { id: 'cat-9', externalId: 'someone-else', displayName: 'SNAPWING' } };
    tenant({ installed: [ours(), other], grants: RSC });
    const report = await run();
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([duplicateAppWarning(['cat-9'])]);
  });

  it('says which values are missing and skips what depends on them', async () => {
    tenant({ installed: [], grants: [] });
    const report = await run({ SNAPWING_PUBLIC_URL: PUBLIC });
    expect(report.ok).toBe(false);
    expect(failed(report).map((c) => `${c.name}: ${c.message}`).slice(0, 2)).toEqual(['bot-token: TEAMS_APP_ID is not set', 'graph-token: TEAMS_APP_ID is not set']);
    expect(failed(report).find((c) => c.name === 'test-team')?.message).toContain('skipped');
  });

  it('refuses a token endpoint rejection without echoing the password', async () => {
    tenant({ installed: [], grants: [] });
    server.use(http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, () => HttpResponse.json({ error: 'invalid_client', error_description: PASSWORD }, { status: 401 })));
    const report = await run();
    expect(failed(report)[0]).toMatchObject({ name: 'bot-token', message: 'Microsoft token endpoint 401: invalid_client' });
    expect(formatReport(report).join('\n')).not.toContain(PASSWORD);
  });
});

describe('compareVersions', () => {
  it('compares the numeric parts', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});
