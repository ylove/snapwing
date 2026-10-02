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

**The `local` runner is for development only (ADR 0017).** It starts the command as a child process on the server's host, as the server's own OS user, so the command can read any file that user can. Every adapter gives the process a fresh, empty scratch `HOME` and `TMPDIR` (section 7) and refuses a working directory in or above the server's own tree, but that is not a boundary. Any deployment that holds real secrets runs harnesses inside the `docker` provider or another container or VM provider; `snapwing serve` refuses `<runtime provider="local">` when `NODE_ENV=production` unless `--allow-local-runner` is passed, and warns whenever it starts with it.

The checkout (`packages/pipeline/src/fixer/workdir/`) is already on the work branch: `handoff/@branch`, else `fix/` plus the issue key, cut from `handoff/@base` (else the repository's default branch), or the existing remote branch on a retry. Commits carry the bot identity. Two hooks are installed: `commit-msg` rejects a message without the issue key, and `pre-push` rejects a push to any ref but the work branch and a branch whose diff against the base touches `.github/workflows/**`, `CODEOWNERS`, or `.github/settings.yml`. The hooks catch mistakes; the token's scope and branch protection are the boundary. Everything Snapwing adds lives under `.git/snapwing/`, outside the worktree.

The command template is split into an argument vector (whitespace separated, double quotes respected) and executed without a shell. Snapwing never interpolates incident text into the command line; the incident reaches the process only through stdin.

The harness process never talks to the Snapwing database or the fixer API. The wrapper in the container that starts it holds the short-lived fixer token (B 9), posts checkpoints and the result to the fixer endpoints, and polls for Stop.

## 2. Stdin

The implementation request (main 9, the XML document `schemas/implementation-request.xsd` validates), encoded as UTF-8, then end of file. Stdin is closed after the request; a harness that waits for more input will hang until its budget ends.

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

The process does not inherit the server's environment. It gets exactly these variables, plus the secrets in the last row:

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
| `SNAPWING_PRIOR_REVIEW_FILE` | fixer retry runs only: absolute path of the `review` artifact of the `request-changes` verdict that caused the retry (JSON, main 11.1), under `.git/snapwing/` so no commit can include it. Absent on a first run |
| `GIT_ASKPASS`, `SNAPWING_GIT_TOKEN` | the Git credential for the one repository: `git push` and `git fetch` in the checkout authenticate through the askpass script, which answers with `SNAPWING_GIT_TOKEN` (a GitHub App installation token). The token is in no file, remote URL, or Git config |
| `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT` | `1`, the null device, and `0`: Git reads only the checkout's own config and never prompts |
| `PATH`, `LANG` | from the runner image |
| `HOME`, `TMPDIR` | a fresh, empty, private (`0700`) scratch directory per run, removed when the run ends; never the server user's home, and neither the config nor the run's environment can override them (ADR 0017). A CLI agent authenticates with its API key variable, not a login stored in a home directory |
| model and Git credentials | only those the harness needs, from the secrets port under their conventional names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, main 14.5) and a Git credential scoped to the one repository; never the fixer API token |

The variables exist so a wrapper script can route or log a run without parsing the implementation request.
