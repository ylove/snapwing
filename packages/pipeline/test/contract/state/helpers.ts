import { afterAll, beforeAll } from 'vitest';
import type { NewEvent, NewArtifact, OutboxItem } from '../../../src/contracts/state.ts';
import type { OpenedState, StatePort } from '../../../src/ports/state.ts';
import { openState } from '../../../src/state/db.ts';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.ts';

let serial = 0;
export function id(): string {
  let value = ++serial;
  let suffix = '';
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  do {
    suffix = alphabet.charAt(value % 32) + suffix;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `01K00000000000000000${suffix.padStart(6, '0')}`;
}
export const workspaceId = id();
export const epoch = '2026-10-02T12:00:00.000Z';
export function fixture(): { state: () => StatePort; setTime: (ms: number) => void } {
  let db: TestDatabase | undefined;
  let opened: OpenedState | undefined;
  let time = Date.parse(epoch);
  beforeAll(async () => {
    db = await createTestDatabase();
    opened = await openState(db.options, { now: () => new Date(time) });
  });
  afterAll(async () => {
    try { await opened?.close(); } finally { await db?.drop(); }
  });
  return {
    state: () => {
      if (!opened) throw new Error('Fixture has not opened');
      return opened;
    },
    setTime: (ms) => { time = Date.parse(epoch) + ms; },
  };
}
export function event(incidentId: string): NewEvent {
  return { incidentId, workspaceId, type: 'closed', v: 1, source: 'cli', occurredAt: epoch, payload: {} };
}
export function artifact(incidentId = id()): NewArtifact {
  return { workspaceId, incidentId, kind: 'diagnosis', contentType: 'application/json', body: '{}', createdBy: 'fake-test-agent' };
}
export function outbox(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return { id: id(), workspaceId, target: 'jira', op: 'add-comment', payload: { text: 'fake comment' }, attempts: 0, createdAt: epoch, nextAttempt: epoch, ...overrides };
}
