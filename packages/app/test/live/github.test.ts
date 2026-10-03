// Live tier: the GitHub App against the private fixture repository `ylove/snapwing-fixture-web` (main 14.4, 11).
// Needs GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_INSTALLATION_ID, from the environment or from `.env.live`
// (found at the repository root, or at SNAPWING_ENV_LIVE). Without them the whole file skips.
//
// The fixture's `main` is protected (required check `snapwing/review`, one approval). This test never writes to it:
// it creates one `test/live-*` branch and one pull request from it, and `afterAll` closes that pull request and
// deletes that branch even when an assertion failed. No secret is logged or put in an assertion message.
//
// Set SNAPWING_RECORD_DIR to write each response body to that directory (one file per call, bodies verbatim).
// Those are for comparing with test/fixtures/github and the inline contract payloads; sanitize before committing.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findEnvFile } from './helpers/env.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { createGitHubAuth } from '../../src/github/auth.ts';
import type { GitHubAuth } from '../../src/github/auth.ts';
import { REVIEW_CHECK_NAME, createGitHubClient, createGitHubTransport } from '../../src/github/client.ts';
import { createCodeownersResolver } from '../../src/github/codeowners.ts';

const REPO = 'ylove/snapwing-fixture-web';
const R = `/repos/${REPO}`;
const BASE = 'main';

const secrets = createEnvFileSecrets({ path: findEnvFile() });
const present = await Promise.all(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'].map((n) => secrets.get(n).then(() => true, () => false)));
const hasSecrets = present.every(Boolean);

const recordDir = process.env.SNAPWING_RECORD_DIR;
let recorded = 0;
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (recordDir !== undefined && recordDir !== '') {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const name = `${String(++recorded).padStart(2, '0')}-${(init?.method ?? 'GET').toLowerCase()}${url.pathname.replaceAll('/', '_')}.json`;
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, name), await res.clone().text());
  }
  return res;
};

