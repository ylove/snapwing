// The composition root: the one place phase 3 components are built and wired (CONTEXT.md 3).
// `snapwing serve` calls `compose` once the config, secrets, state store, and workflow exist, mounts
// the routes on the API process and registers the job modules on the worker.
//
// This is the skeleton (#125): it returns nothing, so `serve` runs only `/healthz` and `/metrics`.
// #159 fills it with the Slack transport, the Jira and GitHub webhooks, the fixer API, the
// projectors, and the pipeline jobs.

import type { AppConfig } from '@snapwing/pipeline/config/app-config.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import type { WorkflowPort } from '@snapwing/pipeline/ports/workflow.ts';
import type { Route } from './http.ts';
import type { JobModule } from './worker.ts';

export interface ComposeDeps {
  readonly config: AppConfig;
  readonly secrets: SecretsPort;
  readonly state: OpenedState;
  readonly workflow: WorkflowPort;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Composed {
  readonly routes: readonly Route[];
  readonly jobs: readonly JobModule[];
}

export type ComposeFn = (deps: ComposeDeps) => Promise<Composed>;

export const compose: ComposeFn = async () => ({ routes: [], jobs: [] });
