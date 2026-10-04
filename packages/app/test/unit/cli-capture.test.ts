import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NumberedChoice } from '@snapwing/capture-client/render.ts';
import {
  askChoice,
  findChoice,
  parseChoiceAnswer,
  scriptedPrompter,
  terminalPrompter,
} from '../../src/cli/prompt.ts';
import {
  findScreenshot,
  newestImage,
  readImageFile,
  ScreenshotError,
  sniffImageType,
  type CommandResult,
  type ScreenshotDeps,
} from '../../src/cli/screenshot.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'snapwing-cli-shot-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

type Runner = (command: string, args: readonly string[]) => CommandResult | undefined;

function deps(platform: NodeJS.Platform, runner: Runner = () => undefined, env: Record<string, string> = {}): ScreenshotDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    platform,
    home,
    cwd: home,
    env,
    calls,
    run: (command, args) => {
      calls.push(command);
      return Promise.resolve(runner(command, args));
    },
  };
}

async function image(path: string, bytes: Buffer, ageSeconds: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
  const t = Date.now() / 1000 - ageSeconds;
  await utimes(path, t, t);
}

describe('sniffImageType', () => {
  it('names PNG, JPEG, GIF, and WebP from their first bytes, and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('hello world'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});

describe('readImageFile', () => {
  it('reads a file relative to the working directory and types it from its bytes', async () => {
    await writeFile(join(home, 'error.dat'), PNG);
    const found = await readImageFile('error.dat', { cwd: home, home });
    expect(found).toMatchObject({ mimeType: 'image/png', origin: 'file', path: join(home, 'error.dat') });
    expect(found.data.equals(PNG)).toBe(true);
  });

  it('expands ~ and falls back to the extension', async () => {
    await writeFile(join(home, 'shot.jpg'), Buffer.from('not really'));
    expect((await readImageFile('~/shot.jpg', { cwd: '/', home })).mimeType).toBe('image/jpeg');
  });

  it('refuses a missing file and a file that is not an image', async () => {
    await writeFile(join(home, 'notes.txt'), 'hello');
    await expect(readImageFile('notes.txt', { cwd: home, home })).rejects.toThrow(ScreenshotError);
    await expect(readImageFile('missing.png', { cwd: home, home })).rejects.toThrow(/Cannot read/);
  });
});

describe('findScreenshot', () => {
  it('sends the named file without looking anywhere else', async () => {
    await writeFile(join(home, 'a.png'), PNG);
    const d = deps('darwin');
    const found = await findScreenshot('a.png', d);
    expect(found.origin).toBe('file');
    expect(d.calls).toEqual([]);
  });

  it('macOS: takes the clipboard image from osascript first', async () => {
    const d = deps('darwin', (command, args) => {
      expect(command).toBe('osascript');
      expect(args.join(' ')).toContain('PNGf');
      return { code: 0, stdout: Buffer.from(`«data PNGf${PNG.toString('hex').toUpperCase()}»\n`) };
    });
    const found = await findScreenshot(undefined, d);
    expect(found).toMatchObject({ origin: 'clipboard', mimeType: 'image/png' });
    expect(found.data.equals(PNG)).toBe(true);
  });

  it('macOS: with no clipboard image, the newest image in the screencapture location', async () => {
    await image(join(home, 'Shots', 'old.png'), PNG, 120);
    await image(join(home, 'Shots', 'new.jpg'), JPEG, 10);
    await image(join(home, 'Shots', 'newer.txt'), Buffer.from('x'), 1);
    await image(join(home, 'Shots', '.hidden.png'), PNG, 0);
    await image(join(home, 'Desktop', 'desk.png'), PNG, 0);
    const d = deps('darwin', (command) =>
      command === 'osascript' ? { code: 1, stdout: Buffer.alloc(0) } : { code: 0, stdout: Buffer.from('~/Shots\n') },
    );
    const found = await findScreenshot(undefined, d);
    expect(found).toMatchObject({ origin: 'disk', path: join(home, 'Shots', 'new.jpg'), mimeType: 'image/jpeg' });
    expect(d.calls).toEqual(['osascript', 'defaults']);
  });

  it('macOS: the default location is ~/Desktop', async () => {
    await image(join(home, 'Desktop', 'Screenshot 1.png'), PNG, 5);
    const d = deps('darwin', () => ({ code: 1, stdout: Buffer.alloc(0) }));
    expect((await findScreenshot(undefined, d)).path).toBe(join(home, 'Desktop', 'Screenshot 1.png'));
  });

  it('Linux on Wayland: wl-paste', async () => {
    const d = deps('linux', (command) => (command === 'wl-paste' ? { code: 0, stdout: PNG } : undefined), {
      WAYLAND_DISPLAY: 'wayland-0',
    });
    expect((await findScreenshot(undefined, d)).origin).toBe('clipboard');
    expect(d.calls).toEqual(['wl-paste']);
  });

  it('Linux on X11: xclip, never wl-paste', async () => {
    const d = deps('linux', (command) => (command === 'xclip' ? { code: 0, stdout: PNG } : undefined));
    expect((await findScreenshot(undefined, d)).origin).toBe('clipboard');
    expect(d.calls).toEqual(['xclip']);
  });

  it('Linux: a clipboard holding no image falls through to ~/Pictures', async () => {
    await image(join(home, 'Pictures', 'holiday.png'), PNG, 300);
    await image(join(home, 'Pictures', 'Screenshots', 'Screenshot.png'), PNG, 30);
    const d = deps('linux', () => ({ code: 0, stdout: Buffer.from('plain text') }), { WAYLAND_DISPLAY: 'w' });
    const found = await findScreenshot(undefined, d);
    expect(found).toMatchObject({ origin: 'disk', path: join(home, 'Pictures', 'Screenshots', 'Screenshot.png') });
    expect(d.calls).toEqual(['wl-paste', 'xclip']);
  });

  it('Linux: no clipboard tool installed reads ~/Pictures', async () => {
    await image(join(home, 'Pictures', 'only.png'), PNG, 30);
    expect((await findScreenshot(undefined, deps('linux'))).path).toBe(join(home, 'Pictures', 'only.png'));
  });

  it('says where it looked when there is nothing to send', async () => {
    await expect(findScreenshot(undefined, deps('linux'))).rejects.toThrow(/Pictures/);
    await expect(findScreenshot(undefined, deps('win32'))).rejects.toThrow(ScreenshotError);
  });

  it('newestImage skips folders that do not exist', async () => {
    expect(await newestImage([join(home, 'nope')])).toBeUndefined();
  });
});

const CHOICES: readonly NumberedChoice[] = [
  { id: 'file', label: 'File it', number: 1 },
  { id: 'web', label: 'Website', number: 2 },
  { id: 'not-a-bug', label: 'Not a bug', number: 3 },
];

describe('choices', () => {
  it('parseChoiceAnswer reads a number or an id, and nothing else', () => {
    expect(parseChoiceAnswer(' 2 ', CHOICES)?.id).toBe('web');
    expect(parseChoiceAnswer('FILE', CHOICES)?.id).toBe('file');
    expect(parseChoiceAnswer('4', CHOICES)).toBeUndefined();
    expect(parseChoiceAnswer('0', CHOICES)).toBeUndefined();
    expect(parseChoiceAnswer('', CHOICES)).toBeUndefined();
    expect(parseChoiceAnswer('maybe', CHOICES)).toBeUndefined();
  });

  it('findChoice prefers an exact id, then a number', () => {
    expect(findChoice('not-a-bug', CHOICES)?.number).toBe(3);
    expect(findChoice('1', CHOICES)?.id).toBe('file');
  });

  it('askChoice asks again after an answer that names no choice', async () => {
    const prompter = scriptedPrompter(['7', 'web']);
    const warnings: string[] = [];
    expect((await askChoice(prompter, CHOICES, (l) => warnings.push(l)))?.id).toBe('web');
    expect(prompter.asked).toEqual(['Choose 1-3: ', 'Choose 1-3: ']);
    expect(warnings).toEqual(['Type a number from 1 to 3.']);
  });

  it('askChoice gives up after three wrong answers, or at the end of input', async () => {
    expect(await askChoice(scriptedPrompter(['x', 'y', 'z', '1']), CHOICES, () => undefined)).toBeUndefined();
    expect(await askChoice(scriptedPrompter([]), CHOICES, () => undefined)).toBeUndefined();
    expect(await askChoice(scriptedPrompter(['1']), [], () => undefined)).toBeUndefined();
  });
});

describe('terminalPrompter', () => {
  function stderrSink(): { stream: PassThrough; text: () => string } {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('reads a choice from the terminal when stdin is a pipe', async () => {
    const err = stderrSink();
    const prompter = terminalPrompter({
      stdin: Readable.from(['the log on stdin\n']),
      stderr: err.stream,
      openTty: () => Readable.from(['2\n']),
    });
    expect(await prompter.line('Choose 1-3: ')).toBe('2');
    expect(err.text()).toContain('Choose 1-3: ');
  });

  it('answers undefined with no terminal at all', async () => {
    const prompter = terminalPrompter({ stdin: Readable.from([]), stderr: stderrSink().stream, openTty: () => undefined });
    expect(await prompter.line('Choose 1-3: ')).toBeUndefined();
  });

  it('reads a hidden answer from a piped stdin and never writes it', async () => {
    const err = stderrSink();
    const prompter = terminalPrompter({
      stdin: Readable.from(['swc_not_a_real_token\n']),
      stderr: err.stream,
      openTty: () => {
        throw new Error('a hidden answer never opens the terminal when stdin is piped');
      },
    });
    expect(await prompter.hidden('Capture token: ')).toBe('swc_not_a_real_token');
    expect(err.text()).toContain('Capture token: ');
    expect(err.text()).not.toContain('swc_not_a_real_token');
  });
});
