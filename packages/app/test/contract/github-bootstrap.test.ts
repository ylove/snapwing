import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import {
  REQUIRED_CHECK,
  runApp,
  runDestroy,
  runFixture,
  runSecrets,
  runVerify,
  runWebhook,
  upsertEnv,
  type BootstrapDeps,
} from '../../../../scripts/github-bootstrap.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const API = 'https://api.github.com';
const FIXTURE = 'ylove/snapwing-fixture-web';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Recorded {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}
let calls: Recorded[] = [];
const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let root = '';
let logs: string[] = [];
let ghCalls: { args: readonly string[]; input: string | undefined }[] = [];

function deps(extra: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    gh: async (args, input) => {
      ghCalls.push({ args, input });
      if (args[0] === 'auth' && args[1] === 'token') return 'gho_faketoken\n';
      if (args[0] === 'auth' && args[1] === 'status') return "github.com\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n";
      return '';
    },
    root,
    env: {},
    log: (line) => logs.push(line),
    openUrl: () => undefined,
    now: () => new Date('2026-10-02T12:00:00Z'),
    ...extra,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'snapwing-bootstrap-'));
  await mkdir(join(root, 'manifests'), { recursive: true });
  await cp(join(REPO_ROOT, 'manifests/github-app.json'), join(root, 'manifests/github-app.json'));
  await cp(join(REPO_ROOT, 'fixtures'), join(root, 'fixtures'), { recursive: true });
  calls = [];
  logs = [];
  ghCalls = [];
  server.use(http.all('http://127.0.0.1:*/*', () => passthrough()));
});
afterEach(async () => {
  server.resetHandlers();
  await rm(root, { recursive: true, force: true });
});

function record(request: Request, body: unknown): void {
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.get('authorization') ?? '', body });
}

describe('upsertEnv', () => {
  it('replaces in place, drops duplicates, appends new keys, and keeps other lines', () => {
    const before = '# keep\nA=1\nGITHUB_APP_PRIVATE_KEY="-----BEGIN\nold\n-----END"\nB=2\nA=3\n';
    const after = upsertEnv(before, { A: 'x', GITHUB_APP_PRIVATE_KEY: 'k1\nk2', NEW: 'v w' });
    expect(after).toBe('# keep\nA=x\nGITHUB_APP_PRIVATE_KEY="k1\nk2"\nB=2\nNEW="v w"\n');
  });
});

