# Snapwing Companion C Integration Notes: Assessment and Next-Action Routing

Companion C adds a stage after triage that reads the evidence a report already produced and recommends the next action (fix now, investigate, ask, plan, hand to a person), with its reasons and a separate judgment for size, uncertainty, change risk and the action itself. This document summarizes that design in one page (section 1), maps it onto the code that exists today (section 2), and specifies stage 1: the assessment runs in recommend-only mode, shows its recommendation on the next-step card, and changes nothing about what executes. It also records one amendment: change risk takes the numeric risk index from #58, while the other judgments stay separate and are never combined into one score.

**Status:** draft
**Read after:** the main spec (`docs/SPEC.md`, "main N.N"), Companion A (`docs/SPEC-A-signals.md`, "A N") and Companion B (`docs/SPEC-B-persistence.md`, "B N"). Section 4.6 (autonomy dial) and section 8 (triage plan and the Fix Preview Card) of the main spec are the ones this document extends.
**Naming:** the product is a working title. New code takes the product name from the brand module (E8), never from a literal.
**Re-check rule:** every "Today" statement below was verified against `main` on the day of writing and names its file. Section 2 must be re-checked at the v1 release candidate, and again before the first pull request of stage 1 is opened (section 10).

---

## 0. Principles (carried over from the design)

1. **A fix is a conclusion, not a default.** After this companion, the fixer runs when the assessment says a bounded fix is advisable and the autonomy level allows it. Both must agree. Stage 1 implements only the recommendation half.
2. **Four independent judgments, never one score.** Size, uncertainty, change risk and the recommended next action are separate fields, each with its own confidence and evidence. No code path, card, field or log line may combine them into a single number or label.
3. **Evidence or it did not happen.** Every material conclusion cites evidence labeled `observed`, `reported` or `inferred`. A report is not a reproduction; a likely code path is not a confirmed cause.
4. **Recommend always, act only when allowed.** The recommendation is produced at every autonomy level. Whether anything executes is decided by the dial and policy, never by the model. In stage 1 nothing executes because of an assessment.
5. **Failure never falls through to the fixer.** An assessment that cannot be produced, validated or trusted leaves the ticket filed and the incident waiting on a human.
6. **Assessments are events.** An assessment is a versioned artifact plus an event; revisions are new events (A 4.2, B 4).

---

## 1. Problem and goals, and the design in one page

### 1.1 Problem

Today every incident that reaches triage flows toward the fixer, gated only by the autonomy level (main 4.6). The triage plan names a likely diagnosis and files a ticket, but nothing says whether a fix is the right next step. A vague report with no reproduction, a one-line change in authentication code and a well-understood localized bug all look the same to the pipeline, and they differ only in the tap a human gives or does not give. The maintainer sees a bare card.

### 1.2 Goals

- After triage, produce one validated `Assessment`: size, uncertainty, change risk and a recommended next action, each with confidence, rationale and evidence references.
- Show the recommendation and the three other judgments side by side on the next-step card, replacing the Fix Preview Card (main 8.2).
- Introduce it with `mode="recommend"`: assessments are published, no assessment starts, stops or reroutes anything, and no incident changes autonomy level because of one.
- Keep the design extensible to routing (later stages) without reshaping the stage 1 contracts.

### 1.3 Non-goals

- Executing any recommended action. Later stages are listed in section 10.2 and are not specified here.
- Priority, severity and business impact. They stay in their existing fields (main 8, A 1.4). Size is never derived from them and never sets them.
- Organizational context (calendars, roadmaps, design systems). Missing context raises uncertainty and is recorded as a limitation; Snapwing does not pretend to have checked.

### 1.4 The design in one page

**Placement.** The new order is: capture, context, scope card, resolve, dedupe, clarify (gated), triage plan, **assess**, file the ticket, **route**, next-step card, then execute if allowed. In stage 1 "route" produces a recommendation and a permission result for the record and does not dispatch.

**Input: the evidence packet.** A versioned artifact assembled from what the pipeline already holds: the report and screenshot readings, the resolution, the dedupe result, the triage plan and the scout diagnosis, any clarify answer, blockers already in the log (holds, claims, escalations), known limitations (search errors, no test command) and the policy versions in force. Evidence items are `{ id, kind, sourceRef, claim }`. An assessment whose `evidenceRefs` do not resolve is rejected.

**Four judgments.**

| Judgment | Values | Notes |
|---|---|---|
| Size | `XS`, `S`, `M`, `L`, `XL`, `unknown` | Work to implement and verify the understood scope. Optional range and condition. Unknown cause raises uncertainty, not size. |
| Uncertainty | `low`, `medium`, `high` | Unresolved facts or decisions that could change the approach. Each unknown records its question, effect, kind (`factual`, `product-decision`, `verification-gap`) and the smallest way to resolve it. |
| Change risk | `low`, `medium`, `high`, `unknown` (plus the numeric index, section 6) | Adverse effects of the candidate change, separate from the harm the bug is causing. Unknown is never treated as low. |
| Next action | one of eight actions | `investigate`, `request_clarification`, `convene_decision`, `plan_change`, `split_work`, `implement_fix`, `use_existing_escalation`, `no_change`. One primary action per assessment, with objective, brief, required result and stop condition. |

