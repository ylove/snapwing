# Snapwing Companion Spec E: Coexistence with Other Agents, and Operating at Scale

Snapwing files a bug and, at levels 2 and 3, starts its own fixer within seconds. Two situations break that today. First, another coding agent (Copilot, Claude, Codex, Devin, Cursor, Jules) may already have the work, and Snapwing cannot see it because every bot author is dropped at the door. Second, a bad deploy produces ten reports in a minute: three of them describe one bug, the fixers they start are unbounded, and no model call is counted. This document specifies both halves. Part 1 adds an agent registry, agent claims, a collision check before a fixer starts and before it pushes, a hand-off port that sends work to another agent on purpose, the same review and status loop for that agent's pull request, and a loop guard. Part 2 adds in-flight dedupe and burst detection, fixer caps with a durable queue, a usage and cost ledger with daily caps, a kill switch, admin views, CLI commands and telemetry.

**Status:** draft
**Read after:** the main spec, Companion A and Companion B. This document extends main 6, 10, 11, 12, 14 and 17, A 1.4, A 2 and A 4, and B 3, B 5 and B 9, and uses their vocabulary.
**Naming:** "Snapwing" is a working title. New code takes the product name from the brand module (E8, #52); copy below writes `{product}` where the name appears. In this document "an agent" or "a coding agent" is another vendor's coding agent; the running system is "the product". The built-in fixer is the fixer of main 10, whatever harness runs it (main 14.5).

---

## 1. Problem and goals

### 1.1 Coexistence (Part 1, epic #47)

Teams now run several coding agents at once. An issue gets assigned to Copilot, someone mentions `@claude` on a pull request, a Jira automation hands new bugs to an agent's account. When the product files a ticket and starts its own fixer on the same bug, two fixes race, reviewers see two pull requests for one ticket, and the pinned status message reports the built-in fixer while the real fix is somewhere else.

Goals:

- **G1, notice.** Recognize a registered agent's pull request, branch or assignment on an incident's key, from GitHub and Jira.
- **G2, yield.** When an agent has the work, file the ticket without starting the built-in fixer and say who is on it, in one line.
- **G3, report honestly.** Link the agent's pull request in the thread, record its merge, and move the status like any other pull request.
- **G4, hand off on purpose.** Per surface, send the work to a chosen agent instead of the built-in fixer, and put that agent's pull request through the same review, merge gate and status loop.
- **G5, no loops.** No bot ping-pong, no re-triage storms, no reading the product's own writes back as someone else's claim.

### 1.2 Scale (Part 2, epic #49)

Many reports at once must stay safe and affordable.

- **G6, one incident per bug.** Reports of the same bug that arrive together become one incident with several reporters.
- **G7, see a burst.** Several different reports about one surface in a short window raise a "possible outage" card that feeds the A 1.4 ladder.
- **G8, bounded fixers.** At most a configured number of fixers run, globally and per repository; the rest wait in a durable queue, ordered by priority, with their position shown.
- **G9, every model call counted.** Each call is recorded with its token usage; an incident has a cost; daily soft and hard caps exist, and the hard cap degrades to ticket-only.
- **G10, one switch.** An authorized person pauses intake, fixers or autopilot, or stops every run, from Slack, App Home or the CLI, and it takes effect within one event.
- **G11, see it.** An App Home "Workspace" section, an ops digest, `runs`, cost in `trace`, spend in `metrics`, and telemetry (spans, JSON logs, Prometheus metrics) with export off unless configured.

### 1.3 Non-goals

- Driving another agent's internals. The product talks to an agent only through the hand-off (3.6) and one mention when a review asks for changes (3.7).
- Counting another vendor's agent usage. Only calls the product makes, or forwards through its model proxy, are in the ledger.
- Autoscaling runners. Caps bound concurrency; capacity is the operator's.
- Embedding similarity for dedupe (still open in main 17).
- A new user interface beyond App Home, cards, the CLI and the console pages already scoped in main 20.3.

---

## 2. Today (verified)

Each statement was checked against the code on `main` and names its file. Paths are relative to `packages/` unless they start with `schemas/`, `manifests/` or `docs/`.

### 2.1 Coexistence

| Fact | File |
|---|---|
| Human claims are complete: `claimState` folds the log, an engineer's `claimed` before the first `fixer-started` holds the fixer, `let-agent-take` and `released` end it | pipeline/src/engine/claims.ts |
| A claim after the fixer started posts the A 2.2 card and a grace timer; nothing aborts | pipeline/src/fixer/claims.ts |
| Environment holds and claim expiry run on durable timers | pipeline/src/signals/holds.ts |
| `isPerson` returns false for a user whose `type` is `Bot`, whose login ends in `[bot]`, or whose login is the App's, so an agent's pull request never produces `pr-opened`, and a merge by a bot is appended with no actor | app/src/webhooks/github.ts |
| A pull request maps to an incident by the Jira key in its head branch only (`incidentByBranch`); the title and body are not read | app/src/webhooks/github.ts |
| The webhook handles `pull_request`, `deployment_status`, `check_suite`, `check_run` and `status`. The manifest subscribes to those and to `pull_request_review` (not handled), and has no Issues permission and no `issues` or `push` subscription | app/src/webhooks/github.ts, manifests/github-app.json |
| The GitHub client reads one pull request, its files, combined status and comparisons; it cannot list open pull requests, branches or issues | app/src/github/client.ts |
| `merged` is a valid transition only from `mergeable` and `held`. A pull request the product did not review (a person's) moves the incident to `in-review`, and its merge is appended but leaves the status at `in-review` | pipeline/src/lifecycle/machine.ts |
| The review job starts only from the fixer API's done hook, so no pull request but the built-in fixer's is reviewed | pipeline/src/review/job.ts |
| The workspace map has no notion of agents (people, channels, surfaces, triggers, vocabulary, policies) | pipeline/src/map/types.ts, schemas/workspace-context.xsd |
| Event actor roles are `engineer`, `reporter`, `unknown` and `human`; the event source `agent` already means the product itself | pipeline/src/contracts/events.ts, pipeline/src/contracts/incident.ts |
| A Jira change made by the product's own account is an echo and appends nothing; a person's assignee change appends `jira-assignee-changed` with the changelog's `from` and `to` | app/src/webhooks/jira.ts |
| Slack messages are classified `own`, `bot` or `person`; only people's messages feed signals | app/src/adapters/slack/authorship.ts |
| `runFixerJob` refuses on a stop, a claim hold, a run still going, an attempt already run, or an instructions hold. There is no collision check and no hand-off | pipeline/src/fixer/job.ts |
| The fixer polls `GET /fixer/{id}/stop` between phases (B 9) | pipeline/src/fixer/stop.ts |
| The implementation request already has a `<handoff mode autonomy branch base>` element. It describes how the built-in fixer delivers, and is unrelated to the hand-off in 3.6 | schemas/implementation-request.xsd |
| Harness adapters (`claude-code`, `codex`, `gemini`, `generic`) run a coding agent inside the product's own runner; they are not another vendor's agent working in its own environment | pipeline/src/config/app-config.ts, pipeline/src/ports/harness.ts |

### 2.2 Scale

| Fact | File |
|---|---|
| Dedupe runs after resolution: Jira JQL, then the recent-incidents cache keyed by surface, component and an exact summary hash | pipeline/src/dedupe/index.ts, pipeline/src/engine/steps.ts (`dedupeStep`) |
| `rememberIncident` runs only in `afterFiledStep`, after filing, so two in-flight reports of the same bug do not see each other | pipeline/src/engine/steps.ts |
| No fingerprint exists at capture; `captureStep` appends `captured` only. The flow parks on the scope preview before resolution | pipeline/src/engine/steps.ts |
| The cache port has `get`, `set` and `setIfAbsent`; it cannot list keys or delete one | pipeline/src/ports/cache.ts |
| The A 1.4 reaction ladder counts unique reactors on one incident; nothing correlates reports across messages | pipeline/src/signals/score.ts |
| A worker runs one job per job name by default (`DEFAULT_CONCURRENCY = 1`, also used by the pg-boss workflow), and `fixer.run` is registered without a concurrency option | pipeline/src/workflow/inprocess/policy.ts, pipeline/src/workflow/pgboss/index.ts, pipeline/src/fixer/job.ts |
| `RunnerPort.runFixer` resolves once the run has started, not when it ends, so the job returns and the next fixer starts: running fixers are unbounded | pipeline/src/ports/runner.ts, pipeline/src/fixer/job.ts |
| Results carry optional `usage` (`ModelResultMeta`); the router never reads it and nothing stores it | pipeline/src/ports/model.ts, pipeline/src/models/router.ts |
| The model proxy forwards calls with a per-run request cap of 1000, counted in memory; it reads no token usage | app/src/model-proxy/routes.ts |
| `/healthz` and `/metrics` exist; metrics are outbox depth and age, parked jobs, and reconciler corrections | app/src/server/ops.ts |
| App Home shows an engineer's queue (assigned, fixing now, waiting on you, recently merged) or a reporter's own reports | app/src/adapters/slack/home.ts, app/src/status/queue.ts |
| `stopIncident` exists for one incident; the CLI has `status` and `stop` but no `trace`, `runs` or `metrics` (`trace` and `metrics` are in progress under #4) | pipeline/src/fixer/stop.ts, app/src/cli/main.ts |
| Logs are plain `info` and `error` lines; there is no OpenTelemetry dependency | app/src/server/compose.ts (`ComposeLog`) |
| Playbook digests exist (`<digest to cron>`), one cron job each | pipeline/src/notify/digest.ts |
| There is no workspace time zone; the only zone in config is the playbook's `quietHours tz` | pipeline/src/config/playbook.ts |
| The map has no admin flag (#133 adds one) | pipeline/src/map/types.ts |
| Migrations run up to `0006` | pipeline/src/state/migrations/ |
| The console package is an empty placeholder | console/src/index.ts |

---

## 3. Part 1: coexistence with other agents

### 3.1 The agent registry

The workspace map gains an optional `<agents>` element after `<people>`. Each `<agent>` has an id, a display name, a mode, and one or more identities. An agent without any identity is invalid.

```xml
<agents useDefaults="true" recentPush="PT24H">
  <!-- An entry with a default's id replaces that default (3.2). -->
  <agent id="example-fixer" name="Example Fixer" mode="handoff-target">
    <github login="example-fixer[bot]"/>
    <jira accountId="example-account-id"/>
    <slack userId="U0EXAMPLEBOT"/>
    <handoff via="webhook" url="https://fixer.example.com/hooks/incoming" secret="HANDOFF_EXAMPLE_SECRET"/>
  </agent>
</agents>
```

**Modes.** What a mode means at run time:

| Mode | A claim on the incident's key | Can receive a hand-off (3.6) | Its pull request is reviewed (3.7) |
|---|---|---|---|
| `yield` (default) | Holds the built-in fixer and files ticket-only, like an engineer's claim (A 2.1) | No | No: the status follows the pull request and its merge |
| `coordinate` | Holds, as `yield` | No | Yes: review, merge gate, status loop |
| `handoff-target` | Holds, as `yield` | Yes, when a surface names it | Yes |

Delivery is staged: #96 implements `yield`; `coordinate` and `handoff-target` are parsed and recorded and hold nothing until 3.7 lands, and a test pins that so the change is deliberate.

**Identity matching.**

- **GitHub:** the login from the signed webhook, compared case-insensitively. A trailing `[bot]` is significant and stored as written. GitHub gives `[bot]` logins only to Apps, so such a login cannot be taken by a person.
- **Jira:** `accountId` (preferred), or `name` when an entry declares one explicitly (see decision 9.8).
- **Slack:** `userId`. Used by the loop guard (3.8) to tell a registered agent's bot messages from an unknown bot's.

`useDefaults="false"` removes every default entry. `recentPush` bounds how old an agent's push to a keyed branch may be and still count as a claim (3.5).

### 3.2 The default registry

Defaults live as data in one file (`pipeline/src/map/agent-defaults.ts`) and resolve through `resolveAgents(map)`: the map's entries plus the defaults, a map entry with the same id replacing the default.

| Id | Display name | Mode | GitHub login | Hand-off |
|---|---|---|---|---|
| `copilot` | Copilot | `yield` | verified at build time (#95) | `github-assign`, verified at build time |
| `claude` | Claude | `yield` | verified at build time (#95) | `mention`, handle verified at build time |
| `codex` | Codex | `yield` | verified at build time (#95) | `mention`, handle verified at build time |
| `devin` | Devin | `yield` | verified at build time (#95) | none (later work) |
| `cursor` | Cursor | `yield` | verified at build time (#95) | none |
| `jules` | Jules | `yield` | verified at build time (#95) | none |

No login is typed from memory. `scripts/verify-agent-logins.mjs` asks GitHub's public API whether each default login exists and is a bot account, prints a table and exits non-zero on any mismatch; the live tier runs the same check (11). An agent with no GitHub bot login keeps its `login` out of the file rather than guessing, and is then recognizable only through the identities a workspace adds. Defaults are `yield`: a workspace opts an agent into `coordinate` or `handoff-target` by adding an entry with the same id.

### 3.3 Agent claims

A claim says "a registered agent has this incident's work". It is a new event, `agent-claimed`, with the agent id, how it was seen, and a link.

| Seen through | Recognized when | Appends |
|---|---|---|
| GitHub pull request (#97) | `pull_request` `opened` or `reopened`, author is a registered agent, and the head branch, title or body names an incident's Jira key | `agent-claimed { via: 'pr' }` and `pr-opened` with the agent as actor, once per pull request |
| GitHub branch (3.5) | A branch carrying the key whose latest push is by a registered agent within `recentPush` | `agent-claimed { via: 'branch' }` |
| Jira assignment (#98) | An issue update whose new assignee is a registered agent's Jira identity, once per assignee change | `agent-claimed { via: 'assignment' }` |
| GitHub issue assignment (3.5) | An issue assigned to a registered agent that names the key (needs Issues read, see 6) | `agent-claimed { via: 'assignment' }` |
| Hand-off (3.6) | The product handed the work to the agent | `agent-claimed { via: 'handoff' }` when the agent's pull request opens |

Appending `pr-opened` with the claim matters: the existing merge path records `merged` only for the pull request named by the latest `pr-opened`, so without it an agent's merge would never be recorded. A pull request from an unregistered bot is ignored exactly as today. A registered agent's pull request that names no known key is acknowledged and ignored.

**The hold.** The claim reader in `engine/claims.ts` grows to read `agent-claimed` beside `claimed`, through the same pure fold, so the engine and the fixer job decide alike:

1. A claim before the incident's first `fixer-started` holds the fixer. The ticket is filed ticket-only: `level-changed` to 0 with the reason `agent-claimed:<agentId>`, and the claim card (A 2.1) reads "Filed as WEB-1042. Copilot is working on this. **[Let {product} take it]** **[Not a bug]**".
2. A claim after `fixer-started` is mid-flight. It is recorded and reported, not enforced, until the pre-push check (3.5) lands; from then on, the built-in run stops before pushing when the agent has an open pull request on the key.
3. The hold ends when the agent's pull request closes unmerged (`released { scope: 'claim', reason: 'pr-closed' }`), when the Jira assignee moves away from the agent (`reason: 'unassigned'`), or when an engineer taps **Let {product} take it** (`let-agent-take`). The incident then returns to its configured level, as a released human claim does.
4. A merged agent pull request moves the incident like any merged pull request.
5. Claim expiry follows A 2.4 with the surface owner asked instead of the claimer: "Copilot has had WEB-1042 for 4 hours with no pull request. **[Keep waiting]** **[Let {product} take it]**".

**Lifecycle (B 5 amendment).** `agent-claimed` and `handoff-sent` move `filed`, `stopped` and `escalated` to `claimed`, where today's rows already carry a later `pr-opened` to `in-review`; in any other status they change nothing (a mid-flight claim is a record). `handoff-failed` moves `claimed` to `escalated`, as `fixer-failed` moves `fixing`. One row is added for every pull request the product does not review (a person's, or a `yield` agent's): `in-review` accepts `merged` and moves to `merged`. The product's own merge path never merges from `in-review`, so the row changes nothing else, and it fixes today's gap where a person's merged pull request leaves the incident at `in-review` (2.1).

**Actor.** A claim's actor is the agent: id `agent:<agentId>`. Which role value it carries is decision 9.1.

### 3.4 Status and the ticket

The copy module (`pipeline/src/status/copy.ts`) gains states; it does not gain a mechanism. The agent's display name always comes from `resolveAgents`, never from a constant.

| Event | Status message (reporter-facing, main 20.1) | Ticket |
|---|---|---|
| `agent-claimed`, no pull request | "Copilot is working on this." | One comment per claim: "Copilot has this (assigned in Jira)." |
| `agent-claimed` or `pr-opened` by an agent | "Copilot is working on this. [See the fix in progress]" | "Copilot opened a pull request: <link>." |
| `merged` by an agent | The existing merged copy, naming the agent: "Merged by Copilot. Rolling out to staging." | Existing merged comment |
| `released`, reason `pr-closed` or `unassigned` | "Copilot stopped working on this. The work is free again." | One comment saying so |
| `handoff-sent` (3.6) | "Handed to Copilot." | "Handed to Copilot through a GitHub issue: <link>." |

Engineers' status answers (A 4.3) add the agent, the pull request number and the hold. Reporter-facing copy never shows a file path, a branch or the word "PR".

### 3.5 The collision check

Two checkpoints, one reader (`pipeline/src/fixer/collision.ts`):

- **Pre-dispatch.** When the queue (4.3) starts a run, `runFixerJob` runs the check with its other refusals, before it appends `fixer-started`.
- **Pre-push.** When the fixer reports its `tested` checkpoint (B 9), the server runs the check. A finding that holds sets the pending stop the fixer already polls, with reason `collision`, so the run stops before `pushed`. Nothing reaches the remote.

| Source | Read through | Finding | Effect |
|---|---|---|---|
| Open pull requests whose head branch, title or body names the key | GitHub: open pull requests of the surface's repo | `agent-pr` or `person-pr` | An agent's: `agent-claimed { via: 'pr' }` and the mode's hold. A person's: `pr-opened` with the person as actor (what the webhook would have appended), and no run |
| Branches carrying the key with a recent push | GitHub: branches and the author of their head commit | `agent-branch` | `agent-claimed { via: 'branch' }` |
| A GitHub issue assigned to a registered agent that names the key | GitHub: issues assigned to each agent's login | `agent-issue` | `agent-claimed { via: 'assignment' }` |
| Open pull requests touching the request's likely files (the diagnosis `<file path>` entries), without the key | GitHub: pull request files | `file-overlap` | Advisory: recorded, passed to the review input, shown on the PR card. No hold (decision 9.7) |

Every check that finds something appends one `collision-checked` event with its findings; a clean check appends nothing. Reads are cached per repository for 60 seconds, so a burst of dispatches costs one set of calls. The Issues source is skipped while the App lacks Issues read (E18, #62, adds the permission). When GitHub cannot be read, the check records `skipped` and the run proceeds (decision 9.6).

The GitHub client gains read methods: open pull requests of a repository, branches matching a key, the head commit author of a branch, and issues assigned to a login. The webhook needs no new subscription for pull requests; pushes are read on demand at the two checkpoints rather than subscribed to.

### 3.6 Hand-off

A surface can send its work to an agent instead of the built-in fixer:

```xml
<surface id="web" label="Website">
  <repo>github.com/example/web</repo>
  <jira project="WEB" defaultIssueType="Bug"/>
  <fixer engine="handoff:copilot" deadline="PT2H" fallback="none"/>
</surface>
```

`engine` is `builtin` (the default) or `handoff:<agentId>`, naming an agent in mode `handoff-target` that has a `<handoff>`. (Epic #47 writes this value as `snapwing`; it is `builtin` here so the schema carries no product name.) Wherever the built-in fixer would start a first attempt (the In Progress transition at levels 2 and 3, **Fix it** at level 1, main 10.1), the product calls the surface's `HandoffPort` instead. Level 0 never hands off. A retry after a review is 3.7's business, not a second hand-off.

| `via` | What the product does | The agent's answer |
|---|---|---|
| `github-assign` | Creates a GitHub issue in the surface's repository with the rendered implementation request, the Jira key in the title and the label `snapwing:handoff`, and assigns it to the agent's GitHub identity. When the surface tracks work in GitHub Issues (E18, #62), the incident's own issue is assigned instead | A pull request by the agent naming the key (3.3) |
| `mention` | The same issue, then one comment mentioning the agent's handle (`text`) asking for a pull request whose branch carries the key | As above |
| `webhook` | POSTs the implementation-request XML to `url`, signed with HMAC-SHA256 under the named secret, with a delivery id, a callback URL `/handoff/{incidentId}/result`, and a callback token scoped to the incident (the fixer token's scheme, B 9, with its own prefix) | 2xx to accept; the result by callback (`{ prUrl }` or `{ failed: reason }`), or simply a pull request by the registered agent |

The send runs as a `handoff.send` job with three retries and backoff. A successful send appends `handoff-sent` with the reference and the deadline. No pull request by the deadline, a callback that reports failure, or a send that exhausts its retries appends `handoff-failed`, and then:

- `fallback="none"`: the incident degrades as a failed fixer does (main 10.4): `level-changed` to at most 2 with the reason, the owner is mentioned.
- `fallback="builtin"`: the built-in fixer starts once, through the queue.

**Stop** on a handed-off incident appends `stopped`, withdraws the hand-off (a comment and unassignment on the issue, or a signed cancel POST to the webhook), and comments on the agent's open pull request. The product does not close a pull request another agent opened.

### 3.7 Review of handed-off pull requests

A pull request from an agent the incident was handed to, or from an agent in mode `coordinate` or `handoff-target`, goes through the same steps as the built-in fixer's:

1. The webhook path starts `review.run` when it appends that `pr-opened`, with the same singleton key per head commit (today only the fixer API starts it, 2.1).
2. The independent review (main 11.1) runs against the implementation request's constraints, with the regression proof. The `snapwing/review` check is created on the agent's pull request.
3. CI is recorded and the merge gate (main 11.3) runs fresh at merge time. At level 3 the App merges only when every gate passes; at levels 1 and 2 a linked person merges (main 11.2).
4. `request-changes` does not start the built-in fixer. The review is posted on the pull request and the agent is mentioned once (the loop guard counts it); a second `request-changes` escalates, as in main 11.1.
5. The status loop is the built-in fixer's, with the agent named.

A `yield` agent's pull request is not reviewed. Its merge moves the incident through the new `in-review` row (3.3), so the status says merged and the deploy rows (A 4.5, E17 #61) follow.

### 3.8 The loop guard

1. **Own writes are never read back.** Every issue, comment and hand-off payload the product writes carries a marker (`snapwing:incident=<id>`, a hidden comment in Markdown, a header on a webhook). Inbound handlers already drop the App's own GitHub events, the product's Jira account's changes and its own Slack messages (2.1); the marker extends that to a hand-off's assignment, which the claim reader takes as the expected acknowledgement of `handoff-sent`, not a new claim.
2. **Agent-triggered re-triage is rate limited.** A message, reaction or alert authored by a registered agent or another bot that would start a capture is limited to `loopGuard agentCapturesPerHour` per author (default 3), through the cache port's `setIfAbsent`, and never starts a capture while an open incident already covers that thread. Above the limit it is dropped, logged, and counted. Agents never count as reactors on the A 1.4 ladder.
3. **Another bot's "ticket created" reply is dedupe evidence.** In an incident's thread, a message classified `bot` (authorship.ts) that carries a tracker key for the surface's project, or an issue link for its repository, becomes a dedupe candidate with score 1 at the dedupe step, and the main 6.2 card asks: "Another bot filed WEB-998 for this. **[Link this thread to WEB-998]** **[Create new anyway]** **[Not related]**".
4. **A mention budget.** The product mentions an agent at most once per incident per hour, and only for a hand-off or a review's changes.
5. **Hand-off depth one.** A pull request that came from a hand-off never triggers another hand-off; `fallback="builtin"` starts the built-in fixer once.
6. **A person who takes over sees the checkpoint.** When a person takes over mid-run (A 2.2 **Stop it, I'll take over**, a Stop, or **Let {product} take it** on an agent's claim), the reply carries the last checkpoint: the phase, the branch, whether anything was pushed, and the open pull request if any, read from `fixer-checkpoint` events or, for an agent, from its pull request.

### 3.9 Contracts

```typescript
// pipeline/src/map/types.ts (additions, #94)
export type AgentMode = 'yield' | 'coordinate' | 'handoff-target';
export type HandoffVia = 'github-assign' | 'mention' | 'webhook';

export interface MapAgentHandoff {
  via: HandoffVia;
  text?: string;                   // mention: the handle to mention
  url?: string;                    // webhook: https, or http to localhost
  secret?: string;                 // webhook: the secret's name, read from the secrets port
}

export interface MapAgent {
  id: string;
  name: string;                    // display name, used in all copy
  mode: AgentMode;
  github: { login: string }[];
  jira: ({ accountId: string } | { name: string })[];
  slack: { userId: string }[];
  handoffs: MapAgentHandoff[];
}

export interface SurfaceFixer {
  engine: 'builtin' | `handoff:${string}`;
  deadline: string;                // ISO 8601, default PT2H
  fallback: 'none' | 'builtin';
}
// WorkspaceMap gains `agents: MapAgent[]` (empty when absent), `agentDefaults: boolean` (true when
// absent) and `agentRecentPush: string`; MapSurface gains `fixer?: SurfaceFixer`.

// pipeline/src/map/agents.ts (#95)
export function resolveAgents(map: WorkspaceMap): readonly MapAgent[];
/** The registered agent with this GitHub login, compared case-insensitively; undefined when none. */
export function isRegisteredAgent(login: string, agents: readonly MapAgent[]): MapAgent | undefined;

// pipeline/src/contracts/events.ts (additions)
export interface AgentClaimedPayload {
  agentId: string;
  via: 'pr' | 'branch' | 'assignment' | 'handoff';
  prNumber?: number;
  branch?: string;
  url?: string;
}
// ReleasedPayload, scope 'claim': reason gains 'pr-closed' | 'unassigned'.

export interface HandoffSentPayload {
  agentId: string;
  via: HandoffVia;
  ref: { kind: 'github-issue' | 'github-comment' | 'webhook'; id: string; url?: string };
  deadline: string;                // ISO 8601 instant
}

export interface HandoffFailedPayload {
  agentId: string;
  reason: 'deadline' | 'rejected' | 'send-failed' | 'reported-failure';
  fallback: 'none' | 'builtin';
}

export type CollisionFinding =
  | { kind: 'agent-pr'; agentId: string; prNumber: number; branch: string }
  | { kind: 'person-pr'; login: string; prNumber: number; branch: string }
  | { kind: 'agent-branch'; agentId: string; branch: string; pushedAt: string }
  | { kind: 'agent-issue'; agentId: string; issueNumber: number }
  | { kind: 'file-overlap'; prNumber: number; author: string; files: string[] };

export interface CollisionCheckedPayload {
  at: 'dispatch' | 'pre-push';
  findings: CollisionFinding[];
  skipped?: 'github-unavailable' | 'rate-limited';
}

// pipeline/src/ports/handoff.ts
export interface HandoffRequest {
  incidentId: string;
  issueKey: string;
  repo: string;
  agent: MapAgent;
  handoff: MapAgentHandoff;
  implementationRequestXml: string;
  callback?: { url: string; token: string };
}

export type HandoffReceipt =
  | { ok: true; ref: HandoffSentPayload['ref'] }
  | { ok: false; reason: string; retryable: boolean };

export interface HandoffPort {
  send(request: HandoffRequest): Promise<HandoffReceipt>;
  /** Stop: unassign or comment, or POST a signed cancel. Idempotent. */
  withdraw(ref: HandoffSentPayload['ref'], reason: string): Promise<void>;
}
```

---

## 4. Part 2: operating at scale

### 4.1 In-flight dedupe and merge

**Fingerprint (#100).** `fingerprintReport(text, readings)` is computed when the bundle is assembled, the first moment both the text and the image readings exist:

- text tokens: `summaryTokens` of the bundle's extracted summary, the same tokens main 6 scores;
- image tokens: `summaryTokens` of each reading's `errorText`, the host and path of `urlBar` (no query string), and `plainDescription`;
- an exact hash of each normalized `errorText`.

Tokens are stored hashed, so the registry holds no readable report text. Two fingerprints score the larger of the token similarity (the `scoreSummaries` formula over the hashed tokens) and 1 when an `errorText` hash matches on the same surface. A hash of `plainDescription` alone is not used as a match: two readings of one broken screen rarely produce the same sentence.

**Registry (#100).** An entry holds the fingerprint, the incident id, the source, and the surface and component once `resolved` names them. It is written at `context-assembled`, updated at `resolved`, and ended at `filed`, `not-filed`, `linked-to-existing`, `capture-cancelled` or `not-a-bug`, with a ceiling TTL of 24 hours (the level 1 tap window). Ending writes a tombstone with a one-second TTL, because the cache port cannot delete. How entries are stored on a port that cannot list keys is decision 9.2.

**Lookup.** The dedupe step calls `findInFlight(fingerprint, resolution)` after the Jira and recent-cache searches. It returns in-flight incidents on the same surface (or with no surface yet), captured **earlier** than this one, scoring at or above the threshold, best first. Only joining an earlier capture breaks the tie when two reports look each other up in the same second.

**Merge (#101).** At or above the merge threshold (decision 9.3), the later report joins the earlier incident. One state transaction appends:

- to the joining incident: `dedupe-checked` with the in-flight candidate, then `linked-to-existing { incidentId, inFlight: true }` (terminal; the payload gains `incidentId`, with `issueKey` optional when it is set);
- to the target: `reporter-added` with the reporter, the anchor, the thread and the score.

The `subscriptions` projection folds `reporter-added` into a thread row, so the joining reporter's thread follows the target's status (main 12, A 4.4). The joining thread gets one line: "Someone reported this a moment ago. I added you to it, and this thread will follow it. **[Not the same problem]**". Reporter-facing copy never names the other reporters. Engineers see "Reported by 3 people" in status answers, and the ticket lists every reporter's conversation link in one batched comment (A 1.5).

**Undo.** **Not the same problem** is the dedupe card's `not-related` choice, open to the joining reporter or an engineer. The target appends `corrected { correctsSeq, fields: { removed: true }, reason: 'split' }` (B 4), the thread row is removed, and the report is captured again as a new incident (idempotency key `<original>:split`, whose in-flight lookup skips that target). The log keeps both facts.

**Edges.** A target that is already filed is main 6's business (the recent cache and the dedupe card), not this merge. A target that ends without filing (a resolution signal, a user-side fix) posts one line to each added reporter with **[Still broken]**, which captures that report again as above.

### 4.2 Cross-message burst detection

After `resolved`, the product counts distinct incidents on the same surface (or component, with `scope="component"`) captured inside `burst window` (default PT15M) that did not join another incident. When the count reaches `minIncidents` (default 3), it posts one card per surface per window (`setIfAbsent` on `burst:{surface}:{window start}`) in the surface's channel, mentioning its owner:

> 3 different reports about **Website** in the last 12 minutes. Possible outage? **[Treat as one outage]** **[Not related]**

The card names no reporter. `burst-detected` is appended on the primary incident (the highest priority, then the earliest) with every incident id.

**Treat as one outage** (an engineer; decision 9.4) appends to the primary incident one counted `comment` per unique reporter of the other incidents, weighted by role, exactly as the signal handler records a reaction (A 1.4). The existing ladder then does the rest: step 3 raises priority, step 5 mentions the owner and suppresses the ask-back gate, step 8 is an outage and starts active monitoring and the playbook's escalation ladder (A 4.5, A 6.2). Each other incident gets one ticket comment, "Part of a possible outage tracked in WEB-1042". Later incidents in the same window are added to the burst and counted. **Not related** or no answer changes nothing, and no second card is posted for that window.

### 4.3 Fixer caps and the queue

**Config (#102).** `<fixers max-running="3" max-per-repo="2" queue-timeout="PT24H"/>` in `snapwing.config.xml`. Both caps are positive integers; the loader rejects `max-per-repo` greater than `max-running`.

**The queue.** A new table (`fixer_queue`, one forward-only migration, both dialects) holds one row per incident, keyed by `fixerRunKey`: the repository, the priority rank, the attempt, the arrival sequence, the state, the waiting reason, the likely files (4.4), and the `FixerRunData`. `startFixer` upserts the row and calls `dispatch`; a duplicate start finds the row and returns it, as the singleton key does today.

**Order.** Priority rank (Highest first; an incident with no priority ranks as Medium), then retries before first attempts, then arrival.

**States and slots.** `queued`, then `dispatched` (the job was started), then `running` (from `fixer-started`), then the row is deleted at `fixer-done`, `fixer-failed` or `stopped`. A slot is a `dispatched` or `running` row, counted globally and per repository. Counting from the log, not from the runner call, is the point: the runner returns as soon as the container starts (2.2).

**Dispatch.** In one transaction: count slots, walk queued rows in order, skip a row whose repository is full, whose files overlap a running run (4.4), or that is held by the budget (4.6) or a paused switch (4.7), and mark the chosen rows `dispatched`. After the commit, start each `fixer.run` with its singleton key. Dispatch runs after every enqueue, after every run ends (the fixer API's done and failed reports, a stop, the budget timer), after a refusal, at startup, and once a minute from a `fixer.dispatch` cron job as a safety net.

**Refusals stay where they are.** `runFixerJob`'s refusals (stop, claim hold, instructions hold) and the collision check (3.5) run when the run leaves the queue. A refusal deletes the row and dispatches again.

**Stop and expiry.** A stop on a queued run deletes its row. A row queued longer than `queue-timeout` appends `fixer-failed { reason: 'queue-timeout' }` and takes main 10.4's degrade.

**Restart.** The queue and the slot count are rebuilt from the table and the log: a `running` row whose log shows the run ended is deleted; a `dispatched` row with no job and no `fixer-started` returns to `queued`. No run starts twice: the singleton key and the attempt check in `runFixerJob` already refuse a second start.

Review runs and test runs are awaited by their jobs and keep the workflow's per-worker concurrency; they are not counted against these caps.

### 4.4 File-overlap serialization

Each queued run records the files its implementation request names as likely code (the diagnosis `<file path>` entries, read through the parsed type, #103). A run does not start while a running run on the same repository names any of the same files; it stays queued with the reason `overlap`. A directory entry overlaps every file under it. Runs on different files or repositories never delay each other. A run with no file list is never blocked: overlap is a hint to avoid merge conflicts, not a lock.

### 4.5 Queue position in the status message

The status copy gains waiting lines (#104), plain language with no file path, branch or "PR" (main 20.1):

| Reason | Line |
|---|---|
| A cap is full | "Waiting for a free fixer, number 3 in line." |
| `overlap` | "Waiting for another fix to the same area to finish." |
| Budget hard cap (4.6) | "Automatic fixing is paused for today. The ticket is filed and the team can see it." |
| Fixers paused (4.7) | "Automatic fixing is paused for now. The ticket is filed and the team can see it." |

The position is read from the queue table through `status/query.ts`, never from the adapters. When runs ahead finish, dispatch re-renders the status of each queued incident whose line changed, so the same message edits in place. No line is added when a run starts at once. Slack, Teams and `snapwing status KEY` show the same text. `waiting-changed` gains the kind `queue` (with `who` set to the reason), appended once when a run starts waiting and cleared when it starts, so status answers (A 4.3) can say what an incident waits on.

### 4.6 Usage ledger, prices, cost and budgets

**Ledger in the router (#105).** `createModelRouter` wraps every route in a ledger writer, as it wraps them in `withValidation`, so every provider is covered once. Each `complete`, `vision` and `classify` call appends one row; a classify retry is two rows. A row holds: time, workspace, incident id when the caller passes one (`CompletionRequest` gains an optional `incidentId`), task, provider, the model that actually served (`result.model`, so a refusal fallback is visible), input and output tokens (null, never zero, when the provider reports none), and the outcome (`ok` or `error`). The table is new (`model_usage`, one forward-only migration, both dialects). Writes are best effort: a failed write is logged and never fails the call.

**Meter the proxy (#106).** The model proxy tees each upstream response: one branch goes back to the container unchanged and unbuffered, the other is read for the provider's usage fields, including the final usage event of a streamed response. Each forwarded call appends a row with source `proxy`, the work item id from the path (the incident) and the run id from the token, and task `harness`. A response with no usage yields null tokens; an upstream failure yields outcome `error`. The ledger write never delays or fails the forwarded response.

**Prices (#107).** `pipeline/src/models/prices.ts` maps provider and model to input and output price per million tokens, with the date each row was copied and its source in a comment. `<prices>` in config adds or replaces a row (for proxied or self-run models). `costOf(row)` returns an amount, or `unknown` for a model with no price, never zero. `incidentCost(incidentId)` returns the total, a split per task, and the count of unknown rows; `dailyCost(day, tz)` sums a day. A test fails when a model in `DEFAULT_MODELS` (models/router.ts) has no price row.

**Budgets (#108).** `<budget daily-soft daily-hard tz>`, both caps optional and off by default, in the price table's currency.

- **Soft cap:** one notice per day to the ops destination (4.8); work continues.
- **Hard cap:** new incidents are filed ticket-only (`level-changed` to 0, reason `budget:daily-hard`, through the same path as a failed fixer's degrade); queued fixers stay queued with the reason `budget`; autopilot merges hold at level 2 semantics; running fixers finish. Model calls for filing still run: the cap limits fixers and autopilot, not the ticket.
- **Reset:** at midnight in `tz` (default `UTC`; there is no workspace time zone, 2.2), and the queue resumes.
- **Cost of the check:** one cached ledger sum per fixer start.

The reporter's thread says, with no amounts, that automatic fixing is paused for today. A config edit raises or clears a cap without a restart (the config watcher already reloads). How unknown-cost rows count toward a cap is decision 9.5.

### 4.7 Ops controls and the kill switch

Three switches and one action:

| Control | While on |
|---|---|
| Pause **intake** | A new report is captured (the `captured` event costs no model call) and its job parks on an `ops` wait until resume; the reporter gets one line: "Received. Processing is paused for now; this will continue when it resumes." A capture parked longer than 24 hours is closed with `capture-cancelled` and a note |
| Pause **fixers** | Dispatch starts nothing; queued runs show the paused line (4.5); running fixers finish |
| Pause **autopilot** | Level 3 merges hold at level 2 semantics with the reason "Autopilot paused by @dana" (main 11.3's degrade) |
| **Stop all** | `stopIncident` for every running and queued fixer (actor the person, reason `stop-all`), then fixers are paused so nothing new starts. Asks for confirmation |

State lives in a new append-only table (`ops_switches`: switch, paused, actor, reason, time); the current state is each switch's latest row, so the history of who paused what, when and why is the table. Every decision point (capture, dispatch, merge evaluation) reads the switch fresh, which is what "within one event" means: the first event after the change sees it.

Surfaces: the product's slash command (working name `/snapwing`, from #138) with `pause intake|fixers|autopilot`, `resume ...`, `stop-all` and `ops`; buttons in the App Home Workspace section (4.8); and the CLI (4.9). Who may use them is decision 9.9.

### 4.8 Admin views and the ops digest

**App Home "Workspace" section.** A platform-neutral model (`app/src/status/workspace.ts`, beside `status/queue.ts`) that Slack Home renders and the Teams personal tab can render later:

- **Running:** each fixer run with its key, repository, age and **Stop**; "3 of 3 fixers busy".
- **Queued:** key, position and reason.
- **Waiting:** incidents waiting on a person longer than an hour, and on what.
- **Failed today:** fixer failures and hand-off failures.
- **Today's spend:** the day's cost against the soft and hard caps, and the count of calls with unknown cost.
- **Switches:** each switch's state with Pause or Resume, and **Stop all**, for people allowed to use them (decision 9.9); others see the section without controls.

**Ops digest.** A playbook digest with `kind="ops"` posts the same sections as a daily summary (A 4.6's mechanism, one cron job). `<notifications><ops to="#eng-ops"/></notifications>` names where soft-cap notices and burst summaries go; without it they appear only in App Home and the CLI.

### 4.9 CLI

| Command | Prints |
|---|---|
| `snapwing runs [--state running\|queued\|failed] [--since 24h] [--json]` | Fixer runs and hand-offs: key, repository, engine, state, age, queue position or reason, cost |
| `snapwing trace <KEY>` (from #4) | Adds the incident's cost: total, per task, unknown rows; plus agent claims, hand-offs and collision findings in order |
| `snapwing metrics [--since 30d]` (from #4) | Adds spend per day, queue wait (median and p90), peak running fixers, in-flight merges, bursts, agent claims and hand-offs |
| `snapwing ops [show\|pause <switch>\|resume <switch>\|stop-all]` | Switch state and history; changes go through the server with the caller's token and are authorized as in 4.7 |

### 4.10 Telemetry

- **Spans.** One trace per incident, its id derived from the incident id. A span per engine step (assemble, scope, resolve, dedupe, clarify, plan, file), per `fixer.run`, `review.run` and `merge.evaluate`, and per model call as a child span carrying task, provider, served model, token counts and outcome. Attributes are ids, names, counts and durations, never message text, image content, prompts or outputs.
- **JSON logs.** `<telemetry logs="json">` turns `ComposeLog` lines into one JSON object per line: time, level, message, and the incident id, step, trace id and span id when known. The default stays text.
- **Prometheus.** `/metrics` keeps its B 10 lines and adds:

| Metric | Type |
|---|---|
| `fixers_running{repo}`, `fixers_queued{reason}` | gauge |
| `fixer_queue_wait_seconds` | histogram |
| `model_calls_total{provider,task,outcome}`, `model_tokens_total{provider,task,direction}` | counter |
| `model_cost_today`, `model_cost_unknown_rows_today` | gauge |
| `budget_state` (0 under, 1 soft, 2 hard), `ops_switch_paused{switch}` | gauge |
| `inflight_merges_total`, `bursts_total{outcome}` | counter |
| `agent_claims_total{agent,via}`, `handoffs_total{agent,outcome}`, `collisions_total{kind}` | counter |
| main 17: `anchor_to_filed_seconds`, `tap_to_pr_seconds` | histogram |
| main 17: `dedupe_hits_total`, `askback_total{answered}`, `autopilot_merges_total`, `reverts_total`, `staging_confirmations_total`, `incidents_total{source,images}` | counter |

  Metric names take their prefix from the brand module (today's lines use `snapwing_`).
- **Export is opt-in.** `<telemetry export="on">` sends spans over OTLP to the endpoint in the standard OpenTelemetry environment variables, with headers from the secrets port. Off, no span leaves the process; `/metrics` is always local.

### 4.11 Console

The console package is a placeholder (2.2). When it is built (main 20.3), its run list renders `runs --json` and its trace timeline renders `trace --json`; this document defines only those read models.

### 4.12 Contracts

```typescript
// pipeline/src/dedupe/fingerprint.ts and inflight.ts (#100)
export interface ReportFingerprint {
  textTokens: string[];            // hashed tokens
  imageTokens: string[];           // hashed tokens
  errorTextHashes: string[];
}
export function fingerprintReport(text: string, readings: readonly ImageReading[]): ReportFingerprint;

export interface InFlightEntry {
  incidentId: string;
  capturedAt: string;
  source: ChannelSource;
  surfaceId?: string;
  componentId?: string;
  fingerprint: ReportFingerprint;
}
export interface InFlightMatch { incidentId: string; score: number }
export function findInFlight(fp: ReportFingerprint, resolution: Resolution, self: InFlightEntry): Promise<InFlightMatch[]>;

// pipeline/src/contracts/events.ts (additions, #101)
export interface ReporterAddedPayload {
  reporter: ReporterRef;
  anchorId: string;
  channelId: string;
  threadId?: string;
  fromIncidentId: string;
  score: number;
}
export interface LinkedToExistingPayload { issueKey?: string; incidentId?: string; inFlight?: boolean } // one of the two ids

export interface BurstDetectedPayload {
  burstId: string;
  surfaceId: string;
  componentId?: string;
  incidentIds: string[];
  windowStart: string;
  windowEnd: string;
}
// WaitingOn.kind gains 'queue'; `who` is 'cap' | 'repo-cap' | 'overlap' | 'budget' | 'paused'.

// pipeline/src/fixer/queue.ts (#102, #103)
export type QueueState = 'queued' | 'dispatched' | 'running';
export type QueueReason = 'cap' | 'repo-cap' | 'overlap' | 'budget' | 'paused';
export interface FixerQueueRow {
  incidentId: string;
  key: string;                     // fixerRunKey(incidentId)
  repo: string;
  priorityRank: number;            // 0 Highest .. 4 Lowest
  attempt: 1 | 2;
  seq: number;                     // arrival
  state: QueueState;
  reason?: QueueReason;
  files: string[];
  data: FixerRunData;
}
export interface FixerQueue {
  enqueue(data: FixerRunData, files: readonly string[]): Promise<{ position: number }>;
  dispatch(): Promise<string[]>;   // incident ids whose run was started
  remove(incidentId: string): Promise<void>;
  position(incidentId: string): Promise<{ position: number; reason: QueueReason } | undefined>;
  rebuild(): Promise<void>;
}

// pipeline/src/models/ledger.ts, prices.ts, cost.ts (#105, #107)
export interface UsageRow {
  at: string;
  workspaceId: string;
  incidentId?: string;
  runId?: string;
  source: 'router' | 'proxy';
  task: ModelTask | 'harness';
  provider: string;
  model: string;                   // as served
  inputTokens: number | null;
  outputTokens: number | null;
  outcome: 'ok' | 'error';
}
export interface UsageLedger {
  record(row: UsageRow): Promise<void>;          // best effort, never throws
  rows(q: { incidentId?: string; from?: string; to?: string }): Promise<UsageRow[]>;
}
export interface PriceRow { provider: string; model: string; inputPerMTok: number; outputPerMTok: number; asOf: string }
export type Cost = { amount: number } | { unknown: true };
export interface IncidentCost { total: number; byTask: Record<string, number>; unknownRows: number }

// pipeline/src/policy/budget.ts (#108)
export type BudgetState = 'under' | 'soft' | 'hard';
export interface BudgetCheck { state: BudgetState; spentToday: number; unknownRows: number; resetsAt: string }

// pipeline/src/ops/controls.ts
export type OpsSwitch = 'intake' | 'fixers' | 'autopilot';
export interface OpsSwitchState { paused: boolean; since?: string; by?: EventActor; reason?: string }
export interface OpsControls {
  state(): Promise<Record<OpsSwitch, OpsSwitchState>>;
  set(change: { switch: OpsSwitch; paused: boolean; actor: EventActor; reason?: string }): Promise<void>;
  stopAll(actor: EventActor, reason?: string): Promise<{ stopped: string[]; dequeued: string[] }>;
}
```

---

## 5. Configuration

### 5.1 Workspace map (`schemas/workspace-context.xsd`, `.sch`)

```xml
<!-- XSD sketch: structure only; cross-references are Schematron's -->
<xs:simpleType name="AgentModeType">
  <xs:restriction base="xs:string">
    <xs:enumeration value="yield"/>
    <xs:enumeration value="coordinate"/>
    <xs:enumeration value="handoff-target"/>
  </xs:restriction>
</xs:simpleType>

<xs:complexType name="AgentHandoffType">
  <xs:attribute name="via" use="required">
    <xs:simpleType>
      <xs:restriction base="xs:string">
        <xs:enumeration value="github-assign"/>
        <xs:enumeration value="mention"/>
        <xs:enumeration value="webhook"/>
      </xs:restriction>
    </xs:simpleType>
  </xs:attribute>
  <xs:attribute name="text" type="NonEmptyString"/>
  <xs:attribute name="url" type="xs:anyURI"/>
  <xs:attribute name="secret" type="xs:NCName"/>
</xs:complexType>

<xs:complexType name="AgentType">
  <xs:sequence>
    <xs:element name="github" minOccurs="0" maxOccurs="unbounded">
      <xs:complexType><xs:attribute name="login" type="NonEmptyString" use="required"/></xs:complexType>
    </xs:element>
    <xs:element name="jira" minOccurs="0" maxOccurs="unbounded">
      <xs:complexType>
        <xs:attribute name="accountId" type="NonEmptyString"/>
        <xs:attribute name="name" type="NonEmptyString"/>
      </xs:complexType>
    </xs:element>
    <xs:element name="slack" minOccurs="0" maxOccurs="unbounded">
      <xs:complexType><xs:attribute name="userId" type="NonEmptyString" use="required"/></xs:complexType>
    </xs:element>
    <xs:element name="handoff" type="AgentHandoffType" minOccurs="0" maxOccurs="unbounded"/>
  </xs:sequence>
  <xs:attribute name="id" type="IdType" use="required"/>
  <xs:attribute name="name" type="NonEmptyString" use="required"/>
  <xs:attribute name="mode" type="AgentModeType" default="yield"/>
</xs:complexType>

<!-- In <workspace>, after <people>: -->
<xs:element name="agents" minOccurs="0">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="agent" type="AgentType" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
    <xs:attribute name="useDefaults" type="xs:boolean" default="true"/>
    <xs:attribute name="recentPush" type="xs:duration" default="PT24H"/>
  </xs:complexType>
  <xs:unique name="agentIdUnique">
    <xs:selector xpath="w:agent"/>
    <xs:field xpath="@id"/>
  </xs:unique>
</xs:element>

<!-- In SurfaceType, after <components>: -->
<xs:element name="fixer" minOccurs="0">
  <xs:complexType>
    <xs:attribute name="engine" default="builtin">
      <xs:simpleType>
        <xs:restriction base="xs:string">
          <xs:pattern value="builtin|handoff:[A-Za-z0-9][A-Za-z0-9_-]*"/>
        </xs:restriction>
      </xs:simpleType>
    </xs:attribute>
    <xs:attribute name="deadline" type="xs:duration" default="PT2H"/>
    <xs:attribute name="fallback" default="none">
      <xs:simpleType>
        <xs:restriction base="xs:string">
          <xs:enumeration value="none"/>
          <xs:enumeration value="builtin"/>
        </xs:restriction>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
</xs:element>
```

Schematron rules:

- an agent has at least one `github`, `jira` or `slack` identity;
- a `jira` identity has exactly one of `accountId` and `name`;
- one GitHub login (compared lowercase) belongs to at most one agent;
- `handoff via="mention"` needs `text`; `via="webhook"` needs `url` (https, or http to `localhost`) and `secret`; `via="github-assign"` needs a `github` identity;
- `fixer engine="handoff:X"` names an agent `X` whose mode is `handoff-target` and that has a `handoff`;
- `fallback="builtin"` only with a `handoff:` engine.

Existing maps parse unchanged and round-trip through `writeWorkspaceMap` and `editWorkspaceMap` with comments and order intact.

### 5.2 Application config (`schemas/app-config.xsd`)

```xml
<snapwing xmlns="urn:snapwing:config:v1" version="1">
  <runtime provider="docker"/>
  <models default-provider="anthropic"/>
  <harness fixer="claude-code" review="claude-code"/>
  <fixers max-running="3" max-per-repo="2" queue-timeout="PT24H"/>
  <budget daily-soft="20" daily-hard="50" tz="America/New_York"/>
  <prices>
    <price provider="openai" model="example-proxied-model" input="1.25" output="10"/>
  </prices>
  <telemetry logs="json" export="off"/>
</snapwing>
```

```xml
<!-- XSD sketch: four optional elements appended to the root sequence -->
<xs:simpleType name="Amount">
  <xs:restriction base="xs:decimal"><xs:minInclusive value="0"/></xs:restriction>
</xs:simpleType>

<xs:element name="fixers" minOccurs="0">
  <xs:complexType>
    <xs:attribute name="max-running" type="xs:positiveInteger" default="3"/>
    <xs:attribute name="max-per-repo" type="xs:positiveInteger" default="2"/>
    <xs:attribute name="queue-timeout" type="Duration" default="PT24H"/>
  </xs:complexType>
</xs:element>
<xs:element name="budget" minOccurs="0">
  <xs:complexType>
    <xs:attribute name="daily-soft" type="Amount"/>
    <xs:attribute name="daily-hard" type="Amount"/>
    <xs:attribute name="tz" type="NonEmptyToken" default="UTC"/>
  </xs:complexType>
</xs:element>
<xs:element name="prices" minOccurs="0">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="price" maxOccurs="unbounded">
        <xs:complexType>
          <xs:attribute name="provider" type="NonEmptyToken" use="required"/>
          <xs:attribute name="model" type="NonEmptyToken" use="required"/>
          <xs:attribute name="input" type="Amount" use="required"/>
          <xs:attribute name="output" type="Amount" use="required"/>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:element>
<xs:element name="telemetry" minOccurs="0">
  <xs:complexType>
    <xs:attribute name="logs" default="text">
      <xs:simpleType>
        <xs:restriction base="xs:string">
          <xs:enumeration value="text"/>
          <xs:enumeration value="json"/>
        </xs:restriction>
      </xs:simpleType>
    </xs:attribute>
    <xs:attribute name="export" type="OnOff" default="off"/>
  </xs:complexType>
</xs:element>
```

The loader adds what XSD 1.0 cannot say: `max-per-repo` at most `max-running`, `daily-soft` at most `daily-hard` when both are set, a known IANA zone in `tz`, and one `price` per provider and model.

### 5.3 Playbook (`schemas/playbook.xsd`)

```xml
<playbook xmlns="urn:snapwing:playbook:v1" version="1">
  <notifications>
    <digest to="#eng-leads" cron="0 9 * * 1-5"/>
    <digest to="#eng-ops" cron="0 9 * * *" kind="ops"/>
    <ops to="#eng-ops"/>
  </notifications>
  <burst window="PT15M" minIncidents="3" scope="surface"/>
  <loopGuard agentCapturesPerHour="3"/>
</playbook>
```

`DigestType` gains `kind` (`incidents`, the default, or `ops`). `NotificationsType` gains an optional `ops` with a required `to`. The root sequence gains optional `burst` (`window` a duration, `minIncidents` an integer of at least 2, `scope` `surface` or `component`) and `loopGuard`. An empty `<playbook/>` stays valid; every new element has a default. The Schematron checks that `ops to` resolves like a digest's `to`.

---

## 6. Interactions with existing specs

- **main 4.2 (map).** `<agents>` and `<surface><fixer>` are map content (5.1); onboarding writes neither, and the defaults need no map entry.
- **main 4.6 (autonomy).** Agent claims and the budget's hard cap degrade through `level-changed`, the path a failed fixer uses. Pausing autopilot holds level 3 merges at level 2 semantics. Timed boosts and presets (E15, #59) are untouched.
- **main 6 (dedupe).** 4.1 adds an in-flight source after the two searches of main 6.1 and a merge before the card; filed incidents keep main 6's path. 3.8 adds another bot's reply as a candidate.
- **main 10 (fixer).** The trigger of 10.1 now enqueues; 10.4's Stop also removes a queued run and withdraws a hand-off; 10.4's degrade also takes `queue-timeout`, `handoff-failed` and the hard cap.
- **main 11 (review, merge).** 3.7 runs 11.1 to 11.3 on an agent's pull request. The risk gate and branch protection apply unchanged.
- **main 12 and 20.1 (status).** New lines in 3.4 and 4.5, platform-neutral, edited in place, with no file path, branch or "PR" for reporters.
- **main 14.1 (orchestration).** Intake pause parks the job on an `ops` wait; the queue sits between the trigger and `fixer.run`.
- **main 14.5 (ports).** The router gains the ledger wrapper; `CompletionRequest` gains `incidentId`. The harness adapters are unchanged: a hand-off is a different port.
- **main 16 (guardrails).** Hand-off targets are explicit map entries; the webhook is signed; the ledger and telemetry carry no content (7).
- **main 17 (open items).** The metrics list becomes Prometheus series (4.10).
- **main 20.2 and 20.3 (App Home, CLI, console).** The Workspace section, `runs`, `ops`, and cost in `trace` and `metrics`.
- **A 1.4 (ladder).** Bursts feed it through counted `comment` events; agents never count as reactors.
- **A 1.5 (attribution).** Agent claims, hand-offs and added reporters produce batched ticket comments.
- **A 2 (claims).** Agent claims reuse the hold reader, the mid-flight rule, `let-agent-take` and expiry. The existing button text "Let the agent take it" becomes **Let {product} take it**, since "agent" now names other vendors' agents.
- **A 4.3, A 4.6 (status pull, digests).** Answers name the agent, the queue position and the reason; the ops digest is a digest kind.
- **B 3, B 4 (schema, events).** New tables: `fixer_queue`, `model_usage`, `ops_switches`, each one forward-only migration on both dialects. New events (`agent-claimed`, `handoff-sent`, `handoff-failed`, `collision-checked`, `reporter-added`, `burst-detected`) each get the payload type, the type list entry, the upcast table entry and the schema entry. The split is a `corrected` event.
- **B 5 (lifecycle).** `agent-claimed` and `handoff-sent` move to `claimed`; `handoff-failed` from `claimed` moves to `escalated`; `in-review` accepts `merged`. The rest are non-state-changing.
- **B 9 (fixer reporting).** The `tested` checkpoint triggers the pre-push check; a collision sets the pending stop.
- **B 10 (operations).** `/metrics` grows (4.10).
- **E8 (#52).** Copy, the slash command, the metric prefix, the hand-off label and the loop guard's marker take the product name from the brand module.
- **E17 (#61).** Merges of agent pull requests feed the deploy and verification ladder like any merge; a per-incident case file can include the incident's cost.
- **E18 (#62).** The Issues permission enables the issue sources of 3.5 and lets `github-assign` assign the incident's own issue.
- **E15 (#59, #133, #138).** The admin flag decides who may use ops controls (9.9); the slash command family carries the ops subcommands.

---

## 7. Security and privacy

- **Identity, not text.** Agents are recognized from the signed webhook's login, the Jira changelog's account, or a Slack user id; never from a name in a message. A `[bot]` login is an App's and cannot be taken by a person.
- **A claim only holds.** A forged or mistaken agent claim can delay the built-in fixer; it cannot merge, close or change anything, and **Let {product} take it** overrides it. Claim expiry asks the owner.
- **Hand-off sends the implementation request out.** Only to agents a workspace listed with a `<handoff>`, and only for surfaces that name them. The request is the one the built-in fixer would get: redacted per main 16, no secrets, no tokens. The webhook is HTTPS (http only to `localhost`), signed with a per-target secret from the secrets port, and carries a delivery id; the callback token is scoped to one incident, expires at the deadline, and is domain-separated from the fixer and model tokens.
- **No write is read back as a claim.** The marker and the claim reader's handling of `handoff-sent` (3.8) keep the product's own assignment from holding its own work.
- **Reporters stay private across a merge.** No reporter-facing message names another reporter; a burst card names none.
- **The ledger holds no content.** Times, ids, task, provider, model, token counts and outcome; no prompt, output, key or token. The proxy's metering branch reads usage fields only and logs nothing from the body.
- **Telemetry carries no content.** Spans and JSON logs hold ids, names, counts and durations. Export is off by default; the OTLP endpoint and headers come from the environment and the secrets port, never from the config file.
- **Ops controls are authorized and audited.** Every switch change and stop-all records who, when and why in `ops_switches`; the CLI goes through the server with the caller's token, never straight to the database.
- **The fingerprint registry holds hashes.** Hashed tokens with a bounded TTL; no readable text from a report or a screenshot.

---

## 8. Failure and degradation

| Failure | Behavior |
|---|---|
| The map is invalid after an edit | The previous map stays live (A 6.1); the defaults are always available |
| GitHub cannot be read during a collision check | `collision-checked { skipped }` is recorded and the run proceeds (decision 9.6) |
| A webhook for an agent's pull request is missed | The pre-dispatch and pre-push checks find the pull request; the reconciler (B 8) covers later events |
| A hand-off send fails | Three retries with backoff, then `handoff-failed` and the surface's fallback |
| The agent never opens a pull request | `handoff-failed { reason: 'deadline' }` at the deadline |
| A callback arrives with a bad token or for another incident | 401 or 403; nothing is appended |
| The in-flight registry is full, or the cache is down | No in-flight merge; main 6's searches still run |
| A wrong in-flight merge | **Not the same problem** splits it (4.1) |
| The merge target ends without a ticket | Each added reporter gets **Still broken** (4.1) |
| A dispatch wake-up is lost | The one-minute `fixer.dispatch` cron and startup rebuild catch it |
| The runner cannot start a run | `fixer-failed` (runner error) as today; the row is deleted and the slot freed |
| A queued run waits past `queue-timeout` | `fixer-failed { reason: 'queue-timeout' }` and main 10.4's degrade |
| A ledger write fails | Logged and counted in a metric; the model call or the forwarded response is unaffected |
| A model has no price | Cost is `unknown`, never zero (decision 9.5 for caps) |
| The proxy cannot parse usage | A row with null tokens |
| The ledger cannot be read for a budget check | Fixers and autopilot proceed, the failure is logged and counted, and the soft-cap notice says spend is unknown |
| The telemetry exporter is down | Spans are dropped from a bounded buffer; nothing blocks |
| The switch table cannot be read | Fixers and autopilot behave as paused for that decision; intake proceeds (capture costs no model call) |
| Two workers dispatch at once | The dispatch transaction marks rows; a seq or row conflict retries, and the singleton key refuses a second start |

---

## 9. Open decisions

- **9.1 Decision pending: the actor role of an agent.** Options: (a) a new role value `coding-agent`; (b) `agent`; (c) the existing `unknown` with an `agent:` id prefix. The role column is text, so no migration is needed either way. Recommendation: (a), because the event source `agent` already means the product itself and (b) would read as the same thing.
- **9.2 Decision pending: where in-flight fingerprints live.** Options: (a) a fixed set of slot keys on the cache port (`setIfAbsent` claims a free slot, a lookup reads every slot, ending writes a short-TTL tombstone), matching #100's "no new table"; (b) add `scan(prefix)` and `delete` to the cache port and every provider; (c) read in-flight incidents from the incidents projection and their fingerprints from the log. Recommendation: (a), with 64 slots and a metric when full.
- **9.3 Decision pending: in-flight thresholds.** Options: (a) one threshold, the existing `DEFAULT_DEDUPE_THRESHOLD` (0.6), merging automatically; (b) two: merge automatically at 0.8 or above, show the dedupe card with the in-flight candidate between 0.6 and 0.8. Recommendation: (b), since an automatic merge needs more certainty than a question.
- **9.4 Decision pending: whether a burst needs a tap.** Options: (a) the card's **Treat as one outage** is required before the ladder counts the burst; (b) the burst counts at once, and **Not related** undoes it. Recommendation: (a): correlation across messages is weaker evidence than reactions on one.
- **9.5 Decision pending: unknown-cost calls and the caps.** Options: (a) they do not count toward a cap, and the view shows how many there are; (b) they count at the most expensive known price for the same provider. Recommendation: (b) for the cap check, with "unknown" in every display.
- **9.6 Decision pending: a collision check that cannot read GitHub.** Options: (a) proceed and record it; (b) hold the run and retry at the next dispatch. Recommendation: (a): review, CI and people still guard the result, and a GitHub outage should not stop all fixing.
- **9.7 Decision pending: an agent's open pull request on the same files.** Options: (a) advisory only; (b) serialize as 4.4 does for the built-in fixer's own runs. Recommendation: (a): another vendor's pull request may sit open for days.
- **9.8 Decision pending: Jira display names for agent assignment.** Options: (a) account id only; (b) a declared `name` as well, since some agents' accounts are easiest to name. Recommendation: (b), only where an entry declares `name`, since a display name can be changed by its owner.
- **9.9 Decision pending: who may use ops controls.** Options: (a) engineers, then admins once #133 adds the flag; (b) admins only, with the CLI on the server host as the fallback until then. Recommendation: (a), with **Stop all** admin-only once the flag exists.
- **9.10 Decision pending: a GitHub issue per hand-off on Jira workspaces.** Options: (a) create one, labeled and closed by the agent's pull request; (b) offer `github-assign` and `mention` only where work is tracked in GitHub Issues (E18). Recommendation: (a), so hand-off works before E18.
- **9.11 Decision pending: an unregistered bot's pull request on the key, found by the collision check.** Options: (a) ignore it, as the webhook does; (b) record a `collision-checked` finding for engineers without a hold. Recommendation: (b).

---

## 10. Acceptance

| Id | Behavior | Tier |
|---|---|---|
| C1 | A map with `<agents>` (all three modes, every identity kind, `<handoff>` of each `via`) validates; a duplicate id, an agent with no identity, one GitHub login on two agents, a `mention` without `text` and a `webhook` without `secret` are rejected | unit |
| C2 | Existing example maps validate and round-trip unchanged | contract |
| C3 | `resolveAgents` returns map entries plus defaults; a map entry with a default's id replaces it; `useDefaults="false"` removes them | unit |
| C4 | `isRegisteredAgent` matches case-insensitively and keeps `[bot]` significant | unit |
| C5 | Every default login exists on GitHub and is a bot account | live |
| C6 | A registered agent's pull request naming the key in the branch, title or body appends `agent-claimed { via: 'pr' }` and `pr-opened` (agent actor) once; an unregistered bot's is ignored; one naming no key is ignored | contract |
| C7 | The agent's pull request closed unmerged releases the hold; merged appends `merged` with the agent as actor and the status reaches `merged` | contract |
| C8 | A person's pull request merged without review moves the incident from `in-review` to `merged` | unit |
| C9 | A Jira assignee change to a registered agent appends `agent-claimed { via: 'assignment' }` once; back to a person releases; an unknown account changes nothing new; the product's own assignee change is never a claim | contract |
| C10 | A `yield` claim before the fixer starts files ticket-only (level 0, reason names the agent), posts one status line naming the agent, and starts no fixer | unit |
| C11 | A claim after `fixer-started` is recorded without stopping the run | unit |
| C12 | **Let {product} take it** ends an agent's hold and the configured level applies | unit |
| C13 | The status copy for claimed, merged and released names the agent from the registry and links the pull request without the word "PR" | unit |
| C14 | One Jira comment per claim | unit |
| C15 | Pre-dispatch: an open agent pull request on the key yields; a recent agent push on a keyed branch yields; a person's pull request on the key appends `pr-opened` and starts nothing; a file overlap is recorded and does not hold | unit |
| C16 | Pre-push: an agent pull request appearing during the run stops the built-in fixer before `pushed` through the stop poll | contract |
| C17 | A collision check that cannot read GitHub records `skipped` and proceeds | unit |
| C18 | A surface with `engine="handoff:<id>"` at level 2 sends the hand-off instead of starting the fixer; level 0 never hands off | unit |
| C19 | `github-assign` creates and assigns an issue carrying the request and the marker; `mention` comments once | contract |
| C20 | A webhook hand-off is signed and verifiable; a callback with the right token links the pull request; a bad token is 401 | contract |
| C21 | No pull request by the deadline appends `handoff-failed`; `fallback="none"` degrades to level 2 semantics; `fallback="builtin"` starts the built-in fixer once | unit |
| C22 | A handed-off agent's pull request gets the review, the CI record, the merge gate and the status loop; `request-changes` mentions the agent once and starts no built-in fixer; a second escalates | contract |
| C23 | Stop on a handed-off incident withdraws the hand-off and comments on the agent's pull request without closing it | unit |
| C24 | The product's own hand-off assignment is never read back as a new claim | unit |
| C25 | Bot-authored captures above `agentCapturesPerHour` are dropped and counted | unit |
| C26 | Another bot's reply carrying a tracker key in the thread appears as a dedupe candidate on the card | contract |
| C27 | A person taking over mid-run is shown the last checkpoint, branch and pushed state | unit |
| C28 | A ticket assigned in Jira to a registered agent is filed ticket-only with one line saying who is on it and no fixer starts; the agent's pull request on the ticket's branch is linked and its merge recorded; an unregistered bot's pull request is ignored | e2e |
| C29 | A webhook hand-off at level 2: the pull request is linked, reviewed and reported; no bot ping-pong | e2e |
| S1 | `fingerprintReport` is stable under word order and filler words; two reports of one bug a few seconds apart find each other; two different bugs do not | unit |
| S2 | The registry works on both state dialects through the cache port and ends at filing | contract |
| S3 | A later in-flight report at or above the merge threshold joins the earlier incident: `linked-to-existing { incidentId }` and `reporter-added` in one transaction; its thread follows the target's status; no copy names another reporter | unit |
| S4 | **Not the same problem** splits the report into its own incident; the log keeps both facts | unit |
| S5 | `state rebuild --verify` gives the same views after merges and splits; new events round-trip on both dialects | contract |
| S6 | Ten triggers, three describing one bug, yield eight incidents (mock model) | unit |
| S7 | Three distinct incidents on one surface within the window post one burst card with no names; **Treat as one outage** feeds the ladder and raises priority as A 1.4 prescribes; **Not related** changes nothing and no second card appears | unit |
| S8 | With a cap of 2 and 5 runs, at most 2 run at any time; per-repository caps hold | unit |
| S9 | Slots count from `fixer-started` to its end, not from the runner call | unit |
| S10 | After a restart the queue and slots are rebuilt and no run starts twice | contract |
| S11 | A stop on a queued run removes it; a queued run past `queue-timeout` degrades | unit |
| S12 | Three runs, two sharing a file, with room for all three: the overlapping one waits and starts when the first ends; a run with no files is never blocked; a directory overlaps its files | unit |
| S13 | A queued run's status reads "number N in line", edits in place as runs ahead finish, and is the same on Slack, Teams and `snapwing status` | contract |
| S14 | Every router call appends one ledger row with the served model; a classify retry is two rows; missing usage is null; a ledger failure never fails the call; no prompt text is stored | unit |
| S15 | The proxy meters one streamed and one plain response per provider without buffering the stream; an upstream failure is recorded as `error`; no key, token or prompt reaches the ledger or the logs | unit |
| S16 | `costOf` returns unknown for an unpriced model; `incidentCost` and `dailyCost` sum correctly; every default model has a price row | unit |
| S17 | With a fake clock: the soft cap posts one notice; the hard cap files new incidents ticket-only and holds queued fixers while running ones finish; midnight in `tz` resets and the queue resumes | unit |
| S18 | Each switch takes effect on the next event after it changes; stop-all stops every running and queued fixer and pauses fixers; every change is recorded with who and why | contract |
| S19 | A paused intake captures and parks; resume continues parked captures in order | unit |
| S20 | The Workspace section shows running, queued, waiting, failed and today's spend, with controls only for authorized people; a forged action from anyone else changes nothing | contract |
| S21 | `runs`, `ops`, and the cost lines in `trace` and `metrics` print the documented fields and `--json` | unit |
| S22 | `/metrics` exposes the 4.10 series; JSON logs carry ids and no content; with export off no span leaves the process | unit |
| S23 | Load: ten triggers in 60 seconds, three of them one bug, produce eight incidents; at most the cap of fixers runs and the rest show positions; cost is visible in App Home and `trace`; the kill switch takes effect within one event | e2e |

---

## 11. Test plan by tier

**Unit** (mock model, fake clock, both state dialects where state is touched):

- map: agents parse, validate (XSD and Schematron), round-trip; default resolution; login matching (C1, C3, C4);
- claim reader: claim before filing, mid-flight, release by close, by unassignment, by `let-agent-take`; non-yield modes pinned (C10 to C12);
- lifecycle: the new rows, including `in-review` to `merged` (C8);
- status copy and the single Jira comment (C13, C14);
- collision reader against a fake GitHub client, and its skip path (C15, C17);
- hand-off routing, deadline, fallback, stop and the loop guard rules (C18, C21, C23 to C25, C27);
- fingerprint, registry, merge, split and the eight-of-ten count (S1, S3, S4, S6);
- burst detection and the ladder feed (S7);
- queue caps, slot counting, overlap, timeout and stop (S8, S9, S11, S12);
- ledger, proxy metering with fake upstreams, prices and cost, budget with a fake clock (S14 to S17);
- intake pause, CLI output, metrics rendering and log redaction (S19, S21, S22).

**Contract** (signed fixtures, MSW, both dialects):

- `pull_request` fixtures: an agent's pull request with the key in the branch, in the body only, from an unregistered bot, closed unmerged, merged (C6, C7);
- Jira fixtures: assigned to an agent, reassigned to a person, unknown account, the product's own change (C9);
- the pre-push stop through the fixer API (C16);
- hand-off over GitHub (MSW) and over a signed webhook with its callback (C19, C20), and review of the resulting pull request (C22);
- another bot's reply as dedupe evidence (C26);
- the in-flight registry and the new events on both dialects; `state rebuild --verify` (S2, S5);
- queue rebuild after a simulated restart (S10);
- Slack status rendering of the queued state (S13);
- switches through the composed app; the Workspace section for an authorized and an unauthorized viewer (S18, S20);
- example maps against the new XSD (C2).

**Live:**

- the default agent logins (`scripts/verify-agent-logins.mjs`; skipped without network) (C5);
- the collision reads against the fixture repository (E0, #44): an open pull request, a branch and a file overlap seen through the real API;
- one metered call per configured provider through the model proxy, checking that usage is read from a real streamed response.

**E2e** (the fixture workspace, E0 #44):

- coexistence: a ticket assigned to a registered agent yields and links, and the agent's pull request merge is recorded (C28);
- hand-off: a webhook hand-off at level 2 is linked, reviewed and reported, with no ping-pong (C29);
- load: ten triggers in 60 seconds, three of them one bug, with a cap of 2: eight incidents, the cap held, positions shown, cost in App Home and `trace`, and the kill switch effective on the next event (S23).

---

## 12. Delivery sequence

Each item is about one pull request. Numbers are the epics' task issues; items marked **missing** have no task yet.

**Part 1, coexistence (#47):**

1. #94 `<agents>` registry in the workspace map (3.1, 5.1). `<surface><fixer>` arrives with item 9.
2. #95 Default registry, logins verified (3.2).
3. #96 Agent claim event and hold (3.3), with the B 5 rows of 3.3, including `in-review` accepting `merged`, and the actor role of decision 9.1.
4. #97 Recognize a registered agent's pull request and branch (3.3). It must append `pr-opened` with the claim, or the merge is never recorded.
5. #98 Recognize an assignment from Jira (3.3).
6. #99 Status copy: "Copilot is working on this" (3.4).
7. **Missing:** GitHub client reads (open pull requests, keyed branches and their authors, issues assigned to a login) and the collision reader with `collision-checked` (3.5).
8. **Missing:** pre-dispatch and pre-push collision checks wired into `runFixerJob` and the fixer API's `tested` checkpoint (3.5).
9. **Missing:** `HandoffPort`, `<surface><fixer engine>`, routing at the fixer trigger, `github-assign` and `mention`, deadline and fallback (3.6).
10. **Missing:** the webhook hand-off and its callback endpoint and token (3.6).
11. **Missing:** review, merge gate and status loop for handed-off and `coordinate` pull requests; `coordinate` and `handoff-target` begin to hold (3.7).
12. **Missing:** loop guard: markers, the hand-off acknowledgement, bot-capture rate limit, mention budget, takeover checkpoint (3.8).
13. **Missing:** another bot's "ticket created" reply as dedupe evidence (3.8).
14. **Missing:** the coexistence e2e proofs C28 and C29.

**Part 2, scale (#49):**

1. #100 Fingerprint and in-flight registry (4.1), with decision 9.2.
2. #101 Merge in-flight duplicates into one incident (4.1), with decision 9.3.
3. #102 Fixer caps and a durable priority queue (4.3). Its touches omit two files this design needs: `contracts/jobs.ts` (the `fixer.dispatch` cron) and `fixer/stop.ts` (a stop removes the queued row).
4. #103 File-overlap serialization (4.4).
5. #104 Queue position in the status message (4.5). The `queue` waiting kind lives in `contracts/events.ts` and the status shape in `contracts/adapters.ts`, neither in its touches.
6. #105 Usage ledger in the router (4.6). It and #102 both add a migration; the second to merge takes the next number.
7. #106 Meter the model proxy (4.6).
8. #107 Price table and per-incident cost (4.6).
9. #108 Daily soft and hard caps (4.6). There is no workspace time zone to use (2.2), so `<budget tz>` carries its own.
10. **Missing:** cross-message burst detection, the card and the ladder feed (4.2), with decision 9.4.
11. **Missing:** ops switches: the `ops_switches` table, the checks at capture, dispatch and merge, intake parking, stop-all (4.7).
12. **Missing:** ops controls on Slack (the `/snapwing` subcommands, after #138) and the CLI `ops` command (4.7, 4.9), with decision 9.9.
13. **Missing:** the App Home Workspace section (4.8).
14. **Missing:** the ops digest and the `<notifications><ops>` destination (4.8).
15. **Missing:** CLI `runs`, and cost lines in `trace` and `metrics` once #4 merges (4.9).
16. **Missing:** JSON logs (4.10).
17. **Missing:** OpenTelemetry spans per stage and model call, OTLP export opt-in (4.10).
18. **Missing:** the 4.10 series in `/metrics`, including the main 17 list (4.10).
19. **Missing:** console run list and trace timeline, after the console exists (4.11).
20. **Missing:** the load e2e proof S23.
