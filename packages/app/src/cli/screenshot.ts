// Finds the image `snapwing shot` sends (main 15.4): the file named on the command line, else the
// clipboard image, else the newest screenshot on disk.
//
//   macOS   clipboard through `osascript` (PNG); disk in the `com.apple.screencapture` location
//           (`defaults read com.apple.screencapture location`), default ~/Desktop
//   Linux   clipboard through `wl-paste` (Wayland) or `xclip` (X11); disk in ~/Pictures/Screenshots
//           and ~/Pictures
//
// Every outside effect (running a command, reading a directory) goes through `ScreenshotDeps`, so the
// unit tests drive each platform on any machine.

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';

export interface FoundImage {
  readonly data: Buffer;
  readonly mimeType: string;
  /** Where it came from, for the line the CLI prints before sending. */
  readonly origin: 'file' | 'clipboard' | 'disk';
  /** The file, for `file` and `disk`. */
  readonly path?: string;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: Buffer;
}

export interface ScreenshotDeps {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Runs a command; resolves undefined when it is not installed. */
  readonly run: (command: string, args: readonly string[]) => Promise<CommandResult | undefined>;
}

export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
};

/** The image type from the first bytes, else undefined. */
export function sniffImageType(data: Uint8Array): string | undefined {
  const at = (i: number): number | undefined => data[i];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  const ascii = (from: number, to: number): string => Buffer.from(data.subarray(from, to)).toString('latin1');
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && ascii(4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1)$/.test(ascii(8, 12))) return 'image/heic';
  if ((at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a) || (at(0) === 0x4d && at(1) === 0x4d && at(3) === 0x2a)) {
    return 'image/tiff';
  }
  return undefined;
}

function isImageName(name: string): boolean {
  return EXTENSION_TYPES[extname(name).toLowerCase()] !== undefined;
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Reads a named file and checks that it is an image. */
export async function readImageFile(file: string, deps: Pick<ScreenshotDeps, 'cwd' | 'home'>): Promise<FoundImage> {
  const path = resolve(deps.cwd, expandHome(file, deps.home));
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    throw new ScreenshotError(`Cannot read ${path}.`);
  }
  const mimeType = sniffImageType(data) ?? EXTENSION_TYPES[extname(path).toLowerCase()];
  if (mimeType === undefined) throw new ScreenshotError(`${path} is not an image.`);
  return { data, mimeType, origin: 'file', path };
}

/** The clipboard image as PNG, or undefined when the clipboard holds none (or no tool can read it). */
export async function readClipboardImage(deps: ScreenshotDeps): Promise<FoundImage | undefined> {
  const found = (data: Buffer): FoundImage | undefined => {
    const mimeType = sniffImageType(data);
    return mimeType === undefined ? undefined : { data, mimeType, origin: 'clipboard' };
  };
  if (deps.platform === 'darwin') {
    const out = await deps.run('osascript', ['-e', 'the clipboard as «class PNGf»']);
    if (out === undefined || out.code !== 0) return undefined;
    // AppleScript prints raw data as «data PNGf89504E47...».
    const match = /«data PNGf([0-9A-Fa-f]+)»/.exec(out.stdout.toString('utf8'));
    return match?.[1] === undefined ? undefined : found(Buffer.from(match[1], 'hex'));
  }
  if (deps.platform === 'linux') {
    const tries: readonly (readonly [string, readonly string[]])[] = [
      ...(deps.env['WAYLAND_DISPLAY'] === undefined ? [] : [['wl-paste', ['--no-newline', '--type', 'image/png']] as const]),
      ['xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out']],
    ];
    for (const [command, args] of tries) {
      const out = await deps.run(command, args);
      if (out !== undefined && out.code === 0 && out.stdout.length > 0) {
        const image = found(out.stdout);
        if (image !== undefined) return image;
      }
    }
  }
  return undefined;
}

/** The folders `shot` looks in for the newest screenshot, in order. */
export async function screenshotFolders(deps: ScreenshotDeps): Promise<readonly string[]> {
  if (deps.platform === 'darwin') {
    const out = await deps.run('defaults', ['read', 'com.apple.screencapture', 'location']);
    const configured = out !== undefined && out.code === 0 ? out.stdout.toString('utf8').trim() : '';
    if (configured !== '') {
      const dir = expandHome(configured, deps.home);
      return [isAbsolute(dir) ? dir : join(deps.home, dir)];
    }
    return [join(deps.home, 'Desktop')];
  }
  if (deps.platform === 'linux') {
    return [join(deps.home, 'Pictures', 'Screenshots'), join(deps.home, 'Pictures')];
  }
  return [];
}

/** The newest image file directly inside any of `folders`, or undefined. */
export async function newestImage(folders: readonly string[]): Promise<string | undefined> {
  let best: { path: string; mtime: number } | undefined;
  for (const folder of folders) {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || !isImageName(name)) continue;
      const path = join(folder, name);
      try {
        const info = await stat(path);
        if (info.isFile() && (best === undefined || info.mtimeMs > best.mtime)) best = { path, mtime: info.mtimeMs };
      } catch {
        // Gone between readdir and stat; skip it.
      }
    }
  }
  return best?.path;
}

/** The given file, else the clipboard image, else the newest screenshot on disk. */
export async function findScreenshot(file: string | undefined, deps: ScreenshotDeps): Promise<FoundImage> {
  if (file !== undefined) return readImageFile(file, deps);
  const clipboard = await readClipboardImage(deps);
  if (clipboard !== undefined) return clipboard;
  const folders = await screenshotFolders(deps);
  const newest = await newestImage(folders);
  if (newest === undefined) {
    const where = folders.length === 0 ? '' : ` in ${folders.join(' or ')}`;
    throw new ScreenshotError(`No image on the clipboard and no screenshot${where}. Name a file: snapwing shot <file>.`);
  }
  const image = await readImageFile(newest, deps);
  return { ...image, origin: 'disk' };
}

/** Runs a command for the real CLI, collecting stdout as bytes; undefined when it is not installed. */
export function runCommand(command: string, args: readonly string[]): Promise<CommandResult | undefined> {
  return new Promise((done) => {
    execFile(command, [...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        done(undefined);
        return;
      }
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      done({ code, stdout });
    });
  });
}
