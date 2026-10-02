// Adapts the client to the pipeline's JiraSearch (pipeline/src/dedupe/index.ts).

import type { JiraSearch, JiraSearchHit } from '@snapwing/pipeline/dedupe/index.ts';
import type { JiraClient } from './client.ts';

const PAGE_SIZE = 100;

export function jiraSearch(client: JiraClient): JiraSearch {
  return {
    async search(jql, limit) {
      const hits: JiraSearchHit[] = [];
      let token: string | undefined;
      while (hits.length < limit) {
        const page = await client.searchJql(jql, {
          maxResults: Math.min(PAGE_SIZE, limit - hits.length),
          fields: ['summary', 'assignee'],
          ...(token ? { nextPageToken: token } : {}),
        });
        for (const issue of page.issues) {
          const summary = issue.fields.summary;
          const assignee = issue.fields.assignee as { displayName?: string; accountId?: string } | null | undefined;
          const name = assignee?.displayName ?? assignee?.accountId;
          hits.push({ key: issue.key, summary: typeof summary === 'string' ? summary : '', ...(name ? { assignee: name } : {}) });
          if (hits.length >= limit) break;
        }
        if (page.isLast !== false || !page.nextPageToken) break;
        token = page.nextPageToken;
      }
      return hits;
    },
  };
}
