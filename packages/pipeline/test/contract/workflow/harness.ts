import { randomUUID } from 'node:crypto';
import type { WorkflowPort } from '../../../src/ports/workflow.ts';
import { StateStore } from '../../../src/state/store.ts';
import { InProcessWorkflow } from '../../../src/workflow/inprocess/index.ts';
import { PgBossWorkflow } from '../../../src/workflow/pgboss/index.ts';
import { createTestDatabase } from '../../helpers/db.ts';

const DELIVERY_TIMEOUT_MS = 10_000;

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Only this adapter knows about scheduler lifecycle and wall time. Assertions use the port. */
export async function createHarness() {
  const database = await createTestDatabase();
  const realTime = database.dialect === 'postgres';
  const schema = `contract_${randomUUID().replaceAll('-', '')}`;
  let time = Date.parse('2026-01-01T00:00:00Z');
  const now = (): Date => new Date(realTime ? Date.now() : time);
  let state = await database.open({ now });
  const construct = () => {
    if (!realTime) return new InProcessWorkflow(state);
    if (!(state instanceof StateStore)) throw new Error('Expected the test database to open a StateStore');
    return new PgBossWorkflow(state, { schema, pollingIntervalSeconds: 0.5, cronIntervalSeconds: 1 });
  };
  let scheduler = construct();
  let polling = false;
  const pump = async (): Promise<void> => {
    if (scheduler instanceof InProcessWorkflow) {
      await scheduler.drain();
    } else {
      if (!polling) {
        await scheduler.startPolling();
        polling = true;
      }
      await sleep(50);
    }
  };
  return {
    get port(): WorkflowPort { return scheduler; },
    now,
    pump,
    async advance(ms: number): Promise<void> {
      if (realTime) await sleep(ms);
      else time += ms;
      await pump();
    },
    async until(predicate: () => boolean, timeoutMs = DELIVERY_TIMEOUT_MS): Promise<void> {
      if (predicate()) return;
      const deadline = Date.now() + timeoutMs;
      do {
        await pump();
        if (predicate()) return;
        await sleep(10);
      } while (Date.now() < deadline);
      throw new Error('Workflow delivery did not arrive before the deadline');
    },
    async advanceTo(deadline: Date): Promise<void> {
      await this.advance(Math.max(0, deadline.getTime() - now().getTime()));
    },
    async deliveryWithin(predicate: () => boolean, delayMs: number): Promise<void> {
      // Virtual time must move to make jobs due. Real workers run while until polls,
      // so return on delivery instead of sleeping through an extra cron boundary.
      if (predicate()) return;
      if (!realTime) await this.advance(delayMs);
      await this.until(predicate, delayMs + DELIVERY_TIMEOUT_MS);
    },
    async quiet(): Promise<void> {
      await this.advance(1_200);
    },
    async reopen(): Promise<void> {
      await scheduler.stop();
      await state.close();
      state = await database.open({ now });
      scheduler = construct();
      polling = false;
      await scheduler.recover();
    },
    async close(): Promise<void> {
      try { await scheduler.stop(); }
      finally { await database.drop(); }
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
