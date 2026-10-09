/* global process, setTimeout, setInterval */
// A fake coding agent behind the generic harness contract (docs/harness-generic.md), for the end to
// end contract test. The real generic adapter starts it with the request on stdin; it reports
// checkpoints as JSON lines on stderr and its result as one JSON object on stdout, which the local
// runner hands to the fixer API (B 9). It never talks to Snapwing or its database, and it holds no
// GitHub credential: it commits on the work branch and stops there; the runner bundles the branch and
// the server pushes it and opens the pull request (#262).
//
//   node fake-harness.mjs <world dir>
//
// The world dir holds `plans/<issue key>.json`, written by the test:
//   { "summary": "...", "files": { "<path>": "<content>" }, "test": "<test file path>",
//     "hangAfterCommit": false, "reviewGate": true, "probes": ["<string>"] }
// and gets `seen/<issue key>-<role>.json`: the environment the agent was handed and, for each probe,
// the files under its working directory that contain it (the test probes with the GitHub token).
//
// SNAPWING_ROLE=fixer: commits the plan's files on the checkout's work branch and reports `done`. With
// `hangAfterCommit` it stops there and waits: a Stop reaches it as SIGTERM, and it answers with a
// `stopped` result at the last phase it reached.
// SNAPWING_ROLE=review: with `reviewGate`, waits for `gates/review-<key>`; then writes an `approve`
// verdict to SNAPWING_REVIEW_FILE when the diff it was given touches every planned file, else
// `request-changes`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const world = process.argv[2] ?? '';
const role = process.env.SNAPWING_ROLE ?? '';
const key = process.env.SNAPWING_ISSUE_KEY ?? '';
const workdir = process.env.SNAPWING_WORKDIR ?? process.cwd();
const plan = JSON.parse(readFileSync(join(world, 'plans', `${key}.json`), 'utf8'));
const request = readFileSync(0, 'utf8');
let phase = 'cloned';

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

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st?.isDirectory()) out.push(...filesUnder(path));
    else if (st?.isFile()) out.push(path);
  }
  return out;
}

/** What this run was handed: its environment, and which of its files hold any probe string. */
function record() {
  const probes = Array.isArray(plan.probes) ? plan.probes.filter((p) => typeof p === 'string' && p !== '') : [];
  const files = filesUnder(workdir);
  const holding = Object.fromEntries(probes.map((p) => [p, files.filter((f) => readFileSync(f).includes(p)).map((f) => relative(workdir, f))]));
  mkdirSync(join(world, 'seen'), { recursive: true });
  writeFileSync(join(world, 'seen', `${key}-${role}.json`), JSON.stringify({ env: { ...process.env }, workdir, holding }));
}

async function waitFor(file) {
  for (let i = 0; i < 1500 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
}

process.on('SIGTERM', () => finish({ outcome: 'stopped', atPhase: phase }));
record();

if (role === 'review') {
  if (plan.reviewGate === true) await waitFor(join(world, 'gates', `review-${key}`));
  const missing = Object.keys(plan.files).filter((path) => !request.includes(`b/${path}`));
  const verdict =
    missing.length === 0
      ? { verdict: 'approve', reasons: ['The diff fixes the reported behavior and adds a regression test.'], constraintViolations: [], regressionTest: { path: plan.test } }
      : { verdict: 'request-changes', reasons: [`The diff does not touch ${missing.join(', ')}.`], constraintViolations: [] };
  writeFileSync(process.env.SNAPWING_REVIEW_FILE ?? '', JSON.stringify(verdict));
  finish({ outcome: 'done', branch: 'review', summary: verdict.verdict, testsAdded: [] });
} else {
  if (!request.includes('<implementation-request')) {
    finish({ outcome: 'failed', reason: 'stdin held no implementation request', attempts: 0 });
  } else {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    checkpoint('branched', branch);
    for (const [path, body] of Object.entries(plan.files)) {
      mkdirSync(dirname(join(workdir, path)), { recursive: true });
      writeFileSync(join(workdir, path), body);
    }
    checkpoint('implemented');
    checkpoint('tested', `1 added (${plan.test})`);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', `${key}: ${plan.summary}`]);
    if (plan.hangAfterCommit === true) {
      setInterval(() => undefined, 1000);
    } else {
      finish({ outcome: 'done', branch, summary: plan.summary, testsAdded: [plan.test] });
    }
  }
}
