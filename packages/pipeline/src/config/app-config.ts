// Application config, snapwing.config.xml (main 14.3 provider selection, main 14.5 models and harness).
// Schema: schemas/app-config.xsd. The types here are plain data; the model router (#26) consumes ModelsConfig.

import { fileURLToPath } from 'node:url';
import { parseXmlDocument, type Element } from 'slimdom';
import { validateXsd, type ValidationResult } from '../schemas/validate.ts';
import { parseDuration } from '../util/duration.ts';

export const APP_CONFIG_NAMESPACE = 'urn:snapwing:config:v1';
export const APP_CONFIG_XSD = fileURLToPath(new URL('../../../../schemas/app-config.xsd', import.meta.url));

export const RUNTIME_PROVIDERS = ['local', 'aws', 'gcp', 'docker'] as const;
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export const MODEL_TASKS = ['triage', 'segmentation', 'vision', 'clarify', 'scout', 'review'] as const;
export const HARNESS_ADAPTERS = ['claude-code', 'codex', 'gemini', 'generic'] as const;

export type RuntimeProvider = (typeof RUNTIME_PROVIDERS)[number];
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
/** Same six values as the ModelPort's ModelTask (main 14.5). */
export type ModelTask = (typeof MODEL_TASKS)[number];
export type HarnessAdapter = (typeof HARNESS_ADAPTERS)[number];

export const DEFAULT_HARNESS_ADAPTER: HarnessAdapter = 'claude-code';
export const DEFAULT_GENERIC_TIMEOUT = 'PT30M';

export interface RuntimeConfig {
  provider: RuntimeProvider;
  region?: string;
}

export interface ModelRow {
  task: ModelTask;
  provider: ModelProvider;
  name: string;
}

/**
 * Model selection. A task without a row uses `defaultProvider` with that provider's default
 * model for the task (the router decides what that is).
 */
export interface ModelsConfig {
  defaultProvider: ModelProvider;
  rows: ModelRow[];
}

export interface GenericHarnessTemplate {
  id: string;
  /** Command template; the implementation request goes on stdin (main 14.5). */
  command: string;
  /** ISO 8601 duration. */
  timeout: string;
}

export interface HarnessConfig {
  fixer: HarnessAdapter;
  review: HarnessAdapter;
  generic: GenericHarnessTemplate[];
}

/** Merge risk gate limits (main 11.3). Durations are ISO 8601. */
export interface MergeConfig {
  maxFiles: number;
  maxDiffLines: number;
  revertWindow: string;
  /** Glob patterns (`*`, `**`, `?`) matched against repo-relative paths; a hit blocks autopilot merge. */
  forbidden: string[];
}

export const DEFAULT_MERGE_FORBIDDEN: readonly string[] = [
  '.github/**',
  'infra/**',
  // Lockfiles
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/npm-shrinkwrap.json',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/Gemfile.lock',
  '**/go.sum',
  // Test and CI configuration
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/jest.config.*',
  '**/playwright.config.*',
  '**/cypress.config.*',
  '**/.eslintrc*',
  '**/eslint.config.*',
  '**/tsconfig*.json',
  '.circleci/**',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'azure-pipelines.yml',
  '.buildkite/**',
];

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  maxFiles: 10,
  maxDiffLines: 400,
  revertWindow: 'PT72H',
  forbidden: [...DEFAULT_MERGE_FORBIDDEN],
};

export interface AppConfig {
  version: 1;
  runtime: RuntimeConfig;
  models: ModelsConfig;
  harness: HarnessConfig;
  /** Always present; defaults apply when `<merge>` is absent. */
  merge: MergeConfig;
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(`Invalid snapwing config: ${message}`);
    this.name = 'AppConfigError';
  }
}

/** Validate a config document against the XSD. Never throws. */
export function validateAppConfig(xml: string): Promise<ValidationResult> {
  return validateXsd(xml, APP_CONFIG_XSD);
}

/**
 * Parse a snapwing.config.xml document into typed config. Enforces the enumerations, ISO 8601
 * durations, and one row per task itself, so it is safe without a prior XSD run, and checks that
 * a `generic` adapter has at least one template. Throws AppConfigError.
 */