describe.skipIf(!hasSecrets)('GitHub App against snapwing-fixture-web', () => {
  const auth: GitHubAuth = createGitHubAuth({ secrets, fetch: recordingFetch });
  const options = { repo: REPO, fetch: recordingFetch };
  const client = createGitHubClient(auth, options);
  const call = createGitHubTransport(auth, options);
  const codeowners = createCodeownersResolver(auth, options);

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const branch = `test/live-${id}`;
  const path = `src/live-${id}.ts`;
  let prNumber: number | undefined;
  let headSha = '';
  let branchCreated = false;

  async function json(method: string, apiPath: string, permissions: Record<string, 'read' | 'write'>, body?: unknown): Promise<Record<string, unknown>> {
    const res = await call({ method, path: apiPath, permissions, ...(body === undefined ? {} : { body }) });
    return res.text === '' ? {} : (JSON.parse(res.text) as Record<string, unknown>);
  }

  afterAll(async () => {
    const failures: string[] = [];
    if (prNumber !== undefined) {
      try {
        await call({ method: 'PATCH', path: `${R}/pulls/${prNumber}`, permissions: { pull_requests: 'write' }, body: { state: 'closed' } });
      } catch (err) {
        failures.push(`close PR ${prNumber}: ${String(err)}`);
      }
    }
    if (branchCreated) {
      try {
        await client.deleteBranch(branch);
      } catch (err) {
        // Already deleted by the test body is fine.
        if (!(err instanceof Error && /\b(404|422)\b/.test(err.message))) failures.push(`delete ${branch}: ${String(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(`teardown incomplete: ${failures.join('; ')}`);
  });

  it('mints an installation token scoped to the fixture repository', async () => {
    const token = await auth.installationToken({ repo: REPO, permissions: { contents: 'read' } });
    expect(token.token).not.toBe('');
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
    const res = await call({ method: 'GET', path: '/installation/repositories', permissions: { contents: 'read' }, token: token.token });
    const body = JSON.parse(res.text) as { repositories: { full_name: string }[] };
    expect(body.repositories.map((r) => r.full_name)).toEqual([REPO]);
  });

  it('opens a test/ branch with one file under an owned path and a pull request from it', async () => {
    const ref = await json('GET', `${R}/git/ref/heads/${BASE}`, { contents: 'read' });
    const baseSha = (ref.object as { sha: string }).sha;
    await json('POST', `${R}/git/refs`, { contents: 'write' }, { ref: `refs/heads/${branch}`, sha: baseSha });
    branchCreated = true;
    const put = await json('PUT', `${R}/contents/${path}`, { contents: 'write' }, {
      message: `test: live tier probe ${id}`,
      content: Buffer.from(`// Created by the Snapwing live tier; safe to delete.\nexport const liveProbe = '${id}';\n`).toString('base64'),
      branch,
    });
    headSha = (put.commit as { sha: string }).sha;
    // Opening a PR needs read on the head ref too: a token with pull_requests alone gets 422 "not all refs are readable".
    const pr = await json('POST', `${R}/pulls`, { pull_requests: 'write', contents: 'read' }, {
      title: `[live test] ${id}`,
      head: branch,
      base: BASE,
      body: 'Opened and closed by the Snapwing live tier. Safe to ignore.',
    });
    prNumber = pr.number as number;

    const read = await client.getPullRequest(prNumber);
    expect(read).toMatchObject({ state: 'open', merged: false, headRef: branch, baseRef: BASE, headSha });
    const files = await client.listPullRequestFiles(prNumber);
    expect(files.map((f) => f.filename)).toEqual([path]);
  });

  it('requests the CODEOWNERS owner as reviewer', async () => {
    expect(prNumber).toBeDefined();
    const files = await client.listPullRequestFiles(prNumber as number);
    const found = await codeowners.codeownersFor(files.map((f) => f.filename));
    expect(found.source).toBe('.github/CODEOWNERS');
    expect(found.owners).toContain('@ylove');
    const users = found.owners.filter((o) => !o.includes('/')).map((o) => o.replace(/^@/, ''));
    await client.requestReviewers(prNumber as number, { users });
    const read = await client.getPullRequest(prNumber as number);
    expect(read.requestedReviewers).toContain('ylove');
  });

  it('reports the required check as pending, then success after a check run completes', async () => {
    const before = await client.combinedStatus(headSha, BASE);
    expect(before.state).toBe('pending');
    expect(before.required).toEqual([{ name: REVIEW_CHECK_NAME, state: 'pending', source: null }]);

    const started = await client.createCheckRun({ headSha, status: 'in_progress', output: { title: 'Snapwing review', summary: 'Live tier probe.' } });
    expect(started).toMatchObject({ name: REVIEW_CHECK_NAME, status: 'in_progress', conclusion: null });
    const midway = await client.combinedStatus(headSha, BASE);
    expect(midway.state).toBe('pending');

    const done = await client.updateCheckRun(started.id, { status: 'completed', conclusion: 'success', output: { title: 'Snapwing review', summary: 'Live tier probe passed.' } });
    expect(done).toMatchObject({ id: started.id, status: 'completed', conclusion: 'success' });
    const after = await client.combinedStatus(headSha, BASE);
    expect(after.state).toBe('success');
    expect(after.required).toEqual([{ name: REVIEW_CHECK_NAME, state: 'success', source: 'check-run' }]);
    expect(after.all).toContainEqual({ name: REVIEW_CHECK_NAME, state: 'success', source: 'check-run' });
  });

  it('closes the pull request with a comment and deletes the branch', async () => {
    expect(prNumber).toBeDefined();
    await client.closePullRequest(prNumber as number, 'Live tier finished; closing.');
    const closed = await client.getPullRequest(prNumber as number);
    expect(closed).toMatchObject({ state: 'closed', merged: false });
    await client.deleteBranch(branch);
    branchCreated = false;
    await expect(call({ method: 'GET', path: `${R}/git/ref/heads/${branch}`, permissions: { contents: 'read' } })).rejects.toMatchObject({ status: 404 });
  });
});
