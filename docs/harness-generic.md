# The generic harness contract

**Status:** contract version 1. **Spec:** main 14.5, Companion B 9, ADR 0003. **Code:** `packages/pipeline/src/ports/harness.ts` (types), `packages/pipeline/src/harness/contract.ts` (validators).

The `generic` harness adapter runs any coding agent (Cursor, Aider, an in-house script) as a child process, without Snapwing code specific to that agent. This page is the whole agreement between Snapwing and that process. A command that follows it can be configured as a fixer or a review agent:

```xml
<harness fixer="generic" review="generic">
  <generic id="aider" command="aider --yes --message-file - --json-result" timeout="PT30M"/>
</harness>
```

Everything the process prints is untrusted. Snapwing validates it with `parseHarnessResult` and `parseCheckpointLine` before it becomes an event; unknown fields are dropped, never forwarded.

## 1. Where it runs

The RunnerPort (main 14.3) starts the command inside the ephemeral fixer container, with the working directory set to the prepared checkout. The runner clones the repository before the command starts and records the `cloned` checkpoint itself, so a harness may begin at `branched`.

**The `local` runner is for development only (ADR 0017).** It starts the command as a child process on the server's host, as the server's own OS user, so the command can read any file that user can. Every adapter gives the process a fresh, empty scratch `HOME` and `TMPDIR` (section 7) and refuses a working directory in or above the server's own tree, but that is not a boundary. Any deployment that holds real secrets runs harnesses inside the `docker` provider or another container or VM provider; `snapwing serve` refuses `<runtime provider="local">` when `NODE_ENV=production` or any production secret (the GitHub App key, the Slack and Teams bot credentials, the Jira API token) is present, in the environment or the `.env` file, unless `--allow-local-runner` is passed, and warns whenever it starts with it.

