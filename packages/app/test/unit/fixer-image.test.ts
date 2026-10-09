// The fixer image's entrypoint wrapper (infra/docker/fixer/, ADR 0017 with amendment 1,
// docs/harness-generic.md). The real entrypoint runs as a child process with the exact environment
// the docker runner builds (`fixerEnv`, `reviewEnv`), fake `claude`, `codex`, and `gemini` CLIs on
// PATH, and a fake fixer API. No docker runs here and the image is never built: the Dockerfile is
// checked statically.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixerJob, ReviewRunJob } from '@snapwing/pipeline/ports/runner.ts';
import { issueFixerToken } from '../../src/fixer-api/token.ts';
import { issueModelToken } from '../../src/model-proxy/token.ts';
import { DOCKER_WORKDIR, fixerEnv, reviewEnv, type DockerModelProxy } from '../../src/providers/docker/runner.ts';
import { applyModelAccess, EXIT_FAILED, EXIT_MISCONFIGURED, FIXER_REQUEST_PATH, modelAccess } from '../../../../infra/docker/fixer/wrapper.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXER_DIR = join(ROOT, 'infra/docker/fixer');
const ENTRYPOINT = join(FIXER_DIR, 'entrypoint.ts');

const keys = { secret: 'fake-hmac-key-for-tests-0123456789abcdef', clock: () => new Date() };
const proxy: DockerModelProxy = {
  url: 'http://snapwing-api:8080/model',
  token: (run) => issueModelToken({ workItemId: run.workItem.id, runId: run.runId, ttl: 'PT45M' }, keys),
};
const REQUEST = '<implementation-request issue="WEB-1042">guard the cart</implementation-request>\n';

