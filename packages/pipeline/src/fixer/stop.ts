// src/fixer/stop.ts: Stop (main 10.4, B 5, B 9). The Stop button and the `snapwing:stop` Jira label
// both call `stopIncident`.
//
// Appends `stopped` first, so the fixer's stop poll (B 9, `GET /fixer/{id}/stop`) and any late report
// see it, then cancels a queued `fixer.run` and the budget timer, cancels the running run through the
// RunnerPort, and closes an open PR with a comment through `FixerGitHub.closePr`. Anything already
// pushed stays on the branch. A second stop (a `stopped` already newer than the last `filed`) appends
// nothing and does nothing else. `stopped` is not terminal (B 5); a stop on a terminal incident is a
// no-op.

import type { EventActor, EventSource, IncidentEvent } from '../contracts/events.ts';
import { fixerRunKey } from '../contracts/jobs.ts';
import { isTerminalStatus } from '../lifecycle/machine.ts';
import { activeRun, appendDecided, fixerBudgetKey, githubContext, lastSeqOf, latest, newEvent, stoppedSinceFiled, type FixerDeps } from './job.ts';

export interface StopInput {
  incidentId: string;
  /** Who pressed Stop or added the label. */
  actor: EventActor;
  /** Where the stop came from. Default `agent`. */
  source?: EventSource;
  reason?: string;
}

export type StopOutcome =
  | { stopped: false; reason: 'already-stopped' | 'unknown-incident' | 'terminal' }
  | { stopped: true; cancelledRun?: string; closedPr?: number };

export async function stopIncident(deps: FixerDeps, input: StopInput): Promise<StopOutcome> {
  const { incidentId, actor } = input;
  let refusal: 'already-stopped' | 'unknown-incident' | 'terminal' = 'already-stopped';
  const incident = await deps.state.getIncident(incidentId);
  if (incident !== null && isTerminalStatus(incident.status)) return { stopped: false, reason: 'terminal' };

  const appended = await appendDecided(deps.state, incidentId, (events) => {
    if (events.length === 0) {
      refusal = 'unknown-incident';
      return undefined;
    }
    if (stoppedSinceFiled(events)) {
      refusal = 'already-stopped';
      return undefined;
    }
    return [
      newEvent(deps, incidentId, 'stopped', input.reason === undefined ? {} : { reason: input.reason }, { actor, source: input.source ?? 'agent' }),
    ];
  });
  if (!appended.appended) return { stopped: false, reason: refusal };

  const before = appended.before;
  await deps.workflow.cancel(fixerRunKey(incidentId));
  await deps.workflow.cancel(fixerBudgetKey(incidentId));

  const run = activeRun(before);
  if (run !== undefined) await deps.runner.cancel(run.payload.runId);

  const pr = openPr(before);
  if (pr !== undefined) {
    const ctx = await githubContext(deps.state, incidentId);
    await deps.github.closePr(pr, closeComment(actor, ctx.issueKey, input.reason), ctx);
  }
  return {
    stopped: true,
    ...(run === undefined ? {} : { cancelledRun: run.payload.runId }),
    ...(pr === undefined ? {} : { closedPr: pr }),
  };
}

/**
 * The PR still open before this stop: the latest `pr-opened` newer than any earlier `stopped` (that
 * stop closed it) with no `merged` or `closed` after it.
 */
function openPr(events: readonly IncidentEvent[]): number | undefined {
  const opened = latest(events, 'pr-opened');
  if (opened === undefined || opened.seq < lastSeqOf(events, 'stopped')) return undefined;
  const ended = events.some((e) => e.seq > opened.seq && (e.type === 'merged' || e.type === 'closed'));
  return ended ? undefined : opened.payload.prNumber;
}

function closeComment(actor: EventActor, issueKey: string | undefined, reason: string | undefined): string {
  const ticket = issueKey === undefined ? 'this incident' : issueKey;
  const why = reason === undefined || reason.trim() === '' ? '' : ` Reason: ${reason.trim()}`;
  return `Stopped by ${actor.id} through Snapwing. Closing this PR for ${ticket}; the branch is kept.${why}`;
}