describe('bootstrap app (manifest flow)', () => {
  const conversion = {
    id: 424242,
    slug: 'snapwing-test',
    client_id: 'Iv1.fakeclientid',
    client_secret: 'fake-client-secret',
    webhook_secret: 'fake-webhook-secret',
    pem: privateKey,
  };

  it('serves the manifest page, exchanges the code, and writes .env.live and the pem', async () => {
    await writeFile(join(root, '.env.live'), 'SNAPWING_PUBLIC_URL=https://snap.example\nOTHER=keep\n');
    server.use(
      http.post(`${API}/app-manifests/:code/conversions`, ({ request, params }) => {
        record(request, params['code']);
        return HttpResponse.json(conversion, { status: 201 });
      }),
    );
    let local = '';
    const result = runApp(
      deps({
        openUrl: (url) => {
          local = url;
        },
      }),
    );
    await expect.poll(() => local).not.toBe('');

    const page = await (await fetch(local)).text();
    const action = /action="([^"]+)"/.exec(page)?.[1] ?? '';
    expect(action.startsWith('https://github.com/settings/apps/new?state=')).toBe(true);
    const state = new URL(action.replaceAll('&amp;', '&')).searchParams.get('state') ?? '';
    const manifestAttr = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? '';
    const manifest = JSON.parse(manifestAttr.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')) as Record<string, unknown>;
    expect(manifest['name']).toBe('Snapwing');
    expect(manifest['hook_attributes']).toEqual({ url: 'https://snap.example/webhooks/github', active: true });
    expect(manifest['redirect_url']).toBe(`${local}/callback`);
    expect(manifest['default_permissions']).toMatchObject({ contents: 'write', pull_requests: 'write', checks: 'write', statuses: 'read', metadata: 'read', deployments: 'read', administration: 'read' });
    expect(manifest['default_events']).toEqual(['pull_request', 'pull_request_review', 'check_suite', 'check_run', 'status', 'deployment_status']);

    // A wrong state is refused and does not consume the flow.
    expect((await fetch(`${local}/callback?code=c0de&state=wrong`)).status).toBe(400);
    expect(calls).toHaveLength(0);

    expect((await fetch(`${local}/callback?code=c0de&state=${state}`)).status).toBe(200);
    const app = await result;
    expect(app).toEqual({ appId: '424242', slug: 'snapwing-test', installUrl: 'https://github.com/apps/snapwing-test/installations/new' });
    expect(calls).toEqual([{ method: 'POST', path: '/app-manifests/c0de/conversions', auth: '', body: 'c0de' }]);

    const secrets = createEnvFileSecrets({ path: join(root, '.env.live'), fallbackEnv: {} });
    expect(await secrets.get('GITHUB_APP_ID')).toBe('424242');
    expect(await secrets.get('GITHUB_APP_CLIENT_ID')).toBe('Iv1.fakeclientid');
    expect(await secrets.get('GITHUB_APP_CLIENT_SECRET')).toBe('fake-client-secret');
    expect(await secrets.get('GITHUB_WEBHOOK_SECRET')).toBe('fake-webhook-secret');
    expect(await secrets.get('GITHUB_APP_PRIVATE_KEY')).toBe(privateKey);
    expect(await secrets.get('OTHER')).toBe('keep');
    expect(await readFile(join(root, 'secrets/github-app.pem'), 'utf8')).toBe(privateKey);
    expect((await stat(join(root, 'secrets/github-app.pem'))).mode & 0o077).toBe(0);
    expect(logs.join('\n')).toContain('https://github.com/apps/snapwing-test/installations/new');
    expect(logs.join('\n')).not.toContain('fake-client-secret');
    expect(logs.join('\n')).not.toContain('BEGIN');
  });

  it('creates the App with an inactive placeholder webhook when SNAPWING_PUBLIC_URL is unset, and still stores a webhook secret', async () => {
    server.use(http.post(`${API}/app-manifests/:code/conversions`, () => HttpResponse.json({ ...conversion, webhook_secret: null }, { status: 201 })));
    let local = '';
    const result = runApp(deps({ openUrl: (url) => (local = url) }));
    await expect.poll(() => local).not.toBe('');
    const page = await (await fetch(local)).text();
    const state = new URL((/action="([^"]+)"/.exec(page)?.[1] ?? '').replaceAll('&amp;', '&')).searchParams.get('state') ?? '';
    const manifestAttr = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? '';
    const manifest = JSON.parse(manifestAttr.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')) as Record<string, unknown>;
    expect(manifest['hook_attributes']).toEqual({ url: 'https://example.invalid/snapwing/webhooks/github', active: false });
    expect(manifest['default_events']).toBeDefined();
    expect(manifest).not.toHaveProperty('callback_urls');
    expect(manifest['redirect_url']).toBe(`${local}/callback`);
    expect((await fetch(`${local}/callback?code=c0de&state=${state}`)).status).toBe(200);
    await result;

    const secrets = createEnvFileSecrets({ path: join(root, '.env.live'), fallbackEnv: {} });
    const generated = await secrets.get('GITHUB_WEBHOOK_SECRET');
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(await secrets.get('GITHUB_APP_ID')).toBe('424242');
    const out = logs.join('\n');
    expect(out).toContain('pnpm github:bootstrap webhook');
    expect(out).not.toContain(generated);
    expect(out).toContain('https://github.com/apps/snapwing-test/installations/new');
  });

  it('fails the run when the code exchange is rejected', async () => {
    server.use(http.post(`${API}/app-manifests/:code/conversions`, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })));
    let local = '';
    const result = runApp(deps({ env: { SNAPWING_PUBLIC_URL: 'https://snap.example' }, openUrl: (u) => (local = u) }));
    const settled = expect(result).rejects.toThrow(/code exchange failed/);
    await expect.poll(() => local).not.toBe('');
    const page = await (await fetch(local)).text();
    const state = new URL((/action="([^"]+)"/.exec(page)?.[1] ?? '').replaceAll('&amp;', '&')).searchParams.get('state') ?? '';
    expect((await fetch(`${local}/callback?code=bad&state=${state}`)).status).toBe(500);
    await settled;
  });
});

