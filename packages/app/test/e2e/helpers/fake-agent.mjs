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

// The multi-repo fixtures (public #333): `@fixture/shared-ui` gains a currency on `formatPrice`, and
// `@fixture/web` bumps its shared-ui pin to the producer commit its request names and passes the cart's
// currency. The commit is read from the request: an attribute `producer-commit`, `producerCommit` or
// `producer` holding a 40 hex commit, else a `<producer>` element holding one, else the last 40 hex
// commit in the request.
const SHARED_UI_PRICE = [
  "const SYMBOLS = { USD: '$', EUR: '\\u20ac', GBP: '\\u00a3' };",
  '',
  '/** A price in integer cents as text in `currency` (default USD), for example `\\u20ac18.00`. */',
  "export function formatPrice(cents, currency = 'USD') {",
  '  return `${SYMBOLS[currency] ?? `${currency} `}${(cents / 100).toFixed(2)}`;',
  '}',
  '',
].join('\n');

function producerCommit() {
  const sha = '([0-9a-f]{40})';
  const found =
    new RegExp(`producer(?:-commit|Commit)?\\s*=\\s*"${sha}"`).exec(request) ??
    new RegExp(`<producer\\b[^>]*>[^<]*?${sha}`).exec(request) ??
    [...request.matchAll(/\b[0-9a-f]{40}\b/g)].at(-1);
  return found === undefined ? undefined : (found[1] ?? found[0]);
}

function packageName() {
  try {
    return JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf8')).name;
  } catch {
    return undefined;
  }
}

function commitAll(files, message, summary) {
  git(['add', ...files]);
  git(['commit', '--quiet', '-m', `${key}: ${message}`]);
  finish({ outcome: 'done', branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), summary: `[snapwing-test] Scripted e2e fixer for ${key}: ${summary}`, testsAdded: [] });
}

function fixSharedUi() {
  checkpoint('branched', git(['rev-parse', '--abbrev-ref', 'HEAD']));
  const file = join(workdir, 'src/price.mjs');
  if (!readFileSync(file, 'utf8').includes('Seeded gap')) return finish({ outcome: 'failed', reason: 'the seeded gap is not where the fixture README says', attempts: 1 });
  writeFileSync(file, SHARED_UI_PRICE);
  const tests = join(workdir, 'test/price.check.mjs');
  writeFileSync(tests, `${readFileSync(tests, 'utf8')}\ntest('formats a euro price with the euro sign', () => {\n  assert.equal(formatPrice(1800, 'EUR'), '\\u20ac18.00');\n});\n`);
  checkpoint('implemented', 'src/price.mjs');
  checkpoint('tested', 'test/price.check.mjs covers it (not run by the scripted agent)');
  commitAll(['src/price.mjs', 'test/price.check.mjs'], 'formatPrice takes a currency', 'formatPrice now takes a currency.');
}

function fixWeb() {
  checkpoint('branched', git(['rev-parse', '--abbrev-ref', 'HEAD']));
  const commit = producerCommit();
  if (commit === undefined) return finish({ outcome: 'failed', reason: 'the request names no producer commit to pin shared-ui to', attempts: 0 });
  const pkgFile = join(workdir, 'package.json');
  const pkg = readFileSync(pkgFile, 'utf8');
  const pinned = pkg.replace(/(@fixture\/shared-ui"\s*:\s*"git\+file:\/\/[^"#]+#)[0-9a-f]{40}/, `$1${commit}`);
  const file = join(workdir, 'src/storefront.mjs');
  const before = readFileSync(file, 'utf8');
  const after = before.replace(/\n\/\/ Seeded bug:[^\n]*\n/, '\n').replace('formatPrice(cents)', 'formatPrice(cents, cart.currency)');
  if (pinned === pkg || after === before) return finish({ outcome: 'failed', reason: 'the seeded bug is not where the fixture README says', attempts: 1 });
  writeFileSync(pkgFile, pinned);
  writeFileSync(file, after);
  const tests = join(workdir, 'test/cart.check.mjs');
  writeFileSync(tests, `${readFileSync(tests, 'utf8')}\ntest('shows a euro cart with the euro sign', () => {\n  const eur = { ...usd, currency: 'EUR' };\n  assert.equal(priceLabel(eur, 1800), '\\u20ac18.00');\n  assert.equal(totalLabel(eur), 'Total \\u20ac20.00');\n});\n`);
  checkpoint('implemented', `package.json pins shared-ui at ${commit.slice(0, 7)}; src/storefront.mjs passes the currency`);
  checkpoint('tested', 'test/cart.check.mjs covers it (not run by the scripted agent)');
  commitAll(['package.json', 'src/storefront.mjs', 'test/cart.check.mjs'], 'show prices in the cart currency', 'web pins the shared-ui commit that takes a currency and passes the cart currency.');
}

async function fix() {
  if (!request.includes('<implementation-request')) return finish({ outcome: 'failed', reason: 'stdin held no implementation request', attempts: 0 });
  const name = packageName();
  if (name === '@fixture/shared-ui') return fixSharedUi();
  if (name === '@fixture/web') return fixWeb();
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
