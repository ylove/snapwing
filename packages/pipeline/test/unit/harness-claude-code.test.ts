import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createClaudeCodeHarness, extractResult } from '../../src/harness/claude-code/index.ts';
import type { HarnessCheckpoint, HarnessResult, HarnessRunOptions } from '../../src/ports/harness.ts';

const FAKE = fileURLToPath(new URL('../fixtures/harness/fake-claude.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const scratch = mkdtempSync(join(tmpdir(), 'snapwing-cc-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const workItem = { id: '01J0000000000000000000FAKE', issueKey: 'WEB-1', repo: 'acme/web' };
const harness = createClaudeCodeHarness({ bin: FAKE, killGraceMs: 300 });

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

describe('claude-code harness: invocation', () => {
  it('runs claude -p --output-format json in workdir with the request on stdin and a minimal env', async () => {
    const record = join(scratch, 'record.json');
    process.env['SERVER_ONLY_VAR'] = 'leak-check';
    const h = createClaudeCodeHarness({ bin: FAKE, model: 'sonnet', allowedTools: ['Bash', 'Edit'] });
    const runEnv = { SNAPWING_GIT_TOKEN: 'test-git-token-not-real', SNAPWING_ROLE: 'overridden' };
    const result = await h.run(workItem, `FAKE_MODE=done FAKE_RECORD=${record}`, scratch, opts({ env: runEnv }));
    delete process.env['SERVER_ONLY_VAR'];
    expect(result).toEqual(DONE);

    const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; cwd: string; env: Record<string, string> };
    expect(seen.argv.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(seen.argv[seen.argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(seen.argv[seen.argv.indexOf('--allowedTools') + 1]).toBe('Bash,Edit');
    expect(seen.argv[seen.argv.indexOf('--append-system-prompt') + 1]).toContain('<fixer-system-prompt');
    expect(seen.stdin).toContain('FAKE_MODE=done');
    expect(realpathSync(seen.cwd)).toBe(realpathSync(scratch));
    expect(seen.env).toMatchObject({
      SNAPWING_HARNESS_CONTRACT: '1',
      SNAPWING_ROLE: 'fixer',
      SNAPWING_WORK_ITEM_ID: workItem.id,
      SNAPWING_ISSUE_KEY: 'WEB-1',
      SNAPWING_REPO: 'acme/web',
      SNAPWING_WORKDIR: scratch,
      SNAPWING_BUDGET_WALL_CLOCK: 'PT30S',
      SNAPWING_BUDGET_ATTEMPTS: '3',
      SNAPWING_GIT_TOKEN: 'test-git-token-not-real',
    });
    expect(seen.env).not.toHaveProperty('SERVER_ONLY_VAR');
  });

  it('declines the review role without spawning anything', async () => {
    const r = await run('done', opts({ role: 'review' }), createClaudeCodeHarness({ bin: '/nonexistent/claude' }));
    expect(r).toMatchObject({ outcome: 'failed', attempts: 0 });
  });

  it('reports a missing binary as failed', async () => {
    const r = await run('done', opts(), createClaudeCodeHarness({ bin: '/nonexistent/claude' }));
    expect(r).toMatchObject({ outcome: 'failed', attempts: 0 });
    expect((r as { reason: string }).reason).toMatch(/could not start/);
  });
});

describe('claude-code harness: result extraction', () => {
  it('takes the JSON object at the end of the result message', async () => {
    expect(await run('done')).toEqual(DONE);
  });
  it('accepts a bare JSON result', async () => {
    expect(await run('bare')).toEqual(DONE);
  });
  it('accepts a fenced JSON block', async () => {
    expect(await run('fenced')).toEqual(DONE);
  });
  it('passes through a failed result', async () => {
    expect(await run('failed')).toEqual({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' });
  });
  it('turns a result message without JSON into a contract failure', async () => {
    const r = await run('no-json');
    expect(r).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect((r as { reason: string }).reason).toMatch(/^harness contract:/);
  });
  it('turns non-claude stdout into a contract failure', async () => {
    const r = await run('not-claude-output');
    expect((r as { reason: string }).reason).toMatch(/^harness contract:/);
  });

  it('extractResult handles event arrays and rejects missing result fields', () => {
    const events = JSON.stringify([{ type: 'system' }, { type: 'result', result: `ok\n${JSON.stringify(DONE)}` }]);
    expect(extractResult(events)).toEqual({ kind: 'result', result: DONE });
    expect(extractResult('{"type":"result"}').kind).toBe('error');
    expect(extractResult('').kind).toBe('error');
  });
});

describe('claude-code harness: exit codes', () => {
  it('keeps a valid failed result on a non-zero exit', async () => {
    expect(await run('failed-exit1')).toEqual({ outcome: 'failed', reason: 'gave up', attempts: 2 });
  });
  it('does not trust done on a non-zero exit', async () => {
    expect(await run('done-exit1')).toEqual({ outcome: 'failed', reason: 'harness exited with code 1', attempts: 1 });
  });
  it('reports a bare non-zero exit', async () => {
    expect(await run('exit3')).toEqual({ outcome: 'failed', reason: 'harness exited with code 3', attempts: 1 });
  });
});

describe('claude-code harness: checkpoints', () => {
  it('delivers checkpoints from the checkpoint file and stderr, in order, ignoring noise', async () => {
    const seen: HarnessCheckpoint[] = [];
    const r = await run('checkpoints', opts({}, seen));
    expect(r).toEqual(DONE);
    expect(seen.map((c) => c.phase).sort()).toEqual(['branched', 'implemented', 'pushed', 'tested']);
    expect(seen.find((c) => c.phase === 'branched')).toEqual({ phase: 'branched', detail: 'fix/WEB-1' });
    expect(seen.find((c) => c.phase === 'tested')).toEqual({ phase: 'tested', detail: '3 passed' });
    expect(seen.findIndex((c) => c.phase === 'tested')).toBeLessThan(seen.findIndex((c) => c.phase === 'pushed'));
  });

  it('survives an onCheckpoint that throws', async () => {
    const r = await run('checkpoints', opts({ onCheckpoint: () => Promise.reject(new Error('api down')) }));
    expect(r).toEqual(DONE);
  });
});

describe('claude-code harness: Stop', () => {
  /** Options whose signal aborts as soon as a checkpoint at `phase` arrives; `seen` records them all. */
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
    // The agent ignores SIGTERM and reports each one as a `tested` checkpoint, and it never exits on its
    // own. Seeing `tested` proves SIGTERM went first; getting a result at all proves SIGKILL followed.
    const seen: HarnessCheckpoint[] = [];
    expect(await run('hang-stubborn', abortAt('branched', seen))).toEqual({ outcome: 'stopped', atPhase: 'tested' });
    expect(seen.map((c) => c.phase)).toEqual(['branched', 'tested']);
  });

  it('stops at cloned when aborted before any checkpoint', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await run('hang', opts({ signal: ac.signal }))).toEqual({ outcome: 'stopped', atPhase: 'cloned' });
  });
});

describe('claude-code harness: budget', () => {
  it('fails with a wall clock reason, not stopped, when the budget ends', async () => {
    const r = await run('hang', opts({ budget: { wallClock: 'PT0.5S', attempts: 3 } }));
    expect(r).toEqual({ outcome: 'failed', reason: 'budget-exceeded: wall clock PT0.5S exceeded', attempts: 1 });
  });
});
