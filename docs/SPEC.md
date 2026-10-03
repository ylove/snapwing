# Snapwing

**Product Requirements Document and Technical Architecture Spec**
**Status:** Living Document, v1.5 (supersedes v1.4)
**Name:** Snapwing (decided in v1.5). npm scope `@snapwing`, CLI command `snapwing`, bot display name "Snapwing", button label "Fix it from here".

---

## 0. What changed

### v1.4 over v1.3

1. **Teams parity is a requirement, with the gaps named.** Every Slack capability has a Teams counterpart in a parity matrix (section 15.2), including the two places where Teams needs Microsoft Graph and tenant consent to match Slack (reading channel history, and reacting to messages the bot did not send).
2. **Packaging is decided.** A monorepo with one installable app package (server, Slack, Teams, CLI), a tiny capture-client SDK, a separate Raycast extension package, and a reserved slot for a browser extension that reuses the SDK (section 21).
3. **Onboarding is a product, not a config file.** Three entry paths (click an install button, paste one command, or be walked through it by the bot in chat) converge on one resumable state machine that interviews the installer in plain language, validates every credential live, and writes the XML so nobody has to (section 22).
4. **Publishing is specified.** Which marketplaces, what each requires, and which artifacts the repository must carry for the hosted offering versus self-hosting (section 23).

### v1.3 over v1.2

1. **Any screenshot is a capture source.** A screenshot DMed to the bot, attached to a channel message and reacted to, shared from a phone, or sent from a CLI enters the same pipeline as a right-click. The vision pass moves from an open item to a core stage of context assembly (sections 5.2, 15.5, 15.6).
2. **The trigger emoji is configurable.** 🐛 is the default, not a constant. Workspaces pick their own during onboarding, may set a different one per channel, and may register more than one (section 15.1, map schema in 4.2).
3. **UI is specified by persona.** Reporters get cards only; engineers get cards plus the Slack App Home tab; admins get a CLI first and a small console later; repo reviewers get a Replay page (section 20).

### v1.2 over v1.1

1. **Autonomy is a dial, not a constant.** v1.1 hardwired "human tap before fixer, human merge always." v1.2 replaces that with four autonomy levels set per workspace and overridable per surface, component, and priority (section 4.6). At the top level the fixer starts the moment the ticket exists, the review agent and CI gate the merge, the agent merges, closes the ticket, and reports back. At lower levels a human taps to start the fixer and CODEOWNERS get the PR. Any failed gate degrades one level; nothing is ever dropped silently.
2. **Provider-agnostic runtime.** v1.1 pinned GCP. v1.2 defines ports for queue, cache, secrets, object storage, and the fixer runner, with AWS, GCP, and local providers, chosen at onboarding (section 14.3).
3. **Live testing is specified.** How to stand up a free Atlassian Cloud site, a Slack dev workspace, and a GitHub fixture repo, bootstrap them with scripts, and run tiered tests against them (section 14.4).

### v1.1 over v1.0

v1.0 specified an omnichannel ingestion layer that ends at Jira issue creation. v1.1 made three structural changes:

1. **The ticket is a midpoint, not the endpoint.** The pipeline now continues through implementation prompt generation, a fixer agent that opens a PR, an independent review agent, human merge, and status reporting back to the originating conversation.
2. **Context is assembled, not assumed.** A right-click marks an anchor, not a boundary. The agent builds a context bundle from surrounding channel history, sub-threads, attachments, and a workspace map produced during onboarding.
3. **Humans are the last resort, not the first.** Dedupe, resolution against the workspace map, and inference from mentions and channel all run before the agent asks anyone anything. Questions to reporters pass a gate; questions requiring technical knowledge are routed to engineers.

Also fixed from v1.0: synchronous orchestration violated Slack's 3-second acknowledgement rule; Teams auth was a stub; `requiresHumanApproval` was hardcoded false; Raycast idempotency had no TTL; adapter generics were `any`.

---

## 1. Product thesis

Bug reports almost never arrive as bug reports. They arrive as a question in a channel ("is checkout down for anyone?"), followed by rapid-fire messages, some with their own threads, a screenshot, a "me too" from support, and the actual reproduction step somewhere in the eighth message. The person who started it is usually not an engineer, and is afraid of two things: filing it wrong, and being asked "steps to reproduce?"

Every existing chat-to-Jira integration optimizes for the engineer. This product optimizes for the reporter, and the engineer benefits as a side effect (fewer duplicates, richer tickets, fewer pings).

**The promise:** make this someone's problem without writing it up, and find out when it is fixed without ever opening Jira.

**The promise is only true end to end.** Removing context switching at intake and then making the reporter check Jira for status breaks it. The loop must close in the conversation where it started.

---

## 2. Personas and how bugs surface

| Persona | How they encounter bugs | What they fear | What they need |
|---|---|---|---|
| **Reporter** (sales, support, ops, any non-engineer) | Notices something broken while doing their job; posts a question in a team channel | Filing it wrong; being interrogated with technical questions; being wrong that it is a bug | Zero fields, no jargon, a signal that someone is on it, and a signal when it is fixed |
| **Engineer** | Sees it in a channel, gets pinged, or notices a stack trace while doing something else | Duplicate tickets; tickets with no context; agents doing unsanctioned work | Dedupe before create, the whole context attached, a tap to approve before anything autonomous happens |
| **Tech lead** | Sees throughput and noise across the whole system | Blast radius of automation; untraceable changes | A dial for how much autonomy each surface gets, review gates intact, every change traceable to a ticket and a person |

### Where bug signals originate (in rough order of volume)

1. Non-engineer question in a team channel (not a thread, not a report)
2. Burst of rapid-fire messages in a channel, each possibly with replies
3. Alert webhook (PagerDuty, Datadog, Sentry) that may or may not be real
4. Engineer notices a stack trace or error in some other window (Raycast case)
5. Customer email forwarded into chat

---

## 3. Pipeline overview

```
 CAPTURE            CONTEXT             RESOLVE              DEDUPE            CLARIFY (gated)
 right-click /  →   assemble bundle  →  surface, repo,   →   search open   →   ask one question,
 emoji / Raycast    (window+threads)    owner via map        issues            routed by role
        │
        ▼
 PREVIEW CARD       TICKET + PROMPT     FIXER AGENT          REVIEW AGENT + CI
 diagnosis;     →   Jira issue +     →  clone, fix,      →   independent AI review,
 tap (L1) or        custom field;       open PR              test suite, risk gate
 info only (L2+)    → In Progress             │
                                              ▼
                              ┌───────────────┴────────────────┐
                              ▼                                ▼
                    HUMAN IN THE LOOP (L1, L2)          AUTOPILOT (L3)
                    review requested from CODEOWNERS;   agent merges, ticket → Done,
                    card in Slack; human merges         posts result; [Revert] available
                              │                                │
                              └───────────────┬────────────────┘
                                              ▼
                                       STATUS LOOPBACK
                       filed → fixing → PR → review → merged → staging → "@reporter can you check?"
```

Which path runs is decided by the autonomy level (section 4.6). Each stage is a separately testable module with an explicit input and output contract (section 13).

---

## 4. Workspace Context Model

The context model is a first-class product artifact. Onboarding builds it, runtime consults it, corrections write back to it. It is the part no generic bot has, and it is what makes "@webDev1 is the nav broken?" in #market-bugs unambiguous.

### 4.1 Four tables

**Channels to surfaces.** `#web-bugs` and `#market-bugs` both resolve to the website. `#app-bugs` resolves to mobile. `#alerts` resolves to whatever the alert payload names. Auto-proposed from channel names and confirmed with a tap during onboarding.

**Vocabulary.** Every company has private nouns. "Market" means the website. "The portal" means the B2B admin. "The feed" means one specific service. Seeded by scanning channel history for recurring nouns near bug-shaped messages, then confirmed by a human.

**People to ownership.** Who owns what, and who historically resolves threads in which channel. Sources: `CODEOWNERS`, Jira components and component leads, Slack user groups, resolution history.

**Surfaces to repos and Jira projects.** So that "website" resolves to a repository the fixer agent can clone and a project key the ticket lands in.

### 4.2 Schema (`workspace-context.xml`)

