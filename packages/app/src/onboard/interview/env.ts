// The one `.env` writer (main 22.3): onboarding and the bootstrap scripts
// (`scripts/github-bootstrap.ts`, `scripts/slack-test-users.ts`) set keys through `upsertEnv`, so a
// value is quoted one way and reads back through `parseDotenv` (`providers/local/secrets.ts`, the
// local SecretsPort) unchanged. Secrets go to `.env` in the working directory, where `snapwing
// serve` reads them (`--env-file`, default `.env`), and nowhere else: never the map, the config, or
// the onboarding state.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function needsQuotes(value: string): boolean {
  return !/^[A-Za-z0-9_./:@+=,-]*$/.test(value);
}

function formatEnvValue(value: string): string {
  if (!needsQuotes(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** End offset (exclusive, past the line's newline) of the definition that starts at `start`. */
function definitionEnd(text: string, start: number, valueStart: number): number {
  let i = valueStart;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  if (text[i] === '"') {
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
  }
  const eol = text.indexOf('\n', Math.max(i, start));
  return eol === -1 ? text.length : eol + 1;
}

/**
 * Sets `entries` in `.env`-dialect `text`, keeping every other line. A key already present is replaced in place (its
 * later duplicates dropped); a new key is appended. Multi-line double-quoted values (a PEM) are replaced whole.
 */
export function upsertEnv(text: string, entries: Readonly<Record<string, string>>): string {
  let out = text.replace(/\r\n?/g, '\n');
  for (const [key, value] of Object.entries(entries)) {
    if (!KEY.test(key)) throw new Error(`upsertEnv: ${JSON.stringify(key)} is not an environment variable name`);
    const rendered = `${key}=${formatEnvValue(value)}\n`;
    const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`, 'gm');
    let result = '';
    let cursor = 0;
    let replaced = false;
    for (let m = re.exec(out); m !== null; m = re.exec(out)) {
      const end = definitionEnd(out, m.index, m.index + m[0].length);
      result += out.slice(cursor, m.index) + (replaced ? '' : rendered);
      replaced = true;
      cursor = end;
      re.lastIndex = end;
    }
    result += out.slice(cursor);
    if (!replaced) result = (result === '' || result.endsWith('\n') ? result : `${result}\n`) + rendered;
    out = result;
  }
  return out;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Sets `entries` in the `.env` file at `path` through `upsertEnv`, keeping every other line. The
 * file is written whole to a sibling and renamed over the old one, so a crash leaves either the old
 * file or the new one, and it is mode 0600 afterwards whatever it was before. Errors never carry a
 * value.
 */
export async function writeEnvFile(path: string, entries: Readonly<Record<string, string>>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const next = upsertEnv(await readIfExists(path), entries);
  await writeFileAtomic(path, next);
}

/**
 * Writes `text` to `path` mode 0600 through a sibling temp file: random name, created exclusively
 * (`wx`, so a planted file or link is never followed), renamed into place, and removed if anything fails.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** The synchronous twin of {@link writeFileAtomic}, for the bootstrap scripts. */
export function writeFileAtomicSync(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * A one-line warning when `envPath` sits in a checkout and the checkout would not ignore it, so the
 * first `add .` would commit the secrets. Undefined when it is ignored, or when there is no checkout.
 */
export function envNotIgnoredWarning(envPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', basename(envPath)], { cwd: dirname(envPath), timeout: 5000 }, (error) => {
      // Exit 0: ignored. Exit 1: inside a checkout and not ignored. Anything else (128, no program): say nothing.
      const code = (error as (Error & { code?: unknown }) | null)?.code;
      resolve(code === 1 ? `${basename(envPath)} is not ignored by git. Add it to .gitignore before you commit, or your secrets will be committed.` : undefined);
    });
  });
}
