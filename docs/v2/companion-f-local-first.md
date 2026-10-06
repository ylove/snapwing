# Snapwing Companion Spec F: Local-First Mode

**Status:** draft
**Read after:** the main spec, section 8.1 (triage and the scout), section 10 (the fixer), section 14.3 (the runtime providers) and section 16 (guardrails). Companion A section 6 (configuration) is the model for the XML added here.
**Naming:** Snapwing is a working title. New code takes the product name from the brand module (E8), never from a literal.

A developer runs one command on their own machine. A server starts, finds the repositories they already have cloned, reads those checkouts to write code-informed tickets, fixes bugs on a git worktree cut from the checkout (no fresh clone), pushes through the GitHub App's credentials, and, after a pull request merges, brings the checkout up to date when that is safe. Nothing in the developer's working tree changes unless it is a clean fast-forward of a branch they asked to keep current. GitHub stays the fallback for every repository without a checkout.

---

## 1. Problem and goals

### 1.1 The problem

Snapwing today works only from GitHub's copy of a repository. Three consequences:

1. **Tickets miss local truth.** The scout reads the code search API and a few files. It cannot see an uncommitted file, a variable that is set in `.env.staging` but not in `.env.production`, or what changed in the last week (`git log`, `git blame`).
2. **Every fix pays for a clone.** Each run clones the repository into a temporary directory and deletes it afterwards. For a large repository that is minutes and gigabytes per run, repeated for every incident.
3. **Nothing comes back.** After a Snapwing pull request merges, the developer's checkout stays where it was.

### 1.2 Goals

- A developer on one machine with one checkout gets a ticket grounded in that checkout, and a fix on a worktree with no clone made.
- The developer's own branch, index and working tree are never modified, except by a clean fast-forward after a merge (section 2.6 of the design).
- A fix is never based on commits that exist only on the developer's machine.
- Values of secrets never reach a model prompt, a ticket, a pull request, a log line or a thread message. Only names do.
- Push credentials stay the GitHub App's. The developer's own git credentials are never used.
- The mode degrades to today's behavior, per repository, when a checkout is missing, unusable or unregistered.

### 1.3 Non-goals

- A shared server that reaches into developers' machines. A server without access to a developer's disk reads GitHub (section 8, topology).
- Merging, rebasing, stashing or force-updating anything in a developer's checkout.
- Changing the isolation rules for untrusted code (ADR 0017): the choice of runner provider still decides where the fixer and the tests execute.

---

## 2. Today (verified)

Every row names the file it was checked in.

