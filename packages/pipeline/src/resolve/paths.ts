// File paths in pasted text, matched against the repo trees of the map's surfaces (main 15.3: "Surface
// inference for Raycast uses file paths in the pasted text matched against repo trees in the map").
// `extractPaths` is pure; `matchPath` takes trees from an injected `RepoTrees`, so a GitHub-backed source
// (the git trees API) and a later local-checkout source plug in the same way.

/**
 * Every file path in a repository at its default branch, relative to the repo root and separated by
 * `/`, for a map repo (`github.com/acme/web`). Undefined when the tree cannot be read (no access, no
 * such repo, the source is down); the file-path step then treats that repo as unknown.
 */
export type RepoTrees = (repo: string) => Promise<readonly string[] | undefined>;

export interface ExtractPathsOptions {
  /**
   * Directory names that mark a repo root inside an absolute path, usually the map's repo names
   * (`web` for `github.com/acme/web`): `/home/dana/code/web/src/cart/total.ts` becomes `src/cart/total.ts`.
   */
  roots?: readonly string[];
}

/** At most this many paths per text: a long log is not worth scanning past its first frames. */
export const MAX_PATHS = 50;

/** Segments that mean a dependency, not the repo's own code. */
const DEPENDENCY_SEGMENTS = new Set(['node_modules', 'site-packages', 'dist-packages', 'bower_components', '.pnpm']);

/** Absolute prefixes where builds and containers put a checkout; stripped when no named root matches. */
const DEPLOY_ROOTS: readonly (readonly string[])[] = [
  ['usr', 'src', 'app'],
  ['home', 'runner', 'work', '*', '*'],
  ['github', 'workspace'],
  ['var', 'task'],
  ['opt', 'app'],
  ['srv', 'app'],
  ['workspace'],
  ['app'],
];