Confidence (`low`, `medium`, `high`) is recorded separately for each judgment. No numeric probabilities until calibration measures them.

**Routing (later).** Two gates must both pass: advisability (the assessment and a routing policy choose the action) and permission (the autonomy dial decides what runs without a tap). `no_change` is never executed automatically. Stage 1 computes the advisable action and records which permission result routing would have returned (`auto` or `needs-tap`), but dispatches nothing.

**Failure.** One structured `classify` call with one repair attempt (the existing `withValidation` retry). On failure the ticket stays filed, an `assessment-failed` event is recorded, the card says a person is needed, and the fixer is never started as a consequence.

**Presentation.** A compact section on the Jira ticket (through the outbox) and the next-step card in chat. The status message gains plain-language wording and posts an update only when the first assessment arrives, the action changes or the execution status changes.

---

## 2. Today (verified against `main`)

Each row names the file. Re-check every row at the v1 release candidate (section 10.3).

| Hook | Today | File |
|---|---|---|
| ModelTask union | `'triage' \| 'segmentation' \| 'vision' \| 'clarify' \| 'scout' \| 'review'`: six tasks. No assessment task exists. | `packages/pipeline/src/ports/model.ts` |
| Config mirror | `MODEL_TASKS = ['triage', 'segmentation', 'vision', 'clarify', 'scout', 'review'] as const`; `ModelTask` there is derived from it, and a comment says it has "the same six values" as the port's union. `<model task="...">` rows are parsed with `oneOf(MODEL_TASKS, ...)`, so an unlisted task is a config error. | `packages/pipeline/src/config/app-config.ts` |
| Router defaults | `DEFAULT_MODELS` is `Record<ModelProvider, Record<ModelTask, string>>` with a model name for each of the six tasks under each of `anthropic`, `openai` and `google`. Adding a task without a row for every provider fails the type check. | `packages/pipeline/src/models/router.ts` |
| XSD enum | `<xs:simpleType name="ModelTask">` enumerates the same six values. `<models>` allows one `<model>` per task (`OneModelPerTask`). | `schemas/app-config.xsd` |
| Recorded mock | Fixtures are keyed by task, schema name and a hash of the request: `<fixturesDir>/<task>/<schemaName>/<sha256>.json`. A new task therefore needs a new fixtures directory and a recorded answer per case. | `packages/pipeline/src/models/mock.ts` |
| Structured calls | `classify<T>` takes a `schemaName`, a `JsonSchema` and a `validate` guard; the shared wrapper retries once with the validation error appended and reports `attempts: 1 \| 2`. | `packages/pipeline/src/ports/model.ts`, `packages/pipeline/src/models/router.ts` |
| Prompts | XML prompts live beside the code: `triage.xml`, `clarify.xml`, `review.xml` and others. There is no assessment prompt. | `packages/pipeline/src/prompts/` |
| Autonomy | `resolveAutonomy(resolution, plan, map)` is a pure function returning `AutonomyLevelId` (0 to 3). Overrides are considered component, then surface, then priority; the lowest matching level wins; otherwise `map.policies.autonomy.default`. It is called from triage planning (`triage/plan.ts`, which stores the result as `plan.autonomyLevel`), from the merge job at merge time (`merge/job.ts`) and from instruction handling (`config/instructions.ts`). `degrade(level, reason)` drops one level. | `packages/pipeline/src/policy/autonomy.ts` |
| Fix preview card | `buildFixPreview(incidentId, card, opts)` renders the diagnosis, a facts line (surface, owner, priority) and the files the scout named. Level 1 engineers get `Fix it` (`approve_fix`), `Ticket only` (`ticket_only`) and `Not a bug` (`dismiss`); levels 2 and 3 get `Stop` and `Not a bug` and a "Fixing now" badge. The card is the `fix-preview` member of the `InteractiveCard` union. | `packages/app/src/adapters/slack/cards/cards.ts`, `packages/pipeline/src/contracts/adapters.ts` |
| Fix preview wiring | The orchestrator treats `fix-preview` as a phase with three allowed answers (`approve_fix`, `ticket_only`, `dismiss`). The Slack interactivity handler maps the `triage_actions` block to the `fix-preview` role and records `bot-message-posted { role: 'fix-preview' }`. | `packages/pipeline/src/engine/orchestrator.ts`, `packages/pipeline/src/engine/cursor.ts`, `packages/app/src/adapters/slack/interactivity.ts` |
| Ticket timing | At level 1 the ticket is not filed when `planned` is appended; it is filed after the card is answered (`create-issue` is enqueued only `if (level !== 1)`). At levels 0, 2 and 3 it is filed with `planned`. | `packages/pipeline/src/engine/steps.ts` |
| Events | The event type list has no assessment events. `waiting-changed` carries `waitingOn.kind` in `ci`, `review`, `human`, `deploy`, `hold`, `nothing`. | `packages/pipeline/src/contracts/events.ts`, `packages/pipeline/src/contracts/signals.ts` |
| Artifacts | Triage writes `plan` and `implementation-request` artifacts through `tx.putArtifact`. There is no `evidence-packet` or `assessment` kind. | `packages/pipeline/src/engine/steps.ts` |
| Sensitive paths | The workspace map has no `<sensitive>` declaration. The only path-based risk control is the merge risk gate (`maxFiles`, `maxDiffLines`, `forbidden` globs), configured under `<merge>` in `snapwing.config.xml`. | `packages/pipeline/src/merge/gate.ts`, `packages/pipeline/src/config/app-config.ts` |
| Numeric risk | No risk index exists. The merge gate returns pass or fail with a list of problems. | `packages/pipeline/src/merge/gate.ts` |
| Config root | `snapwing.config.xml` has `<runtime>`, `<models>`, `<harness>`, optional `<merge>` and optional `<jira>`. There is no `<assessment>` element. | `schemas/app-config.xsd` |

