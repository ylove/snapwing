// The terminal `InterviewIO` (main 22.1, the paste path): one plain-language question at a time,
// numbered choices, hidden input for secrets, and "why?" for the technical detail. Questions are
// asked through the CLI's `Prompter` (`cli/prompt.ts`), so a hidden answer is never echoed; what
// the interview says goes to `say` (stdout). A secret is never passed to `say`.
//
// `--answers <file>` scripts a run: a JSON object from `<step id>.<question id>` (or nested,
// `{ "<step id>": { "<question id>": ... } }`) to an answer, a list of answers used in order for a
// question asked more than once, or `{ "env": "NAME" }` to read the answer from the environment (the
// way to script a secret without writing it in the file). A scripted answer is printed after its
// question (a secret as `[hidden]`); one that is refused, or a question with no scripted answer,
// falls back to the prompter, which answers nothing when there is no terminal, and the run stops
// there with the question named.

import type { Prompter } from '../../cli/prompt.ts';
import {
  InterviewAborted,
  SecretValue,
  type ChoiceQuestion,
  type InterviewIO,
  type Refusal,
  type SecretQuestion,
  type TextQuestion,
} from './io.ts';

export type ScriptedAnswer = string | { readonly env: string };

export class AnswersFileError extends Error {
  override readonly name = 'AnswersFileError';
}

function scriptedValue(key: string, raw: unknown): ScriptedAnswer {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    const name = (raw as Record<string, unknown>)['env'];
    if (keys.length === 1 && typeof name === 'string' && name !== '') return { env: name };
  }
  throw new AnswersFileError(`answers file: ${key} must be a string, a list of strings, or { "env": "NAME" }`);
}

/** Parses an answers file (see the file header) into a queue of answers per question. */
export function parseAnswers(text: string): Map<string, ScriptedAnswer[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AnswersFileError('answers file: not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AnswersFileError('answers file: must be a JSON object');
  const out = new Map<string, ScriptedAnswer[]>();
  const add = (key: string, value: unknown): void => {
    const list = Array.isArray(value) ? value : [value];
    out.set(key, list.map((v) => scriptedValue(key, v)));
  };
  for (const [key, value] of Object.entries(raw)) {
    const isNested = typeof value === 'object' && value !== null && !Array.isArray(value) && !('env' in value);
    if (isNested) {
      for (const [inner, v] of Object.entries(value)) add(`${key}.${inner}`, v);
    } else {
      add(key, value);
    }
  }
  return out;
}

export interface TerminalIOOptions {
  readonly prompter: Prompter;
  /** Where the interview's lines go (stdout). Never given a secret. */
  readonly say: (line: string) => void;
  readonly answers?: ReadonlyMap<string, readonly ScriptedAnswer[]>;
  /** Read for `{ "env": "NAME" }` answers. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const isWhy = (answer: string): boolean => /^why\s*\??$/i.test(answer.trim());

/** The terminal interview (see the file header). */
export function createTerminalIO(options: TerminalIOOptions): InterviewIO {
  const queues = new Map<string, ScriptedAnswer[]>();
  for (const [k, v] of options.answers ?? []) queues.set(k, [...v]);
  const say = (text: string): void => {
    for (const line of text.split('\n')) options.say(line);
  };

  /** The next scripted answer for `id`, consumed; undefined when none is left. */
  const scripted = (id: string): string | undefined => {
    const next = queues.get(id)?.shift();
    if (next === undefined) return undefined;
    if (typeof next === 'string') return next;
    const value = options.env?.[next.env];
    if (value === undefined || value === '') {
      say(`(The answers file reads ${id} from ${next.env}, which is not set.)`);
      return undefined;
    }
    return value;
  };

  const explain = (why: string | undefined): void => {
    say(why ?? 'Nothing more to it than the question says.');
  };

  /**
   * Gets answers until `accept` takes one. `read` asks the person; a scripted answer is tried first.
   * `accept` returns a refusal to ask again, or undefined when the answer is taken.
   */
  async function loop(
    id: string,
    question: string,
    hidden: boolean,
    why: string | undefined,
    accept: (answer: string) => Promise<Refusal>,
  ): Promise<void> {
    for (;;) {
      let answer = scripted(id);
      if (answer !== undefined) {
        say(`${question} ${hidden ? '[hidden]' : answer}`);
      } else {
        answer = await (hidden ? options.prompter.hidden(`${question} `) : options.prompter.line(`${question} `));
        if (answer === undefined) throw new InterviewAborted(id);
      }
      if (isWhy(answer)) {
        explain(why);
        continue;
      }
      const refusal = await accept(answer);
      if (refusal === undefined) return;
      say(refusal);
    }
  }

  return {
    say,

    async ask(q: TextQuestion): Promise<string> {
      let result = '';
      await loop(q.id, q.text, false, q.why, async (raw) => {
        const answer = raw.trim() === '' ? (q.default ?? '') : raw.trim();
        if (answer === '') return 'Type an answer, or "why?" for the detail.';
        const refusal = await q.validate?.(answer);
        if (refusal === undefined) result = answer;
        return refusal;
      });
      return result;
    },

    async choose(q: ChoiceQuestion): Promise<string> {
      if (q.choices.length === 0) throw new Error(`choose ${q.id}: no choices`);
      say(q.text);
      q.choices.forEach((c, i) => say(`  ${i + 1}. ${c.label}${c.id === q.default ? ' (default)' : ''}`));
      let result = '';
      const prompt = `Choose 1-${q.choices.length}:`;
      await loop(q.id, prompt, false, q.why, (raw) => {
        const text = raw.trim();
        const lower = text.toLowerCase();
        const choice =
          text === ''
            ? q.choices.find((c) => c.id === q.default)
            : /^\d+$/.test(text)
              ? q.choices[Number(text) - 1]
              : q.choices.find((c) => c.id.toLowerCase() === lower);
        if (choice === undefined) return Promise.resolve(`Type a number from 1 to ${q.choices.length}, or "why?" for the detail.`);
        result = choice.id;
        return Promise.resolve(undefined);
      });
      return result;
    },

    async secret(q: SecretQuestion): Promise<SecretValue> {
      let result: SecretValue | undefined;
      await loop(q.id, q.text, true, q.why, async (raw) => {
        const text = raw.trim();
        if (text === '') return 'Paste it, or answer "why?" for the detail. It will not show as you type.';
        const value = new SecretValue(text);
        const refusal = await q.validate?.(value);
        if (refusal === undefined) result = value;
        return refusal;
      });
      if (result === undefined) throw new InterviewAborted(q.id);
      return result;
    },
  };
}