/** Characters that end a path token in prose, traces, and logs. */
const TOKEN = /[^\s"'`()<>[\]{},;|]+/g;
const SEGMENT = /^[\w.@+~$-]+$/;
const FILE_NAME = /^[\w.@+~$-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/**
 * File paths named in `text`, in order of appearance, deduplicated, relative to a repo root where one
 * is recognised. Reads stack frames (`at fn (src/cart/total.ts:42:7)`), Python frames
 * (`File "app/views.py", line 3`), source-map URLs (`webpack:///./src/...`), `file://` and `https://`
 * URLs, and Windows separators. Drops dependencies (`node_modules`, `site-packages`), Node internals
 * (`node:internal/...`), line and column suffixes, query strings and fragments, and leading `./`.
 * An absolute path loses its prefix up to the first segment named in `options.roots`, else up to a
 * known deploy root (`/app/`, `/usr/src/app/`, a GitHub runner's `/home/runner/work/x/x/`); with
 * neither it is kept without its leading `/` or drive, for `matchPath` to match by suffix.
 * A token needs a separator and a file name with an extension: a bare `views.py` is too ambiguous.
 */
export function extractPaths(text: string, options: ExtractPathsOptions = {}): string[] {
  const roots = new Set((options.roots ?? []).map((r) => r.toLowerCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const [token] of text.matchAll(TOKEN)) {
    const path = normalizeToken(token, roots);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    found.push(path);
    if (found.length >= MAX_PATHS) break;
  }
  return found;
}

function normalizeToken(token: string, roots: ReadonlySet<string>): string | undefined {
  let t = token;
  if (/^node:/i.test(t)) return undefined;
  if (!/[\\/]/.test(t)) return undefined;
  // Scheme prefixes: a source map's namespace and a URL's host say nothing about the repo path.
  t = t
    .replace(/^webpack(?:-internal)?:\/\/[^/]*\//i, '')
    .replace(/^file:\/\/(?:localhost)?/i, '')
    .replace(/^https?:\/\/[^/]*/i, '');
  t = t.replace(/[?#].*$/, ''); // query string, fragment
  t = t.replace(/[.:!]+$/, ''); // sentence punctuation after the path
  t = t.replace(/(?::\d+){1,2}$/, ''); // :line, :line:col
  t = t.replace(/[.:]+$/, '');
  t = t.replace(/\\/g, '/');
  let absolute = false;
  if (/^\/[A-Za-z]:\//.test(t)) t = t.slice(1); // file:///C:/...
  if (/^[A-Za-z]:\//.test(t)) {
    t = t.slice(2);
    absolute = true;
  }
  if (t.startsWith('/') || t.startsWith('~/')) absolute = true;
  let segments = t.split('/').filter((s) => s !== '' && s !== '.' && s !== '~');
  while (segments[0] === '..') segments = segments.slice(1);
  if (segments.length === 0 || segments.includes('..')) return undefined;
  if (segments.some((s) => DEPENDENCY_SEGMENTS.has(s))) return undefined;
  if (absolute) segments = stripAbsolutePrefix(segments, roots);
  const name = segments.at(-1);
  if (name === undefined || !FILE_NAME.test(name)) return undefined;
  if (!segments.every((s) => SEGMENT.test(s))) return undefined;
  return segments.join('/');
}

function stripAbsolutePrefix(segments: string[], roots: ReadonlySet<string>): string[] {
  // A named root anywhere but the file name itself: the first one, so a repo with a directory of its
  // own name (`/srv/web/src/web/x.ts`) keeps it; a runner's doubled `web/web/` is left for the suffix match.
  const at = segments.slice(0, -1).findIndex((s) => roots.has(s.toLowerCase()));
  if (at >= 0) return segments.slice(at + 1);
  for (const root of DEPLOY_ROOTS) {
    if (segments.length > root.length && root.every((r, i) => r === '*' || segments[i] === r)) return segments.slice(root.length);
  }
  return segments;
}

/** One repo's tree, indexed once per resolution. */
export interface IndexedTree {
  entries: readonly string[];
  set: ReadonlySet<string>;
}

export function indexTree(entries: readonly string[]): IndexedTree {
  return { entries, set: new Set(entries) };
}

export interface PathMatch {
  /** The repos whose tree holds the path at the best tier found. */
  repos: string[];
  /** The tree entry matched in each of those repos (repo-relative). */
  entries: Map<string, string>;
}

/**
 * Which repos hold `path`. An exact entry outranks a suffix match, so a path that is exact in one repo
 * and only a suffix in another names the first. Suffix matches, on segment boundaries: the path ends
 * with a multi-segment entry (an absolute prefix no root stripped), or an entry ends with a multi-segment
 * path (a monorepo package that ran from its own directory). Undefined when no tree holds it.
 */
export function matchPath(path: string, trees: ReadonlyMap<string, IndexedTree>): PathMatch | undefined {
  const exact = new Map<string, string>();
  const suffix = new Map<string, string>();
  const tails = segmentTails(path);
  const multiSegment = path.includes('/');
  for (const [repo, tree] of trees) {
    if (tree.set.has(path)) {
      exact.set(repo, path);
      continue;
    }
    const tail = tails.find((t) => tree.set.has(t));
    if (tail !== undefined) {
      suffix.set(repo, tail);
      continue;
    }
    if (multiSegment) {
      const entry = tree.entries.find((e) => e.endsWith(`/${path}`));
      if (entry !== undefined) suffix.set(repo, entry);
    }
  }
  const best = exact.size > 0 ? exact : suffix;
  return best.size === 0 ? undefined : { repos: [...best.keys()], entries: best };
}

/** `a/b/c/d.ts` gives `b/c/d.ts`, `c/d.ts`: proper tails of at least two segments. */
function segmentTails(path: string): string[] {
  const segments = path.split('/');
  const tails: string[] = [];
  for (let i = 1; i <= segments.length - 2; i++) tails.push(segments.slice(i).join('/'));
  return tails;
}
