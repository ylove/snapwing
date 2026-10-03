// GitHub rows: the attribution comment on the incident's pull request (A 1.5: "written to the Jira
// issue (and to the PR when one exists)"). The line is the Jira one (`attributionText` in jira.ts);
// it goes to the latest PR the incidents row knows (`pr_number`) on the incident's repo, as an
// `add-comment` row with `batch_key` `comment:{incident}`, so a GitHub projector merges a burst within
// 60 s into one PR comment as the Jira projector does (B 7.1). No row without a PR or a repo.

import type { IncidentEvent } from '../../../contracts/events.ts';
import type { OutboxItem } from '../../../contracts/state.ts';
import { repoFullName } from '../../../util/repo.ts';
import type { IncidentChange } from './index.ts';
import { attributionText, jiraCommentBatchKey } from './jira.ts';
import { rowsFor } from './row.ts';

/** `add-comment` on a pull request: plain text (GitHub renders it as Markdown). */
export interface PrCommentRow {
  /** `owner/name`. */
  repo: string;
  prNumber: number;
  text: string;
}

/** GitHub rows for one event (see the file header). */
export function githubRows(event: IncidentEvent, change: IncidentChange): OutboxItem[] {
  const { after } = change;
  if (after.prNumber === undefined || after.repo === undefined || after.repo === '') return [];
  const text = attributionText(event);
  if (text === undefined) return [];
  const payload: PrCommentRow = { repo: repoFullName(after.repo), prNumber: after.prNumber, text };
  return rowsFor(event, 'github', [{ op: 'add-comment', payload: { ...payload }, batchKey: jiraCommentBatchKey(event.incidentId) }]);
}
