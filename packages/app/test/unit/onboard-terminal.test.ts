import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { terminalPrompter } from '../../src/cli/prompt.ts';
import { InterviewAborted } from '../../src/onboard/interview/io.ts';
import { createTerminalIO, parseAnswers } from '../../src/onboard/interview/terminal.ts';

const stderr = { write: () => true } as unknown as NodeJS.WritableStream;

/** A terminal opener that fails the way a missing /dev/tty does: ENXIO, reported on the stream. */
function enxioTty(opened: { count: number }): () => Readable {
  return () => {
    opened.count += 1;
    const stream = new Readable({ read() {} });
    queueMicrotask(() => stream.destroy(Object.assign(new Error("ENXIO: no such device or address, open '/dev/tty'"), { code: 'ENXIO' })));
    return stream;
  };
}

function setup(answers?: string) {
  const opened = { count: 0 };
  const said: string[] = [];
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: false });
  stdin.push(null);
  const prompter = terminalPrompter({ stdin, stderr, openTty: enxioTty(opened) });
  const io = createTerminalIO({ prompter, say: (l) => said.push(l), ...(answers === undefined ? {} : { answers: parseAnswers(answers) }) });
  return { io, opened, said };
}

describe('onboard without a terminal', () => {
  it('stops with a clear message instead of crashing on ENXIO', async () => {
    const { io, opened, said } = setup();
    await expect(io.ask({ id: 'jira.site', text: 'Site?' })).rejects.toBeInstanceOf(InterviewAborted);
    expect(opened.count).toBe(1);
    expect(said.join('\n')).toMatch(/no terminal.*--answers/);
  });

  it('reads a hidden value from piped stdin without opening a terminal', async () => {
    const opened = { count: 0 };
    const stdin = Object.assign(Readable.from(['tok-123\n']), { isTTY: false });
    const prompter = terminalPrompter({ stdin, stderr, openTty: enxioTty(opened) });
    const io = createTerminalIO({ prompter, say: () => undefined });
    const secret = await io.secret({ id: 'jira.token', text: 'Token?' });
    expect(secret.reveal()).toBe('tok-123');
    expect(opened.count).toBe(0);
  });

  it('runs an --answers file that answers every question with no terminal at all', async () => {
    const { io, opened, said } = setup('{"jira":{"site":"acme","token":"x"}}');
    expect(await io.ask({ id: 'jira.site', text: 'Site?' })).toBe('acme');
    expect((await io.secret({ id: 'jira.token', text: 'Token?' })).reveal()).toBe('x');
    expect(opened.count).toBe(0);
    expect(said.join('\n')).not.toContain('no terminal');
  });
});
