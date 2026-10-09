// A fake GitHub for the end to end contract test: MSW handlers over real local bare
// repositories. The fixer and review checkouts clone from those repositories (compose's
// `gitRemoteUrl`), the server's fixer hand-off pushes the work branch there (#262), and every pull
// request answer (head sha, changed files, line counts) is read from them with git, so what the review
// job checks out is what GitHub reports.
//
// The fake harness only commits; the server opens the pull request through `POST /pulls` (numbers
// from 1, authored by the App) and finds it again through `GET /pulls?head=`. Everything else the app
// does to a pull request (reviews, check runs, requested reviewers, merge, comments, close) lands in
// memory here too.
//
// Fake CI: the base branch requires `snapwing/review` (the review agent's check run) and `ci/test`,
// which reports success for every head unless a test silences it (`silent`: a required check nothing
// ever reports, CI that never answers). Approving or requesting changes on the App's own pull request
// is refused with 422, as GitHub does, so the review job's COMMENT fallback runs. A merge is the linked
// human's (their user-to-server token) or, at level 3, the App's own (the installation token).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { DEMO_GITHUB_TOKEN } from '@snapwing/pipeline/demo/msw/github.ts';
import { createBareRepo, GIT_ENV, type BareRepo } from '../../../../pipeline/test/helpers/git.ts';

export const GITHUB = 'https://api.github.com';
/** The installation token the fake hands out: the demo world's, so its search and contents handlers accept it. */
export const INSTALLATION_TOKEN = DEMO_GITHUB_TOKEN;
/** The login of the App's bot user (`${GITHUB_APP_SLUG}[bot]`). */
export const BOT_LOGIN = 'snapwing-test[bot]';
/** The check GitHub's fake CI reports green for every head. */
export const CI_CHECK = 'ci/test';
export const REVIEW_CHECK = 'snapwing/review';
/** The App's id (`GITHUB_APP_ID` in world.ts): check runs the App creates carry it, as GitHub's do. */
export const APP_ID = 1001;
/** The app CI's check run comes from (GitHub Actions). */
const CI_APP = { id: 15368, slug: 'github-actions' };

/** A person who links a GitHub account through the OAuth flow. */
export interface GitHubPerson {
  login: string;
  id: number;
  /** The user-to-server token the fake OAuth exchange issues. */
  token: string;
  /** The authorization code that exchanges for `token`. */
  code: string;
  /** The verified primary email GitHub lists for the account; the link flow checks it against the map. */
  email: string;
}

export interface FakePull {
  repo: string;
  number: number;
  head: string;
  base: string;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedBy?: string;
  mergeSha?: string;
  requestedReviewers: string[];
  labels: string[];
  comments: string[];
  reviews: { event: string; body: string; commitId?: string }[];
}