| Behavior today | File |
|---|---|
| `prepareWorkdir` makes the work directory from nothing: `git init`, `origin` set to a credential-free URL, a fetch of the base (and of the work branch on a retry), a checkout on the work branch. It requires the directory to be absent or empty and throws a `WorkdirError` otherwise. | `packages/pipeline/src/fixer/workdir/index.ts` |
| Everything Snapwing adds lives under `.git/snapwing/` in that directory: the `GIT_ASKPASS` script and the `commit-msg` and `pre-push` hooks. Local config disables signing, blanks `credential.helper`, and points `core.hooksPath` at the hooks directory. | `packages/pipeline/src/fixer/workdir/index.ts` |
| The installation token reaches git only as `SNAPWING_GIT_TOKEN` in the environment of the git processes, read by the askpass script. Git runs with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` set to the null device and no terminal prompts. The result's `env` gives the harness the same arrangement. | `packages/pipeline/src/fixer/workdir/index.ts`, `hooks.ts` |
| The hooks are guardrails against honest mistakes: the commit message must carry the issue key, only the work branch may be pushed, no deletion, and no change to protected paths (`.github/workflows/`, CODEOWNERS, `.github/settings.yml`). | `packages/pipeline/src/fixer/workdir/hooks.ts` |
| `RunnerPort.runFixer` starts a run and resolves when it has started; `cancel` stops it. `runTests` and `runReview` are optional and exist on providers with an isolation boundary. | `packages/pipeline/src/ports/runner.ts` |
| The `local` runner calls `prepareWorkdir` for `<workdirRoot>/<runId>`, runs the harness as a child process of the server's OS user, and removes the directory when the run ends (a failed run's directory is kept only with `keepFailedWorkdir`). A startup `sweep` removes abandoned directories. It is marked development only. | `packages/pipeline/src/providers/local/runner.ts` |
| The `docker` runner prepares the same checkout on the host, mounts that one directory at `/work`, passes no git token into the container (a credential helper in the image fetches fresh tokens from the fixer API), and removes the directory when the container is gone. | `packages/app/src/providers/docker/runner.ts` |
| The default work root is `$SNAPWING_WORKDIR_ROOT`, else `<tmpdir>/snapwing-work`, with `fixer` and `review` subdirectories. | `packages/app/src/server/compose.ts` |
| The only `RepoReader` implementation is GitHub's: code search (default 12 hits) and file contents, through an installation token limited to `contents: read`. The `RepoReader` interface has two methods, `search` and `read`. | `packages/app/src/github/repo-reader.ts`, `packages/pipeline/src/triage/scout.ts` |
| The composition root builds a GitHub reader per resolution and passes it to the scout. The scout's limits are constants (4 queries, 12 hits, 3 files, 4,000 characters). | `packages/app/src/server/compose.ts`, `packages/pipeline/src/triage/scout.ts` |
| The map's `<surface>` holds one `<repo>` element, a non-empty string. There is no element for a local path. | `schemas/workspace-context.xsd` |
| The CLI table has `serve`, `config`, `state`, `login`, `logout`, `shot`, `say`, `log`, `status`, `stop`, `map`, `token` and `onboard`. There is no `doctor`. Bare `snapwing` prints the usage and is left unclaimed on purpose. | `packages/app/src/cli/main.ts` |
| `snapwing serve` refuses `<runtime provider="local">` under `NODE_ENV=production` without `--allow-local-runner`, and prints a warning whenever it runs with the local runner. | `packages/app/src/server/serve.ts` |
| A GitHub `pull_request` webhook that closes a merged pull request becomes a `merged` event on the incident, except for merges the App itself made. | `packages/app/src/webhooks/github.ts` |
| The only redaction in the context path is for vision readings (`redactReading`). There is no general text redactor for repository content. | `packages/pipeline/src/context/vision/reading.ts` |
| Nothing reads `git log`, `git blame`, ripgrep, a file tree, dirty state or environment files. Nothing updates a checkout after a merge. | (none) |

---

## 3. Design

### 3.1 Overview

```
 snapwing (CLI)            checkout registry               RepoReader
 start, doctor      -->    repo -> [paths]      -->    GitHub reader  |  local reader
                                  |                                       (evidence: github@ | checkout@)
                                  v
                          fixer run: git worktree (local runner)  |  hardlinked clone (docker runner)
                                  |
                                  v  push via App credential helper, PR as today
                          merged event --> fetch, fast-forward only when clean, thread note
```

The mode is a property of a repository, not of the server. A repository with a usable checkout uses the local reader and a worktree; any other repository behaves exactly as today.

### 3.2 Checkout registry

Checkout paths are machine-specific, so they live in `snapwing.config.xml` (the app config, main 14.3), never in the shared workspace map.

```xml
<checkouts>
  <checkout repo="github.com/acme/web" path="~/code/web" env-files=".env.test"/>
  <checkout repo="github.com/acme/web" path="~/code/web-staging"/>
  <checkout repo="github.com/acme/api" path="~/code/api"/>
</checkouts>
```

```xsd
<xs:element name="checkouts" minOccurs="0">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="checkout" minOccurs="0" maxOccurs="unbounded">
        <xs:complexType>
          <xs:attribute name="repo" type="NonEmptyString" use="required"/>  <!-- the map's github.com/owner/name -->
          <xs:attribute name="path" type="NonEmptyString" use="required"/>  <!-- ~ and $HOME expand; stored absolute -->
          <xs:attribute name="env-files" type="xs:string"/>                  <!-- opt in, section 3.7; default none -->
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

```typescript
export interface CheckoutEntry {
  repo: string;          // owner/name, reduced from the map's github.com/owner/name (repoFullName)
  path: string;          // absolute, symlinks resolved
  envFiles: string[];    // empty unless opted in
}

export type CheckoutVerdict =
  | { usable: true; branch: string | null; clean: boolean; ahead: number; behind: number; headSha: string }
  | { usable: false; reason: 'missing' | 'not-a-repo' | 'origin-mismatch' | 'bare' | 'shallow-without-base' | 'in-progress-operation' };

export interface CheckoutRegistry {
  /** Every registered checkout of `repo`, in config order, each with a fresh verdict. */
  inspect(repo: string): Promise<{ entry: CheckoutEntry; verdict: CheckoutVerdict }[]>;
  /** The first usable and clean checkout for `repo`, or undefined: GitHub is the fallback. */
  select(repo: string): Promise<CheckoutEntry | undefined>;
}
```

