import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createCodexHarness, extractResult } from '../../src/harness/codex/index.ts';
import type { HarnessCheckpoint, HarnessResult, HarnessRunOptions } from '../../src/ports/harness.ts';

const FAKE = fileURLToPath(new URL('../fixtures/harness/fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const scratch = mkdtempSync(join(tmpdir(), 'snapwing-codex-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const workItem = { id: '01J0000000000000000000FAKE', issueKey: 'WEB-1', repo: 'acme/web' };
const harness = createCodexHarness({ bin: FAKE, killGraceMs: 300 });

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

describe('codex harness: invocation', () => {
  it('runs codex exec - in workdir with fixer prompt plus request on stdin and a minimal env', async () => {
    const record = join(scratch, 'record.json');
    process.env['SERVER_ONLY_VAR'] = 'leak-check';
    const h = createCodexHarness({ bin: FAKE, model: 'gpt-5-codex' });
    const runEnv = { SNAPWING_GIT_TOKEN: 'test-git-token-not-real', OPENAI_API_KEY: 'sk-test-not-real' };
    const result = await h.run(workItem, `FAKE_MODE=done FAKE_RECORD=${record}`, scratch, opts({ env: runEnv }));
    delete process.env['SERVER_ONLY_VAR'];
    expect(result).toEqual(DONE);

    const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; cwd: string; env: Record<string, string> };
    expect(seen.argv[0]).toBe('exec');
    expect(seen.argv.at(-1)).toBe('-');
    expect(seen.argv[seen.argv.indexOf('--model') + 1]).toBe('gpt-5-codex');
    expect(seen.argv).toContain('--output-last-message');
    expect(seen.stdin).toContain('<fixer-system-prompt');
    expect(seen.stdin).toContain('FAKE_MODE=done');
    expect(seen.argv.join(' ')).not.toContain('FAKE_MODE');
    expect(realpathSync(seen.cwd)).toBe(realpathSync(scratch));
    expect(seen.env).toMatchObject({
      SNAPWING_HARNESS_CONTRACT: '1',
      SNAPWING_ROLE: 'fixer',
      SNAPWING_WORK_ITEM_ID: workItem.id,
      SNAPWING_WORKDIR: scratch,
      SNAPWING_GIT_TOKEN: 'test-git-token-not-real',
      OPENAI_API_KEY: 'sk-test-not-real',
    });
    expect(seen.env).not.toHaveProperty('SERVER_ONLY_VAR');
  });

  it('reports a missing binary as failed', async () => {
    const missing = createCodexHarness({ bin: '/nonexistent/codex' });
    const r = await run('done', opts(), missing);
    expect(r).toMatchObject({ outcome: 'failed', attempts: 0 });
    expect((r as { reason: string }).reason).toMatch(/could not start/);
  });
});

describe('codex harness: review role', () => {
  const reviewOpts = (over: Partial<HarnessRunOptions> = {}): HarnessRunOptions => opts({ role: 'review', ...over });

  it('uses review.xml and read-and-run restrictions, with the verdict file env', async () => {
    const record = join(scratch, 'record-review.json');
    const r = await harness.run(workItem, `FAKE_MODE=no-json FAKE_RECORD=${record}`, scratch, reviewOpts({ env: { SNAPWING_REVIEW_FILE: '/tmp/verdict.json' } }));
    expect(r.outcome).toBe('done');
    const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string> };
    expect(seen.stdin).toContain('<review-system-prompt');
    expect(seen.argv[seen.argv.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(seen.env).toMatchObject({ SNAPWING_ROLE: 'review', SNAPWING_REVIEW_FILE: '/tmp/verdict.json' });
  });
  it('is done on exit 0 even with no JSON result', async () => {
    expect((await run('no-json', reviewOpts())).outcome).toBe('done');
  });
  it('is failed on a non-zero exit', async () => {
    expect(await run('exit3', reviewOpts())).toEqual({ outcome: 'failed', reason: 'harness exited with code 3', attempts: 1 });
  });
  it('is stopped when the signal aborts', async () => {
    const ac = new AbortController();
    const r = await run('hang', reviewOpts({ signal: ac.signal, onCheckpoint: async (c) => { if (c.phase === 'branched') ac.abort(); } }));
    expect(r).toEqual({ outcome: 'stopped', atPhase: 'branched' });
  });
});

describe('codex harness: results and exit codes', () => {
  it('takes the result from the last-message file, ignoring stdout chatter', async () => {
    expect(await run('done')).toEqual(DONE);
  });
  it('falls back to stdout when no last-message file exists', async () => {
    expect(await run('no-output-file')).toEqual(DONE);
  });
  it('passes through a failed result', async () => {
    expect(await run('failed')).toEqual({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' });
  });
  it('turns a message without JSON into a contract failure', async () => {
    const r = await run('no-json');
    expect(r).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect((r as { reason: string }).reason).toMatch(/^harness contract:/);
  });
  it('does not trust done on a non-zero exit', async () => {
    expect(await run('done-exit1')).toEqual({ outcome: 'failed', reason: 'harness exited with code 1', attempts: 1 });
  });
  it('reports a bare non-zero exit', async () => {
    expect(await run('exit3')).toEqual({ outcome: 'failed', reason: 'harness exited with code 3', attempts: 1 });
  });
  it('extractResult rejects an empty message', () => {
    expect(extractResult('', '  ').kind).toBe('error');
  });
});

describe('codex harness: checkpoints', () => {
  it('delivers checkpoints from the file and stderr, ignoring noise', async () => {
    const seen: HarnessCheckpoint[] = [];
    expect(await run('checkpoints', opts({}, seen))).toEqual(DONE);
    expect(seen.map((c) => c.phase).sort()).toEqual(['branched', 'implemented', 'pushed', 'tested']);
    expect(seen.find((c) => c.phase === 'tested')).toEqual({ phase: 'tested', detail: '3 passed' });
  });
});

describe('codex harness: Stop', () => {
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

describe('codex harness: budget', () => {
  it('fails with a wall clock reason, not stopped, when the budget ends', async () => {
    const r = await run('hang', opts({ budget: { wallClock: 'PT0.5S', attempts: 3 } }));
    expect(r).toEqual({ outcome: 'failed', reason: 'budget-exceeded: wall clock PT0.5S exceeded', attempts: 1 });
  });
});
