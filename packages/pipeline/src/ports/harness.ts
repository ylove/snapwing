// src/ports/harness.ts (main 14.5, ADR 0003). The fixer (main 10) and the review agent (main 11.1)
// are coding agents behind this port. Checkpoint phases match the fixer reporting endpoints (B 9).
// Untrusted harness output is validated by src/harness/contract.ts; the generic adapter's process
// contract is docs/harness-generic.md.

/** The work item a harness run belongs to. Local to this port until the state contracts land. */
export interface WorkItemRef {
  id: string;
  issueKey: string;
  repo: string;
}

export interface HarnessPort {
  run(workItem: WorkItemRef, implementationRequest: string, workdir: string, opts: HarnessRunOptions): Promise<HarnessResult>;
}

export interface HarnessRunOptions {
  role: 'fixer' | 'review';
  /** `wallClock` is an ISO 8601 duration (default `PT30M`, main 10.4). */
  budget: { wallClock: string; attempts: number };
  onCheckpoint: (c: HarnessCheckpoint) => Promise<void>;
  signal: AbortSignal;
}

export type HarnessCheckpoint = { phase: 'cloned' | 'branched' | 'implemented' | 'tested' | 'pushed' | 'pr-opened'; detail?: string };

export type HarnessPhase = HarnessCheckpoint['phase'];

export type HarnessResult =
  | { outcome: 'done'; branch: string; prNumber?: number; summary: string; testsAdded: string[] }
  | { outcome: 'failed'; reason: string; partialBranch?: string; attempts: number }
  | { outcome: 'stopped'; atPhase: HarnessCheckpoint['phase'] };

export type HarnessOutcome = HarnessResult['outcome'];