A checkout is usable when its path is a non-bare git repository, its `origin` URL names the same `owner/name` (any of the https, ssh or `git@` forms), and no merge, rebase, cherry-pick or bisect is in progress. "Clean" means `git status --porcelain` is empty. A checkout with uncommitted changes is usable for reading and for creating a worktree, because a worktree cut from `origin/<base>` does not touch it. It is not eligible for pull after merge (section 3.8).

Several checkouts of one repository are allowed. Selection for reading and for fixing takes the first usable and clean one in config order; if none is clean, it takes the first usable one and the evidence says the tree is dirty.

**`snapwing doctor`** prints one line per entry with the path, the verdict, the branch, ahead and behind counts against `origin`, and the repositories in the map that have no checkout (they will use GitHub). It exits non-zero only when a registered path is unusable; a repository without a checkout is not an error. It also reports whether `rg` and `git` are on the path and whether the server's runner provider can use a worktree (section 3.6).

### 3.3 The local `RepoReader`

The scout reaches a repository only through `RepoReader` (`scout.ts`). The local reader implements the same interface, so the scout and its grounding check (the diagnosis may name only files it read) are unchanged, and adds optional capabilities that the agentic scout of the sources epic (#45) uses.

```typescript
export interface LocalRepoReader extends RepoReader {
  /** ripgrep with a regular expression and optional path globs; bounded output. */
  grep(pattern: string, options?: { globs?: string[]; maxHits?: number }): Promise<RepoSearchHit[]>;
  /** Directory listing, one level or a bounded depth, never entering .git or ignored secret directories. */
  tree(path?: string, depth?: number): Promise<TreeEntry[]>;
  /** Recent commits touching the files, newest first, bounded. */
  log(paths: string[], limit?: number): Promise<CommitSummary[]>;
  /** Who last changed each line range of a file. */
  blame(path: string, range?: { from: number; to: number }): Promise<BlameLine[]>;
  /** Branch, head sha, ahead and behind against origin, and the dirty files (paths and states only). */
  state(): Promise<CheckoutState>;
  /** Variable names only (section 3.5). */
  env(): Promise<EnvInventory>;
  /** Where every piece of evidence came from; recorded on the ticket. */
  provenance(): Evidence;
}

export type Evidence =
  | { source: 'checkout'; sha: string; dirty: boolean; ahead: number }
  | { source: 'github'; ref: string };
```

Rules:

- Search and read go through `rg` and the filesystem, with the checkout path as a fixed root. Every path argument is resolved and rejected if it escapes the root (a symlink pointing out counts). `git` and `rg` run with no shell, an argument array, a timeout and a byte cap on output.
- Search excludes `.git/`, files matched by the secret patterns of section 3.5, and, by default, paths ignored by `.gitignore` unless the path is a documented environment file (those are readable for names only, never as text).
- `read` returns the working-tree content, so an uncommitted file is visible. That is the reason local reading exists (proof (a)); the cost is that the text may not be on GitHub. The ticket therefore carries the provenance: `checkout@<sha>` plus "uncommitted changes present" or "N commits not pushed", versus `github@<default branch>`. The implementation request tells the fixer which files the diagnosis took from uncommitted or unpushed state, because the fixer starts from `origin/<base>` (section 3.6) and may not find them.
- Output caps are constants in one module (hits, bytes per file, files per run), kept at least as strict as the scout's current limits unless the agentic scout (#45) raises them with its own budget.

### 3.4 Evidence on tickets

The ticket and the implementation request gain one line per diagnosis: the `Evidence` value. A repository read through GitHub keeps today's wording. The status message and the Jira description show it as plain text. This is additive to the contracts in main section 13 (an optional field), so existing artifacts remain valid.

### 3.5 Environment variables: names only

```typescript
export interface EnvInventory {
  variables: {
    name: string;
    definedIn: string[];                 // repository-relative file names, e.g. [".env", ".env.staging"]
    setIn: Record<string, boolean>;      // per file: has a non-empty value
  }[];
}
```

- The parser reads a file, extracts `NAME=` keys and whether the value is non-empty, and drops the value in the same function. The value never becomes a field of a returned object, so a later bug cannot print it.
- Patterns for files that are names-only: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `secrets/`, `*.p12`, and any file gitignored whose name matches a secret pattern. The list lives in one module and is covered by a unit test.
- Content from any file in the checkout still passes through a text redactor before it enters a prompt, a Jira write, a pull request body, a thread message or a log line: high-entropy tokens, well-known key prefixes (provider key formats, `ghp_`, `xox`), PEM blocks and `NAME=value` pairs whose name looks secret. Today only vision readings have a redactor (section 2), so a general `redactText` is a new, shared module under `packages/pipeline/src/context/`, and every sink above is routed through it.
- A diagnosis such as "`PAYMENTS_URL` is set in `.env.staging` but not in `.env.production`" is possible from the inventory alone.

### 3.6 Worktree fixes

For a registered, usable checkout the fixer run does not clone.

```typescript
export interface PrepareWorktreeInput extends Omit<PrepareWorkdirInput, 'remoteUrl' | 'workdir'> {
  checkout: string;      // the registered path
  workdir: string;       // <workRoot>/<runId>, absent or empty
}
// Same result shape as PreparedWorkdir, plus how it was made.
export type PreparedLocalWorkdir = PreparedWorkdir & { mode: 'worktree' | 'local-clone'; checkout: string };
```

Steps, for `mode: 'worktree'`:

1. `git -C <checkout> fetch --no-tags origin <base>` (and the work branch on a retry), using the same token and askpass arrangement as `prepareWorkdir`, passed through the environment of that one process. Nothing is written to the developer's config.
2. `git -C <checkout> worktree add --no-track -b <branch> <workdir> refs/remotes/origin/<base>`. The base is always the remote-tracking ref after the fetch. A retry run checks out `refs/remotes/origin/<branch>` as `prepareWorkdir` does.
3. Enable `extensions.worktreeConfig` and write the per-run settings with `git config --worktree`: the bot identity, signing off, an empty `credential.helper`, `core.hooksPath` at the run's hooks, `push.default`. The shared `.git/config` of the developer's checkout is untouched apart from the one extension flag, which is the single permitted write, and it is documented in `doctor` output. (Decision pending in section 8 if that flag is unacceptable: the alternative is to use the hardlinked clone in every case.)
4. Put the askpass script and the hooks under the worktree's own git directory (`git rev-parse --git-dir` inside the worktree, which is `.git/worktrees/<name>`), inside a `snapwing/` directory, and apply the same hook content as `hooks.ts` (the issue key, the one allowed branch, no protected paths). The hooks module is reused unchanged.
5. Remove with `git -C <checkout> worktree remove --force <workdir>` when the run ends, including on failure and on Stop, then `git worktree prune`. The branch is left in place only while its pull request is open; a failed run that never pushed has its local branch deleted.

The developer's current branch, index and working tree are not read or written by these commands. A checkout that is mid-operation is rejected by the registry (section 3.2).

**Runner interaction.** The `local` runner (development only) runs the harness as a child process, so a worktree works as is. The `docker` runner mounts exactly one directory at `/work` and passes no credential (section 2). A worktree's `.git` is a file that points into the developer's main `.git` directory, which the container cannot see, and mounting that directory would expose the developer's whole object store, remotes and config to untrusted code. So for the `docker` runner the design uses `mode: 'local-clone'`: a local clone (objects hardlinked by default), meaning a self-contained repository whose objects are hardlinked from the checkout (fast, no network, no alternates, no remote credentials), with `origin` then reset to the credential-free GitHub URL and the base fetched. This keeps the existing mount and the existing rule that the runner exposes one self-contained directory. (Decision pending: section 8, item 2.)

**Concurrency.** Two incidents in one repository get two worktrees with distinct branches. Git serializes its own ref locks; the registry holds no lock. A run that finds the work directory in use fails with a `workdir:` reason, as today.

**Push.** Pushes go through the App credential helper exactly as today: the installation token is scoped to the repository and delivered through askpass (local runner) or the image's helper (docker runner). The developer's credential helpers, SSH agent and signing keys are not consulted; `GIT_CONFIG_GLOBAL` is the null device and `credential.helper` is blank in the worktree config.

### 3.7 Opt-in test environment files

A fresh worktree has none of the developer's untracked files, including `.env`. Repositories whose tests need configuration can opt in per checkout (`env-files=".env.test"` in section 3.2).

- Only the named files are copied, into the run's directory, and only for the test run (the regression proof of main 11.1 and the fixer's own test runs). They are not committed: the run adds them to the worktree's `info/exclude`.
- The copied values are never put in a model prompt. Test output is passed through `redactText` (section 3.5) before the fixer reads it, and the copied file's values are added to the redactor's literal list for that run, so an echo of a value is removed even when it matches no pattern.
- The names of such files must not match the production patterns: a file named `.env`, `.env.production` or `.env.prod` is rejected at config time, with a message.
- Default off. The `TestRunJob.env` of the runner port keeps its contract ("never a secret"); the copied file is a file inside the self-contained tree, not an entry in `env`.

