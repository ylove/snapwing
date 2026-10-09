// `run_credentials` (#273): what a runner container run has spent with its tokens, and whether they are
// revoked. The fixer API token and the model token of a run name its run id; the fixer API and the model
// proxy check the row before they act, so a token stops working the moment its run is revoked (the run
// ended or was stopped), however long its signed expiry is. Not part of StatePort; StateStore exposes
// these as methods, and `RunCredentialsPort` is the slice the API needs.
//
// Each reservation is one statement: an insert of the run's first use, or an update that applies only
// while the run is not revoked and under its limits. So of two concurrent calls at a limit, at most one
// wins, on SQLite and on Postgres alike.

import type { StateContext } from './context.ts';

export interface RunCredentialUse {
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  artifacts: number;
  artifactBytes: number;
  revoked: boolean;
}

export type RunSpendRefusal = 'revoked' | 'request-cap' | 'token-cap' | 'artifact-cap';
export type RunReservation = { ok: true } | { ok: false; reason: RunSpendRefusal };

export interface ModelRequestLimits {
  /** Requests one run may make through the model proxy. */
  maxRequests: number;
  /** Tokens (input plus output) one run may spend; a request is refused once the run has used them. */
  maxTokens: number;
}

export interface ArtifactLimits {
  maxArtifacts: number;
  maxBytes: number;
}

/** What the fixer API and the model proxy need of the store. */
export interface RunCredentialsPort {
  runCredentialsRevoked(runId: string): Promise<boolean>;
  revokeRunCredentials(runId: string): Promise<void>;
  reserveModelRequest(runId: string, limits: ModelRequestLimits): Promise<RunReservation>;
  recordModelTokens(runId: string, inputTokens: number, outputTokens: number): Promise<void>;
  reserveArtifact(runId: string, bytes: number, limits: ArtifactLimits): Promise<RunReservation>;
}

export async function runCredentialUse(ctx: StateContext, runId: string): Promise<RunCredentialUse | undefined> {
  const row = await ctx.db.selectFrom('run_credentials').selectAll().where('run_id', '=', runId).executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    modelRequests: ctx.codec.fromNumber(row.model_requests),
    inputTokens: ctx.codec.fromNumber(row.input_tokens),
    outputTokens: ctx.codec.fromNumber(row.output_tokens),
    artifacts: ctx.codec.fromNumber(row.artifacts),
    artifactBytes: ctx.codec.fromNumber(row.artifact_bytes),
    revoked: row.revoked_at !== null,
  };
}

export async function runCredentialsRevoked(ctx: StateContext, runId: string): Promise<boolean> {
  return (await runCredentialUse(ctx, runId))?.revoked ?? false;
}

/** Revokes the run's tokens for good. Idempotent; the first revocation's time stays. */
export async function revokeRunCredentials(ctx: StateContext, runId: string): Promise<void> {
  const now = ctx.codec.timestamp(ctx.now());
  await ctx.db
    .insertInto('run_credentials')
    .values({ run_id: runId, revoked_at: now })
    .onConflict((oc) => oc.column('run_id').doUpdateSet({ revoked_at: now }).where('run_credentials.revoked_at', 'is', null))
    .execute();
}

/** Counts one model request, unless the run is revoked or at a limit. */
export async function reserveModelRequest(ctx: StateContext, runId: string, limits: ModelRequestLimits): Promise<RunReservation> {
  if (limits.maxRequests < 1) return { ok: false, reason: 'request-cap' };
  if (limits.maxTokens < 1) return { ok: false, reason: 'token-cap' };
  const r = await ctx.db
    .insertInto('run_credentials')
    .values({ run_id: runId, model_requests: 1 })
    .onConflict((oc) =>
      oc
        .column('run_id')
        .doUpdateSet((eb) => ({ model_requests: eb('run_credentials.model_requests', '+', 1) }))
        .where('run_credentials.revoked_at', 'is', null)
        .where('run_credentials.model_requests', '<', limits.maxRequests)
        .where((eb) => eb(eb('run_credentials.input_tokens', '+', eb.ref('run_credentials.output_tokens')), '<', limits.maxTokens)),
    )
    .executeTakeFirst();
  if (Number(r.numInsertedOrUpdatedRows ?? 0n) > 0) return { ok: true };
  const use = await runCredentialUse(ctx, runId);
  if (use === undefined || use.revoked) return { ok: false, reason: 'revoked' };
  return { ok: false, reason: use.modelRequests >= limits.maxRequests ? 'request-cap' : 'token-cap' };
}

/** Adds the tokens a provider reported for one of the run's requests. */
export async function recordModelTokens(ctx: StateContext, runId: string, inputTokens: number, outputTokens: number): Promise<void> {
  const input = Math.max(0, Math.trunc(inputTokens));
  const output = Math.max(0, Math.trunc(outputTokens));
  if (input === 0 && output === 0) return;
  await ctx.db
    .insertInto('run_credentials')
    .values({ run_id: runId, input_tokens: input, output_tokens: output })
    .onConflict((oc) =>
      oc.column('run_id').doUpdateSet((eb) => ({
        input_tokens: eb('run_credentials.input_tokens', '+', input),
        output_tokens: eb('run_credentials.output_tokens', '+', output),
      })),
    )
    .execute();
}

/** Counts one artifact of `bytes`, unless the run is revoked or the artifact would pass a limit. */
export async function reserveArtifact(ctx: StateContext, runId: string, bytes: number, limits: ArtifactLimits): Promise<RunReservation> {
  if (limits.maxArtifacts < 1 || bytes > limits.maxBytes) return { ok: false, reason: 'artifact-cap' };
  const r = await ctx.db
    .insertInto('run_credentials')
    .values({ run_id: runId, artifacts: 1, artifact_bytes: bytes })
    .onConflict((oc) =>
      oc
        .column('run_id')
        .doUpdateSet((eb) => ({ artifacts: eb('run_credentials.artifacts', '+', 1), artifact_bytes: eb('run_credentials.artifact_bytes', '+', bytes) }))
        .where('run_credentials.revoked_at', 'is', null)
        .where('run_credentials.artifacts', '<', limits.maxArtifacts)
        .where('run_credentials.artifact_bytes', '<=', limits.maxBytes - bytes),
    )
    .executeTakeFirst();
  if (Number(r.numInsertedOrUpdatedRows ?? 0n) > 0) return { ok: true };
  return { ok: false, reason: (await runCredentialsRevoked(ctx, runId)) ? 'revoked' : 'artifact-cap' };
}