interface ApiCall {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

let dir: string;
let work: string;
let bin: string;
let out: string;
let server: Server;
let apiUrl: string;
let api: ApiCall[];
/** Stop answers 204 once a checkpoint with this phase arrived ('start': from the first poll). */
let stopAfter: string | undefined;
let checkpointStatus: number;
/** What `GET .../git-token` answers; 200 mints `test-fresh-git-token-<n>` for the n-th call. */
let gitTokenStatus: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fixer-image-'));
  work = join(dir, 'work');
  bin = join(dir, 'bin');
  out = join(dir, 'out');
  for (const d of [work, bin, out]) mkdirSync(d);
  api = [];
  stopAfter = undefined;
  checkpointStatus = 200;
  gitTokenStatus = 200;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const call: ApiCall = { method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body: raw === '' ? undefined : (JSON.parse(raw) as unknown) };
      api.push(call);
      if (call.path.endsWith('/stop')) {
        const stopped = stopAfter === 'start' || api.some((c) => c.path.endsWith('/checkpoint') && (c.body as { phase?: string }).phase === stopAfter);
        res.writeHead(stopped ? 204 : 200).end(stopped ? undefined : '{"stop":false}');
      } else if (call.path.endsWith('/checkpoint')) {
        res.writeHead(checkpointStatus).end('{}');
      } else if (call.path.endsWith('/git-token')) {
        const n = api.filter((c) => c.path.endsWith('/git-token')).length;
        if (gitTokenStatus !== 200) res.writeHead(gitTokenStatus).end('{"error":"nope"}');
        else res.writeHead(200).end(JSON.stringify({ token: `test-fresh-git-token-${n}`, expiresAt: '2026-10-02T13:00:00.000Z' }));
      } else {
        res.writeHead(200).end('{"seq":1}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** A fake CLI that records its argv, environment, and stdin under `out/<name>`, then runs `body`. */
function fakeCli(name: string, body: string): void {
  const script = [
    '#!/bin/sh',
    `out='${join(out, name)}'`,
    'mkdir -p "$out"',
    `printf '%s\\n' "$@" > "$out/args"`,
    'env | sort > "$out/env"',
    'cat > "$out/stdin"',
    body,
    '',
  ].join('\n');
  writeFileSync(join(bin, name), script);
  chmodSync(join(bin, name), 0o755);
}

/** `printf` of one line, single-quoted for sh (the JSON holds no single quote). */
function print(line: string): string {
  return `printf '%s\\n' '${line}'`;
}

function claudeResult(result: unknown): string {
  return print(JSON.stringify({ type: 'result', result: JSON.stringify(result) }));
}

function seen(name: string, file: 'args' | 'env' | 'stdin'): string {
  return readFileSync(join(out, name, file), 'utf8');
}

function seenEnv(name: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of seen(name, 'env').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function checkout(request: string | null = REQUEST): void {
  execFileSync('git', ['init', '-q', work]);
  mkdirSync(join(work, '.git', 'snapwing'), { recursive: true });
  if (request !== null) writeFileSync(join(work, FIXER_REQUEST_PATH), request);
}

function fixerJob(over: Partial<FixerJob> = {}): FixerJob {
  return {
    runId: '01J9ZRUNID0000000000000001',
    workItem: { id: 'WI01', issueKey: 'WEB-1042', repo: 'acme/web' },
    implementationRequestArtifactId: 'ART01',
    harness: { adapter: 'claude-code' },
    budget: { wallClock: 'PT1M', attempts: 2 },
    ...over,
  };
}

function reviewJob(over: Partial<ReviewRunJob> = {}): ReviewRunJob {
  return {
    runId: '01J9ZREVIEW000000000000001',
    workItem: { id: 'WI01', issueKey: 'WEB-1042', repo: 'acme/web' },
    harness: { adapter: 'claude-code' },
    budget: { wallClock: 'PT1M', attempts: 1 },
    checkout: '/host/tree',
    inputFile: '.git/snapwing/review-input.xml',
    verdictFile: '.git/snapwing/verdict.json',
    ...over,
  };
}

const FIXER_TOKEN = (): string => issueFixerToken({ workItemId: 'WI01', incidentId: 'INC01', ttl: 'PT45M' }, keys);

/** The runner's container environment with `/work` moved to the test's directory. */
function containerEnv(env: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const moved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) moved[k] = v === DOCKER_WORKDIR || v.startsWith(`${DOCKER_WORKDIR}/`) ? work + v.slice(DOCKER_WORKDIR.length) : v;
  return { ...moved, PATH: `${bin}:${process.env['PATH'] ?? ''}`, ...extra };
}

function runEntrypoint(env: Record<string, string>, timeoutMs = 20_000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRYPOINT], { env, cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`entrypoint timed out; stderr: ${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
}

const posts = (op: string): ApiCall[] => api.filter((c) => c.method === 'POST' && c.path.endsWith(`/${op}`));

describe('fixer role', () => {
  it('runs claude-code on the mounted work item and reports through the fixer API with the run token', async () => {
    checkout();
    const done = { outcome: 'done', branch: 'fix/WEB-1042', prNumber: 87, summary: 'Guard against a null cart', testsAdded: ['test/cart.test.ts'] };
    fakeCli('claude', [`echo '{"phase":"branched","detail":"fix/WEB-1042"}' >> "$SNAPWING_CHECKPOINT_FILE"`, claudeResult(done)].join('\n'));
    const token = FIXER_TOKEN();
    const env = fixerEnv(fixerJob(), { apiUrl, token: () => token, modelProxy: proxy });

    const r = await runEntrypoint(containerEnv(env));

    expect(r.code, r.stderr).toBe(0);
    expect(api.every((c) => c.auth === `Bearer ${token}`)).toBe(true);
    expect(api.every((c) => c.path.startsWith('/fixer/WI01/'))).toBe(true);
    expect(posts('checkpoint').map((c) => c.body)).toEqual([{ phase: 'cloned' }, { phase: 'branched', detail: 'fix/WEB-1042' }]);
    expect(posts('done').map((c) => c.body)).toEqual([{ prNumber: 87, branch: 'fix/WEB-1042', summary: 'Guard against a null cart', testsAdded: ['test/cart.test.ts'] }]);
    expect(api[0]).toMatchObject({ method: 'GET', path: '/fixer/WI01/stop' });

    // The harness got the request on stdin, ran in the checkout, and never saw the fixer token.
    expect(seen('claude', 'stdin')).toBe(REQUEST);
    expect(seen('claude', 'args')).toContain('-p\n');
    const cli = seenEnv('claude');
    expect(cli['SNAPWING_ROLE']).toBe('fixer');
    expect(cli['SNAPWING_WORKDIR']).toBe(work);
    expect(cli['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(Object.keys(cli)).not.toContain('SNAPWING_FIXER_TOKEN');
    expect(seen('claude', 'env')).not.toContain(token);
    // Model access is the proxy with the per-run token, exactly as the runner set it.
    expect(cli['ANTHROPIC_BASE_URL']).toBe(env['ANTHROPIC_BASE_URL']);
    expect(cli['ANTHROPIC_BASE_URL']).toBe('http://snapwing-api:8080/model/WI01/anthropic');
    expect(cli['ANTHROPIC_API_KEY']).toBe(env['ANTHROPIC_API_KEY']);
    expect(cli['ANTHROPIC_API_KEY']?.startsWith('swm1.')).toBe(true);
    expect(r.stderr).not.toContain(token);
  });

  it('removes a provider key that is not a model proxy token, naming it but never its value', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', prNumber: 1, summary: '', testsAdded: [] }));
    const env = fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN, modelProxy: proxy });

    const r = await runEntrypoint(containerEnv(env, { ANTHROPIC_API_KEY: 'test-provider-key-not-real', ANTHROPIC_BASE_URL: 'https://api.example.test' }));

    expect(r.code, r.stderr).toBe(0);
    const cli = seenEnv('claude');
    expect(cli['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(cli['ANTHROPIC_BASE_URL']).toBe('http://snapwing-api:8080/model/WI01/anthropic');
    expect(r.stderr).toContain('removed ANTHROPIC_API_KEY');
    expect(r.stderr).not.toContain('test-provider-key-not-real');
  });

  it('gives the harness no model access without a proxy', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', prNumber: 1, summary: '', testsAdded: [] }));
    const env = fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN });

    const r = await runEntrypoint(containerEnv(env, { ANTHROPIC_API_KEY: 'test-provider-key-not-real' }));

    expect(r.code, r.stderr).toBe(0);
    const cli = seenEnv('claude');
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) expect(cli[name]).toBeUndefined();
    expect(r.stderr).toContain('no model access');
  });

  it('gives git a fresh token from the fixer API on every ask, through the credential helper, never in a file or the env', async () => {
    checkout();
    mkdirSync(join(work, '.git', 'snapwing', 'hooks'));
    const ask = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`;
    fakeCli(
      'claude',
      [
        `${ask} > "$out/cred1"`,
        `${ask} > "$out/cred2"`,
        // The recipe prompts/fixer.xml gives the agent for the GitHub API: header from stdin, never argv.
        `${ask} | sed -n 's/^password=/Authorization: Bearer /p' | curl -sS -H @- "${apiUrl}/github/pulls" > /dev/null`,
        'printf %s "$SNAPWING_GIT_CREDENTIAL_SOCKET" > "$out/socket"',
        claudeResult({ outcome: 'done', branch: 'b', prNumber: 1, summary: '', testsAdded: [] }),
      ].join('\n'),
    );
    const token = FIXER_TOKEN();
    const env = fixerEnv(fixerJob(), { apiUrl, token: () => token });
    // A git token passed by mistake (the runner no longer passes one) never reaches the harness.
    const r = await runEntrypoint(containerEnv(env, { SNAPWING_GIT_TOKEN: 'test-stale-git-token' }));

    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(out, 'claude', 'cred1'), 'utf8')).toContain('username=x-access-token\npassword=test-fresh-git-token-1\n');
    expect(readFileSync(join(out, 'claude', 'cred2'), 'utf8')).toContain('password=test-fresh-git-token-2\n');
    expect(api.find((c) => c.path === '/github/pulls')?.auth).toBe('Bearer test-fresh-git-token-3');
    const asks = api.filter((c) => c.path.endsWith('/git-token'));
    expect(asks.map((c) => [c.method, c.path, c.auth])).toEqual(Array(3).fill(['GET', '/fixer/WI01/git-token', `Bearer ${token}`]));

    const cli = seenEnv('claude');
    expect([cli['GIT_CONFIG_KEY_0'], cli['GIT_CONFIG_VALUE_0']]).toEqual(['credential.helper', '']);
    expect([cli['GIT_CONFIG_KEY_1'], cli['GIT_CONFIG_VALUE_1']]).toEqual(['credential.helper', join(FIXER_DIR, 'git-credential')]);
    expect([cli['GIT_CONFIG_KEY_2'], cli['GIT_CONFIG_VALUE_2']]).toEqual(['core.hooksPath', join(work, '.git', 'snapwing', 'hooks')]);
    expect(cli['GIT_CONFIG_COUNT']).toBe('3');
    for (const absent of ['SNAPWING_GIT_TOKEN', 'GIT_ASKPASS', 'SNAPWING_FIXER_TOKEN']) expect(cli[absent]).toBeUndefined();
    expect(seen('claude', 'env')).not.toContain('test-fresh-git-token');
    expect(seen('claude', 'env')).not.toContain('test-stale-git-token');
    expect(r.stderr).not.toContain('test-fresh-git-token');
    // The socket and its private directory are gone with the run.
    const socket = readFileSync(join(out, 'claude', 'socket'), 'utf8');
    expect(socket).toMatch(/snapwing-git-[^/]+\/credential\.sock$/);
    expect(existsSync(dirname(socket))).toBe(false);
  });

  it('answers git nothing when the fixer API will not mint, so git fails to authenticate', async () => {
    checkout();
    gitTokenStatus = 502;
    fakeCli('claude', [`printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill > "$out/cred" 2> "$out/err"; echo $? > "$out/code"`, claudeResult({ outcome: 'done', branch: 'b', prNumber: 1, summary: '', testsAdded: [] })].join('\n'));

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN }), {}), 30_000);

    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(out, 'claude', 'code'), 'utf8').trim()).not.toBe('0');
    expect(readFileSync(join(out, 'claude', 'cred'), 'utf8')).not.toContain('password=');
    expect(r.stderr).toContain('git token: HTTP 502');
  });

  it('reports a failed harness result', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'failed', reason: 'tests still failing', partialBranch: 'fix/WEB-1042', attempts: 2 }));

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(posts('failed').map((c) => c.body)).toEqual([{ reason: 'tests still failing', partialBranch: 'fix/WEB-1042', attempts: 2 }]);
    expect(posts('done')).toEqual([]);
  });

  it('reports done without a pull request as failed', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', summary: 'pushed', testsAdded: [] }));

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(posts('failed').map((c) => c.body)).toEqual([{ reason: 'the harness finished without opening a pull request', partialBranch: 'fix/WEB-1042', attempts: 1 }]);
  });

  it('reports failed, without running a harness, when the work item is not in the mount', async () => {
    checkout(null);
    fakeCli('claude', 'exit 0');

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(posts('failed')).toHaveLength(1);
    expect((posts('failed')[0]?.body as { reason: string }).reason).toContain('no implementation request');
    expect(existsSync(join(out, 'claude'))).toBe(false);
  });

  it('starts nothing when a stop is already pending', async () => {
    checkout();
    fakeCli('claude', 'exit 0');
    stopAfter = 'start';

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(0);
    expect(api.filter((c) => c.method === 'POST')).toEqual([]);
    expect(existsSync(join(out, 'claude'))).toBe(false);
  });

  it('stops the harness with SIGTERM when the stop poll after a checkpoint answers 204, and reports nothing more', async () => {
    checkout();
    fakeCli('claude', [`echo '{"phase":"branched"}' >> "$SNAPWING_CHECKPOINT_FILE"`, `trap 'echo term > "$out/term"; exit 143' TERM`, 'sleep 30 &', 'wait'].join('\n'));
    stopAfter = 'branched';

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(out, 'claude', 'term'), 'utf8')).toBe('term\n');
    expect(posts('done')).toEqual([]);
    expect(posts('failed')).toEqual([]);
    expect(r.stderr).toContain('stopped at branched');
  });

  it('treats a 409 from the API like a stop', async () => {
    checkout();
    fakeCli('claude', 'exit 0');
    checkpointStatus = 409;

    const r = await runEntrypoint(containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(0);
    expect(existsSync(join(out, 'claude'))).toBe(false);
    expect(posts('done')).toEqual([]);
  });

  it('runs a generic template the image provides, and fails cleanly on one it does not', async () => {
    checkout();
    const generic = join(dir, 'generic');
    mkdirSync(generic);
    fakeCli('aider', [`echo '{"phase":"implemented"}' >&2`, print(JSON.stringify({ outcome: 'done', branch: 'fix/WEB-1042', prNumber: 9, summary: 'aider', testsAdded: [] }))].join('\n'));
    writeFileSync(join(generic, 'aider'), `${join(bin, 'aider')} --yes\n`);
    const env = containerEnv(fixerEnv(fixerJob({ harness: { adapter: 'generic', templateId: 'aider' } }), { apiUrl, token: FIXER_TOKEN, modelProxy: proxy }), { SNAPWING_GENERIC_DIR: generic });

    const r = await runEntrypoint(env);

    expect(r.code, r.stderr).toBe(0);
    expect(seen('aider', 'args')).toBe('--yes\n');
    expect(seenEnv('aider')['ANTHROPIC_BASE_URL']).toBe('http://snapwing-api:8080/model/WI01/anthropic');
    expect(posts('checkpoint').map((c) => (c.body as { phase: string }).phase)).toEqual(['cloned', 'implemented']);
    expect(posts('done')).toHaveLength(1);

    api = [];
    const missing = await runEntrypoint({ ...env, SNAPWING_HARNESS_TEMPLATE: 'cursor' });
    expect(missing.code).toBe(EXIT_FAILED);
    expect((posts('failed')[0]?.body as { reason: string }).reason).toContain('generic harness template cursor is not in this image');
  });

  it('refuses to start without its API URL or token', async () => {
    checkout();
    const env = containerEnv(fixerEnv(fixerJob(), { apiUrl, token: FIXER_TOKEN }));
    delete env['SNAPWING_FIXER_TOKEN'];

    const r = await runEntrypoint(env);

    expect(r.code).toBe(EXIT_MISCONFIGURED);
    expect(api).toEqual([]);
  });
});

