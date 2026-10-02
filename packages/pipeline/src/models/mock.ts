// Recorded mock provider for the unit and contract tiers (main 14.5, ADR 0002). No network, no keys.
//
// A recording is keyed by (task, schemaName, sha256(prompt)) and lives at
//   <fixturesDir>/<task>/<schemaName>/<sha256 hex>.json
// A vision request also keys on its images: sha256 of the image bytes joined in order, written
//   <fixturesDir>/vision/_vision/<prompt sha256>-<images sha256>.json
// so two requests with one prompt and different screenshots never share a recording.
// `complete` and `vision` have no schema; their slot is `_complete` and `_vision`. File shape:
//   { "task": "triage", "schemaName": "triage-plan", "promptSha256": "<hex>",
//     "prompt": "<optional, for humans reading the fixture>",
//     "response": { "value": ... } | { "text": "..." } | { "readings": [ ... ] },
//     "model": "<optional, defaults to mock/recorded>", "usage": { "inputTokens": 0, "outputTokens": 0 } }
// A request with no recording throws MockFixtureMissError naming the key and the expected path.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ClassifyRequest,
  CompletionRequest,
  CompletionResult,
  ImageReading,
  ModelBackend,
  ModelImage,
  ModelPort,
  ModelTask,
  ModelUsage,
  RawClassifyResult,
  VisionRequest,
  VisionResult,
} from '../ports/model.ts';
import { MockFixtureError, MockFixtureMissError } from './errors.ts';
import { withValidation } from './router.ts';

export const MOCK_COMPLETE_SLOT = '_complete';
export const MOCK_VISION_SLOT = '_vision';
export const MOCK_DEFAULT_MODEL = 'mock/recorded';

export interface MockKey {
  task: ModelTask;
  /** The classify schemaName, or `_complete` / `_vision`. */
  schemaName: string;
  promptSha256: string;
  /** Vision only: sha256 over the decoded bytes of every image, in order (see `imagesSha256`). */
  imagesSha256?: string;
}

export type MockResponse = { text: string } | { readings: ImageReading[] } | { value: unknown };

export interface MockFixture extends MockKey {
  prompt?: string;
  response: MockResponse;
  model?: string;
  usage?: ModelUsage;
}

type Operation = 'complete' | 'vision' | 'classify';

