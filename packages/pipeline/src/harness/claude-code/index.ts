// src/harness/claude-code/index.ts: the claude-code harness adapter (main 14.5, ADR 0003).
//
// Flags used (checked against `claude --help`, Claude Code CLI, 2026-10):
//   -p                           non-interactive print mode; the implementation request is piped on stdin
//   --output-format json         one JSON object on stdout; the agent's final message is its `result` string
//   --append-system-prompt <txt> text of src/prompts/fixer.xml, or review.xml for the review role (the *-file variant is not a listed option)
//   --permission-mode dontAsk    never prompt; anything not in --allowedTools is denied
//   --allowedTools <tools...>    fixer default: Bash Edit Write Read Glob Grep; review default: Bash Read Glob Grep
//   --model <model>              only when configured
//   --no-session-persistence     fixer runs are disposable
//
// Stop and budget follow docs/harness-generic.md section 6 and are shared with the generic adapter
// through ../process.ts.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessPort, HarnessResult } from '../../ports/harness.ts';
import { REVIEW_PROMPT_URL, runCliAgent, resultFromMessage, type Extracted } from '../cli-agent.ts';
import { DEFAULT_KILL_GRACE_MS } from '../process.ts';

export interface ClaudeCodeHarnessConfig {
  /** The executable. Default `claude`. */
  bin?: string;
  /** Passed as `--model` when set. */
  model?: string;
  /** Passed as `--allowedTools` for the fixer. Default: Bash, Edit, Write, Read, Glob, Grep. */
  allowedTools?: readonly string[];
  /** Passed as `--allowedTools` for the review role. Default: Bash, Read, Glob, Grep (no Edit or Write). */
  reviewTools?: readonly string[];
  /** SIGTERM to SIGKILL grace period in milliseconds. Default 10000 (PT10S). Tests shorten it. */
  killGraceMs?: number;
}

const DEFAULT_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];
const DEFAULT_REVIEW_TOOLS: readonly string[] = ['Bash', 'Read', 'Glob', 'Grep'];
const FIXER_PROMPT_URL = new URL('../../prompts/fixer.xml', import.meta.url);

export function createClaudeCodeHarness(config: ClaudeCodeHarnessConfig = {}): HarnessPort {
  const bin = config.bin ?? 'claude';
  const fixerTools = config.allowedTools ?? DEFAULT_TOOLS;
  const reviewTools = config.reviewTools ?? DEFAULT_REVIEW_TOOLS;
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    async run(workItem, implementationRequest, workdir, opts): Promise<HarnessResult> {
      const review = opts.role === 'review';
      const tools = review ? reviewTools : fixerTools;
      const systemPrompt = await readFile(review ? REVIEW_PROMPT_URL : FIXER_PROMPT_URL, 'utf8');
      const args = ['-p', '--output-format', 'json', '--append-system-prompt', systemPrompt, '--permission-mode', 'dontAsk', '--no-session-persistence'];
      if (config.model !== undefined) args.push('--model', config.model);
      if (tools.length > 0) args.push('--allowedTools', tools.join(','));

      const scratch = await mkdtemp(join(tmpdir(), 'snapwing-claude-'));
      try {
        return await runCliAgent({ bin, args, workItem, request: implementationRequest, workdir, opts, graceMs, checkpointFile: join(scratch, 'checkpoints.jsonl'), extract: (stdout) => extractResult(stdout), doneOnExit: review, inheritEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

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

  return resultFromMessage(message);
}
