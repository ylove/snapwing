import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { APP_CONFIG_NAMESPACE as NS, loadAppConfig, validateAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import { parseSealKey } from '@snapwing/pipeline/util/seal.ts';
import { scriptedPrompter } from '../../src/cli/prompt.ts';
import { generateEncryptionKey, generateFixerTokenSecret, patchAppConfig, writeAppConfig } from '../../src/onboard/config-write.ts';
import { SecretValue } from '../../src/onboard/interview/io.ts';
import { runInterview, type InterviewResult } from '../../src/onboard/interview/machine.ts';
import { createKvOnboardingStore } from '../../src/onboard/interview/state.ts';
import type { OnboardStep } from '../../src/onboard/interview/step.ts';
import { createTerminalIO } from '../../src/onboard/interview/terminal.ts';
import { checkModelKey, normalizePublicUrl, runtimeStep } from '../../src/onboard/steps/runtime.ts';
import { parseDotenv } from '../../../pipeline/src/providers/local/secrets.ts';
import { MODEL_LISTS, modelKeyHandlers, type SeenKeys } from '../fixtures/onboard/models.ts';

const { anthropic: ANTHROPIC, openai: OPENAI, google: GOOGLE } = MODEL_LISTS;

const KEYS = { anthropic: 'sk-ant-good-0123456789', openai: 'sk-openai-good-0123456789', google: 'AIza-good-0123456789' };

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

/** The keys each provider was checked with. Every key in KEYS is good; anything else is refused the way that provider refuses it. */
let seen: SeenKeys;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-runtime-'));
  seen = { anthropic: [], openai: [], google: [] };
  server.use(...modelKeyHandlers(KEYS, seen));
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

  it('asks about each provider key with the right article', async () => {
    const { lines } = await interview(['local', 'no', 'no', 'no']);
    const text = lines.join('\n');
    expect(text).toContain('Do you have an Anthropic (Claude) API key?');
    expect(text).toContain('Do you have an OpenAI API key?');
    expect(text).toContain('Do you have a Google (Gemini) API key?');
    expect(text).not.toMatch(/\ba (Anthropic|OpenAI)/);
  });

  it('asks again after a bad key, saying so, and never keeps the bad one', async () => {
    const { result, lines } = await interview(['local', 'yes', 'sk-ant-wrong-0000', KEYS.anthropic, 'no', 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(lines.join('\n')).toContain('did not accept that key');
    expect(seen.anthropic).toEqual(['sk-ant-wrong-0000', KEYS.anthropic]);
    expect((await readEnv()).get('ANTHROPIC_API_KEY')).toBe(KEYS.anthropic);
    expect(lines.join('\n')).not.toContain('sk-ant-wrong-0000');
  });

  it('says it could not check a key when the provider is unreachable, and pastes it again on request', async () => {
    let calls = 0;
    server.use(
      http.get(GOOGLE, ({ request }) => {
        calls += 1;
        return calls === 1 ? HttpResponse.json({}, { status: 503 }) : request.headers.get('x-goog-api-key') === KEYS.google ? HttpResponse.json({}) : HttpResponse.json({}, { status: 400 });
      }),
    );
    const { result, lines } = await interview(['local', 'no', 'no', 'yes', KEYS.google, 'again', KEYS.google, 'no']);
    expect(lines.join('\n')).toContain('Could not reach Google (Gemini)');
    expect(calls).toBe(2);
    expect((await readEnv()).get('GOOGLE_API_KEY')).toBe(KEYS.google);
    expect(result.state.steps['runtime']?.data?.['unchecked']).toBeUndefined();
  });

  it('saves a key unchecked when the provider stays unreachable, and says it was not checked', async () => {
    server.use(http.get(GOOGLE, () => HttpResponse.error()));
    const { result, lines } = await interview(['local', 'no', 'no', 'yes', KEYS.google, 'save', 'no']);
    expect(result.outcome).toBe('complete');
    const text = lines.join('\n');
    expect(text).toContain('Could not reach Google (Gemini) to check the key');
    expect(text).toContain('the key will be saved without being checked');
    expect(text).toContain('Not checked, because the provider could not be reached: Google (Gemini).');
    expect((await readEnv()).get('GOOGLE_API_KEY')).toBe(KEYS.google);
    expect(loadAppConfig(await readConfig()).models.defaultProvider).toBe('google');
    expect(result.state.steps['runtime']?.data).toMatchObject({ providers: ['google'], unchecked: ['google'] });
  });

  it('a refused key is never offered to save unchecked', async () => {
    const { result, lines, asked } = await interview(['local', 'yes', 'sk-ant-wrong-0000', 'save']);
    expect(result.outcome).toBe('aborted');
    expect(asked.filter((q) => q.includes('Paste the Anthropic'))).toHaveLength(3);
    expect(lines.filter((l) => l.includes('did not accept that key'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('save it without checking');
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

  it('defaults to Docker, and says local runs untrusted code as the server user', async () => {
    const { result, lines } = await interview(['', 'have', 'ghcr.io/acme/snapwing-fixer:1', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(loadAppConfig(await readConfig()).runtime.provider).toBe('docker');
    expect(lines.join('\n')).toContain('it runs untrusted code as the server user');
  });

  it('docker with a fixer image writes it', async () => {
    await interview(['docker', 'have', 'ghcr.io/acme/snapwing-fixer:1', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect((await readEnv()).get('SNAPWING_FIXER_IMAGE')).toBe('ghcr.io/acme/snapwing-fixer:1');
  });

  it('offers only the runtimes serve can run fixes on: local and docker', async () => {
    const { result, lines } = await interview(['aws', 'gcp', '3']);
    expect(result.outcome).toBe('aborted');
    const text = lines.join('\n');
    expect(text).toContain('1. In Docker');
    expect(text).toContain('2. On this machine (local)');
    expect(text).not.toMatch(/AWS|Google Cloud/);
    expect(lines.filter((l) => l.includes('Type a number from 1 to 2'))).toHaveLength(3);
    await expect(readConfig()).rejects.toThrow();
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

  it('a rerun keeps the config\'s <model> rows and refusal-fallback, and warns about a row with no key', async () => {
    await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    const edited = (await readConfig()).replace(
      /<models default-provider="anthropic"\/>/,
      '<models default-provider="anthropic" refusal-fallback="off">\n' +
        '    <!-- review on Gemini -->\n' +
        '    <model task="triage" provider="anthropic" name="claude-sonnet-5-5"/>\n' +
        '    <model task="review" provider="google" name="gemini-2.5-pro"/>\n' +
        '  </models>',
    );
    await writeFile(join(dir, 'snapwing.config.xml'), edited);

    const { result, lines } = await interview(['docker', 'none', 'yes', KEYS.openai, 'no', 'no']);
    expect(result.outcome).toBe('complete');
    const xml = await readConfig();
    expect(xml).toBe(edited.replace('<runtime provider="local"/>', '<runtime provider="docker"/>'));
    const config = loadAppConfig(xml);
    expect(config.models.refusalFallback).toBe(false);
    expect(config.models.rows.map((r) => [r.task, r.provider])).toEqual([
      ['triage', 'anthropic'],
      ['review', 'google'],
    ]);
    expect(lines.join('\n')).toContain('snapwing.config.xml sends review to Google (Gemini), which has no key here');
  });

  it('a rerun keeps a key it finds when the provider cannot be reached to check it', async () => {
    await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    server.use(http.get(ANTHROPIC, () => HttpResponse.error()));

    const { result, lines, asked } = await interview(['local', 'no', 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(lines.join('\n')).toContain('found ANTHROPIC_API_KEY, but could not reach Anthropic (Claude) to check it; keeping it unchecked');
    expect(asked.some((q) => q.includes('Paste the Anthropic'))).toBe(false);
    expect((await readEnv()).get('ANTHROPIC_API_KEY')).toBe(KEYS.anthropic);
    expect(loadAppConfig(await readConfig()).models.defaultProvider).toBe('anthropic');
    expect(result.state.steps['runtime']?.data).toMatchObject({ providers: ['anthropic'], unchecked: ['anthropic'] });
  });

  it('a rerun asks again for a key it finds that the provider refuses', async () => {
    await writeFile(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-revoked-0000\n');
    const { result, lines } = await interview(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no']);
    expect(result.outcome).toBe('complete');
    expect(lines.join('\n')).toContain('found ANTHROPIC_API_KEY, but Anthropic (Claude) did not accept it');
    expect((await readEnv()).get('ANTHROPIC_API_KEY')).toBe(KEYS.anthropic);
  });

  it('writes a working key found only in the process environment to .env, and says so', async () => {
    const { result, lines, asked } = await interview(['local', 'no', 'no', 'no'], { ANTHROPIC_API_KEY: KEYS.anthropic });
    expect(result.outcome).toBe('complete');
    expect(lines.join('\n')).toContain('found ANTHROPIC_API_KEY in the environment and it works; it will go in .env too');
    expect(asked.some((q) => q.includes('Paste the Anthropic'))).toBe(false);
    expect((await readEnv()).get('ANTHROPIC_API_KEY')).toBe(KEYS.anthropic);
    for (const line of lines) expect(line).not.toContain(KEYS.anthropic);
  });

  it('hands the generated secrets to the redactor, so a later step cannot leak them', async () => {
    const leak: OnboardStep = {
      id: 'leak',
      title: 'Leak',
      needs: ['runtime'],
      run: async () => {
        const env = parseDotenv(await readFile(join(dir, '.env'), 'utf8'), '.env');
        throw new Error(`oops ${env.get('SNAPWING_ENCRYPTION_KEY') ?? ''} ${env.get('SNAPWING_FIXER_TOKEN_SECRET') ?? ''}`);
      },
    };
    const io = createTerminalIO({ prompter: scriptedPrompter(['local', 'yes', KEYS.anthropic, 'no', 'no', 'no']), say: () => undefined });
    const result = await runInterview({ steps: [runtimeStep, leak], store: createKvOnboardingStore(memoryKv()), io, workdir: dir, env: {} });
    expect(result.outcome).toBe('failed');
    expect(result.failure?.message).toBe('oops [secret] [secret]');
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

  it('refuses to patch a file with no runtime or models, or that is not a config, changing nothing', async () => {
    const empty = `<snapwing xmlns="${NS}" version="1"/>`;
    expect(() => patchAppConfig(empty, { provider: 'local' }, 'anthropic')).toThrow(/no <runtime> and <models>/);
    expect(() => patchAppConfig('<snapwing/>', { provider: 'local' }, 'anthropic')).toThrow(/not a Snapwing config/);
    expect(() => patchAppConfig('<snapwing', { provider: 'local' }, 'anthropic')).toThrow(/not well-formed/);
    await writeFile(join(dir, 'snapwing.config.xml'), empty);
    await expect(writeAppConfig(dir, { provider: 'local' }, 'anthropic')).rejects.toThrow();
    expect(await readConfig()).toBe(empty);
  });

  const CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Edited by hand. -->
<snapwing xmlns="${NS}" version="1">
  <!-- was: <runtime provider="docker"/> -->
  <runtime provider="local"/>
  <models default-provider="anthropic" refusal-fallback="off">
    <model task="triage" provider="anthropic" name="claude-sonnet-5-5"/>
    <model task="review" provider="google" name="gemini-2.5-pro" temperature="0.2"/>
  </models>
  <harness fixer="claude-code" review="claude-code"/>
  <merge max-files="3"><!-- tight --></merge>
</snapwing>
`;

  it('edits the real <runtime>, not one inside a comment, and keeps everything else byte for byte', async () => {
    const { xml, rows } = patchAppConfig(CONFIG, { provider: 'docker' }, 'openai');
    expect(xml).toBe(
      CONFIG.replace('  <runtime provider="local"/>', '  <runtime provider="docker"/>').replace(
        'default-provider="anthropic"',
        'default-provider="openai"',
      ),
    );
    expect(xml).toContain('<!-- was: <runtime provider="docker"/> -->');
    expect((await validateAppConfig(xml)).valid).toBe(true);
    const config = loadAppConfig(xml);
    expect(config.runtime).toEqual({ provider: 'docker' });
    expect(config.models.defaultProvider).toBe('openai');
    expect(rows).toEqual([
      { task: 'triage', provider: 'anthropic' },
      { task: 'review', provider: 'google' },
    ]);
  });

  it('keeps <model> rows and refusal-fallback on a rerun', () => {
    const { xml } = patchAppConfig(CONFIG, { provider: 'local' }, 'google');
    const models = loadAppConfig(xml).models;
    expect(models.defaultProvider).toBe('google');
    expect(models.refusalFallback).toBe(false);
    expect(models.rows).toEqual([
      { task: 'triage', provider: 'anthropic', name: 'claude-sonnet-5-5' },
      { task: 'review', provider: 'google', name: 'gemini-2.5-pro', temperature: 0.2 },
    ]);
  });

  it('returns the text unchanged when nothing changes, whatever its formatting', () => {
    const aligned = CONFIG.replace('<model task="triage" provider', '<model task="triage"     provider');
    expect(patchAppConfig(aligned, { provider: 'local' }, 'anthropic').xml).toBe(aligned);
  });

  it('edits an expanded <runtime></runtime> element', async () => {
    const expanded = `<snapwing xmlns="${NS}" version="1"><runtime provider="local"></runtime><models default-provider="anthropic"/><harness fixer="claude-code" review="claude-code"/></snapwing>`;
    await writeFile(join(dir, 'snapwing.config.xml'), expanded);
    await writeAppConfig(dir, { provider: 'docker' }, 'anthropic');
    const xml = await readConfig();
    expect(loadAppConfig(xml).runtime.provider).toBe('docker');
    expect(xml).toBe(expanded.replace('<runtime provider="local"></runtime>', '<runtime provider="docker"/>'));
  });

  it('drops a region the new runtime does not have', () => {
    const cloud = CONFIG.replace('<runtime provider="local"/>', '<runtime provider="aws" region="us-east-2"/>');
    expect(loadAppConfig(patchAppConfig(cloud, { provider: 'docker' }, 'anthropic').xml).runtime).toEqual({ provider: 'docker' });
  });

  it('generates keys the server accepts', () => {
    expect(() => parseSealKey(generateEncryptionKey())).not.toThrow();
    expect(generateFixerTokenSecret().length).toBeGreaterThanOrEqual(32);
    expect(generateEncryptionKey()).not.toBe(generateEncryptionKey());
  });
});
