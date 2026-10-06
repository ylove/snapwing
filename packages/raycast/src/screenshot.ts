import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Image types the vision pass reads; macOS screenshots are png by default. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface ScreenshotImage {
  /** Base64, no data: prefix. */
  readonly image: string;
  readonly mimeType: string;
  readonly path: string;
}

export interface ScreenshotDeps {
  /** The macOS screenshots folder: the `com.apple.screencapture` location, else the Desktop. */
  readonly screenshotsDir: () => Promise<string>;
  readonly listDir: (dir: string) => Promise<readonly string[]>;
  readonly mtimeMs: (path: string) => Promise<number>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
}

export function mimeTypeFor(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

export async function macScreenshotsDir(): Promise<string> {
  try {
    const { stdout } = await run('defaults', ['read', 'com.apple.screencapture', 'location']);
    const raw = stdout.trim();
    if (raw.length > 0) return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
  } catch {
    // The preference is unset until someone changes it; the default is the Desktop.
  }
  return join(homedir(), 'Desktop');
}

export const defaultScreenshotDeps: ScreenshotDeps = {
  screenshotsDir: macScreenshotsDir,
  listDir: (dir) => readdir(dir),
  mtimeMs: async (path) => (await stat(path)).mtimeMs,
  readFile: (path) => readFile(path),
};

/** The newest image file in the screenshots folder, or undefined when there is none or the folder is unreadable. */
export async function newestScreenshot(deps: ScreenshotDeps = defaultScreenshotDeps): Promise<string | undefined> {
  let dir: string;
  let names: readonly string[];
  try {
    dir = await deps.screenshotsDir();
    names = await deps.listDir(dir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const name of names) {
    if (name.startsWith('.') || mimeTypeFor(name) === undefined) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = await deps.mtimeMs(path);
    } catch {
      continue;
    }
    if (best === undefined || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path;
}

export async function loadImage(
  path: string,
  deps: Pick<ScreenshotDeps, 'readFile'> = defaultScreenshotDeps,
): Promise<ScreenshotImage | undefined> {
  const mimeType = mimeTypeFor(path);
  if (mimeType === undefined) return undefined;
  const bytes = await deps.readFile(path);
  return { image: Buffer.from(bytes).toString('base64'), mimeType, path };
}
