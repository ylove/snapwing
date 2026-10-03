// The e2e tier's secrets (main 14.4): read from `.env.live` (at the repository root, or at
// SNAPWING_ENV_LIVE) and then the process environment, as the live tier does. No value is ever logged,
// put in an assertion message, or written anywhere; `missing` lists names only.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';

/** Every Jira summary, Slack message, and PR body the tier writes starts with this. */
export const PREFIX = '[snapwing-test]';
/** The fixture repository (GitHub App installed on it only). */
export const FIXTURE_REPO = 'ylove/snapwing-fixture-web';

/** What the composed server needs, plus the test channel and the two test users (CONTEXT.md 6b). */
export const E2E_SECRETS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEST_CHANNEL',
  'SLACK_TEST_REPORTER_TOKEN',
  'SLACK_TEST_REPORTER_ID',
  'SLACK_TEST_ENGINEER_TOKEN',
  'SLACK_TEST_ENGINEER_ID',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_FIELD_IMPL_PROMPT',
  'JIRA_FIELD_CONVERSATION',
  'JIRA_FIELD_AUTONOMY',
  'JIRA_FIELD_AGENT_STATUS',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
] as const;

/** Model keys: the one the run's model provider needs, and ANTHROPIC_API_KEY for the claude-code fixer. */
export const MODEL_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'] as const;

export type E2eSecretName = (typeof E2E_SECRETS)[number] | (typeof MODEL_KEYS)[number];

export interface LiveEnv {
  /** The `.env.live` path (it may not exist; then everything comes from the environment). */
  file: string;
  /** True when the file exists. */
  fileExists: boolean;
  secrets: SecretsPort;
  values: Readonly<Record<E2eSecretName, string>>;
  /** Names of required secrets that are unset. */
  missing: string[];
  /** The Jira project the tier files in. */
  projectKey: string;
}

export function findEnvFile(): string {
  const fromEnv = process.env.SNAPWING_ENV_LIVE;
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env.live');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(dir, '.env.live');
}

async function optional(secrets: SecretsPort, name: string): Promise<string> {
  try {
    const value = await secrets.get(name);
    return value.trim() === '' ? '' : value;
  } catch (e) {
    if (e instanceof SecretNotFoundError) return '';
    throw e;
  }
}

export async function loadLiveEnv(): Promise<LiveEnv> {
  const file = findEnvFile();
  const secrets = createEnvFileSecrets({ path: file });
  const entries = await Promise.all(E2E_SECRETS.map(async (name) => [name, await optional(secrets, name)] as const));
  const keys = await Promise.all(MODEL_KEYS.map(async (name) => [name, await optional(secrets, name)] as const));
  const values = Object.fromEntries([...entries, ...keys]) as Record<E2eSecretName, string>;
  const missing = entries.filter(([, v]) => v === '').map(([k]) => k);
  const projectKey = (await optional(secrets, 'JIRA_PROJECT_KEY')) || 'OAJ';
  return { file, fileExists: existsSync(file), secrets, values, missing, projectKey };
}

/** A SecretsPort that answers `overlay` first (per-run values such as the tunnel URL), then `inner`. */
export function overlaySecrets(inner: SecretsPort, overlay: Readonly<Record<string, string>>): SecretsPort {
  return {
    get: (name) => {
      const v = overlay[name];
      return v === undefined ? inner.get(name) : Promise.resolve(v);
    },
  };
}
