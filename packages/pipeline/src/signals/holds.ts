// Environment holds and claim expiry (Companion A 2.3 and 2.4, B 5 timers).
//
// Everything is read from the incident's event log; the three durable timers only wake a handler that
// re-reads the log and decides, so a timer that fires early, late, or twice does no harm.
//
// Environment hold (A 2.3). `onEvent` is called after an append commits, with the event's seq.
// - A `comment` with intent `claim` and an `environment` (the claimer is the event's actor) sets a hold:
//   appends `held { kind: 'environment', env, claimerId, expiresAt }`, comments on the ticket and on the
//   PR ("Do not redeploy staging: @dana is investigating there as of 2:47 PM."), and, when the next step
//   deploys to that environment, a `waiting-changed { kind: 'hold', who: holder }` that the status
//   message turns into its waiting line. One hold per environment: a second claim on a held
//   environment sets nothing.
// - Timer `hold:{incident}:{env}` carries a `phase` in its job data. `nudge` fires at half of
//   `claims.holdExpiry` after the holder's last activity and says "still on staging?"; it schedules
//   `expire` for the full span, which appends `released { scope: 'hold', reason: 'expired' }`. Any event
//   by the holder is activity and starts the timer over. A `comment` with intent `release` or
//   `not-a-bug` (or a `not-a-bug` event) from the holder ends the hold at once (`reason: 'requested'`).
//
// Claim expiry (A 2.4), for the engineer's claim that holds the fixer (`claimState`, engine/claims.ts).
// - Timer `claim-nudge:{incident}:{user}` fires `claims.expiry` after the claimer's last activity (a
//   message in the thread, a ticket transition, a commit with the key: any event whose actor is the
//   claimer), counted in business hours when `claims.businessHoursOnly` is set and `businessHours` is
//   configured. It prompts once and schedules `claim:{incident}:{user}` an hour later (wall clock).
// - When that fires with no activity since, the claim is released: `released { scope: 'claim',
//   reason: 'expired', restoredLevel }` with the planned level, and the thread is told. Activity at any
//   point (the 👀 that keeps the claim is a claim comment by the claimer) cancels the hour and starts
//   the expiry over.
//
// What this does not do: it never posts to chat itself (`say`), and the PR comment is an outbox row for
// target `github`, op `add-comment` (payload `{ repo, prNumber, text }`), for the GitHub projector.

