// The interview machine (main 22.1, 22.2; ADR 0004, ADR 0020): one resumable state machine over the
// ordered step registry.
//
// A run walks the registry once, in order, and starts every step that is not finished (`done` or
// `skipped`) and whose needs are met. Before a step starts its record is saved as `running`, and
// after it ends the outcome is saved, so a crash or Ctrl-C leaves the step `running` and the next
// run starts it again; finished steps are never asked twice. A `blocked` step (it waits on a person
// outside the interview, such as a Slack admin approving the install) is tried again on the next
// run, and in this run every step that does not need it carries on (ADR 0004). `only` reruns one
// step whatever its status.
//
// Secrets: every `SecretValue` the run sees (asked, read from `.env`, or written to it) is redacted
// from each record before it is saved, so the state never holds a secret even when a step slips
// one into its data or an error message.

import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseDotenv } from '@snapwing/pipeline/providers/local/secrets.ts';
import { writeEnvFile } from './env.ts';
import { InterviewAborted, scopedIO, SecretValue, type InterviewIO } from './io.ts';
import { emptyState, type JsonObject, type OnboardingState, type OnboardingStore, type StepRecord, type StepStatus } from './state.ts';
import type { OnboardStep, StepContext, StepNeed, StepOutcome } from './step.ts';

const STEP_ID = /^[a-z][a-z0-9-]*$/;

/** Checks the registry: ids unique and well formed, every need an earlier step. Throws naming the problem. */
export function validateRegistry(steps: readonly OnboardStep[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (!STEP_ID.test(step.id)) throw new Error(`onboarding step id ${JSON.stringify(step.id)} must be lowercase words and dashes`);
    if (seen.has(step.id)) throw new Error(`onboarding step ${step.id} is registered twice`);
    for (const need of step.needs.flatMap((n) => (typeof n === 'string' ? [n] : [...n]))) {
      if (!seen.has(need)) throw new Error(`onboarding step ${step.id} needs ${need}, which is not an earlier step`);
    }
    seen.add(step.id);
  }
}

const statusOf = (state: OnboardingState, id: string): StepStatus => state.steps[id]?.status ?? 'pending';
const passes = (s: StepStatus): boolean => s === 'done' || s === 'skipped' || s === 'not-built';
const isFinished = (s: StepStatus): boolean => s === 'done' || s === 'skipped';

/** Whether a list need has been left out by the installer: no step done, and at least one skipped. */
function leftOut(need: StepNeed, state: OnboardingState): need is readonly string[] {
  if (typeof need === 'string') return false;
  const statuses = need.map((id) => statusOf(state, id));
  return !statuses.includes('done') && statuses.every((s) => s === 'skipped' || s === 'not-built') && statuses.includes('skipped');
}

/** Whether one need is met in `state` (see `StepNeed`). */
export function needMet(need: StepNeed, state: OnboardingState): boolean {
  if (typeof need === 'string') return passes(statusOf(state, need));
  const statuses = need.map((id) => statusOf(state, id));
  if (statuses.includes('done')) return true;
  // Every one left out on purpose is not a chat platform: that waits (see `leftOut`). Only steps
  // not built yet, which cannot be asked, stand in for one.
  return statuses.every((s) => s === 'not-built');
}

export interface RunInterviewOptions {
  readonly steps: readonly OnboardStep[];
  readonly store: OnboardingStore;
  readonly io: InterviewIO;
  /** The working directory. */
  readonly workdir: string;
  /** The `.env` file, relative to `workdir` unless absolute. Default `.env`. */
  readonly envFile?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Reruns this one step, whatever its status. */
  readonly only?: string;
  /** The way in, recorded on each step (main 22.1). Default `terminal`. */
  readonly via?: string;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface WaitingStep {
  readonly id: string;
  /** The step ids it waits on. */
  readonly on: readonly string[];
}

export interface InterviewResult {
  /**
   * - `complete`: every step is done, skipped, or not built yet.
   * - `waiting`: what could run did; some steps are blocked on a person or wait on one that is.
   * - `aborted`: a question went unanswered; the step resumes next run.
   * - `failed`: a step threw; it is tried again next run.
   */
  readonly outcome: 'complete' | 'waiting' | 'aborted' | 'failed';
  readonly state: OnboardingState;
  /** Step ids started this run, in order. */
  readonly ran: readonly string[];
  readonly waiting: readonly WaitingStep[];
  /** The unanswered question, as `<step id>.<question id>`, when aborted. */
  readonly unanswered?: string;
  /** The failed step and its (redacted) message, when failed. */
  readonly failure?: { readonly step: string; readonly message: string };
}

export class UnknownStepError extends Error {
  override readonly name = 'UnknownStepError';
}

export class StepNeedsUnmetError extends Error {
  override readonly name = 'StepNeedsUnmetError';
}

const MIN_REDACT_LENGTH = 6;

/** Collects every secret a run sees and scrubs them from what is saved. */
class Redactor {
  readonly #values = new Set<string>();