### 3.8 Pull after merge

On the `merged` event (section 2), for each registered checkout of that repository:

1. `git fetch origin <base>` with the same token arrangement, so no developer credential is needed.
2. If the checkout's current branch is `<base>`, the tree is clean, the index is clean and `git merge-base --is-ancestor HEAD origin/<base>` holds: `git merge --ff-only origin/<base>`.
3. If `<base>` is not checked out, and the local `<base>` ref is an ancestor of `origin/<base>`: `git update-ref` the local branch forward with the old value as the expected value. A branch checked out in another worktree is not moved.
4. Otherwise fetch only, and post a thread note: "Fetched; your `main` has local changes, so it was not changed." The note names the reason: dirty, diverged, other branch checked out, in-progress operation.
5. The local fix branch, if any exists, is deleted only when it is fully merged into `origin/<base>`.

It never merges, rebases, stashes, resets or force-updates. The merge event arrives by webhook when the server has a public URL, and otherwise by the reconciler's polling (`packages/app/src/reconcile/`); the registry action is idempotent, so seeing the event twice is harmless.

### 3.9 The `npx` start

`npx <package>` with no arguments, which `main.ts` leaves unclaimed today, starts the server with the `local` provider and prints:

```
Snapwing is running at http://localhost:3000
Checkouts:  github.com/acme/web  ~/code/web  main, clean, up to date
            github.com/acme/api  (none: GitHub reads)
Webhooks:   no public URL. Slack uses Socket Mode. For Jira and GitHub events choose:
            [t] start a tunnel (cloudflared)   [p] polling only
```

