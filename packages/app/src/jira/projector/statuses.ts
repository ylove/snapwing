// Logical lifecycle targets to the project's own statuses (main 9.1, B 7.2). A `transition` row
// names `backlog`, `in-progress`, `in-review`, or `done`; the projector reads each project's statuses
// once (`GET /project/{key}/statuses`, cached for the projector's life, a failed read is not cached)
// and resolves the target by status category plus the `<jira><status/></jira>` config override, with
// the rules in `@snapwing/pipeline/jira/statuses.ts`. A target that does not resolve is a
// `JiraStatusMappingError`, which the drain parks: the error names the project's statuses and the
// config line that fixes it. A project whose workflow changes is read again after a restart.

import {
  describeJiraStatuses,
  jiraStatusOverrideHint,
  resolveJiraStatus,
  type JiraLogicalStatus,
  type JiraProjectStatus,
  type JiraStatusOverrides,
} from '@snapwing/pipeline/jira/statuses.ts';
import type { JiraClient } from '../client/index.ts';

/** A logical target the project has no status for. Retrying never helps, so the drain parks the row. */
export class JiraStatusMappingError extends Error {
  readonly projectKey: string;
  readonly target: JiraLogicalStatus;
  readonly statuses: readonly JiraProjectStatus[];

  constructor(issueKey: string, projectKey: string, target: JiraLogicalStatus, problem: string, statuses: readonly JiraProjectStatus[]) {
    super(
      `cannot move ${issueKey} to ${target}: in project ${projectKey}, ${problem}; its statuses: ${describeJiraStatuses(statuses)}; name one with ${jiraStatusOverrideHint(target)}`,
    );
    this.name = 'JiraStatusMappingError';
    this.projectKey = projectKey;
    this.target = target;
    this.statuses = statuses;
  }
}

export interface StatusResolver {
  /** The status name to transition `issueKey` to for `target`. Rejects with `JiraStatusMappingError`. */
  resolve(issueKey: string, target: JiraLogicalStatus): Promise<string>;
}

/** The project key of an issue key (`WEB` of `WEB-12`). */
export function projectKeyOf(issueKey: string): string {
  const dash = issueKey.lastIndexOf('-');
  return dash <= 0 ? issueKey : issueKey.slice(0, dash);
}

export function createStatusResolver(client: Pick<JiraClient, 'projectStatuses'>, overrides: JiraStatusOverrides = {}): StatusResolver {
  const cache = new Map<string, Promise<JiraProjectStatus[]>>();

  function statusesOf(projectKey: string): Promise<JiraProjectStatus[]> {
    let pending = cache.get(projectKey);
    if (pending === undefined) {
      pending = client.projectStatuses(projectKey);
      cache.set(projectKey, pending);
      // A failed read (a 429, the network) is tried again on the next row.
      pending.catch(() => {
        if (cache.get(projectKey) === pending) cache.delete(projectKey);
      });
    }
    return pending;
  }

  return {
    async resolve(issueKey, target) {
      const projectKey = projectKeyOf(issueKey);
      const statuses = await statusesOf(projectKey);
      const resolved = resolveJiraStatus(target, statuses, overrides);
      if (!resolved.ok) throw new JiraStatusMappingError(issueKey, projectKey, target, resolved.problem, statuses);
      return resolved.name;
    },
  };
}
