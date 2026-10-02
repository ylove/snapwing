// Operational routes every API process mounts (B 10):
//
//   GET /healthz   200 `ok` once the state store is open and migrated and answers a query; 503 before
//   GET /metrics   Prometheus text format 0.0.4: outbox depth and oldest undrained row age per
//                  target, the parked job count, and reconciler corrections in the last hour;
//                  503 until the store is open
//
// `openState` runs the migrations before it resolves, so "open" here means "open and migrated".
// The store is passed as a getter so `snapwing serve` can listen before the store has opened.

import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { OUTBOX_TARGETS } from '@snapwing/pipeline/contracts/state.ts';
import { pingState, readStoreMetrics, type StoreMetrics } from '@snapwing/pipeline/state/metrics.ts';
import type { Route } from './http.ts';

export interface OpsRoutesOptions {
  /** The open, migrated store, or undefined while it is still opening (or after it closed). */
  readonly state: () => StatePort | undefined;
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
          return plain(503, 'state store not open');
        }
        try {
          await pingState(state);
        } catch {
          return plain(503, 'state store not answering');
        }
        return plain(200, 'ok');
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
        return new Response(renderMetrics(metrics), { status: 200, headers: { 'content-type': PROMETHEUS_CONTENT_TYPE } });
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
  ];
  return `${lines.join('\n')}\n`;
}

function round(seconds: number): string {
  return String(Math.round(seconds * 1000) / 1000);
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
