import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { loadAppConfig, validateAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import { parseSealKey } from '@snapwing/pipeline/util/seal.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { generateEncryptionKey, generateFixerTokenSecret, patchAppConfig, writeAppConfig } from '../../src/onboard/config-write.ts';
import { SecretValue } from '../../src/onboard/interview/io.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore } from '../../src/onboard/interview/state.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import { checkModelKey, normalizePublicUrl, runtimeStep } from '../../src/onboard/steps/runtime.ts';
import { parseDotenv } from '../../../pipeline/src/providers/local/secrets.ts';

const ANTHROPIC = 'https://api.anthropic.com/v1/models';
const OPENAI = 'https://api.openai.com/v1/models';
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/models';

const KEYS = { anthropic: 'sk-ant-good-0123456789', openai: 'sk-openai-good-0123456789', google: 'AIza-good-0123456789' };

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

/** Every key in KEYS is good; anything else is refused with the status the provider uses. */
interface Seen {
  anthropic: string[];
  openai: string[];
  google: string[];
}
let seen: Seen;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-runtime-'));
  seen = { anthropic: [], openai: [], google: [] };
  server.use(
    http.get(ANTHROPIC, ({ request }) => {
      const key = request.headers.get('x-api-key') ?? '';
      seen.anthropic.push(key);
      return key === KEYS.anthropic ? HttpResponse.json({ data: [] }) : HttpResponse.json({ error: { type: 'authentication_error' } }, { status: 401 });
    }),
    http.get(OPENAI, ({ request }) => {
      const auth = request.headers.get('authorization') ?? '';
      seen.openai.push(auth);
      return auth === `Bearer ${KEYS.openai}` ? HttpResponse.json({ data: [] }) : HttpResponse.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
    }),
    http.get(GOOGLE, ({ request }) => {
      const key = request.headers.get('x-goog-api-key') ?? '';
      seen.google.push(key);
      return key === KEYS.google ? HttpResponse.json({ models: [] }) : HttpResponse.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 });
    }),
  );
});

afterEach(async () => {
  server.resetHandlers();
  await rm(dir, { recursive: true, force: true });
});

function memoryKv(): { kvGet(k: string): Promise<string | undefined>; kvSet(k: string, v: string): Promise<void> } {
  const raw = new Map<string, string>();
  return {
    kvGet: (k) => Promise.resolve(raw.get(k)),
    kvSet: (k, v) => {
      raw.set(k, v);
      return Promise.resolve();
    },
  };
}

interface Outcome {
  readonly result: InterviewResult;
  readonly lines: string[];
  readonly asked: readonly string[];
}

async function interview(answers: readonly string[], env: Record<string, string | undefined> = {}): Promise<Outcome> {
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  const io = createTerminalIO({ prompter, say: (line) => lines.push(line) });
  const result = await runInterview({ steps: [runtimeStep], store: createKvOnboardingStore(memoryKv()), io, workdir: dir, env });
  return { result, lines, asked: prompter.asked };
}

const readEnv = async (): Promise<Map<string, string>> => parseDotenv(await readFile(join(dir, '.env'), 'utf8'), '.env');
const readConfig = (): Promise<string> => readFile(join(dir, 'snapwing.config.xml'), 'utf8');