Two mismatches with the design are worth stating up front:

1. **Level 1 files the ticket after the card.** The design files the ticket before routing at every level so that ticket persistence survives any assessment failure. Today level 1 files after the tap. Section 5.4 decides how stage 1 handles this.
2. **Sensitive paths are not declared anywhere.** The design grounds change risk in `<sensitive>` entries shared with the merge gate. Until those exist, stage 1 change risk can only be `unknown` for path-based factors, which is the honest value (never treated as low). Section 6 covers how this meets the risk index.

---

## 3. The model task and its mirrors

### 3.1 Stage 1 adds one task

Stage 1 adds `assess`. The design also names `investigate` and `plan`; those belong to later stages and are not added now.

A new task must change four places in the same pull request, plus the recorded fixtures, because the type system covers only some of them:

| Place | Change | Enforced by |
|---|---|---|
| `ModelTask` in `packages/pipeline/src/ports/model.ts` | Add `'assess'` | Type check |
| `MODEL_TASKS` in `packages/pipeline/src/config/app-config.ts` | Add `'assess'`; update the "same six values" comment | Type check only if a test compares the two lists (see below) |
| `DEFAULT_MODELS` in `packages/pipeline/src/models/router.ts` | Add `assess` under `anthropic`, `openai` and `google` | Type check (`Record<ModelProvider, Record<ModelTask, string>>`) |
| `ModelTask` enum in `schemas/app-config.xsd` | Add `<xs:enumeration value="assess"/>` | XSD validation of config files; a drift test (below) |
| `docs/SPEC.md` section 14.5 | Update the union shown there | Review |
| Recorded fixtures | `packages/pipeline/test/fixtures/models/assess/<schemaName>/` with one recording per acceptance case | Mock provider lookup |

Two drift risks remain because the port's union and `MODEL_TASKS` are declared separately (the config's `ModelTask` type is derived from the array, the port's is a literal union). Stage 1 adds a unit test that asserts all three lists (port, config array, XSD enum) are equal as sets, so a future task cannot be added to only some of them. This is a missing task (section 10.1, A2).

**Default model for `assess`.** Decision pending: which default model per provider. Options: (a) the same model as `triage` (the assessment reads the same evidence and needs the same reasoning depth); (b) the `scout` model (strongest, slower, costs more per incident); (c) the `clarify` model (cheapest, risk of weak judgments). Recommendation: (a), revisited once evaluation data exists. Workspaces can already override per task with `<model task="assess" .../>`.

### 3.2 Contract

```typescript
// packages/pipeline/src/contracts/assessment.ts (new)

export type Size = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'unknown';
export type Level3 = 'low' | 'medium' | 'high';
export type Confidence = Level3;
export type NextActionType =
  | 'investigate' | 'request_clarification' | 'convene_decision' | 'plan_change'
  | 'split_work' | 'implement_fix' | 'use_existing_escalation' | 'no_change';

export interface Evidence { id: string; kind: 'observed' | 'reported' | 'inferred'; sourceRef: string; claim: string; }

export interface Unknown {
  question: string;
  kind: 'factual' | 'product-decision' | 'verification-gap';
  deciders?: 'one' | 'several';   // product decisions only
  effect: string;
  resolution: string;
}

export interface RiskIndex {
  /** 0 to 100, from the risk index (section 6). Absent until the index exists or when it cannot be computed. */
  score: number;
  band: Level3;
  /** Each factor with the points it contributed; deterministic factors first. */
  factors: { id: string; label: string; points: number; deterministic: boolean }[];
  indexVersion: string;
  calibrated: false;              // stays false until calibration has enough outcomes
}

export interface Assessment {
  schemaVersion: 1;
  assessmentId: string;           // ULID
  revision: number;
  supersedes?: string;
  incidentId: string;
  jiraKey?: string;
  packetRef: { artifactId: string; version: number };
  codeRef?: { repo: string; commit: string };
  rubricVersion: string;
  routingPolicyVersion: string;
  scopeSummary: string;
  size: { value: Size; range?: { min: Size; max: Size }; condition?: string; confidence: Confidence; rationale: string; assumptions: string[]; evidenceRefs: string[] };
  uncertainty: { level: Level3; confidence: Confidence; unknowns: Unknown[]; rationale: string; evidenceRefs: string[] };
  changeRisk: {
    level: Level3 | 'unknown';
    confidence: Confidence;
    index?: RiskIndex;            // section 6; absent in a build that has no index yet
    factors: { area: string; failureMode: string }[];
    checks: string[];
    rationale: string;
    evidenceRefs: string[];
  };
  nextAction: {
    type: NextActionType;
    executor: 'investigator' | 'clarify' | 'decision' | 'planner' | 'fixer' | 'escalation' | 'none';
    objective: string; confidence: Confidence; rationale: string; assumptions: string[];
    brief: string; requiredResult: string; stopCondition: string; budgetRef?: string; evidenceRefs: string[];
  };
  evidence: Evidence[];
  limitations: string[];
  createdAt: string;              // ISO 8601
}
```

