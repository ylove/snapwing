import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { SecretNotFoundError } from '@snapwing/pipeline/ports/secrets.ts';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { GitHubApiError, createGitHubAuth, normalizePem } from '../../src/github/auth.ts';
import { createGitHubRepoReader } from '../../src/github/repo-reader.ts';

function fixture(name: string): JsonBodyType {
  return JSON.parse(readFileSync(new URL(`../fixtures/github/${name}`, import.meta.url), 'utf8')) as JsonBodyType;
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const values: Record<string, string> = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_INSTALLATION_ID: '987',
};
const secrets: SecretsPort = {
  async get(name) {
    const v = values[name];
    if (v === undefined) throw new SecretNotFoundError(name, 'test');
    return v;
  },
};

const T0 = new Date('2026-10-02T12:00:00Z');
const tokenResponse = fixture('access-token.json') as { token: string; expires_at: string };
const API = 'https://api.github.com';

interface TokenCall {
  authorization: string;
  body: unknown;
}
let tokenCalls: TokenCall[] = [];
let expiresAt = tokenResponse.expires_at;

const server = setupServer(
  http.post(`${API}/app/installations/987/access_tokens`, async ({ request }) => {
    tokenCalls.push({ authorization: request.headers.get('authorization') ?? '', body: await request.json() });
    return HttpResponse.json({ ...tokenResponse, token: `${tokenResponse.token}_${tokenCalls.length}`, expires_at: expiresAt }, { status: 201 });
  }),
);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  tokenCalls = [];
  expiresAt = tokenResponse.expires_at;
});
afterAll(() => server.close());