- It finds checkouts from the config first. With none registered it scans for git repositories under a short list of conventional roots, shows what matches the map's repositories, and asks before writing the config; it never registers anything silently.
- A tunnel is offered, never started without consent, using `cloudflared` when installed (main 14.3 already names it); when the user declines, the reconciler's polling covers Jira and GitHub events.
- The command refuses to start the production-like configuration of the local runner under `NODE_ENV=production`, as `serve` does.
- `snapwing serve` keeps its meaning. The bare command is a thin wrapper that composes `doctor`, `serve` and the tunnel prompt.

---

## 4. Interactions with existing specs

- **Main 8.1 (triage, scout):** the local reader implements the existing `RepoReader`; the grounding check is unchanged. The agentic scout is #45's design and consumes `LocalRepoReader`'s extra methods when present.
- **Main 10.2 (permissions):** unchanged. The fixer still pushes one branch to one repository through a scoped token, never merges, and the hooks still block the base and protected paths. A worktree adds no permission.
- **Main 10.4 (stop):** a Stop removes the worktree at the next checkpoint (section 6).
- **Main 14.3 (runtime):** the `local` provider keeps its table row. Local-first adds the registry, a reader and a workdir mode; the runner port is not changed, but the two runners call a new `prepareLocalWorkdir` when `select(repo)` returns an entry.
- **Main 16 (security):** the "Agent blast radius" and "Secrets" rows hold. New rows are added in section 5.
- **Companion A section 6:** the XML in section 3.2 follows its conventions; `snapwing config check` validates it.
- **ADR 0017 (runner isolation):** the isolation boundary stays the runner provider. The decision to use a hardlinked clone instead of a worktree under `docker` exists to keep that boundary.
- **E13 (dry run):** a dry run's patch is stored and applied byte for byte on a clean tree; the worktree path produces the same patch from the same base.

