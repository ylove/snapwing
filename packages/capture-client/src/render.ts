import type { Choice, LookupResponse, QueueItem, QueueView } from './wire.ts';

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

/** Most items a section lists; the rest are counted, as on the Slack Home and the Teams card. */
export const QUEUE_SECTION_LIMIT = 8;

const REPORTER_INTRO = 'Fix it from here. Send a bug with `snapwing say`, and `snapwing status <KEY>` shows where a report stands.';

function queueLine(item: QueueItem): string {
  const priority = item.priority === undefined ? '' : ` (${item.priority})`;
  return `  ${item.label} ${item.summary}${priority}${item.detail === '' ? '' : ` · ${item.detail}`}`;
}

/** The queue as plain terminal lines: each section's title and count, its items, or what it says when empty. */
export function formatQueue(queue: QueueView): string {
  const lines: string[] = [queue.title];
  if (queue.kind === 'reporter') lines.push(REPORTER_INTRO);
  for (const s of queue.sections) {
    lines.push('', `${s.title}${s.items.length === 0 ? '' : ` (${s.items.length})`}`);
    if (s.items.length === 0) {
      lines.push(`  ${s.empty}`);
      continue;
    }
    for (const it of s.items.slice(0, QUEUE_SECTION_LIMIT)) {
      lines.push(queueLine(it));
      for (const b of it.buttons) if (b.kind === 'open_pr') lines.push(`    ${b.url}`);
    }
    if (s.items.length > QUEUE_SECTION_LIMIT) lines.push(`  and ${s.items.length - QUEUE_SECTION_LIMIT} more`);
  }
  return lines.join('\n');
}