function decodeJwt(authorization: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: Buffer } {
  const jwt = authorization.replace(/^Bearer /, '');
  const [h, p, s] = jwt.split('.');
  if (h === undefined || p === undefined || s === undefined) throw new Error('not a JWT');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
    signed: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

describe('app JWT', () => {
  it('is RS256 with iat 60 s back, exp 9 minutes out, iss the app id, and verifies against the public key', async () => {
    const auth = createGitHubAuth({ secrets, now: () => T0 });
    await auth.installationToken({ repo: 'octo-org/fixture-repo', permissions: { contents: 'read' } });
    const call = tokenCalls[0];
    expect(call).toBeDefined();
    const jwt = decodeJwt(call?.authorization ?? '');
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    const nowSec = T0.getTime() / 1000;
    expect(jwt.claims).toEqual({ iat: nowSec - 60, exp: nowSec + 540, iss: '123456' });
    const ok = createVerify('RSA-SHA256').update(jwt.signed).verify(createPublicKey(publicKey), jwt.signature);
    expect(ok).toBe(true);
  });

  it('accepts a PEM stored on one line with literal \\n', async () => {
    expect(normalizePem(privateKey.replaceAll('\n', '\\n'))).toBe(privateKey);
    const auth = createGitHubAuth({ secrets: { get: async (n) => (n === 'GITHUB_APP_PRIVATE_KEY' ? privateKey.replaceAll('\n', '\\n') : await secrets.get(n)) }, now: () => T0 });
    await expect(auth.installationToken({ repo: 'octo-org/fixture-repo', permissions: { contents: 'read' } })).resolves.toBeDefined();
  });

  it('rejects with SecretNotFoundError when the key is missing', async () => {
    const auth = createGitHubAuth({ secrets: { get: async (n) => { throw new SecretNotFoundError(n, 'test'); } }, now: () => T0 });
    await expect(auth.installationToken({ repo: 'octo-org/fixture-repo', permissions: { contents: 'read' } })).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe('installationToken', () => {
  const request = { repo: 'octo-org/fixture-repo', permissions: { contents: 'read', pull_requests: 'write' } } as const;

  it('scopes the request body to one repository and the requested permissions', async () => {
    const auth = createGitHubAuth({ secrets, now: () => T0 });
    const t = await auth.installationToken(request);
    expect(tokenCalls[0]?.body).toEqual({ repositories: ['fixture-repo'], permissions: { contents: 'read', pull_requests: 'write' } });
    expect(t.expiresAt).toBe('2026-10-02T13:00:00Z');
    expect(t.token).toMatch(/^ghs_test_/);
  });

  it('caches until 5 minutes before expiry, then refreshes', async () => {
    let now = T0;
    const auth = createGitHubAuth({ secrets, now: () => now });
    const first = await auth.installationToken(request);
    now = new Date('2026-10-02T12:54:00Z');
    expect(await auth.installationToken(request)).toEqual(first);
    expect(tokenCalls).toHaveLength(1);
    now = new Date('2026-10-02T12:55:01Z');
    const second = await auth.installationToken(request);
    expect(tokenCalls).toHaveLength(2);
    expect(second.token).not.toBe(first.token);
  });

  it('keeps separate cache entries per repository and permission set, regardless of key order', async () => {
    const auth = createGitHubAuth({ secrets, now: () => T0 });
    await auth.installationToken({ repo: 'octo-org/a', permissions: { contents: 'read', metadata: 'read' } });
    await auth.installationToken({ repo: 'octo-org/a', permissions: { metadata: 'read', contents: 'read' } });
    await auth.installationToken({ repo: 'octo-org/a', permissions: { contents: 'write' } });
    await auth.installationToken({ repo: 'octo-org/b', permissions: { contents: 'read', metadata: 'read' } });
    expect(tokenCalls).toHaveLength(3);
  });

  it('shares one request between concurrent callers', async () => {
    const auth = createGitHubAuth({ secrets, now: () => T0 });
    const [a, b] = await Promise.all([auth.installationToken(request), auth.installationToken(request)]);
    expect(a).toEqual(b);
    expect(tokenCalls).toHaveLength(1);
  });

  it('rejects a malformed repo before any call', async () => {
    const auth = createGitHubAuth({ secrets, now: () => T0 });
    await expect(auth.installationToken({ repo: 'nope', permissions: { contents: 'read' } })).rejects.toThrow(/owner\/name/);
    expect(tokenCalls).toHaveLength(0);
  });

  it('surfaces GitHub errors without the JWT or token and never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    server.use(http.post(`${API}/app/installations/987/access_tokens`, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })));
    const auth = createGitHubAuth({ secrets, now: () => T0 });
    const err = await auth.installationToken(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(401);
    expect((err as Error).message).toBe('GitHub API 401: Bad credentials');
    expect(JSON.stringify(err)).not.toContain('BEGIN');

    const ok = createGitHubAuth({ secrets, now: () => T0 });
    server.resetHandlers();
    await ok.installationToken(request);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe('createGitHubRepoReader', () => {
  const repo = 'octo-org/fixture-repo';
  const reader = () => createGitHubRepoReader(createGitHubAuth({ secrets, now: () => T0 }), { repo, ref: 'main' });

  it('searches code scoped to the repo and maps hits with snippets', async () => {
    let url: URL | undefined;
    let headers: Headers | undefined;
    server.use(
      http.get(`${API}/search/code`, ({ request }) => {
        url = new URL(request.url);
        headers = request.headers;
        return HttpResponse.json(fixture('search-code.json'));
      }),
    );
    const hits = await reader().search('CheckoutButton');
    expect(url?.searchParams.get('q')).toBe('CheckoutButton repo:octo-org/fixture-repo');
    expect(headers?.get('accept')).toBe('application/vnd.github.text-match+json');
    expect(headers?.get('authorization')).toMatch(/^Bearer ghs_test_/);
    expect(hits).toEqual([
      { path: 'src/components/CheckoutButton.tsx', snippet: 'export function CheckoutButton() {\n  return null;' },
      { path: 'src/index.ts' },
    ]);
    expect(tokenCalls[0]?.body).toEqual({ repositories: ['fixture-repo'], permissions: { contents: 'read' } });
  });

  it('reads a file from the contents API and decodes base64', async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${API}/repos/octo-org/fixture-repo/contents/*`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(fixture('contents-file.json'));
      }),
    );
    const text = await reader().read('src/components/CheckoutButton.tsx');
    expect(text).toBe('export function CheckoutButton() {\n  return null;\n}\n');
    expect(url?.pathname).toBe('/repos/octo-org/fixture-repo/contents/src/components/CheckoutButton.tsx');
    expect(url?.searchParams.get('ref')).toBe('main');
  });

  it('rejects a directory listing and a missing file', async () => {
    server.use(
      http.get(`${API}/repos/octo-org/fixture-repo/contents/src`, () => HttpResponse.json([{ type: 'file', name: 'index.ts', path: 'src/index.ts' }])),
      http.get(`${API}/repos/octo-org/fixture-repo/contents/gone.ts`, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })),
    );
    await expect(reader().read('src')).rejects.toBeInstanceOf(GitHubApiError);
    await expect(reader().read('gone.ts')).rejects.toMatchObject({ status: 404 });
  });

  it('exposes no write methods', () => {
    expect(Object.keys(reader()).sort()).toEqual(['read', 'search']);
  });
});
