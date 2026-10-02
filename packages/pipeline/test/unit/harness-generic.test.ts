import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createGenericHarness, splitCommand } from '../../src/harness/generic/index.ts';
import type { HarnessCheckpoint, HarnessResult, HarnessRunOptions, WorkItemRef } from '../../src/ports/harness.ts';

const AGENT = fileURLToPath(new URL('../fixtures/harness/fake-agent.mjs', import.meta.url));
const WORK_ITEM: WorkItemRef = { id: '01HZXTESTWORKITEM0000000000', issueKey: 'WEB-1042', repo: 'acme/web' };
const REQUEST = '<implementation-request>fix it; $(touch /tmp/pwned) `id`</implementation-request>';
// Untrusted code may not run in the server's own tree (ADR 0017), so the runs use a scratch workdir.
const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'snapwing-generic-test-')));
afterAll(() => rmSync(WORKDIR, { recursive: true, force: true }));

function harness(mode: string, extra: { timeout?: string; killGraceMs?: number; env?: Record<string, string> } = {}) {
  const { env, ...rest } = extra;
  return createGenericHarness({ command: `"${process.execPath}" "${AGENT}"`, killGraceMs: 200, ...rest, env: { FAKE_AGENT_MODE: mode, ...env } });
}

function setup(over: Partial<HarnessRunOptions> = {}) {
  const checkpoints: HarnessCheckpoint[] = [];
  const controller = new AbortController();
  const opts: HarnessRunOptions = {
    role: 'fixer',
    budget: { wallClock: 'PT1M', attempts: 3 },
    onCheckpoint: async (c) => {
      checkpoints.push(c);
    },
    signal: controller.signal,
    ...over,
  };
  return { checkpoints, controller, opts };
}

const run = (h: ReturnType<typeof harness>, opts: HarnessRunOptions, workdir = WORKDIR): Promise<HarnessResult> =>
  h.run(WORK_ITEM, REQUEST, workdir, opts);

describe('splitCommand', () => {
  it('splits on whitespace and respects double quotes', () => {
    expect(splitCommand('aider --yes --message-file -')).toEqual(['aider', '--yes', '--message-file', '-']);
    expect(splitCommand('  node  "my agent.mjs"   "" x ')).toEqual(['node', 'my agent.mjs', '', 'x']);
  });

  it('rejects an unterminated quote', () => {
    expect(() => splitCommand('node "oops')).toThrow(/unterminated/);
  });

  it('rejects an empty command', () => {
    expect(() => createGenericHarness({ command: '   ' })).toThrow(/empty/);
  });
});

describe('generic harness: success', () => {
  it('streams checkpoints and returns the parsed result, dropping unknown keys', async () => {
    const { checkpoints, opts } = setup();
    const result = await run(harness('success'), opts);
    expect(result).toEqual({ outcome: 'done', branch: 'fix/WEB-1', summary: 'ok', testsAdded: ['t.test.ts'] });
    expect(checkpoints).toEqual([{ phase: 'branched', detail: 'fix/WEB-1' }, { phase: 'implemented' }, { phase: 'tested', detail: '1 passed' }]);
  });

  it('writes the request to stdin without shell interpolation and sets the contract environment', async () => {
    const { opts } = setup({ role: 'review' });
    process.env['FAKE_SERVER_SECRET'] = 'fake-not-a-secret';
    try {
      const result = await run(harness('echo'), opts);
      if (result.outcome !== 'done') throw new Error(`expected done, got ${JSON.stringify(result)}`);
      const seen = JSON.parse(result.summary) as { request: string; env: Record<string, string>; cwd: string; leaked: string | null };
      expect(realpathSync(seen.cwd)).toBe(WORKDIR);
      expect(seen.request).toBe(REQUEST);
      expect(seen.leaked).toBeNull();
      expect(seen.env).toEqual({
        SNAPWING_HARNESS_CONTRACT: '1',
        SNAPWING_ROLE: 'review',
        SNAPWING_WORK_ITEM_ID: WORK_ITEM.id,
        SNAPWING_ISSUE_KEY: 'WEB-1042',
        SNAPWING_REPO: 'acme/web',
        SNAPWING_WORKDIR: WORKDIR,
        SNAPWING_BUDGET_WALL_CLOCK: 'PT1M',
        SNAPWING_BUDGET_ATTEMPTS: '3',
      });
    } finally {
      delete process.env['FAKE_SERVER_SECRET'];
    }
  });
});

describe('generic harness: untrusted code on the host (ADR 0017)', () => {
  it('runs with a fresh empty HOME and TMPDIR, never the server user\'s, even when the config or run env names them', async () => {
    const serverHome = homedir();
    const serverTmp = tmpdir();
    const h = harness('echo', { env: { HOME: serverHome, TMPDIR: serverTmp } });
    const homes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await run(h, setup({ env: { HOME: serverHome, TMPDIR: serverTmp } }).opts);
      if (result.outcome !== 'done') throw new Error(`expected done, got ${JSON.stringify(result)}`);
      const seen = JSON.parse(result.summary) as { home: string | null; tmp: string | null; homeEntries: string[] | null };
      expect(seen.home).not.toBeNull();
      expect(seen.home).not.toBe(homedir());
      expect(seen.tmp).not.toBe(serverTmp);
      expect(seen.homeEntries).toEqual([]);
      homes.push(seen.home ?? '');
    }
    // A fresh home per run, removed when the run ends.
    expect(homes[0]).not.toBe(homes[1]);
    for (const home of homes) expect(existsSync(home)).toBe(false);
  });

  it('refuses a workdir in or above the server\'s own tree without starting the process', async () => {
    for (const workdir of [process.cwd(), fileURLToPath(new URL('../../../../', import.meta.url)), '/']) {
      const result = await run(harness('success'), setup().opts, workdir);
      expect(result).toMatchObject({ outcome: 'failed', attempts: 0 });
      expect(result.outcome === 'failed' ? result.reason : '').toMatch(/^harness workdir: .*server's own tree/);
    }
  });
});

