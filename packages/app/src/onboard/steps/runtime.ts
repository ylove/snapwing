// Onboarding step `runtime` (step 0 of main 22.2; main 14.3, 14.5; #397): where Snapwing runs, which
// model provider keys the installer has, and whether there is a public URL or tunnel. It writes
// `snapwing.config.xml` (`<runtime>` and `<models>`, validated against the XSD) and the keys, a
// generated `SNAPWING_ENCRYPTION_KEY` and `SNAPWING_FIXER_TOKEN_SECRET`, and `SNAPWING_PUBLIC_URL` to
// `.env`. A secret is read hidden, checked with one cheap call, and goes only to `.env`.

import {
  MODEL_PROVIDERS,
  type ModelProvider,
  type RuntimeProvider,
} from '@snapwing/pipeline/config/app-config.ts';
import { PROVIDER_KEY_ENV } from '@snapwing/pipeline/models/router.ts';
import { DEFAULT_PORT } from '../../server/serve.ts';
import {
  defaultModelProvider,
  generateEncryptionKey,
  generateFixerTokenSecret,
  writeAppConfig,
  type RuntimeChoice,
} from '../config-write.ts';
import type { SecretValue } from '../interview/io.ts';
import type { OnboardStep, StepContext } from '../interview/step.ts';

const PROVIDER_NAMES: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
};

/** One read-only call per provider: list the models. It costs nothing and fails on a bad key. */
const KEY_CHECKS: Readonly<Record<ModelProvider, (key: string) => { url: string; headers: Record<string, string> }>> = {
  anthropic: (key) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }),
  openai: (key) => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }),
  google: (key) => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': key },
  }),
};

export type KeyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'rejected' | 'unreachable' };

/**
 * Checks a provider key with one cheap call. `rejected` is the provider saying no (401, 403, or a 400
 * naming the key, which is how Google answers); `unreachable` is anything else (network, 5xx), where
 * the key may be fine. A 429 is a working key. Never throws and never puts the key in a message.
 */
