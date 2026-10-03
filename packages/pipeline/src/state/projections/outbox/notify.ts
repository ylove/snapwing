// Chat rows for push notifications (A 4.4): target `slack` (or the incident's chat target), op
// `notify`. `planNotices` (notify/policy.ts) decides who is told and when; this module turns each
// notice into a row. A thread notice is one row mentioning everyone to be mentioned; a DM is one row
// per person (`payload.delivery` says which).
//
// Rows of one burst share `batch_key` `notify:{window}:{delivery}`, and wait for the same
// `next_attempt`, so the chat projector merges them into one message (B 7.1) when the window closes.
// Each row carries its own `text`; the merged message lists them in order.
//
// The context (playbook, subscriptions, the open window) is not in the event or the incident row, so
// a caller that has it passes `change.notify`. Without it the module returns nothing: notifications
// are off by default beyond the silent pinned edit.
//
// Row ids: `rowsFor` numbers a target's rows from 0 and the status module takes 0 on `slack`, so these
// rows are numbered from `NOTIFY_INDEX_BASE`.

import type { IncidentEvent } from '../../../contracts/events.ts';
import type { OutboxItem, OutboxTarget } from '../../../contracts/state.ts';
import { milestoneFor, type Milestone } from '../../../notify/milestone.ts';
import { planNotices, type NoticeReason, type NotifyWindow } from '../../../notify/policy.ts';
import type { IncidentChange } from './index.ts';
import { outboxRowId } from './row.ts';
import { statusTargets } from './status.ts';

export const NOTIFY_OP = 'notify';

/** First per-target row index used by notify rows (the status module uses 0). */
export const NOTIFY_INDEX_BASE = 16;

/** `notify` payload. */
export interface NotifyRow {
  delivery: 'thread' | 'dm';
  /** Users to mention in the thread; the one user to DM. */
  mentions: string[];
  milestone: Milestone;
  /** The message, with `<@ref>` mention tokens in a thread message (status/copy.ts). */
  text: string;
  reason: NoticeReason;
  /** Burst window the row belongs to. */
  windowKey: string;
  issueKey?: string;
}

/** `batch_key` of a notify row. */
export function notifyBatchKey(windowKey: string, deliveryKey: string): string {
  return `notify:${windowKey}:${deliveryKey}`;
}

/**
 * The open window from an incident's outbox rows: the newest `notify` row that is not the reporter's
 * staging request. Its `next_attempt` is when its batch goes out.
 */
export function windowFromRows(rows: readonly OutboxItem[]): NotifyWindow | undefined {
  let newest: OutboxItem | undefined;
  for (const row of rows) {
    if (row.op !== NOTIFY_OP || row.payload['reason'] === 'request' || typeof row.payload['windowKey'] !== 'string') continue;
    if (newest === undefined || row.createdAt > newest.createdAt || (row.createdAt === newest.createdAt && row.id > newest.id)) newest = row;
  }
  return newest === undefined ? undefined : { key: newest.payload['windowKey'] as string, sendAt: newest.nextAttempt };
}

/** Notification rows for one event (see the file header). */
export function notifyRows(event: IncidentEvent, change: IncidentChange): OutboxItem[] {
  const context = change.notify;
  if (context === undefined || !change.valid) return [];
  const milestone = milestoneFor(event, change.after, change.before);
  if (milestone === undefined) return [];
  const incident = change.after;
  const notices = planNotices({
    milestone,
    incident: {
      id: incident.id,
      ...(incident.surfaceId === undefined ? {} : { surfaceId: incident.surfaceId }),
      ...(incident.priority === undefined ? {} : { priority: incident.priority }),
      ...(incident.reporterId === undefined ? {} : { reporterId: incident.reporterId }),
      ...(incident.jiraKey === undefined ? {} : { jiraKey: incident.jiraKey }),
    },
    at: event.recordedAt,
    seq: event.seq,
    context,
  });
  // A thread needs a status target (an incident from chat); a DM does not, so Slack takes it.
  const target: OutboxTarget = statusTargets(incident.source)[0] ?? 'slack';
  return notices.map((notice, i): OutboxItem => {
    const payload: NotifyRow = {
      delivery: notice.delivery,
      mentions: notice.mentions,
      milestone: notice.milestone,
      text: notice.text,
      reason: notice.reason,
      windowKey: notice.windowKey,
      ...(incident.jiraKey === undefined ? {} : { issueKey: incident.jiraKey }),
    };
    return {
      id: outboxRowId(event, target, NOTIFY_INDEX_BASE + i),
      workspaceId: event.workspaceId,
      target,
      incidentId: event.incidentId,
      op: NOTIFY_OP,
      payload: { ...payload },
      batchKey: notifyBatchKey(notice.windowKey, notice.deliveryKey),
      attempts: 0,
      nextAttempt: notice.sendAt,
      createdAt: event.recordedAt,
    };
  });
}
