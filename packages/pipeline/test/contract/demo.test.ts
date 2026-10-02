// `pnpm demo` (#48, main 14.3 reviewer demo mode, the phase 2 proof): runs the demo over the
// recordings in demo/levels/ on the dialect SNAPWING_DB selects, with an environment that holds no
// model or platform key, and checks each recording's final status and the Jira writes its outbox
// produced. The expectations are written out here, not read from the recordings, so a recording
// edited to match a regression still fails. Event type names are not asserted (#117 renames some).

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAP_FILE, runDemo, TIME_BUDGET_MS, type DemoIo, type DemoReport, type ScenarioResult } from '../../src/demo/run.ts';

const DIR = fileURLToPath(new URL('../../../../demo/levels', import.meta.url));

/** Only the database switch: no ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, JIRA_API_TOKEN, or GitHub App values. */
function keylessEnv(): Record<string, string | undefined> {
  return { SNAPWING_DB: process.env['SNAPWING_DB'], DATABASE_URL: process.env['DATABASE_URL'] };
}

async function run(dir: string): Promise<{ report: DemoReport; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: DemoIo = { env: keylessEnv(), stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const report = await runDemo(io, { dir });
  return { report, out: out.join('\n'), err: err.join('\n') };
}

let report: DemoReport;
let out: string;
let err: string;

beforeAll(async () => {
  ({ report, out, err } = await run(DIR));
}, 120_000);

function scenario(name: string): ScenarioResult {
  const found = report.scenarios.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no result for ${name}; ran ${report.scenarios.map((s) => s.name).join(', ')}`);
  return found;
}

describe('pnpm demo', () => {
  it('runs every recording as expected, keyless, inside the mocks, in under a minute', () => {
    expect(err).toBe('');
    expect(report.code).toBe(0);
    expect(report.unhandled).toEqual([]);
    expect(report.elapsedMs).toBeLessThan(TIME_BUDGET_MS);
    expect(report.scenarios.map((s) => s.name)).toEqual([
      '01-level-0-ticket-only',
      '02-level-1-fix-on-tap',
      '03-level-2-fix-now',
      '04-level-3-autopilot',
      '05-resolution-signal',
      '06-dedupe-linked',
    ]);
    for (const s of report.scenarios) {
      expect(s.problems, s.name).toEqual([]);
      expect(s.pending, s.name).toBe(0);
    }
  });

  it('level 0: files ticket only, with no transition', () => {
    expect(scenario('01-level-0-ticket-only')).toMatchObject({
      status: 'filed',
      level: 0,
      outbox: [{ op: 'create-issue', issueKey: 'HELP-1', autonomyLevel: 0 }],
      jira: [{ key: 'HELP-1', status: 'To Do' }],
      cards: ['scope-preview'],
    });
  });

  it('level 1: files after the owner taps Fix it, then moves the issue to In Progress', () => {
    expect(scenario('02-level-1-fix-on-tap')).toMatchObject({
      status: 'filed',
      level: 1,
      outbox: [
        { op: 'create-issue', issueKey: 'ADM-1', autonomyLevel: 1 },
        { op: 'transition', issueKey: 'ADM-1', to: 'In Progress' },
      ],
      jira: [{ key: 'ADM-1', status: 'In Progress' }],
      cards: ['scope-preview', 'fix-preview'],
    });
  });

  it('level 2: asks back once, files, and starts the fixer with an informational preview', () => {
    expect(scenario('03-level-2-fix-now')).toMatchObject({
      status: 'filed',
      level: 2,
      outbox: [
        { op: 'create-issue', issueKey: 'WEB-1', autonomyLevel: 2 },
        { op: 'transition', issueKey: 'WEB-1', to: 'In Progress' },
      ],
      jira: [{ key: 'WEB-1', status: 'In Progress' }],
      cards: ['scope-preview', 'clarify', 'fix-preview'],
    });
  });

  it('level 3: files and starts the fixer', () => {
    expect(scenario('04-level-3-autopilot')).toMatchObject({
      status: 'filed',
      level: 3,
      outbox: [
        { op: 'create-issue', issueKey: 'APP-1', autonomyLevel: 3 },
        { op: 'transition', issueKey: 'APP-1', to: 'In Progress' },
      ],
      jira: [{ key: 'APP-1', status: 'In Progress' }],
      cards: ['scope-preview', 'fix-preview'],
    });
  });

  it('resolution signal: stops as not filed with no card and no Jira write', () => {
    const s = scenario('05-resolution-signal');
    expect(s).toMatchObject({ status: 'not-filed', outbox: [], jira: [], cards: [] });
    expect(s.level).toBeUndefined();
  });

  it('dedupe: links to the open issue with a comment and creates nothing', () => {
    const s = scenario('06-dedupe-linked');
    expect(s).toMatchObject({
      status: 'linked-to-existing',
      outbox: [{ op: 'add-comment', issueKey: 'WEB-41' }],
      jira: [{ key: 'WEB-41', status: 'To Do', comments: 1 }],
      cards: ['scope-preview', 'dedupe'],
    });
    expect(s.level).toBeUndefined();
  });

  it('prints a readable trace: the channel, the cards, the taps, the Jira calls, and a verdict per recording', () => {
    expect(out).toContain(`pnpm demo on ${report.dialect ?? 'sqlite'}`);
    expect(out).toMatch(/> #help-bugs 09:00 @supportLead: The refund policy article/);
    expect(out).toMatch(/slack {3}chat\.postMessage #admin-bugs card fix-preview: Fix preview, level 1: "CSV usage export/);
    expect(out).toMatch(/tap {5}@adminDev taps approve_fix on fix-preview/);
    expect(out).toMatch(/jira {4}POST \/issue\/APP-1\/transitions To Do -> In Progress/);
    expect(out).toMatch(/github {2}GET \/search\/code "checkout" in acme\/web: 1 hit/);
    expect(out.match(/^ {2}result {2}.*; as expected \(/gm)).toHaveLength(6);
    expect(out).toContain('6 of 6 recordings as expected, 0 requests outside the mocks');
  });
});

describe('pnpm demo failure', () => {
  it('exits 1 and says why when a recording ends somewhere it did not expect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snapwing-demo-levels-'));
    try {
      await copyFile(join(DIR, MAP_FILE), join(dir, MAP_FILE));
      const file = '01-level-0-ticket-only.json';
      const recording = JSON.parse(await readFile(join(DIR, file), 'utf8')) as { expect: { status: string } };
      recording.expect.status = 'linked-to-existing';
      await writeFile(join(dir, file), JSON.stringify(recording));
      const { report: failed, out: text } = await run(dir);
      expect(failed.code).toBe(1);
      expect(failed.scenarios[0]?.problems).toEqual(['status filed, expected linked-to-existing']);
      expect(text).toContain('MISMATCH: status filed, expected linked-to-existing');
      expect(text).toContain('0 of 1 recordings as expected');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