export async function checkModelKey(
  provider: ModelProvider,
  key: SecretValue,
  fetchFn: typeof fetch = fetch,
): Promise<KeyCheck> {
  const { url, headers } = KEY_CHECKS[provider](key.reveal());
  try {
    const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
    if (res.ok || res.status === 429) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
    if (res.status === 400 && provider === 'google') return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

const RUNTIME_CHOICES: readonly { readonly id: RuntimeProvider; readonly label: string }[] = [
  { id: 'local', label: 'On this machine (local): quickest, for trying it out; the fixer runs as you' },
  { id: 'docker', label: 'In Docker (a server or VPS): each fix runs in its own container' },
  { id: 'aws', label: 'On AWS' },
  { id: 'gcp', label: 'On Google Cloud' },
];

/** The public URL as Snapwing stores it: https (http only for this machine), no trailing slash. */
export function normalizePublicUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function askWhere(ctx: StepContext): Promise<RuntimeChoice> {
  const provider = (await ctx.io.choose({
    id: 'where',
    text: 'Where will Snapwing run?',
    choices: RUNTIME_CHOICES.map(({ id, label }) => ({ id, label })),
    default: 'local',
    why: 'This sets <runtime provider="..."/> in snapwing.config.xml (main 14.3). local runs the fixer and tests as the server user, so use it where no real secrets are held; docker and the cloud providers isolate each fix.',
  })) as RuntimeProvider;
  if (provider === 'local') {
    ctx.io.say('Local it is. Snapwing will warn each time it starts: this is for development, not for a server holding real secrets.');
    return { provider };
  }
  if (provider === 'docker') return { provider };
  const region = await ctx.io.ask({
    id: 'region',
    text: `Which ${provider === 'aws' ? 'AWS' : 'Google Cloud'} region (for example ${provider === 'aws' ? 'us-east-2' : 'us-central1'})?`,
    validate: (answer) => (/^[A-Za-z0-9-]+$/.test(answer) ? undefined : 'A region is letters, digits and dashes, such as us-east-2.'),
  });
  return { provider, region };
}

/** Docker needs a fixer image; returns its name, or undefined after saying what is missing. */
async function askFixerImage(ctx: StepContext): Promise<string | undefined> {
  const present = (await ctx.readEnv('SNAPWING_FIXER_IMAGE'))?.reveal();
  if (present !== undefined) {
    ctx.io.say('The fixer image is already set (SNAPWING_FIXER_IMAGE); keeping it.');
    return present;
  }
  const have = await ctx.io.choose({
    id: 'fixer-image',
    text: 'Do you have a fixer image to run fixes in?',
    choices: [
      { id: 'have', label: 'Yes, I know its name' },
      { id: 'none', label: 'Not yet' },
    ],
    default: 'none',
    why: 'The docker runtime starts one container per fix from SNAPWING_FIXER_IMAGE (main 14.3). Snapwing refuses to start without it.',
  });
  if (have === 'none') {
    ctx.io.say(
      'Warning: the docker runtime cannot start a fix without a fixer image. Set SNAPWING_FIXER_IMAGE in .env before running snapwing serve; until then it will refuse to start.',
    );
    return undefined;
  }
  return ctx.io.ask({
    id: 'fixer-image-name',
    text: 'What is the image called (for example ghcr.io/you/snapwing-fixer:latest)?',
    validate: (answer) => (/^\S+$/.test(answer) ? undefined : 'An image name has no spaces.'),
  });
}

interface ProviderKey {
  readonly provider: ModelProvider;
  /** The key to write; undefined when it is already in `.env` and stays as it is. */
  readonly key?: SecretValue;
}

async function checkedFor(provider: ModelProvider, key: SecretValue): Promise<string | undefined> {
  const check = await checkModelKey(provider, key);
  if (check.ok) return undefined;
  return check.reason === 'rejected'
    ? `${PROVIDER_NAMES[provider]} did not accept that key. Check it and paste it again.`
    : `Could not reach ${PROVIDER_NAMES[provider]} to check the key. Check your connection and paste it again.`;
}

async function askKeys(ctx: StepContext): Promise<ProviderKey[]> {
  for (;;) {
    const keys: ProviderKey[] = [];
    for (const provider of MODEL_PROVIDERS) {
      const name = PROVIDER_NAMES[provider];
      const env = PROVIDER_KEY_ENV[provider];
      const existing = await ctx.readEnv(env);
      if (existing !== undefined && (await checkModelKey(provider, existing)).ok) {
        ctx.io.say(`${name}: found ${env} and it works; keeping it.`);
        keys.push({ provider });
        continue;
      }
      const have = await ctx.io.choose({
        id: `${provider}-have`,
        text: `Do you have a ${name} API key?`,
        choices: [
          { id: 'yes', label: 'Yes, I will paste it' },
          { id: 'no', label: 'No' },
        ],
        default: 'no',
        why: `The key is checked with one read-only call to ${name} and saved to .env as ${env}. You need at least one provider; with several, the first of Anthropic, OpenAI, Google is the default.`,
      });
      if (have !== 'yes') continue;
      const key = await ctx.io.secret({
        id: `${provider}-key`,
        text: `Paste the ${name} API key:`,
        why: `Typed hidden, never echoed or logged; saved only to .env as ${env}.`,
        validate: (answer) => checkedFor(provider, answer),
      });
      keys.push({ provider, key });
    }
    if (keys.length > 0) return keys;
    ctx.io.say('Snapwing needs a key for at least one model provider to read bug reports. Let us try again.');
  }
}

/** The URL for `SNAPWING_PUBLIC_URL`: the installer's, or this machine's. */
async function askPublicUrl(ctx: StepContext): Promise<{ url: string; tunnel: boolean }> {
  const port = ctx.env['PORT']?.trim() || String(DEFAULT_PORT);
  const have = await ctx.io.choose({
    id: 'public-url',
    text: 'Do you have a public web address (or a tunnel such as ngrok or cloudflared) that reaches this server?',
    choices: [
      { id: 'no', label: 'No, not now' },
      { id: 'yes', label: 'Yes, I will paste it' },
    ],
    default: 'no',
    why: 'Jira and GitHub send webhooks to this address (main 14.3). Without one, Snapwing polls them instead and SNAPWING_PUBLIC_URL is http://localhost:<port>. Slack works without one over Socket Mode.',
  });
  if (have !== 'yes') {
    const url = `http://localhost:${port}`;
    ctx.io.say(`No public address: Snapwing will poll Jira and GitHub, and uses ${url} for itself. You can add one later by setting SNAPWING_PUBLIC_URL in .env.`);
    return { url, tunnel: false };
  }
  let url = '';
  await ctx.io.ask({
    id: 'url',
    text: 'What is the address (https://...)?',
    validate: (answer) => {
      const normal = normalizePublicUrl(answer);
      if (normal === undefined) return 'That is not a web address I can use. It starts with https:// and has no password in it.';
      url = normal;
      return undefined;
    },
  });
  return { url, tunnel: true };
}

export const runtimeStep: OnboardStep = {
  id: 'runtime',
  number: 0,
  title: 'Where Snapwing runs',
  needs: [],
  async run(ctx) {
    ctx.io.say('First, three quick questions about where Snapwing runs. Nothing is written until you have answered all of them.');
    const runtime = await askWhere(ctx);
    const fixerImage = runtime.provider === 'docker' ? await askFixerImage(ctx) : undefined;
    const keys = await askKeys(ctx);
    const publicUrl = await askPublicUrl(ctx);

    const withKeys = keys.map((k) => k.provider);
    const defaultProvider = defaultModelProvider(withKeys);
    if (defaultProvider === undefined) throw new Error('runtime step: no provider with a key');

    await writeAppConfig(ctx.workdir, runtime, defaultProvider);

    // A secret already in `.env` is kept: a new encryption key would strand data sealed with the old one.
    const entries: Record<string, string | SecretValue> = { SNAPWING_PUBLIC_URL: publicUrl.url };
    for (const { provider, key } of keys) if (key !== undefined) entries[PROVIDER_KEY_ENV[provider]] = key;
    if ((await ctx.readEnv('SNAPWING_ENCRYPTION_KEY')) === undefined) entries['SNAPWING_ENCRYPTION_KEY'] = generateEncryptionKey();
    if ((await ctx.readEnv('SNAPWING_FIXER_TOKEN_SECRET')) === undefined) {
      entries['SNAPWING_FIXER_TOKEN_SECRET'] = generateFixerTokenSecret();
    }
    if (fixerImage !== undefined) entries['SNAPWING_FIXER_IMAGE'] = fixerImage;
    await ctx.writeEnv(entries);

    ctx.io.say(
      `Saved snapwing.config.xml (${runtime.provider}, models by ${PROVIDER_NAMES[defaultProvider]}) and the keys in .env.`,
    );
    return {
      status: 'done',
      data: {
        runtime: runtime.provider,
        ...(runtime.region === undefined ? {} : { region: runtime.region }),
        providers: withKeys,
        defaultProvider,
        publicUrl: publicUrl.url,
        tunnel: publicUrl.tunnel,
        ...(runtime.provider === 'docker' ? { fixerImage: fixerImage !== undefined } : {}),
      },
    };
  },
};
