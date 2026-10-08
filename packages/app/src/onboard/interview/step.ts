// What a step module is (main 22.2). Each step lives in its own file under `onboard/steps/` and the
// registry (`onboard/steps/index.ts`) orders them; a step issue replaces only its own file.
//
// A step runs once per `snapwing onboard` (or once for `--step <id>`), asks through `ctx.io`, and
// ends in one outcome. It reads earlier steps' data through `ctx.data`, writes secrets (and the
// non-secret values `serve` reads from the environment) through `ctx.writeEnv`, and may checkpoint
// part of its data with `ctx.progress` so a long step resumed after Ctrl-C can skip what it already
// confirmed.

import type { InterviewIO, SecretValue } from './io.ts';
import type { JsonObject, StepBlock } from './state.ts';

/**
 * A need is a step id, or a list of ids any one of which will do (the chat platform: Slack or
 * Teams). A step id is met when that step is `done`, `skipped`, or `not-built`; a list is met when
 * one of its steps is `done`, or every one is `skipped` or `not-built`. A `blocked`, `failed`,
 * `running`, or `pending` need holds the step back for this run.
 */
export type StepNeed = string | readonly string[];

export interface OnboardStep {
  /** Stable; the state document and `--step` key on it. Lowercase words and dashes. */
  readonly id: string;
  /** Plain language, such as "Connect Jira". */
  readonly title: string;
  /** Steps that must finish first. Every need is earlier in the registry. */
  readonly needs: readonly StepNeed[];
  run(ctx: StepContext): Promise<StepOutcome>;
}

export type StepOutcome =
  | { readonly status: 'done'; readonly data?: JsonObject }
  | ({ readonly status: 'blocked'; readonly data?: JsonObject } & StepBlock)
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'not-built' };

export interface StepContext {
  /** The interview, scoped to this step (`--answers` keys are `<step id>.<question id>`). */
  readonly io: InterviewIO;
  /** The working directory: `snapwing.config.xml`, `workspace-context.xml`, `.env` live here. */
  readonly workdir: string;
  /** The process environment, read only. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Earlier steps' data (and this step's own from a previous attempt), by step id. */
  data(stepId: string): JsonObject | undefined;
  /** Saves part of this step's data now, merged over what was saved; the step stays `running`. */
  progress(data: JsonObject): Promise<void>;
  /**
   * Sets keys in the working directory's `.env` (mode 0600) and records their names on the step.
   * The only place a secret goes.
   */
  writeEnv(entries: Readonly<Record<string, string | SecretValue>>): Promise<void>;
  /** A key from `.env`, else the process environment; undefined when unset or empty. */
  readEnv(name: string): Promise<SecretValue | undefined>;
  /** Opens a URL in the installer's browser, best effort. The step also prints it. */
  openUrl(url: string): Promise<void>;
  readonly now: () => Date;
}

export interface StepMeta {
  readonly id: string;
  readonly title: string;
  readonly needs: readonly StepNeed[];
}

/** A stub for a step not built yet: it says so and the interview moves on. Its issue replaces the file. */
export function notBuiltYet(meta: StepMeta): OnboardStep {
  return {
    ...meta,
    run: (ctx) => {
      ctx.io.say(`${meta.title}: not built yet, skipping.`);
      return Promise.resolve({ status: 'not-built' });
    },
  };
}
