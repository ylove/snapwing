// The milestone events a watcher hears about (A 4.4): filed, PR open, merged, on staging, live,
// stopped, failed. Pure, and a function of the same inputs `statusFor` reads (status/loopback.ts), so
// a notification and the pinned-message edit for one event always agree on whether it happened: an
// event that did not fit the status it arrived in (the status was kept) is no milestone, and neither
// is the retry's second PR.

import type { IncidentEvent } from '../contracts/events.ts';
import type { IncidentStatus, IncidentView } from '../contracts/state.ts';

export const MILESTONES = ['filed', 'pr-open', 'merged', 'staging', 'live', 'stopped', 'failed'] as const;

export type Milestone = (typeof MILESTONES)[number];

/**
 * The milestone `event` reached, or undefined. `incident` is the row after the event folded and
 * `before` the row before it (absent for the first event). Without `before`, an event that names a
 * status counts as moving there.
 */
export function milestoneFor(event: IncidentEvent, incident: IncidentView, before?: IncidentView): Milestone | undefined {
  if (incident.jiraKey === undefined || incident.status === 'linked-to-existing') return undefined;
  const moved = (to: IncidentStatus): boolean => incident.status === to && (before === undefined || before.status !== to);
  switch (event.type) {
    case 'filed':
      return moved('filed') ? 'filed' : undefined;
    case 'pr-opened':
      return moved('in-review') ? 'pr-open' : undefined;
    case 'merged':
      return moved('merged') ? 'merged' : undefined;
    case 'deployed:staging':
      return moved('deployed:staging') ? 'staging' : undefined;
    case 'deployed:production':
      return moved('deployed:production') ? 'live' : undefined;
    case 'stopped':
      return moved('stopped') ? 'stopped' : undefined;
    case 'fixer-failed':
      return moved('escalated') ? 'failed' : undefined;
    default:
      return undefined;
  }
}