---

## 5. Security and privacy

| Concern | Control |
|---|---|
| The developer's uncommitted work | Fixer runs from `origin/<base>` in a separate directory. Registry operations that write to the checkout are limited to the worktree commands of section 3.6 and the fast-forward of section 3.8. Proof (b) compares the tree byte for byte. |
| Secret values | Names only for environment files (section 3.5). A text redactor guards every sink. The planted-secret test of proof (a) checks prompts, tickets, pull request bodies, logs and thread messages. |
| Credentials | Pushes use the App's installation token only. The developer's credential helpers, SSH agent, signing keys and global git config are switched off for every git process Snapwing starts. |
| Path escape | The reader resolves every path against a fixed root and rejects symlinks that leave it. No shell, argument arrays only. |
| Untrusted code | Unchanged: the local runner is development only and the docker runner is the boundary. The docker runner never mounts a developer's `.git` directory. |
| Hostile repositories | A checkout's own hooks, `core.fsmonitor`, `core.sshCommand` and `include` config could run code when git reads it. Every git process runs with `-c core.fsmonitor= -c core.hooksPath=<ours>` and the system and global config off; `doctor` warns when the checkout's local config sets any of `core.fsmonitor`, `core.sshCommand`, `core.pager` or `include.path`. |
| Data retention | The reader returns bounded excerpts that enter prompts exactly as today. Nothing from a checkout is stored beyond the artifacts the pipeline already stores, and those are redacted. |
| Who can start a fix | Unchanged (main 16): only engineers. A fix on a developer's machine is still the developer's own server. |

---

## 6. Failure and degradation

| Situation | Behavior |
|---|---|
| No checkout registered, path missing, `origin` mismatch, mid-operation | The repository uses GitHub reads and a fresh clone, as today. The ticket's evidence says `github@<ref>`. `doctor` names the reason. |
| `rg` missing | The reader falls back to `git grep` for tracked files and reports the reduced coverage in the evidence line. |
| Dirty or ahead checkout, scout | Reads the working tree and flags provenance (section 3.3). The fix still starts from `origin/<base>`. |
| Fetch fails (no network, token) | The run fails with a `workdir:` reason as today and the thread says so. No stale base is used silently. |
| Worktree add fails (branch exists locally, lock) | The run falls back to the clone path once and records why; a second failure fails the run. |
| Stop, crash, restart | The worktree is removed with `worktree remove --force` and `prune`. A startup sweep (as `sweepScratch` does for directories) also prunes worktrees under the work root that belong to no known run, and runs `git worktree prune` in each registered checkout so a deleted directory leaves no dangling entry. |
| Checkout dirty at merge time | Fetch only, thread note (section 3.8). |
| Several checkouts, none clean | The first usable one is read and the evidence says dirty; fixes still use a worktree. |
| Server on another machine | No registry entries resolve (paths do not exist there), so everything uses GitHub (section 8, item 1). |

---

## 7. Contracts (additions)

```typescript
export interface TicketEvidence { source: 'checkout' | 'github'; ref: string; dirty?: boolean; ahead?: number; usedUncommitted?: string[] }
// optional on the triage resolution plan and the implementation request (main 13)

export type LocalFirstEvent =
  | { type: 'checkout-fetched'; repo: string; path: string; sha: string }
  | { type: 'checkout-fast-forwarded'; repo: string; path: string; from: string; to: string }
  | { type: 'checkout-not-updated'; repo: string; path: string; reason: 'dirty' | 'diverged' | 'other-branch' | 'in-progress' | 'worktree-elsewhere' };
```

These are events in the incident log (B 4) so the status message and the thread note read from one source. No event carries a path outside the registered checkout, a file's content or a variable value.

---

## 8. Open decisions

