// The GitHub side of the e2e tier (main 14.4, 11): reading the fixer's pull request on the fixture
// repository through the App, pointing the App's webhook at the run's tunnel (`pnpm github:bootstrap
// webhook`, `runWebhook`), and teardown (close the run's PRs, delete their branches). It never writes
// to `main`: a branch is created or deleted only when it starts with `fix/` or `test/`.
//
// `createFixtureAdmin` is what the App may not do (it has `administration: read` and `deployments:
// read`), done as the fixture's owner through `gh` (logged in with admin on the fixture, as `pnpm
// github:bootstrap fixture` needs): protecting a `test/` branch the run made, so the merge step reads
// required checks there, and creating real deployments, so GitHub sends the App a real
// `deployment_status` (the fixture has no deploy pipeline; the test is its deploy system).

import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { runWebhook, type WebhookResult } from '../../../../../scripts/github-bootstrap.ts';
import { createGitHubAuth } from '../../../src/github/auth.ts';
import { createGitHubTransport } from '../../../src/github/client.ts';
import { FIXTURE_REPO, PREFIX } from './env.ts';

export type Rec = Record<string, unknown>;

/** Branch prefixes the tier may delete: the fixer's own and the test's. */
const DELETABLE = /^(fix|test)\//;

export function createGitHubDriver(secrets: SecretsPort) {
  const auth = createGitHubAuth({ secrets });
  const call = createGitHubTransport(auth, { repo: FIXTURE_REPO });
  const R = `/repos/${FIXTURE_REPO}`;
  const read = { pull_requests: 'read', contents: 'read' } as const;

  async function json(method: string, path: string, permissions: Record<string, 'read' | 'write'>, body?: unknown, query?: Record<string, string>): Promise<unknown> {
    const res = await call({ method, path, permissions, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    return res.text === '' ? {} : (JSON.parse(res.text) as unknown);
  }

  return {
    async pull(n: number): Promise<Rec> {
      return (await json('GET', `${R}/pulls/${n}`, read)) as Rec;
    },
    /** The sha `branch` points at. */
    async branchSha(branch: string): Promise<string> {
      const ref = (await json('GET', `${R}/git/ref/heads/${branch}`, read)) as Rec;
      return String((ref['object'] as Rec | undefined)?.['sha'] ?? '');
    },
    /** Creates `test/...` at `sha`; refuses any other name. */
    async createTestBranch(branch: string, sha: string): Promise<void> {
      if (!branch.startsWith('test/')) throw new Error(`refusing to create ${branch}: only test/ branches`);
      await json('POST', `${R}/git/refs`, { contents: 'write' }, { ref: `refs/heads/${branch}`, sha });
    },
    /** The bodies of the pull request's conversation comments. */
    async issueComments(n: number): Promise<string[]> {
      const list = (await json('GET', `${R}/issues/${n}/comments`, { pull_requests: 'read' }, undefined, { per_page: '100' })) as Rec[];
      return list.map((c) => String(c['body'] ?? ''));
    },
    async pullFiles(n: number): Promise<string[]> {
      const files = (await json('GET', `${R}/pulls/${n}/files`, read)) as Rec[];
      return files.map((f) => String(f['filename']));
    },
    /** Open pull requests whose head branch is `head` (in the fixture repository). */
    async openPullsFrom(head: string): Promise<number[]> {
      const owner = FIXTURE_REPO.split('/')[0] ?? '';
      const list = (await json('GET', `${R}/pulls`, read, undefined, { state: 'open', head: `${owner}:${head}` })) as Rec[];
      return list.map((p) => Number(p['number']));
    },
    async closePull(n: number): Promise<void> {
      await json('PATCH', `${R}/pulls/${n}`, { pull_requests: 'write' }, { state: 'closed' });
    },
    /** Deletes `fix/...` or `test/...`; resolves false when it did not exist. */
    async deleteBranch(branch: string): Promise<boolean> {
      if (!DELETABLE.test(branch)) throw new Error(`refusing to delete ${branch}: only fix/ and test/ branches`);
      try {
        await call({ method: 'DELETE', path: `${R}/git/refs/heads/${branch}`, permissions: { contents: 'write' } });
        return true;
      } catch (e) {
        if (e instanceof Error && /\b(404|422)\b/.test(e.message)) return false;
        throw e;
      }
    },
  };
}

export type GitHubDriver = ReturnType<typeof createGitHubDriver>;

/** True when `gh` runs and its account administers the fixture repository. */
export function ghAdministersFixture(): boolean {
  const r = spawnSync('gh', ['api', `repos/${FIXTURE_REPO}`, '--jq', '.permissions.admin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** `gh api` as the fixture's owner; resolves with the parsed body. No token passes through here. */
async function gh(method: string, path: string, body?: unknown): Promise<unknown> {
  const args = ['api', '-X', method, path, ...(body === undefined ? [] : ['--input', '-']), '-H', 'Accept: application/vnd.github+json'];
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`gh api ${method} ${path} exited ${String(code)}: ${(err.trim() || out.trim()).split('\n')[0]?.slice(0, 200) ?? ''}`));
        return;
      }
      try {
        resolve(out.trim() === '' ? {} : (JSON.parse(out) as unknown));
      } catch {
        resolve({});
      }
    });
    child.stdin.end(body === undefined ? '' : JSON.stringify(body));
  });
}

