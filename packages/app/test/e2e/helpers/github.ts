// The GitHub side of the e2e tier (main 14.4, 11): reading the fixer's pull request on the fixture
// repository through the App, pointing the App's webhook at the run's tunnel (`pnpm github:bootstrap
// webhook`, `runWebhook`), and teardown (close the run's PRs, delete their branches). It never writes
// to `main`: a branch is deleted only when it starts with `fix/` or `test/`.

import { dirname } from 'node:path';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { runWebhook, type WebhookResult } from '../../../../../scripts/github-bootstrap.ts';
import { createGitHubAuth } from '../../../src/github/auth.ts';
import { createGitHubTransport } from '../../../src/github/client.ts';
import { FIXTURE_REPO } from './env.ts';

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