The map is structured, validated at deploy, and injected into every triage prompt. A broken map fails loudly at deploy rather than quietly at 2 a.m.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="acme" updated="2026-09-28T00:00:00Z">

  <surfaces>
    <surface id="web" label="Website">
      <repo>github.com/acme/web</repo>
      <jira project="WEB" defaultIssueType="Bug" />
      <components>
        <component id="nav" label="Navigation" />
        <component id="checkout" label="Checkout" />
        <component id="auth-web" label="Login (web)" />
      </components>
    </surface>
    <surface id="mobile" label="Mobile App">
      <repo>github.com/acme/mobile</repo>
      <jira project="APP" defaultIssueType="Bug" />
    </surface>
    <surface id="admin" label="B2B Admin Portal">
      <repo>github.com/acme/admin</repo>
      <jira project="ADM" defaultIssueType="Bug" />
    </surface>
  </surfaces>

  <channels>
    <channel id="C0WEBBUGS" name="web-bugs" surface="web" confidence="explicit" />
    <channel id="C0MKTBUGS" name="market-bugs" surface="web" confidence="explicit" />
    <channel id="C0APPBUGS" name="app-bugs" surface="mobile" confidence="explicit">
      <trigger emoji="ladybug" />                      <!-- per-channel override -->
    </channel>
    <channel id="C0SALES" name="sales-team" surface="admin" confidence="inferred" />
    <channel id="C0ALERTS" name="alerts" surface="from-payload" />
  </channels>

  <!-- How a human starts the pipeline. Names are each platform's reaction identifier. -->
  <triggers>
    <messageAction label="Fix it from here" />
    <emoji slack="bug" teams="bug" />                  <!-- default: 🐛 -->
    <emoji slack="fire" teams="fire" minReactors="2" /> <!-- second emoji, needs two people -->
    <directMessage images="true" text="true" />        <!-- DM the bot a screenshot or a sentence -->
    <cli enabled="true" />
  </triggers>

  <vocabulary>
    <term surface="web">market</term>
    <term surface="web">the site</term>
    <term surface="admin">the portal</term>
    <term surface="mobile">the app</term>
    <term surface="web" component="checkout">cart</term>
  </vocabulary>

  <people>
    <person slackId="U0WEBDEV1" handle="webDev1" email="dana@example.com" role="engineer">
      <owns surface="web" />
      <owns surface="web" component="nav" primary="true" />
    </person>
    <person slackId="U0MOBDEV" handle="mobDev" email="marcus@example.com" role="engineer">
      <owns surface="mobile" />
    </person>
    <person slackId="U0SALESLEAD" handle="salesLead" email="pat@example.com" role="reporter" />
  </people>

  <policies>
    <askBack maxQuestionsPerIncident="1" suppressWhenReportersAtLeast="3" />

    <!-- Autonomy dial, see 4.6. The default applies unless an override matches. -->
    <autonomy default="1">
      <level id="0" name="ticket-only" fixer="never"     merge="none" />
      <level id="1" name="fix-on-tap"  fixer="on-tap"    merge="human" />
      <level id="2" name="fix-now"     fixer="immediate" merge="human" />
      <level id="3" name="autopilot"   fixer="immediate" merge="agent" requires="review-agent ci-green risk-gate" />
      <overrides>
        <surface ref="web" level="2" />
        <surface ref="admin" level="1" />
        <component surface="web" ref="auth-web" level="1" />
        <priority atLeast="Highest" level="1" />
      </overrides>
    </autonomy>

    <!-- Autopilot merges must pass all of these or degrade to level 2. -->
    <riskGate maxFilesTouched="6" maxDiffLines="300">
      <forbiddenPath>src/auth/**</forbiddenPath>
      <forbiddenPath>infra/**</forbiddenPath>
      <forbiddenPath>**/migrations/**</forbiddenPath>
    </riskGate>
  </policies>

</workspace>
```

An XSD (`schemas/workspace-context.xsd`) validates structure. A Schematron file (`schemas/workspace-context.sch`) validates cross-references (every `channel/@surface` names a real surface, every `person/owns/@component` exists under that surface, every `overrides/*/@ref` resolves).

### 4.3 Onboarding flow

1. **Connect** Slack workspace, Jira site, GitHub org.
2. **Auto-propose** surfaces from Jira projects and GitHub repos; channels from channel names; people from `CODEOWNERS` and Jira component leads.
3. **Vocabulary scan.** Sample the last 90 days of candidate bug channels, extract recurring nouns within two sentences of bug-shaped phrases ("broken," "not working," "can't," "error"), cluster, present top candidates for confirmation.
4. **Confirm.** A human confirms or edits each table. Nothing is written without confirmation.
5. **Validate and deploy.** XSD plus Schematron gate.

The XML is the output of onboarding, not its input. Nobody is expected to write or read it; the full onboarding experience, including how non-technical installers get through it, is section 22.

### 4.4 Runtime resolution: the confidence stack

Signals are consumed in order; the first confident hit wins.

1. **Explicit mention** of a person with a known ownership (`@webDev1` resolves surface = web, likely component = nav, probable assignee).
2. **Channel mapping** with `confidence="explicit"`.
3. **Vocabulary match** in the message text ("market," "cart").
4. **Image reading** surface signals (URL bar, app chrome) from the vision pass (5.2a).
5. **Channel mapping** with `confidence="inferred"`.
6. **Alert payload fields** (service name, environment).
7. **LLM inference** over the context bundle, with the map injected.
8. **Ask-back gate** (section 7), only if 1 through 7 leave surface unresolved.

`@webDev1 is the nav broken?` in `#market-bugs` resolves surface, component, and probable owner from the first two words without a model call.

### 4.5 Learning loop

Every correction an engineer makes in Jira is a labeled example:

- Ticket reassigned → update `people/owns`
- Ticket moved to another project → update channel or vocabulary mapping that led there
- Component changed → update vocabulary term → component link

Corrections accumulate in `workspace-context.corrections.jsonl` and are applied to the XML on a schedule after a human reviews a diff. Six weeks in, the map knows things nobody wrote down.

### 4.6 Autonomy dial

How far the pipeline runs without a human is a policy, resolved per incident from the workspace map. Overrides are evaluated most-specific first: component, then surface, then priority, then the workspace default. The most restrictive matching override wins when several match, so a `Highest` priority bug on an autopilot surface still gets a human.

| Level | Name | Fixer starts | Who merges | What the reporter sees |
|---|---|---|---|---|
| 0 | ticket-only | never | nobody | "Filed as WEB-1042, assigned to @webDev1." |
| 1 | fix-on-tap | when an engineer taps **Fix it** | human | Fix Preview Card with buttons, then status |
| 2 | fix-now | immediately after the ticket is created | human (CODEOWNERS requested) | Card is informational with a **Stop** button; status follows |
| 3 | autopilot | immediately | the agent, if review agent, CI, and risk gate all pass | Card with **Stop**; "Merged and live, can you check?" |

**Degradation, never silence.** If any gate fails at level 3 (review agent rejects, CI red, risk gate tripped, or the fixer gives up), the incident drops to level 2: the PR stays open, CODEOWNERS are requested, and the status message says why. If the fixer fails at level 2, the ticket stays In Progress with a `fixer-failed` label and the assignee is pinged. No level ever results in a ticket quietly closing or a PR quietly disappearing.

**Stop is always available.** At levels 2 and 3 every card and every status message carries a **Stop** button (and the Jira issue accepts an `snapwing:stop` label). Stop cancels the fixer job, closes the PR if one exists, leaves the branch, and moves the ticket back to Backlog with a comment naming who stopped it.

**Recommended rollout.** Start every surface at level 1, promote to level 2 once dedupe and diagnosis quality are trusted, and enable level 3 only on surfaces with strong test coverage and low blast radius. The map records who changed a level and when.

---

## 5. Context assembly

### 5.1 Anchor, not boundary

A right-click (or emoji reaction) marks an **anchor message**. The agent does not treat the anchor's thread as the incident; often there is no thread, or the relevant messages are siblings in the channel.

### 5.2 Collection

```
window(anchor):
  channel_history(channel, oldest = anchor.ts - 30min, latest = anchor.ts + 30min, limit = 40)
  for each message m in window where m.reply_count > 0:
      thread_replies(m)                      # sub-threads of every message in the window
  attachments: images, files, link unfurls   # image content passed to a vision-capable model
  reactions and mentions on every message
```

Both bounds and the cap are policy-configurable. If the anchor is inside a thread, the thread's parent and siblings in the channel are still collected. When the anchor is itself an image with no surrounding conversation (a DM, a CLI send, a phone share), the window is empty and the vision pass below carries the whole load.

### 5.2a Vision pass

Every image in the bundle goes through a vision-capable model before segmentation, producing a structured `ImageReading` (section 13):

- **Error text**, verbatim, if any is visible. This usually becomes the ticket summary.
- **Surface signals:** URL bar contents, page title, app chrome, OS chrome (a phone status bar means mobile; a browser tab strip means web; an admin sidebar is often a giveaway on its own). These feed the confidence stack (4.4) as a signal ranked between vocabulary and inferred channel.
- **Visible UI element names** (button labels, menu items, form fields), which map to components through the vocabulary table.
- **Environment hints:** `staging.` or `localhost` in a URL, a debug banner, a version string in a footer.
- **What is wrong, described plainly**, for the reporter-facing card: "the total field is blank" rather than "null value in DOM node."

Images are never sent to the model raw with no instructions; the vision prompt is XML-structured like the rest and asks for these fields explicitly, with `unknown` as a legal value for each. Screenshots containing what look like credentials, session tokens, or personal data are flagged; the extracted text is redacted in the ticket and the original image is attached only to the Jira issue, never echoed into the channel.

### 5.3 Segmentation

An LLM pass over the raw pile answers: which of these messages are about the same incident as the anchor? Signals:

- **Burst timing.** Messages within short gaps of each other.
- **Shared participants.** Same reporters, same people mentioned.
- **Topic continuity.** Same surface, same vocabulary terms, same component.
- **Reactions.** 👀, 🔥, and the workspace's configured trigger emoji on messages near the anchor.
- **Image readings.** A screenshot in the window whose surface signal matches the anchor's is strong evidence the messages belong together.

Output is a `ContextBundle` (section 13) with the included message IDs, excluded message IDs, and a one-line rationale per exclusion for the audit log.

### 5.4 Resolution signals

The same pass must catch messages that mean **do not file**:

- "nvm, works now"
- "that was me, I was on the wrong account"
- "already fixed in the deploy that just went out"

If a resolution signal is found after the anchor, the agent replies in-thread with what it found and does nothing else.

### 5.5 Scope preview

Before any downstream action, the agent shows its work:

> Reading 11 messages from 2:10 to 2:31, including Dana's screenshot and the thread under Marcus's reply. **[Looks right]** **[Widen]** **[Narrow]**

Nobody wants a bot silently deciding what counts. The preview is both a guardrail and a trust builder. `Widen` doubles the window; `Narrow` limits to the anchor's own thread.

---

## 6. Dedupe

Dedupe runs before create, always. Duplicate tickets are the primary reason engineers reject chat-to-Jira bots.

### 6.1 Search

1. **Jira JQL** over the resolved project: open issues updated in the last 30 days, then a full-text pass on the bundle's extracted summary.
2. **Recent incidents table** (Redis, 7-day TTL) keyed by surface + component + normalized summary hash, catching incidents the agent itself filed minutes ago from another channel.
3. **Embedding similarity** (optional, v1.2) over open issue summaries and descriptions.

### 6.2 Response

If a candidate exceeds the similarity threshold:

> This looks like **WEB-812** (open since Tuesday, assigned to Dana): "Nav dropdown not rendering on Safari." **[Link this thread to WEB-812]** **[Create new anyway]** **[Not related]**

Linking posts the bundle as a comment on the existing issue with a deep link back to the conversation, and subscribes the thread to that issue's status updates (section 12).

---

## 7. Ask-back gate

**Rule:** never ask a question the reporter could not answer from what they saw on their own screen. "Is this production?" fails. "Which login page were you on?" with buttons passes.

### 7.1 Three layers, in order

**Layer 1: Exhaust what can be found.** Before asking anyone:

- Surface, component, and owner from the confidence stack (section 4.4)
- Active alerts for that surface in the last hour
- Open issues for that surface (dedupe, section 6)
- Other reports of the same symptom in the last hour across channels
- Reporter's account state if an internal admin tool is connected

"I can't log in" plus an auth alert firing plus three other reports is an incident. The agent says so and files. It asks nothing.

**Layer 2: Route by role.** Every candidate question is classified `experiential` or `technical`.

- Experiential → the reporter, in their thread
- Technical → an engineer who owns the surface, in the same thread, or answered from the map (environment is usually inferable from reporter role: a sales rep is on production)

The reporter never sees a technical word.

**Layer 3: Options come from the product, not from templates.** Because the agent has the workspace map and the codebase, it knows the website has three login surfaces. So:

> Were you on the **website**, the **phone app**, or the **admin dashboard**?

Or the universal non-technical answer:

> Can you post a screenshot of what you saw?

### 7.2 The gate

Every generated question must pass all of:

- Answerable by a non-technical person from their screen
- Presentable as 2 to 4 buttons, or a screenshot request
- Not already answerable from the bundle or the map
- Budget not exceeded (`askBack/@maxQuestionsPerIncident`, default 1)
- Not suppressed by volume (`askBack/@suppressWhenReportersAtLeast`, default 3: if three people are reporting it, it is an incident, not a question)

