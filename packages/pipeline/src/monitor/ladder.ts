// src/monitor/ladder.ts: escalation ladders (A 6.2) on durable `escalate:{incident}:{step}` timers
// (B 5), #299. A factory over injected interfaces; compose wires it.
//
// A ladder is one playbook `<escalation>`. It applies while any one of its `<applyWhen>` elements
// holds (every attribute on that element must match; none at all means it never applies on its own)
// and the incident is not in a terminal status. The facts it matches come from the incidents row
// (`priority`, `monitored`, `status`) plus two injected predicates: `outage` (the A 1.4 reaction
// ladder's outage step, #290) and `stalled` (A 4.5, #301). Without them both read false.
//
// The log is the ladder's state, one event type `escalation-ladder` (contracts/events.ts):
//   started   `evaluate` found the ladder applying and not running. Its `occurredAt` is the anchor:
//             step i fires at anchor plus its `after` duration. Its seq names the run.
//   step      one `<after>` fired: who was mentioned, the channel, the PagerDuty service id and
//             whether it paged.
//   stopped   `evaluate` or a firing step found it no longer applying: `closed` (terminal status),
//             `no-longer-applies` (downgraded, unstalled, outage gone), or `removed` (not in the
//             playbook any more). A later `started` is a new run (a second stall restarts it).
// It never records `escalated`: that is the B 5 lifecycle transition and the A 1.4 reaction ladder's
// event, and a step must not move the status or the reaction ladder's `step_reached`.
//
// Flow:
//   evaluate(incident)   call after any event that can change the facts (priority, outage, monitoring,
//                        stall, close). Appends `stopped` for each running ladder that no longer
//                        applies (cancelling its timers and resolving its pages) and `started` for each
//                        ladder that applies and is not running (scheduling its first step). Running
//                        twice changes nothing.
//   timer.escalate       one step. A timer from an older run, or a step already recorded, does nothing.
//                        It re-checks the facts first and stops the run instead of acting when the
//                        ladder no longer applies, so no step ever fires after the incident left the
//                        qualifying state even when nobody called `evaluate`. Otherwise it schedules
//                        the next step (before acting, so a failing action never ends the chain), then
//                        mentions in the incident's thread, or posts to the step's channel with the
//                        mention, and pages, each on its own: one failing never skips another.
//                        Then it records the `step`.
//
// Paging. The step's `pagerduty` value is a PagerDuty service id, never a routing key (orchestrator
// decision on #299). The key comes from the secrets port: `PAGERDUTY_ROUTING_KEY_<SERVICE>` (the id
// upper-cased, anything but letters and digits as `_`) when set, else `PAGERDUTY_ROUTING_KEY`. With
// neither the step logs once per service and does not page; its other actions still run. One dedup
// key per incident and ladder (`pagerDedupKey`); a stop resolves it on every service the run paged.
//
// Stall detection (#301) should not count `escalation-ladder` events as progress, or a ladder's own
// step would unstall the incident it escalates.

