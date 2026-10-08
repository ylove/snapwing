// src/harness/gemini/index.ts: the gemini harness adapter (main 14.5, ADR 0003).
//
// Flags used (checked against `gemini --help`, Gemini CLI, 2026-10):
//   --prompt <text>        non-interactive mode; text piped on stdin is appended to this prompt, so the
//                          prompt is the fixer prompt (src/prompts/fixer.xml, or review.xml for the review role) and stdin is the request
//   --output-format json   one JSON object on stdout; the agent's final message is its `response` string
//   --yolo                 auto-approve tool calls; the fixer container is the boundary
//   --allowed-tools <list> the review role instead of --yolo: comma-separated read tools only
//                          (read_file, read_many_files, list_directory, glob, search_file_content); other
//                          tools, run_shell_command included, are not approved, and in non-interactive mode
//                          that means denied
//   --model <model>        only when configured
//
// The review agent reads and never runs (main 11.1, #263): its verdict is the end of its final message,
// which ../cli-agent.ts writes to SNAPWING_REVIEW_FILE once the agent has exited.
//
// Stop, budget, and checkpoints are shared with the other adapters through ../cli-agent.ts and
// ../process.ts (docs/harness-generic.md sections 5 to 7).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessPort, HarnessResult } from '../../ports/harness.ts';
import { messageOf, REVIEW_PROMPT_URL, resultFromMessage, runCliAgent, type Extracted } from '../cli-agent.ts';
import { DEFAULT_KILL_GRACE_MS } from '../process.ts';

export interface GeminiHarnessConfig {
  /** The executable. Default `gemini`. */
  bin?: string;
  /** Passed as `--model` when set. */
  model?: string;
  /** SIGTERM to SIGKILL grace period in milliseconds. Default 10000 (PT10S). Tests shorten it. */
  killGraceMs?: number;
}

const REVIEW_TOOLS: readonly string[] = ['read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content'];
const FIXER_PROMPT_URL = new URL('../../prompts/fixer.xml', import.meta.url);

export function createGeminiHarness(config: GeminiHarnessConfig = {}): HarnessPort {
  const bin = config.bin ?? 'gemini';
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    async run(workItem, implementationRequest, workdir, opts): Promise<HarnessResult> {
      const review = opts.role === 'review';
      const systemPrompt = await readFile(review ? REVIEW_PROMPT_URL : FIXER_PROMPT_URL, 'utf8');
      const args = ['--prompt', systemPrompt, '--output-format', 'json'];
      if (review) args.push('--allowed-tools', REVIEW_TOOLS.join(','));
      else args.push('--yolo');
      if (config.model !== undefined) args.push('--model', config.model);

      const scratch = await mkdtemp(join(tmpdir(), 'snapwing-gemini-'));
      try {
        return await runCliAgent({
          bin,
          args,
          workItem,
          request: implementationRequest,
          workdir,
          opts,
          graceMs,
          checkpointFile: join(scratch, 'checkpoints.jsonl'),
          extract: (stdout) => extractResult(stdout),
          ...(review ? { reviewMessage: (stdout: string) => messageOf(finalMessage(stdout)) } : {}),
          inheritEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL'],
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

/** Gemini's `--output-format json` prints one object whose `response` string is the final message. */
export function extractResult(stdout: string): Extracted {
  const message = finalMessage(stdout);
  return typeof message === 'string' ? resultFromMessage(message) : message;
}

/** The agent's final message: the `response` string in Gemini's JSON output. */
export function finalMessage(stdout: string): string | { kind: 'error'; message: string } {
  const text = stdout.trim();
  if (text === '') return { kind: 'error', message: 'stdout is empty; expected gemini JSON output' };
  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch {
    return { kind: 'error', message: 'stdout is not gemini JSON output' };
  }
  const response = typeof outer === 'object' && outer !== null && !Array.isArray(outer) ? (outer as Record<string, unknown>)['response'] : undefined;
  if (typeof response !== 'string') return { kind: 'error', message: 'gemini output has no string `response` field' };
  return response;
}
