// Where the interview's progress lives (ADR 0020, main 22.1 and 22.2: "Progress is saved after every
// step. An abandoned onboarding resumes where it stopped."). One versioned JSON document in the state
// store's `kv` table under `onboarding:state`, so the paste path (this CLI) and, later, the click and
// in-chat paths (the server, on the same store) read and write the same progress. On the default
// install that is `snapwing.sqlite` in the working directory, the file `snapwing serve` opens.
//
// The document holds step statuses, non-secret answers, and each step's data for later steps. It
// never holds a secret: secrets go to `.env` (`env.ts`), and the record keeps only their names.
// Writes are read-modify-write of one step's record, so two paths working on different steps do not
// overwrite each other; the last writer of one step's record wins.

import type { KvStore } from '@snapwing/pipeline/providers/local/cache.ts';

export const ONBOARDING_STATE_KEY = 'onboarding:state';
export const ONBOARDING_STATE_VERSION = 1;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * - `pending`: not started.
 * - `running`: started and not finished; after a crash or Ctrl-C this is the step to resume.
 * - `done`: finished.
 * - `blocked`: waiting on a person outside the interview (Slack admin approval, the Teams upload
 *   policy); tried again on the next run, and steps that need it wait.
 * - `skipped`: the installer chose not to (a chat platform they do not use). Final until `--step`.
 * - `not-built`: the step's module is a stub in this build; tried again on every run.
 * - `failed`: the step threw; tried again on the next run.
 */
export type StepStatus = 'pending' | 'running' | 'done' | 'blocked' | 'skipped' | 'not-built' | 'failed';

export const STEP_STATUSES: readonly StepStatus[] = Object.freeze([
  'pending',
  'running',
  'done',
  'blocked',
  'skipped',
  'not-built',
  'failed',
] as const);

/** Who or what a blocked step waits on, in plain language. */
export interface StepBlock {
  /** Who has to act, such as "a Slack workspace admin". */
  readonly on: string;
  readonly reason: string;
  /** Where that person acts, such as Slack's "Request to install" page. */
  readonly link?: string;
}

export interface StepRecord {
  readonly status: StepStatus;
  /** How many times the step has started. */
  readonly attempts: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** The way in that last ran it (main 22.1): `terminal` now; `slack` and `teams` later. */
  readonly via?: string;
  readonly blocked?: StepBlock;
  /** Why a step was skipped or not built, or what a failed step threw (secrets redacted). */
  readonly note?: string;
  /** What the step learned, for later steps and for a rerun. Never a secret. */
  readonly data?: JsonObject;
  /** Names of the `.env` keys the step wrote. Names only, never values. */
  readonly secrets?: readonly string[];
}

export interface OnboardingState {
  readonly version: typeof ONBOARDING_STATE_VERSION;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly steps: { readonly [stepId: string]: StepRecord };
}

export class OnboardingStateError extends Error {
  override readonly name = 'OnboardingStateError';
}

export function emptyState(now: Date): OnboardingState {
  const at = now.toISOString();
  return { version: ONBOARDING_STATE_VERSION, startedAt: at, updatedAt: at, steps: {} };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseRecord(id: string, raw: unknown): StepRecord {
  if (!isObject(raw)) throw new OnboardingStateError(`onboarding state: step ${id} is not an object`);
  const status = raw['status'];
  if (typeof status !== 'string' || !(STEP_STATUSES as readonly string[]).includes(status)) {
    throw new OnboardingStateError(`onboarding state: step ${id} has an unknown status ${JSON.stringify(status)}`);
  }
  const attempts = raw['attempts'];
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) {
    throw new OnboardingStateError(`onboarding state: step ${id} has no attempt count`);
  }
  for (const key of ['startedAt', 'finishedAt', 'via', 'note'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new OnboardingStateError(`onboarding state: step ${id} ${key} is not a string`);
  }
  if (raw['data'] !== undefined && !isObject(raw['data'])) throw new OnboardingStateError(`onboarding state: step ${id} data is not an object`);
  const secrets = raw['secrets'];
  if (secrets !== undefined && !(Array.isArray(secrets) && secrets.every((s) => typeof s === 'string'))) {
    throw new OnboardingStateError(`onboarding state: step ${id} secrets is not a list of names`);
  }
  const blocked = raw['blocked'];
  if (blocked !== undefined && !(isObject(blocked) && typeof blocked['on'] === 'string' && typeof blocked['reason'] === 'string')) {
    throw new OnboardingStateError(`onboarding state: step ${id} blocked is malformed`);
  }
  return raw as unknown as StepRecord;
}

/** Parses the stored document. Rejects a document from a newer Snapwing rather than guess at it. */
export function parseOnboardingState(text: string): OnboardingState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OnboardingStateError('onboarding state: not JSON');
  }
  if (!isObject(raw)) throw new OnboardingStateError('onboarding state: not an object');
  const version = raw['version'];
  if (typeof version !== 'number') throw new OnboardingStateError('onboarding state: no version');
  if (version > ONBOARDING_STATE_VERSION) {
    throw new OnboardingStateError(`onboarding state: version ${version} was written by a newer Snapwing (this one reads ${ONBOARDING_STATE_VERSION})`);
  }
  if (version !== ONBOARDING_STATE_VERSION) throw new OnboardingStateError(`onboarding state: unknown version ${version}`);
  if (typeof raw['startedAt'] !== 'string' || typeof raw['updatedAt'] !== 'string') {
    throw new OnboardingStateError('onboarding state: missing timestamps');
  }
  const steps = raw['steps'];
  if (!isObject(steps)) throw new OnboardingStateError('onboarding state: steps is not an object');
  const parsed: Record<string, StepRecord> = {};
  for (const [id, record] of Object.entries(steps)) parsed[id] = parseRecord(id, record);
  return { version: ONBOARDING_STATE_VERSION, startedAt: raw['startedAt'], updatedAt: raw['updatedAt'], steps: parsed };
}

/** Reads and writes the document. */
export interface OnboardingStore {
  /** The stored document, or undefined before the first save. */
  load(): Promise<OnboardingState | undefined>;
  /** Reads the latest document, replaces one step's record, stamps `updatedAt`, and writes it back. */
  saveStep(stepId: string, record: StepRecord, now: Date): Promise<OnboardingState>;
}

/** The store over the state store's `kv` (ADR 0020). `kv` is the store `openState` returned. */
export function createKvOnboardingStore(kv: Pick<KvStore, 'kvGet' | 'kvSet'>, key = ONBOARDING_STATE_KEY): OnboardingStore {
  const load = async (): Promise<OnboardingState | undefined> => {
    const text = await kv.kvGet(key);
    return text === undefined ? undefined : parseOnboardingState(text);
  };
  return {
    load,
    async saveStep(stepId, record, now) {
      const current = (await load()) ?? emptyState(now);
      const next: OnboardingState = {
        ...current,
        updatedAt: now.toISOString(),
        steps: { ...current.steps, [stepId]: record },
      };
      await kv.kvSet(key, JSON.stringify(next));
      return next;
    },
  };
}
