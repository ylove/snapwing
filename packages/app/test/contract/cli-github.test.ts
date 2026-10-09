// `snapwing github unlink <person>` (main 11.2): the offboarding path. On a temp SQLite file and a temp
// copy of the example map, with GitHub's revocation endpoint played by MSW.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { stateOptionsFromEnv } from '@snapwing/pipeline/contracts/state.ts';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { parseSealKey, seal } from '@snapwing/pipeline/util/seal.ts';
import { main } from '../../src/cli/main.ts';

const exampleXml = await readFile(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const KEY = randomBytes(32).toString('base64');
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';

let revokes: { what: string; token: unknown }[] = [];
let revokeStatus = 204;
const server = setupServer(
  http.delete('https://api.github.com/applications/:clientId/:what', async ({ params, request }) => {
    revokes.push({ what: String(params['what']), token: ((await request.json()) as Record<string, unknown>)['access_token'] });
    return new HttpResponse(null, { status: revokeStatus });
  }),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

let dir: string;
let env: Record<string, string>;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-cli-github-'));
  const mapPath = join(dir, 'workspace-context.xml');
  await writeFile(mapPath, exampleXml);
  env = {
    SNAPWING_DB: 'sqlite',
    SNAPWING_SQLITE_PATH: join(dir, 'state.db'),
    SNAPWING_MAP: mapPath,
    SNAPWING_ENV_FILE: join(dir, 'absent.env'),
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    SNAPWING_ENCRYPTION_KEY: KEY,
  };
  out = [];
  err = [];
  revokes = [];
  revokeStatus = 204;
});

afterEach(async () => {
  server.resetHandlers();
  await rm(dir, { recursive: true, force: true });
});

const run = (args: string[]): Promise<number> => main(['github', ...args], { env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
const text = (lines: string[]): string => lines.join('\n');

/** Links a chat user as the OAuth callback would. */
async function seedLink(chat: 'slack' | 'teams', chatUserId: string, githubUserId: number, access: string): Promise<void> {
  const options = stateOptionsFromEnv(env);
  options.url = join(dir, 'state.db');
  const opened = await openState(options);
  try {
    const workspaceId = await ensureInstallWorkspace(opened);
    await opened.linkIdentity({
      workspaceId,
      chat,
      chatUserId,
      githubLogin: `gh-${githubUserId}`,
      githubUserId,
      accessToken: seal(parseSealKey(KEY), access, JSON.stringify(['linked_identities', workspaceId, chat, chatUserId, 'access_token'])),
    });
  } finally {
    await opened.close();
  }
}

async function linked(chat: 'slack' | 'teams', chatUserId: string): Promise<boolean> {
  const options = stateOptionsFromEnv(env);
  options.url = join(dir, 'state.db');
  const opened = await openState(options);
  try {
    const workspaceId = await ensureInstallWorkspace(opened);
    return (await opened.getLinkedIdentity({ workspaceId, chat, chatUserId })) !== null;
  } finally {
    await opened.close();
  }
}

describe('github unlink', () => {
  it('removes a map person\'s link by handle, deletes the token, and revokes the grant at GitHub', async () => {
    await seedLink('slack', 'U0WEBDEV1', 41, 'test-access-token-one');
    await seedLink('slack', 'U0MOBDEV', 42, 'test-access-token-two');
    expect(await run(['unlink', 'webDev1'])).toBe(0);
    expect(text(out)).toContain('unlinked slack U0WEBDEV1, grant revoked at GitHub');
    expect(revokes).toEqual([{ what: 'grant', token: 'test-access-token-one' }]);
    expect(await linked('slack', 'U0WEBDEV1')).toBe(false);
    expect(await linked('slack', 'U0MOBDEV')).toBe(true);
    expect(text(out) + text(err)).not.toContain('test-access-token');
  });

  it('reaches a person already gone from the map by their chat id', async () => {
    await seedLink('slack', 'U0DEPARTED', 43, 'test-access-token-three');
    expect(await run(['unlink', 'U0DEPARTED'])).toBe(0);
    expect(revokes).toEqual([{ what: 'grant', token: 'test-access-token-three' }]);
    expect(await linked('slack', 'U0DEPARTED')).toBe(false);
  });

  it('exits 1 for a person with no link, and calls GitHub for nothing', async () => {
    expect(await run(['unlink', 'webDev1'])).toBe(1);
    expect(text(err)).toContain('has no linked GitHub account');
    expect(revokes).toEqual([]);
  });

  it('deletes the stored token but exits 1 when GitHub does not confirm the revocation', async () => {
    await seedLink('slack', 'U0WEBDEV1', 41, 'test-access-token-one');
    revokeStatus = 502;
    expect(await run(['unlink', 'webDev1'])).toBe(1);
    expect(text(out)).toContain('did not confirm the revocation');
    expect(text(err)).toContain('Remove the Snapwing app');
    expect(await linked('slack', 'U0WEBDEV1')).toBe(false);
    expect(text(out) + text(err)).not.toContain(CLIENT_SECRET);
  });

  it('needs exactly one person and a known subcommand', async () => {
    expect(await run(['unlink'])).toBe(1);
    expect(await run(['unlink', 'a', 'b'])).toBe(1);
    expect(await run(['revoke', 'a'])).toBe(1);
    expect(await run(['--help'])).toBe(0);
  });
});
