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

/** What the caller knows about the event's actor on GitHub. */
export interface GithubActor {
  /** The actor's linked GitHub login, when they linked one; the only thing that may be `@`-mentioned. */
  githubLogin?: string;
}

// GitHub logins: alphanumerics and single hyphens, 39 characters at most.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Stands in for the person while the rest of the line is defused, then is swapped for the final wording.
const WHO = '\uE000';
const ZWSP = '\u200B';

/**
 * A chat display name is not a GitHub login: `@Dana` would notify whoever owns `dana`. So a linked login
 * is mentioned, and anyone else is named in bold with every Markdown punctuation mark backslash-escaped
 * (a name cannot open a link, code span, emphasis, or HTML), `@` followed by a zero-width space (so no
 * mention forms even through an escape), whitespace collapsed, and the length capped.
 */
function personWording(name: string, githubLogin: string | undefined): string {
  if (githubLogin !== undefined && LOGIN.test(githubLogin)) return `@${githubLogin}`;
  const flat = name.replace(/[\s\p{C}]+/gu, ' ').trim().slice(0, 80);
  const safe = flat.replace(/@/g, `@${ZWSP}`).replace(/[!-/:-?[-`{-~]/g, (c) => `\\${c}`);
  return `**${safe === '' ? 'someone' : safe}**`;
}

/** GitHub rows for one event (see the file header). */
export function githubRows(event: IncidentEvent, change: IncidentChange, actor: GithubActor = {}): OutboxItem[] {
  const { after } = change;
  if (after.prNumber === undefined || after.repo === undefined || after.repo === '') return [];
  let named = '';
  const line = attributionText(event, (name) => {
    named = personWording(name, actor.githubLogin);
    return WHO;
  });
  if (line === undefined) return [];
  // Quoted message text may carry mentions too; defuse them, then put the person's wording in.
  // GitHub only mentions an `@` at the start of a word, so links and email addresses are left alone.
  const text = line.replace(/(?<![A-Za-z0-9_])@(?=[A-Za-z0-9])/g, `@${ZWSP}`).replace(WHO, () => named);
  const payload: PrCommentRow = { repo: repoFullName(after.repo), prNumber: after.prNumber, text };
  return rowsFor(event, 'github', [{ op: 'add-comment', payload: { ...payload }, batchKey: jiraCommentBatchKey(event.incidentId) }]);
}