The checkout (`packages/pipeline/src/fixer/workdir/`) is already on the work branch: `handoff/@branch`, else `fix/` plus the issue key, cut from `handoff/@base` (else the repository's default branch), or the existing remote branch on a retry. Commits carry the bot identity. Two hooks are installed: `commit-msg` rejects a message without the issue key, and `pre-push` rejects a push to any ref but the work branch and a branch whose diff against the base touches `.github/workflows/**`, `CODEOWNERS`, or `.github/settings.yml`. The hooks catch mistakes; the token's scope and branch protection are the boundary. Everything Snapwing adds lives under `.git/snapwing/`, outside the worktree.

The command template is split into an argument vector (whitespace separated, double quotes respected) and executed without a shell. Snapwing never interpolates incident text into the command line; the incident reaches the process only through stdin.

The harness process never talks to the Snapwing database or the fixer API. The wrapper in the container that starts it holds the short-lived fixer token (B 9), posts checkpoints and the result to the fixer endpoints, and polls for Stop. The wrapper is the fixer image's entrypoint (section 8).

**The review role runs in a container of its own (ADR 0017 amendment 1, #239).** With a runner that has a boundary, the review job starts the same image with `SNAPWING_ROLE=review` (docker: `snapwing-review-<runId>`, attached). Its only mount is a self-contained copy of the pull request's head (no remote, no Git credential, no hooks), with the review input at `SNAPWING_REVIEW_INPUT_FILE` and the verdict going to `SNAPWING_REVIEW_FILE`, both under `.git/snapwing/` in the mount. The wrapper starts the configured review harness with the input file on stdin; it holds no fixer token and reports nothing to the fixer API. Snapwing reads the verdict file from the mount after the container is gone, accepting only a small regular file (no symlink), and validates it with `parseReviewVerdict`.

**The review container runs none of the pull request's code (#263).** The reviewer reads the checkout; the regression proof runs the tests itself, at the base and at the head, each in a test container of its own (`snapwing-tests-<runId>`) with its own copy of the tree, and only after the verdict has been read. The built-in adapters give the review agent read-only tools (`claude-code`: Read, Glob, Grep, and none of the checkout's own settings, hooks or MCP servers; `codex`: the `read-only` sandbox; `gemini`: read tools only), and the agent states its verdict at the end of its final message. The harness gets a `SNAPWING_REVIEW_FILE` in a private directory outside the mount; once the harness has exited, the wrapper copies that file into the mount, replacing whatever is there, and exits 0. A generic review command must keep the same rule: read the checkout, never run its tests, scripts or dependencies.

## 2. Stdin

The implementation request (main 9, the XML document `schemas/implementation-request.xsd` validates), encoded as UTF-8, then end of file. For the review role it is the review request instead (`prompts/review.xml`: the request's constraints and the pull request diff). Stdin is closed after the request; a harness that waits for more input will hang until its budget ends.

## 3. Stdout: exactly one JSON object

When the process exits, stdout must hold exactly one JSON object, UTF-8, and nothing else. Leading and trailing whitespace and a leading byte order mark are tolerated. Log output belongs on stderr. The object is at most 1 MiB.

| `outcome` | Required fields | Optional fields |
|---|---|---|
| `done` | `branch` (non-empty string), `summary` (string), `testsAdded` (array of file paths, may be empty) | `prNumber` (positive integer) |
| `failed` | `reason` (non-empty string), `attempts` (integer, 0 or more) | `partialBranch` (non-empty string) |
| `stopped` | `atPhase` (one of the checkpoint phases in section 4) | none |

An optional field may be omitted or set to `null`; both mean "not given". Unknown fields are ignored.

```json
{"outcome":"done","branch":"fix/WEB-1042","prNumber":87,"summary":"Guard against a null cart in checkout","testsAdded":["test/cart.test.ts"]}
{"outcome":"failed","reason":"tests still failing after 3 attempts","partialBranch":"fix/WEB-1042","attempts":3}
{"outcome":"stopped","atPhase":"tested"}
```

A payload that is empty, not JSON, not an object, has an unknown `outcome`, or has a missing or mistyped field is a contract violation. `parseHarnessResult` returns `{ ok: false, error }` with `error.code` one of `empty`, `too-large`, `not-json`, `not-object`, `unknown-outcome`, `unknown-phase`, `invalid-field`, and `error.field` naming the field when there is one.

## 4. Stderr: checkpoints as JSON lines

The process reports progress by writing one JSON object per line to stderr:

```
{"phase":"branched","detail":"fix/WEB-1042"}
{"phase":"implemented"}
{"phase":"tested","detail":"14 passed, 1 added"}
{"phase":"pushed"}
{"phase":"pr-opened","detail":"#87"}
```

`phase` is one of `cloned`, `branched`, `implemented`, `tested`, `pushed`, `pr-opened`, in that run order (B 9). `detail` is an optional string. Each valid line is passed to `onCheckpoint` and becomes a `POST /fixer/{workItemId}/checkpoint` event.

Every other line is noise and is ignored for checkpoints (it may be kept as a truncated log): blank lines, plain text, text that starts with `{` but is not JSON, and JSON objects without a `phase` key (so a harness that writes structured logs to stderr is fine). A JSON object that has a `phase` key but an unknown phase or a non-string `detail` is a malformed checkpoint: it is logged as a contract warning and does not fail the run. Lines longer than 64 KiB are rejected the same way.

## 5. Exit codes

| Exit | Stdout | Recorded result |
|---|---|---|
| 0 | valid result | that result |
| 0 | invalid or empty | `failed`, `reason` starting `harness contract:` plus the parse error, `attempts: 1` |
| non-zero, no Stop delivered | valid `failed` result | that result |
| non-zero, no Stop delivered | anything else | `failed`, `reason` `harness exited with code N`, `attempts: 1`; a `done` with a non-zero exit is treated as anything else |
| any, after Stop (section 6) | valid `stopped` result | that result |
| any, after Stop (section 6) | anything else, or killed | `stopped`, `atPhase` the last valid checkpoint (at least `cloned`) |

Exit codes other than 0 carry no further meaning; put the reason in a `failed` result.

## 6. Stop and budgets

Stop is delivered as signals, never on stdin:

1. The wrapper sends `SIGTERM` to the process group.
2. The process should stop work, print a `stopped` result naming the phase it reached, and exit.
3. If it is still running after the grace period (`PT10S`), the wrapper sends `SIGKILL` to the process group.

A Stop is delivered when an approver taps Stop (the stop poll in B 9 returns 204) or the run's `AbortSignal` fires. The wrapper polls the stop endpoint after every checkpoint and at least every 5 seconds.

The wall clock budget (`timeout` on the `generic` element, else `PT30M`, main 10.4) ends the run the same way, with `SIGTERM` then `SIGKILL`, but the recorded result is `failed` with `reason` `budget-exceeded: wall clock <duration> exceeded`, because nobody asked it to stop. The attempts budget is the harness's own to respect; it is passed in the environment and `attempts` in a `failed` result reports how many it used.

## 7. Environment

The process does not inherit the server's environment. It gets exactly these variables, plus the credentials in the last rows:

| Variable | Value |
|---|---|
| `SNAPWING_HARNESS_CONTRACT` | `1`, the version of this page |
| `SNAPWING_ROLE` | `fixer` or `review` |
| `SNAPWING_WORK_ITEM_ID` | the work item ULID |
| `SNAPWING_ISSUE_KEY` | the Jira key, for example `WEB-1042` |
| `SNAPWING_REPO` | `owner/name` of the target repository |
| `SNAPWING_WORKDIR` | absolute path of the checkout (also the working directory) |
| `SNAPWING_BUDGET_WALL_CLOCK` | ISO 8601 duration, for example `PT30M` |
| `SNAPWING_BUDGET_ATTEMPTS` | positive integer |
| `SNAPWING_CHECKPOINT_FILE` | adapter-specific, set only by the CLI adapters (`claude-code`, `codex`, `gemini`): absolute path of a file the agent appends checkpoint JSON lines to (those CLIs' own stderr cannot carry them); the adapter reads it and delivers each line like a stderr checkpoint. The `generic` adapter never sets it |
| `SNAPWING_REVIEW_FILE` | review role only: absolute path the harness leaves its verdict JSON at (`packages/pipeline/src/review/verdict.ts`), outside the worktree (under `.git/snapwing/` on the `local` runner, a private directory outside the mount in a runner container) so no commit can include it. A generic review command writes it itself. The built-in CLI adapters never pass it to the agent: they write it from the verdict at the end of the agent's final message (`prompts/review.xml`) once the agent has exited, replacing whatever is there |
| `SNAPWING_REVIEW_INPUT_FILE` | review role in a runner container only: absolute path of the review request inside the mount, for the wrapper to feed the harness on stdin (section 2) |
| `SNAPWING_PRIOR_REVIEW_FILE` | fixer retry runs only: absolute path of the `review` artifact of the `request-changes` verdict that caused the retry (JSON, main 11.1), under `.git/snapwing/` so no commit can include it. Absent on a first run |
| Git credential | fixer role only, for the one repository (a reviewer never fetches or pushes, so the review role gets none): a GitHub App installation token with `contents: write` and `pull_requests: write`, never `workflows`. Git asks for it whenever it needs one, and the agent reads it the same way for the GitHub REST API (`git credential fill`, piped into curl as a header, `prompts/fixer.xml`). The token is in no file, argv, remote URL, or Git config. How it is answered depends on the runner (#266, below) |
| `SNAPWING_GIT_CREDENTIAL_SOCKET`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` | fixer role in a runner container: Git's only credential helper is the image's `git-credential` script, which asks the wrapper over this unix socket; the wrapper fetches a fresh token from `GET /fixer/{workItemId}/git-token` (B 9) each time. No git token is in the container's environment. The same `GIT_CONFIG_*` entries set `core.hooksPath` to the checkout's hooks |
| `GIT_ASKPASS`, `SNAPWING_GIT_TOKEN` | fixer role on the `local` runner (development only): the askpass script answers with `SNAPWING_GIT_TOKEN`, the one token minted when the run started, so a run there cannot outlive the token's hour |
| `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT` | `1`, the null device, and `0`: Git reads only the checkout's own config and never prompts |
| `PATH`, `LANG` | from the runner image |
| `HOME`, `TMPDIR` | a fresh, empty, private (`0700`) scratch directory per run, removed when the run ends; never the server user's home, and neither the config nor the run's environment can override them (ADR 0017). A CLI agent authenticates with its API key variable, not a login stored in a home directory |
| model access in a runner container | **no model provider key ever enters a container** (ADR 0017 amendment 1). With the server's model proxy configured, the runner sets each CLI's base URL to the proxy (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, and `SNAPWING_MODEL_PROXY_URL` for a wrapper) and puts a per-run model token in the conventional key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`). The token works only on the proxy's generation endpoints, only for this work item, only until shortly after the run's budget, and is not a fixer API token. Without a proxy the container has no model access |
| model access on the `local` runner (development only) | the CLI adapters copy their key and base URL variables from the server's environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and the base URL names above); never the fixer API token |

The variables exist so a wrapper script can route or log a run without parsing the implementation request.

**Git token lifetime (#266).** GitHub installation tokens expire after one hour, and the fixer wall clock (default `PT30M`) is configurable, so a run past the hour would fail its push or its pull request. Two fixes were considered: (a) a fixer API endpoint that mints a fresh token per request, with a credential helper in the image, or (b) rejecting a fixer wall clock above 55 minutes at config load. **(a) is the choice.** It also covers long runs, and it puts no long-lived git token in a container at all: the container holds only its fixer token, which only the wrapper sees, and every git token it gets lives at most an hour (the server's cache reuses one while it has more than five minutes left). `GET /fixer/{workItemId}/git-token` takes the run's fixer token, is refused like a report once the run has ended or the incident is closed, and mints for the incident's repository with the fixer's scopes. The fixer token itself now lives for the run's wall clock plus 15 minutes (`fixerTokenTtl`), so reports and token requests work to the end of a long run. The `local` runner keeps its one token per run (development only).

## 8. The fixer image

`infra/docker/fixer/` holds the image the `docker` runner starts (ADR 0017): `Dockerfile`, the entrypoint wrapper (`entrypoint.ts`, `wrapper.ts`), and a git credential helper (`git-credential`). It is a slim Node image (`node:24-bookworm-slim`; Node 22.18 or later runs the wrapper's TypeScript directly) with git, tini, a non-root `snapwing` user, and the `claude` CLI. The codex and gemini CLIs are behind build args; their package names and the flags their adapters use are from memory (#150, #232), so check them against each CLI's help when enabling them.

Build it from the repository root, then point the server at it:

```sh
pnpm fixer-image:build
pnpm fixer-image:build --build-arg INSTALL_CODEX=true --build-arg INSTALL_GEMINI=true
# in the server's environment
SNAPWING_FIXER_IMAGE=snapwing-fixer:local
```

Other build args: `NODE_VERSION`, `CLAUDE_CODE_VERSION`, `CODEX_VERSION`, `GEMINI_VERSION` (each CLI defaults to its latest release). CI never builds or runs the image; `packages/app/test/unit/fixer-image.test.ts` runs the wrapper itself with fake CLIs and checks the Dockerfile statically.

**No secret is baked in.** `Dockerfile.dockerignore` filters the build context to `packages/pipeline/src` (the harness adapters and prompts the wrapper runs, the same code the `local` runner uses) and the wrapper's own files. Everything a run needs arrives as variables at `docker run` time, by name, from the runner (`packages/app/src/providers/docker/runner.ts`).

**What the wrapper does**, by `SNAPWING_ROLE`:

- `fixer`: the work item is in the mount: a checkout on the work branch at `SNAPWING_WORKDIR`, with the implementation request at `.git/snapwing/implementation-request.xml` inside it. The docker runner prepares both on the host before `docker run` (`prepareWorkdir`, as the `local` runner does, #256), using the installation token for that clone only (no git token enters the container, #266), and runs the container as the server's uid:gid so it can write the checkout and the server can remove it afterwards. A directory whose container the runner never saw end (a restart, a lost daemon) is removed by the runner's `sweep` at the next server start once it is older than the fixer wall clock plus 15 minutes and no `snapwing-fixer-<runId>` container exists; the `local` runner sweeps its own `workdirRoot` the same way. The wrapper checks Stop, reports `cloned`, runs the harness named by `SNAPWING_HARNESS` with the request on stdin, posts every checkpoint to `SNAPWING_API_URL` with `SNAPWING_FIXER_TOKEN`, polls Stop after each checkpoint and every 5 seconds, and posts `done` (a `done` without a pull request is posted as `failed`) or `failed`. A 204 from the stop poll, a 409 from any call, or SIGTERM from `docker stop` stops the harness (SIGTERM, then SIGKILL after 8 seconds, inside docker's own grace). A run with no checkout or no request in the mount is reported `failed` without starting a harness. The harness never sees the fixer token. While the harness runs, the wrapper serves git credentials on a unix socket in a private temp directory (`SNAPWING_GIT_CREDENTIAL_SOCKET`, removed with the run) and sets the image's `git-credential` script as Git's only credential helper; each time Git asks, the wrapper fetches `GET /fixer/{workItemId}/git-token` with the fixer token and answers with the fresh token, held in memory only. A 409 there stops the harness; any other failure answers Git nothing, so it fails to authenticate. The harness can ask the socket too, but only ever gets git tokens from it. The checkout's `.git/snapwing/hooks` (when present) is `core.hooksPath`. `SNAPWING_PRIOR_REVIEW_FILE` is passed on when it lies in the mount.
- `review`: the wrapper feeds `SNAPWING_REVIEW_INPUT_FILE` to the review harness on stdin, with `SNAPWING_REVIEW_FILE` set to a file in a private directory outside the mount (#263). Once the harness has finished, it copies that file, when it is a small regular file, to the mount's `SNAPWING_REVIEW_FILE`, replacing whatever is there, and exits 0; otherwise it exits non-zero, which the review job treats as `escalate`. It never calls the fixer API.
- A `generic` harness runs the command template the image keeps at `/etc/snapwing/generic/<templateId>` (one line; `SNAPWING_GENERIC_DIR` moves the directory). Server config does not reach the container, so an image that runs a generic agent is built `FROM` this one, installs the agent, and adds the template file.

**Model access.** The wrapper rebuilds each CLI's base URL from `SNAPWING_MODEL_PROXY_URL` (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) and keeps a key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`) only when it holds a model proxy token (`swm1.`). Any other value, a real provider key passed by mistake included, and `GOOGLE_API_KEY` always, is removed before a harness starts and named on stderr without its value. Without a proxy, no model variable reaches the harness.

**Exit codes**: 0 done, stopped, or review verdict written; 1 the fixer reported `failed` or the review produced no verdict; 2 the container lacks its contract (unknown role, missing variables); 3 the fixer could not deliver its final report.