describe('bootstrap fixture (reset)', () => {
  interface Repo {
    exists: boolean;
    protected: boolean;
  }
  let repo: Repo;

  function mockRepo(prs: unknown[], refs: Record<string, string[]>): void {
    server.use(
      http.get(`${API}/user`, ({ request }) => {
        record(request, null);
        return HttpResponse.json({ login: 'ylove' });
      }),
      http.get(`${API}/repos/${FIXTURE}`, ({ request }) => {
        record(request, null);
        return repo.exists ? HttpResponse.json({ default_branch: 'main' }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      }),
      http.post(`${API}/user/repos`, async ({ request }) => {
        record(request, await request.json());
        repo.exists = true;
        return HttpResponse.json({ default_branch: 'main' }, { status: 201 });
      }),
      http.delete(`${API}/repos/${FIXTURE}/branches/main/protection`, ({ request }) => {
        record(request, null);
        if (!repo.protected) return HttpResponse.json({ message: 'Branch not protected' }, { status: 404 });
        repo.protected = false;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${API}/repos/${FIXTURE}/pulls`, ({ request }) => {
        record(request, null);
        return HttpResponse.json(prs);
      }),
      http.patch(`${API}/repos/${FIXTURE}/pulls/:n`, async ({ request }) => {
        record(request, await request.json());
        return HttpResponse.json({});
      }),
      http.get(`${API}/repos/${FIXTURE}/git/matching-refs/heads/*`, ({ request }) => {
        record(request, null);
        const prefix = new URL(request.url).pathname.split('/matching-refs/heads/')[1] ?? '';
        return HttpResponse.json((refs[prefix] ?? []).map((r) => ({ ref: `refs/heads/${r}` })));
      }),
      http.delete(`${API}/repos/${FIXTURE}/git/refs/heads/:a/:b`, ({ request }) => {
        record(request, null);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/repos/${FIXTURE}/git/blobs`, async ({ request }) => {
        const body = (await request.json()) as { content: string };
        record(request, body);
        return HttpResponse.json({ sha: `blob-${Buffer.from(body.content, 'base64').length}` }, { status: 201 });
      }),
      http.post(`${API}/repos/${FIXTURE}/git/trees`, async ({ request }) => {
        record(request, await request.json());
        return HttpResponse.json({ sha: 'tree-sha' }, { status: 201 });
      }),
      http.post(`${API}/repos/${FIXTURE}/git/commits`, async ({ request }) => {
        record(request, await request.json());
        return HttpResponse.json({ sha: 'c0ffee1234567' }, { status: 201 });
      }),
      http.patch(`${API}/repos/${FIXTURE}/git/refs/heads/main`, async ({ request }) => {
        record(request, await request.json());
        return HttpResponse.json({});
      }),
      http.put(`${API}/repos/${FIXTURE}/branches/main/protection`, async ({ request }) => {
        record(request, await request.json());
        repo.protected = true;
        return HttpResponse.json({});
      }),
    );
  }

  const pr = (number: number, ref: string): unknown => ({ number, head: { ref } });

  it('closes stray fix/ and test/ PRs and branches, force-pushes the seed, and protects main', async () => {
    repo = { exists: true, protected: true };
    mockRepo([pr(7, 'fix/WEB-1-discount'), pr(8, 'feature/keep'), pr(9, 'test/probe')], { 'fix/': ['fix/WEB-1-discount', 'fix/old'], 'test/': ['test/probe'] });

    const result = await runFixture(deps());
    expect(result).toEqual({
      repo: FIXTURE,
      created: false,
      commit: 'c0ffee1234567',
      closedPullRequests: [7, 9],
      deletedBranches: ['fix/WEB-1-discount', 'fix/old', 'test/probe'],
    });

    // The token comes from `gh auth token` and is only ever sent as a bearer header.
    expect(calls.every((c) => c.auth === 'Bearer gho_faketoken')).toBe(true);
    expect(ghCalls).toEqual([
      { args: ['auth', 'status'], input: undefined },
      { args: ['auth', 'token'], input: undefined },
    ]);
    expect(logs[0]).toMatch(/^fixture needs: .*repo and workflow/);

    const order = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(order.indexOf(`DELETE /repos/${FIXTURE}/branches/main/protection`)).toBeLessThan(order.indexOf(`PATCH /repos/${FIXTURE}/git/refs/heads/main`));
    expect(order.indexOf(`PATCH /repos/${FIXTURE}/git/refs/heads/main`)).toBeLessThan(order.indexOf(`PUT /repos/${FIXTURE}/branches/main/protection`));
    expect(calls.filter((c) => c.method === 'PATCH' && c.path.includes('/pulls/')).map((c) => [c.path, c.body])).toEqual([
      [`/repos/${FIXTURE}/pulls/7`, { state: 'closed' }],
      [`/repos/${FIXTURE}/pulls/9`, { state: 'closed' }],
    ]);

    const tree = calls.find((c) => c.path.endsWith('/git/trees'))?.body as { tree: { path: string }[] };
    expect(tree.tree.map((t) => t.path)).toEqual([
      '.github/CODEOWNERS',
      '.github/workflows/ci.yml',
      '.gitignore',
      'README.md',
      'package.json',
      'src/cart.ts',
      'src/format.ts',
      'test/cart.test.ts',
      'tsconfig.json',
    ]);
    const commit = calls.find((c) => c.path.endsWith('/git/commits'))?.body as Record<string, unknown>;
    expect(commit['parents']).toEqual([]);
    expect(commit['tree']).toBe('tree-sha');
    expect(calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/main'))?.body).toEqual({ sha: 'c0ffee1234567', force: true });

    const protection = calls.find((c) => c.method === 'PUT')?.body as {
      required_status_checks: { checks: { context: string }[] };
      required_pull_request_reviews: { required_approving_review_count: number };
    };
    expect(protection.required_status_checks.checks).toEqual([{ context: REQUIRED_CHECK }]);
    expect(protection.required_pull_request_reviews.required_approving_review_count).toBe(1);
    expect(repo.protected).toBe(true);
  });

  it('is idempotent and creates the repository under the login when it does not exist', async () => {
    repo = { exists: false, protected: false };
    mockRepo([], {});
    const first = await runFixture(deps());
    expect(first.created).toBe(true);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/user/repos')?.body).toMatchObject({ name: 'snapwing-fixture-web', auto_init: true });
    const second = await runFixture(deps());
    expect(second.created).toBe(false);
    expect(repo.protected).toBe(true);
  });

  it('prints a FAIL line with the owner command when protection is refused on a private repository, then a re-run protects', async () => {
    repo = { exists: true, protected: false };
    mockRepo([], {});
    let plan = true;
    server.use(
      http.put(`${API}/repos/${FIXTURE}/branches/main/protection`, async ({ request }) => {
        record(request, await request.json());
        if (plan) return HttpResponse.json({ message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' }, { status: 403 });
        repo.protected = true;
        return HttpResponse.json({});
      }),
      http.delete(`${API}/repos/${FIXTURE}/branches/main/protection`, ({ request }) => {
        record(request, null);
        return plan ? HttpResponse.json({ message: 'Upgrade to GitHub Pro or make this repository public' }, { status: 403 }) : new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(runFixture(deps())).rejects.toThrow(
      'FAIL branch protection needs a public repository on this GitHub plan; the owner decides: run `gh repo edit ylove/snapwing-fixture-web --visibility public --accept-visibility-change-consequences` and then re-run `pnpm github:bootstrap fixture`',
    );
    // The repository was seeded before the refusal, and visibility is never changed in code.
    expect(calls.some((c) => c.path.endsWith('/git/commits'))).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && c.path === `/repos/${FIXTURE}`)).toBe(false);
    expect(calls.some((c) => c.body !== null && typeof c.body === 'object' && 'private' in c.body && (c.body as { private: unknown }).private === false)).toBe(false);
    expect(repo.protected).toBe(false);

    plan = false; // the owner made the repository public
    const again = await runFixture(deps());
    expect(again.created).toBe(false);
    expect(repo.protected).toBe(true);
  });

  it('stops with the refresh command when gh lacks the repo or workflow scope', async () => {
    const gh = async (args: readonly string[]): Promise<string> => (args[1] === 'status' ? "Token scopes: 'gist', 'repo'\n" : 'gho_faketoken\n');
    await expect(runFixture(deps({ gh }))).rejects.toThrow(/missing the workflow scope.*gh auth refresh -s repo,workflow/);
    expect(calls).toHaveLength(0);
  });

  it('fails clearly when gh has no login', async () => {
    await expect(runFixture(deps({ gh: async () => '\n' }))).rejects.toThrow(/gh auth login/);
  });
});

describe('bootstrap verify', () => {
  function installServer(options: { installed: boolean; covers: boolean; protection: unknown }): void {
    server.use(
      http.get(`${API}/app/installations`, ({ request }) => {
        record(request, null);
        return HttpResponse.json(options.installed ? [{ id: 555, account: { login: 'someone-else' } }, { id: 987, account: { login: 'ylove' } }] : [{ id: 555, account: { login: 'someone-else' } }]);
      }),
      http.post(`${API}/app/installations/987/access_tokens`, ({ request }) => {
        record(request, null);
        return HttpResponse.json({ token: 'ghs_fakeinstalltoken', expires_at: '2026-10-02T13:00:00Z' }, { status: 201 });
      }),
      http.get(`${API}/installation/repositories`, ({ request }) => {
        record(request, null);
        return HttpResponse.json({ repositories: options.covers ? [{ full_name: FIXTURE }] : [{ full_name: 'ylove/other' }] });
      }),
      http.get(`${API}/repos/${FIXTURE}`, () => HttpResponse.json({ default_branch: 'main' })),
      http.get(`${API}/repos/${FIXTURE}/branches/main/protection`, ({ request }) => {
        record(request, null);
        return options.protection === null ? HttpResponse.json({ message: 'Branch not protected' }, { status: 404 }) : HttpResponse.json(options.protection);
      }),
    );
  }
  const goodProtection = {
    required_status_checks: { checks: [{ context: REQUIRED_CHECK }] },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  };

  beforeEach(async () => {
    await writeFile(join(root, '.env.live'), `GITHUB_APP_ID=424242\nGITHUB_APP_PRIVATE_KEY="${privateKey}"\n`);
  });

  it('finds the installation with the app JWT, records its id, and passes when everything is in place', async () => {
    installServer({ installed: true, covers: true, protection: goodProtection });
    const result = await runVerify(deps());
    expect(result.ok).toBe(true);
    expect(result.installationId).toBe('987');
    const listCall = calls.find((c) => c.path.startsWith('/app/installations'));
    const [h, p] = (listCall?.auth.replace('Bearer ', '') ?? '').split('.');
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect((JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as { iss: string }).iss).toBe('424242');
    const secrets = createEnvFileSecrets({ path: join(root, '.env.live'), fallbackEnv: {} });
    expect(await secrets.get('GITHUB_INSTALLATION_ID')).toBe('987');
    expect(await secrets.get('GITHUB_APP_PRIVATE_KEY')).toBe(privateKey);
    expect(logs.join('\n')).not.toContain('ghs_fakeinstalltoken');
  });

  it('fails when the App is not installed on the owner', async () => {
    installServer({ installed: false, covers: true, protection: goodProtection });
    const result = await runVerify(deps());
    expect(result.ok).toBe(false);
    expect(result.installationId).toBeNull();
  });

  it('fails when the installation does not cover the fixture repository', async () => {
    installServer({ installed: true, covers: false, protection: goodProtection });
    const result = await runVerify(deps());
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'repository access')?.ok).toBe(false);
  });

  it('fails when the protection rule is missing or too weak', async () => {
    installServer({ installed: true, covers: true, protection: null });
    expect((await runVerify(deps())).checks.find((c) => c.name === 'branch protection')?.ok).toBe(false);
    server.resetHandlers();
    server.use(http.all('http://127.0.0.1:*/*', () => passthrough()));
    installServer({ installed: true, covers: true, protection: { required_status_checks: { checks: [] }, required_pull_request_reviews: { required_approving_review_count: 1 } } });
    expect((await runVerify(deps())).checks.find((c) => c.name === 'branch protection')?.ok).toBe(false);
  });
});

describe('bootstrap secrets', () => {
  const env = {
    GITHUB_APP_ID: '424242',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_INSTALLATION_ID: '987',
    GITHUB_WEBHOOK_SECRET: 'fake-webhook-secret',
  };

  it('sets the GH_ repository secrets with the value on stdin and never echoes it', async () => {
    await writeFile(join(root, '.env.live'), upsertEnv('', env));
    const result = await runSecrets(deps(), { repo: 'ylove/snapwing' });
    expect(result.set).toEqual(['GH_APP_ID', 'GH_APP_PRIVATE_KEY', 'GH_INSTALLATION_ID', 'GH_WEBHOOK_SECRET']);
    expect(ghCalls.map((c) => c.args)).toEqual([
      ['secret', 'set', 'GH_APP_ID', '--repo', 'ylove/snapwing'],
      ['secret', 'set', 'GH_APP_PRIVATE_KEY', '--repo', 'ylove/snapwing'],
      ['secret', 'set', 'GH_INSTALLATION_ID', '--repo', 'ylove/snapwing'],
      ['secret', 'set', 'GH_WEBHOOK_SECRET', '--repo', 'ylove/snapwing'],
    ]);
    expect(ghCalls.map((c) => c.input)).toEqual(['424242', privateKey, '987', 'fake-webhook-secret']);
    const visible = JSON.stringify(ghCalls.map((c) => c.args)) + logs.join('\n');
    for (const v of ['424242', 'fake-webhook-secret', 'BEGIN']) expect(visible).not.toContain(v);
  });

  it('sets nothing when a value is missing', async () => {
    await writeFile(join(root, '.env.live'), upsertEnv('', { GITHUB_APP_ID: '424242' }));
    await expect(runSecrets(deps())).rejects.toThrow(/missing GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_WEBHOOK_SECRET/);
    expect(ghCalls).toEqual([]);
  });
});

describe('bootstrap webhook', () => {
  beforeEach(async () => {
    await writeFile(join(root, '.env.live'), upsertEnv('', { GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 'stored-hook-secret' }));
  });

  function appServer(options: { existingUrl: string; patchStatus: number }): void {
    server.use(
      http.get(`${API}/app`, ({ request }) => {
        record(request, null);
        return HttpResponse.json({ slug: 'snapwing-test', owner: { login: 'ylove', type: 'User' } });
      }),
      http.get(`${API}/app/hook/config`, ({ request }) => {
        record(request, null);
        return HttpResponse.json({ url: options.existingUrl, content_type: 'json' });
      }),
      http.patch(`${API}/app/hook/config`, async ({ request }) => {
        record(request, await request.json());
        return options.patchStatus === 200 ? HttpResponse.json({ url: 'x' }) : HttpResponse.json({ message: 'Not Found' }, { status: options.patchStatus });
      }),
    );
  }

  it('requires SNAPWING_PUBLIC_URL', async () => {
    await expect(runWebhook(deps())).rejects.toThrow(/SNAPWING_PUBLIC_URL/);
    expect(logs[0]).toMatch(/^webhook needs: SNAPWING_PUBLIC_URL/);
  });

  it('patches the hook config with the app JWT and prints the one-time Active step for a placeholder webhook', async () => {
    appServer({ existingUrl: 'https://example.invalid/snapwing/webhooks/github', patchStatus: 200 });
    const result = await runWebhook(deps({ env: { SNAPWING_PUBLIC_URL: 'https://snap.example/' } }));
    expect(result).toMatchObject({ url: 'https://snap.example/webhooks/github', needsActivation: true, settingsUrl: 'https://github.com/settings/apps/snapwing-test' });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/app/hook/config');
    expect(patch?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(patch?.body).toEqual({ url: 'https://snap.example/webhooks/github', content_type: 'json', secret: 'stored-hook-secret', insecure_ssl: '0' });
    const out = logs.join('\n');
    expect(out).toContain('tick "Active"');
    expect(out).toContain('https://github.com/settings/apps/snapwing-test');
    expect(out).toContain('https://snap.example/auth/github/callback');
    expect(out).not.toContain('stored-hook-secret');
  });

  it('needs no UI step when the webhook already had a URL', async () => {
    appServer({ existingUrl: 'https://old.example/webhooks/github', patchStatus: 200 });
    const result = await runWebhook(deps({ env: { SNAPWING_PUBLIC_URL: 'https://snap.example' } }));
    expect(result.needsActivation).toBe(false);
    expect(logs.join('\n')).not.toContain('tick "Active"');
  });

  it('prints the UI step instead of failing when GitHub refuses the patch', async () => {
    appServer({ existingUrl: '', patchStatus: 404 });
    const result = await runWebhook(deps({ env: { SNAPWING_PUBLIC_URL: 'https://snap.example' } }));
    expect(result.needsActivation).toBe(true);
    expect(logs.join('\n')).toContain('tick "Active"');
  });
});

describe('bootstrap destroy', () => {
  const ghWith = (scopes: string) => async (args: readonly string[]): Promise<string> => {
    ghCalls.push({ args, input: undefined });
    return args[1] === 'status' ? `Token scopes: ${scopes}\n` : 'gho_faketoken\n';
  };

  it('refuses without --yes and touches nothing', async () => {
    await expect(runDestroy(deps())).rejects.toThrow(/without --yes/);
    expect(calls).toHaveLength(0);
    expect(ghCalls).toEqual([]);
    expect(logs[0]).toMatch(/^destroy needs: --yes/);
  });

  it('stops with the refresh command when the delete_repo scope is missing', async () => {
    await expect(runDestroy(deps({ gh: ghWith("'repo', 'workflow'") }), { yes: true })).rejects.toThrow(/gh auth refresh -s delete_repo/);
    expect(calls).toHaveLength(0);
  });

  it('deletes the repository and reminds that the App stays', async () => {
    server.use(
      http.delete(`${API}/repos/${FIXTURE}`, ({ request }) => {
        record(request, null);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await runDestroy(deps({ gh: ghWith("'delete_repo', 'repo'") }), { yes: true });
    expect(result).toEqual({ repo: FIXTURE, deleted: true });
    expect(calls).toEqual([{ method: 'DELETE', path: `/repos/${FIXTURE}`, auth: 'Bearer gho_faketoken', body: null }]);
    expect(logs.join('\n')).toContain('GitHub App itself stays');
  });
});
