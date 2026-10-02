// src/harness/cli-agent.ts: the process half shared by the CLI agent adapters (claude-code, codex,
// gemini; main 14.5, ADR 0003). Spawns the agent in its own process group, writes the stdin text,
// delivers checkpoints from SNAPWING_CHECKPOINT_FILE and stderr, and maps exit, Stop, and budget to a
// HarnessResult per docs/harness-generic.md sections 5 and 6. Each adapter supplies its argument
// vector, the exact stdin text, and how to pull the HarnessResult out of what the CLI printed.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { HarnessResult, HarnessRunOptions, WorkItemRef } from '../ports/harness.ts';
import { parseDuration } from '../util/duration.ts';
import { MAX_RESULT_LENGTH, parseHarnessResult } from './contract.ts';
import { budgetExceededReason, superviseProcess } from './process.ts';

export type Extracted = { kind: 'result'; result: HarnessResult } | { kind: 'error'; message: string };

const CHECKPOINT_POLL_MS = 100;
/** Cap on captured stdout; far above a real agent payload, protects memory from a runaway process. */
const MAX_STDOUT_CHARS = 8 * MAX_RESULT_LENGTH;

export interface CliRunInput {
  bin: string;
  args: string[];
  workItem: WorkItemRef;
  /** Exact text written to stdin. */
  request: string;
  /** Maps captured stdout, and the text of `extraFile` when given and readable, to a result. */
  extract: (stdout: string, extra: string | undefined) => Extracted;
  /** Optional file the CLI writes its final message to; read after exit and passed to `extract`. */
  extraFile?: string;
  /** Environment variable names copied from the server environment (the model key the CLI needs). */
  inheritEnv: readonly string[];
  workdir: string;
  opts: HarnessRunOptions;
  graceMs: number;
  checkpointFile: string;
}

export async function runCliAgent(input: CliRunInput): Promise<HarnessResult> {
  const { opts } = input;
  const wallClockMs = parseDuration(opts.budget.wallClock);
  const env = buildEnv(input);

  let stdout = '';
  let stdoutOverflow = false;

  const child = spawn(input.bin, input.args, { cwd: input.workdir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const supervisor = superviseProcess(child, { budgetMs: wallClockMs, graceMs: input.graceMs, signal: opts.signal, onCheckpoint: opts.onCheckpoint });

  // Checkpoint file: read it whole each poll and deliver only the complete lines not yet seen.
  let deliveredLines = 0;
  const pollCheckpointFile = async (final: boolean): Promise<void> => {
    let text: string;
    try {
      text = await readFile(input.checkpointFile, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n');
    if (!final) lines.pop(); // trailing partial line, if any
    else if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines.slice(deliveredLines)) supervisor.feedLine(line);
    deliveredLines = Math.max(deliveredLines, lines.length);
  };

  const exit = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once('error', (e) => resolve({ code: null, spawnError: e }));
    child.once('close', (code) => resolve({ code }));
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    if (stdout.length + d.length > MAX_STDOUT_CHARS) stdoutOverflow = true;
    else stdout += d;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => supervisor.feedStderr(d));
  child.stdin.on('error', () => undefined); // child may exit without reading stdin
  child.stdin.end(input.request, 'utf8');

  const poller = setInterval(() => void pollCheckpointFile(false), CHECKPOINT_POLL_MS);

  const { code, spawnError } = await exit;
  clearInterval(poller);
  await pollCheckpointFile(true);
  await supervisor.finish();
  const { stopRequested, budgetExceeded, lastPhase } = supervisor;

  if (spawnError !== undefined) {
    return { outcome: 'failed', reason: `harness could not start: ${spawnError.message}`, attempts: 0 };
  }

  let extra: string | undefined;
  if (input.extraFile !== undefined) extra = await readFile(input.extraFile, 'utf8').catch(() => undefined);
  const extracted = stdoutOverflow ? undefined : input.extract(stdout, extra);

  if (stopRequested) {
    if (extracted?.kind === 'result' && extracted.result.outcome === 'stopped') return extracted.result;
    return { outcome: 'stopped', atPhase: lastPhase };
  }
  if (budgetExceeded) {
    return { outcome: 'failed', reason: budgetExceededReason(opts.budget.wallClock), attempts: 1 };
  }

  if (code === 0) {
    if (extracted?.kind === 'result') return extracted.result;
    const why = stdoutOverflow ? 'stdout exceeded the size limit' : (extracted?.message ?? 'stdout is empty');
    return { outcome: 'failed', reason: `harness contract: ${why}`, attempts: 1 };
  }
  if (extracted?.kind === 'result' && extracted.result.outcome === 'failed') return extracted.result;
  return { outcome: 'failed', reason: `harness exited with code ${code ?? 'null'}`, attempts: 1 };
}

function buildEnv(input: CliRunInput): NodeJS.ProcessEnv {
  const { workItem, opts, workdir } = input;
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    SNAPWING_HARNESS_CONTRACT: '1',
    SNAPWING_ROLE: opts.role,
    SNAPWING_WORK_ITEM_ID: workItem.id,
    SNAPWING_ISSUE_KEY: workItem.issueKey,
    SNAPWING_REPO: workItem.repo,
    SNAPWING_WORKDIR: workdir,
    SNAPWING_BUDGET_WALL_CLOCK: opts.budget.wallClock,
    SNAPWING_BUDGET_ATTEMPTS: String(opts.budget.attempts),
    SNAPWING_CHECKPOINT_FILE: input.checkpointFile,
  };
  // Not the server's environment: only what the process needs (docs/harness-generic.md section 7).
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', ...input.inheritEnv]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}


/** The HarnessResult at the end of an agent's final message: whole message, fenced block, or trailing object. */
export function resultFromMessage(message: string): Extracted {
  let lastError = 'the result message holds no JSON object';
  for (const candidate of candidates(message)) {
    const parsed = parseHarnessResult(candidate);
    if (parsed.ok) return { kind: 'result', result: parsed.result };
    lastError = parsed.error.message;
  }
  return { kind: 'error', message: lastError };
}

/** Candidate JSON texts in `message`, best first: the whole message, fenced blocks, then trailing objects. */
function* candidates(message: string): Generator<string> {
  const trimmed = message.trim();
  yield trimmed;
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  for (const m of fences.reverse()) if (m[1] !== undefined) yield m[1];
  // Last line starting with `{`, then every `{` that is followed by "outcome", latest first.
  const starts: number[] = [];
  for (let i = trimmed.indexOf('{'); i >= 0; i = trimmed.indexOf('{', i + 1)) starts.push(i);
  for (const i of starts.reverse()) {
    const slice = trimmed.slice(i);
    if (/^\{\s*"outcome"/.test(slice)) yield slice;
  }
}