export interface FixtureAdmin {
  /** Protects `test/...` with `contexts` as its required checks (no reviews, deletable). */
  protect(branch: string, contexts: readonly string[]): Promise<void>;
  /** Removes the protection of `test/...` (already unprotected is fine). */
  unprotect(branch: string): Promise<void>;
  /** Whether the fixture has the deployment environment `name` now. */
  hasEnvironment(name: string): Promise<boolean>;
  /** A deployment of `sha` to `environment` with a `success` status; resolves with its id. */
  deploy(sha: string, environment: 'staging' | 'production'): Promise<number>;
  /** Marks the deployment inactive and deletes it (already gone is fine). */
  removeDeployment(id: number): Promise<void>;
  /** Deletes the deployment environment `name` (already gone is fine). */
  deleteEnvironment(name: string): Promise<void>;
}

export function createFixtureAdmin(): FixtureAdmin {
  const R = `repos/${FIXTURE_REPO}`;
  const testOnly = (branch: string): void => {
    if (!branch.startsWith('test/')) throw new Error(`refusing to change protection on ${branch}: only test/ branches`);
  };
  const gone = (e: unknown): boolean => e instanceof Error && /\b(404|Not Found)\b/.test(e.message);
  return {
    async protect(branch, contexts) {
      testOnly(branch);
      await gh('PUT', `${R}/branches/${branch}/protection`, {
        required_status_checks: { strict: false, contexts },
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_deletions: true,
      });
    },
    async unprotect(branch) {
      testOnly(branch);
      await gh('DELETE', `${R}/branches/${branch}/protection`).catch((e: unknown) => {
        if (!gone(e)) throw e;
      });
    },
    async hasEnvironment(name) {
      try {
        await gh('GET', `${R}/environments/${encodeURIComponent(name)}`);
        return true;
      } catch (e) {
        if (gone(e)) return false;
        throw e;
      }
    },
    async deploy(sha, environment) {
      const created = (await gh('POST', `${R}/deployments`, {
        ref: sha,
        environment,
        required_contexts: [],
        auto_merge: false,
        production_environment: environment === 'production',
        description: `${PREFIX} e2e deploy`,
      })) as Rec;
      const id = Number(created['id']);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`GitHub created no deployment for ${environment}`);
      await gh('POST', `${R}/deployments/${id}/statuses`, { state: 'success', environment, description: `${PREFIX} e2e deploy` });
      return id;
    },
    async removeDeployment(id) {
      try {
        await gh('POST', `${R}/deployments/${id}/statuses`, { state: 'inactive' });
        await gh('DELETE', `${R}/deployments/${id}`);
      } catch (e) {
        if (!gone(e)) throw e;
      }
    },
    async deleteEnvironment(name) {
      await gh('DELETE', `${R}/environments/${encodeURIComponent(name)}`).catch((e: unknown) => {
        if (!gone(e)) throw e;
      });
    },
  };
}

/**
 * `pnpm github:bootstrap webhook` for this run: points the App's webhook at `<publicUrl>/webhooks/github`.
 * It reads the App's values from `envFile` (the bootstrap's `.env.live`), so it runs only where that
 * file exists. GitHub's API cannot switch an inactive App webhook on; `needsActivation` and `lines`
 * say what the owner must do once in the browser.
 */
export async function pointGitHubWebhook(envFile: string, publicUrl: string): Promise<WebhookResult & { lines: string[] }> {
  const lines: string[] = [];
  const result = await runWebhook({
    fetch: (input, init) => fetch(input, init),
    gh: () => Promise.reject(new Error('gh is not used by webhook')),
    root: dirname(envFile),
    env: { SNAPWING_PUBLIC_URL: publicUrl },
    log: (line) => lines.push(line),
    openUrl: () => undefined,
    now: () => new Date(),
  });
  return { ...result, lines };
}
