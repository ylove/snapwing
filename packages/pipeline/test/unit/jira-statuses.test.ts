// Logical Jira lifecycle targets resolve to a project's statuses by category, with config overrides.

import { describe, expect, it } from 'vitest';
import {
  describeJiraStatusMapping,
  resolveJiraStatus,
  resolveJiraStatuses,
  toJiraLogicalStatus,
  type JiraProjectStatus,
} from '../../src/jira/statuses.ts';

/** Jira Cloud's default Scrum workflow, company-managed or team-managed (as the owner's site answers). */
const SCRUM: JiraProjectStatus[] = [
  { name: 'To Do', category: 'new' },
  { name: 'In Progress', category: 'indeterminate' },
  { name: 'In Review', category: 'indeterminate' },
  { name: 'Done', category: 'done' },
];
/** The classic software workflow. */
const CLASSIC: JiraProjectStatus[] = [
  { name: 'Backlog', category: 'new' },
  { name: 'Selected for Development', category: 'new' },
  { name: 'In Progress', category: 'indeterminate' },
  { name: 'Done', category: 'done' },
];

describe('resolveJiraStatuses', () => {
  it('maps a default Scrum project by category', () => {
    const mapping = resolveJiraStatuses(SCRUM);
    expect(mapping.problems).toEqual([]);
    expect(describeJiraStatusMapping(mapping)).toBe('backlog -> To Do, in-progress -> In Progress, in-review -> In Review, done -> Done');
  });

  it('prefers Backlog among new statuses and keeps a project without In Review in progress', () => {
    const mapping = resolveJiraStatuses(CLASSIC);
    expect(mapping.problems).toEqual([]);
    expect(describeJiraStatusMapping(mapping)).toBe(
      'backlog -> Backlog, in-progress -> In Progress, in-review -> In Progress (no In Review status), done -> Done',
    );
  });

  it('falls back to the first status of the category, never the review column for in-progress', () => {
    const custom: JiraProjectStatus[] = [
      { name: 'Open', category: 'new' },
      { name: 'In Review', category: 'indeterminate' },
      { name: 'Doing', category: 'indeterminate' },
      { name: 'Closed', category: 'done' },
      { name: 'Done', category: 'done' },
    ];
    expect(resolveJiraStatus('backlog', custom)).toEqual({ ok: true, name: 'Open', via: 'category' });
    expect(resolveJiraStatus('in-progress', custom)).toEqual({ ok: true, name: 'Doing', via: 'category' });
    expect(resolveJiraStatus('done', custom)).toEqual({ ok: true, name: 'Done', via: 'category' });
  });

  it('takes a config override by name, case-insensitively, and refuses one the project lacks', () => {
    expect(resolveJiraStatus('backlog', CLASSIC, { backlog: 'selected for development' })).toEqual({ ok: true, name: 'Selected for Development', via: 'override' });
    expect(resolveJiraStatus('in-review', SCRUM, { 'in-review': 'Code Review' })).toEqual({
      ok: false,
      problem: 'the config names status "Code Review" for in-review, which the project does not have',
    });
    expect(describeJiraStatusMapping(resolveJiraStatuses(CLASSIC, { done: 'Done' }))).toContain('done -> Done (from config)');
  });

  it('names the missing category when a target cannot resolve', () => {
    const mapping = resolveJiraStatuses([{ name: 'Open', category: 'new' }]);
    expect(mapping.problems).toEqual([
      'no status in category indeterminate for in-progress',
      'no In Review status, and no status in category indeterminate for in-progress',
      'no status in category done for done',
    ]);
    expect(describeJiraStatusMapping(mapping)).toBe('backlog -> Open');
  });
});

describe('toJiraLogicalStatus', () => {
  it('reads a logical target and the status names rows carried before logical targets', () => {
    expect(toJiraLogicalStatus('in-review')).toBe('in-review');
    expect(toJiraLogicalStatus('In Progress')).toBe('in-progress');
    expect(toJiraLogicalStatus(' Backlog ')).toBe('backlog');
    expect(toJiraLogicalStatus('To Do')).toBeUndefined();
    expect(toJiraLogicalStatus(3)).toBeUndefined();
  });
});
