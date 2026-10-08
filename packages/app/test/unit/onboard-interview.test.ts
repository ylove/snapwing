import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { runOnboard, statusLines, EXIT_UNANSWERED, EXIT_WAITING } from '../../src/cli/onboard.ts';
import { COMMANDS } from '../../src/cli/main.ts';
import { scriptedPrompter, terminalPrompter, type Prompter } from '../../src/cli/prompt.ts';
import { upsertEnv, writeEnvFile } from '../../src/onboard/interview/env.ts';
import { InterviewAborted, SecretValue, type InterviewIO } from '../../src/onboard/interview/io.ts';
import { needMet, runInterview, validateRegistry, type RunInterviewOptions } from '../../src/onboard/interview/machine.ts';
import {
  createKvOnboardingStore,
  emptyState,
  ONBOARDING_STATE_KEY,
  OnboardingStateError,
  parseOnboardingState,
  type OnboardingStore,
} from '../../src/onboard/interview/state.ts';
import { notBuiltYet, type OnboardStep, type StepContext, type StepNeed, type StepOutcome } from '../../src/onboard/interview/step.ts';
import { createTerminalIO, parseAnswers } from '../../src/onboard/interview/terminal.ts';
import { ONBOARD_STEPS } from '../../src/onboard/steps/index.ts';
import { upsertEnv as scriptUpsertEnv } from '../../../../scripts/github-bootstrap.ts';

const SECRET = 'jira-token-not-real-0123456789';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-onboard-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An in-memory kv, the shape the state store's `kv` has. */
function memoryKv(): { kvGet(k: string): Promise<string | undefined>; kvSet(k: string, v: string): Promise<void>; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    kvGet: (k) => Promise.resolve(raw.get(k)),
    kvSet: (k, v) => {
      raw.set(k, v);
      return Promise.resolve();
    },
  };
}

function step(id: string, needs: readonly StepNeed[], run: (ctx: StepContext) => Promise<StepOutcome>): OnboardStep {
  return { id, title: `Step ${id}`, needs, run };
}

interface Harness {
  readonly lines: string[];
  readonly prompter: Prompter & { readonly asked: readonly string[] };
  readonly io: InterviewIO;
}

function terminal(answers: readonly string[]): Harness {
  const lines: string[] = [];
  const prompter = scriptedPrompter(answers);
  return { lines, prompter, io: createTerminalIO({ prompter, say: (line) => lines.push(line) }) };
}

function run(steps: readonly OnboardStep[], store: OnboardingStore, io: InterviewIO, extra: Partial<RunInterviewOptions> = {}): ReturnType<typeof runInterview> {
  let tick = 0;
  return runInterview({ steps, store, io, workdir: dir, now: () => new Date(Date.UTC(2026, 9, 3, 12, 0, tick++)), ...extra });
}

