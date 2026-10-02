// CODEOWNERS resolution (main 11.2 step 1). Fetches the file from the places GitHub looks (`.github/`, the root,
// `docs/`, first found wins) and resolves owners per path with last-match-wins semantics. Read-only: the
// installation token needs `contents: read`.

import type { GitHubAuth } from './auth.ts';
import { GitHubNotFoundError, createGitHubTransport } from './client.ts';
import type { GitHubClientOptions } from './client.ts';

/** GitHub's lookup order. */
export const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

export interface CodeownersRule {
  pattern: string;
  owners: string[];
  /** Compiled matcher for `pattern`. */
  matches: (path: string) => boolean;
}

export interface CodeownersResult {
  /** The file the rules came from, or `null` when the repository has none. */
  source: string | null;
  /** Owners per requested path (`@user`, `@org/team`, or an email), empty when no rule matches. */
  byPath: Record<string, string[]>;
  /** Union across paths, in first-seen order. */
  owners: string[];
}

function escapeRegex(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Compile a CODEOWNERS (gitignore-style) pattern to a matcher over repo-relative paths with no leading slash. */
export function compilePattern(rawPattern: string): (path: string) => boolean {
  let pattern = rawPattern;
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '*' && pattern.charAt(i + 1) === '*') {
      const atStart = i === 0 || pattern.charAt(i - 1) === '/';
      const next = pattern.charAt(i + 2);
      if (atStart && next === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else if (atStart && next === '') {
        body += '.*';
        i += 1;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else if (ch === '\\' && i + 1 < pattern.length) {
      body += escapeRegex(pattern.charAt(i + 1));
      i += 1;
    } else body += escapeRegex(ch);
  }
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dirOnly ? '/.*' : '(?:/.*)?'}$`);
  return (path) => re.test(path);
}

/** Parse a CODEOWNERS file. A pattern with no owners is kept: it unsets ownership for what it matches. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('[')) continue;
    // Split on unescaped whitespace; a `#` starting a token begins a trailing comment.
    const tokens = line.split(/(?<!\\)\s+/);
    const pattern = tokens[0];
    if (pattern === undefined || pattern === '') continue;
    const owners: string[] = [];
    for (const token of tokens.slice(1)) {
      if (token.startsWith('#')) break;
      owners.push(token);
    }
    rules.push({ pattern, owners, matches: compilePattern(pattern) });
  }
  return rules;
}

/** Last matching rule wins; no match means no owners. */
export function ownersForPath(rules: readonly CodeownersRule[], path: string): string[] {
  const normalized = path.replace(/^\/+/, '');
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule !== undefined && rule.matches(normalized)) return [...rule.owners];
  }
  return [];
}

export interface CodeownersResolverOptions extends GitHubClientOptions {
  /** Branch, tag, or sha to read the file from; default is the repository's default branch. */
  ref?: string;
}

export interface CodeownersResolver {
  codeownersFor(paths: readonly string[]): Promise<CodeownersResult>;
}

export function createCodeownersResolver(auth: GitHubAuth, options: CodeownersResolverOptions): CodeownersResolver {
  const call = createGitHubTransport(auth, options);

  async function load(): Promise<{ source: string | null; rules: CodeownersRule[] }> {
    for (const location of CODEOWNERS_LOCATIONS) {
      try {
        const res = await call({
          method: 'GET',
          path: `/repos/${options.repo}/contents/${location}`,
          permissions: { contents: 'read' },
          accept: 'application/vnd.github.raw+json',
          ...(options.ref === undefined ? {} : { query: { ref: options.ref } }),
        });
        return { source: location, rules: parseCodeowners(res.text) };
      } catch (err) {
        if (!(err instanceof GitHubNotFoundError)) throw err;
      }
    }
    return { source: null, rules: [] };
  }

  return {
    async codeownersFor(paths) {
      const { source, rules } = await load();
      const byPath: Record<string, string[]> = {};
      const owners = new Set<string>();
      for (const path of paths) {
        const found = ownersForPath(rules, path);
        byPath[path] = found;
        for (const o of found) owners.add(o);
      }
      return { source, byPath, owners: [...owners] };
    },
  };
}
