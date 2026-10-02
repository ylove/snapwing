// src/harness/claude-code/index.ts: the claude-code harness adapter (main 14.5, ADR 0003).
//
// Flags used (checked against `claude --help`, Claude Code CLI, 2026-10):
//   -p                           non-interactive print mode; the implementation request is piped on stdin
//   --output-format json         one JSON object on stdout; the agent's final message is its `result` string
//   --append-system-prompt <txt> text of src/prompts/fixer.xml (the *-file variant is not a listed option)
//   --permission-mode dontAsk    never prompt; anything not in --allowedTools is denied
//   --allowedTools <tools...>    default: Bash Edit Write Read Glob Grep
//   --model <model>              only when configured
//   --no-session-persistence     fixer runs are disposable
//
// Stop and budget follow docs/harness-generic.md section 6 and are shared with the generic adapter
// through ../process.ts.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessPort, HarnessResult, HarnessRunOptions, WorkItemRef } from '../../ports/harness.ts';
import { parseDuration } from '../../util/duration.ts';
import { MAX_RESULT_LENGTH, parseHarnessResult } from '../contract.ts';
import { DEFAULT_KILL_GRACE_MS, superviseProcess } from '../process.ts';

export interface ClaudeCodeHarnessConfig {
  /** The executable. Default `claude`. */
  bin?: string;
  /** Passed as `--model` when set. */
  model?: string;
  /** Passed as `--allowedTools`. Default: Bash, Edit, Write, Read, Glob, Grep. */
  allowedTools?: readonly string[];
  /** SIGTERM to SIGKILL grace period in milliseconds. Default 10000 (PT10S). Tests shorten it. */
  killGraceMs?: number;
}

const DEFAULT_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];
const FIXER_PROMPT_URL = new URL('../../prompts/fixer.xml', import.meta.url);
const CHECKPOINT_POLL_MS = 100;
/** Cap on captured stdout; far above a real `claude -p` payload, protects memory from a runaway process. */
const MAX_STDOUT_CHARS = 8 * MAX_RESULT_LENGTH;

export function createClaudeCodeHarness(config: ClaudeCodeHarnessConfig = {}): HarnessPort {
  const bin = config.bin ?? 'claude';
  const tools = config.allowedTools ?? DEFAULT_TOOLS;
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    async run(workItem, implementationRequest, workdir, opts): Promise<HarnessResult> {
      if (opts.role !== 'fixer') {
        return { outcome: 'failed', reason: `claude-code harness: role ${opts.role} is not supported yet`, attempts: 0 };
      }
      const systemPrompt = await readFile(FIXER_PROMPT_URL, 'utf8');
      const args = ['-p', '--output-format', 'json', '--append-system-prompt', systemPrompt, '--permission-mode', 'dontAsk', '--no-session-persistence'];
      if (config.model !== undefined) args.push('--model', config.model);
      if (tools.length > 0) args.push('--allowedTools', tools.join(','));

      const scratch = await mkdtemp(join(tmpdir(), 'snapwing-claude-'));
      try {
        return await runProcess({ bin, args, workItem, request: implementationRequest, workdir, opts, graceMs, checkpointFile: join(scratch, 'checkpoints.jsonl') });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

interface RunInput {
  bin: string;
  args: string[];
  workItem: WorkItemRef;
  request: string;
  workdir: string;
  opts: HarnessRunOptions;
  graceMs: number;
  checkpointFile: string;
}

async function runProcess(input: RunInput): Promise<HarnessResult> {
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

  const extracted = stdoutOverflow ? undefined : extractResult(stdout);

  if (stopRequested) {
    if (extracted?.kind === 'result' && extracted.result.outcome === 'stopped') return extracted.result;
    return { outcome: 'stopped', atPhase: lastPhase };
  }
  if (budgetExceeded) {
    return { outcome: 'failed', reason: `budget: wall clock ${opts.budget.wallClock} exceeded`, attempts: 1 };
  }

  if (code === 0) {
    if (extracted?.kind === 'result') return extracted.result;
    const why = stdoutOverflow ? 'stdout exceeded the size limit' : (extracted?.message ?? 'stdout is empty');
    return { outcome: 'failed', reason: `harness contract: ${why}`, attempts: 1 };
  }
  if (extracted?.kind === 'result' && extracted.result.outcome === 'failed') return extracted.result;
  return { outcome: 'failed', reason: `harness exited with code ${code ?? 'null'}`, attempts: 1 };
}

function buildEnv(input: RunInput): NodeJS.ProcessEnv {
  const { workItem, opts, workdir } = input;
  const env: NodeJS.ProcessEnv = {
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
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'ANTHROPIC_API_KEY'] as const) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

type Extracted = { kind: 'result'; result: HarnessResult } | { kind: 'error'; message: string };

/**
 * Claude Code's `--output-format json` prints one object whose `result` string is the agent's final
 * message. The HarnessResult is a JSON object at the end of that message, optionally fenced.
 */
export function extractResult(stdout: string): Extracted {
  const text = stdout.trim();
  if (text === '') return { kind: 'error', message: 'stdout is empty; expected claude JSON output' };
  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch {
    return { kind: 'error', message: 'stdout is not claude JSON output' };
  }
  // Some Claude Code versions emit an array of events; the last `result` event wins.
  const events = Array.isArray(outer) ? outer : [outer];
  let message: string | undefined;
  for (const e of events) {
    if (typeof e === 'object' && e !== null && !Array.isArray(e) && (e as Record<string, unknown>)['type'] === 'result') {
      const r = (e as Record<string, unknown>)['result'];
      if (typeof r === 'string') message = r;
    }
  }
  if (message === undefined) return { kind: 'error', message: 'claude output has no string `result` field' };

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
