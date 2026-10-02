// The worker process (main 14.1, main 14.3): registers job modules on the WorkflowPort and polls.
// Phase 3 components are factories that return `JobModule`s; the composition root (compose.ts)
// collects them and hands them here. Durability, retries, parking, and timers are the workflow's
// (B 1, ADR 0012); this file only wires handlers and drives the poll loop.

import type { Job, JobName, WorkflowPort } from '@snapwing/pipeline/ports/workflow.ts';

export interface JobModule {
  readonly name: JobName;
  readonly handler: (job: Job) => Promise<void>;
  /** Handlers of this name running at once in this process; the workflow's default when absent. */
  readonly concurrency?: number;
}

/**
 * A WorkflowPort this process can drive: both implementations (`InProcessWorkflow`,
 * `PgBossWorkflow`) have these, outside the port because only the process owner calls them.
 */
export interface PollingWorkflow extends WorkflowPort {
  /** Recovers jobs a crashed process left behind, then starts delivering to registered handlers. */
  startPolling(): Promise<void>;
  /** Stops delivering and resolves once every handler in flight has finished. */
  stop(): Promise<void>;
}

export interface WorkerOptions {
  readonly workflow: PollingWorkflow;
  readonly jobs: readonly JobModule[];
}

export interface Worker {
  /** The job names this worker registered, in registration order. */
  readonly names: readonly JobName[];
  /** Stops polling and waits for the handlers in flight to finish. Idempotent. */
  stop(): Promise<void>;
}

export class DuplicateJobModuleError extends Error {
  constructor(readonly jobName: JobName) {
    super(`job ${jobName} has more than one module`);
    this.name = 'DuplicateJobModuleError';
  }
}

/** Registers every job module on the workflow, then starts polling. */
export async function createWorker(options: WorkerOptions): Promise<Worker> {
  const { workflow, jobs } = options;
  const names: JobName[] = [];
  for (const job of jobs) {
    if (names.includes(job.name)) {
      throw new DuplicateJobModuleError(job.name);
    }
    names.push(job.name);
  }
  for (const job of jobs) {
    workflow.work(job.name, job.handler, job.concurrency === undefined ? {} : { concurrency: job.concurrency });
  }
  await workflow.startPolling();
  let stopping: Promise<void> | undefined;
  return {
    names,
    stop() {
      stopping ??= workflow.stop();
      return stopping;
    },
  };
}
