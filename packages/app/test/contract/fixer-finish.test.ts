// The local runner's result reaches the fixer reporter (#308): a `done` the hand-off cannot complete
// ends the run as failed with a reason, so the incident leaves `fixing`. The reporter is the real one,
// over the in-memory state, with a fake hand-off and pull request check.

import { beforeEach, describe, expect, it } from 'vitest';
import type { FixerDoneResult } from '../../src/fixer-api/reporter.ts';
import { finishLocalRun } from '../../src/server/compose.ts';

const target = { workItemId: 'INC1', incidentId: 'INC1' };
const done = { outcome: 'done' as const, branch: 'fix/WEB-1042', summary: 'Guard the null cart total', testsAdded: ['test/cart.test.ts'] };

let failures: unknown[];
let doneCalls: number;

function reporter(answer: () => Promise<FixerDoneResult>) {
  return {
    done: async () => {
      doneCalls++;
      return answer();
    },
    failed: async (_t: unknown, input: unknown) => {
      failures.push(input);
      return { ok: true as const, seq: 1 };
    },
  } as unknown as Parameters<typeof finishLocalRun>[0];
}

beforeEach(() => {
  failures = [];
  doneCalls = 0;
});

describe('finishLocalRun (#308)', () => {
  it('records nothing more when done is accepted', async () => {
    await finishLocalRun(reporter(async () => ({ ok: true, seq: 5, runId: 'R' })), target, done);
    expect(doneCalls).toBe(1);
    expect(failures).toEqual([]);
  });

  it('ends the run as failed with the first line of the error when the GitHub call at the pull request step throws', async () => {
    const r = reporter(async () => {
      throw new Error('GitHub 422: not all refs are readable\nrequest id 1');
    });
    await finishLocalRun(r, target, done);
    expect(failures).toEqual([{ reason: 'the hand-off could not open the pull request: GitHub 422: not all refs are readable', attempts: 1 }]);
  });

  it('ends the run as failed when the hand-off reports a failure', async () => {
    await finishLocalRun(reporter(async () => ({ ok: false, code: 'handoff-failed', reason: 'the hand-off could not open the pull request: boom' })), target, done);
    expect(failures).toEqual([{ reason: 'the hand-off could not open the pull request: boom', attempts: 1 }]);
  });

  it('ends the run as failed on pr-mismatch', async () => {
    await finishLocalRun(reporter(async () => ({ ok: false, code: 'pr-mismatch' })), target, done);
    expect(failures).toEqual([{ reason: 'the pull request did not match the run', attempts: 1 }]);
  });

  it('keeps the refusal reason', async () => {
    await finishLocalRun(reporter(async () => ({ ok: false, code: 'handoff-refused', reason: 'CI files changed' })), target, done);
    expect(failures).toEqual([{ reason: 'handoff refused: CI files changed', attempts: 1 }]);
  });

  it('passes a failed result through and leaves a stopped one alone', async () => {
    const failed = { outcome: 'failed' as const, reason: 'tests red', attempts: 2 };
    await finishLocalRun(reporter(async () => ({ ok: true, seq: 1, runId: 'R' })), target, failed);
    await finishLocalRun(reporter(async () => ({ ok: true, seq: 1, runId: 'R' })), target, { outcome: 'stopped', atPhase: 'tested' });
    expect(failures).toEqual([failed]);
    expect(doneCalls).toBe(0);
  });
});
