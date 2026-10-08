// The capture adapter's pieces (#3, ADR 0022): one capture per idempotency key, the screenshot as the
// anchor's attachment and never in the payload, the image loaders and their release, the client's
// choice ids by role, and the status loopback's assignee.

import { describe, expect, it } from 'vitest';
import type { CaptureRequest } from '@snapwing/capture-client/wire.ts';
import type { EventType, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { InteractiveCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import {
  captureIdOfImageUrl,
  captureImageLoader,
  captureImageUrl,
  captureScreenshotLoader,
  createCaptureAdapter,
  createCaptureContextSource,
  dropEndedCaptureImage,
  readCaptureCard,
  readCaptureRecord,
  releaseCaptureScreenshots,
} from '../../src/adapters/capture/adapter.ts';
import { fixPreviewChoices, personHandle, surfaceChoices, tapChoice, ticketStatus } from '../../src/adapters/capture/lookup.ts';

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
    delete: (k) => {
      values.delete(k);
      return Promise.resolve();
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

    const again = await adapter.normalizePayload({ request, person: DANA });
    expect(again.eventId).toBe(payload.eventId);
    expect(await readCaptureRecord(cache, payload.eventId)).toEqual({ source: 'cli', people: ['webDev'] });
    // The same words from someone else are a capture of their own.
    const other = await adapter.normalizePayload({ request, person: SAM });
    expect(other.eventId).not.toBe(payload.eventId);
    expect(other.idempotencyKey).not.toBe(payload.idempotencyKey);
    expect(await readCaptureRecord(cache, other.eventId)).toEqual({ source: 'cli', people: ['supportLead'] });
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

    // Attached, the image is deleted; another URL in the same row is left to its own loader.
    await releaseCaptureScreenshots(cache)([{ url: 'https://files.slack.com/x.png' }, { url, filename: 'screenshot.png' }]);
    expect(await captureImageLoader(cache)({ kind: 'image', url })).toBeUndefined();
    await expect(captureScreenshotLoader(cache, () => Promise.reject(new Error('not this one')))({ url })).rejects.toThrow('no longer kept');
  });

  it('drops the image at unfiled ends, and at stop ends only while filing has not started (#271)', async () => {
    const id = '01JZ0000000000000000000CAP';
    const keep = async (type: EventType, o: { jiraKey?: string; planned?: boolean } = {}): Promise<boolean> => {
      const cache = memoryCache();
      await cache.set(`capture-image:${id}`, PNG, 60);
      const state = {
        getIncident: () => Promise.resolve({ status: 'open', ...(o.jiraKey === undefined ? {} : { jiraKey: o.jiraKey }) } as unknown as IncidentView),
        read: () => Promise.resolve((o.planned === true ? [{ type: 'planned' }] : [{ type: 'captured' }]) as unknown as IncidentEvent[]),
      };
      await dropEndedCaptureImage(cache, state, { type, incidentId: id });
      return (await cache.get(`capture-image:${id}`)) !== null;
    };
    for (const type of ['stopped', 'escalated', 'closed'] as const) {
      expect(await keep(type)).toBe(false); // filing never started
      // A Stop while the create-issue row is pending or retrying: the projector hooks own the image.
      expect(await keep(type, { planned: true })).toBe(true);
      expect(await keep(type, { jiraKey: 'WEB-1', planned: true })).toBe(true);
    }
    for (const type of ['capture-cancelled', 'not-a-bug', 'user-side', 'resolution-signal'] as const) {
      expect(await keep(type)).toBe(false);
    }
    expect(await keep('not-a-bug', { jiraKey: 'WEB-1' })).toBe(true);
    expect(await keep('filed')).toBe(true);
    expect(await keep('comment')).toBe(true);
  });

  it('a pending filing still reads the image after a Stop, and the projector hook then releases it (#271)', async () => {
    const cache = memoryCache();
    const id = '01JZ0000000000000000000CAP';
    const url = captureImageUrl(id, 'image/png');
    await cache.set(`capture-image:${id}`, PNG, 60);
    const state = { getIncident: () => Promise.resolve(null as unknown as IncidentView), read: () => Promise.resolve([{ type: 'planned' }] as unknown as IncidentEvent[]) };
    await dropEndedCaptureImage(cache, state, { type: 'stopped', incidentId: id });
    const upload = await captureScreenshotLoader(cache, () => Promise.reject(new Error('no')))({ url });
    expect(upload.content).toEqual(Buffer.from(PNG, 'base64'));
    // Wired as screenshotsAttached on attach and screenshotsAbandoned on park (see the jira-projector contract test).
    await releaseCaptureScreenshots(cache)([{ url }]);
    expect(await cache.get(`capture-image:${id}`)).toBeNull();
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
    expect(tapChoice(question, 'admin', map, 'reporter')).toBe('B2B Admin Portal');
    expect(tapChoice(question, 'Website', map, 'reporter')).toBe('Website');
    expect(tapChoice(question, 'cancel', map, 'reporter')).toBe('cancel');
    expect(tapChoice(question, 'mobile', map, 'reporter')).toBeUndefined();
  });

  it('passes the file-confirm choices through, and offers none on the dedupe card', () => {
    const confirm: InteractiveCard = { kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website' };
    expect(tapChoice(confirm, 'not-this-surface', map, 'engineer')).toBe('not-this-surface');
    expect(tapChoice(confirm, 'approve_fix', map, 'engineer')).toBeUndefined();
    const dedupe: InteractiveCard = { kind: 'dedupe', issueKey: 'WEB-830', summary: 'Cart total blank' };
    // A tracked capture links at once, so the client's Open it only opens the link and nothing changes it.
    expect(tapChoice(dedupe, 'create-anyway', map, 'engineer')).toBeUndefined();
    expect(tapChoice(dedupe, 'link', map, 'engineer')).toBeUndefined();
    expect(tapChoice(dedupe, 'open', map, 'engineer')).toBeUndefined();
  });

  it('offers Fix it on the fix preview to engineers only; Ticket only to anyone', () => {
    const preview: InteractiveCard = {
      kind: 'fix-preview',
      plan: { action: 'create_issue', projectKey: 'ADM', issueType: 'Bug', summary: 'Export does nothing', descriptionAdf: {}, priority: 'Medium', labels: [], autonomyLevel: 1 },
    };
    expect(fixPreviewChoices('engineer')).toEqual([
      { id: 'approve_fix', label: 'Fix it' },
      { id: 'ticket_only', label: 'Ticket only' },
    ]);
    expect(fixPreviewChoices('reporter')).toEqual([{ id: 'ticket_only', label: 'Ticket only' }]);
    expect(fixPreviewChoices('unknown')).toEqual([{ id: 'ticket_only', label: 'Ticket only' }]);
    expect(tapChoice(preview, 'approve_fix', map, 'engineer')).toBe('approve_fix');
    expect(tapChoice(preview, 'ticket_only', map, 'engineer')).toBe('ticket_only');
    expect(tapChoice(preview, 'ticket_only', map, 'reporter')).toBe('ticket_only');
    expect(tapChoice(preview, 'approve_fix', map, 'reporter')).toBeUndefined();
    expect(tapChoice(preview, 'dismiss', map, 'engineer')).toBeUndefined();
  });
});

