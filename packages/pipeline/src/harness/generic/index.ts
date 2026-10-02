// src/harness/generic/index.ts: the generic command-template harness adapter (main 14.5,
// docs/harness-generic.md). Runs any coding agent as a child process: the implementation request goes
// to stdin, checkpoints come back as JSON lines on stderr, the result is one JSON object on stdout.
// The command is split into an argument vector and executed without a shell, so request content can
// never reach a command line. Everything the process prints is untrusted and goes through the
// validators in ../contract.ts.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { HarnessCheckpoint, HarnessPhase, HarnessPort, HarnessResult, HarnessRunOptions, WorkItemRef } from '../../ports/harness.ts';
import { InvalidDurationError, parseDuration } from '../../util/duration.ts';
import { MAX_RESULT_LENGTH, parseCheckpointLine, parseHarnessResult } from '../contract.ts';

export interface GenericHarnessConfig {
  /** Command template, split on whitespace with double quotes respected; never run through a shell. */
  command: string;
  /** ISO 8601 wall-clock cap from the `generic` element (default `PT30M`); the run budget may lower it. */
  timeout?: string;
  /** Extra environment variables (for example secrets resolved from the secrets port). */
  env?: Readonly<Record<string, string>>;
  /** Grace between SIGTERM and SIGKILL in milliseconds. Default 10000 (`PT10S`); tests lower it. */
  killGraceMs?: number;
}

export const DEFAULT_TIMEOUT = 'PT30M';
export const DEFAULT_KILL_GRACE_MS = 10_000;
const STDERR_TAIL_CHARS = 2000;
const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