import type { AutonomyLevel, EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { timerKey, type Job } from '../contracts/jobs.ts';
import type { IncidentStatus, OutboxItem } from '../contracts/state.ts';
import { claimState, type ClaimHold } from '../engine/claims.ts';
import { appendDecided } from '../fixer/job.ts';
import { isTerminalStatus } from '../lifecycle/machine.ts';
import type { PlaybookClaims } from '../config/playbook.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { jiraCommentBatchKey } from '../state/projections/outbox/jira.ts';
import { parseDuration } from '../util/duration.ts';
import { ulid } from '../util/ulid.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** After a claim expiry prompt, how long the claimer has to answer (A 2.4: "a further hour"). */
export const CLAIM_ANSWER_WINDOW = 'PT1H';

// Business hours ---------------------------------------------------------------------------------

/** When a claim's expiry clock runs. Days are ISO weekdays, 1 (Monday) to 7 (Sunday); default Monday to Friday. */
export interface BusinessHours {
  tz: string;
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
  days?: readonly number[];
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function clockMs(hhmm: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (m === null) throw new RangeError(`business hours: ${JSON.stringify(hhmm)} is not HH:MM`);
  return (Number(m[1]) * 60 + Number(m[2])) * MINUTE_MS;
}

/** The instant after `durationMs` of business time has passed, counting from `startMs`. */
export function addBusinessTime(startMs: number, durationMs: number, hours: BusinessHours): number {
  const open = clockMs(hours.from);
  const close = clockMs(hours.to);
  if (open >= close) throw new RangeError('business hours: from must be before to');
  const days = new Set(hours.days ?? [1, 2, 3, 4, 5]);
  if (days.size === 0) throw new RangeError('business hours: no days');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const local = (t: number): { day: number; ms: number } => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const day = WEEKDAYS[parts['weekday'] ?? ''] ?? 1;
    return { day, ms: ((Number(parts['hour']) * 60 + Number(parts['minute'])) * 60 + Number(parts['second'])) * 1000 };
  };
  let t = startMs;
  let remaining = durationMs;
  // Each pass moves to the next opening or consumes the rest of a day's window, so a week of passes covers a week.
  for (let pass = 0; pass < 10_000; pass++) {
    const { day, ms } = local(t);
    if (!days.has(day) || ms >= close) {
      t += DAY_MS - ms + open;
    } else if (ms < open) {
      t += open - ms;
    } else {
      const available = close - ms;
      if (remaining <= available) return t + remaining;
      remaining -= available;
      t += available;
    }
  }
  throw new RangeError('business hours: no business time found');
}

// Reading the log -------------------------------------------------------------------------------

/** An environment hold that no `released` has ended. */
export interface EnvironmentHold {
  env: string;
  holderId: string;
  /** Seq of the `held` event. */
  seq: number;
  heldAt: string;
  actor?: EventActor;
}

/** The environment holds in force after `events`, in the order they were set. */
export function activeHolds(events: readonly IncidentEvent[]): EnvironmentHold[] {
  const holds = new Map<string, EnvironmentHold>();
  for (const e of events) {
    if (e.type === 'held' && e.payload.kind === 'environment') {
      const holderId = e.payload.claimerId ?? e.actor?.id;
      if (holderId !== undefined && !holds.has(e.payload.env)) {
        holds.set(e.payload.env, { env: e.payload.env, holderId, seq: e.seq, heldAt: e.occurredAt, ...(e.actor === undefined ? {} : { actor: e.actor }) });
      }
    } else if (e.type === 'released' && e.payload.scope === 'hold') {
      holds.delete(e.payload.env);
    }
  }
  return [...holds.values()];
}

/** The holder's latest activity (ms): the hold itself, or any later event the holder acted in. */
export function holdActivity(events: readonly IncidentEvent[], hold: EnvironmentHold): number {
  return lastActivity(events, hold.seq, hold.holderId, hold.heldAt);
}

function lastActivity(events: readonly IncidentEvent[], fromSeq: number, userId: string, startedAt: string): number {
  let last = Date.parse(startedAt);
  for (const e of events) if (e.seq > fromSeq && e.actor?.id === userId) last = Math.max(last, Date.parse(e.occurredAt));
  return last;
}

function claimActivity(events: readonly IncidentEvent[], hold: ClaimHold): number {
  const claimed = events.find((e) => e.seq === hold.seq);
  return lastActivity(events, hold.seq, hold.claimerId, claimed?.occurredAt ?? new Date(0).toISOString());
}

function plannedLevel(events: readonly IncidentEvent[]): AutonomyLevel | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'planned') return e.payload.autonomyLevel;
  }
  return undefined;
}

function jiraKeyOf(events: readonly IncidentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'filed') return e.payload.jiraKey;
  }
  return undefined;
}

// Dependencies ------------------------------------------------------------------------------------

export interface HoldsDeps {
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  clock: () => Date;
  /** The playbook's `<claims>`: `expiry`, `holdExpiry`, `businessHoursOnly`. */
  claims: Pick<PlaybookClaims, 'expiry' | 'holdExpiry' | 'businessHoursOnly'>;
  /** Absent: the claim expiry counts wall-clock time even with `businessHoursOnly`. */
  businessHours?: BusinessHours;
  /** Posts a message in the incident's thread (a nudge, a prompt, a release). Best effort: a failure is logged by the caller and never breaks a timer. */
  say: (incidentId: string, message: { text: string; mentionUserId?: string }) => Promise<void>;
  /** The map handle for a chat user id, without the `@`. Default: the id. */
  handleOf?: (userId: string) => string | undefined;
  /** Time zone for "as of 2:47 PM". Default UTC. */
  timeZone?: string;
  /** True when the incident's next step deploys to `env`, so its status should say it is waiting on the hold. Default: staging after a merge, production after staging. */
  waitsOnEnvironment?: (env: string, status: IncidentStatus) => boolean;
  /** Called after a claim expiry or a hold expiry appended its `released`, with its seq (the engine's `handleClaim` for a claim). */
  afterRelease?: (incidentId: string, seq: number, scope: 'claim' | 'hold') => Promise<void>;
}

