// Unit tests for the `local` runtime providers (main 14.3): in-memory queue, kv-backed cache (on the
// SNAPWING_DB dialect), `.env` secrets, local-disk object store, and the child-process runner over
// the generic harness with the fake agent.

import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '../../src/config/app-config.ts';
import { ServerTreeError } from '../../src/harness/untrusted-host.ts';
import { StateNotFoundError, type Artifact } from '../../src/contracts/state.ts';
import type { HarnessCheckpoint, HarnessResult } from '../../src/ports/harness.ts';
import { InvalidObjectKeyError, ObjectNotFoundError } from '../../src/ports/object-store.ts';
import type { FixerJob } from '../../src/ports/runner.ts';
import { buildImplementationRequest } from '../../src/prompts/implementation-request.ts';
import { SecretNotFoundError } from '../../src/ports/secrets.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import { createLocalObjectStore } from '../../src/providers/local/object-store.ts';
import { InMemoryQueue, QueueClosedError } from '../../src/providers/local/queue.ts';
import { createLocalRunner, harnessResolver, UnknownRunError, type RunInfo } from '../../src/providers/local/runner.ts';
import { createEnvFileSecrets, DotenvParseError, parseDotenv } from '../../src/providers/local/secrets.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { StateStore } from '../../src/state/store.ts';
import { ulid } from '../../src/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { createBareRepo, type BareRepo } from '../helpers/git.ts';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-providers-local-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const dir = (name: string): string => join(scratch, name);

// Queue ---------------------------------------------------------------------------------------------

describe('local queue (in-memory)', () => {
  type Payloads = { 'notify.reporter': { incidentId: string; text: string }; 'reconcile.ping': { n: number } };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers in order, asynchronously, and buffers messages until a consumer registers', async () => {
    const q = new InMemoryQueue<Payloads>();
    const seen: number[] = [];
    const id1 = await q.enqueue('reconcile.ping', { n: 1 });
    await q.enqueue('reconcile.ping', { n: 2 });
    expect(id1).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    q.consume('reconcile.ping', async (p) => {
      seen.push(p.n);
    });
    expect(seen).toEqual([]);
    await q.enqueue('reconcile.ping', { n: 3 });
    await q.drain();
    expect(seen).toEqual([1, 2, 3]);
    q.close();
  });

  it('copies payloads on enqueue so producer mutations do not leak', async () => {
    const q = new InMemoryQueue<Payloads>();
    const got: string[] = [];
    q.consume('notify.reporter', async (p) => {
      got.push(p.text);
    });
    const payload = { incidentId: '01HZXTESTINCIDENT000000000', text: 'before' };
    await q.enqueue('notify.reporter', payload);
    payload.text = 'after';
    await q.drain();
    expect(got).toEqual(['before']);
    q.close();
  });

  it('runs one delivery at a time per queue name', async () => {
    const q = new InMemoryQueue<Payloads>();
    let inFlight = 0;
    let maxInFlight = 0;
    q.consume('reconcile.ping', async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    await Promise.all([1, 2, 3].map((n) => q.enqueue('reconcile.ping', { n })));
    await q.drain();
    expect(maxInFlight).toBe(1);
    q.close();
  });

  it('holds a delayed message until its delay elapses', async () => {
    vi.useFakeTimers();
    const q = new InMemoryQueue<Payloads>();
    const seen: number[] = [];
    q.consume('reconcile.ping', async (p) => {
      seen.push(p.n);
    });
    await q.enqueue('reconcile.ping', { n: 1 }, { delaySec: 30 });
    await q.enqueue('reconcile.ping', { n: 2 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1);
    await q.drain();
    expect(seen).toEqual([2, 1]);
    q.close();
  });

  it('redelivers a failed message after the retry delay, then dead-letters it after maxAttempts', async () => {
    vi.useFakeTimers();
    const q = new InMemoryQueue<Payloads>({ maxAttempts: 3, retryDelaySec: 2 });
    let calls = 0;
    q.consume('reconcile.ping', async () => {
      calls += 1;
      throw new Error('handler down');
    });
    await q.enqueue('reconcile.ping', { n: 7 });
    await q.drain();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);
    expect(q.deadLetters).toHaveLength(1);
    expect(q.deadLetters[0]).toMatchObject({ name: 'reconcile.ping', payload: { n: 7 }, attempts: 3 });
    q.close();
  });

  it('succeeds on a retry without dead-lettering', async () => {
    const q = new InMemoryQueue<Payloads>({ retryDelaySec: 0 });
    let calls = 0;
    q.consume('reconcile.ping', async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    await q.enqueue('reconcile.ping', { n: 1 });
    await q.drain();
    expect(calls).toBe(2);
    expect(q.deadLetters).toEqual([]);
    q.close();
  });

  it('rejects a second consumer, bad options, and use after close', async () => {
    const q = new InMemoryQueue<Payloads>();
    q.consume('reconcile.ping', async () => undefined);
    expect(() => q.consume('reconcile.ping', async () => undefined)).toThrow(/already has a consumer/);
    await expect(q.enqueue('reconcile.ping', { n: 1 }, { delaySec: -1 })).rejects.toBeInstanceOf(RangeError);
    expect(() => new InMemoryQueue({ maxAttempts: 0 })).toThrow(RangeError);
    q.close();
    await expect(q.enqueue('reconcile.ping', { n: 1 })).rejects.toBeInstanceOf(QueueClosedError);
  });

  it('drops delayed messages on close', async () => {
    vi.useFakeTimers();
    const q = new InMemoryQueue<Payloads>();
    const seen: number[] = [];
    q.consume('reconcile.ping', async (p) => {
      seen.push(p.n);
    });
    await q.enqueue('reconcile.ping', { n: 1 }, { delaySec: 1 });
    q.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([]);
  });
});