describe('review role', () => {
  const verdict = { verdict: 'request-changes', reasons: ['Handle the empty cart'], constraintViolations: [] };
  const approve = '{"verdict":"approve","reasons":[],"constraintViolations":[]}';
  const message = `Request changes.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`;
  const mountVerdict = (): string => join(work, '.git', 'snapwing', 'verdict.json');

  function reviewTree(): void {
    checkout(null);
    writeFileSync(join(work, '.git', 'snapwing', 'review-input.xml'), '<review-request>diff</review-request>\n');
  }

  /** How each CLI leaves its final message: claude and gemini print JSON, codex writes its last-message file. */
  function finalMessage(cli: 'claude' | 'codex' | 'gemini', text: string): string {
    if (cli === 'claude') return print(JSON.stringify({ type: 'result', result: text }));
    if (cli === 'gemini') return print(JSON.stringify({ response: text }));
    return ['f=""', 'while [ $# -gt 0 ]; do [ "$1" = --output-last-message ] && f="$2"; shift; done', `printf '%s' '${text}' > "$f"`].join('\n');
  }

  /** A generic review command `reviewer` running `body`, and the environment that selects it. */
  function genericReviewer(body: string): Record<string, string> {
    const generic = join(dir, 'generic');
    mkdirSync(generic);
    writeFileSync(join(generic, 'reviewer'), join(bin, 'reviewer'));
    fakeCli('reviewer', [body, print('{"outcome":"done","branch":"HEAD","summary":"reviewed","testsAdded":[]}')].join('\n'));
    return containerEnv(reviewEnv(reviewJob({ harness: { adapter: 'generic', templateId: 'reviewer' } }), { apiUrl, token: FIXER_TOKEN }), { SNAPWING_GENERIC_DIR: generic });
  }

  it.each([
    ['claude-code', 'claude', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', '/anthropic'],
    ['codex', 'codex', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', '/openai/v1'],
    ['gemini', 'gemini', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', '/google'],
  ] as const)('feeds the review input to %s on stdin and puts the verdict from its final message in the mount', async (adapter, cli, baseVar, keyVar, suffix) => {
    reviewTree();
    fakeCli(cli, finalMessage(cli, message));
    const env = reviewEnv(reviewJob({ harness: { adapter } }), { apiUrl, token: FIXER_TOKEN, modelProxy: proxy });

    const r = await runEntrypoint(containerEnv(env));

    expect(r.code, r.stderr).toBe(0);
    // codex has no system prompt flag, so its stdin is the review prompt followed by the input.
    expect(seen(cli, 'stdin').endsWith('<review-request>diff</review-request>\n')).toBe(true);
    expect(JSON.parse(readFileSync(mountVerdict(), 'utf8'))).toEqual(verdict);
    const seenBy = seenEnv(cli);
    expect(seenBy['SNAPWING_ROLE']).toBe('review');
    // The agent is never told where a verdict file is (#263).
    expect(seenBy['SNAPWING_REVIEW_FILE']).toBeUndefined();
    expect(seenBy[baseVar]).toBe(`http://snapwing-api:8080/model/WI01${suffix}`);
    expect(seenBy[keyVar]?.startsWith('swm1.')).toBe(true);
    for (const absent of ['SNAPWING_FIXER_TOKEN', 'SNAPWING_GIT_TOKEN', 'GIT_ASKPASS', 'SNAPWING_API_URL']) expect(seenBy[absent]).toBeUndefined();
    expect(api).toEqual([]);
  });

  it('code in the container that writes the mount\'s verdict file does not change the verdict (#263)', async () => {
    reviewTree();
    const planted = join(out, 'planted');
    fakeCli('claude', [`printf '%s' '${approve}' > "$SNAPWING_WORKDIR/.git/snapwing/verdict.json"`, `cp "$SNAPWING_WORKDIR/.git/snapwing/verdict.json" '${planted}'`, finalMessage('claude', message)].join('\n'));

    const r = await runEntrypoint(containerEnv(reviewEnv(reviewJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(planted, 'utf8')).toBe(approve);
    expect(JSON.parse(readFileSync(mountVerdict(), 'utf8'))).toEqual(verdict);
  });

  it('a generic review command writes its own file outside the mount, which the wrapper copies in afterwards', async () => {
    reviewTree();
    const env = genericReviewer(`printf '%s' '${JSON.stringify(verdict)}' > "$SNAPWING_REVIEW_FILE"`);

    const r = await runEntrypoint(env);

    expect(r.code, r.stderr).toBe(0);
    const own = seenEnv('reviewer')['SNAPWING_REVIEW_FILE'] ?? '';
    expect(own).not.toBe('');
    expect(own.startsWith(work)).toBe(false);
    // Removed with the run.
    expect(existsSync(own)).toBe(false);
    expect(JSON.parse(readFileSync(mountVerdict(), 'utf8'))).toEqual(verdict);
  });

  it('a verdict file the harness left as a link is not followed: no verdict', async () => {
    reviewTree();
    writeFileSync(join(dir, 'elsewhere.json'), approve);
    const env = genericReviewer(`ln -s '${join(dir, 'elsewhere.json')}' "$SNAPWING_REVIEW_FILE"`);

    const r = await runEntrypoint(env);

    expect(r.code).toBe(EXIT_FAILED);
    expect(r.stderr).toContain('no verdict file');
    expect(existsSync(mountVerdict())).toBe(false);
  });

  it('exits non-zero when the harness writes no verdict', async () => {
    reviewTree();
    fakeCli('claude', 'exit 0');

    const r = await runEntrypoint(containerEnv(reviewEnv(reviewJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(r.stderr).toContain('no verdict file');
  });

  it('exits non-zero when the harness fails, whatever is in the mount', async () => {
    reviewTree();
    fakeCli('claude', [`printf '%s' '${approve}' > "$SNAPWING_WORKDIR/.git/snapwing/verdict.json"`, finalMessage('claude', message), 'exit 3'].join('\n'));

    const r = await runEntrypoint(containerEnv(reviewEnv(reviewJob(), { apiUrl, token: FIXER_TOKEN })));

    // The review job reads nothing back from a run that exits non-zero.
    expect(r.code).toBe(EXIT_FAILED);
  });

  it('refuses a verdict path outside the mount', async () => {
    reviewTree();
    const env = containerEnv(reviewEnv(reviewJob(), { apiUrl, token: FIXER_TOKEN }), { SNAPWING_REVIEW_FILE: join(dir, 'elsewhere.json') });

    const r = await runEntrypoint(env);

    expect(r.code).toBe(EXIT_MISCONFIGURED);
  });
});

describe('modelAccess', () => {
  it('derives every base URL from the proxy and keeps only model tokens', () => {
    const r = modelAccess({
      SNAPWING_MODEL_PROXY_URL: 'http://api:8080/model/WI01/',
      ANTHROPIC_API_KEY: 'swm1.a.b',
      OPENAI_API_KEY: 'test-openai-key-not-real',
      GOOGLE_API_KEY: 'swm1.a.b',
      OPENAI_BASE_URL: 'https://api.example.test/v1',
    });
    expect(r.vars).toEqual({
      SNAPWING_MODEL_PROXY_URL: 'http://api:8080/model/WI01',
      ANTHROPIC_BASE_URL: 'http://api:8080/model/WI01/anthropic',
      OPENAI_BASE_URL: 'http://api:8080/model/WI01/openai/v1',
      GOOGLE_GEMINI_BASE_URL: 'http://api:8080/model/WI01/google',
      ANTHROPIC_API_KEY: 'swm1.a.b',
    });
    expect(r.notes).toEqual(['removed OPENAI_API_KEY: not a model proxy token', 'removed GOOGLE_API_KEY: not a model proxy token']);
  });

  it('gives nothing without a proxy or with one that is not http(s)', () => {
    expect(modelAccess({ ANTHROPIC_API_KEY: 'swm1.a.b' }).vars).toEqual({});
    expect(modelAccess({ SNAPWING_MODEL_PROXY_URL: 'file:///etc/passwd', ANTHROPIC_API_KEY: 'swm1.a.b' }).vars).toEqual({});
  });

  it('replaces the model variables of the process environment', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', ANTHROPIC_API_KEY: 'test-key-not-real', GOOGLE_API_KEY: 'x' };
    applyModelAccess(env, { ANTHROPIC_BASE_URL: 'http://p/anthropic' });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://p/anthropic' });
  });
});

describe('the image definition', () => {
  const dockerfile = readFileSync(join(FIXER_DIR, 'Dockerfile'), 'utf8');
  const instructions = dockerfile.split('\n').filter((l) => /^[A-Z]+\s/.test(l));

  it('is a slim Node 20+ image with git, tini, and the claude-code CLI; codex and gemini behind build args', () => {
    const version = /^ARG NODE_VERSION=(\d+)$/m.exec(dockerfile)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(22); // 22.18+ runs the wrapper's TypeScript directly
    expect(dockerfile).toMatch(/^FROM node:\$\{NODE_VERSION\}-bookworm-slim$/m);
    expect(dockerfile).toMatch(/apt-get install .*\bgit\b.*\btini\b/);
    expect(dockerfile).toContain('npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(dockerfile).toMatch(/if \[ "\$\{INSTALL_CODEX\}" = "true" \]; then npm install -g "@openai\/codex@/);
    expect(dockerfile).toMatch(/if \[ "\$\{INSTALL_GEMINI\}" = "true" \]; then npm install -g "@google\/gemini-cli@/);
    expect(dockerfile).toMatch(/^ARG INSTALL_CODEX=false$/m);
    expect(dockerfile).toMatch(/^ARG INSTALL_GEMINI=false$/m);
  });

  it('runs the wrapper as a non-root user under tini', () => {
    const users = instructions.filter((l) => l.startsWith('USER '));
    expect(users.at(-1)).toBe('USER snapwing');
    expect(instructions.at(-1)).toBe('ENTRYPOINT ["/usr/bin/tini", "--", "node", "--disable-warning=ExperimentalWarning", "/opt/snapwing/infra/docker/fixer/entrypoint.ts"]');
  });

  it('bakes in no secret: no key or token variable, and only the wrapper and the pipeline source in the context', () => {
    for (const l of instructions.filter((x) => /^(ENV|ARG) /.test(x))) expect(l).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
    const copies = instructions.filter((l) => l.startsWith('COPY ')).map((l) => l.split(/\s+/).slice(1, -1));
    expect(copies.flat().sort()).toEqual(['infra/docker/fixer/git-credential', 'infra/docker/fixer/entrypoint.ts', 'infra/docker/fixer/wrapper.ts', 'packages/pipeline/src'].sort());
    const ignore = readFileSync(join(FIXER_DIR, 'Dockerfile.dockerignore'), 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(ignore[0]).toBe('*');
    expect(ignore.slice(1).every((l) => l.startsWith('!packages/pipeline/src/') || l.startsWith('!infra/docker/fixer/'))).toBe(true);
  });

  it('imports nothing the image does not copy', () => {
    const wrapper = readFileSync(join(FIXER_DIR, 'wrapper.ts'), 'utf8');
    const specs = [...wrapper.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1] ?? '');
    for (const s of specs) {
      if (s.startsWith('node:')) continue;
      expect(resolve(FIXER_DIR, s).startsWith(join(ROOT, 'packages/pipeline/src/'))).toBe(true);
    }
  });

  it('is built by pnpm fixer-image:build with the documented tag', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['fixer-image:build']).toBe('docker build -f infra/docker/fixer/Dockerfile -t snapwing-fixer:local .');
    expect(readFileSync(join(ROOT, 'docs/harness-generic.md'), 'utf8')).toContain('SNAPWING_FIXER_IMAGE=snapwing-fixer:local');
  });
});