export interface Holds {
  /** Call after any append to an incident's log commits, with the seq of the (last) event appended. */
  onEvent(incidentId: string, seq: number): Promise<void>;
  /** Registers the `timer.hold`, `timer.claim-nudge` and `timer.claim-expiry` handlers. */
  register(): void;
}

interface HoldTimerData {
  incidentId: string;
  env: string;
  phase: 'nudge' | 'expire';
}

interface ClaimTimerData {
  incidentId: string;
  userId: string;
}

function isHoldTimerData(d: unknown): d is HoldTimerData {
  const v = d as Partial<HoldTimerData> | null;
  return typeof v === 'object' && v !== null && typeof v.incidentId === 'string' && typeof v.env === 'string' && (v.phase === 'nudge' || v.phase === 'expire');
}

function isClaimTimerData(d: unknown): d is ClaimTimerData {
  const v = d as Partial<ClaimTimerData> | null;
  return typeof v === 'object' && v !== null && typeof v.incidentId === 'string' && typeof v.userId === 'string';
}

const defaultWaitsOnEnvironment = (env: string, status: IncidentStatus): boolean =>
  (status === 'merged' && env.toLowerCase() === 'staging') || (status === 'deployed:staging' && env.toLowerCase() === 'production');

/** "an hour", "2 hours", "45 minutes". */
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'an hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

// The module ---------------------------------------------------------------------------------------