If any check fails: do not ask. File with what is known, label the issue `needs-clarification`, assign to the surface owner, and let a human ask. Silence is a valid move; a bad question costs more than a thin ticket.

---

## 8. Triage plan and Fix Preview Card

### 8.1 Triage

The triage prompt receives the `ContextBundle`, the resolved surface and component, the dedupe result, and the workspace map, and produces a `TriageResolutionPlan` (section 13). Triage may include a **read-only codebase pass** by a scout agent: search the resolved repo for the component, identify likely files, and propose a diagnosis. The scout has no write access.

### 8.2 Fix Preview Card (Slack Block Kit)

This is the delight moment and the guardrail in one. Every autonomous action is preceded by a human tap in the place they already are.

> **Diagnosis:** Null `price` on cart line item when a promo code is applied after quantity change.
> **Surface:** Website › Checkout   **Owner:** @webDev1   **Priority:** High
> **Proposed fix touches:** `src/cart/lineItem.ts`, `src/promo/apply.ts`
> **[Fix it]**  **[Ticket only]**  **[Not a bug]**

```json
{
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Diagnosis:* Null `price` on cart line item when a promo code is applied after quantity change." } },
    { "type": "context", "elements": [
      { "type": "mrkdwn", "text": "*Surface:* Website › Checkout  *Owner:* <@U0WEBDEV1>  *Priority:* High" } ] },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Proposed fix touches:* `src/cart/lineItem.ts`, `src/promo/apply.ts`" } },
    { "type": "actions", "block_id": "triage_actions", "elements": [
      { "type": "button", "style": "primary", "text": { "type": "plain_text", "text": "Fix it" }, "action_id": "approve_fix", "value": "evt_01H..." },
      { "type": "button", "text": { "type": "plain_text", "text": "Ticket only" }, "action_id": "ticket_only", "value": "evt_01H..." },
      { "type": "button", "style": "danger", "text": { "type": "plain_text", "text": "Not a bug" }, "action_id": "dismiss", "value": "evt_01H..." } ] }
  ]
}
```

**Who can tap what (level 1):** `Fix it` is restricted to users with `role="engineer"` in the map (and Jira access). Reporters see `Ticket only` and `Not a bug`. A reporter tapping `Fix it` gets "I've asked @webDev1 to approve" and the card is reposted with the engineer mentioned.

**At levels 2 and 3** the card is posted after the fixer has already started. The action row becomes **[Stop]** **[Not a bug]**, and the diagnosis block carries a "Fixing now" badge. `Not a bug` at these levels is a Stop plus a ticket close with resolution "Won't Do."

Teams renders the equivalent as an Adaptive Card with `Action.Submit` buttons. Raycast returns the plan to the extension, which shows a HUD with the same choices.

---

## 9. Ticket synthesis and implementation prompt

### 9.1 Jira issue

Created via REST v3 with:

- Summary and ADF description built from the bundle (reporter, symptom, environment, repro if known, screenshots as attachments, deep link to the conversation)
- Labels: `snapwing`, source channel, surface, `needs-clarification` if applicable
- Component and assignee from the confidence stack
- Custom field `Implementation Prompt` (section 9.2)
- Custom field `Conversation Link`
- Custom field `Autonomy Level` (0 to 3, resolved from policy; visible so anyone reading the ticket knows what the agent is allowed to do)
- Transition: Created → In Progress when `Fix it` is tapped (level 1) or immediately after creation (levels 2 and 3); stays in Backlog at level 0

### 9.2 Implementation prompt (custom field)

Generated from the bundle and the scout's diagnosis, written into a Jira custom field for the fixer agent to pick up. Structured so that both the writer (triage) and the reader (fixer) are parser-shaped.

```xml
<implementation-request xmlns="urn:snapwing:impl:v1" issue="WEB-1042" surface="web" component="checkout">
  <intent>
    Applying a promo code after changing quantity leaves cart line items with a null price,
    causing a blank total on the checkout page.
  </intent>
  <evidence>
    <report source="slack" channel="market-bugs" reporter="pat@example.com" ts="1727540000.000100">
      "cart total is blank after I put in the discount code, happened to two customers today"
    </report>
    <screenshot ref="attachment:WEB-1042/cart-blank.png" />
    <alert none="true" />
  </evidence>
  <diagnosis confidence="medium" by="scout">
    <file path="src/promo/apply.ts">applyPromo() recomputes line totals but reads price from the pre-quantity-change snapshot</file>
    <file path="src/cart/lineItem.ts">LineItem.price becomes undefined when snapshot is stale</file>
  </diagnosis>
  <constraints>
    <scope>Only files under src/cart and src/promo unless a test requires otherwise</scope>
    <tests required="true">Add a regression test covering quantity change followed by promo apply</tests>
    <forbidden>Do not modify pricing rules or promo eligibility logic</forbidden>
  </constraints>
  <handoff mode="review" branch="fix/WEB-1042-promo-null-price" base="dev" autonomy="2" />
</implementation-request>
```

`handoff/@mode` is `review` at levels 1 and 2 and `auto` at level 3; `@autonomy` echoes the resolved level so the fixer and the review agent can both read it without consulting the map. An XSD validates the prompt before it is written to Jira. If validation fails, the ticket is still created, the field is left empty, and the issue is labeled `prompt-failed` for a human to inspect.

---

## 10. Fixer agent contract and guardrails

### 10.1 Trigger

A Jira webhook on transition to In Progress with a non-empty `Implementation Prompt` field enqueues a fixer job. At level 1 that transition happens on the `Fix it` tap; at levels 2 and 3 the orchestrator performs it immediately after issue creation, so the fixer is running before the reporter has finished reading the card. The fixer never polls Slack and never reads conversation history; it reads the ticket and the prompt only.

### 10.2 Permissions

| Action | Allowed |
|---|---|
| Clone the resolved repo | Yes |
| Create a branch named from the ticket | Yes |
| Commit with `WEB-1042` in every message | Yes |
| Open a PR against the base named in `<handoff>` | Yes |
| Push to protected branches | No |
| Merge | No (the fixer never merges; at level 3 a separate merge step does, section 11) |
| Modify CI config or branch protection | No |
| Read secrets beyond the repo scope | No |

The fixer runs in an ephemeral container with a scoped GitHub App installation token. Blast radius is bounded to one branch in one repo.

### 10.3 Output

A PR whose body contains the `<implementation-request>` echoed back, a summary of the change, and the test added. The PR is linked to the Jira issue via the key in the branch name and commit messages.

### 10.4 Stop and failure

A Stop (button, or `snapwing:stop` label on the issue) cancels the job at its next checkpoint (before clone, before push, before PR open). Anything already pushed stays on the branch; an open PR is closed with a comment. If the fixer cannot produce a passing change within its budget (default 30 minutes of wall time or 3 attempts), it pushes what it has as a draft PR labeled `fixer-incomplete`, labels the issue `fixer-failed`, and the pipeline degrades to human handling at level 2 semantics regardless of the configured level.

---

## 11. Review, merge, and close

### 11.1 Review agent (every level that opens a PR)

