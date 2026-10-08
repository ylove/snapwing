// Live check for the default Anthropic models: one small call each, through the router, so a
// request shape the model rejects (forced tool_choice, disabled thinking, temperature) fails here.
// Classify runs on Claude Opus 5.5 and vision on Claude Sonnet 5.5; both use structured outputs, and both
// go to the beta endpoint with `fallbacks: "default"` and `server-side-fallback-2026-07-01`, so a
// rejected fallback shape fails here too. Vision sends a 64x64 PNG (images.ts).
// Reads ANTHROPIC_API_KEY from the environment, else from the `.env.live` at SNAPWING_ENV_LIVE or at this
// checkout's root (never above it, env-file.ts); skips without it.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anthropicProvider } from '../../../src/models/anthropic/index.ts';
import { createModelRouter, MODEL_TASK_LIST } from '../../../src/models/router.ts';
import { envLiveFile } from './env-file.ts';
import { whitePng } from './images.ts';

function liveKey(): string | undefined {
  const fromEnv = process.env['ANTHROPIC_API_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const file = envLiveFile();
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const value = line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
  return value === undefined || value === '' ? undefined : value;
}

const key = liveKey();

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
