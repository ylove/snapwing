import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { superviseProcess } from '../../src/harness/process.ts';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function start(script: string) {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    // Colour escapes (FORCE_COLOR in the caller's environment) would corrupt the pid parsed from stdout.
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const controller = new AbortController();
  const supervisor = superviseProcess(child, { budgetMs: 60_000, graceMs: 200, signal: controller.signal, onCheckpoint: async () => undefined });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return { child, controller, supervisor, closed, stdout: () => out };
}

/** Calls to `process.kill` with a negative pid, i.e. signals sent to a process group. */
const groupSignals = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
  spy.mock.calls.filter((c) => typeof c[0] === 'number' && c[0] < 0);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('superviseProcess process group handling', () => {
  it('sends no group signal after a child that exits cleanly with no grandchildren', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    const run = start('process.exit(0)');
    await run.closed;
    await run.supervisor.finish();
    expect(groupSignals(killSpy)).toEqual([]);
  });

  it('kills a grandchild left behind after a stop', async () => {
    const grandchild = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
      'console.log(g.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const run = start(parent);
    while (run.stdout().trim() === '') await sleep(20);
    const grandchildPid = Number(run.stdout().trim());
    expect(isAlive(grandchildPid)).toBe(true);
    try {
      run.controller.abort();
      await run.closed;
      await run.supervisor.finish();
      // The grandchild ignores SIGTERM; the exit hook must have SIGKILLed the group.
      for (let i = 0; i < 50 && isAlive(grandchildPid); i++) await sleep(20);
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      if (isAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    }
  });

  it('does not signal the group from finish() after exit', async () => {
    const run = start('process.exit(0)');
    await run.closed;
    const killSpy = vi.spyOn(process, 'kill');
    await run.supervisor.finish();
    run.supervisor.signalGroup('SIGKILL');
    expect(groupSignals(killSpy)).toEqual([]);
  });
});
