// `snapwing github unlink <person>` (main 11.2): an admin's offboarding path. Removes a person's linked
// GitHub account on every chat platform: the stored tokens are deleted and the grant is revoked at
// GitHub, the same as the person's own `unlink github` in a direct message.
//
//   snapwing github unlink <person> [--map <file>] [--env-file <file>]
//
// <person> is a map handle, a Slack id, or a Teams id. A person already removed from the map is
// reached by their chat id. It runs on the dialect `SNAPWING_DB` / `DATABASE_URL` name (SQLite file
// `SNAPWING_SQLITE_PATH`), with the GitHub App's client id and secret from the env file, like `serve`.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stateOptionsFromEnv } from '@snapwing/pipeline/contracts/state.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { MapPerson } from '@snapwing/pipeline/map/types.ts';
import type { ChatPlatform, OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { createGitHubOAuth, type ChatUser } from '../github/oauth.ts';
import { DEFAULT_MAP_FILE } from '../server/compose.ts';
import type { CliIo } from './state.ts';

export const GITHUB_USAGE = `Usage: snapwing github unlink <person> [--map <file>] [--env-file <file>]

  unlink   remove a person's linked GitHub account: delete the stored token and revoke the
           authorization at GitHub. <person> is a map handle, a Slack id, or a Teams id.

Environment: SNAPWING_DB=sqlite|postgres, DATABASE_URL (postgres), SNAPWING_SQLITE_PATH (sqlite file),
SNAPWING_MAP (default workspace-context.xml), SNAPWING_ENV_FILE (default .env; the GitHub App secrets).`;

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** The chat users a `<person>` argument names: the map person's ids, else the argument as a chat id on both platforms. */
function chatUsersOf(arg: string, people: readonly MapPerson[]): ChatUser[] {
  const lower = arg.replace(/^@/, '').toLowerCase();
  const matches = people.filter((p) => p.slackId === arg || p.teamsId === arg || p.handle.replace(/^@/, '').toLowerCase() === lower);
  const users: ChatUser[] = [];
  const add = (chat: ChatPlatform, userId: string | undefined): void => {
    if (userId !== undefined && userId !== '' && !users.some((u) => u.chat === chat && u.userId === userId)) users.push({ chat, userId });
  };
  for (const p of matches) {
    add('slack', p.slackId);
    add('teams', p.teamsId);
  }
  add('slack', arg);
  add('teams', arg);
  return users;
}

async function readPeople(mapFlag: string | undefined, io: CliIo): Promise<MapPerson[]> {
  const path = resolve(mapFlag ?? nonEmpty(io.env['SNAPWING_MAP']) ?? DEFAULT_MAP_FILE);
  try {
    return (await parseWorkspaceMap(await readFile(path, 'utf8'))).people;
  } catch {
    // A missing or invalid map is not a reason to leave a departed person linked: fall back to chat ids.
    return [];
  }
}

/** Runs `snapwing github <args>` and returns the exit code. */
export async function runGithub(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    io.stdout(GITHUB_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'unlink') {
    io.stderr(`snapwing github: unknown subcommand ${JSON.stringify(sub)}\n${GITHUB_USAGE}`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: { map: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (e) {
    io.stderr(`snapwing github unlink: ${e instanceof Error ? e.message : String(e)}\n${GITHUB_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.stdout(GITHUB_USAGE);
    return 0;
  }
  const [arg, ...extra] = parsed.positionals;
  if (arg === undefined || extra.length > 0) {
    io.stderr(`snapwing github unlink: give one person (a map handle, a Slack id, or a Teams id)\n${GITHUB_USAGE}`);
    return 1;
  }

  let state: OpenedState | undefined;
  try {
    const users = chatUsersOf(arg, await readPeople(parsed.values.map, io));
    const options = stateOptionsFromEnv(io.env);
    const sqlitePath = nonEmpty(io.env['SNAPWING_SQLITE_PATH']);
    if (options.dialect === 'sqlite' && sqlitePath !== undefined) options.url = sqlitePath;
    state = await openState(options);
    const workspaceId = await ensureInstallWorkspace(state);
    const envFile = parsed.values['env-file'] ?? nonEmpty(io.env['SNAPWING_ENV_FILE']) ?? '.env';
    const failures: string[] = [];
    const oauth = createGitHubOAuth({
      state,
      secrets: createEnvFileSecrets({ path: envFile, fallbackEnv: io.env }),
      workspaceId,
      onError: (e) => failures.push(e instanceof Error ? e.message : String(e)),
    });
    let found = 0;
    let unrevoked = 0;
    for (const user of users) {
      const result = await oauth.disconnect(user);
      if (!result.linked) continue;
      found++;
      if (!result.revoked) unrevoked++;
      io.stdout(`unlinked ${user.chat} ${user.userId}${result.revoked ? ', grant revoked at GitHub' : ', stored token deleted but GitHub did not confirm the revocation'}`);
    }
    if (found === 0) {
      io.stderr(`snapwing github unlink: ${JSON.stringify(arg)} has no linked GitHub account`);
      return 1;
    }
    for (const f of failures) io.stderr(`snapwing github unlink: ${f}`);
    if (unrevoked > 0) {
      io.stderr('Remove the Snapwing app from the person\'s GitHub account (Settings, Applications) or retry once GitHub is reachable.');
      return 1;
    }
    return 0;
  } catch (e) {
    io.stderr(`snapwing github unlink: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await state?.close();
  }
}