describe('the step registry', () => {
  it('orders the runtime first, then the interview with Slack and Teams as two modules, every need earlier', () => {
    expect(() => validateRegistry(ONBOARD_STEPS)).not.toThrow();
    expect(ONBOARD_STEPS.map((s) => s.id)).toEqual([
      'runtime',
      'slack',
      'teams',
      'jira',
      'github',
      'surfaces',
      'words',
      'people',
      'trigger',
      'autonomy',
      'finish',
      'test-drive',
    ]);
  });

  it('numbers each step by its place in the registry, the runtime 0, so no two share a number', () => {
    const numbers = statusLines(ONBOARD_STEPS, undefined).map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(numbers).toEqual(ONBOARD_STEPS.map((_, i) => i));
    expect(statusLines(ONBOARD_STEPS, undefined).filter((l) => /Choose how much|Write the workspace map/.test(l)).map((l) => l.trim().split(/\s+/)[0])).toEqual(['9', '10']);
  });

  it('runs every stub as "not built yet" and finishes, then runs them again next time', async () => {
    // The registry's own steps as stubs: built steps ask questions, which their own tests cover.
    const stubs = ONBOARD_STEPS.map(({ id, title, needs }) => notBuiltYet({ id, title, needs }));
    const kv = memoryKv();
    const store = createKvOnboardingStore(kv);
    const t = terminal([]);
    const result = await run(stubs, store, t.io);
    expect(result.outcome).toBe('complete');
    expect(result.ran).toEqual(stubs.map((s) => s.id));
    expect(Object.values(result.state.steps).every((r) => r.status === 'not-built')).toBe(true);
    expect(t.lines).toContain('Connect Jira: not built yet, skipping.');
    const again = await run(stubs, store, terminal([]).io);
    expect(again.ran).toEqual(stubs.map((s) => s.id));
  });

  it('refuses a need that is not an earlier step, and a duplicate id', () => {
    const done = (): Promise<StepOutcome> => Promise.resolve({ status: 'done' });
    expect(() => validateRegistry([step('a', ['b'], done), step('b', [], done)])).toThrow(/a needs b/);
    expect(() => validateRegistry([step('a', [], done), step('a', [], done)])).toThrow(/twice/);
    expect(() => validateRegistry([step('A', [], done)])).toThrow(/lowercase/);
  });

  it('meets a list need with one done step, or with every step skipped or not built', () => {
    const state = (statuses: Record<string, 'done' | 'skipped' | 'blocked' | 'not-built'>) => ({
      ...emptyState(new Date(0)),
      steps: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, attempts: 1 }])),
    });
    expect(needMet(['slack', 'teams'], state({ slack: 'blocked', teams: 'done' }))).toBe(true);
    expect(needMet(['slack', 'teams'], state({ slack: 'blocked', teams: 'skipped' }))).toBe(false);
    expect(needMet(['slack', 'teams'], state({ slack: 'not-built', teams: 'not-built' }))).toBe(true);
    expect(needMet('jira', state({}))).toBe(false);
  });
});

