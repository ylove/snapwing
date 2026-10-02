// The `local` SecretsPort (main 14.3): secrets from a `.env` file (for example `.env.live`, which is
// gitignored; build/CONTEXT.md 6b). Values are never logged and never appear in an error message.
//
// Lookup: the file first, then `fallbackEnv` (default `process.env`), so CI, which exports
// repository secrets as environment variables, needs no file. An empty value counts as unset. A
// missing file counts as empty. The file is read once, on the first `get`; `reload()` reads it again.
//
// The `.env` dialect: one `KEY=value` per line; blank lines and lines starting with `#` are skipped;
// an optional `export ` prefix is ignored; keys match `[A-Za-z_][A-Za-z0-9_]*`. A value is
// - unquoted: up to the end of the line or a ` #` comment, trimmed;
// - single-quoted: literal up to the closing `'`, may span lines;
// - double-quoted: up to the closing unescaped `"`, may span lines (a PEM private key), with the
//   escapes `\n`, `\r`, `\t`, `\\`, and `\"`.
// A later line for the same key wins. Anything else throws `DotenvParseError` naming the line.

import { readFile } from 'node:fs/promises';
import { SecretNotFoundError, type SecretsPort } from '../../ports/secrets.ts';

export class DotenvParseError extends Error {
  readonly line: number;

  constructor(path: string, line: number, why: string) {
    super(`${path}:${line}: ${why}`);
    this.name = 'DotenvParseError';
    this.line = line;
  }
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };

/** Parses `.env` text (see the file header). `source` names the file in errors. */
export function parseDotenv(text: string, source = '.env'): Map<string, string> {
  const out = new Map<string, string>();
  const src = text.replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;

  const fail = (why: string): never => {
    throw new DotenvParseError(source, line, why);
  };

  while (i < src.length) {
    const eol = src.indexOf('\n', i);
    const end = eol === -1 ? src.length : eol;
    const raw = src.slice(i, end);
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i = end + 1;
      line += 1;
      continue;
    }

    const startLine = line;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) fail('expected KEY=value');
    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) fail('invalid key');

    // Position of the value's first character in `src`.
    const leading = raw.length - raw.trimStart().length;
    let j = i + leading + (trimmed.length - body.length) + eq + 1;
    while (j < end && (src[j] === ' ' || src[j] === '\t')) j += 1;
    const quote = src[j];

    let value: string;
    let after: number;
    if (quote === '"' || quote === "'") {
      let k = j + 1;
      value = '';
      for (;;) {
        if (k >= src.length) {
          line = startLine;
          fail(`unterminated ${quote === '"' ? 'double' : 'single'} quote`);
        }
        const ch = src.charAt(k);
        if (ch === quote) break;
        if (ch === '\n') line += 1;
        if (quote === '"' && ch === '\\') {
          const next = src.charAt(k + 1);
          const mapped = ESCAPES[next];
          if (mapped !== undefined) {
            value += mapped;
            k += 2;
            continue;
          }
        }
        value += ch;
        k += 1;
      }
      after = k + 1;
      const restEnd = src.indexOf('\n', after);
      const rest = src.slice(after, restEnd === -1 ? src.length : restEnd).trim();
      if (rest !== '' && !rest.startsWith('#')) fail('unexpected text after the closing quote');
      after = restEnd === -1 ? src.length : restEnd;
    } else {
      const rest = src.slice(j, end);
      const comment = rest.search(/\s#/);
      value = (comment === -1 ? rest : rest.slice(0, comment)).trim();
      after = end;
    }

    out.set(key, value);
    i = after + 1;
    line += 1;
  }
  return out;
}

export interface EnvFileSecretsOptions {
  /** The `.env` file. */
  path: string;
  /** Consulted when the file has no value. Default `process.env`; pass `{}` to use the file alone. */
  fallbackEnv?: Readonly<Record<string, string | undefined>>;
}

export interface EnvFileSecrets extends SecretsPort {
  /** Reads the file again on the next `get`. */
  reload(): void;
}

export function createEnvFileSecrets(options: EnvFileSecretsOptions): EnvFileSecrets {
  const fallback = options.fallbackEnv ?? process.env;
  let loaded: Promise<Map<string, string>> | undefined;

  const load = async (): Promise<Map<string, string>> => {
    let text: string;
    try {
      text = await readFile(options.path, 'utf8');
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return new Map();
      throw e;
    }
    return parseDotenv(text, options.path);
  };

  return {
    async get(name) {
      loaded ??= load();
      let values: Map<string, string>;
      try {
        values = await loaded;
      } catch (e) {
        loaded = undefined;
        throw e;
      }
      const fromFile = values.get(name);
      if (fromFile !== undefined && fromFile !== '') return fromFile;
      const fromEnv = fallback[name];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      throw new SecretNotFoundError(name, `${options.path} or the environment`);
    },
    reload() {
      loaded = undefined;
    },
  };
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}