/** Splits a command template into an argument vector. Whitespace separates; double quotes group. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inToken = false;
  let quoted = false;
  for (const ch of command) {
    if (ch === '"') {
      quoted = !quoted;
      inToken = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (inToken) args.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quoted) throw new Error('unterminated double quote in harness command');
  if (inToken) args.push(cur);
  return args;
}

export function createGenericHarness(config: GenericHarnessConfig): HarnessPort {
  const argv = splitCommand(config.command);
  if (argv.length === 0) throw new Error('harness command is empty');
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    run: (workItem, implementationRequest, workdir, opts) =>
      runGeneric(argv, config, graceMs, workItem, implementationRequest, workdir, opts),
  };
}

function wallClockMs(config: GenericHarnessConfig, opts: HarnessRunOptions): { ms: number; label: string } {
  const candidates: { ms: number; label: string }[] = [];
  for (const label of [opts.budget.wallClock, config.timeout ?? DEFAULT_TIMEOUT]) {
    try {
      candidates.push({ ms: parseDuration(label), label });
    } catch (e) {
      if (!(e instanceof InvalidDurationError)) throw e;
    }
  }
  if (candidates.length === 0) return { ms: parseDuration(DEFAULT_TIMEOUT), label: DEFAULT_TIMEOUT };
  return candidates.reduce((a, b) => (b.ms < a.ms ? b : a));
}

function buildEnv(config: GenericHarnessConfig, workItem: WorkItemRef, workdir: string, opts: HarnessRunOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  Object.assign(env, config.env ?? {});
  env['SNAPWING_HARNESS_CONTRACT'] = '1';
  env['SNAPWING_ROLE'] = opts.role;
  env['SNAPWING_WORK_ITEM_ID'] = workItem.id;
  env['SNAPWING_ISSUE_KEY'] = workItem.issueKey;
  env['SNAPWING_REPO'] = workItem.repo;
  env['SNAPWING_WORKDIR'] = workdir;
  env['SNAPWING_BUDGET_WALL_CLOCK'] = opts.budget.wallClock;
  env['SNAPWING_BUDGET_ATTEMPTS'] = String(opts.budget.attempts);
  return env;
}

function runGeneric(
  argv: string[],
  config: GenericHarnessConfig,
  graceMs: number,
  workItem: WorkItemRef,
  implementationRequest: string,
  workdir: string,
  opts: HarnessRunOptions,
): Promise<HarnessResult> {
  const startedPhase: HarnessPhase = 'cloned';
  if (opts.signal.aborted) return Promise.resolve({ outcome: 'stopped', atPhase: startedPhase });

  const budget = wallClockMs(config, opts);
  const [file, ...args] = argv;

  return new Promise<HarnessResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file as string, args, {
        cwd: workdir,
        env: buildEnv(config, workItem, workdir, opts),
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ outcome: 'failed', reason: `harness failed to start: ${errMessage(e)}`, attempts: 1 });
      return;
    }

    let stdout = '';
    let stdoutOverflow = false;
    let stderrTail = '';
    let stderrBuf = '';
    let lastPhase: HarnessPhase | undefined;
    let stopRequested = false;
    let budgetExceeded = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let checkpointChain: Promise<void> = Promise.resolve();

    const signalGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    const terminate = (): void => {
      if (killTimer !== undefined) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
    };

    const onAbort = (): void => {
      stopRequested = true;
      terminate();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const budgetTimer = setTimeout(() => {
      budgetExceeded = true;
      terminate();
    }, budget.ms);

    const handleLine = (line: string): void => {
      const parsed = parseCheckpointLine(line);
      if (parsed.kind !== 'checkpoint') return;
      const checkpoint: HarnessCheckpoint = parsed.checkpoint;
      lastPhase = checkpoint.phase;
      checkpointChain = checkpointChain.then(() => opts.onCheckpoint(checkpoint)).catch(() => undefined);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > MAX_RESULT_LENGTH) {
        stdoutOverflow = true;
        stdout = (stdout + chunk).slice(0, MAX_RESULT_LENGTH + 1);
      } else if (!stdoutOverflow) {
        stdout += chunk;
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      stderrBuf += chunk;
      let nl = stderrBuf.indexOf('\n');
      while (nl !== -1) {
        handleLine(stderrBuf.slice(0, nl));
        stderrBuf = stderrBuf.slice(nl + 1);
        nl = stderrBuf.indexOf('\n');
      }
      // A line that never ends cannot be a checkpoint; keep memory bounded.
      if (stderrBuf.length > 128 * 1024) stderrBuf = '';
    });

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(implementationRequest, 'utf8');

    child.on('error', (e) => {
      spawnError = errMessage(e);
    });

    child.on('close', (code, signal) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      clearTimeout(budgetTimer);
      opts.signal.removeEventListener('abort', onAbort);
      if (stderrBuf !== '') handleLine(stderrBuf);

      const result = decide({ code, signal, stdout, stderrTail, lastPhase, stopRequested, budgetExceeded, spawnError, budgetLabel: budget.label });
      void checkpointChain.then(() => resolve(result));
    });
  });
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  lastPhase: HarnessPhase | undefined;
  stopRequested: boolean;
  budgetExceeded: boolean;
  spawnError: string | undefined;
  budgetLabel: string;
}

/** The exit-code table in docs/harness-generic.md section 5, plus budget handling from section 6. */
function decide(o: Outcome): HarnessResult {
  if (o.spawnError !== undefined) {
    return { outcome: 'failed', reason: `harness failed to start: ${o.spawnError}`, attempts: 1 };
  }
  if (o.budgetExceeded && !o.stopRequested) {
    return { outcome: 'failed', reason: `budget-exceeded: wall clock ${o.budgetLabel} exceeded`, attempts: 1 };
  }

  const parsed = parseHarnessResult(o.stdout);

  if (o.stopRequested) {
    if (parsed.ok && parsed.result.outcome === 'stopped') return parsed.result;
    return { outcome: 'stopped', atPhase: o.lastPhase ?? 'cloned' };
  }

  if (o.code === 0) {
    if (parsed.ok) return parsed.result;
    return { outcome: 'failed', reason: `harness contract: ${parsed.error.message}`, attempts: 1 };
  }

  if (parsed.ok && parsed.result.outcome === 'failed') return parsed.result;
  const how = o.code === null ? `harness terminated by signal ${o.signal ?? 'unknown'}` : `harness exited with code ${o.code}`;
  const tail = o.stderrTail.trim();
  return { outcome: 'failed', reason: tail === '' ? how : `${how}: ${tail}`, attempts: 1 };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
