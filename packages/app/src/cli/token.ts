// `snapwing token ...` (main 15.3 Auth, 15.4): per-user capture tokens, an admin's commands.
//
//   snapwing token issue <handle> [--label <text>] [--map <file>]
//   snapwing token list
//   snapwing token revoke <id>
//
// A token identifies one map person and is revocable alone. The store keeps only a hash and does not
// check the person against the workspace map, so `issue` does: an unknown handle exits 1 and issues
// nothing. The token is printed once, with the `snapwing login` line the person runs. It runs on the
// dialect `SNAPWING_DB` / `DATABASE_URL` name (SQLite file `SNAPWING_SQLITE_PATH`), like `state`.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stateOptionsFromEnv } from '@snapwing/pipeline/contracts/state.ts';
import { InvalidMapError, parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { openState } from '@snapwing/pipeline/state/db.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { DEFAULT_MAP_FILE } from '../server/compose.ts';
import type { CliIo } from './state.ts';

export const TOKEN_USAGE = `Usage: snapwing token issue <handle> [--label <text>] [--map <file>]
       snapwing token list
       snapwing token revoke <id>

  issue    make a capture token for a person in the workspace map; it is printed once
  list     every token: id, person, label, issued, last used, status (never a token)
  revoke   revoke one token by its id; the person's other tokens keep working

Environment: SNAPWING_DB=sqlite|postgres, DATABASE_URL (postgres), SNAPWING_SQLITE_PATH (sqlite file),
SNAPWING_MAP (default workspace-context.xml), SNAPWING_PUBLIC_URL (named in the login line).`;

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** Runs `snapwing token <args>` and returns the exit code. */
export async function runToken(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    io.stdout(TOKEN_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'issue' && sub !== 'list' && sub !== 'revoke') {
    io.stderr(`snapwing token: unknown subcommand ${JSON.stringify(sub)}\n${TOKEN_USAGE}`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: { label: { type: 'string' }, map: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (e) {
    io.stderr(`snapwing token ${sub}: ${e instanceof Error ? e.message : String(e)}\n${TOKEN_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.stdout(TOKEN_USAGE);
    return 0;
  }
  const [arg, ...extra] = parsed.positionals;
  const wantsArg = sub !== 'list';
  if (extra.length > 0 || (wantsArg && arg === undefined) || (!wantsArg && arg !== undefined)) {
    io.stderr(`snapwing token ${sub}: ${wantsArg ? `give one ${sub === 'issue' ? 'handle' : 'token id'}` : 'takes no arguments'}\n${TOKEN_USAGE}`);
    return 1;
  }
  if (sub === 'issue' && !(await handleInMap(arg as string, parsed.values.map, io))) return 1;

  let state: OpenedState | undefined;
  try {
    const options = stateOptionsFromEnv(io.env);
    const sqlitePath = nonEmpty(io.env['SNAPWING_SQLITE_PATH']);
    if (options.dialect === 'sqlite' && sqlitePath !== undefined) options.url = sqlitePath;
    state = await openState(options);
    const workspaceId = await ensureInstallWorkspace(state);
    if (sub === 'issue') {
      const label = nonEmpty(parsed.values.label);
      const issued = await state.issueCaptureToken({ workspaceId, person: arg as string, ...(label === undefined ? {} : { label }) });
      const url = nonEmpty(io.env['SNAPWING_PUBLIC_URL']) ?? '<server url>';
      io.stdout(`token ${issued.id} for ${issued.person}${issued.label === undefined ? '' : ` (${issued.label})`}`);
      io.stdout('Shown once. It cannot be read again; revoke it and issue another if it is lost.');
      io.stdout('');
      io.stdout(issued.token);
      io.stdout('');
      io.stdout('They run (it asks for the token without echo):');
      io.stdout(`  snapwing login --url ${url}`);
      return 0;
    }
    if (sub === 'list') {
      const rows = await state.listCaptureTokens(workspaceId);
      if (rows.length === 0) {
        io.stdout('no capture tokens');
        return 0;
      }
      const cells = rows.map((t) => [t.id, t.person, t.label ?? '', t.issuedAt, t.lastUsedAt ?? 'never', t.revokedAt === undefined ? 'live' : `revoked ${t.revokedAt}`]);
      const headers = ['id', 'person', 'label', 'issued', 'last used', 'status'];
      const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
      const line = (r: readonly string[]): string => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
      io.stdout([line(headers), ...cells.map(line)].join('\n'));
      return 0;
    }
    const revoked = await state.revokeCaptureToken(arg as string);
    if (!revoked) {
      io.stderr(`snapwing token revoke: no live token with id ${JSON.stringify(arg)}`);
      return 1;
    }
    io.stdout(`revoked ${arg}`);
    return 0;
  } catch (e) {
    io.stderr(`snapwing token ${sub}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await state?.close();
  }
}

/** True when `handle` is a person in the workspace map; says why on stderr when not. */
async function handleInMap(handle: string, mapFlag: string | undefined, io: CliIo): Promise<boolean> {
  const path = resolve(mapFlag ?? nonEmpty(io.env['SNAPWING_MAP']) ?? DEFAULT_MAP_FILE);
  let xml: string;
  try {
    xml = await readFile(path, 'utf8');
  } catch (e) {
    io.stderr(`snapwing token issue: cannot read the workspace map ${path}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : String(e)}`);
    return false;
  }
  try {
    const map = await parseWorkspaceMap(xml);
    if (map.people.some((p) => p.handle === handle)) return true;
    io.stderr(`snapwing token issue: ${JSON.stringify(handle)} is not a person in ${path} (see: snapwing map show people)`);
  } catch (e) {
    io.stderr(`snapwing token issue: ${path} is not a valid map${e instanceof InvalidMapError ? ` (${e.message})` : ''}`);
  }
  return false;
}
