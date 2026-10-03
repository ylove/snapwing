// The `escalation_scores` projection (B 3, A 1.4, A 7 `EscalationScore`): unique reactors and the
// weighted score per counting intent. `foldScores` is the pure reducer over one incident's rows.
//
// - A `comment` event with `count` (trigger, escalate, accept, reject) and an actor adds the actor
//   to `reactor_ids` and the event's frozen `count.weight` to the score, once per reactor: reacting
//   five times is one. A `reaction-removed` signal takes the reactor and that weight back out (A 1.6),
//   never below zero. `window_ends` is the latest `count.windowEndsAt` seen.
// - `escalated` (the reaction ladder, signals/score.ts, #290) records the step reached (the highest
//   so far) on the row of the intent that crossed it, adding the row when there is none yet.
// `reactor_ids` is sorted in code-unit order and scores are rounded to 1e-6, so a rebuild writes
// the same JSON and the same number on both dialects.

import type { Selectable } from 'kysely';
import type { IncidentEvent } from '../../contracts/events.ts';
import type { EscalationScore } from '../../contracts/signals.ts';
import { isoTimestamp } from '../codec.ts';
import type { StateContext } from '../context.ts';
import type { EscalationScoresTable } from '../db.ts';

export type CountingIntent = EscalationScore['intent'];

const COUNTING: ReadonlySet<string> = new Set<CountingIntent>(['trigger', 'escalate', 'accept', 'reject']);

/** One `escalation_scores` row: A 7's `EscalationScore` plus the window it counts in. */
export interface ScoreRow {
  incidentId: string;
  intent: CountingIntent;
  /** Unique reactor ids, sorted. */
  reactorIds: string[];
  score: number;
  stepReached?: number;
  windowEnds: string;
}

const codeOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byIntent = (a: ScoreRow, b: ScoreRow): number => codeOrder(a.intent, b.intent);

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The incident's score rows after `e`. Pure; sorted by intent; the input array when nothing changed. */
export function foldScores(rows: readonly ScoreRow[], e: IncidentEvent): readonly ScoreRow[] {
  const replace = (row: ScoreRow): readonly ScoreRow[] => [...rows.filter((r) => r.intent !== row.intent), row].sort(byIntent);

  if (e.type === 'escalated') {
    const prev = rows.find((r) => r.intent === e.payload.intent);
    if (prev === undefined) {
      return replace({
        incidentId: e.incidentId,
        intent: e.payload.intent,
        reactorIds: [],
        score: round(e.payload.score),
        stepReached: e.payload.step,
        windowEnds: e.occurredAt,
      });
    }
    return prev.stepReached !== undefined && prev.stepReached >= e.payload.step ? rows : replace({ ...prev, stepReached: e.payload.step });
  }

  if (e.type !== 'comment' || e.payload.count === undefined || !COUNTING.has(e.payload.intent) || e.actor === undefined) {
    return rows;
  }
  const intent = e.payload.intent as CountingIntent;
  const reactor = e.actor.id;
  const { weight } = e.payload.count;
  const windowEndsAt = isoTimestamp(e.payload.count.windowEndsAt);
  const prev = rows.find((r) => r.intent === intent);

  if (e.payload.signalSource === 'reaction-removed') {
    if (prev === undefined || !prev.reactorIds.includes(reactor)) {
      return rows;
    }
    return replace({ ...prev, reactorIds: prev.reactorIds.filter((id) => id !== reactor), score: Math.max(0, round(prev.score - weight)) });
  }
  if (prev === undefined) {
    return replace({ incidentId: e.incidentId, intent, reactorIds: [reactor], score: round(weight), windowEnds: windowEndsAt });
  }
  const windowEnds = windowEndsAt > prev.windowEnds ? windowEndsAt : prev.windowEnds;
  if (prev.reactorIds.includes(reactor)) {
    return windowEnds === prev.windowEnds ? rows : replace({ ...prev, windowEnds });
  }
  return replace({ ...prev, reactorIds: [...prev.reactorIds, reactor].sort(codeOrder), score: round(prev.score + weight), windowEnds });
}

// Table mapping -----------------------------------------------------------------------------------

function rowToScore(ctx: StateContext, r: Selectable<EscalationScoresTable>): ScoreRow {
  const reactors = ctx.codec.fromJson(r.reactor_ids);
  if (!Array.isArray(reactors) || !reactors.every((id): id is string => typeof id === 'string')) {
    throw new TypeError(`escalation_scores ${r.incident_id}/${r.intent}: reactor_ids is not a string array`);
  }
  if (!COUNTING.has(r.intent)) {
    throw new TypeError(`escalation_scores ${r.incident_id}: unknown intent ${JSON.stringify(r.intent)}`);
  }
  return {
    incidentId: r.incident_id,
    intent: r.intent as CountingIntent,
    reactorIds: reactors,
    score: ctx.codec.fromNumber(r.score),
    ...(r.step_reached !== null ? { stepReached: ctx.codec.fromNumber(r.step_reached) } : {}),
    windowEnds: ctx.codec.fromTimestamp(r.window_ends),
  };
}

export async function loadScores(ctx: StateContext, incidentId: string): Promise<ScoreRow[]> {
  const rows = await ctx.db.selectFrom('escalation_scores').selectAll().where('incident_id', '=', incidentId).execute();
  return rows.map((r) => rowToScore(ctx, r)).sort(byIntent);
}

/** Replaces the incident's score rows with `rows`. */
export async function writeScores(ctx: StateContext, incidentId: string, rows: readonly ScoreRow[]): Promise<void> {
  await ctx.db.deleteFrom('escalation_scores').where('incident_id', '=', incidentId).execute();
  if (rows.length === 0) {
    return;
  }
  await ctx.db
    .insertInto('escalation_scores')
    .values(
      rows.map((s) => ({
        incident_id: s.incidentId,
        intent: s.intent,
        reactor_ids: ctx.codec.json(s.reactorIds),
        score: s.score,
        step_reached: s.stepReached ?? null,
        window_ends: ctx.codec.timestamp(s.windowEnds),
      })),
    )
    .execute();
}
