/* global process, setTimeout */
// A scripted coding agent behind the generic harness contract (docs/harness-generic.md) for the e2e
// tier where the `claude` CLI is not on PATH (CI). It does on the real fixture repository what a fixer
// does: fix the seeded bug and commit it on the work branch. It holds no GitHub credential and never
// pushes: the runner bundles the branch, and the server pushes it and opens the real pull request into
// the request's base (#262). It never talks to Snapwing or its database; checkpoints go to stderr and
// the result to stdout.
//
//   node fake-agent.mjs <world dir> <review wait seconds>
//
// SNAPWING_ROLE=fixer: the fix is the one the fixture's README names (`applyDiscount` divides the
// percent by 1000 instead of 100). One world file changes what it does, for the A 8 rows
// (companion-a.test.ts):
//   `<world dir>/regression-test`  when the request requires tests (`<tests required="true">`), also
//                                  adds `test/discount.regression.test.ts` (node:test, no dependencies),
//                                  which fails without the fix and passes with it, so the review's
//                                  regression proof (SNAPWING_TEST_COMMAND) can prove the fix. A request
//                                  that requires none gets no test file (it would be out of scope).
// The pull request's base is the request's `handoff/@base` (else the repository's default branch), as
// the server opens it; the agent no longer chooses it.
// SNAPWING_ROLE=review (also used with the claude-code fixer, to keep live model calls to the fixer):
// waits for `<world dir>/release-review` (the test writes it in teardown, so the status message stays
// on the PR row while the test reads it) or the wait, then writes an `approve` verdict.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const world = process.argv[2] ?? '';
const reviewWaitMs = Number(process.argv[3] ?? '600') * 1000;
const role = process.env.SNAPWING_ROLE ?? '';
const key = process.env.SNAPWING_ISSUE_KEY ?? '';
const workdir = process.env.SNAPWING_WORKDIR ?? process.cwd();
const request = readFileSync(0, 'utf8');
let phase = 'cloned';

const REGRESSION_TEST = 'test/discount.regression.test.ts';
const REGRESSION_TEST_SOURCE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/cart.ts';

test('a 10 percent coupon takes 2.00 off a 20.00 cart', () => {
  assert.equal(applyDiscount(2000, 10), 1800);
});
`;

function checkpoint(name, detail) {
  phase = name;
  process.stderr.write(`${JSON.stringify(detail === undefined ? { phase: name } : { phase: name, detail })}\n`);
}

function finish(result) {
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

function git(args) {
  return execFileSync('git', args, { cwd: workdir, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

process.on('SIGTERM', () => finish({ outcome: 'stopped', atPhase: phase }));

async function review() {
  const gate = join(world, 'release-review');
  const deadline = Date.now() + reviewWaitMs;
  while (!existsSync(gate) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  const verdict = { verdict: 'approve', reasons: ['Scripted e2e reviewer: the diff fixes applyDiscount.'], constraintViolations: [] };
  writeFileSync(process.env.SNAPWING_REVIEW_FILE ?? '', JSON.stringify(verdict));
  finish({ outcome: 'done', branch: 'review', summary: 'approve', testsAdded: [] });
}

async function fix() {
  if (!request.includes('<implementation-request')) return finish({ outcome: 'failed', reason: 'stdin held no implementation request', attempts: 0 });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  checkpoint('branched', branch);
  const file = join(workdir, 'src/cart.ts');
  const before = readFileSync(file, 'utf8');
  const after = before
    .replace(/\n\s*\/\/ Seeded bug:[^\n]*/, '')
    .replace('percent / 1000', 'percent / 100');
  if (after === before) return finish({ outcome: 'failed', reason: 'the seeded bug is not where the fixture README says', attempts: 1 });
  writeFileSync(file, after);
  checkpoint('implemented', 'src/cart.ts');
  const withTest = existsSync(join(world, 'regression-test')) && /<tests\b[^>]*\brequired="true"/.test(request);
  if (withTest) {
    writeFileSync(join(workdir, REGRESSION_TEST), REGRESSION_TEST_SOURCE);
    checkpoint('tested', `${REGRESSION_TEST} fails without the fix (not run by the scripted agent)`);
  } else {
    checkpoint('tested', 'test/cart.test.ts covers it (not run by the scripted agent)');
  }
  git(['add', 'src/cart.ts', ...(withTest ? [REGRESSION_TEST] : [])]);
  git(['commit', '--quiet', '-m', `${key}: apply the discount percent as a percentage`]);
  finish({ outcome: 'done', branch, summary: `[snapwing-test] Scripted e2e fixer for ${key}: applyDiscount divided the percent by 1000; it now divides by 100.`, testsAdded: withTest ? [REGRESSION_TEST] : [] });
}

try {
  if (role === 'review') await review();
  else await fix();
} catch (e) {
  finish({ outcome: 'failed', reason: `scripted agent: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, attempts: 1 });
}
