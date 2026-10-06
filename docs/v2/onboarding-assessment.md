# Onboarding v2: Assessment of a Broader Onboarding Design

**Status:** draft
**Read after:** the main spec (`docs/SPEC.md`, cited as "main N.N"), especially 4 (the workspace context model), 4.6 (the autonomy dial) and 22 (onboarding); and Companion A (`docs/SPEC-A-signals.md`, cited as "A N") section 6 (the playbook and instructions).
**Feeds:** the epic "Context sources and onboarding v2" (E1, #45) and its companion spec (#66). Tracker rows feed E18 (#62); capability and limitation rows feed E6 (#50).
**Naming:** Snapwing is a working title. New code takes the product name from the brand module (E8), not from literals.

This document assesses a broader onboarding design: a long proposal for a multi-source setup experience (project profiles, a connection registry, design and call-transcript sources, preview environments, stakeholder proposals). It gives each proposed capability one verdict (adopt, adapt, partial or defer) and, for what is adopted, the shape it takes on what already exists: the workspace map's surfaces, channels and people; the playbook and the autonomy dial; the app config and its secrets; and the `snapwing onboard` interview. The result is a subset of roughly two fifths of the proposal. It extends the existing model and does not add the proposal's four configuration objects wholesale. The assessment is the input to the Companion D draft (#66). It is not a contract, and later corrections land as ordinary documentation changes.

---

## 1. Problem and goals

### 1.1 The gap

Snapwing reads a report, finds the code involved and files a ticket. The "finds the code" step sees one kind of source. A report such as "this does not match the design" or "this contradicts the redesign spec" cannot be tied to a design frame or a specification, because nothing but the repository is readable. Setup has a second gap: an install that only wants tickets (chat plus Jira) must supply the GitHub App and coding keys before it starts.

The broader design addresses both, and much more. Most of the "much more" (previews, stakeholder prototypes, call transcripts, cross-tracker dependency resolution) is a separate product direction. The goal here is to separate what extends Snapwing's current shape from what does not.

### 1.2 Goals of this assessment

1. Give every proposed capability one verdict with a reason.
2. For everything adopted, name the existing structure it extends, so no parallel configuration object appears.
3. Fix the acceptance subset the epic proves, and say why the rest is deferred.
4. Record the decisions still open, without making them.

### 1.3 Non-goals

Full contracts, schemas and algorithms for the adopted pieces. Those belong to the Companion D draft (#66). This document gives only the shapes needed to justify a verdict.

---

## 2. Today (verified)

Each statement names the file it was checked against.

**Onboarding.**
- `snapwing onboard` exists as an interview engine: an ordered step registry (`packages/app/src/onboard/steps/index.ts`), a step contract with outcomes `done | blocked | skipped | not-built` (`packages/app/src/onboard/interview/step.ts`), resumable progress in one versioned document under the key `onboarding:state` (`packages/app/src/onboard/interview/state.ts`), a `.env` writer that is the only place a secret goes (`packages/app/src/onboard/interview/env.ts`), and the flags `--step`, `--answers`, `--env-file` and `--status` (`packages/app/src/cli/onboard.ts`).
- All twelve step modules are stubs built with `notBuiltYet(...)`: runtime, slack, teams, jira, github, surfaces, words, people, trigger, autonomy, finish, test-drive (`packages/app/src/onboard/steps/*.ts`). The engine is real; the interview content is not yet written. Main 22.2 specifies nine steps, and none asks where specifications, designs or decisions live.
- The CLI has no `doctor` command (`packages/app/src/cli/main.ts` lists serve, config, state, login, logout, shot, say, log, status, stop, map, token, onboard).

**The workspace map.**
- `schemas/workspace-context.xsd` defines `surfaces` (each with exactly one `repo`, one `jira` binding and optional `components`), `channels` (with `surface`, `confidence`, `platform`, `team`), `triggers`, `vocabulary`, `people` (with `owns`) and `policies` (`askBack`, `autonomy`, `riskGate`). It has no element for a documentation, design or other non-repository source.
- The autonomy dial is `policies/autonomy`: four levels 0 to 3 (ticket-only, fix-on-tap, fix-now, autopilot) with per-surface, per-component and per-priority overrides, each recording `changedBy` and `changedAt` (`schemas/workspace-context.xsd`, main 4.6).

**Playbook and instructions.**
- `schemas/playbook.xsd` holds signals, weights, ladder, claims, notifications, monitor, escalation, userSide and recordings. `INSTRUCTIONS.md` is capped at 4,000 characters and can only make the agent more careful (`packages/pipeline/src/config/instructions.ts`, A 6.3 and 6.4).

**App config and secrets.**
- `schemas/app-config.xsd` defines `runtime`, `models`, `harness`, `merge` and a Jira section. It has no connection element. Credentials are environment names read through a secrets port. `REQUIRED_SECRETS` in `packages/app/src/server/compose.ts` always includes the Jira group and the whole GitHub App group, so a ticket-only install cannot start.

**The scout.**
- The scout reads GitHub through `RepoReader` (`search`, `read`) with fixed caps: 4 queries, 12 hits, 3 files, 4,000 characters per file (`SCOUT_MAX_*` in `packages/pipeline/src/triage/scout.ts`). `TriageResolutionPlan` carries a `diagnosis` with `confidence` and `files`, and has no source references, coverage or unknowns (`packages/pipeline/src/contracts/incident.ts`).

---

## 3. Method

1. The proposal was read section by section and each section reduced to one or more capabilities.
2. Each capability was tested against four questions. Does it serve the goal of #45 (a team points Snapwing at where its specifications, designs and decisions live, and a ticket-only install works)? Does it fit a structure listed in section 2? Can its behavior be proven in the existing test tiers with fixtures the project has or can cheaply add? Does it depend on something Snapwing lacks (a preview environment, a design renderer, a transcript pipeline)?
3. Verdicts follow a fixed rule:
   - **Adopt:** serves the goal, fits an existing structure with little or no change, and is testable now.
   - **Adapt:** serves the goal, but the proposal's structure is replaced by an existing one.
   - **Partial:** a bounded slice is adopted; the rest is named and deferred.
   - **Defer:** depends on something absent, or is a different product direction, or serves no acceptance case in this version.
4. A verdict never rests on the provider names the proposal lists. A provider appears in setup only when an adapter has verified its capability against the account in use. This is the proposal's own caution, adopted as a rule: "connected" is not "ready".

---

## 4. The verdict table

The last column cites the carrying epic by issue number. E1 is #45, E6 is #50, E18 is #62.

| Proposal topic | Verdict | v2 shape | Carried by |
|---|---|---|---|
| Four configuration objects: connection registry, project profile, execution recipes, operating policy | Adapt | Connections: a `<connections>` element in the app config, naming credentials by reference (values stay in the secrets port). Project profile: `<sources>` inside each map surface, so the map's surface is the project. Execution recipes: deferred. Operating policy: stays the playbook plus the autonomy dial; no fourth object | E1 (#45) |
| UX principles (outcome first, discover before asking, partial setup, contextual setup, evidence over assertion, remember, no repeat approvals) | Adopt | Written into Companion D (#66) as design rules. "Connected is not ready" becomes the capability status model. Partial setup is already how the engine works (`skipped`, `blocked`, `not-built` outcomes) | E1 (#45) |
| Entry points: chat install, web settings page, CLI, a task that hits a gap | Adopt, within existing surfaces | Extend `snapwing onboard` and the chat paths of main 22.1. The web settings page waits for a console that does not exist yet. Every entry point keeps writing the same state document | E1 (#45) |
| Select or establish a project (step 1) | Adopt | Already the map's surfaces and `channels`; ambiguity is already the ask-back gate (main 4.4, main 7). No new project object | E1 (#45) |
| Add sources of work and context (step 2) | Adopt | `<sources>` per surface: kind, connection, purpose, authority, visibility. A `SourcePort` with `describe`, `search`, `fetch`, `health`. First adapters: Confluence (reusing the Jira credentials), Figma (read-only REST), a local folder (markdown and PDF), and a generic MCP source limited to an allow-list of read-only tools. An unsupported link is recorded as known and marked unavailable | E1 (#45) |
| Review discovered context (step 3) | Adopt | A new onboarding step after the surface, word and people steps: proposals are suggestions until confirmed, each keeping its source; nothing is written without confirmation (main 4.3). Authority is stated per source, not guessed from recency | E1 (#45) |
| Design context (step 4) | Partial | Read-only retrieval of a named design frame and its metadata (Figma REST). Rendering and visual comparison are deferred because they need a runnable preview. A screenshot-only source is recorded as such, so a consuming agent sees the limit | E1 (#45) |
| Historical context and call transcripts (step 5) | Partial | Documents, and chat history through the existing context collection (main 5). Transcripts of recorded calls, calendar-derived notes and a "last 30 days of my ideas" retrieval are deferred | E1 (#45) |
| Execution and demonstration environments (step 6, section 12) | Defer | Not in this version. Needs a preview adapter, lifecycle states, expiry and cleanup, none of which exist. The test drive (main 22.2 step 9) stays the only end-to-end demonstration | Later epic |
| Operating rules (step 7) | Adapt | Per-source `visibility` and per-source permitted actions (read only in this version), expressed next to the autonomy dial, not as a separate policy object. The dial and playbook stay the only rules for what the agent does | E1 (#45) |
| Capability status and first useful action (step 8) | Adopt | A status enum evaluated per capability, shown by `snapwing doctor`, in an App Home admin section and as the last onboarding step. Values: `not_configured`, `discovering`, `needs_input`, `verifying`, `ready`, `limited`, `unavailable`, each with a reason and evidence | E1 (#45), tasks #78 and #82 |
| Continuing setup during ordinary work ("it is in Confluence") | Adopt, second priority | A short reply or a pasted URL resolves through a registered source; when none matches, offer setup and keep the incident state. Built after the source adapters | E1 (#45) |
| Context package for agents (section 9.1) | Adopt, trimmed | Three fields on `TriageResolutionPlan` and on the ticket: `sourceRefs`, `coverage`, `unknowns`. They are also what the assessment stage reads as limitations | E1 (#45), E6 (#50) |
| Dependency decisions across trackers (section 9.2) | Defer | Needs more than one tracker as a first-class concept. Jira and GitHub are the only trackers in this version; the tracker seam is carried by its own epic | E18 (#62) |
| Absence, conflict and duplicate semantics (section 9.3) | Adopt | Typed outcomes `results | none | denied | error | stale`, so "none" always states its searched scope and "denied" or "error" never reads as "none". Semantic similarity yields candidates only; it never merges two tickets | E1 (#45) |
| Stakeholder and executive proposal workflow (section 10) | Defer entirely | A separate product direction: synthesis of past ideas, prototypes, roadmap reconciliation. No acceptance case in this version | None |
| Design workflow contract (section 11) | Partial | The same slice as the design context row: reference resolution and retrieval. Rendered verification is deferred | E1 (#45) |
| Minimal data model (section 13) | Subset | Four records: `Connection`, `SourceBinding`, `SourceCoverage`, `CapabilityStatus`. `Project` is the map surface. `ExecutionRecipe`, `AgentRun` and `PreviewEnvironment` do not exist in this version. Connections and bindings live in configuration; coverage and status live in the state store | E1 (#45) |
| Access and continuity (section 14) | Adopt | Private source content reaches the model and the ticket system only, never a public channel; a revoked source downgrades its capabilities at once and cached content from it is not reused; external documents are evidence, never instructions; setup progress survives interruption (already true of the interview state) | E1 (#45) |
| Failure and recovery (section 15) | Subset | Only the rows that concern retrieval and capability status. Preview and cleanup rows are deferred with their feature | E1 (#45) |
| Acceptance scenarios ONB-01 to ONB-18 | Subset | See section 6 | E1 (#45) |
| Delivery sequence and evaluation | Adapt | Mapped onto the E1 task issues in section 13. Success is measured by correctly resolved references and fewer wrong or duplicated tickets, not by counts of connected providers | E1 (#45) |

### 4.1 Reading the table

**One map, not four objects.** The proposal separates a connection registry, a project profile, execution recipes and an operating policy because it assumes many projects, many roles and provisioned infrastructure. Snapwing has one map per workspace whose surfaces already play the project role, a playbook and a dial that already are the operating policy, and a secrets port that already keeps credential values out of configuration. Adding the proposal's objects would duplicate those three. The adaptation adds exactly two things: a place to name connections (the app config) and a place to bind a connection's resources to a surface (`<sources>` in the map).

**An illustrative shape.** This sketch shows how the map would carry sources. It is a shape for discussion, not a schema. The Companion D draft (#66) owns the real one, and it must extend `schemas/workspace-context.xsd` without invalidating existing maps.

```xml
<surface id="web" label="Website">
  <repo>acme/web</repo>
  <jira project="WEB" defaultIssueType="Bug"/>
  <sources>
    <source id="redesign-spec" kind="confluence" connection="atlassian"
            purpose="specification" authority="authoritative" visibility="private">
      <scope space="WEB" label="Redesign"/>
    </source>
    <source id="web-ui-kit" kind="figma" connection="figma"
            purpose="design-reference" authority="approved" visibility="internal">
      <scope file="FILE_KEY"/>
    </source>
  </sources>
</surface>
```

```xml
<!-- App config: a name, a kind, and the environment names that hold the credentials. -->
<connections>
  <connection id="atlassian" kind="atlassian" credentials="JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN"/>
  <connection id="figma" kind="figma" credentials="FIGMA_TOKEN"/>
</connections>
```

**Why `authority` is explicit.** The proposal warns that a newer brainstorming summary must not override an approved design. The simplest reading Snapwing can test is a stated `authority` per source and a rule that the agent cites sources with their stated roles instead of ranking them by date.

---

## 5. What is adopted, as contracts

Only the contracts needed to carry the verdicts. The full definitions belong to #66.

```ts
type SourceOutcome<T> =
  | { kind: 'results'; items: T[]; scope: string }
  | { kind: 'none'; scope: string }            // searched, nothing matched; the scope says what was searched
  | { kind: 'denied'; scope: string; reason: string }
  | { kind: 'error'; scope: string; reason: string }
  | { kind: 'stale'; items: T[]; scope: string; asOf: string };

interface SourcePort {
  describe(): SourceDescription;               // kind, what it can do; read only
  search(query: string): Promise<SourceOutcome<SourceHit>>;
  fetch(ref: string): Promise<SourceOutcome<SourceDocument>>;
  health(): Promise<SourceHealth>;
}

interface ContextPackage {                     // added to TriageResolutionPlan and to the ticket
  sourceRefs: { sourceId: string; ref: string; role: string }[];
  coverage: { sourceId: string; outcome: SourceOutcome<unknown>['kind']; scope: string }[];
  unknowns: string[];
}

type CapabilityState =
  | 'not_configured' | 'discovering' | 'needs_input' | 'verifying' | 'ready' | 'limited' | 'unavailable';
```

Rules that follow from the verdicts:
- A `none` outcome always carries the scope it searched. "Not found" without a scope is not a valid result.
- `denied` and `error` never degrade into `none`. A ticket shows them in `coverage`, so a reader sees a gap instead of a false absence.
- `stale` returns what it has and says how old it is.
- The scout's existing grounding rule (`isGroundedDiagnosis`) continues to apply: a diagnosis that cites a file or source reference it never retrieved is rejected.
- A source's `visibility` controls where its content may be written. `private` content goes to the model and the ticket system and is never posted in a channel. This extends the existing rule that credentials never appear in channel messages (main 22.3).

---

## 6. The adopted acceptance subset

The proposal lists eighteen scenarios (ONB-01 to ONB-18). This version proves the seven that match adopted rows, written here as testable behaviors. Tiers follow the project's test tiers: unit, contract, live, e2e.

| Id | Proposal scenario | Behavior this version proves | Tier |
|---|---|---|---|
| ONB-01 | A non-technical user enables intake with existing chat and Jira connections | The interview selects the Jira project and a chat channel, writes the map and `.env` with no manual file edit, and the first report files a ticket | e2e |
| ONB-02 | A documentation-only project has documents and a board but no repository | A surface with sources and no `repo` is valid; sources work; code diagnosis reports `not_configured` instead of failing | contract |
| ONB-03 | A specification is "in Confluence" | A short reply or a pasted URL resolves through the Confluence source and cites the page; several credible matches are offered as a choice | contract, live |
| ONB-05 | The relevant source is known but inaccessible | The incident is retained, `coverage` records `denied` with its scope, and the ticket says so; nothing is silently skipped | contract |
| ONB-09 (retrieval only) | A design mismatch is reported | The linked frame's reference, revision and metadata are attached and cited; no rendered comparison is attempted | contract, live |
| ONB-10 | The design source supplies only an image export | The capability is recorded as image-only and `limited`; the ticket cites the image and says structure is missing | contract |
| ONB-17 | A source used by ready capabilities is disconnected | Affected capabilities become `limited` or `unavailable` immediately and content cached from that source is no longer served | contract |

Two more rows come from E1's own proof rather than the proposal.

| Id | Behavior | Tier |
|---|---|---|
| ONB-A1 | A chat plus Jira install with no GitHub secrets, no coding model keys and no fixer image starts, files a ticket from a report, and shows coding as `not_configured` | e2e |
| ONB-A2 | `snapwing doctor` on that install lists every capability with a state and a reason | contract |

Why these and not the others: each is provable with fixtures that exist or are cheap to add (recorded provider responses at the contract tier, one live Confluence and one live Figma check), and each maps to a row adopted in section 4.

---

## 7. What is deferred, and why

| Deferred | Reason | What would bring it back |
|---|---|---|
| Preview environments and their lifecycle (proposal step 6, section 12, ONB-14 to ONB-16) | Needs a provisioning layer, expiry, cleanup and resource limits. Nothing in Snapwing creates a runnable environment, and rendered design comparison depends on one | A decision to build a preview adapter, with a first provider chosen |
| Rendered design verification (ONB-09 beyond retrieval) | Depends on previews | Previews |
| Stakeholder and executive proposals (proposal section 10, ONB-11, ONB-12, ONB-18) | A different workflow from report-to-ticket: prototype creation, idea synthesis, roadmap reconciliation. Serves no case in this version | A separate design, after the report workflow is proven with sources |
| Call transcripts and calendar-derived history (step 5, remainder) | Needs per-provider retrieval, identity resolution and consent handling; documents and chat history cover the near need | Demand for a specific transcript source |
| Cross-tracker dependency resolution (section 9.2, ONB-04, ONB-06, ONB-07, ONB-08) | Needs several trackers, human-dependency tracking and condition-based unblocking. Jira and GitHub only in this version, with the tracker seam in E18 (#62) | The tracker seam and a second tracker in use |
| Execution recipes, `AgentRun` and `PreviewEnvironment` records (section 13) | Their consumers are deferred | Previews |
| A web settings page (entry point) | No console exists | A console |
| Native Notion and Drive adapters | The generic MCP source covers them with an allow-list of read-only tools | Demand, and a verified read path |
| Configuration snapshots held by in-flight runs (section 4) | A run reads the map once at its start; the snapshot rule matters when runs are long or many | Concurrency work in a later epic |

---

## 8. Interactions with existing specs

| Spec | Section | Interaction |
|---|---|---|
| main | 4.1, 4.2 | `<sources>` extends a surface; the map stays the single place the workspace's shape lives. The extension must keep every existing map valid |
| main | 4.3 | The discovery review is a new confirm step in the flow; "nothing is written without confirmation" stays |
| main | 4.6 | The dial is untouched. Reading sources is read-only and changes no level. A source's permitted actions in this version are read only |
| main | 5 | Context collection stays the source of chat evidence; sources add evidence beside it and do not replace it |
| main | 22, 22.2, 22.3 | A new interview step "where do specifications, designs and decisions live?" joins the registry; secrets still go only through `writeEnv`. The step table in 22.2 gains a row |
| A | 6.1 to 6.4 | The playbook stays the operating policy. Text in a connected document is evidence only and never loosens a rule (A 6.4) |
| E6 (#50) | Assessment | `coverage` and `unknowns` are what the assessment reads as limitations |
| E18 (#62) | Tracker seam | Where work is tracked is a surface attribute that E18 adds; this document adds no competing one |

---

## 9. Security and privacy

- Credentials by reference only: the app config names environment variables; values live in the secrets port and in the `.env` that onboarding writes at mode 0600 (`packages/app/src/onboard/interview/env.ts`).
- A source's `visibility` is enforced at output: private content never appears in a public channel message, a card or a log line. It may appear in the model prompt and in the ticket.
- Revoking a connection downgrades every capability that used it before the next report is processed. Cached content from a revoked source is dropped.
- Retrieved text is data. It may inform a diagnosis and never changes autonomy, permissions, tool access or the playbook.
- The generic MCP source calls only tools on an explicit read-only allow-list; a tool not on the list is not callable, whatever the server offers.
- Read access, ticket creation, fixer dispatch and merge remain separately governed. Only read access is new, and it is governed by the source record.

---

## 10. Failure and degradation

| Situation | Behavior |
|---|---|
| A source is denied or returns an error | The report proceeds without it; `coverage` records the outcome and scope; the ticket states the gap |
| A source search returns nothing | `none` with its scope; never phrased as "does not exist" |
| A source's content is older than its freshness limit | `stale` with the age; used with the label |
| Several specifications match | The candidates are offered as a choice; the diagnosis is not guessed |
| A design source supplies only an image | Capability `limited`; the image is cited and the missing structure is stated |
| A connection is revoked mid-incident | The incident continues on the remaining sources; its context package lists the revoked one as `unavailable` |
| Onboarding is interrupted | Resume from the stored step state; a `blocked` step names who must act |

---

## 11. Open decisions

Each is pending. None is decided here.

1. **Decision pending: where `<connections>` lives.** Options: (a) the app config (`schemas/app-config.xsd`), beside runtime, models and the Jira section; (b) the workspace map, beside surfaces. Recommendation: (a), because connections name credentials, which belong with deployment configuration, and the map is meant to be readable by people who never see secrets.
2. **Decision pending: how sources and surfaces relate.** Options: (a) sources nested in a surface, as sketched; (b) sources declared once and referenced by surfaces, so one Confluence space can serve several surfaces. Recommendation: (b) if shared sources turn out to be common, otherwise (a) for simplicity; test against two real maps before choosing.
3. **Decision pending: the `visibility` vocabulary.** Options: `private | internal | public` (three values), or `private | shareable` (two). Recommendation: three values, since "internal" maps to what may be quoted in an internal channel.
4. **Decision pending: a surface without a repository.** A surface requires one `repo` today (`schemas/workspace-context.xsd`). Options: make `repo` optional; or add a distinct surface kind for documentation-only work. Recommendation: make `repo` optional, with a rule that a fixer cannot start on such a surface.
5. **Decision pending: adapter order.** Options: ship the generic MCP source first (covers more, less control), or native adapters first (less coverage, full control). Recommendation: Confluence and Figma native, then the MCP source with its allow-list.
6. **Decision pending: freshness limits.** Options: one global limit, or a limit per source kind. Recommendation: per kind, with a global default.

---

## 12. Test plan by tier

- **Unit:** outcome typing of `SourcePort` results (every adapter returns one of the five outcomes and never throws for a denial); the capability evaluator for each state and its reason; the visibility rule on output; the allow-list on the MCP source; map validation with and without `<sources>`.
- **Contract:** recorded responses for Confluence and Figma in the existing mock-server style, covering results, none, denied, error and stale; ONB-02, 03, 05, 09 (retrieval), 10 and 17; the doctor output (ONB-A2); a map written before this change still validates.
- **Live:** one Confluence page found and cited; one Figma frame resolved from a link. Each check is guarded so a missing credential skips it and says so.
- **E2E:** ONB-01 and ONB-A1 against a fresh fixture, with the ticket-only compose starting without GitHub or coding secrets.

---

## 13. Delivery sequence

The existing task issues under E1 (#45) are the first slice and need no change in scope: #78 capability status model and evaluator; #79 split compose's required secrets by capability; #80 compose builds without GitHub or coding when they are not configured; #81 disabled actions say why; #82 a minimal `snapwing doctor`. Together they deliver ONB-A1 and ONB-A2 and the status half of the adopted rows.

The second slice is listed in E1's work list without task issues yet. Suggested split, each about one pull request:

| Proposed task | Delivers | Needs |
|---|---|---|
| `SourcePort` and the five outcomes, with a fake adapter | The contract and the typing tests | none |
| `<sources>` and `<connections>` in the schemas, with validation and a backward-compatibility test | Config shape | decisions 11.1 to 11.4 |
| Confluence adapter | ONB-03 (retrieval) | `SourcePort`, config |
| Figma adapter (read-only) | ONB-09 (retrieval), ONB-10 | `SourcePort`, config |
| Local folder adapter (markdown, PDF) | Documents without a provider | `SourcePort` |
| Generic MCP source with an allow-list | Notion, Drive, other design tools | `SourcePort` |
| Context package on `TriageResolutionPlan` and the ticket | `sourceRefs`, `coverage`, `unknowns`; the input E6 (#50) reads | adapters |
| Agentic scout over code and sources, bounded by step and token budgets | Cited cross-source diagnoses | context package |
| Onboarding step "where do specifications, designs and decisions live?" and the discovery review | Interview content | the step registry, config |
| Contextual setup ("it is in Confluence", a pasted URL) | ONB-03 end to end | adapters, the incident store |
| Source access: visibility enforcement and revocation downgrade | ONB-17, the privacy rules | status model (#78) |
| App Home admin section for capability status | Status in chat | #78 |

Missing from the current work list: a task that makes `repo` optional on a surface (decision 11.4) and a task for freshness limits (decision 11.6). Both should be added once their decisions are made.
