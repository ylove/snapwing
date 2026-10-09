// Onboarding step 3, the GitHub App through the manifest flow (main 22.2; #14), against MSW: create and
// install, the installer cancels and retries, no public URL, no repository selected, a rerun that keeps the
// saved App, and that every secret the step writes is handed to the redactor.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { parseDotenv } from '@snapwing/pipeline/providers/local/secrets.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore, type OnboardingStore } from '../../src/onboard/interview/state.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { createGitHubStep } from '../../src/onboard/steps/github.ts';
import { githubAccount, githubOnboardHandlers, readManifestPage, type GitHubAccount } from '../fixtures/onboard/github.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CLIENT_SECRET = 'fake-client-secret-0123456789';

let gh: GitHubAccount;

/** What the installer does in the browser, per attempt; the default creates the App. */
type Browser = (local: string) => Promise<void>;
let browser: Browser;
let attempts: number;

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

beforeEach(() => {
  gh = githubAccount({ app: { id: 424242, clientId: 'Iv1.fakeclientid', clientSecret: CLIENT_SECRET, pem: privateKey } });
  attempts = 0;
  browser = createApp;
  server.use(...githubOnboardHandlers(gh));
});
afterEach(() => {
  server.resetHandlers();
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-github-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readPage = (local: string): ReturnType<typeof readManifestPage> => readManifestPage(gh, local);

/** The installer clicks Create on GitHub, and GitHub redirects back with a one-time code. */
const createApp: Browser = async (local) => {
  const { state } = await readPage(local);
  const before = gh.conversions.length;
  // Something that does not carry the state is refused and does not end the wait.
  expect((await fetch(`${local}/callback?code=forged&state=wrong`)).status).toBe(400);
  expect((await fetch(`${local}/callback?code=forged`)).status).toBe(400);
  expect(gh.conversions).toHaveLength(before);
  expect((await fetch(`${local}/callback?code=c0de-${String(attempts)}&state=${state}`)).status).toBe(200);
};

/** The installer reads the page and closes the tab: GitHub never redirects. */
const cancel: Browser = async (local) => {
  await readPage(local);
};

const openUrl = (url: string): Promise<void> => {
  const run = async (): Promise<void> => {
    if (url.startsWith('http://127.0.0.1:')) {
      attempts += 1;
      await browser(url);
    } else if (gh.autoInstall && /\/apps\/[^/]+\/installations\/new$/.test(url)) {
      gh.installed = true;
    }
  };
  return run().catch((e: unknown) => {
    errors.push(e instanceof Error ? e.message : String(e));
  });
};
let errors: string[];
beforeEach(() => {
  errors = [];
});

const runtime: OnboardStep = { id: 'runtime', title: 'Runtime', needs: [], run: () => Promise.resolve({ status: 'done' }) };

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

// The waits are wall-clock timers that start before the simulated browser has loaded anything. A path that must
// succeed gets a window far longer than a loaded machine can stall; a path that must give up shortens it itself.
const step = (extra: Parameters<typeof createGitHubStep>[0] = {}): OnboardStep => createGitHubStep({ pollMs: 5, createWaitMs: 60_000, installWaitMs: 60_000, ...extra });
const GIVES_UP = { createWaitMs: 300 };

async function interview(
  answers: readonly string[],
  options: { env?: Record<string, string>; memory?: MemoryStore; only?: string; steps?: readonly OnboardStep[] } = {},
): Promise<{ result: InterviewResult; lines: string[]; envText: string; stateText: string; asked: readonly string[] }> {
  const memory = options.memory ?? memoryStore();
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const result = await runInterview({
    steps: options.steps ?? [runtime, step()],
    store: memory.store,
    io,
    workdir: dir,
    env: options.env ?? {},
    openUrl,
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

const PUBLIC = { SNAPWING_PUBLIC_URL: 'https://snap.example.com' };

describe('onboarding step 3: the GitHub App', () => {
  it('creates the App through the manifest flow, installs it, and lists the repositories', async () => {
    gh.webhookSecret = null;
    const { result, lines, envText, stateText, asked } = await interview(['org', 'acme', ''], { env: PUBLIC });
    expect(errors).toEqual([]);
    expect(result.outcome).toBe('complete');
    expect(result.state.steps['github']?.status).toBe('done');
    expect(result.state.steps['github']?.data).toEqual({
      appId: '424242',
      slug: 'snapwing-acme',
      name: 'Snapwing (acme)',
      owner: 'acme',
      ownerType: 'org',
      installationId: '777',
      repos: ['acme/web'],
    });
    expect(lines).toContain('Who will own the GitHub App?');
    expect(asked.find((q) => q.includes('organization'))).toBeDefined();

    // The page posts the manifest to the organization's creation page, named, with a live webhook.
    const manifest = gh.manifests[0] ?? {};
    expect(manifest['name']).toBe('Snapwing (acme)');
    expect(manifest['hook_attributes']).toEqual({ url: 'https://snap.example.com/webhooks/github', active: true });
    expect(manifest['callback_urls']).toEqual(['https://snap.example.com/auth/github/callback']);
    expect(String(manifest['redirect_url'])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(gh.conversions).toEqual(['c0de-1']);

    // Every value is in .env; the secrets are written but never printed or saved in the onboarding state.
    const env = parseDotenv(envText, '.env');
    expect(env.get('GITHUB_APP_ID')).toBe('424242');
    expect(env.get('GITHUB_APP_SLUG')).toBe('snapwing-acme');
    expect(env.get('GITHUB_APP_CLIENT_ID')).toBe('Iv1.fakeclientid');
    expect(env.get('GITHUB_APP_CLIENT_SECRET')).toBe(CLIENT_SECRET);
    expect(env.get('GITHUB_APP_PRIVATE_KEY')).toBe(privateKey);
    expect(env.get('GITHUB_INSTALLATION_ID')).toBe('777');
    const webhookSecret = env.get('GITHUB_WEBHOOK_SECRET') ?? '';
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(gh.hookConfigs).toEqual([{ url: 'https://snap.example.com/webhooks/github', content_type: 'json', secret: webhookSecret, insecure_ssl: '0' }]);
    expect(result.state.steps['github']?.secrets).toEqual(expect.arrayContaining(['GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_INSTALLATION_ID']));
    const printed = lines.join('\n');
    for (const secret of [webhookSecret, CLIENT_SECRET, 'BEGIN PRIVATE KEY']) {
      expect(printed).not.toContain(secret);
      expect(stateText).not.toContain(secret);
    }
    expect(printed).toContain('https://github.com/apps/snapwing-acme/installations/new');
    expect(printed).toContain('acme/web');
    expect(printed).not.toMatch(/step \d/i);
  });

  it('asks for a user owner without an organization and suggests the name from the owner', async () => {
    gh.account = 'octocat';
    const { result } = await interview(['user', 'octocat', ''], { env: PUBLIC });
    expect(result.state.steps['github']?.status).toBe('done');
    expect(result.state.steps['github']?.data).toMatchObject({ owner: 'octocat', ownerType: 'user', name: 'Snapwing (octocat)' });
  });

  it('refuses a name longer than GitHub allows and asks again', async () => {
    const { result, lines } = await interview(['org', 'acme', 'A'.repeat(40), 'Snapwing Acme'], { env: PUBLIC });
    expect(result.state.steps['github']?.data).toMatchObject({ name: 'Snapwing Acme' });
    expect(lines.join('\n')).toContain('limits an App name to 34 characters');
  });

  it('offers to try again when the installer cancels, and a retry with another name creates the App', async () => {
    browser = (local) => (attempts === 1 ? cancel(local) : createApp(local));
    // Only the cancelled first attempt gets a short wait; the attempt that must succeed gets the long one. The
    // step reads createWaitMs as each wait starts, before openUrl counts the attempt, so a getter tells them apart
    // (passed straight in, because step() would spread it and read it once).
    const retryStep = createGitHubStep({
      pollMs: 5,
      installWaitMs: 60_000,
      get createWaitMs() {
        return attempts === 0 ? 300 : 60_000;
      },
    });
    const first = await interview(['org', 'acme', '', 'rename', 'Snapwing Two'], { env: PUBLIC, steps: [runtime, retryStep] });
    expect(errors).toEqual([]);
    expect(first.result.state.steps['github']?.status).toBe('done');
    expect(attempts).toBe(2);
    expect(gh.manifests.map((m) => m['name'])).toEqual(['Snapwing (acme)', 'Snapwing Two']);
    expect(gh.conversions).toEqual(['c0de-2']);
    expect(first.lines.join('\n')).toContain('GitHub did not send you back');
    // The cancelled attempt wrote nothing.
    expect(parseDotenv(first.envText, '.env').get('GITHUB_APP_ID')).toBe('424242');
    expect(first.result.state.steps['github']?.data).toMatchObject({ name: 'Snapwing Two' });
  });

  it('stops blocked, with nothing written, when the installer cancels and does not retry', async () => {
    browser = cancel;
    const { result, envText } = await interview(['org', 'acme', '', 'stop'], { env: PUBLIC, steps: [runtime, step(GIVES_UP)] });
    expect(errors).toEqual([]);
    expect(result.state.steps['github']?.status).toBe('blocked');
    expect(result.state.steps['github']?.blocked?.on).toBe('you creating the GitHub App');
    expect(envText).not.toContain('GITHUB_');
    expect(gh.conversions).toEqual([]);
  });

  it('creates the App with the inactive placeholder webhook when Snapwing has no public address', async () => {
    gh.webhookSecret = 'from-github-0123456789abcdef';
    const { result, lines, envText } = await interview(['user', 'acme', ''], { env: {} });
    expect(errors).toEqual([]);
    expect(result.state.steps['github']?.status).toBe('done');
    const manifest = gh.manifests[0] ?? {};
    expect(manifest['hook_attributes']).toEqual({ url: 'https://example.invalid/snapwing/webhooks/github', active: false });
    expect(manifest).not.toHaveProperty('callback_urls');
    expect(manifest['default_events']).toBeDefined();
    expect(lines.join('\n')).toMatch(/no public address/);
    // GitHub's own secret is kept, and nothing is sent to a webhook that does not exist yet.
    expect(parseDotenv(envText, '.env').get('GITHUB_WEBHOOK_SECRET')).toBe('from-github-0123456789abcdef');
    expect(gh.hookConfigs).toEqual([]);
  });

  it("takes the runtime step's http://localhost address for what it is, no public address", async () => {
    const { result, lines } = await interview(['user', 'acme', ''], { env: { SNAPWING_PUBLIC_URL: 'http://localhost:3000' } });
    expect(result.state.steps['github']?.status).toBe('done');
    const manifest = gh.manifests[0] ?? {};
    expect(manifest['hook_attributes']).toEqual({ url: 'https://example.invalid/snapwing/webhooks/github', active: false });
    expect(manifest).not.toHaveProperty('callback_urls');
    expect(lines.join('\n')).toMatch(/no public address/);
    expect(gh.hookConfigs).toEqual([]);
  });

  it('generates the webhook secret when GitHub returns none and there is no public address', async () => {
    const { envText } = await interview(['user', 'acme', ''], { env: {} });
    expect(parseDotenv(envText, '.env').get('GITHUB_WEBHOOK_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(gh.hookConfigs).toEqual([]);
  });

  it('says where to add a repository when none is selected, and checks again', async () => {
    gh.emptyListings = 1;
    const { result, lines } = await interview(['org', 'acme', '', 'check'], { env: PUBLIC });
    expect(result.state.steps['github']?.status).toBe('done');
    expect(result.state.steps['github']?.data).toMatchObject({ installationId: '777', repos: ['acme/web'] });
    expect(lines.join('\n')).toContain('no repository is selected');
    expect(lines.join('\n')).toContain('https://github.com/organizations/acme/settings/installations/777');
  });

  it('stops blocked, keeping the installation, when no repository is selected and the installer will do it later', async () => {
    gh.repos = [];
    const { result, envText } = await interview(['org', 'acme', '', 'later'], { env: PUBLIC });
    const github = result.state.steps['github'];
    expect(github?.status).toBe('blocked');
    expect(github?.blocked).toMatchObject({ on: 'you choosing the repositories for the GitHub App', link: 'https://github.com/organizations/acme/settings/installations/777' });
    expect(github?.data).toMatchObject({ appId: '424242', slug: 'snapwing-acme', installationId: '777', repos: [] });
    expect(parseDotenv(envText, '.env').get('GITHUB_INSTALLATION_ID')).toBe('777');
  });

  it('stops blocked on the install link when the App is never installed and the installer will not keep waiting', async () => {
    gh.autoInstall = false;
    const { result, envText } = await interview(['org', 'acme', '', 'stop'], { env: PUBLIC, steps: [runtime, step({ installWaitMs: 20 })] });
    const github = result.state.steps['github'];
    expect(github?.status).toBe('blocked');
    expect(github?.blocked).toMatchObject({ on: 'you installing the GitHub App', link: 'https://github.com/apps/snapwing-acme/installations/new' });
    expect(github?.data).toMatchObject({ appId: '424242', slug: 'snapwing-acme', repos: [] });
    expect(parseDotenv(envText, '.env').has('GITHUB_INSTALLATION_ID')).toBe(false);
  });

  it('checks a saved App with its own credentials on a rerun and keeps it on a yes', async () => {
    const memory = memoryStore();
    await interview(['org', 'acme', ''], { env: PUBLIC, memory });
    const conversions = gh.conversions.length;
    const again = await interview(['keep'], { env: PUBLIC, memory, only: 'github' });
    expect(again.result.state.steps['github']?.status).toBe('done');
    expect(gh.conversions.length).toBe(conversions);
    expect(again.lines.join('\n')).toContain('already created');
    expect(again.result.state.steps['github']?.data).toMatchObject({ appId: '424242', installationId: '777', repos: ['acme/web'] });
  });

  it('creates the App again when GitHub no longer accepts the saved credentials', async () => {
    const memory = memoryStore();
    await interview(['org', 'acme', ''], { env: PUBLIC, memory });
    gh.appValid = false;
    gh.installed = false;
    gh.slug = 'snapwing-acme-2';
    const again = await interview(['org', 'acme', 'Snapwing Again'], { env: PUBLIC, memory, only: 'github' });
    expect(errors).toEqual([]);
    expect(again.lines.join('\n')).toContain('no longer accepts the saved App credentials');
    expect(again.result.state.steps['github']?.data).toMatchObject({ slug: 'snapwing-acme-2', name: 'Snapwing Again' });
  });

  it('hands the secrets it writes to the redactor, so a later step cannot leak them', async () => {
    const leak: OnboardStep = {
      id: 'leak',
      title: 'Leak',
      needs: ['github'],
      run: async () => {
        const env = parseDotenv(await readFile(join(dir, '.env'), 'utf8'), '.env');
        throw new Error(`oops ${env.get('GITHUB_WEBHOOK_SECRET') ?? ''} ${env.get('GITHUB_APP_PRIVATE_KEY') ?? ''} ${env.get('GITHUB_APP_CLIENT_SECRET') ?? ''}`);
      },
    };
    const { result } = await interview(['org', 'acme', ''], { env: PUBLIC, steps: [runtime, step(), leak] });
    expect(result.outcome).toBe('failed');
    expect(result.failure?.message).toBe('oops [secret] [secret] [secret]');
  });
});
