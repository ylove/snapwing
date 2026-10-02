// The `claims` projection (B 3, A 2, A 7 `Claim`): who is on an incident, and which environment
// they hold. `foldClaims` is the pure reducer over one incident's rows, kept sorted by claimer.
//
// - `claimed` adds a row (`since` and `last_activity` are the event's `occurredAt`) or, for a
//   claimer already on it, refreshes `last_activity` and `expires_at` and keeps `since`.
// - `released` (scope `claim`) and `let-agent-take` delete the claimer's row; `released` (scope
//   `hold`) clears that environment's hold on every row.
// - `held` (kind `environment`) is a claim on an environment (A 2.3): it sets the hold on the
//   holder's row (`payload.claimerId`, else the actor), adding the row when the holder had none.
// - Any other event whose actor is a claimer refreshes that claim's `last_activity` (A 2.4).
// - Entering a terminal status (B 5) deletes every claim: nobody is on a closed incident.

import type { Selectable } from 'kysely';
import type { IncidentEvent } from '../../contracts/events.ts';
import type { Claim, IncidentStatus } from '../../contracts/state.ts';
import { isTerminalStatus } from '../../lifecycle/machine.ts';
import { isoTimestamp } from '../codec.ts';
import type { StateContext } from '../context.ts';
import type { ClaimsTable } from '../db.ts';

const byClaimer = (a: Claim, b: Claim): number => (a.claimerId < b.claimerId ? -1 : a.claimerId > b.claimerId ? 1 : 0);

const later = (a: string, b: string): string => (a >= b ? a : b);

function withoutHold(c: Claim): Claim {
  const { holdEnv: _env, holdExpiresAt: _expires, ...rest } = c;
  return rest;
}

/**
 * The incident's claims after `e`, given the status `e` moved it to. Pure; the result is sorted by
 * `claimerId` and is the input array itself when nothing changed.
 */
export function foldClaims(claims: readonly Claim[], e: IncidentEvent, statusAfter: IncidentStatus): readonly Claim[] {
  if (isTerminalStatus(statusAfter)) {
    return claims.length === 0 ? claims : [];
  }
  const at = e.occurredAt;
  const upsert = (claimerId: string, update: (prev: Claim | undefined) => Claim): readonly Claim[] => {
    const prev = claims.find((c) => c.claimerId === claimerId);
    return [...claims.filter((c) => c.claimerId !== claimerId), update(prev)].sort(byClaimer);
  };
  const remove = (claimerId: string): readonly Claim[] =>
    claims.some((c) => c.claimerId === claimerId) ? claims.filter((c) => c.claimerId !== claimerId) : claims;

  switch (e.type) {
    case 'claimed': {
      const expiresAt = isoTimestamp(e.payload.expiresAt);
      return upsert(e.payload.claimerId, (prev) =>
        prev === undefined
          ? { incidentId: e.incidentId, claimerId: e.payload.claimerId, since: at, lastActivity: at, expiresAt }
          : { ...prev, lastActivity: later(prev.lastActivity, at), expiresAt },
      );
    }
    case 'released': {
      if (e.payload.scope === 'claim') {
        return remove(e.payload.claimerId);
      }
      const env = e.payload.env;
      return claims.some((c) => c.holdEnv === env) ? claims.map((c) => (c.holdEnv === env ? withoutHold(c) : c)) : claims;
    }
    case 'let-agent-take':
      return remove(e.payload.claimerId);
    case 'held': {
      if (e.payload.kind !== 'environment') {
        break;
      }
      const holder = e.payload.claimerId ?? e.actor?.id;
      if (holder === undefined) {
        return claims;
      }
      const env = e.payload.env;
      const holdExpiresAt = isoTimestamp(e.payload.expiresAt);
      return upsert(holder, (prev) =>
        prev === undefined
          ? { incidentId: e.incidentId, claimerId: holder, since: at, lastActivity: at, expiresAt: holdExpiresAt, holdEnv: env, holdExpiresAt }
          : { ...prev, lastActivity: later(prev.lastActivity, at), holdEnv: env, holdExpiresAt },
      );
    }
    default:
      break;
  }

  const actor = e.actor?.id;
  const mine = actor === undefined ? undefined : claims.find((c) => c.claimerId === actor);
  if (mine === undefined || mine.lastActivity >= at) {
    return claims;
  }
  return claims.map((c) => (c === mine ? { ...c, lastActivity: at } : c));
}

// Table mapping -----------------------------------------------------------------------------------

function rowToClaim(ctx: StateContext, r: Selectable<ClaimsTable>): Claim {
  const holdExpiresAt = ctx.codec.fromTimestampOpt(r.hold_expires_at);
  return {
    incidentId: r.incident_id,
    claimerId: r.claimer_id,
    since: ctx.codec.fromTimestamp(r.since),
    lastActivity: ctx.codec.fromTimestamp(r.last_activity),
    expiresAt: ctx.codec.fromTimestamp(r.expires_at),
    ...(r.hold_env !== null ? { holdEnv: r.hold_env } : {}),
    ...(holdExpiresAt !== undefined ? { holdExpiresAt } : {}),
  };
}

/** The incident's claims, sorted by claimer (the order `foldClaims` keeps). */
export async function loadClaims(ctx: StateContext, incidentId: string): Promise<Claim[]> {
  const rows = await ctx.db.selectFrom('claims').selectAll().where('incident_id', '=', incidentId).execute();
  // Sorted here, not in SQL: Postgres orders text by its collation, which need not match code order.
  return rows.map((r) => rowToClaim(ctx, r)).sort(byClaimer);
}

/** Replaces the incident's claims with `claims`. */
export async function writeClaims(ctx: StateContext, incidentId: string, claims: readonly Claim[]): Promise<void> {
  await ctx.db.deleteFrom('claims').where('incident_id', '=', incidentId).execute();
  if (claims.length === 0) {
    return;
  }
  await ctx.db
    .insertInto('claims')
    .values(
      claims.map((c) => ({
        incident_id: c.incidentId,
        claimer_id: c.claimerId,
        since: ctx.codec.timestamp(c.since),
        last_activity: ctx.codec.timestamp(c.lastActivity),
        expires_at: ctx.codec.timestamp(c.expiresAt),
        hold_env: c.holdEnv ?? null,
        hold_expires_at: c.holdExpiresAt !== undefined ? ctx.codec.timestamp(c.holdExpiresAt) : null,
      })),
    )
    .execute();
}