const SCHEMA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash of the image bytes of a vision request: each image hashed, the hex digests joined with newlines, hashed again. */
export function imagesSha256(images: ModelImage[]): string {
  const parts = images.map((image) => createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex'));
  return sha256Hex(parts.join('\n'));
}

/** The replay key for a request. `classify` uses its schemaName; the other two use their slot name. */
export function mockKey(request: CompletionRequest | VisionRequest | ClassifyRequest<unknown>): MockKey {
  const schemaName =
    'schemaName' in request ? request.schemaName : 'images' in request ? MOCK_VISION_SLOT : MOCK_COMPLETE_SLOT;
  const key: MockKey = { task: request.task, schemaName, promptSha256: sha256Hex(request.prompt) };
  if ('images' in request) key.imagesSha256 = imagesSha256(request.images);
  return key;
}

export function formatMockKey(key: MockKey): string {
  const images = key.imagesSha256 === undefined ? '' : `, images=${key.imagesSha256}`;
  return `(task=${key.task}, schemaName=${key.schemaName}, sha256=${key.promptSha256}${images})`;
}

/** Where the recording for `key` lives under `fixturesDir`. Rejects schema names that are not safe path segments. */
export function mockFixturePath(fixturesDir: string, key: MockKey): string {
  if (key.schemaName !== MOCK_COMPLETE_SLOT && key.schemaName !== MOCK_VISION_SLOT && !SCHEMA_NAME.test(key.schemaName)) {
    throw new MockFixtureError(
      join(fixturesDir, key.task),
      `schemaName "${key.schemaName}" is not usable as a fixture path segment (letters, digits, ".", "_", "-"; no leading "." or "_")`,
    );
  }
  const name = key.imagesSha256 === undefined ? key.promptSha256 : `${key.promptSha256}-${key.imagesSha256}`;
  return join(fixturesDir, key.task, key.schemaName, `${name}.json`);
}

/**
 * Write a recording for `request`. Used by recorders in the live tier and by tests that build fixtures
 * on the fly. Recordings must hold obvious fakes only: never a token, key, or real credential.
 */
export async function writeMockFixture(
  fixturesDir: string,
  request: CompletionRequest | VisionRequest | ClassifyRequest<unknown>,
  response: MockResponse,
  extra: { model?: string; usage?: ModelUsage; includePrompt?: boolean } = {},
): Promise<string> {
  const key = mockKey(request);
  const path = mockFixturePath(fixturesDir, key);
  const fixture: MockFixture = {
    ...key,
    ...(extra.includePrompt === false ? {} : { prompt: request.prompt }),
    response,
    ...(extra.model === undefined ? {} : { model: extra.model }),
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return path;
}

export interface MockModelOptions {
  fixturesDir: string;
  /** Reported as `model` when a fixture does not name one. */
  model?: string;
}

/**
 * Replays recordings. A ModelBackend: its `classify` returns the recorded value without running
 * `validate`, exactly like a vendor adapter, so the shared retry contract in withValidation is
 * exercised the same way in tests as in production. Use `createMockModelPort` for a ready ModelPort.
 */
export class MockModel implements ModelBackend {
  readonly fixturesDir: string;
  readonly defaultModel: string;
  /** Every key looked up, hit or miss, in call order. Handy for asserting what a stage asked. */
  readonly calls: MockKey[] = [];

  constructor(options: MockModelOptions) {
    this.fixturesDir = options.fixturesDir;
    this.defaultModel = options.model ?? MOCK_DEFAULT_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { fixture, path } = await this.lookup('complete', request);
    const { response } = fixture;
    if (!('text' in response) || typeof response.text !== 'string') {
      throw new MockFixtureError(path, 'a complete recording needs response.text (string)');
    }
    return { text: response.text, ...this.meta(fixture) };
  }

  async vision(request: VisionRequest): Promise<VisionResult> {
    const { fixture, path } = await this.lookup('vision', request);
    const { response } = fixture;
    if (!('readings' in response) || !Array.isArray(response.readings)) {
      throw new MockFixtureError(path, 'a vision recording needs response.readings (array)');
    }
    return { readings: response.readings, ...this.meta(fixture) };
  }

  async classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
    const { fixture, path } = await this.lookup('classify', request);
    const { response } = fixture;
    if (!('value' in response)) throw new MockFixtureError(path, 'a classify recording needs response.value');
    return { value: response.value, ...this.meta(fixture) };
  }

  private meta(fixture: MockFixture): { model: string; usage?: ModelUsage } {
    return { model: fixture.model ?? this.defaultModel, ...(fixture.usage === undefined ? {} : { usage: fixture.usage }) };
  }

  private async lookup(
    op: Operation,
    request: CompletionRequest | VisionRequest | ClassifyRequest<unknown>,
  ): Promise<{ fixture: MockFixture; path: string }> {
    const key = mockKey(request);
    this.calls.push(key);
    const path = mockFixturePath(this.fixturesDir, key);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) throw new MockFixtureMissError(`${op} ${formatMockKey(key)}`, path);
      throw err;
    }
    return { fixture: parseFixture(text, path, key), path };
  }
}

/** A MockModel wrapped in the shared classify contract: the ModelPort a unit test hands to a stage. */
export function createMockModelPort(options: MockModelOptions): ModelPort {
  return withValidation(new MockModel(options));
}

/** Provider factory for createModelRouter: every route replays from the same fixtures directory. */
export function mockModelProvider(fixturesDir: string): () => ModelBackend {
  return () => new MockModel({ fixturesDir });
}

function parseFixture(text: string, path: string, key: MockKey): MockFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new MockFixtureError(path, `not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MockFixtureError(path, 'not a JSON object');
  const f = raw as Record<string, unknown>;
  for (const field of ['task', 'schemaName', 'promptSha256', 'imagesSha256'] as const) {
    if (f[field] !== key[field]) {
      throw new MockFixtureError(path, `${field} is ${JSON.stringify(f[field])}, expected ${JSON.stringify(key[field])}`);
    }
  }
  const response = f['response'];
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new MockFixtureError(path, 'response must be an object');
  }
  if (f['model'] !== undefined && typeof f['model'] !== 'string') throw new MockFixtureError(path, 'model must be a string');
  return raw as MockFixture;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
