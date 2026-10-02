// src/harness/process.ts: the stop, budget, and checkpoint logic shared by the process-based harness
// adapters (generic and claude-code; main 14.5, docs/harness-generic.md sections 4 and 6).
//
// One implementation of: SIGTERM then SIGKILL to the whole process group after a grace period, the
// wall-clock budget timer, the abort-signal listener, stderr line splitting into checkpoints, and
// in-order delivery of checkpoints to `onCheckpoint`. Deciding what the run's outcome is stays with
// each adapter, because the stdout formats differ.

import type { ChildProcess } from 'node:child_process';
import type { HarnessCheckpoint, HarnessPhase, HarnessRunOptions } from '../ports/harness.ts';
import { HARNESS_PHASES, parseCheckpointLine } from './contract.ts';

/** Default SIGTERM to SIGKILL grace in milliseconds (`PT10S`, docs/harness-generic.md section 6). */
export const DEFAULT_KILL_GRACE_MS = 10_000;
/** A stderr line that never ends cannot be a checkpoint; the buffer is dropped past this size. */
const MAX_PARTIAL_LINE_CHARS = 128 * 1024;

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
   * stderr line, reaps stragglers in the process group, and resolves when every checkpoint has
   * been delivered.
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
    killTimer = setTimeout(() => signalGroup('SIGKILL'), options.graceMs);
  };

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
      signalGroup('SIGKILL'); // reap stragglers in the group; a no-op when none remain
      if (stderrBuf !== '') feedLine(stderrBuf);
      stderrBuf = '';
      await chain;
    },
    signalGroup,
  };
}
