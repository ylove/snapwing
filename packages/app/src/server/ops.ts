// Operational routes every API process mounts (B 10):
//
//   GET /healthz   JSON `{ ok: true, platforms? }` (capture-client's `HealthResult`, which `snapwing
//                  status` reads, #3) once the state store is open and migrated and answers a query;
//                  `platforms` is each configured chat platform as compose reports it (`health`).
//                  503 `{ ok: false, detail }` before. Open to anyone, but only a request with the ops
//                  token sees the detail: without it each platform is its id, `ok`, and `mode`, and a
//                  503 has no `detail` (#272)
//   GET /metrics   Prometheus text format 0.0.4: outbox depth and oldest undrained row age per
//                  target, the parked job count, reconciler corrections in the last hour, and
//                  the event-log watermark lag in rows (0 on SQLite);
//                  503 until the store is open. Only with the ops token: 401 otherwise, and always
//                  when no token is set
//
// The ops token is `SNAPWING_OPS_TOKEN` (`serve.ts`), sent as `Authorization: Bearer <token>`.
//
// `openState` runs the migrations before it resolves, so "open" here means "open and migrated".
// The store is passed as a getter so `snapwing serve` can listen before the store has opened.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { HealthResult, PlatformHealth } from '@snapwing/capture-client/wire.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { OUTBOX_TARGETS } from '@snapwing/pipeline/contracts/state.ts';
import { pingState, readStoreMetrics, type StoreMetrics } from '@snapwing/pipeline/state/metrics.ts';
import type { Route } from './http.ts';

export interface OpsRoutesOptions {
  /** The open, migrated store, or undefined while it is still opening (or after it closed). */
  readonly state: () => StatePort | undefined;
  /** More Prometheus text for `/metrics` (the composed projectors' pauses and parked rows). */
  readonly metrics?: () => Promise<string>;
  /** Each configured chat platform for `/healthz` (compose's `health`). */
  readonly health?: () => Promise<readonly PlatformHealth[]>;
  /** The ops token (`SNAPWING_OPS_TOKEN`): `/metrics` and the `/healthz` detail need it. Absent: neither is served. */
  readonly token?: string;
}

/** Whether the request carries the ops token as a bearer token; false when there is no token. */
export function hasOpsToken(req: Request, token: string | undefined): boolean {
  if (token === undefined || token === '') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '');
  if (match?.[1] === undefined) return false;
  const digest = (v: string): Buffer => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function opsRoutes(options: OpsRoutesOptions): Route[] {
  return [
    {
      method: 'GET',
      path: '/healthz',
      handler: async (req) => {
        const detailed = hasOpsToken(req, options.token);
        const state = options.state();
        if (state === undefined) {
          return json(503, { ok: false, ...(detailed ? { detail: 'state store not open' } : {}) });
        }
        try {
          await pingState(state);
        } catch {
          return json(503, { ok: false, ...(detailed ? { detail: 'state store not answering' } : {}) });
        }
        const all = (await options.health?.()) ?? [];
        const platforms = detailed ? all : all.map((p) => ({ id: p.id, ok: p.ok, ...(p.mode === undefined ? {} : { mode: p.mode }) }));
        const body: HealthResult = { ok: true, ...(platforms.length === 0 ? {} : { platforms }) };
        return json(200, body);
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handler: async (req) => {
        if (!hasOpsToken(req, options.token)) {
          return new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Bearer' } });
        }
        const state = options.state();
        if (state === undefined) {
          return plain(503, 'state store not open');
        }
        const metrics = await readStoreMetrics(state);
        const extra = (await options.metrics?.()) ?? '';
        return new Response(`${renderMetrics(metrics)}${extra === '' || extra.endsWith('\n') ? extra : `${extra}\n`}`, { status: 200, headers: { 'content-type': PROMETHEUS_CONTENT_TYPE } });
      },
    },
  ];
}

/** Renders B 10 store metrics in the Prometheus text exposition format. */
export function renderMetrics(metrics: StoreMetrics): string {
  const lines: string[] = [
    '# HELP snapwing_outbox_depth Outbox rows not yet drained, per target.',
    '# TYPE snapwing_outbox_depth gauge',
    ...OUTBOX_TARGETS.map((t) => `snapwing_outbox_depth{target="${t}"} ${metrics.outbox[t].depth}`),
    '# HELP snapwing_outbox_oldest_age_seconds Age of the oldest undrained outbox row, per target; 0 when empty.',
    '# TYPE snapwing_outbox_oldest_age_seconds gauge',
    ...OUTBOX_TARGETS.map((t) => `snapwing_outbox_oldest_age_seconds{target="${t}"} ${round(metrics.outbox[t].oldestAgeSeconds)}`),
    '# HELP snapwing_jobs_parked Jobs parked on a wait (tap, children, CI, deploy, verification).',
    '# TYPE snapwing_jobs_parked gauge',
    `snapwing_jobs_parked ${metrics.parkedJobs}`,
    '# HELP snapwing_reconciler_corrections_last_hour Events the reconciler emitted for missed webhooks, recorded in the last hour.',
    '# TYPE snapwing_reconciler_corrections_last_hour gauge',
    `snapwing_reconciler_corrections_last_hour ${metrics.reconcilerCorrectionsLastHour}`,
    '# HELP snapwing_event_log_watermark_lag_rows Committed event rows the projectors cannot read yet because an older transaction is open; 0 on SQLite.',
    '# TYPE snapwing_event_log_watermark_lag_rows gauge',
    `snapwing_event_log_watermark_lag_rows ${metrics.watermarkLagRows}`,
  ];
  return `${lines.join('\n')}\n`;
}

function round(seconds: number): string {
  return String(Math.round(seconds * 1000) / 1000);
}

function json(status: number, body: HealthResult & { detail?: string }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