import type { EscalationLadderPayload, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { timerKey } from '../contracts/jobs.ts';
import type { IncidentView } from '../contracts/state.ts';
import type { EscalationCondition, Playbook, PlaybookEscalation } from '../config/playbook.ts';
import { appendDecided, latest, newEvent } from '../fixer/job.ts';
import { isTerminalStatus, type LifecycleStatus } from '../lifecycle/machine.ts';
import { SecretNotFoundError, type SecretsPort } from '../ports/secrets.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { parseDuration } from '../util/duration.ts';
import type { Pager } from './pager.ts';

/** The secret every service falls back to (CONTEXT 6b). */
export const PAGERDUTY_ROUTING_KEY = 'PAGERDUTY_ROUTING_KEY';

/** What `applyWhen` matches against. */
export interface LadderFacts {
  /** A terminal status (B 5): every ladder stops. */
  closed: boolean;
  /** The Jira priority name. */
  priority?: string;
  outage: boolean;
  monitored: boolean;
  stalled: boolean;
}

/** Where a step's message goes: the incident's thread, or the step's `channel` as the playbook writes it. */
export type EscalationWhere = { kind: 'thread'; channel: string; threadId?: string } | { kind: 'channel'; channel: string };

export interface EscalationPost {
  incidentId: string;
  ladder: string;
  /** 1-based step index. */
  step: number;
  where: EscalationWhere;
  /** A person reference to mention (a chat user id or a map handle); the chat side resolves it. */
  mention?: string;
  /** The message, without the mention. */
  text: string;
}

/** The chat side of a step; the app implements it per platform. */
export interface EscalationChat {
  post(message: EscalationPost): Promise<void>;
}

export interface LadderDeps {
  /** The install's workspace (single tenant), stamped on every event. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  /** The current playbook, read on every evaluation and step (hot reload). */
  playbook: () => Playbook | Promise<Playbook>;
  chat: EscalationChat;
  pager: Pager;
  secrets: SecretsPort;
  clock: () => Date;
  /** The A 1.4 outage step has been reached (#290). Default: never. */
  outage?: (incident: IncidentView) => boolean | Promise<boolean>;
  /** The incident is stalled (A 4.5, #301). Default: never. */
  stalled?: (incident: IncidentView) => boolean | Promise<boolean>;
  /** A link back to the incident for the page. */
  link?: (incident: IncidentView) => string | undefined;
  /** Default `console.warn`. Never given a secret. */
  log?: (message: string) => void;
}

/** `timer.escalate` job data. */
export interface EscalateTimerData {
  incidentId: string;
  ladder: string;
  /** 1-based step index. */
  step: number;
  /** The seq of the run's `started` event; a timer from another run does nothing. */
  run: number;
}

export type StopReason = Extract<EscalationLadderPayload, { phase: 'stopped' }>['reason'];

export type LadderChange = { ladder: string; started: true } | { ladder: string; stopped: StopReason };

export type StepOutcome =
  | { fired: true; step: Extract<EscalationLadderPayload, { phase: 'step' }> }
  | { fired: false; reason: 'stale' | 'duplicate' | 'no-step' | 'no-incident' }
  | { fired: false; reason: 'stopped'; stopped: StopReason };

export interface EscalationLadders {
  /** Starts the ladders that now apply and stops the running ones that no longer do. */
  evaluate(incidentId: string): Promise<LadderChange[]>;
  /** The `timer.escalate` handler. */
  fire(data: EscalateTimerData): Promise<StepOutcome>;
  /** Registers `timer.escalate` on the workflow port. */
  register(): void;
}

type StartedEvent = IncidentEvent<'escalation-ladder'> & { payload: { phase: 'started' } };
type StepPayload = Extract<EscalationLadderPayload, { phase: 'step' }>;

export function createEscalationLadders(deps: LadderDeps): EscalationLadders {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const warnedOnce = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    log(message);
  };

  async function factsOf(incident: IncidentView): Promise<LadderFacts> {
    return {
      closed: isTerminalStatus(incident.status as LifecycleStatus),
      ...(incident.priority === undefined ? {} : { priority: incident.priority }),
      monitored: incident.monitored,
      outage: (await deps.outage?.(incident)) ?? false,
      stalled: (await deps.stalled?.(incident)) ?? false,
    };
  }

  function stopReason(def: PlaybookEscalation | undefined, facts: LadderFacts): StopReason | undefined {
    if (facts.closed) return 'closed';
    if (def === undefined) return 'removed';
    return ladderApplies(def, facts) ? undefined : 'no-longer-applies';
  }

  async function routingKeyFor(service: string): Promise<string | undefined> {
    for (const name of [serviceSecretName(service), PAGERDUTY_ROUTING_KEY]) {
      try {
        return await deps.secrets.get(name);
      } catch (e) {
        if (!(e instanceof SecretNotFoundError)) {
          warnOnce(`secret-error:${service}`, `escalation: cannot read the PagerDuty routing key for service ${service}: ${errorText(e)}; not paging`);
          return undefined;
        }
      }
    }
    warnOnce(`no-key:${service}`, `escalation: no PagerDuty routing key for service ${service} (${serviceSecretName(service)} or ${PAGERDUTY_ROUTING_KEY}); not paging`);
    return undefined;
  }

  /** After a `stopped`: cancels the run's timers and resolves every page it opened. */
  async function afterStop(incidentId: string, ladder: string, events: readonly IncidentEvent[], run: number, playbook: Playbook): Promise<void> {
    const steps = runSteps(events, ladder, run);
    // Every step of the current definition; for a ladder gone from the playbook, the one after the last recorded.
    const count = playbook.escalations.find((e) => e.name === ladder)?.steps.length ?? Math.max(0, ...steps.map((s) => s.step)) + 1;
    for (let i = 1; i <= count; i++) await deps.workflow.cancel(escalateTimerKey(incidentId, ladder, i));
    const services = [...new Set(steps.filter((s) => s.paged === true && s.pagerduty !== undefined).map((s) => s.pagerduty as string))];
    for (const service of services) {
      const routingKey = await routingKeyFor(service);
      if (routingKey === undefined) continue;
      try {
        await deps.pager.resolve(pagerDedupKey(incidentId, ladder), { routingKey });
      } catch (e) {
        log(`escalation: resolving the ${ladder} page for incident ${incidentId} on service ${service} failed: ${errorText(e)}`);
      }
    }
  }

  async function scheduleStep(incidentId: string, def: PlaybookEscalation, step: number, run: number, anchor: string): Promise<void> {
    const after = def.steps[step - 1];
    if (after === undefined) return;
    const runAt = new Date(Date.parse(anchor) + parseDuration(after.duration));
    const data: EscalateTimerData = { incidentId, ladder: def.name, step, run };
    await deps.workflow.schedule('timer.escalate', data, runAt, { singletonKey: escalateTimerKey(incidentId, def.name, step) });
  }

  async function evaluate(incidentId: string): Promise<LadderChange[]> {
    const incident = await deps.state.getIncident(incidentId);
    if (incident === null) return [];
    const playbook = await deps.playbook();
    const facts = await factsOf(incident);

    let changes: LadderChange[] = [];
    const appended = await appendDecided(deps.state, incidentId, (events) => {
      const running = runningLadders(events);
      changes = [];
      for (const [ladder] of running) {
        const reason = stopReason(playbook.escalations.find((e) => e.name === ladder), facts);
        if (reason !== undefined) changes.push({ ladder, stopped: reason });
      }
      if (!facts.closed) {
        for (const def of playbook.escalations) {
          if (!running.has(def.name) && ladderApplies(def, facts)) changes.push({ ladder: def.name, started: true });
        }
      }
      return changes.length === 0 ? undefined : changes.map((c) => ladderEvent(incidentId, 'started' in c ? { phase: 'started', ladder: c.ladder } : { phase: 'stopped', ladder: c.ladder, reason: c.stopped }));
    });
    if (!appended.appended) return [];

    const firstSeq = appended.seq - changes.length + 1;
    const running = runningLadders(appended.before);
    for (const [i, change] of changes.entries()) {
      if ('started' in change) {
        const def = playbook.escalations.find((e) => e.name === change.ladder);
        if (def !== undefined) await scheduleStep(incidentId, def, 1, firstSeq + i, deps.clock().toISOString());
      } else {
        const run = running.get(change.ladder);
        if (run !== undefined) await afterStop(incidentId, change.ladder, appended.before, run.seq, playbook);
      }
    }
    return changes;
  }

  async function stopRun(incidentId: string, ladder: string, run: number, reason: StopReason, playbook: Playbook): Promise<boolean> {
    const appended = await appendDecided(deps.state, incidentId, (events) =>
      runningLadders(events).get(ladder)?.seq === run ? [ladderEvent(incidentId, { phase: 'stopped', ladder, reason })] : undefined,
    );
    if (!appended.appended) return false;
    await afterStop(incidentId, ladder, appended.before, run, playbook);
    return true;
  }

  async function fire(data: EscalateTimerData): Promise<StepOutcome> {
    const { incidentId, ladder, step } = data;
    const events = await deps.state.read(incidentId);
    const run = runningLadders(events).get(ladder);
    if (run === undefined || run.seq !== data.run) return { fired: false, reason: 'stale' };
    if (runSteps(events, ladder, run.seq).some((s) => s.step === step)) return { fired: false, reason: 'duplicate' };

    const incident = await deps.state.getIncident(incidentId);
    if (incident === null) return { fired: false, reason: 'no-incident' };
    const playbook = await deps.playbook();
    const def = playbook.escalations.find((e) => e.name === ladder);
    const reason = stopReason(def, await factsOf(incident));
    if (reason !== undefined || def === undefined) {
      const why = reason ?? 'removed';
      await stopRun(incidentId, ladder, run.seq, why, playbook);
      return { fired: false, reason: 'stopped', stopped: why };
    }
    const after = def.steps[step - 1];
    if (after === undefined) return { fired: false, reason: 'no-step' };

    // The next step first: an action that throws must not end the ladder.
    await scheduleStep(incidentId, def, step + 1, run.seq, run.occurredAt);

    const payload: StepPayload = { phase: 'step', ladder, step, after: after.duration };
    const text = stepText(incident, def, step);

    if (after.mention !== undefined || after.channel !== undefined) {
      const mentioned = after.mention === undefined ? undefined : personRef(after.mention, incident);
      if (after.mention !== undefined) payload.mention = after.mention;
      if (mentioned !== undefined) payload.mentioned = mentioned;
      if (after.channel !== undefined) payload.channel = after.channel;
      const where = after.channel !== undefined ? ({ kind: 'channel', channel: after.channel } as const) : threadOf(events, incident);
      if (where === undefined) {
        log(`escalation: incident ${incidentId} has no chat thread for the ${ladder} step ${String(step)} mention`);
        payload.posted = false;
      } else {
        try {
          await deps.chat.post({ incidentId, ladder, step, where, ...(mentioned === undefined ? {} : { mention: mentioned }), text });
          payload.posted = true;
        } catch (e) {
          log(`escalation: the ${ladder} step ${String(step)} post for incident ${incidentId} failed: ${errorText(e)}`);
          payload.posted = false;
        }
      }
    }

    if (after.pagerduty !== undefined) {
      const service = after.pagerduty;
      payload.pagerduty = service;
      payload.paged = false;
      const routingKey = await routingKeyFor(service);
      if (routingKey !== undefined) {
        const href = deps.link?.(incident);
        try {
          await deps.pager.trigger({
            dedupKey: pagerDedupKey(incidentId, ladder),
            summary: text,
            severity: 'critical',
            source: 'snapwing',
            routingKey,
            ...(href === undefined ? {} : { link: { href, text: incident.jiraKey ?? incidentId } }),
            details: { incident: incidentId, ladder, step: String(step), service, ...(incident.jiraKey === undefined ? {} : { jira: incident.jiraKey }) },
          });
          payload.paged = true;
        } catch (e) {
          log(`escalation: paging service ${service} for incident ${incidentId} failed: ${errorText(e)}`);
        }
      }
    }

    await appendDecided(deps.state, incidentId, (latestEvents) => {
      const current = runningLadders(latestEvents).get(ladder);
      if (current?.seq !== run.seq || runSteps(latestEvents, ladder, run.seq).some((s) => s.step === step)) return undefined;
      return [ladderEvent(incidentId, payload)];
    });
    return { fired: true, step: payload };
  }

  function ladderEvent(incidentId: string, payload: EscalationLadderPayload): NewEvent<'escalation-ladder'> {
    return newEvent(deps, incidentId, 'escalation-ladder', payload);
  }

  return {
    evaluate,
    fire,
    register(): void {
      deps.workflow.work('timer.escalate', async (job) => {
        if (!isEscalateTimerData(job.data)) throw new Error('timer.escalate: malformed job data');
        await fire(job.data);
      });
    },
  };
}

