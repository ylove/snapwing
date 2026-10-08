// Operational routes every API process mounts (B 10):
//
//   GET /healthz   JSON `{ ok: true, platforms? }` (capture-client's `HealthResult`, which `snapwing
//                  status` reads, #385) once the state store is open and migrated and answers a query;
//                  `platforms` is each configured chat platform as compose reports it (`health`).
//                  503 `{ ok: false, detail }` before. Unauthenticated, like `/metrics`
//   GET /metrics   Prometheus text format 0.0.4: outbox depth and oldest undrained row age per
//                  target, the parked job count, reconciler corrections in the last hour, and
//                  the event-log watermark lag in rows (0 on SQLite);
//                  503 until the store is open
//
// `openState` runs the migrations before it resolves, so "open" here means "open and migrated".
// The store is passed as a getter so `snapwing serve` can listen before the store has opened.

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
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function opsRoutes(options: OpsRoutesOptions): Route[] {
  return [
    {
      method: 'GET',
      path: '/healthz',
      handler: async () => {
        const state = options.state();
        if (state === undefined) {
          return json(503, { ok: false, detail: 'state store not open' });
        }
        try {
          await pingState(state);
        } catch {
          return json(503, { ok: false, detail: 'state store not answering' });
        }
        const platforms = (await options.health?.()) ?? [];
        const body: HealthResult = { ok: true, ...(platforms.length === 0 ? {} : { platforms }) };
        return json(200, body);
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handler: async () => {
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