export function loadAppConfig(xml: string): AppConfig {
  let root: Element | null;
  try {
    root = parseXmlDocument(xml).documentElement;
  } catch (err) {
    throw new AppConfigError(`malformed XML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!root || root.localName !== 'snapwing' || root.namespaceURI !== APP_CONFIG_NAMESPACE) {
    throw new AppConfigError(`root element must be <snapwing xmlns="${APP_CONFIG_NAMESPACE}">`);
  }
  if (root.getAttribute('version') !== '1') throw new AppConfigError('version must be "1"');

  const runtimeEl = requiredChild(root, 'runtime');
  const region = runtimeEl.getAttribute('region');
  const runtime: RuntimeConfig = {
    provider: oneOf(RUNTIME_PROVIDERS, requiredAttr(runtimeEl, 'provider'), 'runtime provider'),
    ...(region === null ? {} : { region }),
  };

  const modelsEl = requiredChild(root, 'models');
  const seen = new Set<ModelTask>();
  const rows = children(modelsEl, 'model').map((el): ModelRow => {
    const task = oneOf(MODEL_TASKS, requiredAttr(el, 'task'), 'model task');
    if (seen.has(task)) throw new AppConfigError(`task "${task}" has more than one <model> row`);
    seen.add(task);
    return {
      task,
      provider: oneOf(MODEL_PROVIDERS, requiredAttr(el, 'provider'), 'model provider'),
      name: requiredAttr(el, 'name'),
    };
  });
  const models: ModelsConfig = {
    defaultProvider: oneOf(MODEL_PROVIDERS, requiredAttr(modelsEl, 'default-provider'), 'default-provider'),
    rows,
  };

  const harnessEl = requiredChild(root, 'harness');
  const ids = new Set<string>();
  const generic = children(harnessEl, 'generic').map((el): GenericHarnessTemplate => {
    const id = requiredAttr(el, 'id');
    if (ids.has(id)) throw new AppConfigError(`generic harness id "${id}" is declared more than once`);
    ids.add(id);
    const timeout = el.getAttribute('timeout') ?? DEFAULT_GENERIC_TIMEOUT;
    try {
      parseDuration(timeout);
    } catch {
      throw new AppConfigError(`generic harness "${id}" timeout "${timeout}" is not an ISO 8601 duration`);
    }
    return { id, command: requiredAttr(el, 'command'), timeout };
  });
  const harness: HarnessConfig = {
    fixer: oneOf(HARNESS_ADAPTERS, harnessEl.getAttribute('fixer') ?? DEFAULT_HARNESS_ADAPTER, 'harness fixer'),
    review: oneOf(HARNESS_ADAPTERS, harnessEl.getAttribute('review') ?? DEFAULT_HARNESS_ADAPTER, 'harness review'),
    generic,
  };
  if ((harness.fixer === 'generic' || harness.review === 'generic') && generic.length === 0) {
    throw new AppConfigError('harness uses "generic" but declares no <generic> command template');
  }

  const merge = loadMerge(children(root, 'merge')[0]);

  return { version: 1, runtime, models, harness, merge };
}

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === name);
}

function requiredChild(parent: Element, name: string): Element {
  const el = children(parent, name)[0];
  if (!el) throw new AppConfigError(`<${parent.localName}> is missing required <${name}>`);
  return el;
}

function requiredAttr(el: Element, name: string): string {
  const value = el.getAttribute(name);
  if (value === null || value.trim() === '') throw new AppConfigError(`<${el.localName}> is missing required attribute ${name}`);
  return value;
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  const hit = allowed.find((a) => a === value);
  if (hit === undefined) throw new AppConfigError(`${what} "${value}" must be one of ${allowed.join(', ')}`);
  return hit;
}

function loadMerge(el: Element | undefined): MergeConfig {
  if (!el) return { ...DEFAULT_MERGE_CONFIG, forbidden: [...DEFAULT_MERGE_FORBIDDEN] };
  const positive = (name: string, fallback: number): number => {
    const raw = el.getAttribute(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw.trim())) throw new AppConfigError(`<merge> ${name} "${raw}" must be a positive integer`);
    return Number(raw);
  };
  const revertWindow = el.getAttribute('revert-window') ?? DEFAULT_MERGE_CONFIG.revertWindow;
  try {
    parseDuration(revertWindow);
  } catch {
    throw new AppConfigError(`<merge> revert-window "${revertWindow}" is not an ISO 8601 duration`);
  }
  const forbidden = children(el, 'forbidden').map((f) => requiredAttr(f, 'path'));
  return {
    maxFiles: positive('max-files', DEFAULT_MERGE_CONFIG.maxFiles),
    maxDiffLines: positive('max-diff-lines', DEFAULT_MERGE_CONFIG.maxDiffLines),
    revertWindow,
    // Built-in protections always apply; <forbidden> elements only add to them (main 11.3).
    forbidden: [...new Set([...DEFAULT_MERGE_FORBIDDEN, ...forbidden])],
  };
}