describe('resume', () => {
  it('resumes at an abandoned step without asking the finished ones again', async () => {
    const kv = memoryKv();
    const store = createKvOnboardingStore(kv);
    const steps = [
      step('a', [], async (ctx) => ({ status: 'done', data: { name: await ctx.io.ask({ id: 'name', text: 'Your name?' }) } })),
      step('b', ['a'], async (ctx) => {
        const colour = await ctx.io.ask({ id: 'colour', text: 'Colour?' });
        await ctx.progress({ colour });
        const size = await ctx.io.ask({ id: 'size', text: 'Size?' });
        return { status: 'done', data: { size } };
      }),
      step('c', ['b'], (ctx) => Promise.resolve({ status: 'done', data: { saw: ctx.data('b') ?? null } })),
    ];

    // First run: Ctrl-C (no answer) at b's second question.
    const first = await run(steps, store, terminal(['Ada', 'blue']).io);
    expect(first.outcome).toBe('aborted');
    expect(first.unanswered).toBe('b.size');
    expect(first.state.steps['a']).toMatchObject({ status: 'done', attempts: 1, via: 'terminal', data: { name: 'Ada' } });
    expect(first.state.steps['b']).toMatchObject({ status: 'running', attempts: 1, data: { colour: 'blue' } });
    expect(first.state.steps['c']).toBeUndefined();

    // Second run: a is not asked again; b starts over with its saved progress; c follows.
    const t = terminal(['green', 'L']);
    const second = await run(steps, store, t.io);
    expect(second.outcome).toBe('complete');
    expect(second.ran).toEqual(['b', 'c']);
    expect(t.prompter.asked).toEqual(['Colour? ', 'Size? ']);
    expect(t.lines).toContain('Picking up where you left off: Step b.');
    expect(second.state.steps['b']).toMatchObject({ status: 'done', attempts: 2, data: { colour: 'green', size: 'L' } });
    expect(second.state.steps['c']?.data).toEqual({ saw: { colour: 'green', size: 'L' } });
    expect(parseOnboardingState(kv.raw.get(ONBOARDING_STATE_KEY) ?? '')).toEqual(second.state);
  });

  it('stops at a step that throws, records why, and retries it next run', async () => {
    const store = createKvOnboardingStore(memoryKv());
    let fail = true;
    const steps = [
      step('a', [], () => (fail ? Promise.reject(new Error('Jira answered 503')) : Promise.resolve({ status: 'done' }))),
      step('b', [], () => Promise.resolve({ status: 'done' })),
    ];
    const first = await run(steps, store, terminal([]).io);
    expect(first.outcome).toBe('failed');
    expect(first.failure).toEqual({ step: 'a', message: 'Jira answered 503' });
    expect(first.state.steps['a']).toMatchObject({ status: 'failed', note: 'Jira answered 503' });
    expect(first.ran).toEqual(['a']);
    fail = false;
    const second = await run(steps, store, terminal([]).io);
    expect(second.outcome).toBe('complete');
    expect(second.state.steps['a']).toMatchObject({ status: 'done', attempts: 2 });
    expect(second.state.steps['a']?.note).toBeUndefined();
  });

  it('reruns one finished step with --step, and refuses one whose needs are not met', async () => {
    const store = createKvOnboardingStore(memoryKv());
    let runs = 0;
    const steps = [
      step('a', [], () => {
        runs += 1;
        return Promise.resolve({ status: 'done' });
      }),
      step('b', ['a'], () => Promise.resolve({ status: 'blocked', on: 'an admin', reason: 'approval' })),
      step('c', ['b'], () => Promise.resolve({ status: 'done' })),
    ];
    await run(steps, store, terminal([]).io);
    const rerun = await run(steps, store, terminal([]).io, { only: 'a' });
    expect(rerun.ran).toEqual(['a']);
    expect(runs).toBe(2);
    expect(rerun.state.steps['a']?.attempts).toBe(2);
    await expect(run(steps, store, terminal([]).io, { only: 'c' })).rejects.toThrow(/c needs b first/);
    await expect(run(steps, store, terminal([]).io, { only: 'nope' })).rejects.toThrow(/no onboarding step "nope"/);
  });

  it('refuses a state document written by a newer Snapwing', () => {
    expect(() => parseOnboardingState(JSON.stringify({ ...emptyState(new Date(0)), version: 2 }))).toThrow(OnboardingStateError);
  });
});

describe('blocked steps (ADR 0004)', () => {
  it('skips a step blocked on a person, carries on with what does not need it, and resumes it next run', async () => {
    const store = createKvOnboardingStore(memoryKv());
    let approved = false;
    const calls: string[] = [];
    const record = (id: string, outcome: StepOutcome) => (): Promise<StepOutcome> => {
      calls.push(id);
      return Promise.resolve(outcome);
    };
    const steps = [
      step('runtime', [], record('runtime', { status: 'done' })),
      step('slack', ['runtime'], () => {
        calls.push('slack');
        return Promise.resolve(
          approved
            ? { status: 'done', data: { team: 'T1' } }
            : { status: 'blocked', on: 'a Slack workspace admin', reason: 'the workspace requires approval to install apps.', link: 'https://slack.example/request' },
        );
      }),
      step('teams', ['runtime'], record('teams', { status: 'skipped', reason: 'not using Teams' })),
      step('jira', ['runtime'], record('jira', { status: 'done' })),
      step('trigger', [['slack', 'teams']], record('trigger', { status: 'done' })),
      step('words', ['jira'], record('words', { status: 'done' })),
    ];

    const t1 = terminal([]);
    const first = await run(steps, store, t1.io);
    expect(first.outcome).toBe('waiting');
    expect(first.ran).toEqual(['runtime', 'slack', 'teams', 'jira', 'words']);
    expect(first.waiting).toEqual([{ id: 'trigger', on: ['slack', 'teams'] }]);
    expect(first.state.steps['slack']).toMatchObject({
      status: 'blocked',
      blocked: { on: 'a Slack workspace admin', link: 'https://slack.example/request' },
    });
    expect(t1.lines).toContain('Step slack is waiting on a Slack workspace admin: the workspace requires approval to install apps.');
    expect(t1.lines).toContain('https://slack.example/request');

    approved = true;
    calls.length = 0;
    const second = await run(steps, store, terminal([]).io);
    expect(second.outcome).toBe('complete');
    expect(calls).toEqual(['slack', 'trigger']);
    expect(second.state.steps['slack']).toMatchObject({ status: 'done', attempts: 2, data: { team: 'T1' } });
    expect(second.state.steps['slack']?.blocked).toBeUndefined();
    expect(second.state.steps['teams']).toMatchObject({ status: 'skipped', note: 'not using Teams' });
  });
});