The `schema` passed to `classify` and the `validate` guard are generated from one definition so they cannot drift. `changeRisk.index` is filled by deterministic code after the model answers (section 6), never by the model.

Validation beyond the JSON schema: enums; every `evidenceRefs` entry resolves within `evidence`; `range.min <= value <= range.max` when present; an `unknown` size has no range; an `unknown` risk may have empty factors only with a rationale; `convene_decision` needs a product-decision unknown with `deciders: 'several'`; `implement_fix` needs a non-empty verification path; `no_change` needs at least one `observed` or `reported` evidence item that establishes the disposition. One repair attempt through the existing retry, then `assessment-failed`.

---

## 4. Autonomy: resolution stays as it is, and the assessment never changes it

`resolveAutonomy` (`policy/autonomy.ts`) stays a pure function of the map, the resolution and the plan. Stage 1 makes no change to it, and the assessment is not an input to it.

This is the stage 1 safety property: **with `mode="recommend"`, no incident changes level because of an assessment.** Concretely:

- `plan.autonomyLevel` is still the output of `resolveAutonomy` and nothing else. The assessment step runs after `planned` and reads the level; it never writes it.
- `degrade` is unchanged and is not called by the assessment path.
- The merge job still re-resolves the level at merge time (`merge/job.ts`) from the map, not from any assessment.
- A static check (a unit test over the assessment module's imports) asserts that the assessment code does not import `degrade` and that no function in it returns an `AutonomyLevelId`.

Stage 1 does record what routing would have permitted: `next-action-recommended` carries `permission: 'auto' | 'needs-tap'`, computed from the resolved level and a table that mirrors design section 7.1. Because mode is `recommend`, a result of `auto` is informational. This lets the evaluation step (section 10.2) compare recommendations with what the pipeline actually did, which is the data needed before any later stage is considered.

When routing arrives, the function that combines the recommendation with the level is a new function that takes the resolved `AutonomyLevelId` as input. It does not extend `resolveAutonomy`, so the dial's resolution rules (most restrictive wins; most specific first) remain testable on their own.

---

## 5. Stage 1: recommend only

### 5.1 Configuration

A new optional element in `snapwing.config.xml`, validated by `schemas/app-config.xsd`:

```xml
<assessment rubric="sizes-v1" policy="routing-v1" mode="recommend">
  <size-anchors>
    <anchor size="XS">A route constant or copy fix with an existing test</anchor>
    <anchor size="M">A checkout edge case touching cart and promo with new tests</anchor>
  </size-anchors>
</assessment>
```

XSD sketch (added beside `<merge>` and `<jira>` in the root sequence, `minOccurs="0"`):

```xml
<xs:element name="assessment" minOccurs="0">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="size-anchors" minOccurs="0">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="anchor" minOccurs="0" maxOccurs="unbounded">
              <xs:complexType>
                <xs:simpleContent>
                  <xs:extension base="xs:string">
                    <xs:attribute name="size" type="AnchorSize" use="required"/>
                  </xs:extension>
                </xs:simpleContent>
              </xs:complexType>
            </xs:element>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
    <xs:attribute name="rubric" type="xs:string" default="sizes-v1"/>
    <xs:attribute name="policy" type="xs:string" default="routing-v1"/>
    <xs:attribute name="mode" type="AssessmentMode" default="recommend"/>
  </xs:complexType>
</xs:element>
<!-- AssessmentMode: recommend. "execute" is added by the routing stage, not by stage 1. -->
<!-- AnchorSize: XS, S, M, L, XL -->
```

Rules:

- **Absent element means the stage is off.** No assessment call is made and the pipeline behaves as it does today. The stage is opt-in for the first release that contains it.
- **`mode` accepts only `recommend` in stage 1.** The XSD enumeration lists one value, so a config that says `mode="execute"` fails validation with a clear message rather than silently doing nothing. The routing stage widens the enumeration.
- The fixer profile, budgets and per-surface allowances from the design are not in the stage 1 schema; they arrive with routing.
- The parser follows the existing pattern in `app-config.ts` (`oneOf`, `requiredAttr`, `AppConfigError`) and exposes `assessment?: AssessmentConfig` on the loaded config.

### 5.2 Stage placement and behavior

A new `assess` step runs after `planned` is committed and before the card is posted. It:

1. Builds the evidence packet from the incident's existing artifacts and events and stores it as an artifact of kind `evidence-packet`.
2. Makes one `classify` call with `task: 'assess'`, using a new prompt `packages/pipeline/src/prompts/assess.xml` that extends the triage prompt's evidence block.
3. Validates the result (section 3.2), fills `changeRisk.index` if the index exists (section 6), stores the `assessment` artifact and appends `assessed`.
4. Computes the recommendation's permission result and appends `next-action-recommended` (section 4).
5. Hands the assessment to the card step.

Idempotency: one assessment per packet revision, with the singleton key `assess:{incident}:{packetRevision}`. Equal events produce no second assessment and no second message. The step is idempotent on replay in the same way the existing steps are (the cursor derives the phase from the log, `engine/cursor.ts`); this needs a new `assess` phase in the cursor, which is part of the step task.

New events (added to `contracts/events.ts`): `assessed`, `assessment-failed`, `next-action-recommended`. Payloads follow the design: an artifact reference and revision, the four headline values and `supersedes` for `assessed`; reason and packet reference for `assessment-failed`; action, executor, objective, permission result and the rule that decided it for `next-action-recommended`. The other design events (`next-action-started`, `next-action-finished`, `assessment-overridden`, `decision-requested`, `decision-recorded`) belong to later stages.

New artifact kinds: `evidence-packet` and `assessment`, both versioned (B 3).

Projections: the incident row gains `size`, `uncertainty`, `change_risk`, `next_action` and `assessment_revision` (B 3 schema, B 7.2 field map). The Jira display fields (`Size`, `Uncertainty`, `Change Risk`, `Next Step`) are optional and created only when the workspace opts in; routing never reads them.

### 5.3 The next-step card

`buildFixPreview` becomes the next-step card. The card is the same message in the same place (it keeps the `triage_actions` block and the `fix-preview` role so existing interactivity, cursor phases and recorded `bot-message-posted` roles continue to work), with new content:

> **Next step: investigate** (Snapwing recommends; high confidence)
> Mobile menu does not open; the click handler in shared navigation is a candidate. Not yet reproduced.
> Size S (conditional) · Uncertainty high · Change risk medium, 41/100 (shared navigation; uncalibrated)
> [Fix it] [Ticket only] [Not a bug]

Rules:

- **Four judgments, shown separately.** Each is its own labeled item with its own confidence. The card never shows a combined score, a traffic-light roll-up, or a sort key built from more than one judgment.
- **Reporters see plain language** (main 20.1: no file paths, no jargon): the recommended action in words and "low-risk change" style wording for risk, not the index. Engineers see the index and factors (section 6).
- **Buttons are unchanged in stage 1.** `Fix it`, `Ticket only` and `Not a bug` keep their action ids and their per-level, per-role rules from `buildFixPreview`. The recommendation does not add, remove or reorder buttons, and `Fix it` still works at level 1 even when the recommendation says `investigate`, because stage 1 changes nothing about what a human may do. (The design's `Do it` and override menu arrive with routing.)
- **The existing diagnosis and touched-files lines stay** (from `plan.diagnosis`), so a card without an assessment (stage off, or `assessment-failed`) is exactly today's card.
- **Failure rendering.** When the assessment fails or is invalid, the card shows today's content plus one line saying the recommendation is unavailable and a person decides. It never shows a partial or default recommendation.
- **Level 2 and 3 cards** are informational and post after the fixer has started, as today. In stage 1 the recommendation appears on them as information only; it cannot hold or stop the fixer. Decision pending: whether the card at levels 2 and 3 shows a recommendation that contradicts what is already running (for example "recommends investigate" beside "Fixing now"). Options: (a) show it, flagged "Snapwing would have recommended a different step", which produces the most useful evaluation data and is the recommendation; (b) hide it at levels 2 and 3 and record it in the log only.

Contract change: the `fix-preview` member of `InteractiveCard` (`contracts/adapters.ts`) gains an optional `assessment` summary (the four headline values, confidence, the one-line rationale and, for engineers, the index factors). The field is optional so the Teams adapter, which does not render it yet, keeps working (Teams parity follows the Teams card work).

### 5.4 Ticket timing

The design files the ticket before the card at every level. Today level 1 files after the tap (section 2). Decision pending: how stage 1 treats this. Options:

- **(a) Leave level 1 as it is.** The assessment runs before the card; if it fails the card still posts, and the ticket is filed after the tap as today. No ticket-timing change, no risk to existing behavior. Principle 5 holds in stage 1 because nothing acts on the assessment.
- **(b) File at level 1 before the card.** Matches the design and survives assessment failure, but changes level 1 behavior for every workspace (a ticket appears before a human has decided anything, and `Not a bug` then needs a close transition) and is a separate, reviewable change.

Recommendation: (a) for stage 1, and (b) as its own task when routing is scheduled, since only routing makes it necessary.

### 5.5 Presentation on the ticket

When the ticket is filed, the assessment (if it exists) adds one compact section to the description through the existing Jira outbox (B 7.1), revised in place on a new revision, with `recommended` always distinguished from `running` (in stage 1 the status is always `recommended`). If the ticket is filed before the assessment finishes (it is not, in the order above, but a late reassessment could be), the section is added by an `update-issue` outbox row.

---

## 6. Change risk and the risk index (amendment)

### 6.1 The amendment

Companion C defines change risk as `low`, `medium`, `high` or `unknown`. The risk index (#58) defines a number from 0 to 100 with a factor breakdown and configurable bands (default low below 25, medium 25 to 59, high 60 and up). The amendment:

- **Change risk takes the numeric risk index.** `changeRisk.index` carries the score, band, factors and version from #58. When an index exists, `changeRisk.level` is the index's band, not a separate model opinion. The model's role for change risk is reduced to the judged factors the index asks it for, and to rationale text.
- **The other three judgments stay separate.** Size, uncertainty and the next action keep their own fields, scales and confidences. The index is a measure of change risk only. It is never added to, averaged with or ranked together with size or uncertainty, and no field, card or sort key is a combined score. Uncertainty may appear as one input factor to the index (the index design lists it as a factor), which is a use of the uncertainty judgment as evidence about risk, not a blend of the two outputs: both are still reported separately.
- **`unknown` survives.** If the index cannot be computed (no sensitive-path declarations, no code access), `changeRisk.level` is `unknown` and `index` is absent. Unknown is never mapped to low, and the card says the risk could not be assessed.
- **Uncalibrated until measured.** The index is labeled "uncalibrated" wherever it is shown until the calibration stage has enough recorded outcomes (`RiskIndex.calibrated` stays `false`).

An architecture decision record documents this amendment, in the same pull request as the first change that reads the index. It records the principle ("four judgments, never one score, because the index covers change risk only"), the band-to-level mapping, and that the band and not the model decides `changeRisk.level` when an index exists.

### 6.2 Dependency and order

The index is delivered by #58 (E14), which is scheduled in the same wave as stage 1. Stage 1 must not wait for it:

- **Without the index,** stage 1 ships with `changeRisk.index` absent and `changeRisk.level` from the model's judgment against the evidence packet, with `unknown` when path-based factors cannot be grounded (section 2: no `<sensitive>` declarations exist).
- **With the index,** a small follow-up task fills `changeRisk.index` from #58's scoring function and switches `changeRisk.level` to the band.

The seam is one function, `riskIndexFor(packet): RiskIndex | undefined`, defined in the assessment module and implemented by the risk module when it lands. Stage 1 ships it returning `undefined`. This keeps the contracts stable and makes the two epics independent in time.

### 6.3 Shared inputs

The design uses `<sensitive>` declarations in the workspace map for risk before the change and says the merge gate uses the same source. Today the gate has only `forbidden` globs (section 2). Declaring sensitive paths is owned by #58 (the index lists declared sensitive paths as a factor); stage 1 reads them if they exist and does not define them. Decision pending: whether `<sensitive>` lives in the workspace map (`schemas/workspace-context.xsd`, per surface, as the design sketches) or in `<merge>` in `snapwing.config.xml`. Recommendation: the workspace map, because sensitivity is a property of a surface and component, the same place ownership lives, and the merge gate can then read it instead of keeping a second list. This decision belongs to #58 and is recorded here only because both documents depend on it.

---

## 7. Interactions with existing specs

| Spec | Interaction |
|---|---|
| main 3 (pipeline overview) | A new `assess` stage between triage and filing/card. Stage order text and the diagram need an update when stage 1 merges. |
| main 4.6 (autonomy dial) | Unchanged in stage 1. The assessment never changes a level (section 4). The design's permission table (design 7.1) is recorded as informational. |
| main 7 (ask-back gate) | Unchanged in stage 1. A later `request_clarification` action reuses the gate's card and question; the assessment's unknown becomes the gate's question. |
| main 8.1, 8.2 (triage, Fix Preview Card) | The scout diagnosis is evidence for the assessment, not replaced by it. The Fix Preview Card becomes the next-step card (section 5.3). |
| main 11.3 (autopilot) | The merge risk gate is unchanged. The index will later feed a `maxRiskIndex` limit (owned by #58). |
| main 12 (status loopback) | The status message gains wording for the recommendation and posts only when the first assessment arrives, the action changes or the execution status changes. |
| main 14.5 (model and harness ports) | `ModelTask` gains `assess` (section 3). |
| A 1.3 (target roles) | The next-step card keeps the `fix-preview` role, so reaction handling on it is unchanged. |
| A 4.2 (event log) | Three new event types (section 5.2). |
| B 3, B 4 (schema, event rules) | New artifact kinds, projection columns and event types; `expectedSeq` rules apply unchanged. |
| B 5 (lifecycle) | Stage 1 adds no lifecycle state: assessment completes within the planning window. Later stages add `assessed`, `investigating`, `planning` and `awaiting-decision` states. |
| B 7 (Jira projection) | One revised-in-place description section and optional display fields, written through the outbox. |

---

## 8. Security and privacy

- **No new data leaves the existing boundary.** The assessment call sends what the triage call already sends (the bundle, readings, plan and scout diagnosis) to the same provider selected for the task. Sensitive screenshot readings stay redacted before rendering into any prompt (the existing redaction in `context/segment.ts` applies to the evidence packet builder, which must use the same rendering path, not a copy).
- **The packet is not a new copy of secrets.** It stores references and claims, not raw attachments. The same retention as other artifacts applies.
- **Model output is untrusted.** It is validated against the schema, evidence references must resolve, and the `index` and `permission` fields are computed by code and overwrite anything the model emitted for them. The recommendation is displayed as text; it never becomes a command.
- **No credentials are added.** Stage 1 has no executor, runs no container and needs no repository token beyond what the scout already uses.
- **Prompt injection.** Report text can try to steer the assessment ("recommend implement_fix"). In stage 1 the worst effect is a wrong recommendation on a card, because nothing executes from it; this is a reason routing is a later, separately reviewed stage.
- **Who sees what.** Reporters see plain-language wording; the index and its factors are shown to engineers only (section 5.3).

---

## 9. Failure and degradation

| Situation | Behavior |
|---|---|
| Stage off (no `<assessment>`) | Today's behavior and today's card. |
| Invalid structured output | One repair attempt; then `assessment-failed`, the card renders without a recommendation, the ticket flow is unchanged. |
| Model or provider error | The workflow retries per its existing policy; after exhaustion, as invalid output. Never a fallback to a default recommendation. |
| Index unavailable | `changeRisk.index` absent, level `unknown` or model-judged, card says the risk could not be scored. |
| Evidence references do not resolve | Treated as invalid output. |
| Duplicate or concurrent events | One assessment per packet revision (singleton key); one card. |
| Assessment slower than the card timeout | The card posts without a recommendation after a bounded wait; a late assessment is recorded and shown on the ticket but does not edit a card that a human has already answered. Decision pending: the wait. Options: the same bound as one triage call (recommendation), or a configured value. |
| Assessment contradicts what a level 2 or 3 fixer is doing | Recorded; shown or hidden per the section 5.3 decision; the fixer is not touched. |

Principle 5 holds throughout: no failure path starts, stops or reroutes the fixer.

---

## 10. Open decisions, delivery, and later stages

### 10.1 Open decisions

| # | Decision pending | Options | Recommendation |
|---|---|---|---|
| D1 | Default model for `assess` (section 3.1) | Same as triage; the scout model; the clarify model | Same as triage |
| D2 | Recommendation on level 2 and 3 cards when it contradicts the running action (section 5.3) | Show flagged; log only | Show flagged |
| D3 | Ticket timing at level 1 (section 5.4) | Leave; file before the card | Leave in stage 1 |
| D4 | Where `<sensitive>` is declared (section 6.3, owned by #58) | Workspace map; `<merge>` config | Workspace map |
| D5 | Wait for the assessment before posting the card (section 9) | Triage-call bound; configured value | Triage-call bound |
| D6 | Whether the card shows the index to reporters | Never (plain words only); a band word | Plain words only |

### 10.2 Later stages (listed, not specified)

These follow the design and are out of scope until stage 1 is proven. They are named here so stage 1 does not close them off; no tasks are proposed for them.

- **Evaluation:** run the reference set and compare recommendations with what the pipeline did.
- **Routing:** two-gate routing with the autonomy dial, an automatic fixer profile, the investigator and planner roles, budgets, stale checks.
- **Decide and override:** the `convene_decision` brief and recording paths, overrides from cards, commands and Jira, split proposals.
- **Calibrate:** outcome reports, anchor tuning and the evaluation set in CI.

### 10.3 Re-check at the v1 release candidate

At the v1 release candidate and before the first stage 1 pull request is opened, re-verify every row of section 2 against `main`: the `ModelTask` union, `MODEL_TASKS`, `DEFAULT_MODELS` and the XSD enum (names, locations and the count of six); `resolveAutonomy` (signature and call sites); `buildFixPreview` and the `fix-preview` card kind, phase and action ids; the level 1 ticket timing; the event type list and artifact kinds; the merge gate's `forbidden` configuration; and the config root's element list. Any difference is fixed in this document in the same pull request that finds it.

### 10.4 Delivery sequence (stage 1)

The epic (#50) lists its work as checkboxes and has no task issues yet. Each task below is about one pull request. **Every task is missing as an issue** and needs one created under #50 (the numbers are labels used in this document only).

| Task | Scope | Depends on | Package |
|---|---|---|---|
| A1 | Contracts, schema generation and validation (`contracts/assessment.ts`, section 3.2) with unit tests for every validation rule | none | pipeline |
| A2 | The `assess` model task in the port, `MODEL_TASKS`, `DEFAULT_MODELS`, the XSD enum and `docs/SPEC.md` 14.5, a three-way drift test, a recorded-fixture mock directory with fixtures for C-01, C-02, C-08 and C-14 | none | pipeline |
| A3 | `<assessment>` config element: XSD, parser, `AssessmentConfig`, `mode="recommend"` only | A2 | pipeline |
| A4 | Events, artifact kinds and projections (`assessed`, `assessment-failed`, `next-action-recommended`; `evidence-packet`, `assessment`; incident columns) | A1 | pipeline |
| A5 | Evidence packet builder and the `assess` step with `assess.xml`, the cursor phase, idempotency, failure path, and the unit test that the step never changes a level | A1, A2, A3, A4 | pipeline |
| A6 | The next-step card: `buildFixPreview` content, `InteractiveCard` optional field, plain-language wording for reporters, Slack rendering tests | A5 | app, pipeline |
| A7 | Jira description section through the outbox, and optional display fields | A5 | pipeline |
| A8 | Risk index seam and the amendment: `riskIndexFor`, an architecture decision record, switch `changeRisk.level` to the band when an index exists | A1; #58 for the real index | pipeline |
| A9 | Contract-tier and e2e proof: C-01, C-02, C-08, C-14, C-18 and C-19 pass, and the "no incident changes level" check | A5, A6 | pipeline, app |

A8 can merge with the index absent (it adds the seam and the record) and is completed by a one-line change when #58 lands.

---

## 11. Acceptance

The proof names six design cases. They keep their design ids.

| ID | Behavior | Tier |
|---|---|---|
| C-01 | A known localized fix with clear behavior and a test yields size XS or S, low uncertainty, low risk and `implement_fix`; with `mode="recommend"` nothing executes at any level | unit, contract |
| C-02 | A vague report with no reproduction yields size `unknown` or conditional, high uncertainty and `investigate` with named questions | unit, contract |
| C-08 | Too little code context for blast radius yields change risk `unknown` with a stated limitation, never low, and no index | unit, contract |
| C-14 | Invalid output after the repair attempt leaves the ticket flow unchanged, records `assessment-failed`, shows a card without a recommendation, and never starts the fixer | unit, contract |
| C-18 | At level 0 the assessment and recommendation are posted and nothing executes | unit, contract |
| C-19 | `mode="recommend"` at level 3 executes nothing; the fixer never starts because of an assessment | unit, contract |
| I-01 | `ModelTask`, `MODEL_TASKS` and the XSD enum contain the same tasks, and `DEFAULT_MODELS` has a row for each under every provider | unit |
| I-02 | With the stage on, no incident's `plan.autonomyLevel` differs from `resolveAutonomy`'s result, and the assessment module cannot call `degrade` | unit |
| I-03 | The next-step card shows size, uncertainty, change risk and the action as separate items; no field or string combines them | unit (rendering) |
| I-04 | With the `<assessment>` element absent, the card and event log are identical to today's | contract |
| I-05 | A config with `mode="execute"` fails XSD validation | unit |
| I-06 | An assessment whose evidence references do not resolve is rejected and counted as invalid output | unit |
| I-07 | Equal events produce one assessment, one card and one ticket section (singleton key) | unit |
| I-08 | With an index present, `changeRisk.level` equals the index band; with none, it is model-judged or `unknown`; the index never appears inside size, uncertainty or action fields | unit |
| I-09 | A reporter's view of the card contains no file paths and no index number | unit (rendering) |
| I-10 | Buttons on the card are the same as today's for each level and role | unit (rendering) |

---

## 12. Test plan by tier

| Tier | Covers |
|---|---|
| unit | Contract validation (every rule in section 3.2); the three-way task drift test; config parsing and XSD (`mode`, absent element, unknown anchor size); the step's idempotency and failure paths; the "never changes a level" and "cannot call `degrade`" checks; card rendering per level, per role and per failure state; reporter wording; index seam behavior with and without an index |
| contract | Assessment calls through the recorded mock for C-01, C-02, C-08 and C-14, including a repair attempt and a failure; the Jira section through the outbox; the card through the Slack adapter; the full event log with the stage on and off |
| live | One assessment per default provider on a small fixture incident, recorded once to produce or refresh fixtures; checks that each provider's structured output accepts the generated schema |
| e2e | C-01 at level 2 with `mode="recommend"`: the incident proceeds exactly as today and the card shows the recommendation as information; C-02 at level 1: the card shows `investigate` and the `Fix it` button still works |

Live and e2e runs create their fixture repository per run and delete it afterward, as the other live tiers do.

---

## 13. Open items

- The design's calendar integration, browser reproduction and story point mapping are unchanged and belong to later stages.
- Teams parity for the next-step card follows the Teams work for the other v2 cards; stage 1's optional `assessment` field keeps the Teams adapter working in the meantime.
- Cross-incident learning (using similar past incidents as sizing evidence) is deferred until calibration data exists.
