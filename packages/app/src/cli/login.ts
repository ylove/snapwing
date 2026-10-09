// `snapwing login` and `snapwing logout` (main 15.3, 15.4): store or forget the capture endpoint and
// the per-user token. Where they live is capture-client's business (`saveClientConfig`,
// `clientConfigPath`, `loadClientConfig`): this file never names a path or reads the file itself, so
// a later mode that points the commands somewhere else changes one place.
//
//   snapwing login --url <endpoint> [--token <token>]   no --token: asked for without echo
//   snapwing logout

import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { clientConfigPath, saveClientConfig } from '@snapwing/capture-client/config.ts';
import { CaptureConfigError } from '@snapwing/capture-client/errors.ts';
import type { CaptureEnv } from './capture.ts';
import type { CliIo } from './state.ts';

export const LOGIN_USAGE = `Usage: snapwing login --url <endpoint> [--token <token> | --token -]

  --url <endpoint>   the Snapwing server, such as https://snapwing.example.com or http://localhost:3000
  --token <token>    your capture token (swc_...); without it you are asked for it, and it is not echoed
  --token -         read the token from standard input, so it stays out of the process list

Stores both for shot, say, log, status, and stop. SNAPWING_URL and SNAPWING_TOKEN, when set, win
over what is stored.`;

export const LOGOUT_USAGE = `Usage: snapwing logout

Forgets the stored endpoint and token.`;

const isHelp = (args: readonly string[]): boolean => args.includes('--help') || args.includes('-h');

/** Runs `snapwing login <args>` and returns the exit code. */
export async function runLogin(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  if (isHelp(args)) {
    io.stdout(LOGIN_USAGE);
    return 0;
  }
  let values: { url?: string | undefined; token?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      options: { url: { type: 'string' }, token: { type: 'string' } },
    }));
  } catch (error) {
    io.stderr(`snapwing login: ${error instanceof Error ? error.message : String(error)}\n${LOGIN_USAGE}`);
    return 1;
  }
  const endpoint = values.url?.trim();
  if (endpoint === undefined || endpoint === '') {
    io.stderr(`snapwing login: --url is required\n${LOGIN_USAGE}`);
    return 1;
  }
  const given = values.token === '-' ? (await env.readStdin()).split('\n')[0] : values.token;
  const token = (given ?? (await env.prompter.hidden('Capture token: ')))?.trim();
  if (token === undefined || token === '') {
    io.stderr('snapwing login: no token given.');
    return 1;
  }
  let path: string;
  try {
    path = await saveClientConfig({ endpoint, token }, { home: env.home });
  } catch (error) {
    if (error instanceof CaptureConfigError) {
      io.stderr(`snapwing login: ${error.message}`);
      return 1;
    }
    throw error;
  }
  io.stdout(`Logged in to ${endpoint}. Saved to ${path}.`);
  const overridden = ['SNAPWING_URL', 'SNAPWING_TOKEN'].filter((name) => (io.env[name] ?? '') !== '');
  if (overridden.length > 0) io.stderr(`Note: ${overridden.join(' and ')} in the environment still win over the saved values.`);
  return 0;
}

/** Runs `snapwing logout` and returns the exit code. */
export async function runLogout(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  if (isHelp(args)) {
    io.stdout(LOGOUT_USAGE);
    return 0;
  }
  if (args.length > 0) {
    io.stderr(`snapwing logout: takes no arguments\n${LOGOUT_USAGE}`);
    return 1;
  }
  const path = clientConfigPath(env.home);
  try {
    await rm(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      io.stdout('Not logged in.');
      return 0;
    }
    io.stderr(`snapwing logout: cannot remove ${path}.`);
    return 1;
  }
  io.stdout(`Logged out. Removed ${path}.`);
  return 0;
}
