// src/harness/process.ts: the stop, budget, and checkpoint logic shared by the process-based harness
// adapters (generic and claude-code; main 14.5, docs/harness-generic.md sections 4 and 6).
//
// One implementation of: SIGTERM then SIGKILL to the whole process group after a grace period, the
// wall-clock budget timer, the abort-signal listener, stderr line splitting into checkpoints, and
// in-order delivery of checkpoints to `onCheckpoint`. Deciding what the run's outcome is stays with
// each adapter, because the stdout formats differ.
//
// Process group safety: once the group leader is reaped and the group is empty, its id may be reused
// by an unrelated process group (on the local runner that is a developer's machine), so nothing here
// signals `-pid` after the leader has exited, except one final SIGKILL sent from the `exit` event
// itself when a stop or budget kill was in progress. Node emits `exit` as the leader is reaped, so
// that call lands while any straggler still holds the group alive. A run that ends on its own
// (no stop, no budget kill) sends no group signal after exit; `finish()` never signals.

import type { ChildProcess } from 'node:child_process';
import type { HarnessCheckpoint, HarnessPhase, HarnessRunOptions } from '../ports/harness.ts';
import { HARNESS_PHASES, parseCheckpointLine } from './contract.ts';

/** Default SIGTERM to SIGKILL grace in milliseconds (`PT10S`, docs/harness-generic.md section 6). */
export const DEFAULT_KILL_GRACE_MS = 10_000;
/** A stderr line that never ends cannot be a checkpoint; the buffer is dropped past this size. */
const MAX_PARTIAL_LINE_CHARS = 128 * 1024;

/** The `failed` reason recorded when the wall-clock budget ends a run (docs/harness-generic.md section 6). */
export function budgetExceededReason(duration: string): string {
  return `budget-exceeded: wall clock ${duration} exceeded`;
}

export interface SupervisorOptions {
  /** Wall-clock budget in milliseconds; when it elapses the process is terminated. */
  budgetMs: number;
  /** Grace between SIGTERM and SIGKILL in milliseconds. */
  graceMs: number;
  signal: AbortSignal;
  onCheckpoint: HarnessRunOptions['onCheckpoint'];
}

export interface ProcessSupervisor {
  /** True once the abort signal fired. */
  readonly stopRequested: boolean;
  /** True once the wall-clock budget elapsed. */
  readonly budgetExceeded: boolean;
  /** The furthest phase any checkpoint reported; `cloned` before the first one. */
  readonly lastPhase: HarnessPhase;
  /** Delivers one checkpoint (in order, errors from `onCheckpoint` swallowed). */
  deliver(checkpoint: HarnessCheckpoint): void;
  /** Feeds a stderr chunk; every complete line that is a checkpoint is delivered. */
  feedStderr(chunk: string): void;
  /** Feeds one extra complete line (for example from a checkpoint file). */
  feedLine(line: string): void;
  /**
   * Call once the child has exited: stops the timers and the abort listener, flushes a trailing
   * stderr line, and resolves when every checkpoint has been delivered. It sends no signal:
   * stragglers of a stopped or budget-killed run are reaped from the `exit` event instead.
   */
  finish(): Promise<void>;
  /** Sends `signal` to the child's process group (falls back to the child alone). */
  signalGroup(signal: NodeJS.Signals): void;
}

/** Starts supervising an already spawned, detached child. Aborts and budgets act on its group. */
export function superviseProcess(child: ChildProcess, options: SupervisorOptions): ProcessSupervisor {
  let stopRequested = false;
  let budgetExceeded = false;
  let lastPhase: HarnessPhase = 'cloned';
  let stderrBuf = '';
  let killTimer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let exited = false;

  const signalGroup = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined || exited) return;
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
    killTimer = setTimeout(() => signalGroup('SIGKILL'), options.graceMs);
  };

  // The leader is reaped. If a stop or budget kill was in progress, SIGKILL the group now, while a
  // straggler (if any) still keeps the group id allocated; otherwise leave the group alone.
  child.once('exit', () => {
    const killing = killTimer !== undefined;
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (killing && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // group already empty
      }
    }
    exited = true;
  });

  const onAbort = (): void => {
    stopRequested = true;
    terminate();
  };
  const budgetTimer = setTimeout(() => {
    budgetExceeded = true;
    terminate();
  }, options.budgetMs);
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });

  const deliver = (checkpoint: HarnessCheckpoint): void => {
    if (HARNESS_PHASES.indexOf(checkpoint.phase) > HARNESS_PHASES.indexOf(lastPhase)) lastPhase = checkpoint.phase;
    chain = chain.then(() => options.onCheckpoint(checkpoint)).catch(() => undefined);
  };
  const feedLine = (line: string): void => {
    const parsed = parseCheckpointLine(line);
    if (parsed.kind === 'checkpoint') deliver(parsed.checkpoint);
  };

  return {
    get stopRequested() {
      return stopRequested;
    },
    get budgetExceeded() {
      return budgetExceeded;
    },
    get lastPhase() {
      return lastPhase;
    },
    deliver,
    feedLine,
    feedStderr(chunk) {
      stderrBuf += chunk;
      let nl = stderrBuf.indexOf('\n');
      while (nl !== -1) {
        feedLine(stderrBuf.slice(0, nl));
        stderrBuf = stderrBuf.slice(nl + 1);
        nl = stderrBuf.indexOf('\n');
      }
      if (stderrBuf.length > MAX_PARTIAL_LINE_CHARS) stderrBuf = '';
    },
    async finish() {
      if (killTimer !== undefined) clearTimeout(killTimer);
      clearTimeout(budgetTimer);
      options.signal.removeEventListener('abort', onAbort);
      if (stderrBuf !== '') feedLine(stderrBuf);
      stderrBuf = '';
      await chain;
    },
    signalGroup,
  };
}
