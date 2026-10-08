// Logical Jira lifecycle targets (main 9.1, main 14.4, B 7.2). Outbox `transition` rows name one
// of four logical targets, never a status name: Jira Cloud's default workflows say To Do, In Progress,
// (In Review), Done, while older or customized ones say Backlog, Selected for Development, and so on.
// The Jira projector resolves a target against the project's own statuses (`GET /project/{key}/statuses`)
// by status category, and `pnpm jira:bootstrap` prints the same mapping. Pure functions only.
//
// Resolution, names compared without regard to case:
//   backlog      the override, else a `new` status named Backlog, else the first `new` status
//   in-progress  the override, else an `indeterminate` status named In Progress, else the first
//                `indeterminate` status not named In Review
//   in-review    the override, else a status named In Review, else whatever in-progress resolves to
//                (a project without a review column keeps the issue in progress)
//   done         the override, else a `done` status named Done, else the first `done` status
// An override (`<jira><status logical="..." name="..."/></jira>` in snapwing.config.xml) must name a
// status the project has. A target with no candidate is unresolvable; the error lists the statuses.

export const JIRA_LOGICAL_STATUSES = ['backlog', 'in-progress', 'in-review', 'done'] as const;
export type JiraLogicalStatus = (typeof JIRA_LOGICAL_STATUSES)[number];

/** Jira's status category keys (`statusCategory.key`). `undefined` is Jira's "no category". */
export type JiraStatusCategory = 'new' | 'indeterminate' | 'done' | 'undefined';

export interface JiraProjectStatus {
  name: string;
  category: JiraStatusCategory;
}

/** Status name per logical target, from config; absent targets resolve by category. */
export type JiraStatusOverrides = Readonly<Partial<Record<JiraLogicalStatus, string>>>;

export function isJiraLogicalStatus(v: unknown): v is JiraLogicalStatus {
  return typeof v === 'string' && (JIRA_LOGICAL_STATUSES as readonly string[]).includes(v);
}

/**
 * A logical target from a row's `to`: the target itself, or a status name that spells one (`In
 * Progress`, `backlog`), which rows written before logical targets carried. Undefined for anything else.
 */
export function toJiraLogicalStatus(v: unknown): JiraLogicalStatus | undefined {
  if (typeof v !== 'string') return undefined;
  const slug = v.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return isJiraLogicalStatus(slug) ? slug : undefined;
}

export type JiraStatusResolution =
  | { ok: true; name: string; via: 'override' | 'category' | 'fallback' }
  | { ok: false; problem: string };

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const PREFERRED: Readonly<Record<Exclude<JiraLogicalStatus, 'in-review'>, { category: JiraStatusCategory; name: string }>> = {
  backlog: { category: 'new', name: 'Backlog' },
  'in-progress': { category: 'indeterminate', name: 'In Progress' },
  done: { category: 'done', name: 'Done' },
};
const IN_REVIEW = 'In Review';

/** `To Do (new), In Progress (indeterminate), Done (done)`, for error lines. */
export function describeJiraStatuses(statuses: readonly JiraProjectStatus[]): string {
  return statuses.length === 0 ? '(none)' : statuses.map((s) => `${s.name} (${s.category})`).join(', ');
}

/** Resolves one logical target against a project's statuses (see the file header). */
export function resolveJiraStatus(target: JiraLogicalStatus, statuses: readonly JiraProjectStatus[], overrides: JiraStatusOverrides = {}): JiraStatusResolution {
  const override = overrides[target];
  if (override !== undefined && override.trim() !== '') {
    const hit = statuses.find((s) => same(s.name, override));
    return hit === undefined
      ? { ok: false, problem: `the config names status "${override}" for ${target}, which the project does not have` }
      : { ok: true, name: hit.name, via: 'override' };
  }
  if (target === 'in-review') {
    const hit = statuses.find((s) => same(s.name, IN_REVIEW));
    if (hit !== undefined) return { ok: true, name: hit.name, via: 'category' };
    const progress = resolveJiraStatus('in-progress', statuses, overrides);
    return progress.ok ? { ok: true, name: progress.name, via: 'fallback' } : { ok: false, problem: `no In Review status, and ${progress.problem}` };
  }
  const { category, name } = PREFERRED[target];
  const inCategory = statuses.filter((s) => s.category === category);
  // In progress never falls back to the review column.
  const review = [IN_REVIEW, overrides['in-review'] ?? IN_REVIEW];
  const fallback = target === 'in-progress' ? inCategory.find((s) => !review.some((r) => same(s.name, r))) : inCategory[0];
  const hit = inCategory.find((s) => same(s.name, name)) ?? fallback;
  return hit === undefined ? { ok: false, problem: `no status in category ${category} for ${target}` } : { ok: true, name: hit.name, via: 'category' };
}

export interface JiraStatusMapping {
  resolved: Partial<Record<JiraLogicalStatus, { name: string; via: 'override' | 'category' | 'fallback' }>>;
  /** One line per target that did not resolve. */
  problems: string[];
}

/** Every logical target at once (the bootstrap's workflow check). */
export function resolveJiraStatuses(statuses: readonly JiraProjectStatus[], overrides: JiraStatusOverrides = {}): JiraStatusMapping {
  const out: JiraStatusMapping = { resolved: {}, problems: [] };
  for (const target of JIRA_LOGICAL_STATUSES) {
    const r = resolveJiraStatus(target, statuses, overrides);
    if (r.ok) out.resolved[target] = { name: r.name, via: r.via };
    else out.problems.push(r.problem);
  }
  return out;
}

/** `backlog -> To Do, in-progress -> In Progress, in-review -> In Progress (no In Review status), done -> Done`. */
export function describeJiraStatusMapping(mapping: JiraStatusMapping): string {
  return JIRA_LOGICAL_STATUSES.flatMap((t) => {
    const r = mapping.resolved[t];
    if (r === undefined) return [];
    const note = r.via === 'override' ? ' (from config)' : r.via === 'fallback' ? ' (no In Review status)' : '';
    return [`${t} -> ${r.name}${note}`];
  }).join(', ');
}

/** The config line that names a status for a target, for error messages. */
export function jiraStatusOverrideHint(target: JiraLogicalStatus): string {
  return `<jira><status logical="${target}" name="..."/></jira> in snapwing.config.xml`;
}