describe('generic harness: failure', () => {
  it('returns a valid failed result even with a non-zero exit', async () => {
    const { checkpoints, opts } = setup();
    const result = await run(harness('failure'), opts);
    expect(result).toEqual({ outcome: 'failed', reason: 'tests still failing', partialBranch: 'fix/WEB-1', attempts: 3 });
    expect(checkpoints).toEqual([{ phase: 'branched' }]);
  });

  it('treats a done result with a non-zero exit as a failure', async () => {
    const result = await run(harness('done-nonzero'), setup().opts);
    expect(result).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect((result as { reason: string }).reason).toMatch(/exited with code 5/);
  });

  it('fails cleanly when the command cannot start', async () => {
    const h = createGenericHarness({ command: '/definitely/not/a/real/binary --x' });
    const result = await run(h, setup().opts);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect((result as { reason: string }).reason).toMatch(/failed to start/);
  });
});

describe('generic harness: garbage output', () => {
  it('exit 0 with unparseable stdout is a contract failure', async () => {
    const result = await run(harness('garbage'), setup().opts);
    expect(result).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect((result as { reason: string }).reason).toMatch(/^harness contract: stdout is not JSON/);
  });

  it('non-zero exit with unparseable stdout carries the stderr tail', async () => {
    const result = await run(harness('garbage-exit'), setup().opts);
    expect(result).toMatchObject({ outcome: 'failed', attempts: 1 });
    const reason = (result as { reason: string }).reason;
    expect(reason).toMatch(/exited with code 2/);
    expect(reason).toContain('boom: could not reach model');
  });
});

describe('generic harness: stop', () => {
  it('SIGTERM lets the agent report its own stopped result', async () => {
    const { controller, opts } = setup({
      onCheckpoint: async (c) => {
        if (c.phase === 'implemented') controller.abort();
      },
    });
    const result = await run(harness('stop-graceful'), opts);
    expect(result).toEqual({ outcome: 'stopped', atPhase: 'implemented' });
  });

  it('falls back to the last checkpoint when the agent dies without a result', async () => {
    const { controller, opts } = setup({
      onCheckpoint: async (c) => {
        if (c.phase === 'tested') controller.abort();
      },
    });
    const result = await run(harness('stop-silent'), opts);
    expect(result).toEqual({ outcome: 'stopped', atPhase: 'tested' });
  });

  it('escalates to SIGKILL after the grace period', async () => {
    const captured = setup({
      onCheckpoint: async (c) => {
        captured.checkpoints.push(c);
        if (c.phase === 'branched') captured.controller.abort();
      },
    });
    const { opts } = captured;
    // The agent ignores SIGTERM but reports it as a `tested` checkpoint, and it never exits on its own.
    // Seeing `tested` proves SIGTERM went first; getting a result at all proves SIGKILL followed.
    const { checkpoints } = captured;
    const result = await run(harness('stop-stubborn', { killGraceMs: 300 }), opts);
    expect(result).toEqual({ outcome: 'stopped', atPhase: 'tested' });
    expect(checkpoints.map((c) => c.phase)).toEqual(['branched', 'tested']);
  });

  it('an already-aborted signal stops without running the command', async () => {
    const { controller, opts } = setup();
    controller.abort();
    expect(await run(harness('hang'), opts)).toEqual({ outcome: 'stopped', atPhase: 'cloned' });
  });
});

describe('generic harness: wall-clock budget', () => {
  it('opts.budget.wallClock yields failed budget-exceeded', async () => {
    const { checkpoints, opts } = setup({ budget: { wallClock: 'PT1S', attempts: 1 } });
    const started = Date.now();
    const result = await run(harness('hang'), opts);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect((result as { reason: string }).reason).toMatch(/^budget-exceeded: wall clock PT1S exceeded/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(checkpoints).toEqual([{ phase: 'branched' }]);
  });

  it('the configured timeout caps the run when it is shorter than the budget', async () => {
    const result = await run(harness('hang', { timeout: 'PT1S' }), setup().opts);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect((result as { reason: string }).reason).toMatch(/budget-exceeded: wall clock PT1S/);
  });

  it('SIGKILLs a stubborn agent that overruns its budget', async () => {
    const result = await run(harness('stop-stubborn', { killGraceMs: 200 }), setup({ budget: { wallClock: 'PT1S', attempts: 1 } }).opts);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect((result as { reason: string }).reason).toMatch(/budget-exceeded/);
  });
});
