import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attachment, ContextBundle, ImageReading, SourceMessage } from '../../src/contracts/incident.ts';
import {
  isImageReading,
  loadVisionPrompt,
  readImages,
  redactReading,
  unreadableReading,
  type LoadImage,
} from '../../src/context/vision/index.ts';
import { MockModel, createMockModelPort, imagesSha256, mockKey, writeMockFixture } from '../../src/models/mock.ts';
import type { ModelImage, VisionRequest } from '../../src/ports/model.ts';
import { withValidation } from '../../src/models/router.ts';

const FIXTURES = new URL('../fixtures/vision/', import.meta.url).pathname;

// Obvious fake bytes, one distinct "image" per recording.
const IMAGES: Record<string, ModelImage> = {
  'att-web': { mimeType: 'image/png', data: Buffer.from('fake-web-screenshot').toString('base64'), ref: 'att-web' },
  'att-mobile': { mimeType: 'image/png', data: Buffer.from('fake-mobile-screenshot').toString('base64'), ref: 'att-mobile' },
  'att-admin': { mimeType: 'image/jpeg', data: Buffer.from('fake-admin-screenshot').toString('base64'), ref: 'att-admin' },
  'att-secret': { mimeType: 'image/png', data: Buffer.from('fake-secret-screenshot').toString('base64'), ref: 'att-secret' },
  'att-blank': { mimeType: 'image/png', data: Buffer.from('fake-blank-screenshot').toString('base64'), ref: 'att-blank' },
};
const loadImage: LoadImage = async (a) => IMAGES[a.url];

function image(url: string): Attachment {
  return { kind: 'image', url };
}

function bundleOf(...attachments: Attachment[]): ContextBundle {
  const message: SourceMessage = {
    id: '1',
    authorId: 'U1',
    text: 'look at this',
    timestamp: '2026-10-01T12:00:00Z',
    mentions: [],
    reactions: [],
    attachments,
  };
  return { anchorId: '1', included: [message], excluded: [], windowUsed: { oldest: '1', latest: '1', cap: 20 } };
}

function readingsOf(bundle: ContextBundle): (ImageReading | undefined)[] {
  return bundle.included.flatMap((m) => m.attachments.map((a) => a.reading));
}

describe('readImages with recordings', () => {
  it('reads a web screenshot', async () => {
    const out = await readImages(bundleOf(image('att-web')), createMockModelPort({ fixturesDir: FIXTURES }), { loadImage });
    const [r] = readingsOf(out);
    expect(r?.surfaceSignals.chrome).toBe('web');
    expect(r?.errorText).toBe('Cannot read properties of undefined');
    expect(r?.sensitive).toBe(false);
  });

  it('reads a mobile screenshot', async () => {
    const out = await readImages(bundleOf(image('att-mobile')), createMockModelPort({ fixturesDir: FIXTURES }), { loadImage });
    const [r] = readingsOf(out);
    expect(r?.surfaceSignals.chrome).toBe('mobile');
    expect(r?.environmentHint).toBe('production');
  });

  it('reads an admin screenshot with unknown in several fields', async () => {
    const out = await readImages(bundleOf(image('att-admin')), createMockModelPort({ fixturesDir: FIXTURES }), { loadImage });
    const [r] = readingsOf(out);
    expect(r?.surfaceSignals.chrome).toBe('admin');
    expect(r?.errorText).toBe('unknown');
    expect(r?.environmentHint).toBe('unknown');
  });

  it('keeps a sensitive reading intact in the bundle and redacts it for channels', async () => {
    const out = await readImages(bundleOf(image('att-secret')), createMockModelPort({ fixturesDir: FIXTURES }), { loadImage });
    const [r] = readingsOf(out);
    expect(r?.sensitive).toBe(true);
    expect(r?.errorText).toContain('sk-test-0000');
    const safe = redactReading(r as ImageReading);
    expect(safe.errorText).toBeUndefined();
    expect(safe.uiElements).toEqual([]);
    expect(JSON.stringify(safe)).not.toContain('sk-test-0000');
    expect(safe.plainDescription).toBe(r?.plainDescription);
  });

  it('accepts an unreadable image the model reports as all unknown', async () => {
    const out = await readImages(bundleOf(image('att-blank')), createMockModelPort({ fixturesDir: FIXTURES }), { loadImage });
    const [r] = readingsOf(out);
    expect(r?.plainDescription).toBe('unknown');
    expect(r?.surfaceSignals).toEqual({ urlBar: 'unknown', pageTitle: 'unknown', chrome: 'unknown' });
    expect(r?.sensitive).toBe(false);
  });

  it('calls vision once per image attachment, skips other kinds, and does not mutate the input', async () => {
    const mock = new MockModel({ fixturesDir: FIXTURES });
    const bundle = bundleOf(image('att-web'), { kind: 'link', url: 'https://example.test' }, image('att-mobile'));
    const out = await readImages(bundle, withValidation(mock), { loadImage });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.every((k) => k.task === 'vision' && k.schemaName === '_vision')).toBe(true);
    expect(out.included[0]?.attachments[1]?.reading).toBeUndefined();
    expect(bundle.included[0]?.attachments[0]?.reading).toBeUndefined();
  });

  it('sends the XML prompt and the image bytes', async () => {
    const seen: VisionRequest[] = [];
    const model = withValidation({
      ...new MockModel({ fixturesDir: FIXTURES }),
      complete: () => Promise.reject(new Error('unused')),
      classify: () => Promise.reject(new Error('unused')),
      vision: async (req) => {
        seen.push(req);
        return { readings: [unreadableReading()], model: 'test/x' };
      },
    });
    await readImages(bundleOf(image('att-web')), model, { loadImage });
    const prompt = await loadVisionPrompt();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.system).toBe(prompt.system);
    expect(seen[0]?.prompt).toBe(prompt.request.replace('{{ref}}', 'att-web'));
    expect(seen[0]?.prompt).toContain('<field name="sensitive">');
    expect(seen[0]?.images).toEqual([IMAGES['att-web']]);
  });
});

