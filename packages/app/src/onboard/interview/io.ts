// What the interview asks through (main 22.2: "Every step is one question in plain language,
// validated live before moving on, with the technical detail available on request and never
// required"). A step only ever talks to an `InterviewIO`; the terminal (paste path, `terminal.ts`)
// is the first implementation, and the chat paths (click and in chat, main 22.1) implement the same
// interface later with buttons and modals.
//
// A secret is a `SecretValue`, never a string: it prints, logs, and serializes as `[secret]`, so a
// step that puts one in its data or an error message by mistake cannot leak it. `reveal()` is the
// only way to the text, and the only places that call it are the `.env` writer and the step's own
// validation call.

import { inspect } from 'node:util';

export type Awaitable<T> = T | Promise<T>;

const REDACTED = '[secret]';

/** A secret typed by the installer. Prints and serializes as `[secret]`. */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The text. Pass it only to the `.env` writer or a validation call. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/**
 * Returned by `validate` to refuse an answer: the plain-language reason, said before the question is
 * asked again. Undefined accepts it.
 */
export type Refusal = string | undefined;

interface QuestionBase {
  /** Stable within its step; `--answers` keys it as `<step id>.<id>`. */
  readonly id: string;
  /** One question in plain language. */
  readonly text: string;
  /** The technical detail, printed when the installer answers "why?". Never required. */
  readonly why?: string;
}

export interface TextQuestion extends QuestionBase {
  /** Used when the answer is empty. Without one, an empty answer is asked again. */
  readonly default?: string;
  readonly validate?: (answer: string) => Awaitable<Refusal>;
}

export interface Choice {
  readonly id: string;
  /** One line. */
  readonly label: string;
}

export interface ChoiceQuestion extends QuestionBase {
  readonly choices: readonly Choice[];
  /** The id chosen when the answer is empty. */
  readonly default?: string;
}

export interface SecretQuestion extends QuestionBase {
  readonly validate?: (answer: SecretValue) => Awaitable<Refusal>;
}

/**
 * One conversation with the installer. Each method asks one question and resolves to an answer that
 * passed `validate`; it rejects with `InterviewAborted` when nobody is there to answer (end of
 * input, Ctrl-C, no terminal), and the machine then leaves the step unfinished to resume later.
 */
export interface InterviewIO {
  /** Tells the installer something; one or more plain-language lines. */
  say(text: string): void;
  ask(question: TextQuestion): Promise<string>;
  /** Resolves to the chosen `Choice.id`. */
  choose(question: ChoiceQuestion): Promise<string>;
  /** Hidden input: never echoed, never logged, never stored in the onboarding state. */
  secret(question: SecretQuestion): Promise<SecretValue>;
}

/** Nobody answered: end of input, Ctrl-C, or no terminal. The current step stays unfinished. */
export class InterviewAborted extends Error {
  override readonly name = 'InterviewAborted';
  /** The question left unanswered, as `<step id>.<question id>`. */
  readonly question: string;

  constructor(question: string, why = 'no answer') {
    super(`${why} to ${question}`);
    this.question = question;
  }
}

/** An `InterviewIO` whose question ids are prefixed with `<step id>.`, so answers files key per step. */
export function scopedIO(io: InterviewIO, stepId: string): InterviewIO {
  const scope = <Q extends { readonly id: string }>(q: Q): Q => ({ ...q, id: `${stepId}.${q.id}` });
  return {
    say: (text) => io.say(text),
    ask: (q) => io.ask(scope(q)),
    choose: (q) => io.choose(scope(q)),
    secret: (q) => io.secret(scope(q)),
  };
}