// Pure helpers ------------------------------------------------------------------------------------

/** True when any `applyWhen` holds and the incident is not closed. No `applyWhen`: never. */
export function ladderApplies(def: PlaybookEscalation, facts: LadderFacts): boolean {
  return !facts.closed && def.applyWhen.some((c) => conditionHolds(c, facts));
}

function conditionHolds(c: EscalationCondition, facts: LadderFacts): boolean {
  if (c.priority !== undefined && c.priority.toLowerCase() !== facts.priority?.trim().toLowerCase()) return false;
  if (c.outage !== undefined && c.outage !== facts.outage) return false;
  if (c.monitored !== undefined && c.monitored !== facts.monitored) return false;
  if (c.stalled !== undefined && c.stalled !== facts.stalled) return false;
  return true;
}

/** The ladders running on the incident: each one's latest `started` with no `stopped` after it. */
export function runningLadders(events: readonly IncidentEvent[]): Map<string, StartedEvent> {
  const running = new Map<string, StartedEvent>();
  for (const e of events) {
    if (e.type !== 'escalation-ladder') continue;
    if (e.payload.phase === 'started') running.set(e.payload.ladder, e as StartedEvent);
    else if (e.payload.phase === 'stopped') running.delete(e.payload.ladder);
  }
  return running;
}

