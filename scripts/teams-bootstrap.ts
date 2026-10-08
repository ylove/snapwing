// `pnpm teams:bootstrap` (main 14.4, 15.2, 22.4): idempotent checks of the Teams app. A thin wrapper: the
// logic lives in `packages/app/src/onboard/teams/install.ts` (the Teams onboarding step uses the same code);
// see its header for the checks.
//   pnpm teams:bootstrap            checks only: bot and Graph tokens, the messaging endpoint answers 401,
//                                   the test team and channel exist, the app is installed with every grant;
//                                   writes TEAMS_TEST_TEAM_ID and TEAMS_TEST_CHANNEL_ID to .env.live
//   pnpm teams:bootstrap --install  first signs the team owner in by device code, then publishes or updates
//                                   the app in the tenant catalog and installs it in the test team
// Reads .env.live (then the process environment), never prints a token or the app password, and exits
// non-zero with one line per failed check.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnvFile } from '../packages/app/src/onboard/slack/bootstrap.ts';
import { createTeamsGraph } from '../packages/app/src/adapters/teams/graph.ts';
import {
  adminCenterSteps,
  formatReport,
  installTeamsApp,
  runTeamsBootstrap,
  signInByDeviceCode,
} from '../packages/app/src/onboard/teams/install.ts';

export * from '../packages/app/src/onboard/teams/install.ts';

const ENV_FILE = '.env.live';

async function install(env: Record<string, string | undefined>): Promise<boolean> {
  const need = (key: string): string => {
    const v = env[key]?.trim();
    if (!v) throw new Error(`${key} is not set`);
    return v;
  };
  const appId = need('TEAMS_APP_ID');
  const teamId = need('TEAMS_TEST_TEAM_ID');
  const publicUrl = env['TEAMS_PUBLIC_URL']?.trim() || need('SNAPWING_PUBLIC_URL');
  const token = await signInByDeviceCode({
    tenantId: need('TEAMS_TENANT_ID'),
    clientId: appId,
    prompt: (p) => console.log(`Sign in as the team owner: open ${p.verificationUri} and enter the code ${p.userCode} (valid ${Math.round(p.expiresIn / 60)} minutes).`),
  });
  const result = await installTeamsApp({ graph: createTeamsGraph({ token: token.reveal() }), appId, publicUrl, teamId });
  console.log(`catalog ${result.catalog}, install ${result.install}, mode ${result.mode}${result.reason === undefined ? '' : ` (${result.reason})`}`);
  for (const w of result.warnings) console.log(`warn ${w}`);
  if (result.adminSteps.length > 0) {
    let packageFile: string | undefined;
    if (result.packageZip !== undefined) {
      packageFile = join(tmpdir(), 'snapwing-teams-app.zip');
      writeFileSync(packageFile, result.packageZip);
    }
    const steps = packageFile === undefined ? result.adminSteps : adminCenterSteps({ uploadNeeded: true, teamId, packageFile });
    console.log('This tenant needs an admin to finish the install:');
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(readFileSync(ENV_FILE, 'utf8'));
  } catch {
    // No .env.live: fall back to the process environment.
  }
  const env = { ...process.env, ...fileEnv };
  if (process.argv.includes('--install')) {
    try {
      if (!(await install(env))) {
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      console.log(`FAIL install: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }
  const report = await runTeamsBootstrap({
    env,
    readEnvFile: () => (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''),
    writeEnvFile: (text) => writeFileSync(ENV_FILE, text),
  });
  for (const line of formatReport(report)) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
