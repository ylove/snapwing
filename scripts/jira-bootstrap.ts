// `pnpm jira:bootstrap` (main 14.4, B 7.2): idempotent setup of the Jira project the live tier uses. A thin
// wrapper: the logic lives in `packages/app/src/onboard/jira/bootstrap.ts` (onboarding step 2 runs the same
// code); see its header for what each run does.
//   pnpm jira:bootstrap [webhook] [--dry-run] [--config <path>]
// Reads .env.live (then the process environment), never prints a secret, one line per check.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnvFile, runBootstrap } from '../packages/app/src/onboard/jira/bootstrap.ts';

export * from '../packages/app/src/onboard/jira/bootstrap.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const mode = args.includes('webhook') ? 'webhook' : 'fields';
  const at = args.indexOf('--config');
  const configPath = at === -1 ? undefined : args[at + 1];
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(readFileSync('.env.live', 'utf8'));
  } catch {
    // No .env.live: the missing-values line says what to add.
  }
  const report = await runBootstrap({ env: { ...process.env, ...fileEnv }, mode, dryRun, ...(configPath === undefined ? {} : { configPath }) });
  for (const line of report.lines) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