An **independent** review agent (separate prompt, separate model context, no access to the fixer's reasoning) reviews every PR the fixer opens. It checks the diff against the `<constraints>` in the request, confirms the regression test exists and fails without the fix, runs the test suite, and posts a review with an explicit verdict: `approve`, `request-changes`, or `escalate`. A `request-changes` verdict re-enqueues the fixer once with the review attached; a second failure escalates.

### 11.2 Human in the loop (levels 1 and 2)

1. Review is requested from the surface's owners via the GitHub API, using `CODEOWNERS` for the touched paths and falling back to the map's `people/owns` for the surface.
2. A card is posted in the originating thread and in the surface's bug channel:

   > **PR #418 is ready** for WEB-1042 (review agent: approve, CI: green, 2 files, +41 −6). Review requested from @webDev1. **[Open PR]** **[Merge]** **[Request changes]** **[Stop]**

3. `Merge` is available only to users with a linked GitHub identity (OAuth at onboarding) who are in the requested reviewers; the merge is performed as that user, so GitHub's audit log names a human. Users without a linked identity see `Open PR` only.
4. Branch protection on the repo requires the review agent's check and at least one human approval. This is enforced in GitHub, not in prompts.

### 11.3 Autopilot (level 3)

The merge step runs only when all of the following are true, and re-checks them at merge time rather than trusting earlier results:

- Review agent verdict is `approve`
- Every required CI check is green
- Risk gate passes: files touched and diff size under the configured limits, no forbidden paths, no changes to test configuration or CI
- No Stop has been issued
- The resolved level is still 3 (the map may have changed since the ticket was created)

If all pass: the merge is performed by the GitHub App (which is on the branch protection bypass list for that repo, and only for repos whose surface is at level 3), the branch is deleted, the Jira issue transitions to Done with a comment linking the merged PR, and the status message updates. A **[Revert]** button stays on the status message for a configurable window (default 72 hours); tapping it opens a revert PR and reopens the ticket at level 2.

If any check fails: degrade to 11.2. The card says which gate failed and why.

**Trade-off stated plainly.** Level 3 puts a GitHub App on the bypass list, which is exactly the kind of permission the v1.1 guardrail model forbade. It is acceptable only because it is opt-in per surface, gated by an independent reviewer plus CI plus a mechanical risk gate, re-verified at merge time, reversible with one tap, and fully attributed. Teams that do not want any of that stay at level 2 and lose nothing else.

---

## 12. Status loopback

The originating conversation is the single pane. The reporter never opens Jira.

| Event | Posted to thread |
|---|---|
| Ticket created (level 0, 1) | "Filed as WEB-1042, assigned to @webDev1." |
| Ticket created (level 2, 3) | "Filed as WEB-1042. Working on a fix now. **[Stop]**" |
| PR opened | "A fix is up (PR #418). Review requested from @webDev1." |
| Review passed | "Review passed, waiting on merge." |
| Merged (human) | "Merged by Dana. Rolling out to staging." |
| Merged (autopilot) | "Merged automatically (review: approve, CI: green). **[Revert]**" |
| Autopilot gate failed | "Held for human review: risk gate (touched infra/). @webDev1 requested." |
| Fixer stopped | "Stopped by Marcus. Ticket back in Backlog." |
| Fixer failed | "Couldn't produce a passing fix. Draft PR #419 has what it tried. @webDev1 pinged." |
| Deployed to staging | "Fix is on staging. @pat, can you check?" |
| Deployed to production | "Live. Closing WEB-1042." |
| `needs-clarification` cleared | "Thanks, that answered it. Moving ahead." |

Updates edit a single pinned status message rather than posting a dozen separate messages. Reporters can react 👍 on the staging check to confirm, which comments on the Jira issue.

---

## 13. Data contracts

```typescript
// src/contracts/incident.ts

export type IncidentUrgency = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type ActorRole = 'engineer' | 'reporter' | 'unknown';

export interface IncidentActor {
  id: string;
  name: string;
  email?: string;
  role: ActorRole;                 // resolved from workspace map
}

export interface SourceMessage {
  id: string;                      // ts, activity id, or synthetic
  authorId: string;
  text: string;
  timestamp: string;               // ISO 8601
  threadParentId?: string;
  mentions: string[];
  reactions: string[];
  attachments: Attachment[];
}

export interface Attachment {
  kind: 'image' | 'file' | 'link';
  url: string;
  mimeType?: string;
  extractedText?: string;          // unfurl output for links and files
  reading?: ImageReading;          // vision pass output for images (5.2a)
}

export interface ImageReading {
  errorText?: string;              // verbatim, if visible
  surfaceSignals: { urlBar?: string; pageTitle?: string; chrome?: 'web' | 'mobile' | 'desktop' | 'admin' | 'unknown' };
  uiElements: string[];            // visible labels, menu items, field names
  environmentHint?: 'production' | 'staging' | 'local' | 'unknown';
  plainDescription: string;        // reporter-facing: "the total field is blank"
  sensitive: boolean;              // credentials, tokens, or personal data visible
}

export type ChannelSource = 'slack' | 'teams' | 'raycast' | 'cli' | 'alert_webhook';

export interface ContextBundle {
  anchorId: string;
  included: SourceMessage[];
  excluded: { id: string; reason: string }[];
  resolutionSignal?: { messageId: string; text: string };
  windowUsed: { oldest: string; latest: string; cap: number };
}

export interface Resolution {
  surfaceId?: string;
  componentId?: string;
  ownerId?: string;
  repo?: string;
  jiraProject?: string;
  resolvedBy: 'mention' | 'channel-explicit' | 'vocabulary' | 'image' | 'channel-inferred' | 'alert' | 'llm' | 'unresolved';
  confidence: number;              // 0..1
}

export interface CanonicalIncidentPayload {
  eventId: string;                 // ULID
  idempotencyKey: string;
  source: ChannelSource;
  reporter: IncidentActor;
  anchorText: string;
  context: {
    channelId: string;
    threadId?: string;
    deepLink?: string;
    rawPayloadSnapshot: Record<string, unknown>;
  };
  timestamp: string;
}

export interface DedupeResult {
  candidates: { issueKey: string; summary: string; score: number; assignee?: string }[];
  decision: 'none' | 'link' | 'create-anyway' | 'pending-user';
}

export interface ClarifyQuestion {
  audience: 'reporter' | 'engineer';
  text: string;
  options?: string[];              // 2..4, or omitted for screenshot request
  gatePassed: boolean;
  gateFailures: string[];
}

export interface TriageResolutionPlan {
  action: 'create_issue' | 'link_existing' | 'noop';
  linkTo?: string;
  projectKey: string;
  issueType: 'Incident' | 'Bug' | 'Task';
  summary: string;
  descriptionAdf: Record<string, unknown>;
  priority: 'Lowest' | 'Low' | 'Medium' | 'High' | 'Highest';
  labels: string[];
  componentId?: string;
  suggestedAssigneeEmail?: string;
  diagnosis?: { confidence: 'low' | 'medium' | 'high'; files: { path: string; note: string }[] };
  implementationPromptXml?: string;
  autonomyLevel: 0 | 1 | 2 | 3;    // resolved from policy for this incident
}

export type ApprovalAction = 'approve_fix' | 'ticket_only' | 'dismiss' | 'stop' | 'merge' | 'request_changes' | 'revert';

export interface MergeGateResult {
  reviewVerdict: 'approve' | 'request-changes' | 'escalate';
  ciGreen: boolean;
  riskGate: { passed: boolean; filesTouched: number; diffLines: number; forbiddenHits: string[] };
  stopped: boolean;
  levelAtMergeTime: 0 | 1 | 2 | 3;
  decision: 'merge' | 'degrade' | 'hold';
  reason?: string;
}
```

```typescript
// src/adapters/base.ts

import { CanonicalIncidentPayload, TriageResolutionPlan, ClarifyQuestion } from '../contracts/incident';

export interface IngestionAdapter<TRaw, TAck> {
  readonly channelSource: CanonicalIncidentPayload['source'];

  /** Cryptographic authenticity. Must be constant-time where a secret is compared. */
  authenticateRequest(raw: TRaw): Promise<boolean>;

  /** Fast, synchronous shape check plus idempotency key. Must complete well under 1s. */
  normalizePayload(raw: TRaw): Promise<CanonicalIncidentPayload>;

  /** Immediate acknowledgement to the platform (HTTP 200, ephemeral "working on it"). */
  acknowledge(raw: TRaw, payload: CanonicalIncidentPayload): Promise<TAck>;

  /** Post the scope preview, dedupe prompt, clarify question, or fix preview card. */
  postInteractive(payload: CanonicalIncidentPayload, card: InteractiveCard): Promise<void>;

  /** Post or edit the pinned status message. */
  postStatus(payload: CanonicalIncidentPayload, status: StatusUpdate): Promise<void>;
}

export type InteractiveCard =
  | { kind: 'scope-preview'; summary: string }
  | { kind: 'dedupe'; issueKey: string; summary: string; assignee?: string }
  | { kind: 'clarify'; question: ClarifyQuestion }
  | { kind: 'fix-preview'; plan: TriageResolutionPlan };

export interface StatusUpdate {
  issueKey: string;
  stage: 'filed' | 'pr-open' | 'review-passed' | 'merged' | 'staging' | 'production' | 'clarified';
  text: string;
  mentionUserId?: string;
}
```

---

## 14. Orchestration and runtime

### 14.1 Asynchronous by construction

Slack requires HTTP 200 within 3,000 ms. The request handler does exactly three things: authenticate, normalize, enqueue. Everything else runs in a worker.

```typescript
// src/engine/orchestrator.ts (shape only)

export class IncidentOrchestrator {
  async handleInbound(source: ChannelSource, raw: unknown) {
    const adapter = this.adapters.get(source);
    if (!adapter) throw new UnsupportedChannelError(source);
    if (!(await adapter.authenticateRequest(raw))) throw new UnauthorizedError();

    const payload = await adapter.normalizePayload(raw);
    if (await this.idempotency.seen(payload.idempotencyKey)) return adapter.acknowledge(raw, payload);

    await this.queue.enqueue('incident.process', payload);
    return adapter.acknowledge(raw, payload);          // returns within budget
  }

  // Worker
  async process(payload: CanonicalIncidentPayload) {
    const bundle     = await this.context.assemble(payload);
    if (bundle.resolutionSignal) return this.postResolved(payload, bundle);

    const resolution = await this.resolver.resolve(payload, bundle, this.workspaceMap);
    await this.awaitInteractive(payload, { kind: 'scope-preview', summary: describe(bundle) });

    const dedupe     = await this.dedupe.search(resolution, bundle);
    if (dedupe.candidates.length) {
      const choice = await this.awaitInteractive(payload, dedupeCard(dedupe));
      if (choice === 'link') return this.linkAndSubscribe(payload, dedupe);
    }

    const question   = await this.clarify.maybeAsk(payload, bundle, resolution, this.workspaceMap);
    if (question?.gatePassed) await this.awaitInteractive(payload, { kind: 'clarify', question });

    const plan       = await this.triage.plan(payload, bundle, resolution, this.workspaceMap);
    const level      = this.policy.resolveAutonomy(resolution, plan, this.workspaceMap);

    if (level === 1) {
      const decision = await this.awaitInteractive(payload, { kind: 'fix-preview', plan });
      if (decision === 'dismiss') return this.noop(payload, plan);
      const issueKey = await this.jira.create(plan, bundle, level);
      if (decision === 'approve_fix') await this.jira.transition(issueKey, 'In Progress');  // fires fixer webhook
      return this.status.subscribe(payload, issueKey);
    }

    const issueKey   = await this.jira.create(plan, bundle, level);
    if (level >= 2) await this.jira.transition(issueKey, 'In Progress');   // fixer starts now
    await this.adapter(payload).postInteractive(payload, { kind: 'fix-preview', plan });  // informational, carries Stop
    await this.status.subscribe(payload, issueKey);
  }
}
```

`awaitInteractive` persists the job, posts the card, and yields; the button callback resumes the job by `eventId`. Level 1 jobs that receive no tap within a configurable window (default 24h) fall through to `ticket_only` and post a note saying so. The merge step (section 11) runs as a separate job triggered by the review agent's verdict and CI completion webhooks, and evaluates `MergeGateResult` fresh at that moment.

### 14.2 Idempotency

- Slack: `slack-{channel}-{ts}` (message actions) or `slack-{channel}-{ts}-{reaction}` (emoji triggers)
- Teams: `teams-{conversationId}-{activityId}`
- Raycast: `raycast-{sha256(text)}` with a **24h TTL**, so resubmitting the same stack trace after a regression the next week is not silently dropped
- Alerts: the provider's incident or alert ID

### 14.3 Provider-agnostic runtime

The application is a plain Node.js/TypeScript service with two processes (API handler, worker) and one ephemeral job type (fixer). Everything cloud-specific sits behind five ports, and a provider is chosen at onboarding.

```typescript
// src/ports/index.ts

export interface QueuePort      { enqueue(name: string, payload: unknown, opts?: { delaySec?: number }): Promise<string>; consume(name: string, handler: (p: unknown) => Promise<void>): void; }
export interface CachePort      { get(k: string): Promise<string | null>; set(k: string, v: string, ttlSec?: number): Promise<void>; setIfAbsent(k: string, v: string, ttlSec: number): Promise<boolean>; }
export interface SecretsPort    { get(name: string): Promise<string>; }
export interface ObjectStorePort{ put(key: string, body: Buffer, contentType: string): Promise<string>; get(key: string): Promise<Buffer>; }
export interface RunnerPort     { runFixer(job: FixerJob): Promise<{ runId: string }>; cancel(runId: string): Promise<void>; }
```

| Port | `local` | `aws` | `gcp` | `docker` (any VPS) |
|---|---|---|---|---|
| Queue | in-memory | SQS | Cloud Tasks | Redis Streams (BullMQ) |
| Cache | in-memory or Redis container | ElastiCache | Memorystore | Redis container |
| Secrets | `.env` | Secrets Manager | Secret Manager | `.env` or Vault |
| Object store | local disk | S3 | GCS | MinIO |
| Runner | child process | ECS Fargate task | Cloud Run Job | `docker run` |
| API + worker | single process | ECS Fargate services or Lambda behind API Gateway | Cloud Run services | Compose services behind Caddy or nginx |

Provider selection lives in `snapwing.config.xml` (`<runtime provider="aws" region="us-east-2"/>`) and is validated against the same schema set as the workspace map. Terraform modules for `aws` and `gcp` live under `infra/`; `docker` ships a Compose file. Adding a provider means implementing five interfaces and nothing else.

**The public endpoint.** Slack message actions, Teams bots, and Jira and GitHub webhooks all need a public HTTPS URL. In production that is the provider's gateway (API Gateway, a Cloud Run URL, or the VPS's reverse proxy). For local development there are two options, and both are supported:

