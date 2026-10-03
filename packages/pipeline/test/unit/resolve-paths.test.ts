import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalIncidentPayload, ContextBundle, Resolution, SourceMessage } from '../../src/contracts/incident.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { resolve, STEP_CONFIDENCE } from '../../src/resolve/index.ts';
import { extractPaths, indexTree, matchPath } from '../../src/resolve/paths.ts';
import type { RepoTrees } from '../../src/resolve/paths.ts';

const exampleXml = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

describe('extractPaths', () => {
  const rows: { name: string; text: string; roots?: string[]; expected: string[] }[] = [
    {
      name: 'a TypeScript stack frame, line and column dropped',
      text: 'TypeError: x is undefined\n    at total (src/cart/total.ts:42:7)\n    at Object.<anonymous> (src/cart/index.ts:3:1)',
      expected: ['src/cart/total.ts', 'src/cart/index.ts'],
    },
    {
      name: 'a Python frame',
      text: 'Traceback (most recent call last):\n  File "app/views.py", line 3, in index\n    return render(request)',
      expected: ['app/views.py'],
    },
    {
      name: 'webpack source-map URLs, with and without a namespace, query string dropped',
      text: 'at webpack:///./src/cart/total.ts?3a1f:12:4 and webpack://shop/./src/nav/menu.tsx',
      expected: ['src/cart/total.ts', 'src/nav/menu.tsx'],
    },
    {
      name: 'Windows separators and a drive letter, up to a known repo root',
      text: 'at C:\\Users\\dana\\code\\web\\src\\cart\\total.ts:42:7',
      roots: ['web'],
      expected: ['src/cart/total.ts'],
    },
    {
      name: 'node_modules, site-packages, and Node internals are dropped',
      text: [
        'at run (/srv/web/node_modules/react-dom/cjs/react-dom.development.js:1:1)',
        'File "/usr/lib/python3.12/site-packages/django/core/handlers.py", line 9',
        'at Module._compile (node:internal/modules/cjs/loader.js:1105:14)',
        'at main (src/main.ts:1:1)',
      ].join('\n'),
      expected: ['src/main.ts'],
    },
    {
      name: 'an absolute prefix stops at the first known repo root',
      text: 'at /home/dana/code/admin/app/views.py:3 and /srv/web/src/web/widget.ts',
      roots: ['web', 'admin'],
      expected: ['app/views.py', 'src/web/widget.ts'],
    },
    {
      name: 'deploy roots are stripped with no named root',
      text: 'File "/app/admin_portal/views.py", line 3\nat /usr/src/app/src/cart/total.js:1:1\nat /home/runner/work/web/web/src/x.ts:2:2',
      expected: ['admin_portal/views.py', 'src/cart/total.js', 'src/x.ts'],
    },
    {
      name: 'an unknown absolute prefix is kept without its leading slash, for the suffix match',
      text: 'at /Users/dana/projects/thing/src/cart/total.ts:4:2',
      expected: ['Users/dana/projects/thing/src/cart/total.ts'],
    },
    {
      name: 'URLs lose their host, query, and fragment; file URLs their scheme',
      text: 'see https://cdn.example.test/static/js/main.js?v=3#L2 and file:///C:/work/web/src/a.ts',
      roots: ['web'],
      expected: ['static/js/main.js', 'src/a.ts'],
    },
    {
      name: 'leading ./ and ../ dropped, repeats deduplicated, trailing punctuation ignored',
      text: 'It fails in ./src/cart/total.ts. Also ../src/cart/total.ts and src/cart/total.ts:9!',
      expected: ['src/cart/total.ts'],
    },
    {
      name: 'prose with slashes, bare file names, and extensionless paths are not paths',
      text: 'and/or the TCP/IP stack; views.py looks fine; https://market.example.test/cart is blank; 1.2/3.4',
      expected: [],
    },
  ];

  it.each(rows)('$name', ({ text, roots, expected }) => {
    expect(extractPaths(text, roots === undefined ? {} : { roots })).toEqual(expected);
  });

  it('stops at MAX_PATHS', () => {
    const text = Array.from({ length: 80 }, (_, i) => `at f (src/f${i}.ts:1:1)`).join('\n');
    expect(extractPaths(text)).toHaveLength(50);
  });
});

