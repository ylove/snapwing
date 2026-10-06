// `snapwing onboard` (main 22.1, the paste path; main 22.2): the interview in the terminal.
//
//   snapwing onboard [--step <id>] [--answers <file>] [--env-file <file>] [--status]
//
// Everything lives in the working directory, where `snapwing serve` reads it: `.env` (secrets),
// `snapwing.config.xml`, `workspace-context.xml`, and the state store (`snapwing.sqlite` by default,
// or `SNAPWING_DB=postgres` with `DATABASE_URL`), which holds the interview's progress under kv
// `onboarding:state` (ADR 0020). Never a global location.

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stateOptionsFromEnv } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { DEFAULT_SQLITE_PATH, openState } from '@snapwing/pipeline/state/db.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import type { InterviewIO } from '../onboard/interview/io.ts';
import { runInterview, StepNeedsUnmetError, UnknownStepError, type InterviewResult } from '../onboard/interview/machine.ts';
import { createKvOnboardingStore, OnboardingStateError, type OnboardingState, type StepStatus } from '../onboard/interview/state.ts';
import type { OnboardStep } from '../onboard/interview/step.ts';
import { AnswersFileError, createTerminalIO, parseAnswers } from '../onboard/interview/terminal.ts';
import { ONBOARD_STEPS } from '../onboard/steps/index.ts';
import { defaultCaptureEnv } from './capture.ts';
import { terminalPrompter, type Prompter } from './prompt.ts';
import type { CliIo } from './state.ts';

export const ONBOARD_USAGE = `Usage: snapwing onboard [--step <id>] [--answers <file>] [--env-file <file>] [--status]

Sets Snapwing up by interview, one question at a time. Answer "why?" to any question for the
technical detail. Progress is saved after every step: run it again to pick up where it stopped.

  --step <id>        run one step again (${ONBOARD_STEPS.map((s) => s.id).join(', ')})
  --answers <file>   take answers from a JSON file, for scripted runs: { "<step>.<question>": "answer" },
                     a list for a question asked more than once, or { "env": "NAME" } for a secret
  --env-file <file>  where secrets go; default $SNAPWING_ENV_FILE, else .env
  --status           print where each step stands and exit

Everything is written to the working directory: .env (mode 0600), snapwing.config.xml,
workspace-context.xml, and the state (snapwing.sqlite, or SNAPWING_DB=postgres with DATABASE_URL).
Secrets go only to .env.

Exit codes: 0 finished, 1 a step failed, 2 a question was left unanswered, 3 waiting on someone.`;

export const EXIT_WAITING = 3;
export const EXIT_UNANSWERED = 2;

/** What `runOnboard` reaches beyond `CliIo`. Tests pass their own. */
export interface OnboardDeps {
  readonly cwd?: string;
  readonly prompter?: Prompter;
  readonly steps?: readonly OnboardStep[];
  readonly openState?: (options: Parameters<typeof openState>[0]) => Promise<OpenedState>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly now?: () => Date;
}

const STATUS_WORDS: Readonly<Record<StepStatus, string>> = {
  pending: 'not started',
  running: 'started, not finished',
  done: 'done',
  blocked: 'waiting on someone',
  skipped: 'skipped',
  'not-built': 'not built yet',
  failed: 'failed, will retry',
};

/** One line per step: number, title, status. */
export function statusLines(steps: readonly OnboardStep[], state: OnboardingState | undefined): string[] {
  const width = Math.max(...steps.map((s) => s.title.length));
  return steps.map((s) => {
    const record = state?.steps[s.id];
    const words = STATUS_WORDS[record?.status ?? 'pending'];
    const detail = record?.status === 'blocked' && record.blocked !== undefined ? ` (${record.blocked.on})` : '';
    return `  ${String(s.number).padStart(2)}  ${s.title.padEnd(width)}  ${words}${detail}`;
  });
}

