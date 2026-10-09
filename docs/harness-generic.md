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

The checkout (`packages/pipeline/src/fixer/workdir/`) is already on the work branch: `handoff/@branch`, else `fix/` plus the issue key, cut from `handoff/@base` (else the repository's default branch), or the existing remote branch on a retry. The runner prepares it on the host with a token the harness never sees: no credential is in the checkout's config, its remote URL, its files, or the process's environment. Commits carry the bot identity. One hook is installed: `commit-msg` rejects a message without the issue key. Everything Snapwing adds lives under `.git/snapwing/`, outside the worktree.

**Commit on the work branch; never push (#262).** The process has no GitHub credential and needs none. When it ends with `done`, or `failed` with a `partialBranch`, the runner (the wrapper in a container, the `local` runner on the host) writes a bundle of the work branch's commits since the base it was given, and the server imports it into a repository it owns, never running Git in the checkout. The server refuses the whole hand-off, pushes nothing, and records the run as `failed` with the reason when the bundle carries any ref but the work branch, the work does not build on the given base, a commit message lacks the issue key, or the change touches `.github/workflows/**`, a `CODEOWNERS` file, or `.github/settings.yml` (a rename counts on both sides). Otherwise it pushes exactly the work branch with a token minted for that push and opens the pull request as the App, with the `summary` as its description. Only the work branch's commits are ever handed back: work on any other branch is lost. Those checks, and that the process holds no credential, are the boundary; the hook only catches the common mistake early.

The command template is split into an argument vector (whitespace separated, double quotes respected) and executed without a shell. Snapwing never interpolates incident text into the command line; the incident reaches the process only through stdin.

The harness process never talks to the Snapwing database or the fixer API. The wrapper in the container that starts it holds the short-lived fixer token (B 9), posts checkpoints and the result to the fixer endpoints, and polls for Stop. The wrapper is the fixer image's entrypoint (section 8).

**The review role runs in a container of its own (ADR 0017 amendment 1, #239).** With a runner that has a boundary, the review job starts the same image with `SNAPWING_ROLE=review` (docker: `snapwing-review-<runId>`, attached). Its only mount is a self-contained copy of the pull request's head (no remote, no Git credential, no hooks), with the review input at `SNAPWING_REVIEW_INPUT_FILE` and the verdict going to `SNAPWING_REVIEW_FILE`, both under `.git/snapwing/` in the mount. The wrapper starts the configured review harness with the input file on stdin; it holds no fixer token and reports nothing to the fixer API. Snapwing reads the verdict file from the mount after the container is gone, accepting only a small regular file (no symlink), and validates it with `parseReviewVerdict`.

**The review container runs none of the pull request's code (#263).** The reviewer reads the checkout; the regression proof runs the tests itself, at the base and at the head, each in a test container of its own (`snapwing-tests-<runId>`) with its own copy of the tree, and only after the verdict has been read. The built-in adapters give the review agent read-only tools (`claude-code`: Read, Glob, Grep, and none of the checkout's own settings, hooks or MCP servers; `codex`: the `read-only` sandbox, no `.rules` files, and a scratch `CODEX_HOME` that trusts no project config; `gemini`: read tools only), and the agent states its verdict at the end of its final message. The agent's tree leaves out the checkout's agent CLI configuration (`.claude/`, `.codex/`, `.gemini/`, `.mcp.json`), so no MCP server, hook, extension or tool command from the pull request is configured; the diff still shows any change to it. The harness gets a `SNAPWING_REVIEW_FILE` in a private directory outside the mount; once the harness has exited, the wrapper copies that file into the mount, replacing whatever is there, and exits 0. A generic review command must keep the same rule: read the checkout, never run its tests, scripts or dependencies.

## 2. Stdin

The implementation request (main 9, the XML document `schemas/implementation-request.xsd` validates), encoded as UTF-8, then end of file. For the review role it is the review request instead (`prompts/review.xml`: the request's constraints and the pull request diff). Stdin is closed after the request; a harness that waits for more input will hang until its budget ends.

## 3. Stdout: exactly one JSON object

When the process exits, stdout must hold exactly one JSON object, UTF-8, and nothing else. Leading and trailing whitespace and a leading byte order mark are tolerated. Log output belongs on stderr. The object is at most 1 MiB.

| `outcome` | Required fields | Optional fields |
|---|---|---|
| `done` | `branch` (non-empty string), `summary` (string), `testsAdded` (array of file paths, may be empty) | `prNumber` (positive integer) |
| `failed` | `reason` (non-empty string), `attempts` (integer, 0 or more) | `partialBranch` (non-empty string) |
| `stopped` | `atPhase` (one of the checkpoint phases in section 4) | none |

An optional field may be omitted or set to `null`; both mean "not given". Unknown fields are ignored. `done` means the change is committed on the work branch. The `branch` and any `prNumber` a process reports are not used: the server hands back the run's own work branch and opens the pull request itself (section 1). A `partialBranch` asks the server to keep the commits on the work branch for a person (main 10.4's draft pull request); the branch the server records is always the run's work branch.

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
```

`phase` is one of `cloned`, `branched`, `implemented`, `tested`, `pushed`, `pr-opened`, in that run order (B 9). `detail` is an optional string. Each valid line is passed to `onCheckpoint` and becomes a `POST /fixer/{workItemId}/checkpoint` event. A process reports `branched`, `implemented`, and `tested`; the runner records `cloned`, and the server records `pushed` and `pr-opened` when it has pushed the work and opened the pull request. The fixer API refuses `pushed` and `pr-opened` from a run (400), so a process that still reports them records nothing by it.

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

The process does not inherit the server's environment. It gets exactly these variables, plus model access in the last rows. It never gets a GitHub credential, in either role and on any runner (#262):

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
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0` | fixer role in a runner container: `core.hooksPath` set to the checkout's hooks in the mount |
| `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT` | `1`, the null device, and `0`: Git reads only the checkout's own config and never prompts |
| `PATH`, `LANG` | from the runner image |
| `HOME`, `TMPDIR` | a fresh, empty, private (`0700`) scratch directory per run, removed when the run ends; never the server user's home, and neither the config nor the run's environment can override them (ADR 0017). A CLI agent authenticates with its API key variable, not a login stored in a home directory |
| model access in a runner container | **no model provider key and no token ever reaches the process** (ADR 0017 amendment 1, #273). The image's wrapper serves model calls on loopback and forwards each to the server's model proxy with the run's model token, which only the wrapper holds: each CLI's base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, and `SNAPWING_MODEL_PROXY_URL`) is that loopback address, and its key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`) the placeholder `snapwing-local`. The proxy sends every call to the role's pinned model with `max_tokens` capped (section 8). Without a proxy the container has no model access |
| model access on the `local` runner (development only) | the CLI adapters copy their key and base URL variables from the server's environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and the base URL names above); never the fixer API token |

The variables exist so a wrapper script can route or log a run without parsing the implementation request.

**No GitHub credential in a run (#262).** The runner clones on the host, the process commits, and the server pushes the work branch after its checks (section 1) with a token minted for that one push, then opens the pull request as the App. The credentials the server merges and reverts with never leave the server process. A run's only tokens are its fixer API token and its model token. Only the wrapper holds them, both name the run, and both stop working when the run ends or is stopped (section 8), at the latest at the run's wall clock plus 15 minutes (`fixerTokenTtl`).

## 8. The fixer image

`infra/docker/fixer/` holds the image the `docker` runner starts (ADR 0017): `Dockerfile` and the entrypoint wrapper (`entrypoint.ts`, `wrapper.ts`). It is a slim Node image (`node:24-bookworm-slim`; Node 22.18 or later runs the wrapper's TypeScript directly) with git, tini, a non-root `snapwing` user, and the `claude` CLI. The codex and gemini CLIs are behind build args; their package names and the flags their adapters use are from memory (#150, #232), so check them against each CLI's help when enabling them.

Build it from the repository root, then point the server at it:

```sh
pnpm fixer-image:build
pnpm fixer-image:build --build-arg INSTALL_CODEX=true --build-arg INSTALL_GEMINI=true
# in the server's environment
SNAPWING_FIXER_IMAGE=snapwing-fixer:local
```

Other build args: `NODE_VERSION`, `CLAUDE_CODE_VERSION`, `CODEX_VERSION`, `GEMINI_VERSION` (each CLI defaults to its latest release). CI never builds or runs the image; `packages/app/test/unit/fixer-image.test.ts` runs the wrapper itself with fake CLIs and checks the Dockerfile statically.

**No secret is baked in.** `Dockerfile.dockerignore` filters the build context to `packages/pipeline/src` (the harness adapters and prompts the wrapper runs, the same code the `local` runner uses) and the wrapper's and relay's own files. Everything a run needs arrives at `docker run` time from the runner (`packages/app/src/providers/docker/runner.ts`): variables by name, and the run's two tokens in a credentials file.

**Credentials (#273).** The runner writes the run's fixer token and model token to `credentials.json` in a private directory of the run's own, mounted at `/run/snapwing` (`SNAPWING_CREDENTIALS_FILE`). The wrapper reads the file and removes it before any harness starts, and removes any token or model variable the container was started with, so no process in the container can read a token from a file, its environment, or another process's `/proc/*/environ`. Both tokens name the run. The server revokes them in the state store (`run_credentials`) when the fixer reports done or failed, when the runner sees its container end, when a run is stopped (before `docker stop`), and when a review run returns; a revoked token gets 401 from the fixer API and the model proxy, and a fixer token whose run is no longer the incident's running run gets 409. One run writes at most 20 artifacts and 4 MiB of them through the fixer API (413 past either).

**Network (#273).** Fixer and review containers join `SNAPWING_CONTAINER_NETWORK` (default `snapwing-runs`), a docker `--internal` network whose bridge holds no address of the host's (`com.docker.network.bridge.inhibit_ipv4`). The runner creates it when it is missing and refuses to start a run on a network that is not internal or that gives the host an address. From it a container reaches no host port, no cloud metadata service (169.254.169.254), and nothing on the internet directly. Its one way out is the relay: a `snapwing-relay` container from this image (`relay.ts`), which the runner starts on `SNAPWING_RELAY_NETWORK` (default docker's `bridge`, with `host.docker.internal` mapped to the host) and joins to the run network as `snapwing-api`. Containers reach the server at `http://snapwing-api:8080`, and the relay forwards only `/fixer/...` and `/model/...` requests to `SNAPWING_CONTAINER_API_URL` (else `SNAPWING_FIXER_API_URL`, else `SNAPWING_PUBLIC_URL`); everything else is 404. A server that runs in a container itself sets `SNAPWING_RELAY_NETWORK` to a network it is on and `SNAPWING_CONTAINER_API_URL` to its address there.

**Package registries (#273).** So a fixer can install a repository's dependencies and run its tests, the relay also serves an HTTP CONNECT proxy at `http://snapwing-api:3128` (`relay.ts`, `egress.ts`). It tunnels only to port 443 and only to hosts on the allowlist, each an exact name or `*.<suffix>` for the names under it; plain HTTP is refused, since every registry on the default list is HTTPS. The relay resolves the name itself and refuses it when any address it gets is loopback, link-local (the metadata service included), private (RFC 1918 or IPv6 ULA), shared (CGNAT), multicast, or reserved, then connects to the address it checked, so a second DNS answer cannot redirect the tunnel. Each refusal is one line on the relay's stderr (`docker logs snapwing-relay`). The default list (`DEFAULT_FIXER_EGRESS_ALLOW` in `packages/app/src/providers/docker/runner.ts`) is `registry.npmjs.org` (npm, and pnpm, yarn 1, and the pnpm and yarn 1 that corepack downloads), `registry.yarnpkg.com`, `repo.yarnpkg.com` (yarn 2 and later through corepack), `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`, `sum.golang.org`, `index.crates.io`, `static.crates.io`, `rubygems.org`, `index.rubygems.org`, `repo.maven.apache.org`, `repo1.maven.org`, and `api.nuget.org`. `SNAPWING_FIXER_EGRESS_ALLOW` (comma-separated) replaces it, and `SNAPWING_FIXER_EGRESS_ALLOW=none` turns the proxy off. A fixer container gets `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, and `http_proxy` set to the proxy, `NO_PROXY`/`no_proxy` set to `snapwing-api,localhost,127.0.0.1,::1`, and `NODE_USE_ENV_PROXY=1`, which the wrapper passes to the fixer harness, so the fixer API and the model calls on loopback never go through it. npm reads the proxy variables itself, and `NODE_USE_ENV_PROXY=1` makes Node's own `fetch` use them, which corepack needs to download pnpm and yarn (both checked in the fixer image); pip, Go, Cargo, Bundler, and NuGet read them too, by their own documentation; Maven and Gradle read proxies only from their own settings, so a Java repository needs a `settings.xml` proxy pointing at `snapwing-api:3128`. A review container never gets the proxy: its agent only reads. The runner replaces the relay when the image, the upstream, either network, or the allowlist changes. What a fixer can reach: the relay's two server paths, port 443 of the allowlisted registries, and the other fixer and review containers on the run network; nothing else.

**Test containers.** The regression proof (`runTests`) does not reuse the fixer's checkout: the fixer's `/work` is removed when its container ends, and the review job builds each tree it tests as a fresh clone of the pull request's commits (at the base with the head's tests, then at the head), so no dependencies the fixer installed are in it. Test containers have no network at all by default, so a `SNAPWING_TEST_COMMAND` that installs dependencies first fails there. `SNAPWING_TEST_EGRESS=on` puts test containers on the run network with the same registry proxy (and still no token of any kind); `SNAPWING_TEST_NETWORK` instead names a network of the operator's own, such as one with a registry mirror.

**Model spend (#273).** The model token names its run's provider (the harness's: `claude-code` Anthropic, `codex` OpenAI, `gemini` Google, `generic` the models' `default-provider`), the role's model (`<harness fixer-model="..." review-model="...">`, else Claude Sonnet 5.5, `gpt-5`, or `gemini-2.5-pro` for the provider), and the largest output one call may ask for (`<harness max-tokens>`, default 32000). The proxy refuses a call to another provider (403), sends every call to that model whatever the request names, and lowers `max_tokens`, `max_output_tokens`, `max_completion_tokens`, or `generationConfig.maxOutputTokens` to the cap (setting it when absent). It counts each call and the input and output tokens the provider reports, from JSON answers and event streams alike, in the state store, and answers 429 once a run has made 1000 calls or spent `<harness max-run-tokens>` tokens (default 50 million, cache reads included). `SNAPWING_HARNESS_MODEL` tells the wrapper the model to start the CLI with.

**What the wrapper does**, by `SNAPWING_ROLE`:

- `fixer`: the work item is in the mount: a checkout on the work branch at `SNAPWING_WORKDIR` (`/work`), with the implementation request at `.git/snapwing/implementation-request.xml` inside it. The docker runner prepares both on the host before `docker run` (`prepareWorkdir`, as the `local` runner does, #256), using an installation token for that clone only, and writes the run record (`run.json`: the repository, work branch, base, and the commit the work must build on) beside the checkout, where the container cannot reach it. The container gets three mounts, the checkout at `/work`, an empty hand-off directory at `/out`, and its credentials at `/run/snapwing`, and runs as the server's uid:gid so it can write them and the server can remove them afterwards. A directory whose container the runner never saw end (a restart, a lost daemon) is removed by the runner's `sweep` at the next server start once it is older than the fixer wall clock plus 15 minutes and no `snapwing-fixer-<runId>` container exists; the `local` runner sweeps its own `workdirRoot` the same way. The wrapper checks Stop, reports `cloned`, runs the harness named by `SNAPWING_HARNESS` with the request on stdin, posts every checkpoint to `SNAPWING_API_URL` with the fixer token from the credentials file, polls Stop after each checkpoint and every 5 seconds, and at the end posts `done` or `failed`. Before a `done` (or a `failed` with a partial branch) it writes the bundle of `SNAPWING_WORK_BRANCH` since `SNAPWING_BASE_SHA` to `SNAPWING_HANDOFF_FILE` (`/out/work.bundle`); it posts no branch and no pull request number. When the server refuses the hand-off (409 `handoff-refused`), the wrapper posts `failed` with the server's reason. A 204 from the stop poll, any other 409, or SIGTERM from `docker stop` stops the harness (SIGTERM, then SIGKILL after 8 seconds, inside docker's own grace). A run with no checkout or no request in the mount is reported `failed` without starting a harness. The harness never sees the fixer token, and nothing in the container holds a GitHub credential or can push. The checkout's `.git/snapwing/hooks` (when present) is `core.hooksPath`. `SNAPWING_PRIOR_REVIEW_FILE` is passed on when it lies in the mount. With docker the API reads the run record and the bundle from the runner's scratch directory, so the API and the worker run on one host with the same `SNAPWING_WORKDIR_ROOT`.
- `review`: the wrapper feeds `SNAPWING_REVIEW_INPUT_FILE` to the review harness on stdin, with `SNAPWING_REVIEW_FILE` set to a file in a private directory outside the mount (#263). Once the harness has finished, it copies that file, when it is a small regular file, to the mount's `SNAPWING_REVIEW_FILE`, replacing whatever is there, and exits 0; otherwise it exits non-zero, which the review job treats as `escalate`. It never calls the fixer API.
- A `generic` harness runs the command template the image keeps at `/etc/snapwing/generic/<templateId>` (one line; `SNAPWING_GENERIC_DIR` moves the directory). Server config does not reach the container, so an image that runs a generic agent is built `FROM` this one, installs the agent, and adds the template file.

**Model access.** With `SNAPWING_MODEL_PROXY_URL` and a model token in the credentials file, the wrapper listens on a loopback port and sets each CLI's base URL to it (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) and each key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`) to the placeholder `snapwing-local`; it forwards each call to the proxy with the model token in place of whatever key the CLI sent. Any model variable the container was started with, a real provider key passed by mistake included, and `GOOGLE_API_KEY` always, is removed before a harness starts and named on stderr without its value. Without a proxy or a model token, no model variable reaches the harness.

**Exit codes**: 0 done, stopped, or review verdict written; 1 the fixer reported `failed` or the review produced no verdict; 2 the container lacks its contract (unknown role, missing variables); 3 the fixer could not deliver its final report.
