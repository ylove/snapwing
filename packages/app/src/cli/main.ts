#!/usr/bin/env -S npx tsx
// The `snapwing` CLI. Minimal on purpose: `node:util` parseArgs, one module per command group, and
// one row per command in `COMMANDS` below. A new command appends its row and keeps the others; the
// usage text is built from the table. `serve` is the server composition root (server/serve.ts).
// Bare `snapwing` (no command) prints the usage and is otherwise left unclaimed on purpose: a later
// local-first mode may give it a meaning.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runServe } from '../server/serve.ts';
import { defaultCaptureEnv, runLog, runSay, runShot, runStatus, runStop, type CaptureEnv } from './capture.ts';
import { runConfig } from './config.ts';
import { runLogin, runLogout } from './login.ts';
import { runMap } from './map.ts';
import { runOnboard } from './onboard.ts';
import { runState, type CliIo } from './state.ts';
import { runToken } from './token.ts';

/** What commands reach beyond `CliIo`. Tests pass their own; the real CLI builds the defaults lazily. */
export interface CliDeps {
  /** Home, prompts, stdin, screenshot tools, fetch, and browser for the capture commands. */
  readonly capture: () => CaptureEnv;
}

export interface CliCommand {
  /** How the usage names it, such as `config check`; default the command name. */
  readonly label?: string;
  readonly summary: string;
  readonly run: (args: readonly string[], io: CliIo, deps: CliDeps) => Promise<number>;
}

/** The command table: one row per command. Append yours, keep the others. */
export const COMMANDS: Readonly<Record<string, CliCommand>> = {
  serve: {
    summary: 'run the API and worker processes',
    run: (args, io) => runServe(args, io),
  },
  config: {
    label: 'config check',
    summary: 'validate the map, playbook, and instructions',
    run: (args, io) => runConfig(args, io),
  },
  state: {
    label: 'state rebuild',
    summary: 'rebuild projections from the event log',
    run: (args, io) => runState(args, io),
  },
  login: {
    summary: 'store the capture endpoint and your token',
    run: (args, io, deps) => runLogin(args, io, deps.capture()),
  },
  logout: {
    summary: 'forget the stored endpoint and token',
    run: (args, io, deps) => runLogout(args, io, deps.capture()),
  },
  shot: {
    label: 'shot [file]',
    summary: 'report a screenshot: the file, the clipboard image, or the newest on disk',
    run: (args, io, deps) => runShot(args, io, deps.capture()),
  },
  say: {
    label: 'say "<text>"',
    summary: 'report a sentence',
    run: (args, io, deps) => runSay(args, io, deps.capture()),
  },
  log: {
    label: 'log < file',
    summary: 'report what arrives on stdin, like a stack trace',
    run: (args, io, deps) => runLog(args, io, deps.capture()),
  },
  status: {
    label: 'status [KEY]',
    summary: "a ticket's status loopback; with no key, the server's health",
    run: (args, io, deps) => runStatus(args, io, deps.capture()),
  },
  stop: {
    label: 'stop KEY',
    summary: 'stop the work on a ticket (engineers only)',
    run: (args, io, deps) => runStop(args, io, deps.capture()),
  },
  map: {
    label: 'map show|set-level|set-trigger',
    summary: 'read and edit the workspace map (validated, written atomically)',
    run: (args, io) => runMap(args, io),
  },
  token: {
    label: 'token issue|list|revoke',
    summary: 'issue, list, and revoke per-user capture tokens',
    run: (args, io) => runToken(args, io),
  },
  onboard: {
    summary: 'set Snapwing up by interview; picks up where it stopped',
    run: (args, io) => runOnboard(args, io),
  },
};

function usage(): string {
  const width = Math.max(...Object.entries(COMMANDS).map(([name, c]) => (c.label ?? name).length));
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${(c.label ?? name).padEnd(width)} ${c.summary}`);
  return `Usage: snapwing <command> [args]\n\nCommands:\n${rows.join('\n')}\n\nEvery command takes --help.`;
}

export const USAGE = usage();

/** Runs the CLI and returns the exit code. */
export async function main(argv: readonly string[], io: CliIo, deps?: Partial<CliDeps>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout(USAGE);
    return command === undefined ? 1 : 0;
  }
  const row = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (row === undefined) {
    io.stderr(`snapwing: unknown command ${JSON.stringify(command)}\n${USAGE}`);
    return 1;
  }
  let capture: CaptureEnv | undefined;
  const resolved: CliDeps = { capture: deps?.capture ?? (() => (capture ??= defaultCaptureEnv())) };
  return row.run(rest, io, resolved);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exitCode = code;
}
