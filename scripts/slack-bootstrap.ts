// `pnpm slack:bootstrap` (main 14.4, 15.1, 22.4): idempotent, read-only checks of the Slack app. A thin
// wrapper: the logic lives in `packages/app/src/onboard/slack/bootstrap.ts` (onboarding step 1 uses the same
// code); see its header for the checks.
// Reads .env.live (then the process environment), never prints a token, and exits non-zero with one
// line per failed check.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatReport, parseEnvFile, runBootstrap } from '../packages/app/src/onboard/slack/bootstrap.ts';

export * from '../packages/app/src/onboard/slack/bootstrap.ts';

async function main(): Promise<void> {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(readFileSync('.env.live', 'utf8'));
  } catch {
    // No .env.live: fall back to the process environment.
  }
  const report = await runBootstrap({ env: { ...process.env, ...fileEnv } });
  for (const line of formatReport(report)) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
