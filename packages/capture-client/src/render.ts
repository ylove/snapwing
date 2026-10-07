import type { Choice, LookupResponse } from './wire.ts';

export interface NumberedChoice extends Choice {
  /** One-based, as typed at a terminal prompt or shown in a list. */
  readonly number: number;
}

export interface RenderedChoices {
  /** The neutral lines every client shows, in order. */
  readonly lines: readonly string[];
  /** Numbered choices to pick from; empty when the response is final or pending. */
  readonly choices: readonly NumberedChoice[];
  /** True when nothing more is asked of the user. */
  readonly done: boolean;
}

/** Client-side choices for a tracked response; the server sends none because opening is local. */
export const TRACKED_CHOICES: readonly Choice[] = [
  { id: 'open', label: 'Open it' },
  { id: 'dismiss', label: 'Not now' },
];

function numbered(choices: readonly Choice[]): readonly NumberedChoice[] {
  return choices.map((c, i) => ({ ...c, number: i + 1 }));
}

export function renderChoices(response: LookupResponse): RenderedChoices {
  switch (response.kind) {
    case 'tracked': {
      const who = response.assignee === undefined ? '' : `, assigned to ${response.assignee}`;
      return {
        lines: [`Already tracked as ${response.issueKey} (${response.status}${who}). Open it?`],
        choices: numbered(TRACKED_CHOICES),
        done: false,
      };
    }
    case 'new': {
      const from = response.evidence === undefined ? '' : ` (from ${response.evidence})`;
      return {
        lines: [`New. Looks like ${response.surface.label}${from}. File it?`],
        choices: numbered(response.choices),
        done: false,
      };
    }
    case 'which-surface':
      return { lines: ['New. Which surface?'], choices: numbered(response.choices), done: false };
    case 'fix-preview':
      return { lines: [`Ready to file: ${response.summary}`], choices: numbered(response.choices), done: false };
    case 'filed':
      return { lines: [`Filed as ${response.issueKey}.`, response.url], choices: [], done: true };
    case 'not-filed':
      return { lines: [`Not filed. ${response.reason}`], choices: [], done: true };
    case 'pending':
      return { lines: ['Working on it.'], choices: [], done: false };
  }
}

/** The lines and numbered choices as plain text, for terminals. */
export function formatRendered(rendered: RenderedChoices): string {
  return [...rendered.lines, ...rendered.choices.map((c) => `${c.number}. ${c.label}`)].join('\n');
}