export function createHolds(deps: HoldsDeps): Holds {
  const holdMs = parseDuration(deps.claims.holdExpiry);
  const expiryMs = parseDuration(deps.claims.expiry);
  const answerMs = parseDuration(CLAIM_ANSWER_WINDOW);
  const nowMs = (): number => deps.clock().getTime();
  const handle = (userId: string): string => `@${deps.handleOf?.(userId) ?? userId}`;

  const newEvent = <T extends EventType>(incidentId: string, type: T, payload: EventPayloads[T], actor?: EventActor): NewEvent<T> =>
    ({
      workspaceId: deps.workspaceId,
      incidentId,
      type,
      v: 1,
      source: 'agent',
      ...(actor === undefined ? {} : { actor }),
      occurredAt: deps.clock().toISOString(),
      payload,
    }) as unknown as NewEvent<T>;

  const row = (incidentId: string, target: 'jira' | 'github', op: string, payload: Record<string, unknown>, batchKey?: string): OutboxItem => {
    const now = deps.clock();
    const at = now.toISOString();
    return {
      id: ulid(now.getTime()),
      workspaceId: deps.workspaceId,
      target,
      incidentId,
      op,
      payload,
      ...(batchKey === undefined ? {} : { batchKey }),
      attempts: 0,
      nextAttempt: at,
      createdAt: at,
    };
  };

  /** A ticket comment, when the incident has a ticket, and a PR comment, when it has a PR. */
  async function comment(incidentId: string, text: string, opts: { pr: boolean }): Promise<void> {
    const incident = await deps.state.getIncident(incidentId);
    if (incident?.jiraKey !== undefined) {
      await deps.state.enqueueOutbox(row(incidentId, 'jira', 'add-comment', { issueKey: incident.jiraKey, text }, jiraCommentBatchKey(incidentId)));
    }
    if (opts.pr && incident?.prNumber !== undefined && incident.repo !== undefined) {
      await deps.state.enqueueOutbox(row(incidentId, 'github', 'add-comment', { repo: incident.repo, prNumber: incident.prNumber, text }));
    }
  }

  const asOf = (iso: string): string => {
    const base = { hour: 'numeric', minute: '2-digit' } as const;
    const options: Intl.DateTimeFormatOptions =
      deps.timeZone === undefined ? { ...base, timeZone: 'UTC', timeZoneName: 'short' } : { ...base, timeZone: deps.timeZone };
    return new Date(iso).toLocaleTimeString('en-US', options);
  };

  const claimExpiresAt = (lastMs: number): number =>
    deps.claims.businessHoursOnly && deps.businessHours !== undefined ? addBusinessTime(lastMs, expiryMs, deps.businessHours) : lastMs + expiryMs;

  // Timers ---------------------------------------------------------------------------------------

  const holdKey = (incidentId: string, env: string): string => timerKey('hold', { incidentId, env });
  const nudgeKey = (incidentId: string, userId: string): string => timerKey('claim-nudge', { incidentId, userId });
  const claimKey = (incidentId: string, userId: string): string => timerKey('claim', { incidentId, userId });

  /** Starts the hold's clock over from the holder's activity at `lastMs`. */
  async function scheduleHold(incidentId: string, env: string, lastMs: number): Promise<void> {
    const nudgeAt = lastMs + holdMs / 2;
    const phase = nowMs() < nudgeAt ? 'nudge' : 'expire';
    const data: HoldTimerData = { incidentId, env, phase };
    await deps.workflow.schedule('timer.hold', data, new Date(phase === 'nudge' ? nudgeAt : lastMs + holdMs), { singletonKey: holdKey(incidentId, env) });
  }

  async function scheduleClaim(incidentId: string, userId: string, lastMs: number): Promise<void> {
    const data: ClaimTimerData = { incidentId, userId };
    await deps.workflow.cancel(claimKey(incidentId, userId));
    await deps.workflow.schedule('timer.claim-nudge', data, new Date(claimExpiresAt(lastMs)), { singletonKey: nudgeKey(incidentId, userId) });
  }

  async function cancelClaim(incidentId: string, userId: string): Promise<void> {
    await deps.workflow.cancel(nudgeKey(incidentId, userId));
    await deps.workflow.cancel(claimKey(incidentId, userId));
  }

  // Holds ----------------------------------------------------------------------------------------

  async function setHold(incidentId: string, e: IncidentEvent<'comment'>, status: IncidentStatus): Promise<void> {
    const env = e.payload.environment?.trim();
    const actor = e.actor;
    if (env === undefined || env === '' || actor === undefined) return;
    const expiresAt = new Date(Date.parse(e.occurredAt) + holdMs).toISOString();
    const waits = (deps.waitsOnEnvironment ?? defaultWaitsOnEnvironment)(env, status);
    const decided = await appendDecided(deps.state, incidentId, (log) => {
      if (activeHolds(log).some((h) => h.env === env)) return undefined;
      return [
        newEvent(incidentId, 'held', { kind: 'environment', env, claimerId: actor.id, expiresAt }, actor),
        ...(waits ? [newEvent(incidentId, 'waiting-changed', { waitingOn: { kind: 'hold', who: actor.id } })] : []),
      ];
    });
    if (!decided.appended) {
      // The environment is already held: a claim by its holder is activity (the generic pass handles it), anyone else's changes nothing.
      return;
    }
    await comment(incidentId, `Do not redeploy ${env}: ${handle(actor.id)} is investigating there as of ${asOf(e.occurredAt)}.`, { pr: true });
    await scheduleHold(incidentId, env, Date.parse(e.occurredAt));
  }

  /** Ends `holds` (all by one holder): appends the `released` events, clears the waiting line, comments, and cancels the timers. */
  async function endHolds(incidentId: string, holderId: string, envs: readonly string[] | undefined, reason: 'requested' | 'expired'): Promise<number | undefined> {
    const incident = await deps.state.getIncident(incidentId);
    let ended: EnvironmentHold[] = [];
    const decided = await appendDecided(deps.state, incidentId, (log) => {
      ended = activeHolds(log).filter((h) => h.holderId === holderId && (envs === undefined || envs.includes(h.env)));
      if (ended.length === 0) return undefined;
      const stillWaiting = incident?.waitingOn?.kind === 'hold' && incident.waitingOn.who === holderId && ended.length === activeHolds(log).length;
      return [
        ...ended.map((h) => newEvent(incidentId, 'released', { scope: 'hold', env: h.env, reason })),
        ...(stillWaiting ? [newEvent(incidentId, 'waiting-changed', {})] : []),
      ];
    });
    if (!decided.appended) return undefined;
    for (const h of ended) {
      await deps.workflow.cancel(holdKey(incidentId, h.env));
      const text =
        reason === 'expired'
          ? `The hold on ${h.env} is released: ${handle(holderId)} has not been active for ${span(holdMs)}.`
          : `The hold on ${h.env} is released.`;
      await comment(incidentId, text, { pr: true });
    }
    return decided.seq;
  }

  async function holdTimer(job: Job): Promise<void> {
    if (!isHoldTimerData(job.data)) throw new Error('timer.hold: malformed job data');
    const { incidentId, env, phase } = job.data;
    const log = await deps.state.read(incidentId);
    const hold = activeHolds(log).find((h) => h.env === env);
    if (hold === undefined || (await terminal(incidentId))) return;
    const last = holdActivity(log, hold);
    const nudgeAt = last + holdMs / 2;
    const expireAt = last + holdMs;
    if (phase === 'nudge') {
      if (nowMs() < nudgeAt) return scheduleHold(incidentId, env, last);
      await deps.say(incidentId, {
        text: `${handle(hold.holderId)}, still on ${env}? I'll assume you're done in ${span(expireAt - nowMs())}.`,
        mentionUserId: hold.holderId,
      });
      await deps.workflow.schedule('timer.hold', { incidentId, env, phase: 'expire' } satisfies HoldTimerData, new Date(expireAt), {
        singletonKey: holdKey(incidentId, env),
      });
      return;
    }
    if (nowMs() < expireAt) return scheduleHold(incidentId, env, last);
    const seq = await endHolds(incidentId, hold.holderId, [env], 'expired');
    if (seq === undefined) return;
    await deps.say(incidentId, { text: `${handle(hold.holderId)}, the hold on ${env} has expired, so it is free again.`, mentionUserId: hold.holderId });
    await deps.afterRelease?.(incidentId, seq, 'hold');
  }

  // Claims ---------------------------------------------------------------------------------------

  async function terminal(incidentId: string): Promise<boolean> {
    const incident = await deps.state.getIncident(incidentId);
    return incident !== null && isTerminalStatus(incident.status);
  }

  /** The claim hold of `userId` as the log has it now, with its last activity, or undefined when it no longer holds. */
  async function heldClaim(incidentId: string, userId: string): Promise<{ log: IncidentEvent[]; hold: ClaimHold; last: number } | undefined> {
    const log = await deps.state.read(incidentId);
    const hold = claimState(log).hold;
    if (hold === undefined || hold.claimerId !== userId || (await terminal(incidentId))) return undefined;
    return { log, hold, last: claimActivity(log, hold) };
  }

  async function claimNudgeTimer(job: Job): Promise<void> {
    if (!isClaimTimerData(job.data)) throw new Error('timer.claim-nudge: malformed job data');
    const { incidentId, userId } = job.data;
    const claim = await heldClaim(incidentId, userId);
    if (claim === undefined) return;
    const due = claimExpiresAt(claim.last);
    if (nowMs() < due) return scheduleClaim(incidentId, userId, claim.last);
    const key = jiraKeyOf(claim.log);
    await deps.say(incidentId, {
      text: `${handle(userId)}, still on ${key ?? 'this'}? React 👀 to keep it, or I can take it.`,
      mentionUserId: userId,
    });
    await deps.workflow.schedule('timer.claim-expiry', { incidentId, userId } satisfies ClaimTimerData, new Date(nowMs() + answerMs), {
      singletonKey: claimKey(incidentId, userId),
    });
  }

  async function claimExpiryTimer(job: Job): Promise<void> {
    if (!isClaimTimerData(job.data)) throw new Error('timer.claim-expiry: malformed job data');
    const { incidentId, userId } = job.data;
    const claim = await heldClaim(incidentId, userId);
    if (claim === undefined) return;
    // Activity the timers were not told about still counts.
    if (nowMs() < claimExpiresAt(claim.last)) return scheduleClaim(incidentId, userId, claim.last);
    const restoredLevel = plannedLevel(claim.log);
    const decided = await appendDecided(deps.state, incidentId, (log) => {
      const hold = claimState(log).hold;
      if (hold === undefined || hold.claimerId !== userId) return undefined;
      return [newEvent(incidentId, 'released', { scope: 'claim', claimerId: userId, reason: 'expired', ...(restoredLevel === undefined ? {} : { restoredLevel }) })];
    });
    if (!decided.appended) return;
    const key = jiraKeyOf(claim.log);
    const back = restoredLevel === undefined ? 'its configured autonomy level' : `autonomy level ${restoredLevel}`;
    await deps.say(incidentId, { text: `${handle(userId)} did not answer, so ${key ?? 'the incident'} is back at ${back}.`, mentionUserId: userId });
    await comment(incidentId, `${handle(userId)}'s claim expired with no activity, so the incident is back at ${back}.`, { pr: false });
    await deps.afterRelease?.(incidentId, decided.seq, 'claim');
  }

  // Events ---------------------------------------------------------------------------------------

  async function onEvent(incidentId: string, seq: number): Promise<void> {
    const incident = await deps.state.getIncident(incidentId);
    if (incident === null) return;
    const log = await deps.state.read(incidentId);
    const e = log.find((x) => x.seq === seq);
    if (e === undefined) return;

    const cs = claimState(log);
    if (isTerminalStatus(incident.status)) {
      for (const h of activeHolds(log)) await deps.workflow.cancel(holdKey(incidentId, h.env));
      if (cs.hold !== undefined) await cancelClaim(incidentId, cs.hold.claimerId);
      return;
    }

    // Endings first: a release or not-a-bug from a holder ends their holds.
    const actorId = e.actor?.id;
    const ends =
      e.type === 'not-a-bug' || (e.type === 'comment' && (e.payload.intent === 'release' || e.payload.intent === 'not-a-bug'));
    if (ends && actorId !== undefined && activeHolds(log).some((h) => h.holderId === actorId)) {
      await endHolds(incidentId, actorId, undefined, 'requested');
    }
    if (e.type === 'let-agent-take') await cancelClaim(incidentId, e.payload.claimerId);
    if (e.type === 'released' && e.payload.scope === 'claim') await cancelClaim(incidentId, e.payload.claimerId);
    if (e.type === 'released' && e.payload.scope === 'hold') await deps.workflow.cancel(holdKey(incidentId, e.payload.env));

    // A claim on an environment sets a hold.
    if (e.type === 'comment' && e.payload.intent === 'claim' && e.payload.environment !== undefined && e.payload.environment.trim() !== '') {
      await setHold(incidentId, e, incident.status);
    }

    // Activity by a holder or by the claimer starts their clocks over.
    if (actorId !== undefined && !ends) {
      for (const h of activeHolds(await deps.state.read(incidentId))) {
        if (h.holderId === actorId && h.seq !== seq) await scheduleHold(incidentId, h.env, Date.parse(e.occurredAt));
      }
    }
    const claimer = e.type === 'claimed' ? e.payload.claimerId : actorId;
    if (cs.hold !== undefined && claimer === cs.hold.claimerId && !ends) await scheduleClaim(incidentId, claimer, Date.parse(e.occurredAt));
  }

  return {
    onEvent,
    register(): void {
      deps.workflow.work('timer.hold', holdTimer);
      deps.workflow.work('timer.claim-nudge', claimNudgeTimer);
      deps.workflow.work('timer.claim-expiry', claimExpiryTimer);
    },
  };
}