describe('step 0: runtime, model keys, public URL', () => {
  it('local, two provider keys, no public URL: config validates, defaults to the first provider, keys land in .env', async () => {
    const { result, lines } = await interview(['local', 'yes', KEYS.anthropic, 'yes', KEYS.openai, 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(result.state.steps['runtime']?.status).toBe('done');

    const xml = await readConfig();
    expect((await validateAppConfig(xml)).valid).toBe(true);
    const config = loadAppConfig(xml);
    expect(config.runtime.provider).toBe('local');
    expect(config.models.defaultProvider).toBe('anthropic');
    expect(xml).not.toContain(KEYS.anthropic);

    const env = await readEnv();
    expect(env.get('ANTHROPIC_API_KEY')).toBe(KEYS.anthropic);
    expect(env.get('OPENAI_API_KEY')).toBe(KEYS.openai);
    expect(env.has('GOOGLE_API_KEY')).toBe(false);
    expect(() => parseSealKey(env.get('SNAPWING_ENCRYPTION_KEY') ?? '')).not.toThrow();
    expect((env.get('SNAPWING_FIXER_TOKEN_SECRET') ?? '').length).toBeGreaterThanOrEqual(32);
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);

    // Nothing secret in the transcript or the saved state.
    const everything = JSON.stringify({ lines, state: result.state });
    for (const key of Object.values(KEYS)) expect(everything).not.toContain(key);
    for (const name of ['SNAPWING_ENCRYPTION_KEY', 'SNAPWING_FIXER_TOKEN_SECRET']) expect(everything).not.toContain(env.get(name) ?? 'x');
  });

  it('validates each provider key with one call: Anthropic, OpenAI and Google', async () => {
    for (const [provider, key] of Object.entries(KEYS)) {
      await rm(join(dir, '.env'), { force: true });
      const answers = ['local', ...['anthropic', 'openai', 'google'].flatMap((p) => (p === provider ? ['yes', key] : ['no'])), 'no'];
      const { result } = await interview(answers);
      expect(result.outcome).toBe('complete');
      expect(loadAppConfig(await readConfig()).models.defaultProvider).toBe(provider);
    }
    expect(seen.anthropic).toEqual([KEYS.anthropic]);
    expect(seen.openai).toEqual([`Bearer ${KEYS.openai}`]);
    expect(seen.google).toEqual([KEYS.google]);
  });

  it('defaults to the first provider with a key in the order anthropic, openai, google', async () => {
    await interview(['local', 'no', 'yes', KEYS.openai, 'yes', KEYS.google, 'no']);
    expect(loadAppConfig(await readConfig()).models.defaultProvider).toBe('openai');
  });

  it('asks again after a bad key, saying so, and never keeps the bad one', async () => {
    const { result, lines } = await interview(['local', 'yes', 'sk-ant-wrong-0000', KEYS.anthropic, 'no', 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(lines.join('\n')).toContain('did not accept that key');
    expect(seen.anthropic).toEqual(['sk-ant-wrong-0000', KEYS.anthropic]);
    expect((await readEnv()).get('ANTHROPIC_API_KEY')).toBe(KEYS.anthropic);
    expect(lines.join('\n')).not.toContain('sk-ant-wrong-0000');
  });

  it('says it could not check a key when the provider is unreachable, and asks again', async () => {
    let calls = 0;
    server.use(
      http.get(GOOGLE, ({ request }) => {
        calls += 1;
        return calls === 1 ? HttpResponse.json({}, { status: 503 }) : request.headers.get('x-goog-api-key') === KEYS.google ? HttpResponse.json({}) : HttpResponse.json({}, { status: 400 });
      }),
    );
    const { lines } = await interview(['local', 'no', 'no', 'yes', KEYS.google, KEYS.google, 'no']);
    expect(lines.join('\n')).toContain('Could not reach Google (Gemini)');
    expect((await readEnv()).get('GOOGLE_API_KEY')).toBe(KEYS.google);
  });

  it('asks the key questions again when none is given', async () => {
    const { lines } = await interview(['local', 'no', 'no', 'no', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect(lines.join('\n')).toContain('at least one model provider');
    expect(loadAppConfig(await readConfig()).models.defaultProvider).toBe('anthropic');
  });

  it('with no public URL, SNAPWING_PUBLIC_URL is http://localhost:<port> and the step says polling covers Jira and GitHub', async () => {
    const { lines } = await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect((await readEnv()).get('SNAPWING_PUBLIC_URL')).toBe('http://localhost:3000');
    expect(lines.join('\n')).toContain('poll Jira and GitHub');

    await rm(join(dir, '.env'));
    await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no'], { PORT: '4100' });
    expect((await readEnv()).get('SNAPWING_PUBLIC_URL')).toBe('http://localhost:4100');
  });

  it('takes a public URL or tunnel, normalized, and refuses one that is not https', async () => {
    const { lines } = await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'yes', 'http://example.com/', 'https://bugs.example.com/']);
    expect(lines.join('\n')).toContain('not a web address I can use');
    expect((await readEnv()).get('SNAPWING_PUBLIC_URL')).toBe('https://bugs.example.com');
    expect(normalizePublicUrl('https://x.trycloudflare.com/')).toBe('https://x.trycloudflare.com');
    expect(normalizePublicUrl('https://user:pw@x.example.com')).toBeUndefined();
    expect(normalizePublicUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizePublicUrl('not a url')).toBeUndefined();
  });

  it('docker without a fixer image warns, leaves SNAPWING_FIXER_IMAGE unset, and still writes the config', async () => {
    const { result, lines } = await interview(['docker', 'none', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(lines.join('\n')).toContain('cannot start a fix without a fixer image');
    expect(loadAppConfig(await readConfig()).runtime.provider).toBe('docker');
    expect((await readEnv()).has('SNAPWING_FIXER_IMAGE')).toBe(false);
    expect(result.state.steps['runtime']?.data).toMatchObject({ runtime: 'docker', fixerImage: false });
  });

  it('docker with a fixer image writes it', async () => {
    await interview(['docker', 'have', 'ghcr.io/acme/snapwing-fixer:1', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect((await readEnv()).get('SNAPWING_FIXER_IMAGE')).toBe('ghcr.io/acme/snapwing-fixer:1');
  });

  it('a cloud runtime asks for its region', async () => {
    await interview(['aws', 'us-east-2', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    const config = loadAppConfig(await readConfig());
    expect(config.runtime).toEqual({ provider: 'aws', region: 'us-east-2' });
  });

  it('keeps what a rerun finds: a working key, the encryption key, and the rest of an edited config', async () => {
    await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    const first = await readEnv();
    const edited = (await readConfig()).replace('</snapwing>', '  <merge max-files="3"/>\n</snapwing>');
    await writeFile(join(dir, 'snapwing.config.xml'), edited);

    const { lines, asked } = await interview(['docker', 'none', 'yes', KEYS.openai, 'no', 'no']);
    expect(lines.join('\n')).toContain('found ANTHROPIC_API_KEY and it works');
    expect(asked.some((q) => q.includes('Anthropic'))).toBe(false);
    const second = await readEnv();
    expect(second.get('SNAPWING_ENCRYPTION_KEY')).toBe(first.get('SNAPWING_ENCRYPTION_KEY'));
    expect(second.get('SNAPWING_FIXER_TOKEN_SECRET')).toBe(first.get('SNAPWING_FIXER_TOKEN_SECRET'));
    const config = loadAppConfig(await readConfig());
    expect(config.runtime.provider).toBe('docker');
    expect(config.models.defaultProvider).toBe('anthropic');
    expect(config.merge.maxFiles).toBe(3);
  });

  it('leaves the interview waiting for an answer, not half written, when nobody answers', async () => {
    const { result } = await interview(['local', 'yes', KEYS.anthropic]);
    expect(result.outcome).toBe('aborted');
    await expect(readConfig()).rejects.toThrow();
    await expect(readEnv()).rejects.toThrow();
  });
});

describe('checkModelKey', () => {
  it('tells a refused key from an unreachable provider, and treats a rate limit as a working key', async () => {
    expect(await checkModelKey('anthropic', new SecretValue(KEYS.anthropic))).toEqual({ ok: true });
    expect(await checkModelKey('anthropic', new SecretValue('nope'))).toEqual({ ok: false, reason: 'rejected' });
    expect(await checkModelKey('google', new SecretValue('nope'))).toEqual({ ok: false, reason: 'rejected' });
    server.use(http.get(OPENAI, () => HttpResponse.json({}, { status: 429 })));
    expect(await checkModelKey('openai', new SecretValue('any'))).toEqual({ ok: true });
    server.use(http.get(OPENAI, () => HttpResponse.error()));
    expect(await checkModelKey('openai', new SecretValue('any'))).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('config-write', () => {
  it('writes a config the XSD accepts for every runtime and default provider', async () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      await writeAppConfig(dir, { provider: 'local' }, provider);
      const xml = await readConfig();
      expect((await validateAppConfig(xml)).valid).toBe(true);
      expect(loadAppConfig(xml).models.defaultProvider).toBe(provider);
    }
  });

  it('refuses to patch a file with no runtime or models, changing nothing', async () => {
    expect(() => patchAppConfig('<snapwing/>', { provider: 'local' }, 'anthropic')).toThrow(/no <runtime/);
    await writeFile(join(dir, 'snapwing.config.xml'), '<snapwing/>');
    await expect(writeAppConfig(dir, { provider: 'local' }, 'anthropic')).rejects.toThrow();
    expect(await readConfig()).toBe('<snapwing/>');
  });

  it('replaces a models element that has rows', () => {
    const xml = '<snapwing><runtime provider="local"/><models default-provider="google"><model task="triage" provider="google" name="g"/></models></snapwing>';
    expect(patchAppConfig(xml, { provider: 'docker' }, 'openai')).toBe(
      '<snapwing><runtime provider="docker"/><models default-provider="openai"/></snapwing>',
    );
  });

  it('generates keys the server accepts', () => {
    expect(() => parseSealKey(generateEncryptionKey())).not.toThrow();
    expect(generateFixerTokenSecret().length).toBeGreaterThanOrEqual(32);
    expect(generateEncryptionKey()).not.toBe(generateEncryptionKey());
  });
});