describe('matchPath', () => {
  const trees = new Map([
    ['github.com/acme/web', indexTree(['src/cart/total.ts', 'src/index.ts', 'package.json'])],
    ['github.com/acme/admin', indexTree(['packages/legacy/src/cart/total.ts', 'packages/legacy/src/old.ts', 'src/index.ts', 'app/views.py'])],
  ]);

  it('an exact entry outranks a suffix match in another repo', () => {
    const match = matchPath('src/cart/total.ts', trees);
    expect(match?.repos).toEqual(['github.com/acme/web']);
  });

  it('a path ending in a multi-segment entry matches it (unknown absolute prefix)', () => {
    const match = matchPath('Users/dana/x/app/views.py', trees);
    expect(match?.repos).toEqual(['github.com/acme/admin']);
    expect(match?.entries.get('github.com/acme/admin')).toBe('app/views.py');
  });

  it('an entry ending in the path matches it (a monorepo package)', () => {
    const match = matchPath('legacy/src/old.ts', trees);
    expect(match?.repos).toEqual(['github.com/acme/admin']);
    expect(match?.entries.get('github.com/acme/admin')).toBe('packages/legacy/src/old.ts');
  });

  it('a single-segment suffix is not a match', () => {
    expect(matchPath('tools/package.json', trees)).toBeUndefined();
  });

  it('a path in both trees names both repos', () => {
    expect(matchPath('src/index.ts', trees)?.repos).toEqual(['github.com/acme/web', 'github.com/acme/admin']);
  });
});

// Repo trees for the main 4.2 example map. `src/index.ts` is in two repos; admin's tree is the Django app.
const TREES: Record<string, readonly string[]> = {
  'github.com/acme/web': ['package.json', 'src/index.ts', 'src/cart/total.ts', 'src/nav/menu.tsx'],
  'github.com/acme/mobile': ['package.json', 'src/index.ts', 'ios/AppDelegate.swift'],
  'github.com/acme/admin': ['manage.py', 'app/views.py', 'app/models.py'],
};

interface Trees {
  repoTrees: RepoTrees;
  calls: string[];
}

function trees(overrides: Record<string, readonly string[] | undefined | 'reject'> = {}): Trees {
  const calls: string[] = [];
  const repoTrees: RepoTrees = (repo) => {
    calls.push(repo);
    const tree = repo in overrides ? overrides[repo] : TREES[repo];
    return tree === 'reject' ? Promise.reject(new Error('tree source down')) : Promise.resolve(tree);
  };
  return { repoTrees, calls };
}

function build(channelId: string, text: string, context: string[] = []): { payload: CanonicalIncidentPayload; bundle: ContextBundle } {
  const message = (id: string, body: string): SourceMessage => ({
    id,
    authorId: 'U0WEBDEV1',
    text: body,
    timestamp: '2026-10-03T09:00:00.000Z',
    mentions: [],
    reactions: [],
    attachments: [],
  });
  return {
    payload: {
      eventId: '01K0000000000000000000R375',
      idempotencyKey: 'test-375',
      source: 'raycast',
      reporter: { id: 'U0WEBDEV1', name: 'Dana', role: 'engineer' },
      anchorText: text,
      context: { channelId, rawPayloadSnapshot: {} },
      timestamp: '2026-10-03T09:00:00.000Z',
    },
    bundle: {
      anchorId: 'anchor',
      included: [...context.map((t, i) => message(`ctx-${i}`, t)), message('anchor', text)],
      excluded: [],
      windowUsed: { oldest: '2026-10-03T08:00:00.000Z', latest: '2026-10-03T09:00:00.000Z', cap: 50 },
    },
  };
}

function run(channelId: string, text: string, t?: Trees, context?: string[]): Promise<Resolution> {
  const { payload, bundle } = build(channelId, text, context);
  return resolve(payload, bundle, map, undefined, t === undefined ? {} : { repoTrees: t.repoTrees });
}

// Raycast captures carry no mapped channel.
const RAYCAST = 'raycast';

const TS_TRACE = 'TypeError: Cannot read properties of undefined\n    at total (src/cart/total.ts:42:7)\n    at render (src/nav/menu.tsx:10:3)';
const PY_TRACE = 'Traceback (most recent call last):\n  File "app/views.py", line 3, in index\n    raise ValueError("boom")';

