// `snapwing.config.xml` writer for onboarding (main 14.3, 14.5; #397). Onboarding chooses the runtime
// and the model provider; this file renders them, validates the result against schemas/app-config.xsd,
// and writes it atomically. A config that already exists keeps everything except its `<runtime>` and
// `<models>` elements (harness, merge, jira and comments are the installer's), so running the step
// again never loses an edit. API keys never appear here: they go to `.env`.

import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  APP_CONFIG_NAMESPACE,
  DEFAULT_HARNESS_ADAPTER,
  MODEL_PROVIDERS,
  validateAppConfig,
  type ModelProvider,
  type RuntimeProvider,
} from '@snapwing/pipeline/config/app-config.ts';

export const CONFIG_FILE = 'snapwing.config.xml';

/** Main 14.5: the default provider is the first one the installer has a key for, in this order. */
export const MODEL_PROVIDER_ORDER: readonly ModelProvider[] = MODEL_PROVIDERS;

export interface RuntimeChoice {
  readonly provider: RuntimeProvider;
  /** Cloud providers only. */
  readonly region?: string;
}

export class ConfigWriteError extends Error {
  override readonly name = 'ConfigWriteError';
}

/** The first provider with a key, in the order anthropic, openai, google; undefined when none. */
export function defaultModelProvider(withKeys: readonly ModelProvider[]): ModelProvider | undefined {
  return MODEL_PROVIDER_ORDER.find((p) => withKeys.includes(p));
}

const escapeAttr = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function runtimeElement(runtime: RuntimeChoice): string {
  const region = runtime.region === undefined ? '' : ` region="${escapeAttr(runtime.region)}"`;
  return `<runtime provider="${runtime.provider}"${region}/>`;
}

/** No `<model>` rows: a task without one uses the default provider's model for it (`DEFAULT_MODELS`). */
function modelsElement(defaultProvider: ModelProvider): string {
  return `<models default-provider="${defaultProvider}"/>`;
}

/** A complete config for an install with no config yet. */
export function renderAppConfig(runtime: RuntimeChoice, defaultProvider: ModelProvider): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<snapwing xmlns="${APP_CONFIG_NAMESPACE}" version="1">
  ${runtimeElement(runtime)}
  ${modelsElement(defaultProvider)}
  <harness fixer="${DEFAULT_HARNESS_ADAPTER}" review="${DEFAULT_HARNESS_ADAPTER}"/>
</snapwing>
`;
}

const RUNTIME_RE = /<runtime\b[^>]*\/>/;
const MODELS_RE = /<models\b[^>]*?(?:\/>|>[\s\S]*?<\/models>)/;

/** `existing` with its `<runtime>` and `<models>` replaced; the rest is kept byte for byte. */
export function patchAppConfig(existing: string, runtime: RuntimeChoice, defaultProvider: ModelProvider): string {
  if (!RUNTIME_RE.test(existing) || !MODELS_RE.test(existing)) {
    throw new ConfigWriteError(`${CONFIG_FILE} has no <runtime/> and <models> elements to update`);
  }
  return existing.replace(RUNTIME_RE, () => runtimeElement(runtime)).replace(MODELS_RE, () => modelsElement(defaultProvider));
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Writes `<workdir>/snapwing.config.xml` with the runtime and default model provider, validated
 * against the XSD before anything is written (an invalid result changes nothing and throws
 * `ConfigWriteError`). Returns the path.
 */
export async function writeAppConfig(workdir: string, runtime: RuntimeChoice, defaultProvider: ModelProvider): Promise<string> {
  const path = join(workdir, CONFIG_FILE);
  const existing = await readIfExists(path);
  const next = existing === undefined ? renderAppConfig(runtime, defaultProvider) : patchAppConfig(existing, runtime, defaultProvider);
  const result = await validateAppConfig(next);
  if (!result.valid) {
    const first = result.errors[0];
    throw new ConfigWriteError(`${CONFIG_FILE} would not be valid: ${first === undefined ? 'unknown error' : first.message}`);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(tmp, next);
  await rename(tmp, path);
  return path;
}

/** A fresh `SNAPWING_ENCRYPTION_KEY`: 32 random bytes as 64 hex characters (`parseSealKey` takes it). */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}

/** A fresh `SNAPWING_FIXER_TOKEN_SECRET`: 32 random bytes as base64url (43 characters, over the 32 minimum). */
export function generateFixerTokenSecret(): string {
  return randomBytes(32).toString('base64url');
}
