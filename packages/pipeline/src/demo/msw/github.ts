// DEMO ONLY (`pnpm demo`, main 14.3 reviewer demo mode). A fake GitHub REST API behind MSW, and the
// read-only RepoReader the triage scout (main 8.1) reads it through. The real GitHub App client is
// phase 3; nothing outside src/demo/ may import this file.
//
// Mock side: repositories from the recordings, served on `GET /search/code` (with text matches) and
// `GET /repos/{owner}/{repo}/contents/{path}` (base64), checked against a fake installation token.

import { http, HttpResponse, type HttpHandler } from 'msw';
import type { Resolution } from '../../contracts/incident.ts';
import type { RepoReader, RepoSearchHit } from '../../triage/scout.ts';
import type { TraceSink } from './slack.ts';

export const GITHUB_API = 'https://api.github.com';
/** An obvious fake; the mock refuses anything else. */
export const DEMO_GITHUB_TOKEN = 'demo-installation-token';

/** Files by path, per repository full name (`acme/web`). */
export type DemoRepos = Readonly<Record<string, Readonly<Record<string, string>>>>;

export class GitHubWorld {
  readonly repos = new Map<string, Map<string, string>>();

  constructor(private readonly trace: TraceSink) {}

  addRepos(repos: DemoRepos): void {
    for (const [name, files] of Object.entries(repos)) {
      const repo = this.repos.get(name) ?? new Map<string, string>();
      for (const [path, content] of Object.entries(files)) repo.set(path, content);
      this.repos.set(name, repo);
    }
  }

  note(text: string): void {
    this.trace('github', text);
  }
}

function authorized(request: Request): boolean {
  return request.headers.get('authorization') === `Bearer ${DEMO_GITHUB_TOKEN}`;
}

const BAD_CREDENTIALS = { message: 'Bad credentials' };

export function githubHandlers(world: GitHubWorld): HttpHandler[] {
  return [
    http.get(`${GITHUB_API}/search/code`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json(BAD_CREDENTIALS, { status: 401 });
      const q = new URL(request.url).searchParams.get('q') ?? '';
      const repoName = /(?:^|\s)repo:(\S+)/.exec(q)?.[1] ?? '';
      const terms = q.replace(/(?:^|\s)repo:\S+/, '').trim().toLowerCase();
      const repo = world.repos.get(repoName);
      const items: unknown[] = [];
      for (const [path, content] of repo ?? []) {
        const line = content.split('\n').find((l) => l.toLowerCase().includes(terms));
        if (terms === '' || (line === undefined && !path.toLowerCase().includes(terms))) continue;
        items.push({
          name: path.split('/').pop(),
          path,
          repository: { full_name: repoName },
          text_matches: line === undefined ? [] : [{ fragment: line.trim() }],
        });
      }
      world.note(`GET /search/code "${terms}" in ${repoName}: ${items.length} ${items.length === 1 ? 'hit' : 'hits'}`);
      return HttpResponse.json({ total_count: items.length, incomplete_results: false, items });
    }),
    http.get(`${GITHUB_API}/repos/:owner/:repo/contents/*`, ({ request, params }) => {
      if (!authorized(request)) return HttpResponse.json(BAD_CREDENTIALS, { status: 401 });
      const name = `${String(params['owner'])}/${String(params['repo'])}`;
      const path = String(params['0']);
      const content = world.repos.get(name)?.get(path);
      if (content === undefined) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      world.note(`GET /repos/${name}/contents/${path}`);
      return HttpResponse.json({ type: 'file', path, encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') });
    }),
  ];
}

// Client side -------------------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function github(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { authorization: `Bearer ${DEMO_GITHUB_TOKEN}`, accept: 'application/vnd.github.text-match+json' },
  });
  if (!res.ok) throw new Error(`github GET ${path}: HTTP ${res.status}`);
  return asRecord(await res.json());
}

class DemoRepoReader implements RepoReader {
  constructor(private readonly fullName: string) {}

  async search(query: string): Promise<RepoSearchHit[]> {
    const body = await github(`/search/code?q=${encodeURIComponent(`${query} repo:${this.fullName}`)}`);
    const items = Array.isArray(body['items']) ? body['items'].map(asRecord) : [];
    return items.map((item) => {
      const matches = Array.isArray(item['text_matches']) ? item['text_matches'].map(asRecord) : [];
      const fragment = matches[0]?.['fragment'];
      return { path: String(item['path']), ...(typeof fragment === 'string' ? { snippet: fragment } : {}) };
    });
  }

  async read(path: string): Promise<string> {
    const body = await github(`/repos/${this.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
    return Buffer.from(String(body['content']), 'base64').toString('utf8');
  }
}

/** The engine's `repoReader`: a reader for `github.com/<owner>/<repo>`, or none for any other repo. */
export function demoRepoReader(resolution: Resolution): RepoReader | undefined {
  const match = /^(?:https:\/\/)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(resolution.repo ?? '');
  return match?.[1] === undefined ? undefined : new DemoRepoReader(match[1]);
}
