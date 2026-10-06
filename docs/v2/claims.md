# Claims ledger

Every claim the README makes is listed here with its evidence. Engineering facts only: business claims (pricing, hosting) stay out of the README until they are decided.

**Status words:**
- **Shipped:** merged on `main` and proven by a passing test or proof run, as stated.
- **In progress:** being built in an open phase or epic.
- **Planned:** everything else.

**Evidence references:** the first 196 pull requests were merged in a private build repository. The history here keeps each one as a commit whose title ends with "(build PR N)", so `git log --grep "build PR 277"` finds it. "Build issue N" is a task in that repository. Test files are linked from this repository.

**How to check a README change:** every new or changed claim gets a row here in the same pull request, and its status matches the evidence on the day it merges. A claim with no row is removed from the README.

## README tier 1 (checked 2026-10-05)

### What it does and how it works

| Claim | Status | Evidence |
|---|---|---|
| A 🐛 reaction on a Slack message starts a report; Snapwing reads the whole thread, screenshots included | Shipped | Context collection (build PR 102), vision pass (build PR 103), Slack adapter (build PRs 181, 349); live in [`levels.test.ts`](../../packages/app/test/e2e/levels.test.ts) |
| It checks for duplicates | Shipped | Dedupe before create (build PR 110); dedupe card handled in the live e2e |
| It works out the product area and its code from a workspace map | Shipped | Resolution confidence stack (build PR 104), workspace-context schema (build PR 52) |
| It asks one question back only when it has to | Shipped | Ask-back gate (build PR 109) |
| It files a Jira ticket that names the likely code, with a structured request a coding agent can act on | Shipped | Triage with a read-only scout (build PR 111), ticket synthesis and implementation prompt (build PR 112), Jira projector (build PR 178); fields asserted in the live e2e |
| A coding agent writes the fix in a throwaway container | Shipped (built and tested) | Docker runner (build PR 212), fixer image (build PR 257), work item in the mount (build PR 262). The live e2e runs the fixer with the local runner, not the container |
| A separate review agent checks it | Shipped (built and tested) | Review prompt and verdict (build PR 188), review job (build PR 221), review in the docker runner (build PRs 241, 246). The live e2e uses a scripted reviewer |
| A pull request opens, and the status message in the thread is kept up to date | Shipped | Status loopback (build PR 189), Slack status projector (build PR 196); live in `levels.test.ts` |

### The autonomy dial

| Claim | Status | Evidence |
|---|---|---|
| Four levels, 0 to 3, with the behavior in the README table | Shipped | Autonomy policy (build PR 100), `pnpm demo` runs all four levels against mocked services (build PR 120); levels 1 and 2 live in `levels.test.ts` |
| Set per channel, component and priority; the most restrictive match wins | Shipped | `packages/pipeline/src/policy/autonomy.ts` (build PR 100) |
| Stop on every card and status message at levels 2 and 3 | Shipped | Slack interactivity, Stop (build PR 194), fixer Stop (build PR 167) |
| A failed gate at level 3 drops the incident to level 2 and says why | Shipped (built and tested) | Merge step, autopilot and Revert (build PR 199), merge risk gate (build PR 187) |
| Who changed a level, and when, is recorded | Shipped | Map: who changed an autonomy level (build PR 414) |

### What works today

| Claim | Status | Evidence |
|---|---|---|
| Slack 🐛 to Jira ticket to the fixer's pull request, status updated, at levels 1 and 2: passes automated live tests against real Slack, Jira and GitHub sandboxes | Shipped | [`levels.test.ts`](../../packages/app/test/e2e/levels.test.ts) (build PR 277), phase 3 proof passed 2026-10-02; passed again in the phase 4 proof run, 8 of 8, 2026-10-03 (build PR 358) |
| An engineer's 👀 claims the bug, the ticket is assigned to them, no fixer starts | Shipped | [`companion-a.test.ts`](../../packages/app/test/e2e/companion-a.test.ts), claim hold row (build PRs 358, 361) |
| A pile of 🔥 reactions escalates: top priority, owner mentioned, monitoring on | Shipped | `companion-a.test.ts`, escalation row. Two of the five reactions are real test users; three are Slack payloads for people in the test map |
| A status question in a direct message gets a plain-language answer | Shipped | `companion-a.test.ts`, status pull row (answered under 1 s) |
| A staging screenshot is checked with the reporter before filing | Shipped | `companion-a.test.ts`, user-side check row |
| After a staging deploy, the reporter's 👍 marks the fix verified | Shipped, with scripted stand-ins for the coding and review agents | `companion-a.test.ts`, staging verification row (level 3) |
| Level 0 and level 3 built; tested against mocked services; the level 3 merge has run live only with scripted stand-ins | Shipped as stated | `pnpm demo` (build PR 120), merge step (build PR 199), staging verification row |
| The coding agent's container holds no model API keys and gets short-lived tokens for one run | Shipped (built and tested) | Model proxy keeps provider keys out of containers (build PR 246), fresh git tokens from the fixer API (build PR 267), per-work-item tokens (build PR 172) |
| The coding agent can't change CI or branch protection | Shipped (by permission) | The GitHub App has no `workflows` permission, so GitHub rejects a push that changes `.github/workflows/`, and only read access to administration ([`manifests/github-app.json`](../../manifests/github-app.json)). The fixer's git hooks also stop such edits early, as a guardrail rather than the boundary (build PR 201). The fixer never merges |
| Pluggable coding agents: Claude Code, Codex, Gemini CLI, or any command | Shipped (built and tested) | Generic harness (build PR 57), Claude Code (build PR 61), Codex and Gemini (build PR 224), harness contract suite (build PR 70) |
| Pluggable model providers: Anthropic, OpenAI, Google | Shipped (built and tested) | Build PRs 66, 64, 65; contract suite (build PR 77) |
| Microsoft Teams: in progress, tested against mocks only | In progress | Teams adapter pieces (build PRs 412 to 438); no live Teams tenant in the v1 build |
| CLI, Raycast extension, guided `snapwing onboard`: in progress | In progress | CLI (build PRs 430, 433), Raycast (build PR 429), onboarding engine (build PR 435); the phase 5 proof has not run |
| In the live tests, the review agent is a scripted stand-in, and the coding agent is Claude Code or a scripted stand-in | Fact about the tests | Header comments of `levels.test.ts` and `companion-a.test.ts` |
| Every live run so far was driven by test scripts and agents | Fact on 2026-10-05 | Update this row and the README after the first hands-on run |

### What's coming

Every item in the README's "What's coming" list is **planned**. Each becomes a public epic issue in this repository; its README entry moves to "in progress" when the epic opens and to "shipped" when the epic's proof passes.

### How it's being built

| Claim | Status | Evidence |
|---|---|---|
| Tasks are GitHub issues with spec sections, files they may touch, and acceptance criteria | Fact | The build repository's issues; the same shape is used for issues here |
| An orchestrator agent merges only when the full suite passes on SQLite and Postgres | Fact | CI matrix since phase 0; a local run of the same suite while hosted CI minutes were exhausted (2026-10-03 to the move to this repository) |
| First commit October 1, 2026 | Fact | `git log --reverse` |
| 196 pull requests merged as of October 5, 2026 | Fact | `gh pr list --state merged` on the build repository, 2026-10-05 |
| Phases 0 to 4 complete, phase 5 in progress, phase 6 next | Fact on 2026-10-05 | Phase 3 proof (build PR 277), phase 4 proof (build PR 358) |
