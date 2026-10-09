// src/harness/codex/index.ts: the codex harness adapter (main 14.5, ADR 0003).
//
// Flags used (checked against `codex exec --help`, Codex CLI, 2026-10):
//   exec                          non-interactive run; a trailing `-` reads the prompt from stdin
//   --sandbox danger-full-access  the fixer container is the boundary and `git push` needs the network
//   --sandbox workspace-write     the review role instead: it can run commands and read, but not write outside the
//                                 workdir and temp dirs. Codex has no per-tool allow list, and read-only would block
//                                 the verdict file (SNAPWING_REVIEW_FILE), so this is the tightest sandbox that works.
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
import { REVIEW_PROMPT_URL, resultFromMessage, runCliAgent, type Extracted } from '../cli-agent.ts';
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
      const args = ['exec', '--sandbox', review ? 'workspace-write' : 'danger-full-access', '--skip-git-repo-check', '--output-last-message', lastMessageFile];
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
          doneOnExit: review,
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
  const message = (lastMessage ?? stdout).trim();
  if (message === '') return { kind: 'error', message: 'codex printed no final message' };
  return resultFromMessage(message);
}