// Cache ---------------------------------------------------------------------------------------------

describe('local cache (state kv)', () => {
  let tdb: TestDatabase;
  let state: OpenedState;
  let nowMs = Date.parse('2026-10-02T09:00:00.000Z');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    state = await tdb.open({ now: () => new Date(nowMs) });
  });

  afterAll(async () => {
    await tdb.drop();
  });

  const cache = () => {
    if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
    return createKvCache(state);
  };

  it('gets null for an absent key, then sets and overwrites', async () => {
    const c = cache();
    expect(await c.get('idem:absent')).toBeNull();
    await c.set('idem:a', '1');
    expect(await c.get('idem:a')).toBe('1');
    await c.set('idem:a', '2');
    expect(await c.get('idem:a')).toBe('2');
  });

  it('expires a value after its TTL', async () => {
    const c = cache();
    await c.set('rate:u1', '3', 60);
    nowMs += 59_000;
    expect(await c.get('rate:u1')).toBe('3');
    nowMs += 1000;
    expect(await c.get('rate:u1')).toBeNull();
  });

  it('setIfAbsent wins once, and again after expiry', async () => {
    const c = cache();
    const [a, b] = await Promise.all([c.setIfAbsent('lock:x', 'a', 30), c.setIfAbsent('lock:x', 'b', 30)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await c.setIfAbsent('lock:x', 'c', 30)).toBe(false);
    nowMs += 30_000;
    expect(await c.setIfAbsent('lock:x', 'd', 30)).toBe(true);
    expect(await c.get('lock:x')).toBe('d');
  });

  it('rejects a non-positive TTL', async () => {
    await expect(cache().setIfAbsent('lock:y', 'v', 0)).rejects.toBeInstanceOf(RangeError);
  });
});

// Secrets -------------------------------------------------------------------------------------------

