// The fixer image's entrypoint wrapper (infra/docker/fixer/, ADR 0017 with amendment 1, #273,
// docs/harness-generic.md). The real entrypoint runs as a child process with the exact environment
// and credentials file the docker runner builds (`fixerEnv`, `reviewEnv`, `fixerCredentials`,
// `reviewCredentials`), fake `claude`, `codex`, and `gemini` CLIs on PATH, and a fake fixer API and
// model proxy. No docker runs here and the image is never built: the Dockerfile is checked statically,
// and the relay runs as a child process too.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixerJob, ReviewRunJob } from '@snapwing/pipeline/ports/runner.ts';
import { issueFixerToken } from '../../src/fixer-api/token.ts';
import { issueModelToken } from '../../src/model-proxy/token.ts';
import {
  DOCKER_CREDENTIALS_DIR,
  DOCKER_OUTDIR,
  DOCKER_WORKDIR,
  fixerCredentials,
  fixerEnv,
  reviewCredentials,
  reviewEnv,
  type DockerModelProxy,
  type DockerRunnerEnv,
} from '../../src/providers/docker/runner.ts';
import { applyModelAccess, EXIT_FAILED, EXIT_MISCONFIGURED, FIXER_REQUEST_PATH, LOCAL_MODEL_KEY, modelVars, takeCredentials } from '../../../../infra/docker/fixer/wrapper.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXER_DIR = join(ROOT, 'infra/docker/fixer');
const ENTRYPOINT = join(FIXER_DIR, 'entrypoint.ts');

