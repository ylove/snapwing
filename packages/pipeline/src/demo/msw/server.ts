// DEMO ONLY (`pnpm demo`). One MSW server for the three mocked platforms. Any request that matches
// none of their handlers is refused and recorded, so the demo can prove it never left the process.

import { EventEmitter } from 'node:events';
import { http, HttpResponse } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';
import { GitHubWorld, githubHandlers } from './github.ts';
import { JiraWorld, jiraHandlers } from './jira.ts';
import { SlackWorld, slackHandlers, type TraceSink } from './slack.ts';

export interface DemoServer {
  readonly slack: SlackWorld;
  readonly jira: JiraWorld;
  readonly github: GitHubWorld;
  /** Requests no handler matched (each was answered with a network error). */
  readonly unhandled: string[];
  close(): void;
}

/**
 * MSW 3 answers each request by claiming the pooled mock TLS socket, adding a listener per request
 * that keep-alive reuse never removes; past ten, Node warns of a leak that is not ours. The demo
 * makes a few dozen requests per host, so the cap is raised while the server runs.
 */
const MAX_SOCKET_LISTENERS = 200;

export function startDemoServer(trace: TraceSink): DemoServer {
  const previousMax = EventEmitter.defaultMaxListeners;
  EventEmitter.defaultMaxListeners = Math.max(previousMax, MAX_SOCKET_LISTENERS);
  const slack = new SlackWorld(trace);
  const jira = new JiraWorld(trace);
  const github = new GitHubWorld(trace);
  const unhandled: string[] = [];
  const server: SetupServer = setupServer(
    ...slackHandlers(slack),
    ...jiraHandlers(jira),
    ...githubHandlers(github),
    http.all('*', ({ request }) => {
      unhandled.push(`${request.method} ${request.url}`);
      return HttpResponse.error();
    }),
  );
  server.listen();
  return {
    slack,
    jira,
    github,
    unhandled,
    close: () => {
      server.close();
      EventEmitter.defaultMaxListeners = previousMax;
    },
  };
}