- **Slack Socket Mode** for the Slack adapter: the app opens a WebSocket to Slack, so message actions and button taps arrive with no public URL at all. Recommended for day-to-day development. Development only: Slack does not allow Socket Mode apps to be listed in its Marketplace, so the production Slack app uses HTTP endpoints (section 23).
- **A tunnel** (`ngrok`, `cloudflared`) for Jira and GitHub webhooks, which have no socket equivalent. The bootstrap scripts in 14.4 accept the tunnel URL and register webhooks against it.

**Reviewer demo mode** (`npm run demo`): a single Node process on the `local` provider with MSW mocking Slack, Jira, and GitHub, and a `demo/` folder of recorded channel histories that exercise segmentation, dedupe, the ask-back gate, and all four autonomy levels. It should produce a full pipeline trace in the terminal in under a minute with no keys.

### 14.4 Testing against live Atlassian, Slack, and GitHub

Mocks prove the code paths; they do not prove the Jira custom field IDs are right, that the webhook fires on the transition you think it does, or that Slack's message action payload looks the way the docs say. The live tier exists for that.

**Sandboxes to stand up once**

| Service | What | Notes |
|---|---|---|
| Atlassian | A free Jira Cloud site (Free plan, up to 10 users) with a project keyed `OAJ` | Service user with an API token for tests; OAuth 2.0 3LO is a v1.3 item. A company-managed project; its workflow needs a status in each category the logical targets map to (backlog to a "to do" status, in progress, in review when present, done), so the default Scrum workflow works unchanged and `snapwing.config.xml` can name a status per target; the bootstrap verifies this and prints the mapping. |
| Slack | A dedicated dev workspace; the app created from `slack/manifest.yaml` | Socket Mode on for local runs. Two test users: one `engineer`, one `reporter`, mapped in a test workspace map. |
| GitHub | A fixture repo `snapwing-fixture-web` with a seeded, reproducible bug and a test that fails until it is fixed; a `CODEOWNERS` file; branch protection mirroring production | A GitHub App installed on this repo only, with contents, pull requests, and checks permissions. |
| Teams | Optional in the live tier; a Microsoft 365 developer tenant if exercised | Adapter is `DEMO_ONLY` until JWT validation is complete. |

**Bootstrap scripts** (idempotent, re-runnable):

- `npm run jira:bootstrap` creates the custom fields (`Implementation Prompt`, `Conversation Link`, `Autonomy Level`), writes their field IDs into `.env.live`, registers the issue-transition webhook against the URL you pass, and verifies the workflow transitions exist.
- `npm run slack:bootstrap` validates the manifest against the workspace, prints the scopes still missing, and confirms Socket Mode connectivity.
- `npm run github:bootstrap` resets the fixture repo to its seeded state (deletes stray `fix/*` branches, closes stray PRs) and verifies the App installation and branch protection.

**Environment** (`.env.live`, never committed):

```
JIRA_BASE_URL=https://<site>.atlassian.net
JIRA_EMAIL=
JIRA_API_TOKEN=
JIRA_PROJECT_KEY=OAJ
JIRA_FIELD_IMPL_PROMPT=customfield_10042      # written by bootstrap
JIRA_FIELD_CONVERSATION=customfield_10043
JIRA_FIELD_AUTONOMY=customfield_10044
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=xoxb-
SLACK_APP_TOKEN=xapp-                          # Socket Mode
SLACK_TEST_CHANNEL=C0...
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=
GITHUB_INSTALLATION_ID=
GITHUB_FIXTURE_REPO=<org>/snapwing-fixture-web
SNAPWING_PROVIDER=local
SNAPWING_PUBLIC_URL=https://<tunnel>.ngrok.app   # only needed for Jira and GitHub webhooks
```

**Test tiers**

| Tier | Command | Network | What it proves |
|---|---|---|---|
| unit | `npm test` | none | segmentation, resolution stack, gate logic, schema validation, XML prompt generation |
| contract | `npm run test:contract` | MSW only | adapters and orchestrator against recorded real payloads (captured once from the live tier and committed under `test/fixtures/`) |
| live | `npm run test:live` | real Jira, Slack, GitHub | field IDs, webhook registration, transition names, message action and button payload shapes, PR creation and reviewer requests |
| e2e | `npm run test:e2e` | real, scripted | one scenario per autonomy level: post a bug-shaped message in the test channel as the reporter user, react 🐛 as the engineer user, assert the issue exists with the right fields, assert the fixer opened a PR against the fixture repo, assert the status message was edited, and (level 3) assert the merge and the Done transition |

**Hygiene.** Live and e2e runs prefix every issue summary with `[snapwing-test]` and every branch with `test/`, and a teardown step deletes the issues, closes the PRs, and deletes the branches. The teardown runs even when assertions fail. Nothing in the live tier ever points at a real project key.

**Raycast.** Run the extension with `ray develop` against the local API; the live tier includes one Raycast scenario that posts a stack trace containing a fixture file path and asserts the lookup-first response names the fixture surface.

### 14.5 Model and harness ports

Two more ports sit next to the five in 14.3 and the two in Companion B section 1. They keep the pipeline independent of any one model vendor and of any one coding agent.

**ModelPort.** Every model call in the pipeline goes through one interface with three operations. Prompts stay XML-structured and provider-neutral; each provider adapter translates a structured-output request into its API's native mechanism (tool use or JSON schema output for Anthropic, `response_format` JSON schema for OpenAI, `responseSchema` for Google).

```typescript
// src/ports/model.ts

export type ModelTask = 'triage' | 'segmentation' | 'vision' | 'clarify' | 'scout' | 'review';

export interface ModelPort {
  complete(request: CompletionRequest): Promise<CompletionResult>;                 // free text
  vision(request: VisionRequest): Promise<VisionResult>;                           // images in, ImageReading-shaped out
  classify<T>(request: ClassifyRequest<T>): Promise<ClassifyResult<T>>;            // structured output against a JSON schema
}

export interface CompletionRequest { task: ModelTask; system: string; prompt: string; maxTokens?: number; temperature?: number; }
export interface ClassifyRequest<T> extends CompletionRequest { schemaName: string; schema: JsonSchema; validate: (v: unknown) => v is T; }
```

| Provider | Package | Structured output | Vision |
|---|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` | Tool use with a single forced tool whose input schema is the request schema | Image content blocks |
| `openai` | `openai` | `response_format: { type: 'json_schema', strict: true }` | `image_url` content parts |
| `google` | `@google/genai` | `responseMimeType: 'application/json'` plus `responseSchema` | Inline data parts |

Provider and model are chosen per task in the `models` element of `snapwing.config.xml`. The default, written at onboarding, is whichever provider has a key, in the order anthropic, openai, google. A `classify` result that fails `validate` is retried once with the validation error appended, then surfaces as a typed error; it never reaches a stage unvalidated. Unit and contract tests use a recorded mock provider; live model calls happen only in the live and e2e tiers.

**HarnessPort.** The fixer (section 10) and the review agent (section 11.1) are coding agents, and which coding agent is a workspace choice.

```typescript
// src/ports/harness.ts

export interface HarnessPort {
  run(workItem: WorkItemRef, implementationRequest: string, workdir: string, opts: HarnessRunOptions): Promise<HarnessResult>;
}

export interface HarnessRunOptions { role: 'fixer' | 'review'; budget: { wallClock: string; attempts: number }; onCheckpoint: (c: HarnessCheckpoint) => Promise<void>; signal: AbortSignal; }
export type HarnessCheckpoint = { phase: 'cloned' | 'branched' | 'implemented' | 'tested' | 'pushed' | 'pr-opened'; detail?: string };
export type HarnessResult =
  | { outcome: 'done'; branch: string; prNumber?: number; summary: string; testsAdded: string[] }
  | { outcome: 'failed'; reason: string; partialBranch?: string; attempts: number }
  | { outcome: 'stopped'; atPhase: HarnessCheckpoint['phase'] };
```

| Adapter | Invocation | Notes |
|---|---|---|
| `claude-code` | `claude -p` with the implementation request on stdin and `--output-format json` | Default when `claude` is on the runner image |
| `codex` | `codex exec` with the request on stdin | |
| `gemini` | `gemini` CLI in non-interactive mode | |
| `generic` | A command template from config; the implementation request on stdin; one JSON object matching `HarnessResult` on stdout (checkpoints as JSON lines on stderr) | Wires in Cursor, Aider, or anything else without code |

The harness is chosen per workspace in the `harness` element. The RunnerPort (14.3) executes whichever harness is configured inside the ephemeral container; the harness never talks to the database, and checkpoints and results reach the server through the fixer reporting endpoints (Companion B section 9). The `wallClock` budget is an ISO 8601 duration (default `PT30M`), matching 10.4.

**Configuration example.** All three runtime choices live in one validated file:

```xml
<snapwing xmlns="urn:snapwing:config:v1" version="1">
  <runtime provider="local"/>
  <models default-provider="anthropic">
    <model task="triage"       provider="anthropic" name="claude-sonnet-5-5"/>
    <model task="segmentation" provider="anthropic" name="claude-haiku-4-5"/>
    <model task="vision"       provider="openai"    name="gpt-5"/>
    <model task="clarify"      provider="anthropic" name="claude-haiku-4-5"/>
    <model task="scout"        provider="anthropic" name="claude-opus-5-5"/>
    <model task="review"       provider="google"    name="gemini-2.5-pro"/>
  </models>
  <harness fixer="claude-code" review="generic">
    <generic id="aider" command="aider --yes --message-file - --json-result" timeout="PT30M"/>
  </harness>
</snapwing>
```

`schemas/app-config.xsd` validates this file; a task without a `<model>` row uses `default-provider` with that provider's default model for the task. Secrets (API keys) are never in this file; they come from the secrets port by the conventional names `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GOOGLE_API_KEY`.

---

## 15. Ingestion channels

### 15.1 Slack

**Triggers:**

- Message shortcut "Fix it from here" (`message_action`)
- Emoji reaction (`reaction_added` event; lower friction than the context menu and it works on mobile Slack, where many of these threads actually start). The emoji is configurable: 🐛 (`bug`) is the default; onboarding lets the workspace pick another, a channel may override it (`<channel><trigger emoji="…"/></channel>`), and more than one may be registered. Each `<emoji>` may carry `minReactors`, so a workspace can make 🔥 file only when two people agree it is on fire. The bot reacts back with ✅ on the anchor so the reactor knows the tap landed, and ignores its own reactions. Removing the reaction within 60 seconds is treated as a Stop for that trigger.
- Direct message to the bot (`message.im` event) containing an image, text, or both. The DM is its own anchor with an empty window; the vision pass (5.2a) does the work. The bot replies in the DM with the scope preview, and all later cards land there. If the reading resolves to a surface with a bug channel, the status message is also mirrored into that channel so the owning engineer sees it.
- Attachment on a channel message plus the trigger emoji: the image is read as part of the bundle like any other attachment.
- Optional per-channel passive detection (opt-in, section 17)

**Scopes:** `commands`, `chat:write`, `channels:history`, `channels:join`, `groups:history`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`, `files:read`, `im:history`, `im:write`. Event subscriptions: `message.im`, `reaction_added`, `reaction_removed`, `file_shared`. Files are downloaded with the bot token in the `Authorization` header from the file's `url_private_download`; Slack does not serve them unauthenticated.

