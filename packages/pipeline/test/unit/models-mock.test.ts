import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockFixtureError, MockFixtureMissError } from '../../src/models/errors.ts';
import {
  MOCK_DEFAULT_MODEL,
  MockModel,
  createMockModelPort,
  mockFixturePath,
  mockKey,
  sha256Hex,
  writeMockFixture,
} from '../../src/models/mock.ts';
import type { ClassifyRequest, CompletionRequest, ImageReading, VisionRequest } from '../../src/ports/model.ts';

interface Severity {
  severity: 'low' | 'high';
}
const isSeverity = (v: unknown): v is Severity =>
  typeof v === 'object' && v !== null && ((v as Severity).severity === 'low' || (v as Severity).severity === 'high');

const completeReq: CompletionRequest = { task: 'clarify', system: 'You ask one question.', prompt: '<ask>which page?</ask>' };
const classifyReq: ClassifyRequest<Severity> = {
  task: 'triage',
  system: 'You triage.',
  prompt: '<incident>checkout total is blank</incident>',
  schemaName: 'severity',
  schema: { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'high'] } }, required: ['severity'] },
  validate: isSeverity,
};
const visionReq: VisionRequest = {
  task: 'vision',
  system: 'You read screenshots.',
  prompt: '<image ref="att-1"/>',
  images: [{ mimeType: 'image/png', data: 'ZmFrZS1wbmc=', ref: 'att-1' }],
};
const reading: ImageReading = {
  surfaceSignals: { urlBar: 'https://app.example.test/checkout', chrome: 'web' },
  uiElements: ['Total', 'Pay now'],
  plainDescription: 'the total field is blank',
  sensitive: false,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-mock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mockKey', () => {
  it('keys by task, schemaName, and sha256 of the prompt only', () => {
    expect(mockKey(classifyReq)).toEqual({ task: 'triage', schemaName: 'severity', promptSha256: sha256Hex(classifyReq.prompt) });
    expect(mockKey({ ...classifyReq, system: 'a different system prompt' })).toEqual(mockKey(classifyReq));
    expect(mockKey({ ...classifyReq, prompt: `${classifyReq.prompt} ` }).promptSha256).not.toBe(sha256Hex(classifyReq.prompt));
  });

  it('uses the _complete and _vision slots for the schema-less operations', () => {
    expect(mockKey(completeReq).schemaName).toBe('_complete');
    expect(mockKey(visionReq).schemaName).toBe('_vision');
  });

  it('sha256Hex is the standard digest', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('lays fixtures out as <task>/<schemaName>/<sha>.json and refuses unsafe schema names', () => {
    const key = mockKey(classifyReq);
    expect(mockFixturePath(dir, key)).toBe(join(dir, 'triage', 'severity', `${key.promptSha256}.json`));
    expect(() => mockFixturePath(dir, { ...key, schemaName: '../escape' })).toThrow(MockFixtureError);
    expect(() => mockFixturePath(dir, { ...key, schemaName: '_complete2' })).toThrow(MockFixtureError);
  });
});

describe('MockModel replay hit', () => {
  it('replays complete, vision, and classify recordings', async () => {
    await writeMockFixture(dir, completeReq, { text: 'Which page were you on?' });
    await writeMockFixture(dir, visionReq, { readings: [reading] }, { model: 'mock/vision-recorder' });
    await writeMockFixture(dir, classifyReq, { value: { severity: 'high' } }, { usage: { inputTokens: 12, outputTokens: 3 } });
    const mock = new MockModel({ fixturesDir: dir });

    await expect(mock.complete(completeReq)).resolves.toEqual({ text: 'Which page were you on?', model: MOCK_DEFAULT_MODEL });
    await expect(mock.vision(visionReq)).resolves.toEqual({ readings: [reading], model: 'mock/vision-recorder' });
    await expect(mock.classify(classifyReq)).resolves.toEqual({
      value: { severity: 'high' },
      model: MOCK_DEFAULT_MODEL,
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(mock.calls.map((k) => k.schemaName)).toEqual(['_complete', '_vision', 'severity']);
  });

  it('writes a readable fixture with the key fields and the prompt', async () => {
    const path = await writeMockFixture(dir, classifyReq, { value: { severity: 'low' } });
    const fixture: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(fixture).toEqual({
      task: 'triage',
      schemaName: 'severity',
      promptSha256: sha256Hex(classifyReq.prompt),
      prompt: classifyReq.prompt,
      response: { value: { severity: 'low' } },
    });
  });

  it('createMockModelPort gives a validated ModelPort', async () => {
    await writeMockFixture(dir, classifyReq, { value: { severity: 'low' } });
    const port = createMockModelPort({ fixturesDir: dir });
    await expect(port.classify(classifyReq)).resolves.toEqual({ value: { severity: 'low' }, attempts: 1, model: MOCK_DEFAULT_MODEL });
  });
});

describe('MockModel replay miss', () => {
  it('fails loudly with the missing key and the expected path in the message', async () => {
    const mock = new MockModel({ fixturesDir: dir });
    const key = mockKey(classifyReq);
    const err = await mock.classify(classifyReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MockFixtureMissError);
    const miss = err as MockFixtureMissError;
    expect(miss.message).toContain(`task=triage`);
    expect(miss.message).toContain(`schemaName=severity`);
    expect(miss.message).toContain(`sha256=${key.promptSha256}`);
    expect(miss.message).toContain(mockFixturePath(dir, key));
    expect(miss.path).toBe(mockFixturePath(dir, key));
  });

  it('misses on a different prompt even when task and schema match', async () => {
    await writeMockFixture(dir, classifyReq, { value: { severity: 'low' } });
    const mock = new MockModel({ fixturesDir: dir });
    await expect(mock.classify({ ...classifyReq, prompt: '<incident>something else</incident>' })).rejects.toThrow(
      MockFixtureMissError,
    );
  });

  it('misses for complete and vision too', async () => {
    const mock = new MockModel({ fixturesDir: dir });
    await expect(mock.complete(completeReq)).rejects.toThrow(/schemaName=_complete/);
    await expect(mock.vision(visionReq)).rejects.toThrow(/schemaName=_vision/);
  });
});

describe('MockModel malformed fixtures', () => {
  async function put(content: string): Promise<void> {
    const path = mockFixturePath(dir, mockKey(classifyReq));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }

  it('rejects non-JSON', async () => {
    await put('not json');
    await expect(new MockModel({ fixturesDir: dir }).classify(classifyReq)).rejects.toThrow(MockFixtureError);
  });

  it('rejects a fixture whose key fields disagree with its path', async () => {
    await put(JSON.stringify({ ...mockKey(classifyReq), schemaName: 'other', response: { value: 1 } }));
    await expect(new MockModel({ fixturesDir: dir }).classify(classifyReq)).rejects.toThrow(/schemaName is "other"/);
  });

  it('rejects a response of the wrong shape for the operation', async () => {
    await writeMockFixture(dir, completeReq, { value: 'no text here' });
    await expect(new MockModel({ fixturesDir: dir }).complete(completeReq)).rejects.toThrow(/response\.text/);
  });
});