describe('secrets', () => {
  const secretStep = step('jira', [], async (ctx) => {
    const token = await ctx.io.secret({
      id: 'token',
      text: 'Paste a Jira API token:',
      why: 'Snapwing calls /rest/api/3/myself with it.',
      validate: (s) => (s.reveal().startsWith('jira-') ? undefined : 'Jira did not accept that token. Try again.'),
    });
    await ctx.writeEnv({ JIRA_API_TOKEN: token, JIRA_BASE_URL: 'https://example.atlassian.net' });
    // A careless step: the secret in its data, as the object and as text, and in a progress note.
    await ctx.progress({ token: token.toJSON(), echo: `token is ${token.reveal()}` });
    return { status: 'done', data: { site: 'https://example.atlassian.net', copy: token.reveal() } };
  });

  it('never echoes, logs, or stores hidden input; it goes only to .env, mode 0600', async () => {
    const kv = memoryKv();
    const store = createKvOnboardingStore(kv);
    const t = terminal(['why?', 'wrong-token', SECRET]);
    const result = await run([secretStep], store, t.io);
    expect(result.outcome).toBe('complete');
    expect(t.prompter.asked).toEqual(['Paste a Jira API token: ', 'Paste a Jira API token: ', 'Paste a Jira API token: ']);
    expect(t.lines).toContain('Snapwing calls /rest/api/3/myself with it.');
    expect(t.lines).toContain('Jira did not accept that token. Try again.');
    expect(t.lines.join('\n')).not.toContain(SECRET);

    const stored = kv.raw.get(ONBOARDING_STATE_KEY) ?? '';
    expect(stored).not.toContain(SECRET);
    expect(result.state.steps['jira']).toMatchObject({
      status: 'done',
      secrets: ['JIRA_API_TOKEN', 'JIRA_BASE_URL'],
      data: { token: '[secret]', echo: 'token is [secret]', copy: '[secret]', site: 'https://example.atlassian.net' },
    });

    const envPath = join(dir, '.env');
    expect(await readFile(envPath, 'utf8')).toBe(`JIRA_API_TOKEN=${SECRET}\nJIRA_BASE_URL=https://example.atlassian.net\n`);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it('keeps other .env lines, tightens an existing file to 0600, and reads keys back', async () => {
    const envPath = join(dir, '.env');
    await writeFile(envPath, '# mine\nSLACK_BOT_TOKEN=xoxb-test\n', { mode: 0o644 });
    await writeEnvFile(envPath, { JIRA_API_TOKEN: 'a b"c' });
    expect(await readFile(envPath, 'utf8')).toBe('# mine\nSLACK_BOT_TOKEN=xoxb-test\nJIRA_API_TOKEN="a b\\"c"\n');
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);

    let read: SecretValue | undefined;
    const steps = [
      step('a', [], async (ctx) => {
        read = await ctx.readEnv('JIRA_API_TOKEN');
        return { status: 'done', data: { fallback: (await ctx.readEnv('FROM_ENV'))?.reveal() ?? null, missing: (await ctx.readEnv('NOPE')) === undefined } };
      }),
    ];
    const result = await run(steps, createKvOnboardingStore(memoryKv()), terminal([]).io, { env: { FROM_ENV: 'from-process' } });
    expect(read?.reveal()).toBe('a b"c');
    expect(String(read)).toBe('[secret]');
    expect(result.state.steps['a']?.data).toEqual({ fallback: '[secret]', missing: true });
  });

  it('is the one upsertEnv the bootstrap scripts use', () => {
    expect(scriptUpsertEnv).toBe(upsertEnv);
  });

  it('reads hidden input on a terminal without echoing it', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stderr.on('data', (c: Buffer) => {
      chunks.push(c);
      // Type the answer once the question is on the screen.
      if (c.toString('utf8').includes('Paste a Jira API token:')) setImmediate(() => stdin.write(`${SECRET}\r`));
    });
    const lines: string[] = [];
    const io = createTerminalIO({ prompter: terminalPrompter({ stdin, stderr }), say: (line) => lines.push(line) });
    const answer = await io.secret({ id: 'jira.token', text: 'Paste a Jira API token:' });
    expect(answer.reveal()).toBe(SECRET);
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('aborts a question nobody answers', async () => {
    await expect(terminal([]).io.secret({ id: 'jira.token', text: 'Token:' })).rejects.toBeInstanceOf(InterviewAborted);
  });
});

describe('the terminal interview', () => {
  it('asks numbered choices, takes a number or an id, and explains on "why?"', async () => {
    const t = terminal(['why?', '7', '2', 'docker']);
    const choice = { id: 'where', text: 'Where will Snapwing run?', why: 'local runs fixers as you; docker isolates them.', choices: [{ id: 'local', label: 'On this machine' }, { id: 'docker', label: 'In Docker' }], default: 'local' };
    expect(await t.io.choose(choice)).toBe('docker');
    expect(t.lines).toEqual([
      'Where will Snapwing run?',
      '  1. On this machine (default)',
      '  2. In Docker',
      'local runs fixers as you; docker isolates them.',
      'Type a number from 1 to 2, or "why?" for the detail.',
    ]);
    expect(await t.io.choose(choice)).toBe('docker');
    expect(await terminal(['']).io.choose(choice)).toBe('local');
  });

  it('uses a default on an empty answer and asks again when validation refuses', async () => {
    const t = terminal(['', 'nope', 'https://x.atlassian.net']);
    const site = await t.io.ask({ id: 'site', text: 'Which Jira site?', validate: (a) => (a.startsWith('https://') ? undefined : 'Paste the address, starting https://.') });
    expect(site).toBe('https://x.atlassian.net');
    expect(t.lines).toEqual(['Type an answer, or "why?" for the detail.', 'Paste the address, starting https://.']);
    expect(await terminal(['']).io.ask({ id: 'port', text: 'Port?', default: '3000' })).toBe('3000');
  });

  it('parses answers files: flat, nested, lists, and environment references', () => {
    const answers = parseAnswers(JSON.stringify({ 'a.x': 'one', b: { y: ['1', 2], z: { env: 'TOKEN' } }, c: { env: 'OTHER' } }));
    expect([...answers.entries()]).toEqual([
      ['a.x', ['one']],
      ['b.y', ['1', '2']],
      ['b.z', [{ env: 'TOKEN' }]],
      ['c', [{ env: 'OTHER' }]],
    ]);
    expect(() => parseAnswers('[]')).toThrow(/JSON object/);
    expect(() => parseAnswers('{"a": {"b": {"c": 1}}}')).toThrow(/a.b must be/);
  });
});

describe('snapwing onboard', () => {
  let tdb: TestDatabase;

  beforeEach(async () => {
    tdb = await createTestDatabase();
  });

  afterEach(async () => {
    await tdb.drop();
  });

  const twoSteps: readonly OnboardStep[] = [
    step('where', [], async (ctx) => {
      const runtime = await ctx.io.choose({ id: 'runtime', text: 'Where will Snapwing run?', choices: [{ id: 'local', label: 'Here' }, { id: 'docker', label: 'Docker' }] });
      return { status: 'done', data: { runtime } };
    }),
    step('jira', ['where'], async (ctx) => {
      const site = await ctx.io.ask({ id: 'site', text: 'Which Jira site?' });
      const token = await ctx.io.secret({ id: 'token', text: 'Paste a Jira API token:' });
      await ctx.writeEnv({ JIRA_BASE_URL: site, JIRA_API_TOKEN: token });
      return { status: 'done', data: { site, runtime: ctx.data('where')?.['runtime'] ?? null } };
    }),
  ];

  function cli(): { io: { env: Record<string, string>; stdout: (l: string) => void; stderr: (l: string) => void }; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { env: { ONBOARD_TEST_TOKEN: SECRET }, stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
  }

  it('is in the command table', () => {
    expect(COMMANDS['onboard']?.summary).toMatch(/interview/);
  });

  it('runs two fake steps from an answers file and saves the state in the store', async () => {
    await writeFile(join(dir, 'answers.json'), JSON.stringify({ where: { runtime: '2' }, 'jira.site': 'https://example.atlassian.net', 'jira.token': { env: 'ONBOARD_TEST_TOKEN' } }));
    const c = cli();
    const code = await runOnboard(['--answers', 'answers.json'], c.io, {
      cwd: dir,
      steps: twoSteps,
      prompter: scriptedPrompter([]),
      openState: () => openState(tdb.options),
    });
    expect(c.err).toEqual([]);
    expect(code).toBe(0);
    expect(c.out).toContain('Choose 1-2: 2');
    expect(c.out).toContain('Which Jira site? https://example.atlassian.net');
    expect(c.out).toContain('Paste a Jira API token: [hidden]');
    expect(c.out).toContain('Onboarding is finished.');
    expect(c.out.join('\n')).not.toContain(SECRET);

    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).toContain(`JIRA_API_TOKEN=${SECRET}`);
    const s = await tdb.open();
    if (!(s instanceof StateStore)) throw new Error('expected the store');
    const stored = await s.kvGet(ONBOARDING_STATE_KEY);
    expect(stored).not.toContain(SECRET);
    const state = await createKvOnboardingStore(s).load();
    expect(state?.steps['where']).toMatchObject({ status: 'done', data: { runtime: 'docker' } });
    expect(state?.steps['jira']).toMatchObject({ status: 'done', secrets: ['JIRA_BASE_URL', 'JIRA_API_TOKEN'], data: { runtime: 'docker' } });

    const status = cli();
    expect(await runOnboard(['--status'], status.io, { cwd: dir, steps: twoSteps, openState: () => openState(tdb.options) })).toBe(0);
    expect(status.out).toEqual(['Onboarding:', '   0  Step where  done', '   1  Step jira   done']);
  });

  it('exits 2 at an unanswered question and picks up there on the next run', async () => {
    const c = cli();
    const deps = { cwd: dir, steps: twoSteps, openState: () => openState(tdb.options) };
    expect(await runOnboard([], c.io, { ...deps, prompter: scriptedPrompter(['1']) })).toBe(EXIT_UNANSWERED);
    expect(c.out).toContain('Stopped at Step jira; nothing you answered is lost. Run `snapwing onboard` again to pick up there.');
    const again = cli();
    expect(await runOnboard([], again.io, { ...deps, prompter: scriptedPrompter(['https://x.atlassian.net', SECRET]) })).toBe(0);
    expect(again.out).toContain('Picking up where you left off: Step jira.');
  });

  it('exits 3 while a step waits on someone, and 1 for an unknown --step', async () => {
    const blocked: readonly OnboardStep[] = [step('slack', [], () => Promise.resolve({ status: 'blocked', on: 'a Slack workspace admin', reason: 'approval' }))];
    const c = cli();
    const deps = { cwd: dir, steps: blocked, prompter: scriptedPrompter([]), openState: () => openState(tdb.options) };
    expect(await runOnboard([], c.io, deps)).toBe(EXIT_WAITING);
    expect(c.out).toContain('  Step slack: a Slack workspace admin');
    const bad = cli();
    expect(await runOnboard(['--step', 'nope'], bad.io, deps)).toBe(1);
    expect(bad.err[0]).toMatch(/no onboarding step "nope"; the steps are slack/);
  });
});
