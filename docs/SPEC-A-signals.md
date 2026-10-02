# Snapwing Companion Spec A: Signals, Observability, and Configuration

**Status:** Living Document, Companion A v1.1
**Changelog:** vA1.1 (2026-10-01): renamed to Snapwing; decisions from the decisions section applied. vA1.0: first version.
**Read after:** the main spec (v1.5). This document extends sections 4, 5, 12, 15, and 16 of that spec and assumes its vocabulary: autonomy levels, the workspace map, the confidence stack, the status loopback, the Fix Preview Card.
**Naming:** the product is Snapwing (main spec v1.5). This document says "the agent" for the running system.

---

## 0. Why this document exists

The main spec treats one emoji as a starter button and the conversation as something the agent reads once, at capture time. That undersells what a channel actually is. A bug thread is a live stream of human intent: someone claims it, someone approves it, five people pile on the same reaction because it is hurting them, someone says "on it" and disappears for twenty minutes. Today all of that is invisible to tooling. This document makes it legible.

Three additions:

1. **A signal vocabulary.** Reactions and short messages carry intent (fix this, I've got this, stop, approved, looking), and the agent acts on them according to who sent them, what they were attached to, and how many there are.
2. **Observability on demand.** The agent keeps a complete, queryable account of every incident and answers "where are we with X?" instantly and accurately, without spamming the channel by default.
3. **A configuration layer for humans.** A validated playbook plus a freeform instructions file, so a workspace can encode "page the CTO if checkout is down for more than 30 minutes" without anyone reading the source.

---

## 1. Signal vocabulary

### 1.1 Intents

Every reaction and every short message is classified into one intent. The default mapping ships with the product and is overridable in the playbook (section 6).

| Intent | Default emoji | Default phrases | Meaning |
|---|---|---|---|
| `trigger` | 🐛 (workspace-configurable, main spec 15.1) | "snap it", "file this", "can someone fix this" | Start the pipeline |
| `escalate` | 🔥 🚨 | "this is urgent", "customers are hitting this", "prod is down" | Raise priority; may also trigger if no incident exists yet |
| `claim` | 👀 🙋 | "on it", "looking", "checking", "I got it", "mine", "taking a look" | A human is investigating; hold the fixer |
| `release` | 🙅 | "not it", "can't right now", "someone else take this", "handing off" | The claimer stepped back; pipeline may resume |
| `stop` | 🛑 ✋ | "stop", "hold off", "don't fix this yet", "wait" | Halt the fixer at the next checkpoint (main spec 4.6) |
| `accept` | 👍 🙏 ✅ ❤️ 🎉 | "looks good", "works now", "confirmed", "ship it" | Acknowledgement or approval, meaning depends on target (1.3) |
| `reject` | 👎 ❌ | "still broken", "not fixed", "nope" | The fix did not work, or the diagnosis is wrong |
| `watch` | 🔔 👁️ | "keep me posted", "let me know", "ping me when" | Subscribe this person to push updates for this incident (section 4) |
| `not-a-bug` | 🤷 | "that's expected", "working as intended", "user error on my end" | Close as not a bug |

Reaction names are stored per platform (`slack` and `teams` attributes, as in the main spec's `<emoji>` element) because the two platforms do not share a reaction namespace.

### 1.2 Classification

Reactions classify by lookup. Messages classify in two passes:

1. **Lexicon pass.** Short messages (default: under 12 words) posted in the incident's window or thread are matched against the phrase lexicon, case-insensitive, punctuation-stripped, with light stemming ("looking" matches "looking into it"). Cheap, deterministic, and it covers the rapid-fire cases that matter most.
2. **LLM pass.** Messages that miss the lexicon but sit inside an active incident's thread are classified by the segmentation model (main spec 5.3), which already reads them. The model returns one intent or `none` and a confidence; intents under the confidence floor (default 0.7) are ignored.

The lexicon is per workspace and grows through the learning loop (main spec 4.5): when an engineer corrects the agent ("no, 'peeking' means I'm looking"), the phrase is proposed for the lexicon.

### 1.3 Target matters

The same 👍 means different things on different messages. The agent posts a fixed set of message roles, and intent is resolved as `(intent, target role, reactor role)`.

| Target role | `accept` means | `reject` means | `claim` means |
|---|---|---|---|
| Anchor (the original human message) | Agreement that it is a bug; counts toward escalation (1.4) if the reactor is a reporter, toward confirmation if an engineer | Dispute that it is a bug; three from engineers with no trigger from an engineer holds the pipeline at ticket-only | A human is on it; hold the fixer (section 2) |
| Scope preview | "Looks right" | "Widen" or "Narrow" (the buttons remain the primary path) | n/a |
| Dedupe card | "Yes, link it" | "No, create new" | n/a |
| Fix Preview Card | From an engineer: same as tapping `Fix it` at level 1 (only if `reactionsAsButtons` is on, default off) | Same as `Not a bug` from an engineer; from a reporter, recorded as a comment | Hold the fixer; claimer becomes assignee |
| PR card | From an engineer with a linked GitHub identity: recorded as a review comment on the PR ("Approved in Slack by Dana at 3:14 PM"); never converted to a GitHub approval unless `reactionsAsApproval` is on (default off, section 6) | Recorded as "Changes requested in Slack by …" and the review agent is re-run with the objection | n/a |
| Staging check ("can you check?") | **Verification.** Recorded on the Jira issue and the PR: "@pat verified on staging at 3:22 PM." Unblocks production deploy at levels 2 and 3 if the playbook requires reporter verification | Reopens the incident: ticket back to In Progress, fixer re-enqueued with the rejection attached, status message says so | n/a |
| Status message | Acknowledgement; no action | Treated as `reject` on the most recent stage | n/a |

**Reactor role** comes from the workspace map. A reporter's 👍 on a PR card is a comment; an engineer's 👍 on a PR card is a review note. Nobody's reaction merges anything.

### 1.4 Counting: escalation by weight of reactions

Several people reacting the same way is a signal on its own. The agent counts **unique reactors** per intent per incident (one person reacting five times is one), within a rolling window (default 2 hours from the anchor), and weights by role.

```
score(intent) = Σ over unique reactors of weight(role)
  weight: reporter = 1.0, engineer = 1.5, owner of the surface = 2.0
```

Default ladders, all overridable in the playbook:

| Intent | Score reached | Effect |
|---|---|---|
| `trigger` or `escalate` | 3 | Priority raised one step (Medium → High); status message notes "3 people are reporting this" |
| `trigger` or `escalate` | 5 | Priority raised to Highest; the surface owner is mentioned; the ask-back gate is suppressed (it is an incident, not a question) |
| `trigger` or `escalate` | 8 | Treated as an outage: the escalation ladder in the playbook starts (section 6.2), and the agent begins active polling (section 4.3) |
| `accept` on the anchor | 3 | Recorded as "confirmed by multiple people" on the ticket; no priority change on its own |
| `reject` on the anchor, engineers only | 3 | Pipeline held at ticket-only; owner asked to adjudicate |

Priority only moves up automatically. It never moves down without a human, because a bug that stopped getting reactions did not stop being a bug.

Escalation by reactions happens **after** the incident exists. Reactions accumulating on a message that has no incident yet are counted the moment one is created, so "five people reacted 🔥 before anyone reacted 🐛" still lands as Highest.

### 1.5 Attribution comments

Every intent that changes state, and every `accept` and `reject` regardless of effect, is written to the Jira issue (and to the PR when one exists) as a comment with attribution, timestamp, and a deep link to the message:

> **@pat** approved on staging at 3:22 PM ([message](https://…))
> **@dana** is looking at this on staging as of 2:47 PM ([message](https://…))
> **@marcus** stopped the fix at 2:51 PM: "hold off, I think this is the CDN" ([message](https://…))

Comments are batched: several reactions within 60 seconds become one comment listing all of them. This is how a stakeholder who only reads Jira sees what happened in Slack, and it is what makes the audit trail complete without anyone writing it.

### 1.6 Removal

Removing a reaction reverses its effect where reversal is safe:

- Removing `trigger` within 60 seconds is a Stop (main spec 15.1).
- Removing `claim` is a `release`.
- Removing `watch` unsubscribes.
- Removing `accept` on a staging check withdraws the verification and holds any deploy that depended on it.
- Removing `escalate` reduces the score but never lowers a priority already raised (1.4).

---

## 2. Claims: when a human is already on it

### 2.1 The rule

If a human claims an incident, the agent does less, not more. A `claim` from anyone with `role="engineer"` in the map, arriving between the anchor and the moment the fixer would start, has these effects:

1. The incident is filed (ticket only), assigned to the claimer, labeled `human-claimed`.
2. The fixer is not started, whatever the autonomy level. The Fix Preview Card is replaced with:

   > Filed as **WEB-1042** and assigned to @dana, since she's on it. **[Let the agent take it]** **[Not a bug]**

3. The scout still runs read-only and posts its diagnosis as a Jira comment, so the human gets the agent's homework without the agent touching the code.
4. The status loopback continues; stage updates come from the ticket's transitions and the human's PRs (matched by ticket key) instead of from the fixer.

A `claim` from a reporter is recorded as a comment ("@pat is looking into it") and does not hold the pipeline, because reporters looking at the symptom is not the same as engineers looking at the cause.

### 2.2 Claims arriving mid-flight

If the fixer is already running when a claim arrives, the agent does not abort; it posts:

> @dana, the fixer started on this 4 minutes ago and is on `fix/WEB-1042`. **[Let it finish]** **[Stop it, I'll take over]**

Silence for 10 minutes defaults to `Let it finish`. Stopping leaves the branch for the human, as in the main spec.

### 2.3 Environment protection

A claim on a specific environment ("looking on staging", 👀 on the staging-check message) sets an **environment hold**:

- The agent will not deploy to, reset, or reseed that environment for this incident while the hold is active.
- A comment goes on the ticket and the PR: "Do not redeploy staging: @dana is investigating there as of 2:47 PM."
- If a deploy is the next step, the status message says it is waiting on the hold and mentions the holder.

Holds expire after `claim.holdExpiry` (default 2 hours) of no activity from the holder, with a nudge at the halfway mark: "@dana, still on staging? I'll assume you're done in an hour." A `release` or a `not-a-bug` from the holder ends it immediately.

### 2.4 Claim expiry

A claim with no activity (no message from the claimer in the thread, no ticket transition, no commit with the key) for `claim.expiry` (default 4 hours, business hours only) prompts once: "@dana, still on WEB-1042? React 👀 to keep it, or I can take it." No answer within a further hour returns the incident to its configured autonomy level and says so.

---

## 3. Text signals beyond claims

The lexicon and LLM passes (1.2) also catch, within an active incident's thread:

- **Resolution signals** ("nvm, works now", "fixed in the deploy that just went out"): already in the main spec 5.4; now they also apply after filing, and close the ticket with resolution "Cannot Reproduce" or "Fixed" after one confirmation prompt.
- **Environment mentions** ("this is staging", "happening on prod too"): update the incident's environment field and, for production mentions on a staging-scoped incident, raise priority one step.
- **Scope changes** ("also the footer is broken", "same thing on the app"): proposed as a linked incident, not merged into the current one, with a card: "Sounds like a second issue on mobile. File it separately? **[Yes]** **[It's the same bug]**"
- **Handoffs** ("@marcus can you take this?"): if the mentioned person reacts `claim` or says yes within 15 minutes, reassign; otherwise nothing.

None of these post a message on their own except the scope-change card. They update the incident state and show up in status answers.

---

## 4. Observability

### 4.1 Principle

The agent always knows where every incident is, and can say so on request in under a second. It does not narrate by default. The main spec's status loopback edits one pinned message silently; this section adds the ability to ask, the ability to subscribe, and active monitoring for incidents that warrant it.

### 4.2 The incident event log

Every incident is an append-only log of events, each with an actor, a source (slack, teams, jira, github, ci, deploy, agent, cli), a timestamp, and a payload:

```
captured → context-assembled → resolved → dedupe-checked → clarified? → planned →
filed → claimed? → fixer-started → pr-opened → review-passed | review-failed →
ci-green | ci-red → merged → deployed:staging → verified? → deployed:production → closed
plus at any point: escalated, stopped, released, held:<env>, comment:<intent>, level-changed
```

Current state is derived from the log, never stored separately, so a status answer and the Replay page (main spec 20.4) and the metrics all read the same truth. The log is the audit trail for the guardrails in main spec 16, and it is what makes "who approved this and when" a query rather than an archaeology project.

### 4.3 Pull: asking the agent

Anyone can ask, in any of these ways, and gets an answer in the same place:

- Mention the bot in a thread: "@agent where are we with this?"
- Mention the bot anywhere with a description: "@agent status on the checkout thing" or "@agent WEB-1042"
- DM the bot: "what's open on the website?"
- Slash command `/status [key or words]`, CLI `<cli> status [key or words]`, or the App Home tab

**Resolving "the checkout thing."** In a thread, the incident is the thread's. Elsewhere, the agent matches the words against open incidents using the vocabulary table, component names, and summary similarity, and asks only if two candidates tie ("WEB-1042 (blank cart total) or WEB-1051 (promo code rejected)?").

**Answer shape**, tuned to who asked:

Reporter:
> **WEB-1042, blank cart total.** Filed 2:31 PM. A fix is being reviewed (since 2:58 PM). Next: it goes to staging, and I'll ask you to check. Nothing needed from you right now.

Engineer:
> **WEB-1042** · High · Dana · fix-now
> filed 2:31 → fixer 2:32 → PR #418 2:49 → review agent ✅ 2:58 → CI 🟡 running (4 min) → waiting on: CI, then @dana's approval
> Hold: none. Watchers: @pat, @boss. [Open PR] [Open ticket] [Stop]

Stakeholder asking about a surface rather than an incident ("how's the website today?") gets a list: open incidents on that surface, one line each, worst first.

Every answer ends with the next expected step and who or what it is waiting on, because "where are we" is really "what's the holdup."

### 4.4 Push: subscriptions and the notification policy

Off by default beyond the silent pinned edit. Three ways to turn it on:

- **Per person, per incident:** react `watch` (🔔) or say "keep me posted." The watcher is mentioned on milestone events (filed, PR open, merged, on staging, live, stopped, failed) in the incident's thread, and in a DM if they are not in the channel.
- **Per person, standing:** "keep me posted on the website" in a DM subscribes to every incident on that surface; `<cli> watch web`.
- **Per incident, by policy:** the playbook can force push updates for a priority or a surface (section 6.2). The reporter is always mentioned on the staging check regardless, because that is a request, not a notification.

Notifications respect quiet hours and rate limits from the playbook; a burst of events within 5 minutes becomes one message.

### 4.5 Active monitoring for critical incidents

Webhooks are the normal source of truth. For incidents that qualify (Highest priority, or an outage score from 1.4, or a surface the playbook marks `critical`), the agent stops waiting to be told:

- Polls CI and deploy status every `monitor.interval` (default 60 seconds) instead of relying on the completion webhook.
- Posts progress to the thread on every stage change and every `monitor.heartbeat` (default 10 minutes) even without one ("Still in CI, 12 minutes; typical for this repo is 9. Watching.").
- Detects stalls: no event for `monitor.stallAfter` (default 15 minutes) triggers the escalation ladder (6.2).
- Stops monitoring on close, or when a human downgrades the priority.

Active monitoring is the one place the agent posts unprompted. It is scoped to incidents where every minute costs something, and the playbook decides which those are.

### 4.6 Digests

Optional, off by default: a daily or weekly summary to a channel or a DM: incidents opened and closed, time to PR, autopilot merges and reverts, the three oldest open incidents and what they are waiting on. Configured in the playbook; useful for the tech lead persona and for nobody else.

---

## 5. Recognizing human error

### 5.1 What the agent can see

Some "bugs" are the reporter's environment: wrong site, wrong account, stale cache, a browser extension, caps lock, an expired session, a VPN that dropped. The agent can only see these through what the reporter shows it, which in practice means a screenshot or a screen recording. The vision pass (main spec 5.2a) gains a field:

```typescript
userSideIndicators: {
  kind: 'wrong-environment' | 'wrong-account' | 'stale-cache' | 'extension-interference'
      | 'input-mode' | 'expired-session' | 'network' | 'wrong-surface' | 'other';
  evidence: string;          // "URL bar shows staging.example.com"
  confidence: number;        // 0..1
}[]
```

Typical evidence: a staging or localhost hostname in the URL bar; an account name in the header that does not match the reporter; a "you've been logged out" banner; an ad blocker or password manager overlay covering a button; a caps lock indicator next to a password field; a screenshot of the admin portal when the report says "the website."

Screen recordings (Loom links, phone recordings, any video under `recording.maxDuration`, default 3 minutes) are sampled at one frame per second plus every frame where the scene changes, run through the same pass, and summarized as a sequence: "0:04 opens cart, 0:11 applies promo, 0:12 total goes blank." Recordings are the strongest evidence for both real bugs and user-side causes, and the agent asks for one when a screenshot is ambiguous and the reporter is an engineer.

### 5.2 How the agent behaves

The agent never tells a reporter they made a mistake, and never labels a ticket "user error." It converts the indicator into one check, asked before filing, phrased as a favor:

> Before I file this: your screenshot shows **staging.example.com**, which is the test site. Can you try the same thing on **example.com**? **[That fixed it]** **[Still broken]** **[I meant staging]**

- **That fixed it** → no ticket; a `user-side` event goes in the log with the indicator kind; the thread gets "Great, no bug then. Flagging that the staging link is easy to land on." The reporter's name is not attached to anything in Jira.
- **Still broken** → file normally, with the check recorded so engineers do not repeat it.
- **I meant staging** → file with environment set correctly.

This check counts against the ask-back budget (main spec 7.2), so it is the one question if it is asked, and the gate's rules still apply: it must be answerable from the reporter's screen and presented as buttons.

### 5.3 When user error is a product bug

Three different people hitting the same `user-side` indicator on the same surface in 30 days is a UX defect, not three mistakes. The agent files one ticket, type Task, labeled `ux-friction`, summarizing the pattern without naming anyone ("3 reporters landed on staging from a link in #sales-team"), and posts it to the surface's bug channel. The threshold and whether this happens at all are in the playbook.

---

## 6. Configuration

### 6.1 Three layers

The product runs with no configuration beyond onboarding. Everything in this document has a default. But every workspace has rules nobody wrote down, and the place to write them down should not be the source code.

| Layer | File | Authored by | Validated by | Precedence |
|---|---|---|---|---|
| Workspace map | `workspace-context.xml` | Onboarding and the learning loop (main spec 4) | XSD + Schematron | lowest |
| Playbook | `playbook.xml` | Admins, via the console, the CLI, or a text editor | XSD + Schematron | middle |
| Instructions | `INSTRUCTIONS.md` | Anyone with admin rights, in prose | Size cap and a lint for contradictions | highest, within what the playbook allows |
| Per-incident taps | (none) | Whoever taps | n/a | overrides all of the above for that incident |

The playbook is structured because its contents are things a machine must apply exactly: thresholds, ladders, schedules, mappings. The instructions file is prose because its contents are things only a model can apply: judgment calls, tribal knowledge, exceptions. The instructions are injected into the triage, clarify, fixer, and review prompts as a `<workspace-instructions>` block, and they cannot loosen a guardrail the playbook sets (an instruction saying "always merge automatically" is ignored where the playbook's autonomy level says otherwise, and the lint says so at load time).

Both files are hot-reloaded on change and validated before they take effect; an invalid file is rejected with the reason, and the previous version stays live. Onboarding writes a default playbook and an empty instructions file with a commented example, so a nontechnical installer never opens either.

### 6.2 `playbook.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<playbook xmlns="urn:snapwing:playbook:v1" version="1">

  <!-- 1. Signal vocabulary overrides (defaults in Companion A, 1.1) -->
  <signals>
    <intent name="trigger">
      <emoji slack="bug" teams="bug" />
      <emoji slack="ladybug" teams="ladybug" channel="app-bugs" />
    </intent>
    <intent name="claim">
      <emoji slack="eyes" teams="eyes" />
      <phrase>on it</phrase>
      <phrase>peeking</phrase>              <!-- learned from a correction -->
    </intent>
    <intent name="accept">
      <emoji slack="+1" teams="like" />
      <emoji slack="pray" teams="pray" />
      <emoji slack="heart" teams="heart" />
    </intent>
    <intent name="stop">
      <emoji slack="octagonal_sign" teams="stop" />
    </intent>
    <intent name="watch">
      <emoji slack="bell" teams="bell" />
    </intent>
    <lexicon maxWords="12" confidenceFloor="0.7" />
    <reactionsAsButtons enabled="false" />      <!-- engineer 👍 on Fix Preview = Fix it -->
    <reactionsAsApproval enabled="false" />     <!-- engineer 👍 on PR card = GitHub approval -->
  </signals>

  <!-- 2. Counting and escalation by reactions -->
  <weights reporter="1.0" engineer="1.5" owner="2.0" window="PT2H" />
  <ladder intent="trigger escalate">
    <step score="3" priority="+1" note="true" />
    <step score="5" priority="Highest" mentionOwner="true" suppressAskBack="true" />
    <step score="8" outage="true" />
  </ladder>

  <!-- 3. Claims -->
  <claims expiry="PT4H" holdExpiry="PT2H" midFlightGrace="PT10M" businessHoursOnly="true" />

  <!-- 4. Notifications -->
  <notifications>
    <quietHours tz="America/New_York" from="20:00" to="08:00" exceptPriority="Highest" />
    <rateLimit perIncident="PT5M" />
    <forcePush priority="Highest" />
    <forcePush surface="checkout" />
    <digest to="#eng-leads" cron="0 9 * * 1-5" />
  </notifications>

  <!-- 5. Active monitoring -->
  <monitor interval="PT60S" heartbeat="PT10M" stallAfter="PT15M">
    <critical surface="checkout" />
    <critical surface="auth-web" />
  </monitor>

  <!-- 6. Escalation ladders: what to do when a critical incident stalls -->
  <escalation name="outage">
    <after duration="PT0M"  mention="owner" />
    <after duration="PT30M" mention="@U0ENGLEAD" />
    <after duration="PT60M" pagerduty="P123ABC" />
    <after duration="PT2H"  mention="@U0CTO" channel="#incidents" />
    <applyWhen priority="Highest" />
    <applyWhen outage="true" />
  </escalation>
  <escalation name="stalled-fix">
    <after duration="PT15M" mention="owner" />
    <after duration="PT45M" mention="@U0ENGLEAD" />
    <applyWhen monitored="true" stalled="true" />
  </escalation>

  <!-- 7. Human-error handling -->
  <userSide check="true" uxFrictionThreshold="3" uxFrictionWindow="P30D" />

  <!-- 8. Recordings -->
  <recordings maxDuration="PT3M" sampleFps="1" />

</playbook>
```

Every element has a default; an empty `<playbook/>` is valid. The XSD enforces types and durations (ISO 8601); the Schematron enforces that every mention resolves to a person in the map, every surface exists, and no escalation step is shorter than the one before it.

### 6.3 `INSTRUCTIONS.md`

Freeform, injected verbatim (up to 4,000 characters) into the agent's prompts. What belongs here is what a new engineer would be told in their first week:

```markdown
# Workspace instructions

- The payments service (src/payments) is owned by an outside vendor. Never start the fixer on it;
  file the ticket and mention @vendor-liaison.
- "The portal" and "the dashboard" are the same thing (admin surface).
- Sales reps report bugs in #sales-team. Assume production unless they say otherwise.
- During a release window (announced in #releases), hold all autopilot merges until the window closes.
- If the CEO reports something, treat it as High minimum, and be brief.
- Our staging environment resets nightly at 2 AM Eastern; a "works on staging" after 2 AM may be the reset.
```

The lint flags instructions that conflict with the playbook or the guardrails and shows the conflict in the console and on `<cli> config check`. It does not try to be clever beyond that; the point of the file is that a human wrote it and a human can read it.

### 6.4 Precedence in practice

A concrete case: the playbook sets `checkout` to autonomy level 3, `INSTRUCTIONS.md` says "hold all autopilot merges during a release window," and a release window is open.

1. Fixer starts immediately (level 3 says so; nothing above it disagrees).
2. Review agent and CI pass.
3. The merge step reads the instructions block, sees the release-window rule, and degrades to level 2 for this merge: CODEOWNERS requested, status message says "Holding for the release window per workspace instructions."
4. A human taps `Merge` anyway. The tap wins; the log records who and why.

Instructions can make the agent more careful. Only the playbook can make it bolder, and only within the autonomy dial.

---

## 7. Contracts (additions)

```typescript
// src/contracts/signals.ts

export type Intent =
  | 'trigger' | 'escalate' | 'claim' | 'release' | 'stop'
  | 'accept' | 'reject' | 'watch' | 'not-a-bug' | 'none';

export type TargetRole =
  | 'anchor' | 'scope-preview' | 'dedupe' | 'fix-preview' | 'pr' | 'staging-check' | 'status' | 'other';

export interface SignalEvent {
  incidentId?: string;             // absent if no incident exists yet
  intent: Intent;
  confidence: number;              // 1.0 for reactions and lexicon hits
  source: 'reaction' | 'reaction-removed' | 'message';
  platform: 'slack' | 'teams';
  actor: IncidentActor;            // includes role from the map
  target: { role: TargetRole; messageId: string };
  environment?: string;            // "staging", when the signal names one
  raw: string;                     // emoji name or message text
  timestamp: string;
}

export interface Claim {
  incidentId: string;
  claimer: IncidentActor;
  since: string;
  lastActivity: string;
  environmentHold?: { environment: string; since: string; expiresAt: string };
  expiresAt: string;
}

export interface EscalationScore {
  incidentId: string;
  intent: 'trigger' | 'escalate' | 'accept' | 'reject';
  uniqueReactors: string[];
  score: number;
  ladderStepReached?: number;
}

export interface IncidentEvent {
  incidentId: string;
  seq: number;
  type: string;                    // the event names in 4.2
  actor?: IncidentActor;
  source: 'slack' | 'teams' | 'jira' | 'github' | 'ci' | 'deploy' | 'agent' | 'cli';
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface StatusQuery {
  asker: IncidentActor;
  text: string;
  context: { channelId?: string; threadId?: string };
}

export interface StatusAnswer {
  incidentId?: string;             // absent for surface-level answers
  audience: 'reporter' | 'engineer' | 'lead';
  text: string;                    // rendered per audience
  waitingOn: { kind: 'ci' | 'review' | 'human' | 'deploy' | 'hold' | 'nothing'; who?: string; since?: string };
  nextStep: string;
  actions: ApprovalAction[];
}
```

---

## 8. Test scenarios (additions to main spec 14.4)

| Tier | Scenario | Asserts |
|---|---|---|
| unit | Lexicon: "on it", "On it!", "ok on it" classify as `claim`; "on iteration 3" does not | Stemming and word-boundary rules |
| unit | Weighting: 5 reporters + 1 owner reacting 🐛 = score 7 → step 2, not step 3 | Ladder math and unique-reactor dedupe |
| unit | Target resolution: 👍 from a reporter on a PR card is a comment, not a review | Role × target matrix |
| unit | Playbook validation rejects an escalation ladder with a step shorter than its predecessor | Schematron |
| unit | Instructions lint flags "always merge automatically" against a level-1 surface | Precedence rule |
| contract | Recorded Slack `reaction_added` and Teams Graph reaction diff both produce identical `SignalEvent`s | Parity |
| e2e | Engineer reacts 👀 within 30 s of the anchor at level 2 → ticket filed, assigned to them, no fixer job, scout comment present | Claim hold |
| e2e | Reporter reacts 👍 on the staging check → Jira comment "verified on staging" with timestamp; deploy to production proceeds at level 3 | Verification |
| e2e | Five distinct users react 🔥 → priority Highest, owner mentioned, ask-back suppressed, active monitoring on | Escalation |
| e2e | "@agent where are we with the cart thing" from a reporter in another channel → correct incident, reporter-shaped answer, under 1 s | Status pull |
| e2e | Screenshot with `staging.` in the URL bar → user-side check asked before filing; "That fixed it" → no ticket, `user-side` event logged | Human error |
| e2e | Stall: CI webhook suppressed in the fixture → heartbeat posts at 10 min, owner mentioned at 15 min | Monitoring and escalation |

---

## 9. Open items

- **Sentiment as a signal.** "This is the third time this week" carries urgency the lexicon misses. Worth a bounded experiment before it touches priority.
- **Cross-channel claim awareness.** An engineer who says "on it" in #eng about an incident filed from #sales-team. Needs the segmentation model to link across channels; risky for false positives.
- **Reaction semantics for Jira and GitHub.** 👍 on the Jira issue or the PR itself could feed the same vocabulary. Both platforms expose reactions through their APIs.
- **Voice and huddles.** Slack huddles and Teams calls where an incident is discussed; transcript ingestion as another text signal source, opt-in and consented.
- **Instructions versioning.** Treat `INSTRUCTIONS.md` and `playbook.xml` as code: PR review in the repo that hosts them, with the agent posting a diff summary when they change.