function summary(result: InterviewResult, steps: readonly OnboardStep[]): { lines: string[]; code: number } {
  const title = (id: string): string => steps.find((s) => s.id === id)?.title ?? id;
  const notBuilt = steps.filter((s) => result.state.steps[s.id]?.status === 'not-built').map((s) => s.title);
  const notBuiltLine = notBuilt.length === 0 ? [] : [`Not built yet in this version: ${notBuilt.join(', ')}.`];
  switch (result.outcome) {
    case 'complete':
      return { lines: [notBuilt.length === 0 ? 'Onboarding is finished.' : 'Every step this version has is done.', ...notBuiltLine], code: 0 };
    case 'aborted': {
      const step = result.unanswered?.split('.')[0] ?? '';
      return {
        lines: [`Stopped at ${title(step)}; nothing you answered is lost. Run \`snapwing onboard\` again to pick up there.`],
        code: EXIT_UNANSWERED,
      };
    }
    case 'failed':
      return {
        lines: [`${title(result.failure?.step ?? '')} did not finish: ${result.failure?.message ?? 'unknown error'}`, 'Run `snapwing onboard` again to retry it.'],
        code: 1,
      };
    case 'waiting': {
      const blocked = steps.filter((s) => result.state.steps[s.id]?.status === 'blocked');
      const lines = ['Onboarding is waiting on someone:'];
      for (const s of blocked) lines.push(`  ${s.title}: ${result.state.steps[s.id]?.blocked?.on ?? 'someone'}`);
      for (const w of result.waiting) lines.push(`  ${title(w.id)} waits for ${w.on.map(title).join(' or ')}`);
      lines.push('Run `snapwing onboard` again once that is done.', ...notBuiltLine);
      return { lines, code: EXIT_WAITING };
    }
  }
}

/** Runs `snapwing onboard <args>` and returns the exit code. */
export async function runOnboard(args: readonly string[], io: CliIo, deps: OnboardDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(ONBOARD_USAGE);
    return 0;
  }
  let values: { step?: string | undefined; answers?: string | undefined; 'env-file'?: string | undefined; status?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      options: { step: { type: 'string' }, answers: { type: 'string' }, 'env-file': { type: 'string' }, status: { type: 'boolean' } },
    }));
  } catch (error) {
    io.stderr(`snapwing onboard: ${error instanceof Error ? error.message : String(error)}\n${ONBOARD_USAGE}`);
    return 1;
  }
  const cwd = deps.cwd ?? process.cwd();
  const steps = deps.steps ?? ONBOARD_STEPS;
  const envFile = values['env-file'] ?? (io.env['SNAPWING_ENV_FILE']?.trim() || '.env');

  let answers: ReturnType<typeof parseAnswers> | undefined;
  if (values.answers !== undefined) {
    const path = isAbsolute(values.answers) ? values.answers : join(cwd, values.answers);
    try {
      answers = parseAnswers(await readFile(path, 'utf8'));
    } catch (error) {
      io.stderr(`snapwing onboard: ${error instanceof AnswersFileError ? error.message : `cannot read ${values.answers}`}`);
      return 1;
    }
  }

  let opened: OpenedState | undefined;
  try {
    const options = stateOptionsFromEnv(io.env);
    if (options.dialect === 'sqlite') options.url = resolve(cwd, io.env['SNAPWING_SQLITE_PATH']?.trim() || DEFAULT_SQLITE_PATH);
    opened = await (deps.openState ?? openState)(options);
    if (!(opened instanceof StateStore)) throw new Error('onboarding needs the store openState returned');
    const store = createKvOnboardingStore(opened);

    if (values.status === true) {
      io.stdout('Onboarding:');
      for (const line of statusLines(steps, await store.load())) io.stdout(line);
      return 0;
    }

    const prompter = deps.prompter ?? terminalPrompter({ stdin: process.stdin, stderr: process.stderr });
    const interview: InterviewIO = createTerminalIO({ prompter, say: io.stdout, ...(answers === undefined ? {} : { answers }), env: io.env });
    const result = await runInterview({
      steps,
      store,
      io: interview,
      workdir: cwd,
      envFile,
      env: io.env,
      openUrl: deps.openUrl ?? defaultCaptureEnv().openUrl,
      ...(values.step === undefined ? {} : { only: values.step }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    const { lines, code } = summary(result, steps);
    for (const line of lines) io.stdout(line);
    return code;
  } catch (error) {
    if (error instanceof UnknownStepError || error instanceof StepNeedsUnmetError || error instanceof OnboardingStateError) {
      io.stderr(`snapwing onboard: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await opened?.close();
  }
}