describe('the status loopback', () => {
  const map = { people: [DANA, SAM, { handle: 'mobDev', slackId: 'U0MOBDEV', role: 'engineer', owns: [] }] } as unknown as WorkspaceMap;
  const incident = (fields: Partial<IncidentView>): IncidentView & { jiraKey: string } =>
    ({ id: 'i1', workspaceId: 'w', status: 'filed', jiraKey: 'WEB-830', summary: 'Cart total blank', ...fields }) as IncidentView & { jiraKey: string };
  const url = (key: string): string => `https://jira.example/browse/${key}`;

  it('names a Jira assignee by their map handle, and none when the map does not know them', () => {
    expect(personHandle(map, 'dana@example.com')).toBe('webDev');
    expect(personHandle(map, 'U0MOBDEV')).toBe('mobDev');
    expect(personHandle(map, 'SUPPORTLEAD')).toBe('supportLead');
    expect(personHandle(map, '5b10ac8d82e05b22cc7d4ef5')).toBeUndefined();

    expect(ticketStatus(incident({ assigneeId: 'dana@example.com', ownerRef: 'mobDev' }), map, url)).toMatchObject({ assignee: 'webDev' });
    // A bare Jira account id says nothing to a reader: no assignee, not the raw id, and not the
    // resolved owner either, since Jira says someone else has it.
    const unknown = ticketStatus(incident({ assigneeId: '5b10ac8d82e05b22cc7d4ef5', ownerRef: 'webDev' }), map, url);
    expect(unknown).toEqual({ issueKey: 'WEB-830', summary: 'Cart total blank', status: 'open', url: 'https://jira.example/browse/WEB-830' });
    // Nobody assigned in Jira: the resolved owner.
    expect(ticketStatus(incident({ ownerRef: 'webDev' }), map, url)).toMatchObject({ assignee: 'webDev' });
  });
});
