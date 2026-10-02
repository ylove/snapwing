import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenericHarness } from '../../../src/harness/generic/index.ts';
import { createClaudeCodeHarness } from '../../../src/harness/claude-code/index.ts';
import type { HarnessCheckpoint, HarnessPort, HarnessResult, HarnessRunOptions } from '../../../src/ports/harness.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const adapters: { name: string; create: () => HarnessPort }[] = [
  { name: 'generic', create: () => createGenericHarness({ command: `"${process.execPath}" "${fixture('generic')}"`, killGraceMs: 50 }) },
  { name: 'claude-code', create: () => createClaudeCodeHarness({ bin: fixture('claude'), killGraceMs: 50 }) },
];
const workItem = { id: '01J00000000000000000000000', issueKey: 'FAKE-34', repo: 'fake-owner/fake-repo' };
const request = '<implementation-request>fake task</implementation-request>';
const done: HarnessResult = { outcome: 'done', branch: 'fix/FAKE-34', prNumber: 34, summary: 'Fake change', testsAdded: ['test/fake.test.ts'] };

// Expectations come from docs/harness-generic.md sections 3 through 7 and B section 9.
describe.each(adapters)('$name HarnessPort contract', ({ name, create }) => {
  let workdir: string;
  let controller: AbortController;
  let harness: HarnessPort;
  beforeEach(async () => {
    workdir = await realpath(await mkdtemp(join(tmpdir(), 'snapwing-harness-contract-')));
    controller = new AbortController();
    harness = create();
  });
  afterEach(async () => {
    controller.abort();
    vi.unstubAllEnvs();
    await rm(workdir, { recursive: true, force: true });
  });
  async function run(
    scenario: { mode?: string; result?: HarnessResult; exitCode?: number },
    overrides: Partial<HarnessRunOptions> = {},
  ): Promise<HarnessResult> {
    await writeFile(join(workdir, 'scenario.json'), JSON.stringify(scenario));
    return harness.run(workItem, request, workdir, {
      role: 'fixer', budget: { wallClock: 'PT10S', attempts: 3 },
      signal: controller.signal, onCheckpoint: async () => {}, ...overrides,
    });
  }
  it('forwards valid checkpoints in order and awaits asynchronous callbacks', async () => {
    const checkpoints: HarnessCheckpoint[] = [];
    const result = await run({ mode: 'checkpoints', result: done }, {
      onCheckpoint: async (checkpoint) => {
        await delay(checkpoint.phase === 'cloned' ? 30 : 1);
        checkpoints.push(checkpoint);
      },
    });
    expect(result).toEqual(done);
    expect(checkpoints).toEqual(['cloned', 'branched', 'implemented', 'tested', 'pushed', 'pr-opened']
      .map((phase) => ({ phase, detail: `reached ${phase}` })));
  });
  it('returns done with all result fields', async () => {
    expect(await run({ result: done })).toEqual(done);
  });
  it.each([0, 2])('preserves a failed result with exit code %i', async (exitCode) => {
    const failed: HarnessResult = { outcome: 'failed', reason: 'fake tests failed', partialBranch: 'fix/FAKE-34', attempts: 3 };
    expect(await run({ result: failed, exitCode })).toEqual(failed);
  });
  it('preserves a stopped result', async () => {
    const stopped: HarnessResult = { outcome: 'stopped', atPhase: 'tested' };
    expect(await run({ result: stopped })).toEqual(stopped);
  });
  it('delivers Stop after a checkpoint and returns stopped', async () => {
    expect(await run({ mode: 'stop' }, { onCheckpoint: async () => { controller.abort(); } }))
      .toEqual({ outcome: 'stopped', atPhase: 'implemented' });
  });
  it('kills an uncooperative agent after Stop at its last checkpoint', async () => {
    expect(await run({ mode: 'hang' }, { onCheckpoint: async () => { controller.abort(); } }))
      .toEqual({ outcome: 'stopped', atPhase: 'implemented' });
  });
  // Bug (#68): claude-code uses `budget:` instead of the section 6 `budget-exceeded:` reason.
  const budgetTest = name === 'claude-code' ? it.fails : it;
  budgetTest('records budget exceeded as failed, even when the agent ignores SIGTERM', async () => {
    expect(await run({ mode: 'hang' }, { budget: { wallClock: 'PT1S', attempts: 3 } }))
      .toEqual({ outcome: 'failed', reason: 'budget-exceeded: wall clock PT1S exceeded', attempts: 1 });
  });
  async function environment(): Promise<Record<string, string>> {
    for (const key of ['DATABASE_URL', 'SNAPWING_DB', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
      'PGPASSFILE', 'MYSQL_PWD', 'DB_PASSWORD', 'REDIS_URL', 'SNAPWING_FIXER_TOKEN', 'UNRELATED_SERVER_VALUE']) {
      vi.stubEnv(key, 'fake-token');
    }
    expect(await run({ result: done })).toEqual(done);
    const observed = JSON.parse(await readFile(join(workdir, 'observed.json'), 'utf8')) as {
      env: Record<string, string>; cwd: string; request: string;
    };
    expect(observed.cwd).toBe(workdir);
    const expected = {
      SNAPWING_HARNESS_CONTRACT: '1', SNAPWING_ROLE: 'fixer', SNAPWING_WORK_ITEM_ID: workItem.id,
      SNAPWING_ISSUE_KEY: workItem.issueKey, SNAPWING_REPO: workItem.repo, SNAPWING_WORKDIR: workdir,
      SNAPWING_BUDGET_WALL_CLOCK: 'PT10S', SNAPWING_BUDGET_ATTEMPTS: '3',
    };
    expect(observed.env).toMatchObject(expected);
    expect(Object.keys(observed.env).filter((key) => /^(PG|DATABASE_|SNAPWING_DB|MYSQL_|DB_|REDIS_)/u.test(key))).toEqual([]);
    expect(observed.env['SNAPWING_FIXER_TOKEN']).toBeUndefined();
    expect(observed.env['UNRELATED_SERVER_VALUE']).toBeUndefined();
    return observed.env;
  }
  it('excludes server and database credentials from the child environment', async () => {
    await environment();
  });
  // Bug (#68): claude-code adds SNAPWING_CHECKPOINT_FILE, absent from the section 7 allowlist.
  const environmentTest = name === 'claude-code' ? it.fails : it;
  environmentTest('exposes only the documented environment variables', async () => {
    const env = await environment();
    const expected = {
      SNAPWING_HARNESS_CONTRACT: '1', SNAPWING_ROLE: 'fixer', SNAPWING_WORK_ITEM_ID: workItem.id,
      SNAPWING_ISSUE_KEY: workItem.issueKey, SNAPWING_REPO: workItem.repo, SNAPWING_WORKDIR: workdir,
      SNAPWING_BUDGET_WALL_CLOCK: 'PT10S', SNAPWING_BUDGET_ATTEMPTS: '3',
    };
    expect(Object.keys(env).filter((key) => key.startsWith('SNAPWING_')).sort()).toEqual(Object.keys(expected).sort());
    const allowed = new Set([...Object.keys(expected), 'PATH', 'HOME', 'LANG', 'TMPDIR']);
    // macOS injects this variable into Node itself, independently of the supplied environment.
    if (process.platform === 'darwin') allowed.add('__CF_USER_TEXT_ENCODING');
    expect(Object.keys(env).filter((key) => !allowed.has(key))).toEqual([]);
  });
});