describe('local secrets (.env file)', () => {
  it('parses the .env dialect', () => {
    const text = [
      '# comment',
      '',
      'SLACK_BOT_TOKEN=xoxb-test',
      'export JIRA_EMAIL = fake@example.com   # trailing comment',
      "SINGLE='literal \\n $NOT'",
      'DOUBLE="tab\\there \\"q\\""',
      'HASH_IN_VALUE=a#b',
      'EMPTY=',
      'GITHUB_APP_PRIVATE_KEY="-----BEGIN FAKE KEY-----',
      'not-a-real-key',
      '-----END FAKE KEY-----"',
      'AFTER=1',
      'SLACK_BOT_TOKEN=xoxb-test-later',
    ].join('\r\n');
    expect(Object.fromEntries(parseDotenv(text))).toEqual({
      SLACK_BOT_TOKEN: 'xoxb-test-later',
      JIRA_EMAIL: 'fake@example.com',
      SINGLE: 'literal \\n $NOT',
      DOUBLE: 'tab\there "q"',
      HASH_IN_VALUE: 'a#b',
      EMPTY: '',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN FAKE KEY-----\nnot-a-real-key\n-----END FAKE KEY-----',
      AFTER: '1',
    });
  });

  it('reports malformed lines by line number without echoing values', () => {
    const cases: [string, number][] = [
      ['A=1\nno equals here', 2],
      ['A=1\n\n1BAD=x', 3],
      ['A=1\nB="never closed\nC=2', 2],
      ["A='x' junk", 1],
    ];
    for (const [text, line] of cases) {
      let caught: unknown;
      try {
        parseDotenv(text, 'test.env');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DotenvParseError);
      expect((caught as DotenvParseError).line).toBe(line);
      expect((caught as Error).message).not.toMatch(/never closed|junk/);
    }
  });

  it('reads the file, falls back to the environment, and treats empty as unset', async () => {
    const path = join(scratch, 'secrets.env');
    await writeFile(path, 'SLACK_BOT_TOKEN=xoxb-test\nJIRA_API_TOKEN=\n');
    const secrets = createEnvFileSecrets({ path, fallbackEnv: { JIRA_API_TOKEN: 'fake-jira-token', SLACK_BOT_TOKEN: 'xoxb-env' } });
    expect(await secrets.get('SLACK_BOT_TOKEN')).toBe('xoxb-test');
    expect(await secrets.get('JIRA_API_TOKEN')).toBe('fake-jira-token');
    const err = await secrets.get('ANTHROPIC_API_KEY').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretNotFoundError);
    expect((err as SecretNotFoundError).secretName).toBe('ANTHROPIC_API_KEY');
  });

  it('reads the file once until reload', async () => {
    const path = join(scratch, 'reload.env');
    await writeFile(path, 'SLACK_APP_TOKEN=xapp-test-1\n');
    const secrets = createEnvFileSecrets({ path, fallbackEnv: {} });
    expect(await secrets.get('SLACK_APP_TOKEN')).toBe('xapp-test-1');
    await writeFile(path, 'SLACK_APP_TOKEN=xapp-test-2\n');
    expect(await secrets.get('SLACK_APP_TOKEN')).toBe('xapp-test-1');
    secrets.reload();
    expect(await secrets.get('SLACK_APP_TOKEN')).toBe('xapp-test-2');
  });

  it('treats a missing file as empty and surfaces a parse error', async () => {
    const missing = createEnvFileSecrets({ path: join(scratch, 'nope.env'), fallbackEnv: { OPENAI_API_KEY: 'sk-test' } });
    expect(await missing.get('OPENAI_API_KEY')).toBe('sk-test');
    const badPath = join(scratch, 'bad.env');
    await writeFile(badPath, 'garbage\n');
    await expect(createEnvFileSecrets({ path: badPath, fallbackEnv: {} }).get('X')).rejects.toBeInstanceOf(DotenvParseError);
  });
});

// Object store --------------------------------------------------------------------------------------

