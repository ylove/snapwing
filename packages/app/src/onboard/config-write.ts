// `snapwing.config.xml` writer for onboarding (main 14.3, 14.5; #12). Onboarding chooses the runtime
// and the model provider; this file renders them, validates the result against schemas/app-config.xsd,
// and writes it atomically. A config that already exists is edited in place with slimdom: only the
// real `<runtime>` element's `provider` (and `region`) and the `<models>` element's `default-provider`
// change, so its `<model>` rows, `refusal-fallback`, comments, and everything else the installer wrote
// survive a rerun. API keys never appear here: they go to `.env`.

import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseXmlDocument, serializeToWellFormedString, type Document, type Element, type Node } from 'slimdom';
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

/** A `<model>` row the config keeps, as written (the XSD limits both to known values). */
export interface ModelRowRef {
  readonly task: string;
  readonly provider: string;
}

/** A config's text after onboarding's edit, with the `<model>` rows it keeps. */
export interface AppConfigEdit {
  readonly xml: string;
  /** In document order; empty for a fresh config. */
  readonly rows: readonly ModelRowRef[];
}

export interface WrittenAppConfig {
  readonly path: string;
  readonly rows: readonly ModelRowRef[];
}

export class ConfigWriteError extends Error {
  override readonly name = 'ConfigWriteError';
}

/** The first provider with a key, in the order anthropic, openai, google; undefined when none. */
export function defaultModelProvider(withKeys: readonly ModelProvider[]): ModelProvider | undefined {
  return MODEL_PROVIDER_ORDER.find((p) => withKeys.includes(p));
}

const escapeAttr = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

/** A complete config for an install with no config yet. No `<model>` rows: each task uses the default provider's model. */
export function renderAppConfig(runtime: RuntimeChoice, defaultProvider: ModelProvider): string {
  const region = runtime.region === undefined ? '' : ` region="${escapeAttr(runtime.region)}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<snapwing xmlns="${APP_CONFIG_NAMESPACE}" version="1">
  <runtime provider="${runtime.provider}"${region}/>
  <models default-provider="${defaultProvider}"/>
  <harness fixer="${DEFAULT_HARNESS_ADAPTER}" review="${DEFAULT_HARNESS_ADAPTER}"/>
</snapwing>
`;
}

const isElement = (n: Node): n is Element => n.nodeType === 1;

/** `parent`'s child elements in the config namespace named `name`. Comments and text are never matched. */
function configChildren(parent: Element, name: string): Element[] {
  return parent.childNodes.filter(isElement).filter((e) => e.localName === name && e.namespaceURI === APP_CONFIG_NAMESPACE);
}

/** Sets (or, for undefined, removes) one attribute in place; true when that changed anything. */
function setAttr(el: Element, name: string, value: string | undefined): boolean {
  const before = el.getAttribute(name);
  if (value === undefined) {
    if (before === null) return false;
    el.removeAttribute(name);
    return true;
  }
  if (before === value) return false;
  el.setAttribute(name, value);
  return true;
}

/**
 * The edited document as text. slimdom keeps comments, whitespace inside the root, and attribute order;
 * it does not keep the XML declaration or the whitespace between top-level nodes, so the declaration is
 * copied from `original`, each top-level node (a comment before the root, the root) gets its own line,
 * and the original trailing whitespace ends the file.
 */
function serialize(doc: Document, original: string): string {
  const declaration = /^<\?xml[^?]*\?>/.exec(original)?.[0];
  const nodes = doc.childNodes.map((n) => serializeToWellFormedString(n));
  const trailing = /\s*$/.exec(original)?.[0] ?? '';
  return `${[...(declaration === undefined ? [] : [declaration]), ...nodes].join('\n')}${trailing}`;
}

/**
 * `existing` with its runtime and default model provider set. Only the `<runtime>` and `<models>`
 * children of the root are touched, and only those attributes: `<model>` rows, `refusal-fallback`,
 * and every other element and comment stay. When nothing changes the text comes back byte for byte.
 * Throws `ConfigWriteError` for a document that is not a Snapwing config or has no element to edit.
 */
export function patchAppConfig(existing: string, runtime: RuntimeChoice, defaultProvider: ModelProvider): AppConfigEdit {
  let doc: Document;
  try {
    doc = parseXmlDocument(existing);
  } catch (e) {
    throw new ConfigWriteError(`${CONFIG_FILE} is not well-formed XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const root = doc.documentElement;
  if (root === null || root.localName !== 'snapwing' || root.namespaceURI !== APP_CONFIG_NAMESPACE) {
    throw new ConfigWriteError(`${CONFIG_FILE} is not a Snapwing config: its root is not <snapwing xmlns="${APP_CONFIG_NAMESPACE}">`);
  }
  const runtimeEl = configChildren(root, 'runtime')[0];
  const modelsEl = configChildren(root, 'models')[0];
  if (runtimeEl === undefined || modelsEl === undefined) {
    throw new ConfigWriteError(`${CONFIG_FILE} has no <runtime> and <models> elements to update`);
  }
  const changes = [
    setAttr(runtimeEl, 'provider', runtime.provider),
    setAttr(runtimeEl, 'region', runtime.region),
    setAttr(modelsEl, 'default-provider', defaultProvider),
  ];
  const rows = configChildren(modelsEl, 'model').map((el) => ({ task: el.getAttribute('task') ?? '', provider: el.getAttribute('provider') ?? '' }));
  return { xml: changes.includes(true) ? serialize(doc, existing) : existing, rows };
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
 * `ConfigWriteError`). Returns the path and the `<model>` rows the file keeps.
 */
export async function writeAppConfig(workdir: string, runtime: RuntimeChoice, defaultProvider: ModelProvider): Promise<WrittenAppConfig> {
  const path = join(workdir, CONFIG_FILE);
  const existing = await readIfExists(path);
  const next: AppConfigEdit =
    existing === undefined ? { xml: renderAppConfig(runtime, defaultProvider), rows: [] } : patchAppConfig(existing, runtime, defaultProvider);
  const result = await validateAppConfig(next.xml);
  if (!result.valid) {
    const first = result.errors[0];
    throw new ConfigWriteError(`${CONFIG_FILE} would not be valid: ${first === undefined ? 'unknown error' : first.message}`);
  }
  if (next.xml !== existing) {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    await writeFile(tmp, next.xml);
    await rename(tmp, path);
  }
  return { path, rows: next.rows };
}

/** A fresh `SNAPWING_ENCRYPTION_KEY`: 32 random bytes as 64 hex characters (`parseSealKey` takes it). */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}

/** A fresh `SNAPWING_FIXER_TOKEN_SECRET`: 32 random bytes as base64url (43 characters, over the 32 minimum). */
export function generateFixerTokenSecret(): string {
  return randomBytes(32).toString('base64url');
}
