#!/usr/bin/env -S npx tsx
// The `snapwing` CLI. Minimal on purpose: `node:util` parseArgs, one module per command group.
// `serve` is the server composition root (server/serve.ts). Later phases add `map`, `jira reproject`, and `onboard`.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runServe } from '../server/serve.ts';
import { runConfig } from './config.ts';
import { runState, type CliIo } from './state.ts';

export const USAGE = `Usage: snapwing <command> [args]

Commands:
  serve           run the API and worker processes (see: snapwing serve --help)
  config check    validate the map, playbook, and instructions (see: snapwing config --help)
  state rebuild   rebuild projections from the event log (see: snapwing state --help)`;

/** Runs the CLI and returns the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'serve':
      return runServe(rest, io);
    case 'config':
      return runConfig(rest, io);
    case 'state':
      return runState(rest, io);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      io.stdout(USAGE);
      return command === undefined ? 1 : 0;
    default:
      io.stderr(`snapwing: unknown command ${JSON.stringify(command)}\n${USAGE}`);
      return 1;
  }
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