  add(secret: SecretValue): SecretValue {
    const text = secret.reveal();
    if (text.length >= MIN_REDACT_LENGTH) this.#values.add(text);
    return secret;
  }

  text(s: string): string {
    let out = s;
    for (const v of this.#values) out = out.split(v).join('[secret]');
    return out;
  }

  record(record: StepRecord): StepRecord {
    const json = JSON.stringify(record);
    const clean = this.text(json);
    return clean === json ? record : (JSON.parse(clean) as StepRecord);
  }
}

function blockedLines(step: OnboardStep, record: StepRecord): string {
  const b = record.blocked;
  if (b === undefined) return `${step.title} is waiting on someone.`;
  return [`${step.title} is waiting on ${b.on}: ${b.reason}`, ...(b.link === undefined ? [] : [b.link])].join('\n');
}

/** Runs the interview once (see the file header). */
export async function runInterview(options: RunInterviewOptions): Promise<InterviewResult> {
  const { steps, store } = options;
  validateRegistry(steps);
  const now = options.now ?? (() => new Date());
  const via = options.via ?? 'terminal';
  const env = options.env ?? {};
  const envFile = options.envFile ?? '.env';
  const envPath = isAbsolute(envFile) ? envFile : join(options.workdir, envFile);
  const redactor = new Redactor();
  const io: InterviewIO = {
    say: (text) => options.io.say(text),
    ask: (q) => options.io.ask(q),
    choose: (q) => options.io.choose(q),
    secret: async (q) => redactor.add(await options.io.secret(q)),
  };

  const loaded = await store.load();
  let state = loaded ?? emptyState(now());
  const save = async (id: string, record: StepRecord): Promise<void> => {
    state = await store.saveStep(id, redactor.record(record), now());
  };

  const ran: string[] = [];
  const waiting: WaitingStep[] = [];

  /** Runs one step; returns how the run goes on. */
  const runStep = async (step: OnboardStep): Promise<{ stop?: Omit<InterviewResult, 'state' | 'ran' | 'waiting'> }> => {
    const previous = state.steps[step.id];
    let record: StepRecord = {
      status: 'running',
      attempts: (previous?.attempts ?? 0) + 1,
      startedAt: now().toISOString(),
      via,
      ...(previous?.data === undefined ? {} : { data: previous.data }),
      ...(previous?.secrets === undefined ? {} : { secrets: previous.secrets }),
    };
    ran.push(step.id);
    await save(step.id, record);

    const ctx: StepContext = {
      io: scopedIO(io, step.id),
      workdir: options.workdir,
      env,
      now,
      data: (id) => state.steps[id]?.data,
      progress: async (data) => {
        record = { ...record, data: { ...record.data, ...data } };
        await save(step.id, record);
      },
      writeEnv: async (entries) => {
        const plain: Record<string, string> = {};
        for (const [name, value] of Object.entries(entries)) {
          plain[name] = value instanceof SecretValue ? redactor.add(value).reveal() : value;
        }
        await writeEnvFile(envPath, plain);
        const names = [...new Set([...(record.secrets ?? []), ...Object.keys(plain)])];
        record = { ...record, secrets: names };
        await save(step.id, record);
      },
      readEnv: async (name) => {
        let fromFile: string | undefined;
        try {
          fromFile = parseDotenv(await readFile(envPath, 'utf8'), envPath).get(name);
        } catch (e) {
          if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')) throw e;
        }
        const value = fromFile !== undefined && fromFile !== '' ? fromFile : env[name];
        return value === undefined || value === '' ? undefined : redactor.add(new SecretValue(value));
      },
      openUrl: options.openUrl ?? (() => Promise.resolve()),
    };

    let outcome: StepOutcome;
    try {
      outcome = await step.run(ctx);
    } catch (e) {
      if (e instanceof InterviewAborted) {
        return { stop: { outcome: 'aborted', unanswered: e.question } };
      }
      const message = redactor.text(e instanceof Error ? e.message : String(e));
      await save(step.id, { ...record, status: 'failed', finishedAt: now().toISOString(), note: message });
      return { stop: { outcome: 'failed', failure: { step: step.id, message } } };
    }

    const finishedAt = now().toISOString();
    const { blocked: _b, note: _n, ...base } = record;
    void _b;
    void _n;
    const withData = (data: JsonObject | undefined): StepRecord =>
      data === undefined ? base : { ...base, data: { ...base.data, ...data } };
    switch (outcome.status) {
      case 'done':
        record = { ...withData(outcome.data), status: 'done', finishedAt };
        break;
      case 'blocked':
        record = {
          ...withData(outcome.data),
          status: 'blocked',
          finishedAt,
          blocked: { on: outcome.on, reason: outcome.reason, ...(outcome.link === undefined ? {} : { link: outcome.link }) },
        };
        break;
      case 'skipped':
        record = { ...base, status: 'skipped', finishedAt, note: outcome.reason };
        break;
      case 'not-built':
        record = { ...base, status: 'not-built', finishedAt, note: 'not built yet' };
        break;
    }
    await save(step.id, record);
    if (record.status === 'blocked') {
      io.say(`${blockedLines(step, record)}\nI will carry on with the steps that do not need it. Run \`snapwing onboard\` again once that is done.`);
    }
    return {};
  };

  if (options.only !== undefined) {
    const step = steps.find((s) => s.id === options.only);
    if (step === undefined) {
      throw new UnknownStepError(`no onboarding step ${JSON.stringify(options.only)}; the steps are ${steps.map((s) => s.id).join(', ')}`);
    }
    const unmet = step.needs.filter((n) => !needMet(n, state));
    if (unmet.length > 0) {
      throw new StepNeedsUnmetError(`${step.id} needs ${unmet.map((n) => (typeof n === 'string' ? n : n.join(' or '))).join(', ')} first`);
    }
    const { stop } = await runStep(step);
    return { ...(stop ?? { outcome: summarize(steps, state) }), state, ran, waiting };
  }

  const resume = steps.find((s) => statusOf(state, s.id) === 'running' || statusOf(state, s.id) === 'failed');
  if (loaded === undefined) {
    io.say("Let's set up Snapwing. One question at a time; answer \"why?\" to any of them for the technical detail.");
  } else if (resume !== undefined) {
    io.say(`Picking up where you left off: ${resume.title}.`);
  }

  const said = new Set<string>();
  for (const step of steps) {
    if (isFinished(statusOf(state, step.id))) continue;
    const unmet = step.needs.filter((n) => !needMet(n, state));
    if (unmet.length > 0) {
      waiting.push({ id: step.id, on: unmet.flatMap((n) => (typeof n === 'string' ? [n] : [...n])) });
      for (const need of unmet) {
        const key = typeof need === 'string' ? '' : need.join(' ');
        if (!leftOut(need, state) || said.has(key)) continue;
        said.add(key);
        const options = (need as readonly string[]).map((id) => `\`snapwing onboard --step ${id}\``);
        io.say(`Snapwing needs a chat platform, and every one was left out. Run ${options.join(' or ')} to set one up; the steps that need it wait until then.`);
      }
      continue;
    }
    const { stop } = await runStep(step);
    if (stop !== undefined) return { ...stop, state, ran, waiting };
  }
  return { outcome: summarize(steps, state), state, ran, waiting };
}

function summarize(steps: readonly OnboardStep[], state: OnboardingState): 'complete' | 'waiting' {
  return steps.every((s) => passes(statusOf(state, s.id))) ? 'complete' : 'waiting';
}
