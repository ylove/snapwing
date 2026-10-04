// The capture adapter's pieces (#385, ADR 0022): one capture per idempotency key, the screenshot as the
// anchor's attachment and never in the payload, the image loaders, and the client's choice ids.

import { describe, expect, it } from 'vitest';
import type { CaptureRequest } from '@snapwing/capture-client/wire.ts';
import type { InteractiveCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import {
  captureIdOfImageUrl,
  captureImageLoader,
  captureImageUrl,
  captureScreenshotLoader,
  createCaptureAdapter,
  createCaptureContextSource,
  readCaptureCard,
  readCaptureRecord,
} from '../../src/adapters/capture/adapter.ts';
import { surfaceChoices, tapChoice } from '../../src/adapters/capture/lookup.ts';

function memoryCache(): CachePort {
  const values = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(values.get(k) ?? null),
    set: (k, v) => {
      values.set(k, v);
      return Promise.resolve();
    },
    setIfAbsent: (k, v) => {
      if (values.has(k)) return Promise.resolve(false);
      values.set(k, v);
      return Promise.resolve(true);
    },
  };
}

const DANA: MapPerson = { handle: 'webDev', email: 'dana@example.com', role: 'engineer', owns: [] };
const SAM: MapPerson = { handle: 'supportLead', role: 'reporter', owns: [] };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const clock = (): Date => new Date('2026-10-03T09:00:00.000Z');

describe('createCaptureAdapter', () => {
  it('normalizes text to a payload whose reporter is the map person; a resend is the same capture', async () => {
    const cache = memoryCache();
    const adapter = createCaptureAdapter('cli', { cache, clock });
    const request: CaptureRequest = { source: 'cli', text: 'checkout total is blank', surface: 'web', context: { url: 'https://shop.example.com/cart' } };
    expect(await adapter.authenticateRequest({ request, person: DANA })).toBe(true);
    expect(await createCaptureAdapter('raycast', { cache, clock }).authenticateRequest({ request, person: DANA })).toBe(false);

    const payload = await adapter.normalizePayload({ request, person: DANA });
    expect(payload).toMatchObject({
      source: 'cli',
      reporter: { id: 'webDev', name: 'webDev', email: 'dana@example.com', role: 'engineer' },
      anchorText: 'checkout total is blank\n\nURL: https://shop.example.com/cart',
      context: { channelId: 'cli:webDev', surfaceHint: 'web' },
    });
    expect(payload.idempotencyKey).toMatch(/^cli-[0-9a-f]{64}$/);
    expect(await adapter.acknowledge({ request, person: DANA }, payload)).toEqual({ captureId: payload.eventId });

    const again = await adapter.normalizePayload({ request, person: SAM });
    expect(again.eventId).toBe(payload.eventId);
    expect(await readCaptureRecord(cache, payload.eventId)).toEqual({ source: 'cli', people: ['webDev', 'supportLead'] });
  });

  it('keeps a screenshot in kv, out of the payload, as the anchor message attachment', async () => {
    const cache = memoryCache();
    const adapter = createCaptureAdapter('raycast', { cache, clock });
    const payload = await adapter.normalizePayload({ request: { source: 'raycast', image: PNG, mimeType: 'image/png' }, person: DANA });
    expect(payload.anchorText).toBe('');
    expect(JSON.stringify(payload)).not.toContain(PNG);
    expect(payload.context.rawPayloadSnapshot).toMatchObject({ kind: 'image', image: { mimeType: 'image/png', bytes: 8 } });

    const anchor = await createCaptureContextSource().anchor(payload);
    const url = captureImageUrl(payload.eventId, 'image/png');
    expect(anchor.message.attachments).toEqual([{ kind: 'image', url, mimeType: 'image/png' }]);
    expect(captureIdOfImageUrl(url)).toBe(payload.eventId);
    expect(captureIdOfImageUrl('https://files.slack.com/x.png')).toBeUndefined();

    expect(await captureImageLoader(cache)({ kind: 'image', url })).toEqual({ mimeType: 'image/png', data: PNG, ref: url });
    expect(await captureImageLoader(cache)({ kind: 'image', url: `data:image/png;base64,${PNG}` })).toMatchObject({ data: PNG });
    const upload = await captureScreenshotLoader(cache, () => Promise.reject(new Error('not this one')))({ url, filename: 'screenshot.png' });
    expect(upload).toEqual({ filename: 'screenshot.png', content: Buffer.from(PNG, 'base64'), contentType: 'image/png' });
  });

  it('keeps the card the engine posts, by capture id', async () => {
    const cache = memoryCache();
    const adapter = createCaptureAdapter('cli', { cache, clock });
    const payload = await adapter.normalizePayload({ request: { source: 'cli', text: 'x' }, person: DANA });
    const card: InteractiveCard = { kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website' };
    await adapter.postInteractive(payload, card);
    expect(await readCaptureCard(cache, payload.eventId)).toEqual(card);
  });
});

describe('the client choices', () => {
  const map = { surfaces: [{ id: 'web', label: 'Website' }, { id: 'admin', label: 'B2B Admin Portal' }] } as unknown as WorkspaceMap;
  const question: InteractiveCard = {
    kind: 'clarify',
    question: { audience: 'reporter', text: 'New. Which surface?', options: ['Website', 'B2B Admin Portal'], asks: 'surface', gatePassed: true, gateFailures: [] },
  };

  it('offers each surface by id and taps the engine with its label', () => {
    expect(surfaceChoices(['Website', 'B2B Admin Portal'], map)).toEqual([
      { id: 'web', label: 'Website' },
      { id: 'admin', label: 'B2B Admin Portal' },
      { id: 'cancel', label: 'Cancel' },
    ]);
    expect(tapChoice(question, 'admin', map)).toBe('B2B Admin Portal');
    expect(tapChoice(question, 'Website', map)).toBe('Website');
    expect(tapChoice(question, 'cancel', map)).toBe('cancel');
    expect(tapChoice(question, 'mobile', map)).toBeUndefined();
  });

  it('passes the file-confirm and dedupe choices through, and nothing else', () => {
    const confirm: InteractiveCard = { kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website' };
    expect(tapChoice(confirm, 'not-this-surface', map)).toBe('not-this-surface');
    expect(tapChoice(confirm, 'approve_fix', map)).toBeUndefined();
    const dedupe: InteractiveCard = { kind: 'dedupe', issueKey: 'WEB-830', summary: 'Cart total blank' };
    expect(tapChoice(dedupe, 'create-anyway', map)).toBe('create-anyway');
    expect(tapChoice(dedupe, 'open', map)).toBeUndefined();
  });
});