**Mobile.** A screenshot taken on a phone is shared to the bot's DM with the OS share sheet, which is the whole mobile capture story and needs no app of its own.

**Auth:** HMAC SHA-256 over `v0:{timestamp}:{body}` with the signing secret, timing-safe compare, reject if `|now - timestamp| > 300s`. Carried forward from v1.0 unchanged.

**Acknowledgement:** respond 200 immediately with an ephemeral "On it, pulling context" so the user knows the tap landed.

**Install (self-hosted).** `snapwing onboard` creates the Slack app from `manifests/slack/manifest.yaml` through the `apps.manifest.create` API, using a one-time app configuration token that the user generates in the browser (the CLI opens the page and asks them to paste it). It then opens the OAuth install URL and captures the bot token on the redirect, through a local HTTPS callback or by paste. If the workspace requires admin approval to install, onboarding detects the error, prints the "Request to install" link, and continues with every step that does not need the bot token. The bot is a workspace-level identity: it self-joins public channels with `channels:join` and asks to be invited to private ones.

### 15.2 Microsoft Teams

**Parity rule:** everything Slack can do, Teams can do. Where the platforms differ, the adapter hides the difference and the matrix below says how. Where Teams needs permissions Slack does not, onboarding asks for them and the feature degrades gracefully until they are granted; it never silently fails.

| Capability | Slack | Teams | Gap and handling |
|---|---|---|---|
| Right-click trigger | Message shortcut (`message_action`) | Message extension **action command** on the message "..." menu | None. Same card, same buttons. |
| Emoji trigger | `reaction_added` on any message | Bot Framework `messageReaction` fires **only for messages the bot sent**. For reactions on human messages, subscribe to Microsoft Graph change notifications on the channel's messages (`chatMessage` updated) and diff the `reactions` array. | Requires RSC permission `ChannelMessage.Read.Group` in the app manifest (team owner consent) and, for tenant-wide use, approval for Microsoft's protected APIs. Until granted, the Teams emoji trigger is off and onboarding says so; the action command still works. Reaction names differ per platform, so `<emoji>` carries `slack` and `teams` attributes. |
| Bot DM with screenshot or text | `message.im` | Personal (1:1) chat with the bot; attachments arrive with `contentUrl` | None. Files in personal chat download with the bot token. |
| Attachment on a channel message | `files:read`, `url_private_download` | Channel files live in SharePoint; fetched via Graph with the same RSC grant | Same grant as the emoji trigger; degrades to "please DM me the screenshot" if absent. |
| Channel history for context assembly | `conversations.history`, `conversations.replies` | Graph `channels/{id}/messages` and `.../replies` with `ChannelMessage.Read.Group` (RSC) | Same grant. Without it, Teams context is the anchor message only, and the scope preview says so. |
| Ephemeral acknowledgement | `chat.postEphemeral` | No ephemeral messages in Teams. Acknowledge in the personal chat, and react to the anchor with the ✅ reaction (bots can add reactions via Graph). | Cosmetic; documented. |
| Cards and buttons | Block Kit, `actions` block | Adaptive Cards 1.5 with **Universal Actions** (`Action.Execute`), so taps route to the bot regardless of where the card was posted | None. `verb` values match `ApprovalAction`. |
| Edit status message in place | `chat.update` | `updateActivity` on the stored activity id | None. |
| Mention the owner | `<@U…>` | `<at>` entity in the card with the AAD object id | None. |
| Modal for secrets or clarifying input | Slack modals (`views.open`) | Task modules (dialogs) with an Adaptive Card body | None. Used by onboarding (section 22) so keys are never typed into a channel. |
| Engineer queue | App Home tab | Personal **static tab** rendering the same queue page from the console (section 20.3), signed in with Teams SSO | The tab needs a hosted page; Slack's App Home is pure Block Kit. |
| Role and identity resolution | `users.info`, `users:read.email` | Graph `users/{id}` with `User.Read.All` or the identity in the activity `from` field | None with the app's Graph permissions. |
| Local development | Socket Mode | No socket equivalent; use a dev tunnel (`devtunnel` from the Teams Toolkit, or `ngrok`) | Documented in 14.4. |
| Distribution | Slack Marketplace or shared install link | Teams admin center (org custom app) or the Microsoft commercial marketplace via Partner Center | Section 23. |