describe('failure handling', () => {
  const failing = (readings: unknown[]) =>
    withValidation({
      complete: () => Promise.reject(new Error('unused')),
      classify: () => Promise.reject(new Error('unused')),
      vision: async () => ({ readings: readings as ImageReading[], model: 'test/x' }),
    });

  it('treats a reading that fails validation like an unreadable image', async () => {
    const out = await readImages(bundleOf(image('att-web')), failing([{ plainDescription: 5 }]), { loadImage });
    expect(readingsOf(out)).toEqual([unreadableReading()]);
  });

  it('treats a wrong number of readings, a thrown call, and an unloadable image the same way', async () => {
    expect(readingsOf(await readImages(bundleOf(image('att-web')), failing([]), { loadImage }))).toEqual([unreadableReading()]);
    const missing = createMockModelPort({ fixturesDir: join(FIXTURES, 'nowhere') });
    expect(readingsOf(await readImages(bundleOf(image('att-web')), missing, { loadImage }))).toEqual([unreadableReading()]);
    expect(readingsOf(await readImages(bundleOf(image('att-gone')), failing([]), { loadImage }))).toEqual([unreadableReading()]);
  });

  it('by default loads only inline data URLs', async () => {
    const dataUrl = `data:image/png;base64,${IMAGES['att-web']?.data}`;
    const seen: ModelImage[] = [];
    const model = withValidation({
      complete: () => Promise.reject(new Error('unused')),
      classify: () => Promise.reject(new Error('unused')),
      vision: async (req) => {
        seen.push(...req.images);
        return { readings: [unreadableReading()], model: 'test/x' };
      },
    });
    await readImages(bundleOf(image(dataUrl), image('https://files.example.test/a.png')), model);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data).toBe(IMAGES['att-web']?.data);
  });
});

describe('isImageReading', () => {
  const ok: ImageReading = { surfaceSignals: {}, uiElements: [], plainDescription: 'unknown', sensitive: false };

  it('accepts unknown for every field and absent optionals', () => {
    expect(isImageReading(ok)).toBe(true);
    expect(isImageReading(unreadableReading())).toBe(true);
  });

  it('rejects wrong types and unlisted enum values', () => {
    expect(isImageReading(null)).toBe(false);
    expect(isImageReading({ ...ok, sensitive: 'no' })).toBe(false);
    expect(isImageReading({ ...ok, uiElements: [1] })).toBe(false);
    expect(isImageReading({ ...ok, surfaceSignals: { chrome: 'tablet' } })).toBe(false);
    expect(isImageReading({ ...ok, environmentHint: 'prod' })).toBe(false);
    expect(isImageReading({ ...ok, surfaceSignals: undefined })).toBe(false);
  });
});

describe('redactReading', () => {
  it('returns a non-sensitive reading unchanged', () => {
    const r: ImageReading = { errorText: 'Oops', surfaceSignals: {}, uiElements: ['Save'], plainDescription: 'x', sensitive: false };
    expect(redactReading(r)).toBe(r);
  });
});

describe('MockModel vision key', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keys on the image bytes as well as the prompt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snapwing-vision-'));
    const base = { task: 'vision', system: 's', prompt: 'same prompt' } as const;
    const a: VisionRequest = { ...base, images: [IMAGES['att-web'] as ModelImage] };
    const b: VisionRequest = { ...base, images: [IMAGES['att-mobile'] as ModelImage] };
    const readingA: ImageReading = { surfaceSignals: {}, uiElements: [], plainDescription: 'A', sensitive: false };
    const readingB: ImageReading = { ...readingA, plainDescription: 'B' };
    expect(mockKey(a).imagesSha256).not.toBe(mockKey(b).imagesSha256);
    expect(imagesSha256(a.images)).toBe(mockKey(a).imagesSha256);
    await writeMockFixture(dir, a, { readings: [readingA] });
    await writeMockFixture(dir, b, { readings: [readingB] });
    const mock = new MockModel({ fixturesDir: dir });
    expect((await mock.vision(a)).readings[0]?.plainDescription).toBe('A');
    expect((await mock.vision(b)).readings[0]?.plainDescription).toBe('B');
    await expect(mock.vision({ ...base, images: [IMAGES['att-admin'] as ModelImage] })).rejects.toThrow(/images=/);
  });
});
