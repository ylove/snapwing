import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createGeminiHarness, extractResult } from '../../src/harness/gemini/index.ts';
import type { HarnessCheckpoint, HarnessResult, HarnessRunOptions } from '../../src/ports/harness.ts';

const FAKE = fileURLToPath(new URL('../fixtures/harness/fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const scratch = mkdtempSync(join(tmpdir(), 'snapwing-gemini-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const workItem = { id: '01J0000000000000000000FAKE', issueKey: 'WEB-1', repo: 'acme/web' };
const harness = createGeminiHarness({ bin: FAKE, killGraceMs: 300 });

function opts(over: Partial<HarnessRunOptions> = {}, seen: HarnessCheckpoint[] = []): HarnessRunOptions {
  return {
    role: 'fixer',
    budget: { wallClock: 'PT30S', attempts: 3 },
    onCheckpoint: async (c) => {
      seen.push(c);
    },
    signal: new AbortController().signal,
    ...over,
  };
}
const run = (mode: string, o: HarnessRunOptions = opts(), h = harness): Promise<HarnessResult> =>
  h.run(workItem, `<implementation-request>FAKE_MODE=${mode}</implementation-request>`, scratch, o);

const DONE: HarnessResult = { outcome: 'done', branch: 'fix/WEB-1', prNumber: 7, summary: 'Guard null cart', testsAdded: ['test/cart.test.ts'] };

describe('gemini harness: invocation', () => {
  it('runs gemini non-interactively in workdir with the request on stdin and a minimal env', async () => {
    const record = join(scratch, 'record.json');
    process.env['SERVER_ONLY_VAR'] = 'leak-check';
    const h = createGeminiHarness({ bin: FAKE, model: 'gemini-2.5-pro' });
    const runEnv = { SNAPWING_GIT_TOKEN: 'test-git-token-not-real', GEMINI_API_KEY: 'test-key-not-real' };
    const result = await h.run(workItem, `FAKE_MODE=done FAKE_RECORD=${record}`, scratch, opts({ env: runEnv }));
    delete process.env['SERVER_ONLY_VAR'];
    expect(result).toEqual(DONE);

    const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; cwd: string; env: Record<string, string> };
    expect(seen.argv[seen.argv.indexOf('--prompt') + 1]).toContain('<fixer-system-prompt');
    expect(seen.argv[seen.argv.indexOf('--output-format') + 1]).toBe('json');
    expect(seen.argv).toContain('--yolo');
    expect(seen.argv[seen.argv.indexOf('--model') + 1]).toBe('gemini-2.5-pro');
    expect(seen.stdin).toBe(`FAKE_MODE=done FAKE_RECORD=${record}`);
    expect(realpathSync(seen.cwd)).toBe(realpathSync(scratch));
    expect(seen.env).toMatchObject({
      SNAPWING_HARNESS_CONTRACT: '1',
      SNAPWING_ROLE: 'fixer',
      SNAPWING_WORKDIR: scratch,
      SNAPWING_GIT_TOKEN: 'test-git-token-not-real',
      GEMINI_API_KEY: 'test-key-not-real',
    });
    expect(seen.env).not.toHaveProperty('SERVER_ONLY_VAR');
  });

  it('declines the review role and reports a missing binary as failed', async () => {
    const missing = createGeminiHarness({ bin: '/nonexistent/gemini' });
    expect(await run('done', opts({ role: 'review' }), missing)).toMatchObject({ outcome: 'failed', attempts: 0 });
    const r = await run('done', opts(), missing);
    expect((r as { reason: string }).reason).toMatch(/could not start/);
  });
});

describe('gemini harness: results and exit codes', () => {
  it('takes the result from the response field', async () => {
    expect(await run('done')).toEqual(DONE);
  });
  it('passes through a failed result', async () => {
    expect(await run('failed')).toEqual({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' });
  });
  it('turns a response without JSON into a contract failure', async () => {
    const r = await run('no-json');
    expect((r as { reason: string }).reason).toMatch(/^harness contract:/);
  });
  it('turns non-gemini stdout into a contract failure', async () => {
    const r = await run('not-gemini-output');
    expect((r as { reason: string }).reason).toMatch(/^harness contract:.*not gemini JSON/);
  });
  it('does not trust done on a non-zero exit', async () => {
    expect(await run('done-exit1')).toEqual({ outcome: 'failed', reason: 'harness exited with code 1', attempts: 1 });
  });
  it('reports a bare non-zero exit', async () => {
    expect(await run('exit3')).toEqual({ outcome: 'failed', reason: 'harness exited with code 3', attempts: 1 });
  });
  it('extractResult rejects empty output and a missing response field', () => {
    expect(extractResult('').kind).toBe('error');
    expect(extractResult('{"stats":{}}').kind).toBe('error');
  });
});

describe('gemini harness: checkpoints', () => {
  it('delivers checkpoints from the file and stderr, ignoring noise', async () => {
    const seen: HarnessCheckpoint[] = [];
    expect(await run('checkpoints', opts({}, seen))).toEqual(DONE);
    expect(seen.map((c) => c.phase).sort()).toEqual(['branched', 'implemented', 'pushed', 'tested']);
    expect(seen.find((c) => c.phase === 'branched')).toEqual({ phase: 'branched', detail: 'fix/WEB-1' });
  });
});

describe('gemini harness: Stop', () => {
  function abortAt(phase: HarnessCheckpoint['phase'], seen: HarnessCheckpoint[] = []): HarnessRunOptions {
    const ac = new AbortController();
    return opts(
      {
        signal: ac.signal,
        onCheckpoint: async (c) => {
          seen.push(c);
          if (c.phase === phase) ac.abort();
        },
      },
      seen,
    );
  }

  it('uses the stopped result the agent prints after SIGTERM', async () => {
    expect(await run('hang-stopped', abortAt('implemented'))).toEqual({ outcome: 'stopped', atPhase: 'tested' });
  });
  it('names the last checkpoint when the agent prints nothing', async () => {
    expect(await run('hang', abortAt('branched'))).toEqual({ outcome: 'stopped', atPhase: 'branched' });
  });
  it('escalates to SIGKILL after the grace period', async () => {
    const seen: HarnessCheckpoint[] = [];
    expect(await run('hang-stubborn', abortAt('branched', seen))).toEqual({ outcome: 'stopped', atPhase: 'tested' });
    expect(seen.map((c) => c.phase)).toEqual(['branched', 'tested']);
  });
});

describe('gemini harness: budget', () => {
  it('fails with a wall clock reason, not stopped, when the budget ends', async () => {
    const r = await run('hang', opts({ budget: { wallClock: 'PT0.5S', attempts: 3 } }));
    expect(r).toEqual({ outcome: 'failed', reason: 'budget-exceeded: wall clock PT0.5S exceeded', attempts: 1 });
  });
});