**Auth (fixed from v1.0):** validate the Bot Framework JWT against the OpenID metadata endpoint for the Bot Framework, checking issuer, audience (the bot's app ID), and expiry. A bare `Bearer` prefix check is not authentication. If full validation is out of scope for a demo build, the adapter must be marked `DEMO_ONLY` and refuse to start with `NODE_ENV=production`. Graph calls use the app's own credentials (client credentials flow) with the RSC or application permissions declared in the manifest.

**Email correlation (fixed from v1.0):** resolve `aadObjectId` to a UPN via Microsoft Graph rather than string-concatenating `name@company.com`.

**Install (self-hosted).** `snapwing onboard` builds the Teams app package (`manifest.json` plus icons, zipped) and either uploads it to the target team through Graph (if the tenant allows custom app upload and the installer is a team owner) or prints the admin-center instructions and continues. RSC permissions for channel history and reactions are declared in the manifest and consented by the team owner at install. Until they are consented, the Teams adapter runs in **reduced mode** (action command and personal chat only) and says so on every card it posts and in `snapwing status`.

**Test coverage:** every e2e scenario in 14.4 runs once against Slack and once against Teams. The Teams run requires a Microsoft 365 developer tenant with the RSC grant applied to the test team; without it the Teams run is marked partial, not skipped.

### 15.3 Raycast

**Trigger:** global hotkey on selected text (`getSelectedText()`), no-view command.

**First response is a lookup, not a ticket.** The backend runs dedupe first and replies with one of:

- `Already tracked as WEB-830 (open, assigned to Dana). Open it?`
- `New. Looks like the website (from src/cart/... in the trace). File it?`
- `New. Which surface?` with the surfaces from the map as choices

Surface inference for Raycast uses file paths in the pasted text matched against repo trees in the map.

**Auth:** per-user bearer tokens issued at onboarding, not a shared secret, so a leaked token identifies one engineer and is revocable alone.

**Screenshots.** A second Raycast command, "Send Screenshot," takes the most recent file in the macOS screenshots folder (or the clipboard image) and posts it to the same endpoint as an image; it goes through the vision pass like a DMed screenshot.

### 15.4 CLI

For engineers who live in a terminal, and for anything scripted:

```
<cli> shot                     # clipboard image, or the newest screenshot on disk
<cli> shot ./error.png         # a specific file
<cli> shot --surface web       # skip surface inference
<cli> say "checkout total is blank after promo"
<cli> log < error.log          # stdin, like a pasted stack trace
<cli> status WEB-1042          # print the status loopback for a ticket
<cli> stop WEB-1042
```

The CLI uses the same per-user bearer tokens as Raycast, talks to the same endpoint, and gets the same lookup-first response (already tracked, new and inferred, or new and asking which surface). Its cards render as terminal prompts with numbered choices. Nothing in the pipeline knows or cares that the source was a terminal; `source: 'cli'` exists for idempotency keys and metrics only.

### 15.5 Alert webhooks (zero-click)

PagerDuty, Datadog, Sentry. Normalization maps provider fields to surface via the map's `<channel surface="from-payload">` rule. Dedupe runs against open alerts and open issues before any ticket. Alerts follow the same autonomy resolution as any other source, with one extra rule: an alert-sourced incident is capped at level 2 unless the alert carries a confirmed service and environment, because a noisy monitor at level 3 would merge code on a false positive. The fix preview card is posted in the surface's bug channel since there is no originating thread.

---

## 16. Security and guardrails summary

| Concern | Control |
|---|---|
| Authentication | Slack and Teams authenticate the person and the request (Slack signature verification, Bot Framework JWT verification). Raycast and the CLI use Snapwing-issued per-user tokens. |
| Authorization | Snapwing authorizes each action from the workspace map's role and, for merges, a linked GitHub identity. Anyone in the workspace may trigger; only `role="engineer"` may start a fixer (`Fix it`); only linked humans may merge at levels 1 and 2. |
| One install per workspace | Self-hosted: onboarding warns (never blocks) if a bot named Snapwing already exists (section 22.4). Hosted: enforced server-side on `team_id` / `tenant_id`. |
| Replay | Timestamp window on Slack signatures; idempotency keys with TTL on all channels |
| Agent blast radius | Fixer runs in ephemeral container, scoped GitHub App token, one branch in one repo, never merges, no CI or protection changes |
| Merge (levels 1, 2) | Branch protection requires the review agent's check and a human approval; Slack `Merge` button acts as the linked human, never as the bot |
| Merge (level 3) | Opt-in per surface; App on the bypass list only for those repos; review agent plus CI plus risk gate, all re-verified at merge time; one-tap Revert for 72h; every autopilot merge posted to the channel |
| Stop | Available on every card and status message at levels 2 and 3, and as a Jira label; cancels at the next checkpoint |
| Degradation | Any failed gate drops one level and says so; no silent closes, no silent drops |
| Traceability | Ticket key in branch name and every commit; PR body echoes the implementation request; conversation deep link and autonomy level on the ticket; who changed a level is recorded in the map |
| Secrets | Secret Manager; no tokens in the map or in prompts |
| Data retention | `rawPayloadSnapshot` retained 30 days for audit, then purged; screenshots live on the Jira issue only |
| Images | Vision pass flags visible credentials, tokens, or personal data; extracted text is redacted in the ticket and never echoed into a channel; the image itself is attached only to the Jira issue |
| Trigger emoji | Configurable, but the bot ignores its own reactions and requires `minReactors` where set; reaction removal within 60s is a Stop |
| Map integrity | XSD plus Schematron at deploy; corrections applied only after human review of the diff |

---

## 17. Open items for v1.4

- **Rename.** Resolved in v1.5: the product is Snapwing.
- **Deploy tracking.** The staging and production rows in the status loopback assume a deploy event source (GitHub Deployments API, a CD webhook, or a release tag). Specify the adapter.
- **Passive detection.** Per-channel opt-in nudge ("Want me to file this?") when a message pattern-matches a bug. Needs a high precision threshold and a one-tap mute.
- **Embedding-based dedupe** over open issue descriptions, and over image readings so two screenshots of the same broken screen dedupe against each other.
- **Screen recordings.** Short videos (Loom links, phone screen recordings) as a capture source; frame sampling plus the same vision pass.
- **Corrections UI** in the console (section 20.3) for reviewing and applying the learning-loop diff to the workspace map, and for changing autonomy levels with an audit trail.
- **Risk gate tuning.** Start with the mechanical rules in 4.2; consider a learned risk score once there is merge history to train on.
- **Atlassian OAuth 2.0 3LO / Forge** instead of a service-account API token.
- **Teams JWT validation** to lift the `DEMO_ONLY` flag, and Teams parity for DM screenshots.
- **Metrics.** Time from anchor to filed, dedupe hit rate, ask-back rate and answer rate, tap-to-PR time, autopilot merge rate and revert rate, reporter confirmation rate on staging, share of incidents that arrive as images.

---

## 18. Repository layout (target)

A pnpm workspace monorepo. Package boundaries are decided in section 21; this is where the files live.

```
.
├── README.md                        # thesis, architecture diagram, screenshots, Replay link, demo instructions
├── pnpm-workspace.yaml
├── docs/
│   ├── SPEC.md                      # this document
│   ├── guardrails.md
│   ├── live-testing.md              # expanded version of 14.4
│   ├── cards/                       # Block Kit and Adaptive Card JSON for every card
│   ├── onboarding.md                # the interview script and state machine (section 22)
│   └── publishing/                  # per-marketplace checklists and listing copy (section 23)
├── legal/
│   ├── PRIVACY.md                   # required by every marketplace
│   ├── TERMS.md
│   └── SUPPORT.md
├── schemas/
│   ├── workspace-context.xsd
│   ├── workspace-context.sch
│   ├── implementation-request.xsd
│   └── app-config.xsd
├── examples/
│   ├── workspace-context.example.xml
│   └── implementation-request.example.xml
├── manifests/
│   ├── slack/manifest.yaml
│   ├── teams/manifest.json          # with RSC permissions declared
│   ├── teams/color.png, outline.png
│   └── github-app.json              # GitHub App manifest for the one-click create flow
├── infra/
│   ├── aws/                         # Terraform: SQS, ElastiCache, Secrets Manager, ECS
│   ├── gcp/                         # Terraform: Cloud Tasks, Memorystore, Secret Manager, Cloud Run
│   └── docker/                      # Compose: Redis, MinIO, Caddy
├── packages/
│   ├── pipeline/                    # @snapwing/pipeline: contracts, ports, engine, context, resolve, policy, models, harness,
│   │                                #   dedupe, clarify, triage, jira, fixer, review, merge, status, prompts
│   ├── app/                         # @snapwing/app: server (API + worker), slack and teams adapters,
│   │                                #   alert adapter, providers, CLI entry (bin), onboarding interview
│   ├── capture-client/              # @snapwing/capture-client: tiny SDK for token, endpoint, send text/image,
│   │                                #   render the lookup-first response; used by raycast and browser-extension
│   ├── raycast/                     # separate package; published via the Raycast Store
│   ├── browser-extension/           # reserved for v1.5; Chrome, Edge, Firefox; uses capture-client
│   ├── console/                     # admin console and the engineer queue page (Teams tab, section 20.3)
│   └── replay/                      # hosted incident replay page (section 20.4)
├── scripts/
│   ├── jira-bootstrap.ts
│   ├── slack-bootstrap.ts
│   ├── teams-bootstrap.ts
│   └── github-bootstrap.ts
├── demo/                            # recorded channel histories, MSW handlers
└── test/
    ├── unit/
    ├── contract/                    # against recorded real payloads in test/fixtures/
    ├── live/
    └── e2e/                         # one scenario per autonomy level, run against Slack and Teams
```

---

## 19. Changelog

- **v1.5 (2026-10-01):** Renamed to Snapwing; decisions from the decisions section applied: ModelPort and HarnessPort (14.5) with the `models` and `harness` config elements; self-hosted Slack and Teams install flows (15.1, 15.2, 22.4); one install per workspace (22.4); authentication and authorization model (16).
- **v1.4 (2026-09-29):** Teams parity matrix with the Graph/RSC requirements named and graceful degradation specified; `<emoji>` carries per-platform names; monorepo packaging (pipeline, app with server plus Slack plus Teams plus CLI, capture-client SDK, separate Raycast package, reserved browser-extension package); onboarding as a resumable interview with three entry paths and secrets handled through modals or hidden input; GitHub App manifest flow for one-click app creation; publishing section covering Slack Marketplace, Teams admin center and Microsoft commercial marketplace, Atlassian Marketplace via Forge, Raycast Store, GitHub Marketplace, npm, container registry, and browser stores; legal and manifest artifacts added to the repository layout; Socket Mode marked development-only.
- **v1.3 (2026-09-29):** Screenshots from any source as a capture path (Slack DM, attachment plus emoji, phone share sheet, Raycast screenshot command, CLI); vision pass promoted to a core context-assembly stage with a structured `ImageReading` contract, surface signals in the confidence stack, and sensitive-content handling; configurable trigger emoji with per-channel overrides, multiple emoji, `minReactors`, and reaction-removal-as-Stop; Slack scopes and event subscriptions updated; CLI adapter; UI specified by persona (section 20); open items moved to v1.4.
- **v1.2 (2026-09-29):** Autonomy dial (four levels, per-surface/component/priority overrides, degradation rules, Stop everywhere); fixer starts immediately at levels 2 and 3; review-and-merge split into human-in-the-loop (CODEOWNERS requested, Slack card with Merge as the linked human) and autopilot (review agent plus CI plus risk gate re-verified at merge time, App merge, ticket to Done, 72h Revert); provider-agnostic runtime with five ports and local/aws/gcp/docker providers chosen at onboarding; Slack Socket Mode for local development; live-testing section with sandboxes, bootstrap scripts, environment, four test tiers, and hygiene rules; `Autonomy Level` custom field; `MergeGateResult` contract.
- **v1.1 (2026-09-28):** Extended pipeline through fixer, review, and merge; added Workspace Context Model with schema, onboarding, confidence stack, and learning loop; added context assembly (anchor plus window plus sub-threads, segmentation, resolution signals, scope preview); dedupe as a required pre-create stage; ask-back gate with role routing and product-derived options; Fix Preview Card; status loopback; asynchronous orchestration; Teams auth and email correlation fixed; Raycast idempotency TTL and lookup-first behavior; per-user Raycast tokens; typed adapter interface; repository layout.
- **v1.0:** Omnichannel ingestion (Slack, Teams, Raycast, alert webhook), canonical payload, adapter interface, synchronous orchestrator ending at Jira issue creation.

---

## 20. User interface

The thesis is no context switching, so the product's primary UI is the chat client the report started in. A web application people live in would contradict the pitch. UI work is scoped by persona, and the rule for adding any new surface is: does the task fit in a card? If yes, it is a card.

### 20.1 Reporters: cards only

The Fix Preview Card and the pinned status message are the entire product to this persona and get the same design pass a landing page would.

- **One message that edits in place.** The status loopback (section 12) updates a single pinned message. A thread that fills with twelve bot posts is the failure mode.
- **Plain language, no jargon.** Reporters never see a file path, a branch name, or the word "PR." They see "a fix is being reviewed" and "the fix is on staging, can you check?"
- **Buttons over free text.** Every question the gate lets through is 2 to 4 buttons or a screenshot request (section 7.2).
- **A fixed visual vocabulary,** consistent across Slack, Teams, and the CLI: 🐛 filed, 🔧 fixing, 🔍 in review, ✅ live, ⏸ stopped, ↩ reverted. Emoji here are display, not triggers; the trigger emoji is whatever the workspace chose.
- **Block Kit and Adaptive Card mockups live in the repo** (`docs/cards/`) as JSON, so a change to a card is a reviewable diff.

### 20.2 Engineers: cards plus Slack App Home

Engineers see the same cards with more buttons (`Fix it`, `Merge`, `Request changes`, `Stop`, `Revert`), plus the PR and the Jira issue, which already exist and which the `Autonomy Level` field and the echoed implementation request make legible.

The one addition is the **Slack App Home tab**, the native surface most integrations ignore. It shows the engineer's own queue with no separate login and no new app:

- **Assigned to me:** open incidents where they are the resolved owner
- **Fixing now:** fixer jobs in flight on their surfaces, each with Stop
- **Waiting on you:** PRs where they are a requested reviewer, with `Open PR` and `Merge`
- **Recently merged / reverted** on their surfaces, last 7 days

Teams gets the equivalent as a personal tab. The CLI's `status` command prints the same lists.

### 20.3 Tech leads and admins: CLI first, console later

The tasks here do not fit in a chat window, but they are also rare, so the first version is a CLI that edits the XML directly and validates it against the schemas. A web console wraps the same commands later.

**CLI (v1.3 scope):**

```
<cli> onboard                  # connect Slack, Jira, GitHub; auto-propose the four tables; confirm interactively
<cli> map show [surfaces|channels|lexicon|people|triggers]
<cli> map set-level web 2      # change autonomy for a surface, recorded with who and when
<cli> map set-trigger --emoji ladybug [--channel app-bugs]
<cli> corrections review       # walk the learning-loop diff, accept or reject per line
<cli> trace WEB-1042           # the full incident trace: bundle, exclusions, stack result, gates, taps
<cli> metrics [--since 30d]
```

**Console (v1.4 scope):** the same operations with a browser UI, plus the two things a CLI does badly: a visual corrections diff, and the incident trace as a timeline. Built as a single Next.js app under `console/`, served from the same deployment, gated by Slack sign-in and the `engineer` role plus an `admin` flag in the map.

### 20.4 Repository reviewers: the Replay page

Nobody evaluating the showcase has the dev workspace. So the most important UI for the repository's purpose is a **hosted Replay page** that plays back a recorded incident as the cards would have appeared in Slack: the anchor message, the scope preview, the Echo check, the One Question if any, the Fix Preview Card, and the status message editing itself through to "can you check?" A scrubber moves through the timeline; a side panel shows what the pipeline was doing at each step (the bundle, the confidence stack result, the gate decisions, the generated XML).

- One recording per autonomy level, plus one screenshot-sourced incident and one Raycast-sourced incident
- Recordings are captured from the e2e tier (14.4) and committed under `replay/recordings/`, so the Replay is never hand-faked
- The README leads with real screenshots from the dev workspace and links to the Replay in the first screen

### 20.5 What is deliberately not built

- No standalone reporter app, web or mobile. The phone story is the share sheet into the bot's DM.
- No dashboard that duplicates Jira. Jira is the system of record; the product writes to it and links to it.
- No chat UI of its own. Every conversation happens in Slack, Teams, or a terminal.

---

## 21. Packages and distribution shape

### 21.1 Package boundaries

| Package | Contains | Installed by | Why it is separate |
|---|---|---|---|
| `@snapwing/pipeline` | Contracts, ports, engine, every pipeline stage, prompts, schemas | Nothing directly; a dependency of `app` | The core has no opinion about chat platforms or clouds and is testable without either |
| `@snapwing/app` | Server (API handler plus worker), Slack adapter, Teams adapter, alert adapter, cloud providers, the CLI (`bin`), the onboarding interview | Self-hosters (`npx snapwing onboard`, `docker run`), and the hosted offering | Slack, Teams, and the CLI share tokens, endpoints, card rendering, and the onboarding flow; splitting them would triplicate the same auth and card code. One install gives a workspace everything. |
| `@snapwing/capture-client` | A few hundred lines: store a per-user token and endpoint, send text or an image, parse the lookup-first response into choices | A dependency of `raycast` and `browser-extension` | The "capture from anywhere" surfaces share exactly this and nothing else |
| `@snapwing/raycast` | The Raycast extension (selected text, screenshot) | Raycast users, from the Raycast Store | Raycast extensions are published from a dedicated directory structure and reviewed by Raycast; keeping it separate keeps the store submission clean |
| `@snapwing/browser-extension` | Reserved. Chrome, Edge, and Firefox extension: send the current selection, or a screenshot of the tab, with the tab URL attached | Browser users, from the stores | Same SDK as Raycast. The tab URL is a free surface signal, which makes this the best-context capture surface of all |
| `@snapwing/console` | Admin console and the engineer queue page that Teams renders as a personal tab | Served by `app`, or hosted | A web app with its own build; deploys alongside the server |
| `@snapwing/replay` | The incident replay page | Static hosting | Zero dependencies on the server; a static site that reads recordings |

### 21.2 Two distribution models, one codebase

- **Self-hosted.** The workspace runs `app` on its own provider. It creates its own Slack app from the manifest, its own Teams app from the manifest, its own GitHub App through the manifest flow, and supplies its own Jira credentials. No marketplace listing is required for any of this, and the showcase repository targets this model first.
- **Hosted.** One deployment of `app` serves many workspaces. This is what marketplace listings are for (section 23). The code paths are the same; the difference is multi-tenant secrets (per-workspace entries behind the secrets port), OAuth install flows instead of manifest-created apps, and the listing artifacts. The spec is written so that moving from self-hosted to hosted is configuration and publishing work, not architecture work.

---

## 22. Onboarding

Onboarding is the product's first impression and its highest-risk step: it asks non-technical people for credentials and decisions. It is designed as one resumable state machine with three ways in, and the XML map is its output, never its input.

### 22.1 Three ways in

| Path | Who it is for | How it starts | Where the interview happens |
|---|---|---|---|
| **Click** | Anyone; the hosted offering | An "Add to Slack" or "Add to Teams" button on the website or marketplace listing. OAuth installs the app; the bot immediately DMs the installer. | In chat, with buttons and modals |
| **Paste** | A developer self-hosting | One line: `npx snapwing onboard` (or `docker run ... onboard`) | In the terminal, as a conversational interview with hidden input for secrets |
| **In chat** | Anyone in a workspace where the app is installed but not configured, or an admin reconfiguring later | Type anything to the bot, or run `/snapwing setup` | In chat, same as Click |

All three paths write the same state and can hand off to each other: a developer can paste the command, connect Jira and GitHub in the terminal, and let the product owner finish the emoji and autonomy choices in chat the next morning.

### 22.2 The interview

The onboarding agent interviews, it does not present a form. Every step is one question in plain language, validated live before moving on, with the technical detail available on request and never required.

| Step | What is asked | How it is validated | Notes |
|---|---|---|---|
| 1. Chat platform | Already done by the install; confirm which channels the bot may read | Lists channels; asks for the bug-shaped ones; asks about private channels explicitly | Teams: explains the RSC grant in one sentence and offers a link for the team owner |
| 2. Jira | "Which Jira site? Paste its address." Then either sign in (OAuth 3LO, hosted) or paste an API token (self-hosted) | Calls `/myself`; lists projects; asks which project bugs go to per surface | Tokens are entered in a Slack modal, a Teams task module, or a hidden terminal prompt. Never in a channel message. |
| 3. GitHub | "Click this to create the app" (GitHub App manifest flow, which creates the app with the right permissions in one click) then "install it on the repos you want fixed" | Verifies the installation; lists repos | Self-hosters get their own App; the hosted offering uses the published one |
| 4. Surfaces | "Here is what I think your products are, based on your repos and Jira projects. Right?" | Confirms or renames each; asks which channel goes with which | Auto-proposed from step 1 to 3 |
| 5. Words | "Do people call any of these something else? For example, does anyone say 'the site' or 'the portal'?" | Proposes candidates from a 90-day scan of the bug channels | Seeds the vocabulary table |
| 6. People | "Who owns each product? I found these names in CODEOWNERS and Jira." | Confirms; asks for backups | Seeds ownership |
| 7. Trigger | "Pick the reaction people will use to file a bug. Most teams use 🐛." with an emoji picker | Checks the reaction exists on each platform; offers a second one | Per-channel overrides offered only if asked |
| 8. Autonomy | "How much should I do on my own?" with the four levels described in one line each, defaulting to Ask (level 1) | Recommends starting at Ask for everything and promoting later | Records who chose what |
| 9. Test drive | "Let's try one." The bot posts a sample bug in a sandbox channel, the installer reacts, and the pipeline runs end to end against a sample repo | Passes when a PR opens on the sample repo | The first success is the last step of onboarding, on purpose |

Progress is saved after every step. An abandoned onboarding resumes where it stopped. Every answer can be changed later with `snapwing map ...` or by telling the bot "change the bug emoji."

### 22.3 What the installer never sees

- XML. The map is written and validated behind the scenes; `snapwing map show` prints it for people who want it.
- Field IDs, webhook URLs, custom field creation, transition names. The Jira bootstrap (14.4) runs inside step 2.
- A secret in a chat message. Any credential arrives through a modal, a task module, an OAuth redirect, or a hidden terminal prompt, and goes straight to the secrets port.

### 22.4 Self-hosted installs and one install per workspace

- **Slack.** The Paste path creates the Slack app from the manifest and installs it as described in 15.1. An install that needs admin approval does not stop onboarding: the "Request to install" link is printed, and steps 2 through 6 continue without the bot token.
- **Teams.** The Paste path builds and uploads (or hands off) the app package as described in 15.2. Until the team owner consents to the RSC permissions, the adapter runs in reduced mode and onboarding says so in step 1.
- **One install per workspace.** Self-hosted onboarding lists bot users (`users.list`, `is_bot`) and warns if one named Snapwing already exists; on Teams it queries `/teams/{id}/installedApps` when the permission is granted. This is best effort, with a clear warning, and never a hard block. The hosted offering (later) enforces one install server-side on `team_id` / `tenant_id`.

---

## 23. Publishing and marketplaces

Self-hosting needs none of this. The hosted offering needs most of it, and the repository carries the artifacts for all of it so that publishing is a checklist, not a project. Marketplace rules change; each entry below is a v1.4 snapshot to be re-verified against the platform's current guidelines at submission time.

| Marketplace | What is listed | Hard requirements | Repo artifacts |
|---|---|---|---|
| **Slack Marketplace** | The Slack app (hosted) | OAuth v2 install flow over HTTPS; no Socket Mode; a privacy policy, support contact, and app description; a security and functionality review by Slack; scopes justified in the listing | `manifests/slack/manifest.yaml`, `legal/*`, listing copy and screenshots in `docs/publishing/slack/` |
| **Microsoft Teams** | The Teams app (hosted); org-only installs use the admin center | Two routes: (a) **org custom app** uploaded in the Teams admin center, no external review, fine for self-hosters and pilots; (b) **Microsoft commercial marketplace** via Partner Center, with manifest validation, a store review, and optional Microsoft 365 App Certification. RSC permissions must be declared in the manifest and are consented by the team owner at install. | `manifests/teams/manifest.json` plus icons, `legal/*`, validation checklist and copy in `docs/publishing/teams/` |
| **Atlassian Marketplace** | Only if the Jira side becomes a Forge app | Not required in v1.4 (the app uses REST with an API token or OAuth 3LO from the developer console, which needs no listing). A Forge app is the right long-term shape: it replaces service-account tokens, can render the incident trace as an issue panel, and lists on the Marketplace. Forge apps have their own review and hosting rules. | Deferred to the Forge item in section 17; `docs/publishing/atlassian.md` holds the rationale |
| **Raycast Store** | The Raycast extension | Submitted as a pull request to Raycast's public extensions repository; reviewed by Raycast; must be open source there; requires README, changelog, icon, and screenshots; no external binaries | `packages/raycast/` structured to Raycast's template, with its own README and CHANGELOG |
| **GitHub Marketplace** | The GitHub App (hosted) | The App must be owned by an organization; free listings are permitted; requires a verified publisher, privacy policy, support URL, and a description of the permissions used. Self-hosters skip this entirely and create their own App through the manifest flow. | `manifests/github-app.json`, `legal/*`, listing copy in `docs/publishing/github/` |
| **npm** | `@snapwing/app` (with the CLI), `@snapwing/pipeline`, `@snapwing/capture-client` | A scoped organization on npm; provenance attestations from CI; a `bin` entry so `npx snapwing onboard` works | `package.json` per package; publish workflow in CI |
| **Container registry** | The server image | GHCR or Docker Hub; multi-arch; signed | `Dockerfile`, publish workflow |
| **Browser stores** (v1.5) | Chrome Web Store, Microsoft Edge Add-ons, Firefox Add-ons | Each has a developer account, a review, a privacy disclosure, and (Chrome) a one-time fee; Manifest V3 | `packages/browser-extension/` |

### 23.1 Artifacts every listing wants

Kept once, in the repository, and reused: a privacy policy and terms (`legal/`), a support channel, an app icon in every required size, a 60-second demo video (the Replay page doubles as its source), listing copy in three lengths (one line, one paragraph, full), and screenshots from the dev workspace at each platform's required dimensions.

### 23.2 Order of operations

1. Self-hosted release: npm packages, container image, manifests, and the onboarding interview. This is what the showcase demonstrates.
2. Raycast Store, because it is the cheapest listing and the most visible one to engineers.
3. Teams org custom app and the Slack shared-install link, for pilots without any review.
4. Slack Marketplace and Microsoft commercial marketplace, once there is a hosted deployment with multi-tenant secrets and a support process.
5. GitHub Marketplace alongside item 4.
6. Atlassian Marketplace when the Forge app exists.
