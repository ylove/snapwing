// Artifacts (B 1, B 3): versioned, content-addressed. Every put writes a new immutable row
// `(id, version)`; versions run 1, 2, 3 per id with no gaps. `sha256` is the lowercase hex digest
// of the UTF-8 body, computed here, never taken from the caller.

import { createHash } from 'node:crypto';
import type { Selectable } from 'kysely';
import { StateNotFoundError, type Artifact, type ArtifactContentType, type ArtifactKind, type NewArtifact } from '../contracts/state.ts';
import { ulid } from '../util/ulid.ts';
import { inTransaction, type StateContext } from './context.ts';
import type { ArtifactsTable } from './db.ts';

const ARTIFACT_KINDS: readonly ArtifactKind[] = ['implementation-request', 'diagnosis', 'contract', 'review', 'bundle'];
const CONTENT_TYPES: readonly ArtifactContentType[] = ['application/xml', 'application/json'];

/** How often a put retries when a concurrent put took the same version first. */
const VERSION_RACE_RETRIES = 5;

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * See `StatePort.putArtifact`. Without `a.id` mints a ULID and writes version 1; with `a.id` writes
 * the version after that id's latest (version 1 when the id has none yet, so a caller may mint the
 * id itself). Outside a transaction, a put that loses a version race to a concurrent put of the same
 * id retries with the next version; inside one it rejects, since a failed statement aborts the
 * caller's transaction on Postgres.
 */
export async function putArtifact(ctx: StateContext, a: NewArtifact): Promise<{ id: string; version: number }> {
  if (!ARTIFACT_KINDS.includes(a.kind)) {
    throw new TypeError(`putArtifact: unknown artifact kind ${JSON.stringify(a.kind)}`);
  }
  if (!CONTENT_TYPES.includes(a.contentType)) {
    throw new TypeError(`putArtifact: unknown content type ${JSON.stringify(a.contentType)}`);
  }
  const id = a.id ?? ulid(ctx.now().getTime());
  const sha256 = sha256Hex(a.body);
  const attempts = ctx.db.isTransaction ? 1 : VERSION_RACE_RETRIES;

  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(ctx, async (tx) => {
        const latest = await tx.db.selectFrom('artifacts').select((eb) => eb.fn.max('version').as('v')).where('id', '=', id).executeTakeFirst();
        const version = latest?.v === null || latest?.v === undefined ? 1 : tx.codec.fromNumber(latest.v) + 1;
        await tx.db
          .insertInto('artifacts')
          .values({
            id,
            version,
            workspace_id: a.workspaceId,
            incident_id: a.incidentId,
            kind: a.kind,
            content_type: a.contentType,
            sha256,
            body: a.body,
            created_by: a.createdBy,
            created_at: tx.codec.timestamp(tx.now()),
          })
          .execute();
        return { id, version };
      });
    } catch (e) {
      if (attempt >= attempts || !isUniqueViolation(e)) {
        throw e;
      }
    }
  }
}

/** See `StatePort.getArtifact`. The latest version, or `version`; `StateNotFoundError` when absent. */
export async function getArtifact(ctx: StateContext, id: string, version?: number): Promise<Artifact> {
  let q = ctx.db.selectFrom('artifacts').selectAll().where('id', '=', id);
  q = version === undefined ? q.orderBy('version', 'desc').limit(1) : q.where('version', '=', version);
  const row = await q.executeTakeFirst();
  if (row === undefined) {
    throw new StateNotFoundError('artifact', version === undefined ? id : `${id}@${version}`);
  }
  return toArtifact(ctx, row);
}

function toArtifact(ctx: StateContext, row: Selectable<ArtifactsTable>): Artifact {
  return {
    id: row.id,
    version: ctx.codec.fromNumber(row.version),
    workspaceId: row.workspace_id,
    incidentId: row.incident_id,
    kind: oneOf(ARTIFACT_KINDS, row.kind, 'kind'),
    contentType: oneOf(CONTENT_TYPES, row.content_type, 'content_type'),
    sha256: row.sha256,
    body: row.body,
    createdBy: row.created_by,
    createdAt: ctx.codec.fromTimestamp(row.created_at),
  };
}

/** A primary key or unique violation: Postgres SQLSTATE 23505, SQLite's constraint codes. */
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) {
    return false;
  }
  const code = (e as { code: unknown }).code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  const hit = allowed.find((x) => x === value);
  if (hit === undefined) {
    throw new TypeError(`artifacts.${column} holds unknown value ${JSON.stringify(value)}`);
  }
  return hit;
}
