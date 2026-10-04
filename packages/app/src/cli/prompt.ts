// Terminal prompts for the capture commands (main 15.4: "its cards render as terminal prompts with
// numbered choices"). The lines and numbers come from capture-client's `renderChoices`, so the CLI
// and Raycast word every response the same way; this file only asks and reads the answer.
//
// Questions go to stderr, so stdout stays the response. When stdin is not a terminal (`log < file`
// has used it up), the default prompter reads a choice from /dev/tty; with no terminal at all it
// answers undefined and the command exits asking for `--choice`. A hidden question (the login
// token) reads a piped stdin instead.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';
import type { NumberedChoice } from '@snapwing/capture-client/render.ts';

export interface Prompter {
  /** Asks one question; undefined when there is no one to answer (end of input, no terminal). */
  line(question: string): Promise<string | undefined>;
  /** Like `line`, without echoing what is typed (tokens). */
  hidden(question: string): Promise<string | undefined>;
}

/** The choice an answer names: its number, or its id. Undefined when it names none. */
export function parseChoiceAnswer(answer: string, choices: readonly NumberedChoice[]): NumberedChoice | undefined {
  const text = answer.trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return choices.find((c) => c.number === n);
  }
  const lower = text.toLowerCase();
  return choices.find((c) => c.id.toLowerCase() === lower);
}

/** The choice a `--choice` value names: its id, or its number. */
export function findChoice(value: string, choices: readonly NumberedChoice[]): NumberedChoice | undefined {
  return choices.find((c) => c.id === value) ?? parseChoiceAnswer(value, choices);
}

export const MAX_TRIES = 3;

/**
 * Asks until the answer names a choice. Undefined when the prompter has no answer or after
 * `MAX_TRIES` answers that name none.
 */
export async function askChoice(
  prompter: Prompter,
  choices: readonly NumberedChoice[],
  warn: (line: string) => void,
): Promise<NumberedChoice | undefined> {
  if (choices.length === 0) return undefined;
  const question = `Choose 1-${choices.length}: `;
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const answer = await prompter.line(question);
    if (answer === undefined) return undefined;
    const choice = parseChoiceAnswer(answer, choices);
    if (choice !== undefined) return choice;
    warn(`Type a number from 1 to ${choices.length}.`);
  }
  return undefined;
}

export interface TerminalPrompterOptions {
  readonly stdin: Readable & { isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream;
  /** Opens the controlling terminal when stdin is not one; undefined when there is none. */
  readonly openTty?: () => Readable | undefined;
}

function defaultOpenTty(): Readable | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const stream = createReadStream('/dev/tty');
    // Opening fails asynchronously when there is no controlling terminal; swallow it, the read sees EOF.
    stream.on('error', () => stream.destroy());
    return stream;
  } catch {
    return undefined;
  }
}

/** A prompter on the real terminal. */
export function terminalPrompter(options: TerminalPrompterOptions): Prompter {
  const input = (hide: boolean): { stream: Readable; terminal: boolean; close: () => void } | undefined => {
    if (options.stdin.isTTY === true) return { stream: options.stdin, terminal: true, close: () => undefined };
    // A piped secret (`printf %s "$TOKEN" | snapwing login --url ...`) is read from stdin, never echoed.
    if (hide) return { stream: options.stdin, terminal: false, close: () => undefined };
    const tty = (options.openTty ?? defaultOpenTty)();
    if (tty === undefined) return undefined;
    return { stream: tty, terminal: false, close: () => tty.destroy() };
  };

  async function ask(question: string, hide: boolean): Promise<string | undefined> {
    const source = input(hide);
    if (source === undefined) return undefined;
    let muted = false;
    const output = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        if (!muted) options.stderr.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input: source.stream, output, terminal: source.terminal });
    return new Promise<string | undefined>((done) => {
      let answered = false;
      rl.on('close', () => {
        source.close();
        if (!answered) {
          if (hide) options.stderr.write('\n');
          done(undefined);
        }
      });
      rl.question(question, (answer) => {
        answered = true;
        if (hide) options.stderr.write('\n');
        rl.close();
        done(answer);
      });
      // The question is written before muting, so only the typed characters are hidden.
      muted = hide;
    });
  }

  return {
    line: (question) => ask(question, false),
    hidden: (question) => ask(question, true),
  };
}

/** A prompter that answers from a list, for tests and scripts; undefined once the list runs out. */
export function scriptedPrompter(answers: readonly string[]): Prompter & { readonly asked: readonly string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (question: string): Promise<string | undefined> => {
    asked.push(question);
    return Promise.resolve(queue.shift());
  };
  return { line: next, hidden: next, asked };
}
