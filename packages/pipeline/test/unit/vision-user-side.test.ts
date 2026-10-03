import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment, ContextBundle, ImageReading } from '../../src/contracts/incident.ts';
import {
  isImageReading,
  loadVisionPrompt,
  readImages,
  redactReading,
  unreadableReading,
  type LoadImage,
} from '../../src/context/vision/index.ts';
import { createMockModelPort, writeMockFixture } from '../../src/models/mock.ts';
import { toStructuredSchema } from '../../src/models/anthropic/schema.ts';
import { USER_SIDE_INDICATORS_SCHEMA, USER_SIDE_KINDS, parseUserSideIndicators } from '../../src/models/user-side.ts';
import type { ModelImage } from '../../src/ports/model.ts';

// Recorded model answers, one per scenario. Obvious fake bytes and example.test hosts only.
const BASE = { surfaceSignals: {}, uiElements: [] as string[], sensitive: false as boolean };
const RECORDED: Record<string, ImageReading> = {
  'att-staging': {
    ...BASE,
    surfaceSignals: { urlBar: 'https://staging.example.test/cart', chrome: 'web' },
    environmentHint: 'staging',
    plainDescription: 'the cart total is blank',
    userSideIndicators: [{ kind: 'wrong-environment', evidence: 'URL bar shows staging.example.test', confidence: 0.92 }],
  },
  'att-account': {
    ...BASE,
    surfaceSignals: { chrome: 'web' },
    plainDescription: 'the invoices page says no access',
    userSideIndicators: [
      { kind: 'wrong-account', evidence: 'header shows pat@other.example.test, not the reporter', confidence: 0.6 },
    ],
  },
  'att-logged-out': {
    ...BASE,
    surfaceSignals: { chrome: 'web' },
    plainDescription: 'the page keeps asking me to sign in',
    userSideIndicators: [{ kind: 'expired-session', evidence: 'banner reads "You have been logged out"', confidence: 0.95 }],
  },
  'att-clean': {
    ...BASE,
    surfaceSignals: { urlBar: 'https://app.example.test/cart', chrome: 'web' },
    environmentHint: 'production',
    plainDescription: 'the total field is blank',
    userSideIndicators: [],
  },
};
const IMAGES: Record<string, ModelImage> = Object.fromEntries(
  Object.keys(RECORDED).map((ref) => [ref, { mimeType: 'image/png', data: Buffer.from(`fake-${ref}`).toString('base64'), ref }]),
);
const loadImage: LoadImage = async (a) => IMAGES[a.url];

function bundleOf(attachment: Attachment): ContextBundle {
  return {
    anchorId: '1',
    included: [
      { id: '1', authorId: 'U1', text: 'broken', timestamp: '2026-10-02T12:00:00Z', mentions: [], reactions: [], attachments: [attachment] },
    ],
    excluded: [],
    windowUsed: { oldest: '1', latest: '1', cap: 20 },
  };
}

describe('vision user-side indicators (A 5.1)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snapwing-user-side-'));
    const prompt = await loadVisionPrompt();
    for (const [ref, reading] of Object.entries(RECORDED)) {
      await writeMockFixture(
        dir,
        { task: 'vision', system: prompt.system, prompt: prompt.request.replaceAll('{{ref}}', ref), images: [IMAGES[ref] as ModelImage] },
        { readings: [reading] },
      );
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function read(ref: string): Promise<ImageReading | undefined> {
    const out = await readImages(bundleOf({ kind: 'image', url: ref }), createMockModelPort({ fixturesDir: dir }), { loadImage });
    return out.included[0]?.attachments[0]?.reading;
  }

  it('reports a staging hostname in the URL bar', async () => {
    const r = await read('att-staging');
    expect(r?.userSideIndicators).toEqual([
      { kind: 'wrong-environment', evidence: 'URL bar shows staging.example.test', confidence: 0.92 },
    ]);
    expect(r?.environmentHint).toBe('staging');
  });

  it('reports a mismatched account', async () => {
    const r = await read('att-account');
    expect(r?.userSideIndicators?.map((i) => i.kind)).toEqual(['wrong-account']);
  });

  it('reports a logged-out banner', async () => {
    const r = await read('att-logged-out');
    expect(r?.userSideIndicators?.[0]).toMatchObject({ kind: 'expired-session', confidence: 0.95 });
  });

  it('reports none for a clean screenshot', async () => {
    const r = await read('att-clean');
    expect(r?.userSideIndicators).toEqual([]);
    expect(r?.plainDescription).toBe('the total field is blank');
  });

  it('rejects a reading with a bad indicator, and the unreadable fallback carries none', () => {
    const clean = RECORDED['att-clean'] as ImageReading;
    expect(isImageReading({ ...clean, userSideIndicators: [{ kind: 'user-error', evidence: 'x', confidence: 1 }] })).toBe(false);
    expect(isImageReading({ ...clean, userSideIndicators: [{ kind: 'other', evidence: 'x', confidence: 1.5 }] })).toBe(false);
    expect(unreadableReading().userSideIndicators).toEqual([]);
  });

  it('accepts a reading recorded before the field existed', () => {
    const { userSideIndicators: _omit, ...legacy } = RECORDED['att-clean'] as ImageReading;
    expect(isImageReading(legacy)).toBe(true);
  });

  it('redacts indicators from a sensitive reading, since evidence can quote an account', () => {
    const redacted = redactReading({ ...(RECORDED['att-account'] as ImageReading), sensitive: true });
    expect(redacted.userSideIndicators).toBeUndefined();
  });
});

describe('vision prompt', () => {
  it('asks for the field with every kind and the A 5.1 examples', async () => {
    const { request } = await loadVisionPrompt();
    expect(request).toContain('userSideIndicators');
    for (const kind of USER_SIDE_KINDS) expect(request).toContain(kind);
    for (const phrase of ['staging or localhost hostname', 'logged out', 'ad blocker', 'caps lock', 'admin portal']) {
      expect(request).toContain(phrase);
    }
  });
});

describe('userSideIndicators across providers', () => {
  it('parses leniently: drops bad entries, keeps good ones, undefined when absent', () => {
    expect(parseUserSideIndicators(undefined)).toBeUndefined();
    expect(parseUserSideIndicators(null)).toBeUndefined();
    expect(
      parseUserSideIndicators([
        { kind: 'network', evidence: 'offline banner', confidence: 0.5, extra: 1 },
        { kind: 'made-up', evidence: 'x', confidence: 0.5 },
        { kind: 'other', evidence: 'x', confidence: 2 },
        'nope',
      ]),
    ).toEqual([{ kind: 'network', evidence: 'offline banner', confidence: 0.5 }]);
  });

  it('is expressible as an Anthropic structured output, optional or not, with no type array next to an enum', () => {
    const wrapper = { type: 'object' as const, properties: { userSideIndicators: USER_SIDE_INDICATORS_SCHEMA }, required: [] };
    const sent = JSON.stringify(toStructuredSchema(wrapper));
    expect(sent).not.toMatch(/"type":\[/);
    expect(sent).toContain('"wrong-environment"');
  });
});
