// Who the incident's reporter is (#363, #365). `payload.reporter` is who brought the report in; when that
// person only flagged someone else's post (a trigger reaction, the message shortcut), `anchorAuthor` is
// the post's author, the person who saw the bug. Anything that names or asks "the reporter" uses this.

import type { CanonicalIncidentPayload, IncidentActor } from '../contracts/incident.ts';

type ReporterFields = Pick<CanonicalIncidentPayload, 'reporter' | 'anchorAuthor'>;

/** The anchor's author when a person other than the trigger wrote it, else the one who brought it in. */
export function incidentReporter(payload: ReporterFields): IncidentActor {
  return payload.anchorAuthor ?? payload.reporter;
}

/** The person who flagged someone else's post, or undefined when the reporter brought the report in themselves. */
export function flaggedBy(payload: ReporterFields): IncidentActor | undefined {
  const author = payload.anchorAuthor;
  return author !== undefined && author.id !== payload.reporter.id ? payload.reporter : undefined;
}
