// The one `.env` writer (main 22.3): onboarding and the bootstrap scripts
// (`scripts/github-bootstrap.ts`, `scripts/slack-test-users.ts`) set keys through `upsertEnv`, so a
// value is quoted one way and reads back through `parseDotenv` (`providers/local/secrets.ts`, the
// local SecretsPort) unchanged. Secrets go to `.env` in the working directory, where `snapwing
// serve` reads them (`--env-file`, default `.env`), and nowhere else: never the map, the config, or
// the onboarding state.

import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
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
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(tmp, next, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