describe('local object store (disk)', () => {
  it('puts and gets bytes under the root and returns a file URL', async () => {
    const root = dir('objects-1');
    const store = createLocalObjectStore({ root });
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const url = await store.put('captures/01HZX/shot.png', body, 'image/png');
    expect(url.startsWith('file://')).toBe(true);
    expect(fileURLToPath(url)).toBe(join(root, 'objects', 'captures', '01HZX', 'shot.png'));
    expect(Buffer.compare(await store.get('captures/01HZX/shot.png'), body)).toBe(0);
    expect(await store.head('captures/01HZX/shot.png')).toEqual({ contentType: 'image/png', size: 6 });
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
  });

  it('overwrites an existing key', async () => {
    const store = createLocalObjectStore({ root: dir('objects-2') });
    await store.put('a.txt', Buffer.from('one'), 'text/plain');
    await store.put('a.txt', Buffer.from('two!'), 'text/markdown');
    expect((await store.get('a.txt')).toString()).toBe('two!');
    expect(await store.head('a.txt')).toEqual({ contentType: 'text/markdown', size: 4 });
  });

  it('rejects a missing key with ObjectNotFoundError', async () => {
    const store = createLocalObjectStore({ root: dir('objects-3') });
    await expect(store.get('missing.png')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await store.put('dir/file', Buffer.from('x'), 'text/plain');
    await expect(store.get('dir')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(store.head('missing.png')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('refuses keys that could escape the root', async () => {
    const store = createLocalObjectStore({ root: dir('objects-4') });
    for (const key of ['', '/etc/passwd', '../escape', 'a/../../b', 'a//b', './a', 'a\\b', 'a\u0000b', 'trailing/']) {
      await expect(store.put(key, Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidObjectKeyError);
      await expect(store.get(key)).rejects.toBeInstanceOf(InvalidObjectKeyError);
    }
    await expect(stat(dir('escape'))).rejects.toThrow();
  });
});

// Runner --------------------------------------------------------------------------------------------

describe('local runner (child process over the generic harness)', () => {
  const AGENT = fileURLToPath(new URL('../fixtures/harness/fake-agent.mjs', import.meta.url));
  const REQUEST_ID = '01HZXTESTREQUEST0000000000';
  const REQUEST_BODY = buildImplementationRequest({
    issue: 'WEB-1042',
    intent: 'fix the login button',
    evidence: [{ kind: 'report', source: 'slack', text: 'the login button does nothing' }],
    constraints: { scope: 'login only', tests: { required: true, text: 'add a test' }, forbidden: [] },
    handoff: { mode: 'review', autonomy: 2 },
  });
  let origin: BareRepo;
  beforeAll(async () => {
    origin = await createBareRepo();
  });
  afterAll(async () => {
    await origin.remove();
  });

  const artifacts: Record<string, Artifact> = {
    [REQUEST_ID]: {
      id: REQUEST_ID,
      version: 1,
      workspaceId: '01HZXTESTWORKSPACE00000000',
      incidentId: '01HZXTESTINCIDENT000000000',
      kind: 'implementation-request',
      contentType: 'application/xml',
      sha256: '0'.repeat(64),
      body: REQUEST_BODY,
      createdBy: 'triage',
      createdAt: '2026-10-02T09:00:00.000Z',
    },
    '01HZXTESTDIAGNOSIS00000000': {
      id: '01HZXTESTDIAGNOSIS00000000',
      version: 1,
      workspaceId: '01HZXTESTWORKSPACE00000000',
      incidentId: '01HZXTESTINCIDENT000000000',
      kind: 'diagnosis',
      contentType: 'application/json',
      sha256: '0'.repeat(64),
      body: '{}',
      createdBy: 'fixer',
      createdAt: '2026-10-02T09:00:00.000Z',
    },
  };
  const artifactStore = {
    async getArtifact(id: string): Promise<Artifact> {
      const a = artifacts[id];
      if (a === undefined) throw new StateNotFoundError('artifact', id);
      return a;
    },
  };

  const harnessConfig: HarnessConfig = {
    fixer: 'generic',
    review: 'generic',
    generic: [{ id: 'fake', command: `"${process.execPath}" "${AGENT}"`, timeout: 'PT1M' }],
  };

  const job = (over: Partial<FixerJob> = {}): FixerJob => ({
    runId: ulid(),
    workItem: { id: '01HZXTESTWORKITEM0000000000', issueKey: 'WEB-1042', repo: 'acme/web' },
    implementationRequestArtifactId: REQUEST_ID,
    harness: { adapter: 'generic', templateId: 'fake' },
    budget: { wallClock: 'PT1M', attempts: 2 },
    ...over,
  });

  let workdirRoot: string;
  beforeEach(async () => {
    workdirRoot = await mkdtemp(join(scratch, 'runs-'));
  });

  function runner(mode: string, hooks: { onCheckpoint?: (run: RunInfo, c: HarnessCheckpoint) => Promise<void> } = {}) {
    const checkpoints: { runId: string; checkpoint: HarnessCheckpoint }[] = [];
    const finished: { runId: string; result: HarnessResult }[] = [];
    const r = createLocalRunner({
      resolveHarness: harnessResolver(harnessConfig, { env: { FAKE_AGENT_MODE: mode }, killGraceMs: 200 }),
      artifacts: artifactStore,
      workdirRoot,
      git: { token: async () => 'test-git-token-not-real', remoteUrl: () => origin.url },
      onCheckpoint:
        hooks.onCheckpoint ??
        (async (run, checkpoint) => {
          checkpoints.push({ runId: run.runId, checkpoint });
        }),
      onFinished: async (run, result) => {
        finished.push({ runId: run.runId, result });
      },
    });
    return { r, checkpoints, finished };
  }

  it('runs the fixer under the job run id in its own checkout, reports checkpoints and the result, and removes the checkout', async () => {
    const { r, checkpoints, finished } = runner('success');
    const given = job();
    const { runId } = await r.runFixer(given);
    expect(runId).toBe(given.runId);
    expect(r.active()).toEqual([runId]);
    const result = await r.wait(runId);
    expect(result).toEqual({ outcome: 'done', branch: 'fix/WEB-1', summary: 'ok', testsAdded: ['t.test.ts'] });
    expect(checkpoints.map((c) => c.checkpoint.phase)).toEqual(['cloned', 'branched', 'implemented', 'tested']);
    expect(checkpoints.every((c) => c.runId === runId)).toBe(true);
    expect(finished).toEqual([{ runId, result }]);
    expect(r.active()).toEqual([]);
    await expect(stat(join(workdirRoot, runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes the artifact body on stdin and the job to the harness environment', async () => {
    const { r } = runner('echo');
    const { runId } = await r.runFixer(job());
    const result = await r.wait(runId);
    if (result.outcome !== 'done') throw new Error(`expected done, got ${JSON.stringify(result)}`);
    const seen = JSON.parse(result.summary) as { request: string; env: Record<string, string>; cwd: string };
    expect(seen.request).toBe(REQUEST_BODY);
    expect(seen.cwd).toBe(join(await realpath(workdirRoot), runId));
    expect(seen.env).toMatchObject({
      SNAPWING_ROLE: 'fixer',
      SNAPWING_ISSUE_KEY: 'WEB-1042',
      SNAPWING_REPO: 'acme/web',
      SNAPWING_BUDGET_WALL_CLOCK: 'PT1M',
      SNAPWING_BUDGET_ATTEMPTS: '2',
      SNAPWING_GIT_TOKEN: 'test-git-token-not-real',
    });
    expect(seen.env).not.toHaveProperty('SNAPWING_PRIOR_REVIEW_FILE');
  });

  it('runs the fixer with a scratch HOME, never the server user\'s (ADR 0017)', async () => {
    const { r } = runner('echo');
    const { runId } = await r.runFixer(job());
    const result = await r.wait(runId);
    if (result.outcome !== 'done') throw new Error(`expected done, got ${JSON.stringify(result)}`);
    const seen = JSON.parse(result.summary) as { home: string | null; homeEntries: string[] | null };
    expect(seen.home).not.toBeNull();
    expect(seen.home).not.toBe(homedir());
    expect(seen.homeEntries).toEqual([]);
  });

  it('refuses a workdir root in or above the server\'s own tree (ADR 0017)', () => {
    const make = (root: string) => () =>
      createLocalRunner({
        resolveHarness: harnessResolver(harnessConfig),
        artifacts: artifactStore,
        workdirRoot: root,
        git: { token: async () => 'test-git-token-not-real', remoteUrl: () => origin.url },
      });
    expect(make(join(process.cwd(), 'runs'))).toThrow(ServerTreeError);
    expect(make(fileURLToPath(new URL('../../../../.runs', import.meta.url)))).toThrow(ServerTreeError);
    expect(make('/')).toThrow(ServerTreeError);
    expect(make(workdirRoot)).not.toThrow();
  });

  it('reports a failed run', async () => {
    const { r, finished } = runner('failure');
    const { runId } = await r.runFixer(job());
    expect(await r.wait(runId)).toEqual({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' });
    expect(finished).toHaveLength(1);
  });

  it('cancel stops a running fixer and resolves once it has ended', async () => {
    // The fake agent installs its SIGTERM handler in the same tick it reports `implemented`.
    let implemented: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      implemented = resolve;
    });
    const { r, finished } = runner('stop-graceful', {
      onCheckpoint: async (_run, c) => {
        if (c.phase === 'implemented') implemented();
      },
    });
    const { runId } = await r.runFixer(job());
    await reached;
    await r.cancel(runId);
    expect(r.active()).toEqual([]);
    expect(finished).toEqual([{ runId, result: { outcome: 'stopped', atPhase: 'implemented' } }]);
    await r.cancel(runId);
  });

  it('refuses a second start of a run id it already knows', async () => {
    const { r } = runner('success');
    const given = job();
    await r.runFixer(given);
    await expect(r.runFixer(given)).rejects.toThrow(/already exists/);
    expect((await r.wait(given.runId)).outcome).toBe('done');
  });

  it('keeps running when a reporting hook throws', async () => {
    const { r } = runner('success', {
      onCheckpoint: async () => {
        throw new Error('fixer API down');
      },
    });
    const { runId } = await r.runFixer(job());
    expect((await r.wait(runId)).outcome).toBe('done');
  });

  it('starts nothing for a missing or wrong-kind artifact or an unknown harness', async () => {
    const { r } = runner('success');
    await expect(r.runFixer(job({ implementationRequestArtifactId: '01HZXTESTMISSING0000000000' }))).rejects.toBeInstanceOf(StateNotFoundError);
    await expect(r.runFixer(job({ implementationRequestArtifactId: '01HZXTESTDIAGNOSIS00000000' }))).rejects.toThrow(/not an implementation-request/);
    await expect(r.runFixer(job({ harness: { adapter: 'generic', templateId: 'nope' } }))).rejects.toThrow(/no <generic id="nope">/);
    await expect(r.runFixer(job({ runId: '../escape' }))).rejects.toThrow(/not a plain path segment/);
    await expect(r.runFixer(job({ runId: '' }))).rejects.toThrow(/not a plain path segment/);
    expect(r.active()).toEqual([]);
    expect(await readdir(workdirRoot)).toEqual([]);
  });

  it('builds codex and gemini harnesses from the config, one instance each', () => {
    const resolve = harnessResolver(harnessConfig);
    const codex = resolve({ adapter: 'codex' });
    const gemini = resolve({ adapter: 'gemini' });
    expect(codex).toBe(resolve({ adapter: 'codex' }));
    expect(gemini).toBe(resolve({ adapter: 'gemini' }));
    expect(codex).not.toBe(gemini);
  });

  it('treats cancel of an unknown run as a no-op and rejects wait for one', async () => {
    const { r } = runner('success');
    await r.cancel('01HZXTESTUNKNOWNRUN0000000');
    await expect(r.wait('01HZXTESTUNKNOWNRUN0000000')).rejects.toBeInstanceOf(UnknownRunError);
  });
});
