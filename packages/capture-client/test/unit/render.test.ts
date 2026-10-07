import { describe, expect, it } from 'vitest';
import { formatRendered, renderChoices } from '../../src/render.ts';

describe('renderChoices', () => {
  it('renders an already tracked ticket with assignee', () => {
    const r = renderChoices({
      kind: 'tracked',
      captureId: 'c',
      issueKey: 'WEB-830',
      summary: 's',
      status: 'open',
      assignee: 'Dana',
      url: 'u',
    });
    expect(r.lines).toEqual(['Already tracked as WEB-830 (open, assigned to Dana). Open it?']);
    expect(r.choices.map((c) => [c.number, c.id])).toEqual([
      [1, 'open'],
      [2, 'dismiss'],
    ]);
    expect(r.done).toBe(false);
  });

  it('renders a tracked ticket without an assignee', () => {
    const r = renderChoices({ kind: 'tracked', captureId: 'c', issueKey: 'WEB-1', summary: 's', status: 'open', url: 'u' });
    expect(r.lines).toEqual(['Already tracked as WEB-1 (open). Open it?']);
  });

  it('renders a new inferred surface with evidence', () => {
    const r = renderChoices({
      kind: 'new',
      captureId: 'c',
      surface: { id: 'web', label: 'the website' },
      evidence: 'src/cart/...',
      choices: [
        { id: 'file', label: 'File it' },
        { id: 'other', label: 'Pick another surface' },
      ],
    });
    expect(r.lines).toEqual(['New. Looks like the website (from src/cart/...). File it?']);
    expect(r.choices).toEqual([
      { number: 1, id: 'file', label: 'File it' },
      { number: 2, id: 'other', label: 'Pick another surface' },
    ]);
  });

  it('renders a new inferred surface without evidence', () => {
    const r = renderChoices({ kind: 'new', captureId: 'c', surface: { id: 'web', label: 'the website' }, choices: [] });
    expect(r.lines).toEqual(['New. Looks like the website. File it?']);
    expect(r.choices).toEqual([]);
  });

  it('renders which surface with numbered surfaces', () => {
    const r = renderChoices({
      kind: 'which-surface',
      captureId: 'c',
      choices: [
        { id: 'web', label: 'Website' },
        { id: 'api', label: 'API' },
      ],
    });
    expect(r.lines).toEqual(['New. Which surface?']);
    expect(formatRendered(r)).toBe('New. Which surface?\n1. Website\n2. API');
  });

  it('renders a fix preview with the choices the server offers', () => {
    const r = renderChoices({
      kind: 'fix-preview',
      captureId: 'c',
      summary: 'Cart total is blank',
      choices: [
        { id: 'approve_fix', label: 'Fix it' },
        { id: 'ticket_only', label: 'Ticket only' },
      ],
    });
    expect(formatRendered(r)).toBe('Ready to file: Cart total is blank\n1. Fix it\n2. Ticket only');
    expect(r.done).toBe(false);
  });

  it('renders final and pending responses without choices', () => {
    expect(renderChoices({ kind: 'filed', captureId: 'c', issueKey: 'WEB-2', url: 'http://x/WEB-2' })).toEqual({
      lines: ['Filed as WEB-2.', 'http://x/WEB-2'],
      choices: [],
      done: true,
    });
    expect(renderChoices({ kind: 'not-filed', captureId: 'c', reason: 'Duplicate.' })).toEqual({
      lines: ['Not filed. Duplicate.'],
      choices: [],
      done: true,
    });
    expect(renderChoices({ kind: 'pending', captureId: 'c' })).toEqual({
      lines: ['Working on it.'],
      choices: [],
      done: false,
    });
  });
});
