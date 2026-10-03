// Live check for the default Anthropic models (#275): one small call each, through the router, so a
// request shape the model rejects (forced tool_choice, disabled thinking, temperature) fails here.
// Classify runs on Claude Opus 5.5 and vision on Claude Sonnet 5.5; both use structured outputs.
// Reads ANTHROPIC_API_KEY from the environment, else from the `.env.live` at SNAPWING_ENV_LIVE or up the
// tree; skips without it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { anthropicProvider } from '../../../src/models/anthropic/index.ts';
import { createModelRouter, MODEL_TASK_LIST } from '../../../src/models/router.ts';

function liveKey(): string | undefined {
  const fromEnv = process.env['ANTHROPIC_API_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  let file = process.env['SNAPWING_ENV_LIVE'];
  for (let dir = process.cwd(); file === undefined; dir = dirname(dir)) {
    if (existsSync(join(dir, '.env.live'))) file = join(dir, '.env.live');
    else if (dirname(dir) === dir) return undefined;
  }
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const value = line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
  return value === undefined || value === '' ? undefined : value;
}

const key = liveKey();

/** A 64x64 white RGB PNG as base64. The API refuses the contract suite's 1x1 image ("Could not process image"). */
function whitePng(size = 64): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0xff)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function port(model: string) {
  return createModelRouter(
    { defaultProvider: 'anthropic', rows: MODEL_TASK_LIST.map((task) => ({ task, provider: 'anthropic' as const, name: model })) },
    { anthropic: anthropicProvider },
    { ANTHROPIC_API_KEY: key ?? '' },
  );
}

interface Label { label: 'bug' | 'question'; note?: string }
const isLabel = (v: unknown): v is Label =>
  typeof v === 'object' && v !== null && 'label' in v && (v.label === 'bug' || v.label === 'question') &&
  (!('note' in v) || typeof v.note === 'string');

describe.skipIf(!key)('anthropic default models live', () => {
  it('classify on claude-opus-5-5 answers through structured outputs', async () => {
    const result = await port('claude-opus-5-5').classify({
      task: 'triage',
      system: '<system>Classify the report.</system>',
      prompt: '<report>The checkout button does nothing when clicked.</report>',
      temperature: 0,
      schemaName: 'live_label',
      schema: {
        type: 'object',
        properties: { label: { type: 'string', enum: ['bug', 'question'] }, note: { type: 'string', maxLength: 80 } },
        required: ['label'],
      },
      validate: isLabel,
    });
    expect(result.value.label).toBe('bug');
    expect(result.model).toBe('anthropic/claude-opus-5-5');
  }, 120_000);

  it('vision on claude-sonnet-5-5 returns one reading', async () => {
    const result = await port('claude-sonnet-5-5').vision({
      task: 'vision',
      system: '<system>Read the screenshot.</system>',
      prompt: '<request>Describe the image in a few words.</request>',
      temperature: 0,
      images: [{ mimeType: 'image/png', data: whitePng() }],
    });
    expect(result.readings).toHaveLength(1);
    expect(result.readings[0]).toMatchObject({ plainDescription: expect.any(String), sensitive: expect.any(Boolean) });
    expect(result.model).toBe('anthropic/claude-sonnet-5-5');
  }, 120_000);
});