1. **Topology.** Decision pending: where the server runs relative to checkouts. Tracked in #156, which is open. Options: (a) one server per developer, on their machine, using their checkouts; (b) one shared server with a checkout set per developer, which needs a way to identify whose checkout a fix uses and who receives pull after merge; (c) both, with a shared server falling back to GitHub reads. **Recommendation:** (a), with (c)'s fallback: a shared server never reads a developer's disk, uses GitHub reads and fresh clones, and ignores the registry. The rest of this document assumes (a).
2. **Docker isolation of the object store.** Decision pending: for the `docker` runner, a worktree cannot be mounted without exposing the developer's `.git`. Options: hardlinked local clone (self-contained, recommended, section 3.6); mount the common git directory read-only (git cannot write objects, so commits fail); refuse worktree mode under `docker` and use fresh clones. **Recommendation:** hardlinked local clone.
3. **Never base a fix on unpushed commits.** The default is `origin/<base>` after a fetch, because a pull request must build on what reviewers can see. Decision pending: whether an engineer may opt in, per fix, to a local base. **Recommendation:** no opt-in in this version; the evidence line tells the fixer when the diagnosis relies on unpushed state, and the thread says the fix may not reproduce it.
4. **Several checkouts of one repository.** Decision pending: the selection rule. **Recommendation:** allowed; the first clean one in config order wins; all registered checkouts receive pull after merge.
5. **Shared config flag.** Decision pending: whether `extensions.worktreeConfig` on a developer's repository is acceptable. **Recommendation:** accept it, report it in `doctor`, and offer the hardlinked clone as a registry option (`mode="clone"`) for those who object.
6. **Discovery scan.** Decision pending: whether the `npx` start scans for repositories or requires the config. **Recommendation:** scan a short list of roots and ask before writing.

---

## 9. Acceptance

| id | Behavior | Tier |
|---|---|---|
| F-1 | The registry config validates against the XSD; a missing `repo` or `path`, or a production-like `env-files` name, is rejected | unit |
| F-2 | `inspect` reports usable, branch, clean, ahead and behind for a normal checkout, and each unusable reason (missing, not a repo, origin mismatch, bare, in-progress operation) | unit |
| F-3 | `origin` forms (https, ssh, `git@`) all match `owner/name` | unit |
| F-4 | `select` returns the first usable clean checkout in config order; none clean returns the first usable with dirty evidence; none usable returns undefined | unit |
| F-5 | `snapwing doctor` prints one line per entry and the unregistered repositories, and exits non-zero only for a registered, unusable path | unit |
| F-6 | The local reader's `grep`, `tree`, `log` and `blame` return bounded results on a fixture repository, with no shell and capped output | unit |
| F-7 | A path that escapes the root, by `..` or a symlink, is rejected by every reader method | unit |
| F-8 | The local reader satisfies the same `RepoReader` contract tests as the GitHub reader | contract |
| F-9 | `read` returns an uncommitted file; the evidence line states `checkout@<sha>` with uncommitted changes | unit |
| F-10 | The environment inventory reports names, defining files and set or unset per file; a planted value appears nowhere in the returned object | unit |
| F-11 | Files matching the secret patterns are never returned as text by `read` or `grep` | unit |
| F-12 | `redactText` removes planted tokens, PEM blocks and secret-named pairs; every sink (prompt, Jira write, PR body, thread message, log line) calls it | unit |
| F-13 | `prepareLocalWorkdir` in worktree mode creates the branch from `origin/<base>` after a fetch and applies the bot identity and hooks to the worktree only | unit |
| F-14 | After worktree creation and removal, the checkout's HEAD, index, working tree and shared config are unchanged (except the documented extension flag) | unit |
| F-15 | A fix never starts from a local commit that is not on `origin/<base>` | unit |
| F-16 | Under the `docker` runner a run mounts one self-contained directory with no path into the developer's `.git` | contract |
| F-17 | The hooks block a commit without the key, a push to the base and a protected-path change in a worktree, as in a clone | unit |
| F-18 | Pushes use the App credential only: a checkout whose global and local config name another credential helper still authenticates as the App | unit |
| F-19 | Opt-in env files are copied for test runs only, excluded from commits, and absent unless configured | unit |
| F-20 | Test output is redacted, including the literal values of copied files, before the fixer reads it | unit |
| F-21 | On `merged`, a clean checkout on the base is fast-forwarded | unit |
| F-22 | On `merged`, a dirty, diverged, other-branch or mid-operation checkout is fetched only and the thread note names the reason | unit |
| F-23 | The merged-event handler is idempotent and never merges, rebases, stashes or resets | unit |
| F-24 | The fully merged local fix branch is deleted; an unmerged one is kept | unit |
| F-25 | Stop mid-fix, a failed run and a server restart leave no worktree and no dangling worktree entry | unit |
| F-26 | The bare command prints the URL and the checkouts found, offers a tunnel or polling, and starts nothing without consent | unit |
| F-27 | A repository without a usable checkout behaves as today (GitHub reads, fresh clone) | contract |
| F-28 | Proof (a): a level 0 ticket explainable only by an uncommitted file or an environment difference names the right file and variable, and a planted fake secret appears in no prompt, ticket, PR or log | e2e |
| F-29 | Proof (b): a level 2 fix runs from a worktree while the developer has uncommitted work on another branch; the tree is byte-for-byte unchanged afterwards | e2e |
| F-30 | Proof (c): after merge, a clean local base is fast-forwarded and a dirty one is only fetched with a thread note | e2e |
| F-31 | Proof (d): Stop mid-fix leaves no worktree behind | e2e |
| F-32 | On a machine with one checkout, a Slack report yields a fix on a worktree and a pull request with no clone made | e2e |
| F-33 | The same flow against a real private repository with a real GitHub App installation | live |

