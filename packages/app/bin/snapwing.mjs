#!/usr/bin/env node
// The installed `snapwing` command (ADR 0021). The packages ship TypeScript sources, and Node will not
// strip types under node_modules, so this shim registers tsx (a dependency of @snapwing/app) and runs
// the CLI's `main` from src/cli/main.ts. Inside the monorepo, `pnpm serve` and friends call
// src/cli/main.ts through tsx directly; both paths reach the same `main`.

import process from 'node:process';
import { register } from 'tsx/esm/api';

// The caller's tsconfig.json (the working directory is the user's own) has no say over our sources.
register({ tsconfig: false });

const { main } = await import('../src/cli/main.ts');
process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