const keys = { secret: 'fake-hmac-key-for-tests-0123456789abcdef', clock: () => new Date() };
const grant = { provider: 'anthropic', model: 'claude-pinned', maxTokens: 1000 } as const;
const proxy: DockerModelProxy = {
  url: 'http://snapwing-api:8080/model',
  token: (run) => issueModelToken({ workItemId: run.workItem.id, runId: run.runId, ttl: 'PT45M', ...grant }, keys),
  model: () => 'claude-pinned',
};
/** The loopback base URL the wrapper gives a harness, with the path a CLI's base URL adds. */
const loopback = (suffix: string): RegExp => new RegExp(`^http://127\\.0\\.0\\.1:\\d+${suffix.replaceAll('/', '\\/')}$`);
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
/** The run's hand-off directory, mounted at `/out` in a container. */
let handoffDir: string;
/** The run's credentials directory, mounted at `/run/snapwing` in a container. */
let credsDir: string;
let server: Server;
let apiUrl: string;
let api: ApiCall[];
/** Stop answers 204 once a checkpoint with this phase arrived ('start': from the first poll). */
let stopAfter: string | undefined;
let checkpointStatus: number;
/** What `POST .../done` answers. */
let doneAnswer: { status: number; body: unknown };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fixer-image-'));
  work = join(dir, 'work');
  bin = join(dir, 'bin');
  out = join(dir, 'out');
  handoffDir = join(dir, 'handoff');
  credsDir = join(dir, 'creds');
  for (const d of [work, bin, out, handoffDir, credsDir]) mkdirSync(d);
  api = [];
  stopAfter = undefined;
  checkpointStatus = 200;
  doneAnswer = { status: 200, body: { seq: 1 } };
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
      } else if (call.path.endsWith('/done')) {
        res.writeHead(doneAnswer.status).end(JSON.stringify(doneAnswer.body));
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

const WORK_BRANCH = 'fix/WEB-1042';
const GIT_TEST_ENV = { PATH: process.env['PATH'] ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
/** The commit the prepared checkout's work branch starts at (`SNAPWING_BASE_SHA`). */
let baseSha: string;

/** A prepared checkout on the work branch, at one base commit, with the request inside it. */
function checkout(request: string | null = REQUEST): void {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: work, env: GIT_TEST_ENV, encoding: 'utf8' }).trim();
  git(['init', '-q', `--initial-branch=${WORK_BRANCH}`]);
  git(['config', 'user.name', 'snapwing[bot]']);
  git(['config', 'user.email', 'snapwing[bot]@users.noreply.github.com']);
  writeFileSync(join(work, 'cart.ts'), 'export const total = 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  baseSha = git(['rev-parse', 'HEAD']);
  mkdirSync(join(work, '.git', 'snapwing'), { recursive: true });
  if (request !== null) writeFileSync(join(work, FIXER_REQUEST_PATH), request);
}

/** A shell line for a fake CLI: commit a change on the work branch, as an agent does. */
const COMMIT = `echo 'export const total = 2;' > cart.ts && git add -A && git commit -q -m 'WEB-1042: guard the cart total'`;

/** The credentials file as the runner writes it. */
function writeCredentials(credentials: object | undefined): void {
  if (credentials !== undefined) writeFileSync(join(credsDir, 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
}

/** The docker runner's fixer environment and credentials file for `job`, with the hand-off of the prepared checkout. */
function fixerContainer(env: DockerRunnerEnv, job: FixerJob = fixerJob()): Record<string, string> {
  writeCredentials(fixerCredentials(job, env));
  return fixerEnv(job, env, { branch: WORK_BRANCH, expectedBase: baseSha });
}

/** The docker runner's review environment and credentials file for `job`. */
function reviewContainer(job: ReviewRunJob, env: DockerRunnerEnv): Record<string, string> {
  writeCredentials(reviewCredentials(job, env));
  return reviewEnv(job, env);
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

const FIXER_TOKEN = (): string => issueFixerToken({ workItemId: 'WI01', incidentId: 'INC01', runId: '01J9ZRUNID0000000000000001', ttl: 'PT45M' }, keys);

/** The runner's container environment with `/work` and `/out` moved to the test's directories. */
function containerEnv(env: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const moved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === DOCKER_WORKDIR || v.startsWith(`${DOCKER_WORKDIR}/`)) moved[k] = work + v.slice(DOCKER_WORKDIR.length);
    else if (v.startsWith(`${DOCKER_OUTDIR}/`)) moved[k] = handoffDir + v.slice(DOCKER_OUTDIR.length);
    else if (v.startsWith(`${DOCKER_CREDENTIALS_DIR}/`)) moved[k] = credsDir + v.slice(DOCKER_CREDENTIALS_DIR.length);
    else moved[k] = v;
  }
  return { ...moved, PATH: `${bin}:${process.env['PATH'] ?? ''}`, ...extra };
}

/** `git bundle list-heads` of the bundle the wrapper left, or null when it left none. */
function handedBack(): string | null {
  const file = join(handoffDir, 'work.bundle');
  return existsSync(file) ? execFileSync('git', ['bundle', 'list-heads', file], { cwd: dir, env: GIT_TEST_ENV, encoding: 'utf8' }).trim() : null;
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
  it('runs claude-code on the mounted work item, bundles the work branch into /out, and reports done through the fixer API with the run token', async () => {
    checkout();
    const done = { outcome: 'done', branch: 'fix/WEB-1042', prNumber: 87, summary: 'Guard against a null cart', testsAdded: ['test/cart.test.ts'] };
    fakeCli('claude', [`echo '{"phase":"branched","detail":"fix/WEB-1042"}' >> "$SNAPWING_CHECKPOINT_FILE"`, `ls '${credsDir}' > "$out/creds"`, COMMIT, claudeResult(done)].join('\n'));
    const token = FIXER_TOKEN();
    const env = fixerContainer({ apiUrl, token: () => token, modelProxy: proxy });
    const modelToken = JSON.parse(readFileSync(join(credsDir, 'credentials.json'), 'utf8')).modelToken as string;

    const r = await runEntrypoint(containerEnv(env));

    expect(r.code, r.stderr).toBe(0);
    expect(api.every((c) => c.auth === `Bearer ${token}`)).toBe(true);
    expect(api.every((c) => c.path.startsWith('/fixer/WI01/'))).toBe(true);
    expect(posts('checkpoint').map((c) => c.body)).toEqual([{ phase: 'cloned' }, { phase: 'branched', detail: 'fix/WEB-1042' }]);
    // No branch and no pull request number: the server pushes the run's branch and opens the PR (#262).
    expect(posts('done').map((c) => c.body)).toEqual([{ summary: 'Guard against a null cart', testsAdded: ['test/cart.test.ts'] }]);
    expect(api[0]).toMatchObject({ method: 'GET', path: '/fixer/WI01/stop' });
    const tip = execFileSync('git', ['rev-parse', `refs/heads/${WORK_BRANCH}`], { cwd: work, env: GIT_TEST_ENV, encoding: 'utf8' }).trim();
    expect(handedBack()).toBe(`${tip} refs/heads/${WORK_BRANCH}`);

    // The harness got the request on stdin, ran in the checkout, and never saw the fixer token.
    expect(seen('claude', 'stdin')).toBe(REQUEST);
    expect(seen('claude', 'args')).toContain('-p\n');
    const cli = seenEnv('claude');
    expect(cli['SNAPWING_ROLE']).toBe('fixer');
    expect(cli['SNAPWING_WORKDIR']).toBe(work);
    expect(cli['GIT_CONFIG_NOSYSTEM']).toBe('1');
    for (const name of ['SNAPWING_FIXER_TOKEN', 'SNAPWING_CREDENTIALS_FILE']) expect(Object.keys(cli)).not.toContain(name);
    // Neither token is in its environment, and the credentials file was gone before it started (#273).
    expect(seen('claude', 'env')).not.toContain(token);
    expect(seen('claude', 'env')).not.toContain(modelToken);
    expect(seen('claude', 'env')).not.toMatch(/swm1\.|swf1\./);
    expect(readFileSync(join(out, 'claude', 'creds'), 'utf8')).toBe('');
    // Model access is the wrapper's loopback forwarder with a placeholder key, and the pinned model.
    expect(cli['ANTHROPIC_BASE_URL']).toMatch(loopback('/anthropic'));
    expect(cli['ANTHROPIC_API_KEY']).toBe(LOCAL_MODEL_KEY);
    expect(seen('claude', 'args')).toContain('--model\nclaude-pinned\n');
    expect(r.stderr).not.toContain(token);
  });

  it('sends the agent\'s model calls to the proxy with the run\'s model token, which the agent never holds (#273)', async () => {
    checkout();
    const call = [
      `${JSON.stringify(process.execPath)} -e '`,
      'fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", { method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: "m", max_tokens: 9 }) })',
      '.then((r) => r.text()).then((t) => require("fs").writeFileSync(process.argv[1], t))',
      `' "$out/answer"`,
    ].join('');
    fakeCli('claude', [call, claudeResult({ outcome: 'done', branch: 'b', summary: '', testsAdded: [] })].join('\n'));
    const env = fixerContainer({ apiUrl, token: FIXER_TOKEN, modelProxy: { ...proxy, url: `${apiUrl}/model` } });
    const modelToken = JSON.parse(readFileSync(join(credsDir, 'credentials.json'), 'utf8')).modelToken as string;

    const r = await runEntrypoint(containerEnv(env));

    expect(r.code, r.stderr).toBe(0);
    const model = api.filter((c) => c.path.startsWith('/model/'));
    expect(model).toEqual([{ method: 'POST', path: '/model/WI01/anthropic/v1/messages?beta=true', auth: `Bearer ${modelToken}`, body: { model: 'm', max_tokens: 9 } }]);
    expect(readFileSync(join(out, 'claude', 'answer'), 'utf8')).toBe('{"seq":1}');
    expect(seen('claude', 'env')).not.toContain(modelToken);
  });

  it('removes a provider key and a token the container was started with, naming it but never its value', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', summary: '', testsAdded: [] }));
    const env = fixerContainer({ apiUrl, token: FIXER_TOKEN, modelProxy: proxy });

    const r = await runEntrypoint(containerEnv(env, { ANTHROPIC_API_KEY: 'test-provider-key-not-real', ANTHROPIC_BASE_URL: 'https://api.example.test', SNAPWING_FIXER_TOKEN: FIXER_TOKEN() }));

    expect(r.code, r.stderr).toBe(0);
    const cli = seenEnv('claude');
    expect(cli['ANTHROPIC_API_KEY']).toBe(LOCAL_MODEL_KEY);
    expect(cli['ANTHROPIC_BASE_URL']).toMatch(loopback('/anthropic'));
    expect(cli['SNAPWING_FIXER_TOKEN']).toBeUndefined();
    expect(r.stderr).toContain('removed ANTHROPIC_API_KEY');
    expect(r.stderr).not.toContain('test-provider-key-not-real');
  });

  it('gives the harness no model access without a proxy', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', summary: '', testsAdded: [] }));
    const env = fixerContainer({ apiUrl, token: FIXER_TOKEN });

    const r = await runEntrypoint(containerEnv(env, { ANTHROPIC_API_KEY: 'test-provider-key-not-real' }));

    expect(r.code, r.stderr).toBe(0);
    const cli = seenEnv('claude');
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) expect(cli[name]).toBeUndefined();
    expect(r.stderr).toContain('no model access');
  });

  it('gives the harness no GitHub credential: no token, askpass, socket, or helper, and git cannot get one (#262)', async () => {
    checkout();
    mkdirSync(join(work, '.git', 'snapwing', 'hooks'));
    fakeCli(
      'claude',
      [
        `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill > "$out/cred" 2> /dev/null; echo $? > "$out/code"`,
        COMMIT,
        claudeResult({ outcome: 'done', branch: 'b', summary: '', testsAdded: [] }),
      ].join('\n'),
    );
    const token = FIXER_TOKEN();
    // A git token passed by mistake (no runner passes one) never reaches the harness.
    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: () => token }), { SNAPWING_GIT_TOKEN: 'test-stale-git-token' }));

    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(out, 'claude', 'code'), 'utf8').trim()).not.toBe('0');
    expect(readFileSync(join(out, 'claude', 'cred'), 'utf8')).not.toContain('password=');
    const cli = seenEnv('claude');
    for (const absent of ['SNAPWING_GIT_TOKEN', 'GIT_ASKPASS', 'SNAPWING_GIT_CREDENTIAL_SOCKET', 'SNAPWING_FIXER_TOKEN', 'SNAPWING_HANDOFF_FILE', 'SNAPWING_BASE_SHA']) expect(cli[absent]).toBeUndefined();
    // Git's only extra config is the checkout's own hooks.
    expect([cli['GIT_CONFIG_COUNT'], cli['GIT_CONFIG_KEY_0'], cli['GIT_CONFIG_VALUE_0']]).toEqual(['1', 'core.hooksPath', join(work, '.git', 'snapwing', 'hooks')]);
    expect(seen('claude', 'env')).not.toContain('test-stale-git-token');
    expect(api.filter((c) => c.path.endsWith('/git-token'))).toEqual([]);
  });

  it('reports a failed harness result, keeping committed partial work as the run\'s branch and nothing else', async () => {
    checkout();
    fakeCli('claude', [COMMIT, claudeResult({ outcome: 'failed', reason: 'tests still failing', partialBranch: 'some-other-branch', attempts: 2 })].join('\n'));

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(posts('failed').map((c) => c.body)).toEqual([{ reason: 'tests still failing', partialBranch: WORK_BRANCH, attempts: 2 }]);
    expect(handedBack()).toMatch(new RegExp(` refs/heads/${WORK_BRANCH}$`));
    expect(posts('done')).toEqual([]);
  });

  it('reports a failure with no committed work without a partial branch, and leaves no bundle', async () => {
    checkout();
    fakeCli('claude', claudeResult({ outcome: 'failed', reason: 'tests still failing', partialBranch: 'fix/WEB-1042', attempts: 2 }));

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(posts('failed').map((c) => c.body)).toEqual([{ reason: 'tests still failing', attempts: 2 }]);
    expect(handedBack()).toBeNull();
  });

  it('reports failed with the server\'s reason when the server refuses the hand-off', async () => {
    checkout();
    doneAnswer = { status: 409, body: { error: 'handoff-refused', reason: 'the run left no bundle of its work branch; the fixer must commit its change on it' } };
    fakeCli('claude', claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', summary: 'pushed', testsAdded: [] }));

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(r.stderr).toContain('nothing is committed on fix/WEB-1042 beyond its base');
    expect(posts('done')).toHaveLength(1);
    expect(posts('failed').map((c) => c.body)).toEqual([{ reason: 'handoff refused: the run left no bundle of its work branch; the fixer must commit its change on it', attempts: 1 }]);
  });

  it('treats any other 409 on done like a stop', async () => {
    checkout();
    doneAnswer = { status: 409, body: { error: 'run-finished' } };
    fakeCli('claude', [COMMIT, claudeResult({ outcome: 'done', branch: 'fix/WEB-1042', summary: 'x', testsAdded: [] })].join('\n'));

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(0);
    expect(posts('failed')).toEqual([]);
  });

  it('reports failed, without running a harness, when the work item is not in the mount', async () => {
    checkout(null);
    fakeCli('claude', 'exit 0');

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(posts('failed')).toHaveLength(1);
    expect((posts('failed')[0]?.body as { reason: string }).reason).toContain('no implementation request');
    expect(existsSync(join(out, 'claude'))).toBe(false);
  });

  it('starts nothing when a stop is already pending', async () => {
    checkout();
    fakeCli('claude', 'exit 0');
    stopAfter = 'start';

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(0);
    expect(api.filter((c) => c.method === 'POST')).toEqual([]);
    expect(existsSync(join(out, 'claude'))).toBe(false);
  });

  it('stops the harness with SIGTERM when the stop poll after a checkpoint answers 204, and reports and hands back nothing', async () => {
    checkout();
    fakeCli('claude', [COMMIT, `echo '{"phase":"branched"}' >> "$SNAPWING_CHECKPOINT_FILE"`, `trap 'echo term > "$out/term"; exit 143' TERM`, 'sleep 30 &', 'wait'].join('\n'));
    stopAfter = 'branched';

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(out, 'claude', 'term'), 'utf8')).toBe('term\n');
    expect(posts('done')).toEqual([]);
    expect(posts('failed')).toEqual([]);
    expect(handedBack()).toBeNull();
    expect(r.stderr).toContain('stopped at branched');
  });

  it('treats a 409 from the API like a stop', async () => {
    checkout();
    fakeCli('claude', 'exit 0');
    checkpointStatus = 409;

    const r = await runEntrypoint(containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(0);
    expect(existsSync(join(out, 'claude'))).toBe(false);
    expect(posts('done')).toEqual([]);
  });

  it('runs a generic template the image provides, and fails cleanly on one it does not', async () => {
    checkout();
    const generic = join(dir, 'generic');
    mkdirSync(generic);
    fakeCli('aider', [`echo '{"phase":"implemented"}' >&2`, COMMIT, print(JSON.stringify({ outcome: 'done', branch: 'fix/WEB-1042', summary: 'aider', testsAdded: [] }))].join('\n'));
    writeFileSync(join(generic, 'aider'), `${join(bin, 'aider')} --yes\n`);
    const env = containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN, modelProxy: proxy }, fixerJob({ harness: { adapter: 'generic', templateId: 'aider' } })), { SNAPWING_GENERIC_DIR: generic });

    const r = await runEntrypoint(env);

    expect(r.code, r.stderr).toBe(0);
    expect(seen('aider', 'args')).toBe('--yes\n');
    expect(seenEnv('aider')['ANTHROPIC_BASE_URL']).toMatch(loopback('/anthropic'));
    expect(posts('checkpoint').map((c) => (c.body as { phase: string }).phase)).toEqual(['cloned', 'implemented']);
    expect(posts('done')).toHaveLength(1);

    api = [];
    writeCredentials(fixerCredentials(fixerJob(), { apiUrl, token: FIXER_TOKEN }));
    const missing = await runEntrypoint({ ...env, SNAPWING_HARNESS_TEMPLATE: 'cursor' });
    expect(missing.code).toBe(EXIT_FAILED);
    expect((posts('failed')[0]?.body as { reason: string }).reason).toContain('generic harness template cursor is not in this image');
  });

  it('refuses to start without its API URL or a fixer token in the credentials file, and never takes one from the environment', async () => {
    checkout();
    const env = containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN }), { SNAPWING_FIXER_TOKEN: FIXER_TOKEN() });
    rmSync(join(credsDir, 'credentials.json'));

    const r = await runEntrypoint(env);

    expect(r.code).toBe(EXIT_MISCONFIGURED);
    expect(r.stderr).toContain('SNAPWING_CREDENTIALS_FILE');
    expect(api).toEqual([]);
  });

  it('refuses to start without the hand-off: the work branch, its base, and a bundle path outside the checkout', async () => {
    checkout();
    const env = containerEnv(fixerContainer({ apiUrl, token: FIXER_TOKEN }));
    for (const [name, value] of [
      ['SNAPWING_WORK_BRANCH', undefined],
      ['SNAPWING_BASE_SHA', 'HEAD'],
      ['SNAPWING_HANDOFF_FILE', join(work, '.git', 'snapwing', 'work.bundle')],
    ] as const) {
      const broken = { ...env };
      if (value === undefined) delete broken[name];
      else broken[name] = value;
      // Each run takes the credentials file.
      writeCredentials(fixerCredentials(fixerJob(), { apiUrl, token: FIXER_TOKEN }));
      const r = await runEntrypoint(broken);
      expect(r.code, name).toBe(EXIT_MISCONFIGURED);
      expect(r.stderr).toContain(name);
    }
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
    return containerEnv(reviewContainer(reviewJob({ harness: { adapter: 'generic', templateId: 'reviewer' } }), { apiUrl, token: FIXER_TOKEN }), { SNAPWING_GENERIC_DIR: generic });
  }

  it.each([
    ['claude-code', 'claude', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', '/anthropic'],
    ['codex', 'codex', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', '/openai/v1'],
    ['gemini', 'gemini', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', '/google'],
  ] as const)('feeds the review input to %s on stdin and puts the verdict from its final message in the mount', async (adapter, cli, baseVar, keyVar, suffix) => {
    reviewTree();
    fakeCli(cli, finalMessage(cli, message));
    const env = reviewContainer(reviewJob({ harness: { adapter } }), { apiUrl, token: FIXER_TOKEN, modelProxy: proxy });

    const r = await runEntrypoint(containerEnv(env));

    expect(r.code, r.stderr).toBe(0);
    // codex has no system prompt flag, so its stdin is the review prompt followed by the input.
    expect(seen(cli, 'stdin').endsWith('<review-request>diff</review-request>\n')).toBe(true);
    expect(JSON.parse(readFileSync(mountVerdict(), 'utf8'))).toEqual(verdict);
    const seenBy = seenEnv(cli);
    expect(seenBy['SNAPWING_ROLE']).toBe('review');
    // The agent is never told where a verdict file is (#263).
    expect(seenBy['SNAPWING_REVIEW_FILE']).toBeUndefined();
    expect(seenBy[baseVar]).toMatch(loopback(suffix));
    expect(seenBy[keyVar]).toBe(LOCAL_MODEL_KEY);
    expect(seen(cli, 'env')).not.toContain('swm1.');
    expect(existsSync(join(credsDir, 'credentials.json'))).toBe(false);
    for (const absent of ['SNAPWING_FIXER_TOKEN', 'SNAPWING_GIT_TOKEN', 'GIT_ASKPASS', 'SNAPWING_API_URL', 'SNAPWING_CREDENTIALS_FILE']) expect(seenBy[absent]).toBeUndefined();
    expect(api).toEqual([]);
  });

  it('code in the container that writes the mount\'s verdict file does not change the verdict (#263)', async () => {
    reviewTree();
    const planted = join(out, 'planted');
    fakeCli('claude', [`printf '%s' '${approve}' > "$SNAPWING_WORKDIR/.git/snapwing/verdict.json"`, `cp "$SNAPWING_WORKDIR/.git/snapwing/verdict.json" '${planted}'`, finalMessage('claude', message)].join('\n'));

    const r = await runEntrypoint(containerEnv(reviewContainer(reviewJob(), { apiUrl, token: FIXER_TOKEN })));

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

    const r = await runEntrypoint(containerEnv(reviewContainer(reviewJob(), { apiUrl, token: FIXER_TOKEN })));

    expect(r.code).toBe(EXIT_FAILED);
    expect(r.stderr).toContain('no verdict file');
  });

  it('exits non-zero when the harness fails, whatever is in the mount', async () => {
    reviewTree();
    fakeCli('claude', [`printf '%s' '${approve}' > "$SNAPWING_WORKDIR/.git/snapwing/verdict.json"`, finalMessage('claude', message), 'exit 3'].join('\n'));

    const r = await runEntrypoint(containerEnv(reviewContainer(reviewJob(), { apiUrl, token: FIXER_TOKEN })));

    // The review job reads nothing back from a run that exits non-zero.
    expect(r.code).toBe(EXIT_FAILED);
  });

  it('refuses a verdict path outside the mount', async () => {
    reviewTree();
    const env = containerEnv(reviewContainer(reviewJob(), { apiUrl, token: FIXER_TOKEN }), { SNAPWING_REVIEW_FILE: join(dir, 'elsewhere.json') });

    const r = await runEntrypoint(env);

    expect(r.code).toBe(EXIT_MISCONFIGURED);
  });
});

describe('model access and credentials (#273)', () => {
  it('derives every base URL from the loopback forwarder, with the placeholder key', () => {
    expect(modelVars('http://127.0.0.1:4100')).toEqual({
      SNAPWING_MODEL_PROXY_URL: 'http://127.0.0.1:4100',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/anthropic',
      OPENAI_BASE_URL: 'http://127.0.0.1:4100/openai/v1',
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:4100/google',
      ANTHROPIC_API_KEY: LOCAL_MODEL_KEY,
      OPENAI_API_KEY: LOCAL_MODEL_KEY,
      CODEX_API_KEY: LOCAL_MODEL_KEY,
      GEMINI_API_KEY: LOCAL_MODEL_KEY,
    });
  });

  it('takes the credentials once: the file is removed, and only tokens of the right kind are kept', async () => {
    const file = join(credsDir, 'credentials.json');
    writeFileSync(file, JSON.stringify({ fixerToken: 'swm1.wrong.kind', modelToken: 'swm1.a.b' }));
    expect(await takeCredentials({ SNAPWING_CREDENTIALS_FILE: file }, work)).toEqual({ modelToken: 'swm1.a.b' });
    expect(existsSync(file)).toBe(false);
    expect(await takeCredentials({ SNAPWING_CREDENTIALS_FILE: file }, work)).toEqual({});
    // Never from inside the checkout, and never through a link.
    writeFileSync(join(work, 'creds.json'), JSON.stringify({ fixerToken: 'swf1.a.b' }));
    expect(await takeCredentials({ SNAPWING_CREDENTIALS_FILE: join(work, 'creds.json') }, work)).toEqual({});
    symlinkSync(join(work, 'creds.json'), file);
    expect(await takeCredentials({ SNAPWING_CREDENTIALS_FILE: file }, work)).toEqual({});
  });

  it('replaces the model variables of the process environment', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', ANTHROPIC_API_KEY: 'test-key-not-real', GOOGLE_API_KEY: 'x' };
    applyModelAccess(env, { ANTHROPIC_BASE_URL: 'http://p/anthropic' });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://p/anthropic' });
  });
});

describe('the relay (#273)', () => {
  it('forwards only the fixer API and the model proxy to its upstream, headers as sent, and nothing else', async () => {
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(FIXER_DIR, 'relay.ts')], {
      env: { PATH: process.env['PATH'] ?? '', SNAPWING_RELAY_UPSTREAM: apiUrl, SNAPWING_RELAY_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      await new Promise<void>((r) => child.stderr.on('data', (c: Buffer) => c.toString('utf8').includes('listening') && r()));
      const relay = `http://127.0.0.1:${port}`;
      const stop = await fetch(`${relay}/fixer/WI01/stop`, { headers: { authorization: 'Bearer swf1.a.b' } });
      expect(stop.status).toBe(200);
      const model = await fetch(`${relay}/model/WI01/anthropic/v1/messages?key=dropped`, { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"a":1}' });
      expect(model.status).toBe(200);
      for (const path of ['/', '/healthz', '/metrics', '/fixer', '/webhooks/github', '/model/../metrics', '/fixer/%2e%2e/metrics']) {
        expect((await fetch(`${relay}${path}`)).status, path).toBe(404);
      }
      expect(api.map((c) => `${c.method} ${c.path} ${c.auth ?? ''}`)).toEqual(['GET /fixer/WI01/stop Bearer swf1.a.b', 'POST /model/WI01/anthropic/v1/messages ']);
    } finally {
      child.kill('SIGTERM');
    }
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

  it('bakes in no secret: no key or token variable, and only the wrapper, the relay, and the pipeline source in the context', () => {
    for (const l of instructions.filter((x) => /^(ENV|ARG) /.test(x))) expect(l).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
    const copies = instructions.filter((l) => l.startsWith('COPY ')).map((l) => l.split(/\s+/).slice(1, -1));
    // No credential helper either: nothing in the image fetches or holds a GitHub token (#262).
    expect(copies.flat().sort()).toEqual(['infra/docker/fixer/entrypoint.ts', 'infra/docker/fixer/forward.ts', 'infra/docker/fixer/relay.ts', 'infra/docker/fixer/wrapper.ts', 'packages/pipeline/src'].sort());
    const ignore = readFileSync(join(FIXER_DIR, 'Dockerfile.dockerignore'), 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(ignore[0]).toBe('*');
    expect(ignore.slice(1).every((l) => l.startsWith('!packages/pipeline/src/') || l.startsWith('!infra/docker/fixer/'))).toBe(true);
  });

  it('imports nothing the image does not copy', () => {
    const copied = ['entrypoint.ts', 'wrapper.ts', 'forward.ts', 'relay.ts'].map((f) => join(FIXER_DIR, f));
    for (const file of copied) {
      const specs = [...readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1] ?? '');
      for (const s of specs) {
        if (s.startsWith('node:')) continue;
        const target = resolve(FIXER_DIR, s);
        expect(target.startsWith(join(ROOT, 'packages/pipeline/src/')) || copied.includes(target), `${file}: ${s}`).toBe(true);
      }
    }
  });

  it('is built by pnpm fixer-image:build with the documented tag', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['fixer-image:build']).toBe('docker build -f infra/docker/fixer/Dockerfile -t snapwing-fixer:local .');
    expect(readFileSync(join(ROOT, 'docs/harness-generic.md'), 'utf8')).toContain('SNAPWING_FIXER_IMAGE=snapwing-fixer:local');
  });
});