---

## 10. Test plan

- **Unit:** the registry, the origin matcher, the reader methods, path confinement, the inventory parser, the secret-pattern list, `redactText`, worktree preparation and removal on temporary repositories (a bare "remote" plus a clone, as the workdir tests do), the fast-forward decision table, and the config XSD. Git runs for real against temporary repositories; nothing mocks git.
- **Contract:** the `RepoReader` suite run against both readers; the runner suite checking that `docker` mounts a single self-contained directory; the fallback path for repositories without a checkout.
- **Live:** one run against a real private repository and a real App installation (F-33), in the live tier of main 14.4, using the fixture repository of the test setup epic.
- **E2E:** proofs (a) to (d) and F-32 on the in-process stack with mocked Slack, Jira and a local bare repository standing in for GitHub. The planted-secret check scans the model request log, the Jira write log, the pull request body, the thread messages and the server log.

---

## 11. Delivery sequence

E4 (#48) has no task issues yet. The tasks below are proposed, one pull request each, with non-overlapping touches. The task numbers are placeholders until the issues are filed (F-T1 to F-T8). The first four are independent and can run in parallel.

| Task | Content | Touches | Depends on |
|---|---|---|---|
| F-T1 (missing) | Checkout registry, config XML and XSD, origin matcher, `snapwing doctor` | `packages/pipeline/src/checkouts/`, `packages/app/src/cli/doctor.ts`, `schemas/app-config.xsd`, one row in `cli/main.ts` | none |
| F-T2 (missing) | Local `RepoReader`: ripgrep, tree, log, blame, state, path confinement, `Evidence`, contract suite | `packages/app/src/local/repo-reader.ts` | F-T1 for `select` |
| F-T3 (missing) | Secret handling: environment inventory, secret patterns, `redactText` and its routing to every sink | `packages/pipeline/src/context/redact.ts`, `packages/app/src/local/env-inventory.ts` | none |
| F-T4 (missing) | `prepareLocalWorkdir`: worktree and hardlinked-clone modes, per-worktree config, hooks reuse, removal and sweep | `packages/pipeline/src/fixer/workdir/local.ts` | F-T1 |
| F-T5 (missing) | Runner wiring: the `local` and `docker` runners choose the local workdir when a checkout is selected; Stop and failure cleanup | `packages/pipeline/src/providers/local/runner.ts`, `packages/app/src/providers/docker/runner.ts` | F-T4 |
| F-T6 (missing) | Opt-in test env files and test output redaction | `packages/pipeline/src/review/` test-run path, config attribute | F-T3, F-T5 |
| F-T7 (missing) | Pull after merge and thread notes, events | `packages/app/src/local/pull-after-merge.ts`, one handler registration | F-T1 |
| F-T8 (missing) | The bare `npx` start: URL, checkouts, tunnel or polling prompt | `packages/app/src/cli/start.ts`, `cli/main.ts` | F-T1 |
| F-T9 (missing) | Proofs (a) to (d) and F-32, F-33; the "How to try it" steps | `packages/app/test/e2e/`, `test/live/` | F-T2, F-T5, F-T6, F-T7, F-T8 |

F-T5 and F-T6 each touch a runner file and must not run in the same wave as another task that edits that file. The sources epic's agentic scout (#45) consumes F-T2 and is tracked there; it needs no change to this document except the optional methods of section 3.3.
