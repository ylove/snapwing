// #393: a Teams incident gets `target='teams'` rows, as a Slack one gets `target='slack'` (main 12, 15.2,
// A 4.4). Both platforms run through a real store on the dialect `SNAPWING_DB` selects, so the rows are
// the ones the projections write, and each platform's rows stay off the other's queue.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewEvent } from '../../src/contracts/events.ts';
import type { OutboxItem, OutboxTarget } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { NotifyRow } from '../../src/state/projections/outbox/notify.ts';
import { statusBatchKey, statusTargets, UPDATE_STATUS_OP } from '../../src/state/projections/outbox/status.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-01T15:00:00.000Z');
const workspaceId = '01JZ0000000000000000000001';

let tdb: TestDatabase;
let state: OpenedState;
let time = T0;
let serial = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  await tdb.drop();
});

const iso = (): string => new Date(time).toISOString();

function ev(incidentId: string, type: NewEvent['type'], payload: unknown, source: NewEvent['source']): NewEvent {
  return { workspaceId, incidentId, type, v: 1, source, occurredAt: iso(), payload } as unknown as NewEvent;
}

async function filedIncident(source: 'slack' | 'teams'): Promise<string> {
  serial += 1;
  const id = `01JZ0000000000000000${source === 'teams' ? 'T' : 'S'}${String(serial).padStart(5, '0')}`;
  const drafts: NewEvent[] = [
    ev(id, 'captured', {
      kind: 'incident',
      idempotencyKey: `${source}:${id}`,
      source,
      reporter: { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' },
      anchorText: 'Checkout says 500',
      anchorId: '1700000000.000100',
      channelId: 'C-FAKE',
    }, source),
    ev(id, 'context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 1, excludedCount: 0 }, 'agent'),
    ev(id, 'resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }, 'agent'),
    ev(id, 'dedupe-checked', { candidates: [], decision: 'none' }, 'agent'),
    ev(id, 'planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500',
      priority: 'Medium',
      labels: ['snapwing'],
      autonomyLevel: 2,
      implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
    }, 'agent'),
  ];
  const { seq } = await state.append(id, drafts, 0);
  await state.append(id, [ev(id, 'filed', { jiraKey: `WEB-${String(serial)}` }, 'agent')], seq);
  return id;
}

/** Everything queued for `target`, however far in the future, acked as it goes. */
async function drain(target: OutboxTarget): Promise<OutboxItem[]> {
  const rows: OutboxItem[] = [];
  const far = time;
  time = far + 400 * 24 * 3600 * 1000;
  try {
    for (let page = await state.drainOutbox(target, 1000); page.length > 0; page = await state.drainOutbox(target, 1000)) {
      rows.push(...page);
      await state.ackOutbox(page.map((r) => r.id));
    }
  } finally {
    time = far;
  }
  return rows;
}

describe('chat targets', () => {
  it('maps slack and teams to their own target; capture sources without a thread get none', () => {
    expect(statusTargets('slack')).toEqual(['slack']);
    expect(statusTargets('teams')).toEqual(['teams']);
    expect(statusTargets('cli')).toEqual([]);
    expect(statusTargets('raycast')).toEqual([]);
  });
});

describe.each(['slack', 'teams'] as const)('%s incident', (platform) => {
  const other = platform === 'slack' ? 'teams' : 'slack';

  it('gets update-status and notify rows on its own target only', async () => {
    time += 3_600_000;
    await state.subscribe({ workspaceId, userId: 'U-PAT', scopeKind: 'surface', scopeId: 'web', channel: 'thread', createdAt: iso() });
    const id = await filedIncident(platform);

    const own = (await drain(platform)).filter((r) => r.incidentId === id);
    const foreign = (await drain(other)).filter((r) => r.incidentId === id);
    await state.unsubscribe({ workspaceId, userId: 'U-PAT', scopeKind: 'surface', scopeId: 'web' });

    expect(foreign).toEqual([]);
    const status = own.filter((r) => r.op === UPDATE_STATUS_OP);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ target: platform, batchKey: statusBatchKey(id), attempts: 0 });
    const notify = own.filter((r) => r.op === 'notify');
    expect(notify).toHaveLength(1);
    expect(notify[0]).toMatchObject({ target: platform });
    expect(notify[0]?.payload as unknown as NotifyRow).toMatchObject({ delivery: 'thread', mentions: ['U-PAT'], milestone: 'filed', reason: 'watch' });
  });
});