describe('resolve: the file-path step (main 15.3)', () => {
  it('a TypeScript trace names the website', async () => {
    const t = trees();
    expect(await run(RAYCAST, TS_TRACE, t)).toEqual({
      surfaceId: 'web',
      ownerId: 'webDev1',
      repo: 'github.com/acme/web',
      jiraProject: 'WEB',
      resolvedBy: 'file-path',
      confidence: STEP_CONFIDENCE['file-path'],
      evidence: { path: 'src/cart/total.ts' },
    });
  });

  it('a Python trace names the admin portal, over a vocabulary word for the website', async () => {
    const result = await run('C0SALES', `the site is down:\n${PY_TRACE}`, trees());
    expect(result).toMatchObject({ surfaceId: 'admin', resolvedBy: 'file-path', repo: 'github.com/acme/admin', jiraProject: 'ADM', evidence: { path: 'app/views.py' } });
  });

  it('a path in two repos is a tie and falls through', async () => {
    const text = 'at main (src/index.ts:1:1)';
    expect(await run(RAYCAST, text, trees())).toEqual({ resolvedBy: 'unresolved', confidence: 0 });
    expect(await run('C0SALES', text, trees())).toMatchObject({ surfaceId: 'admin', resolvedBy: 'channel-inferred' });
  });

  it('a path whose repo has no tree falls through, and so does a tree read that fails', async () => {
    expect(await run(RAYCAST, PY_TRACE, trees({ 'github.com/acme/admin': undefined }))).toEqual({ resolvedBy: 'unresolved', confidence: 0 });
    expect(await run(RAYCAST, PY_TRACE, trees({ 'github.com/acme/admin': 'reject' }))).toEqual({ resolvedBy: 'unresolved', confidence: 0 });
    const none = trees({ 'github.com/acme/web': undefined, 'github.com/acme/mobile': undefined, 'github.com/acme/admin': undefined });
    expect(await run(RAYCAST, TS_TRACE, none)).toMatchObject({ resolvedBy: 'vocabulary', surfaceId: 'web' }); // "cart" in the path
  });

  it('a shared path does not block a unique one in the same trace', async () => {
    const result = await run(RAYCAST, 'at main (src/index.ts:1:1)\nat boot (ios/AppDelegate.swift:12)', trees());
    expect(result).toMatchObject({ surfaceId: 'mobile', resolvedBy: 'file-path', evidence: { path: 'ios/AppDelegate.swift' } });
  });

  it('paths in one message that name different surfaces fall through to the next message', async () => {
    const result = await run(RAYCAST, 'web says src/nav/menu.tsx, admin says app/models.py', trees(), ['earlier: File "app/views.py", line 3']);
    expect(result).toMatchObject({ surfaceId: 'admin', resolvedBy: 'file-path', evidence: { path: 'app/views.py' } });
  });

  it('an absolute path resolves through the map repo name as its root, Windows separators included', async () => {
    const result = await run(RAYCAST, 'at C:\\Users\\dana\\code\\admin\\app\\models.py:7', trees());
    expect(result).toMatchObject({ surfaceId: 'admin', resolvedBy: 'file-path', evidence: { path: 'app/models.py' } });
  });

  it('a named owner and an explicit channel outrank a path', async () => {
    expect(await run('C0WEBBUGS', PY_TRACE, trees())).toMatchObject({ surfaceId: 'web', resolvedBy: 'channel-explicit' });
    expect((await run(RAYCAST, `@mobDev ${PY_TRACE}`, trees())).resolvedBy).toBe('mention');
  });

  it('trees are read only when the text names a path, and once per repo', async () => {
    const quiet = trees();
    expect((await run('C0SALES', 'something is wrong', quiet)).resolvedBy).toBe('channel-inferred');
    expect(quiet.calls).toEqual([]);
    const busy = trees();
    await run(RAYCAST, PY_TRACE, busy);
    expect([...busy.calls].sort()).toEqual(['github.com/acme/admin', 'github.com/acme/mobile', 'github.com/acme/web']);
  });

  it('without repo trees the step is skipped and no other step carries evidence', async () => {
    const result = await run(RAYCAST, TS_TRACE);
    expect(result).toMatchObject({ surfaceId: 'web', resolvedBy: 'vocabulary' });
    expect(result.evidence).toBeUndefined();
  });
});