interface CheckRun {
  id: number;
  repo: string;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export class FakeGitHub {
  readonly repos = new Map<string, BareRepo>();
  readonly pulls = new Map<string, FakePull>();
  readonly checkRuns: CheckRun[] = [];
  /** Every request the fake answered, as `METHOD /path`. */
  readonly calls: string[] = [];
  readonly people: GitHubPerson[] = [];
  /** Who opened every pull request: the App's bot user. */
  botLogin = BOT_LOGIN;
  /** Required checks no CI ever reports for any head (so they stay pending). */
  readonly silent = new Set<string>();
  /** Branches the app deleted, as `owner/name:branch`. */
  readonly deletedBranches: string[] = [];

  /** `dir` is the fake harness's world directory, which the tests share with it. */
  constructor(readonly dir: string) {}

  /** A bare repository `owner/name` with `files` committed on `main`. */
  async addRepo(fullName: string, files: Readonly<Record<string, string>>): Promise<void> {
    this.repos.set(fullName, await createBareRepo({ files: { ...files } }));
  }

  /** The clone URL compose uses for `owner/name` (the map's `github.com/owner/name` too). */
  remoteUrl = (repo: string): string => {
    const name = repo.replace(/^(https:\/\/)?github\.com\//, '').replace(/\.git$/, '');
    const bare = this.repos.get(name);
    if (bare === undefined) throw new Error(`fake github: no repository ${repo}`);
    return bare.url;
  };

  pull(repo: string, number: number): FakePull | undefined {
    return this.pulls.get(`${repo}#${number}`);
  }

  async remove(): Promise<void> {
    for (const r of this.repos.values()) await r.remove();
  }

  /** Opens a pull request from `head`, as `POST /pulls` does; numbers count from 1 per repository. */
  open(repo: string, input: { head: string; base: string; title: string }): FakePull {
    const number = [...this.pulls.values()].filter((p) => p.repo === repo).length + 1;
    const pr: FakePull = { repo, number, head: input.head, base: input.base, title: input.title, state: 'open', merged: false, requestedReviewers: [], labels: [], comments: [], reviews: [] };
    this.pulls.set(`${repo}#${number}`, pr);
    return pr;
  }

  private headSha(pr: FakePull): string {
    const bare = this.repos.get(pr.repo);
    if (bare === undefined) throw new Error(`fake github: no repository ${pr.repo}`);
    return git(bare.url, ['rev-parse', `refs/heads/${pr.head}`]);
  }

  private diff(pr: FakePull): { filename: string; status: string; additions: number; deletions: number }[] {
    return this.diffOf(pr.repo, `refs/heads/${pr.base}...refs/heads/${pr.head}`);
  }

  /** The files a `base...head` range changes in `repo`, as GitHub lists them. */
  private diffOf(repo: string, range: string): { filename: string; status: string; additions: number; deletions: number }[] {
    const bare = this.repos.get(repo);
    if (bare === undefined) return [];
    const status = new Map(
      git(bare.url, ['diff', '--name-status', range])
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => {
          const [s, path] = l.split('\t');
          return [path ?? '', s === 'A' ? 'added' : s === 'D' ? 'removed' : 'modified'] as const;
        }),
    );
    return git(bare.url, ['diff', '--numstat', range])
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [add, del, filename] = l.split('\t');
        return { filename: filename ?? '', status: status.get(filename ?? '') ?? 'modified', additions: Number(add), deletions: Number(del) };
      });
  }

  private pullJson(pr: FakePull): Record<string, unknown> {
    const files = this.diff(pr);
    return {
      number: pr.number,
      node_id: `PR_fake_${pr.number}`,
      title: pr.title,
      body: '',
      state: pr.state,
      draft: false,
      merged: pr.merged,
      mergeable: pr.state === 'open',
      merge_commit_sha: pr.mergeSha ?? null,
      html_url: `https://github.com/${pr.repo}/pull/${pr.number}`,
      head: { sha: this.headSha(pr), ref: pr.head, repo: { full_name: pr.repo } },
      base: { ref: pr.base, repo: { full_name: pr.repo } },
      user: { login: this.botLogin },
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      changed_files: files.length,
      requested_reviewers: pr.requestedReviewers.map((login) => ({ login })),
      labels: pr.labels.map((name) => ({ name })),
    };
  }

  handlers(): HttpHandler[] {
    const installation = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${INSTALLATION_TOKEN}`;
    const denied = () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
    const notFound = () => HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    const repoOf = (params: Record<string, unknown>): string => `${String(params['owner'])}/${String(params['repo'])}`;
    const note = (request: Request): void => {
      this.calls.push(`${request.method} ${new URL(request.url).pathname}`);
    };
    const withPull = async (request: Request, params: Record<string, unknown>, fn: (pr: FakePull) => Response | Promise<Response>): Promise<Response> => {
      note(request);
      const pr = this.pull(repoOf(params), Number(params['number']));
      return pr === undefined ? notFound() : fn(pr);
    };
    return [
      http.post(`${GITHUB}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 }),
      ),
      // OAuth (main 11.2 step 3): the code exchange and the user it names.
      http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
        const code = new URLSearchParams(await request.text()).get('code');
        const person = this.people.find((p) => p.code === code);
        return HttpResponse.json(person === undefined ? { error: 'bad_verification_code' } : { access_token: person.token, token_type: 'bearer', scope: '' });
      }),
      http.get(`${GITHUB}/user`, ({ request }) => {
        const person = this.people.find((p) => request.headers.get('authorization') === `Bearer ${p.token}`);
        return person === undefined ? denied() : HttpResponse.json({ login: person.login, id: person.id });
      }),
      http.get(`${GITHUB}/repos/:owner/:repo`, ({ request }) => (installation(request) ? HttpResponse.json({ default_branch: 'main' }) : denied())),
      http.get(`${GITHUB}/user/emails`, ({ request }) => {
        const person = this.people.find((p) => request.headers.get('authorization') === `Bearer ${p.token}`);
        return person === undefined ? denied() : HttpResponse.json([{ email: person.email, primary: true, verified: true }]);
      }),
      // The fixer hand-off (#262): the server finds its open pull request, or opens one as the App.
      http.get(`${GITHUB}/repos/:owner/:repo/pulls`, ({ request, params }) => {
        if (!installation(request)) return denied();
        note(request);
        const url = new URL(request.url);
        const repo = repoOf(params);
        const head = url.searchParams.get('head');
        const base = url.searchParams.get('base');
        const state = url.searchParams.get('state') ?? 'open';
        const found = [...this.pulls.values()].filter(
          (p) => p.repo === repo && (state === 'all' || p.state === state) && (head === null || `${repo.split('/')[0] ?? ''}:${p.head}` === head) && (base === null || p.base === base),
        );
        return HttpResponse.json(found.map((p) => this.pullJson(p)));
      }),
      http.post(`${GITHUB}/repos/:owner/:repo/pulls`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        note(request);
        const repo = repoOf(params);
        const body = rec(await request.json());
        const head = String(body['head'] ?? '');
        const base = String(body['base'] ?? '');
        const bare = this.repos.get(repo);
        if (bare === undefined) return notFound();
        if (git(bare.url, ['for-each-ref', '--format=%(refname)', `refs/heads/${head}`]) === '') {
          return HttpResponse.json({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }, { status: 422 });
        }
        if ([...this.pulls.values()].some((p) => p.repo === repo && p.head === head && p.base === base && p.state === 'open')) {
          return HttpResponse.json({ message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${head}.` }] }, { status: 422 });
        }
        const pr = this.open(repo, { head, base, title: String(body['title'] ?? '') });
        return HttpResponse.json(this.pullJson(pr), { status: 201 });
      }),
      http.get(`${GITHUB}/repos/:owner/:repo/pulls/:number`, async ({ request, params }) =>
        installation(request) ? withPull(request, params, (pr) => HttpResponse.json(this.pullJson(pr))) : denied(),
      ),
      http.patch(`${GITHUB}/repos/:owner/:repo/pulls/:number`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        const body = rec(await request.clone().json());
        return withPull(request, params, (pr) => {
          if (body['state'] === 'closed' && !pr.merged) pr.state = 'closed';
          return HttpResponse.json(this.pullJson(pr));
        });
      }),
      http.get(`${GITHUB}/repos/:owner/:repo/pulls/:number/files`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return withPull(request, params, (pr) => HttpResponse.json(page === 1 ? this.diff(pr).map((f) => ({ ...f, changes: f.additions + f.deletions })) : []));
      }),
      // The merge step reads the files of exactly the commit it merges (#264): `base...sha`.
      http.get(`${GITHUB}/repos/:owner/:repo/compare/:basehead`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        note(request);
        const [base = '', head = ''] = String(params['basehead']).split('...');
        const files = this.diffOf(repoOf(params), `refs/heads/${base}...${head}`).map((f) => ({ ...f, changes: f.additions + f.deletions }));
        return HttpResponse.json({ status: 'ahead', files });
      }),
      http.post(`${GITHUB}/repos/:owner/:repo/pulls/:number/requested_reviewers`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        const body = rec(await request.clone().json());
        return withPull(request, params, (pr) => {
          for (const login of Array.isArray(body['reviewers']) ? body['reviewers'] : []) {
            if (typeof login === 'string' && !pr.requestedReviewers.includes(login)) pr.requestedReviewers.push(login);
          }
          return HttpResponse.json(this.pullJson(pr), { status: 201 });
        });
      }),
      http.post(`${GITHUB}/repos/:owner/:repo/pulls/:number/reviews`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        const body = rec(await request.clone().json());
        return withPull(request, params, (pr) => {
          const event = String(body['event']);
          if (event !== 'COMMENT') return HttpResponse.json({ message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] }, { status: 422 });
          pr.reviews.push({ event, body: String(body['body'] ?? ''), ...(typeof body['commit_id'] === 'string' ? { commitId: body['commit_id'] } : {}) });
          return HttpResponse.json({ id: pr.reviews.length, state: 'COMMENTED', html_url: '' });
        });
      }),
      http.put(`${GITHUB}/repos/:owner/:repo/pulls/:number/merge`, async ({ request, params }) => {
        // Performed as the linked human (main 16): their user-to-server token. An autopilot merge (level 3,
        // main 11.3) is the App's own, with the installation token.
        const person = this.people.find((p) => request.headers.get('authorization') === `Bearer ${p.token}`);
        const by = person?.login ?? (installation(request) ? BOT_LOGIN : undefined);
        if (by === undefined) return denied();
        const body = rec(await request.clone().json());
        return withPull(request, params, (pr) => {
          if (pr.state !== 'open') return HttpResponse.json({ message: 'Pull Request is not mergeable' }, { status: 405 });
          if (body['sha'] !== this.headSha(pr)) return HttpResponse.json({ message: 'Head branch was modified' }, { status: 409 });
          pr.state = 'closed';
          pr.merged = true;
          pr.mergedBy = by;
          pr.mergeSha = createHash('sha1').update(`${pr.repo}#${pr.number}`).digest('hex');
          return HttpResponse.json({ merged: true, sha: pr.mergeSha, message: 'Pull Request successfully merged' });
        });
      }),
      http.post(`${GITHUB}/repos/:owner/:repo/issues/:number/comments`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        const body = rec(await request.clone().json());
        return withPull(request, params, (pr) => {
          pr.comments.push(String(body['body'] ?? ''));
          return HttpResponse.json({ id: pr.comments.length }, { status: 201 });
        });
      }),
      http.post(`${GITHUB}/repos/:owner/:repo/check-runs`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        note(request);
        const body = rec(await request.json());
        const run: CheckRun = {
          id: this.checkRuns.length + 100,
          repo: repoOf(params),
          name: String(body['name']),
          headSha: String(body['head_sha']),
          status: String(body['status']),
          conclusion: typeof body['conclusion'] === 'string' ? body['conclusion'] : null,
        };
        this.checkRuns.push(run);
        return HttpResponse.json({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, html_url: '' }, { status: 201 });
      }),
      http.patch(`${GITHUB}/repos/:owner/:repo/check-runs/:id`, async ({ request, params }) => {
        if (!installation(request)) return denied();
        note(request);
        const body = rec(await request.json());
        const run = this.checkRuns.find((r) => r.id === Number(params['id']));
        if (run === undefined) return notFound();
        if (typeof body['status'] === 'string') run.status = body['status'];
        if (typeof body['conclusion'] === 'string') run.conclusion = body['conclusion'];
        return HttpResponse.json({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, html_url: '' });
      }),
      http.get(`${GITHUB}/repos/:owner/:repo/branches/:branch/protection/required_status_checks`, ({ request }) => {
        if (!installation(request)) return denied();
        note(request);
        return HttpResponse.json({ strict: false, contexts: [REVIEW_CHECK, CI_CHECK], checks: [] });
      }),
      // No repository ruleset requires anything more (the classic list above holds every required check).
      http.get(`${GITHUB}/repos/:owner/:repo/rules/branches/:branch`, ({ request }) => {
        if (!installation(request)) return denied();
        note(request);
        return HttpResponse.json([]);
      }),
      http.get(`${GITHUB}/repos/:owner/:repo/commits/:sha/check-runs`, ({ request, params }) => {
        if (!installation(request)) return denied();
        note(request);
        const sha = String(params['sha']);
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const runs = this.checkRuns
          .filter((r) => r.repo === repoOf(params) && r.headSha === sha)
          .map((r) => ({ id: r.id, name: r.name, head_sha: r.headSha, status: r.status, conclusion: r.conclusion, app: { id: APP_ID, slug: 'snapwing-test' } }));
        const ci = this.silent.has(CI_CHECK) ? [] : [{ id: 1, name: CI_CHECK, head_sha: sha, status: 'completed', conclusion: 'success', app: CI_APP }];
        const all = [...ci, ...runs.filter((r) => !this.silent.has(r.name))];
        return HttpResponse.json(page === 1 ? { total_count: all.length, check_runs: all } : { total_count: all.length, check_runs: [] });
      }),
      // The head branch after an autopilot merge (`fix/KEY`, so the ref has a slash).
      http.delete(/\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/.+$/, ({ request }) => {
        if (!installation(request)) return denied();
        note(request);
        const [, owner, name, branch] = /\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/.exec(new URL(request.url).pathname) ?? [];
        this.deletedBranches.push(`${owner ?? ''}/${name ?? ''}:${decodeURIComponent(branch ?? '')}`);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${GITHUB}/repos/:owner/:repo/commits/:sha/status`, ({ request }) => {
        if (!installation(request)) return denied();
        note(request);
        return HttpResponse.json({ state: 'success', statuses: [] });
      }),
    ];
  }
}
