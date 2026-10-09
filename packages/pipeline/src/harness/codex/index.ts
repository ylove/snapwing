// src/harness/codex/index.ts: the codex harness adapter (main 14.5, ADR 0003).
//
// Flags used (checked against `codex exec --help`, Codex CLI, 2026-10):
//   exec                          non-interactive run; a trailing `-` reads the prompt from stdin
//   --sandbox danger-full-access  the fixer container is the boundary and `git push` needs the network
//   --sandbox read-only           the review role instead (main 11.1, #263): codex has no per-tool allow list, so
//                                 nothing the agent runs may write anywhere. The verdict is the end of its final
//                                 message, which codex itself writes to the last-message file below and
//                                 ../cli-agent.ts writes to SNAPWING_REVIEW_FILE once the agent has exited.
//   --ignore-rules                review role only: no execpolicy `.rules` file, the checkout's included. Codex
//                                 loads a project's `.codex/config.toml` only for a trusted project, and the run's
//                                 CODEX_HOME (in its empty scratch HOME) trusts none; the review job also leaves
//                                 `.codex/` out of the agent's tree (#263)
//   --skip-git-repo-check         never fail on the checkout's git state
//   --output-last-message <file>  the agent's final message is written to this file (stdout carries progress)
//   --model <model>               only when configured
//   -c model_provider=...         the model proxy (main 14, ADR 0017, #296). Codex 0.162 ignores OPENAI_BASE_URL and
//                                 calls the provider's public host, so a `snapwing-proxy` provider entry is passed as
//                                 `-c` overrides: base_url from the run's OPENAI_BASE_URL, key from OPENAI_API_KEY.
//
// Codex has no system prompt flag, so the stdin text is the fixer prompt (src/prompts/fixer.xml, or review.xml for the review role) followed
// by the implementation request. Stop, budget, and checkpoints are shared with the other adapters through
// ../cli-agent.ts and ../process.ts (docs/harness-generic.md sections 5 to 7).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessPort, HarnessResult } from '../../ports/harness.ts';
import { messageOf, REVIEW_PROMPT_URL, resultFromMessage, runCliAgent, type Extracted } from '../cli-agent.ts';
import { DEFAULT_KILL_GRACE_MS } from '../process.ts';

export interface CodexHarnessConfig {
  /** The executable. Default `codex`. */
  bin?: string;
  /** Passed as `--model` when set. */
  model?: string;
  /** SIGTERM to SIGKILL grace period in milliseconds. Default 10000 (PT10S). Tests shorten it. */
  killGraceMs?: number;
}

const PROXY_PROVIDER = 'snapwing-proxy';

/**
 * The `-c` overrides that make codex send every model call to the run's model proxy (#296). Without a base URL
 * (no proxy, a local run) codex keeps its own provider settings. The URL is a TOML string, so JSON quoting is exact.
 */
export function proxyProviderArgs(baseUrl: string | undefined): string[] {
  if (baseUrl === undefined || baseUrl === '') return [];
  const provider = `{ name = "Snapwing model proxy", base_url = ${JSON.stringify(baseUrl)}, env_key = "OPENAI_API_KEY", wire_api = "responses" }`;
  return ['-c', `model_provider="${PROXY_PROVIDER}"`, '-c', `model_providers.${PROXY_PROVIDER}=${provider}`];
}

const FIXER_PROMPT_URL = new URL('../../prompts/fixer.xml', import.meta.url);

export function createCodexHarness(config: CodexHarnessConfig = {}): HarnessPort {
  const bin = config.bin ?? 'codex';
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    async run(workItem, implementationRequest, workdir, opts): Promise<HarnessResult> {
      const review = opts.role === 'review';
      const systemPrompt = await readFile(review ? REVIEW_PROMPT_URL : FIXER_PROMPT_URL, 'utf8');
      const scratch = await mkdtemp(join(tmpdir(), 'snapwing-codex-'));
      const lastMessageFile = join(scratch, 'last-message.txt');
      const args = ['exec', '--sandbox', review ? 'read-only' : 'danger-full-access', ...(review ? ['--ignore-rules'] : []), '--skip-git-repo-check', '--output-last-message', lastMessageFile];
      args.push(...proxyProviderArgs(opts.env?.['OPENAI_BASE_URL'] ?? process.env['OPENAI_BASE_URL']));
      if (config.model !== undefined) args.push('--model', config.model);
      args.push('-');
      try {
        return await runCliAgent({
          bin,
          args,
          workItem,
          request: `${systemPrompt}\n${implementationRequest}`,
          workdir,
          opts,
          graceMs,
          checkpointFile: join(scratch, 'checkpoints.jsonl'),
          extraFile: lastMessageFile,
          extract: extractResult,
          ...(review ? { reviewMessage: (stdout: string, lastMessage: string | undefined) => messageOf(finalMessage(stdout, lastMessage)) } : {}),
          inheritEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

/** The result is the end of the last-message file; stdout (progress text) is the fallback if the file is missing. */
export function extractResult(stdout: string, lastMessage: string | undefined): Extracted {
  const message = finalMessage(stdout, lastMessage);
  return typeof message === 'string' ? resultFromMessage(message) : message;
}

/** The agent's final message: the last-message file, else stdout. */
export function finalMessage(stdout: string, lastMessage: string | undefined): string | { kind: 'error'; message: string } {
  const message = (lastMessage ?? stdout).trim();
  return message === '' ? { kind: 'error', message: 'codex printed no final message' } : message;
}