/** The steps recorded in the run that `started` at seq `run`. */
export function runSteps(events: readonly IncidentEvent[], ladder: string, run: number): StepPayload[] {
  const steps: StepPayload[] = [];
  for (const e of events) {
    if (e.seq <= run || e.type !== 'escalation-ladder' || e.payload.ladder !== ladder) continue;
    if (e.payload.phase !== 'step') break;
    steps.push(e.payload);
  }
  return steps;
}

/** `escalate:{incident}:{ladder}.{step}`, through `timerKey`. */
export function escalateTimerKey(incidentId: string, ladder: string, step: number): string {
  return timerKey('escalate', { incidentId, step: `${ladder}.${String(step)}` });
}

/** One PagerDuty dedup key per incident and ladder. */
export function pagerDedupKey(incidentId: string, ladder: string): string {
  return `snapwing:${incidentId}:${ladder}`;
}

/** `PAGERDUTY_ROUTING_KEY_<SERVICE>`: the service id upper-cased, anything but letters and digits as `_`. */
export function serviceSecretName(service: string): string {
  return `${PAGERDUTY_ROUTING_KEY}_${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function isEscalateTimerData(v: unknown): v is EscalateTimerData {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d['incidentId'] === 'string' &&
    d['incidentId'] !== '' &&
    typeof d['ladder'] === 'string' &&
    d['ladder'] !== '' &&
    Number.isInteger(d['step']) &&
    (d['step'] as number) >= 1 &&
    Number.isInteger(d['run']) &&
    (d['run'] as number) >= 1
  );
}

/** `owner` is the Jira assignee, else the resolved owner (as the status message names it); `@X` is `X`. */
function personRef(mention: string, incident: IncidentView): string | undefined {
  if (mention === 'owner') return incident.assigneeId ?? incident.ownerRef;
  return mention.startsWith('@') ? mention.slice(1) : mention;
}

/** The originating thread: the captured thread, else the anchor message (as the status message does). */
function threadOf(events: readonly IncidentEvent[], incident: IncidentView): EscalationWhere | undefined {
  const channel = incident.channelId;
  if (channel === undefined || channel === '') return undefined;
  const threadId = latest(events, 'captured')?.payload.threadId ?? incident.anchorId;
  return threadId === undefined || threadId === '' ? { kind: 'thread', channel } : { kind: 'thread', channel, threadId };
}

function stepText(incident: IncidentView, def: PlaybookEscalation, step: number): string {
  const subject = [incident.jiraKey, incident.summary].filter((s): s is string => s !== undefined && s !== '').join(' ');
  return `Escalating (${def.name}, step ${String(step)} of ${String(def.steps.length)}): ${subject === '' ? `incident ${incident.id}` : subject}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
