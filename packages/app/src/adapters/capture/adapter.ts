// The capture adapter (main 15.3, 15.4, 14.2; ADR 0022): the IngestionAdapter behind the capture API,
// one per capture source (`cli`, `raycast`). Raycast and the CLI share it and its routes; nothing in the
// pipeline knows which one called, and `source` only shapes the idempotency key and metrics.
//
// Inbound requests reach it as a `CaptureInbound`: the validated wire request plus the map person the
// route found for the bearer token (`routes.ts` verifies every token with `verifyCaptureToken` and
// checks the handle against the map before anything reaches the engine). `authenticateRequest` only
// confirms that the route did so for this source.
//
// A capture's id is its incident id (the payload's `eventId`). The same text or image from the same
// source within the idempotency window (24 h, main 14.2) is one capture: kv `capture-key:{key}` maps the
// key to the id the first send minted, so a resend answers with the capture it already started, and
// whoever resent it may answer it too.
//
// What the adapter keeps in kv (B 1 fallback cache), each for `CAPTURE_TTL_SEC`:
//   capture:{id}        { source, people, image? }: who sent it and the image's type
//   capture-card:{id}   the card the engine posted last, exactly as posted
//   capture-image:{id}  the image's bytes, base64, until the Jira projector has attached them
// An image is the anchor message's one image attachment at `snapwing-capture://image/{id}/screenshot.<ext>`;
// `captureImageLoader` reads it for the vision pass, as a DMed screenshot is read, and
// `captureScreenshotLoader` for the Jira attachment. The image never enters the event log.

import { Buffer } from 'node:buffer';
import type { CaptureRequest } from '@snapwing/capture-client/wire.ts';
import { loadDataUrlImage, type LoadImage } from '@snapwing/pipeline/context/vision/index.ts';
import type { Anchor } from '@snapwing/pipeline/context/collect.ts';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { CanonicalIncidentPayload, CaptureSource, IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import { captureIdempotencyKey, RAYCAST_IDEMPOTENCY_TTL_SEC, type ContextSource } from '@snapwing/pipeline/engine/deps.ts';
import { directAnchor } from '@snapwing/pipeline/engine/steps.ts';
import type { MapPerson } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { ImageMimeType } from '@snapwing/pipeline/ports/model.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import type { UploadAttachmentInput } from '../../jira/client/types.ts';
import type { LoadScreenshot, ScreenshotRef } from '../../jira/projector/ops.ts';

export const CAPTURE_SOURCES: readonly CaptureSource[] = Object.freeze(['cli', 'raycast']);
/** How long a capture's record, card, and image are kept: past the tap timeout and the Jira filing. */
export const CAPTURE_TTL_SEC = 7 * 24 * 60 * 60;
/** The image types the vision pass reads; any other is refused at the route. */
export const CAPTURE_IMAGE_TYPES: readonly ImageMimeType[] = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_URL_PREFIX = 'snapwing-capture://image/';
const EXTENSIONS: Readonly<Record<ImageMimeType, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A capture request after the route verified its token: the wire request and the token's map person. */
export interface CaptureInbound {
  readonly request: CaptureRequest;
  readonly person: MapPerson;
}

/** What `acknowledge` hands back to the route: the capture to look up. */
export interface CaptureAck {
  readonly captureId: string;
}

export function isCaptureAck(value: unknown): value is CaptureAck {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['captureId'] === 'string';
}

/** kv `capture:{id}`. */
export interface CaptureRecord {
  source: CaptureSource;
  /** Map handles of everyone who sent it, first sender first. */
  people: string[];
  image?: { mimeType: ImageMimeType };
}

export function isCaptureSourceName(value: string): value is CaptureSource {
  return (CAPTURE_SOURCES as readonly string[]).includes(value);
}

// kv ------------------------------------------------------------------------------------------------

const recordKey = (id: string): string => `capture:${id}`;
const cardKey = (id: string): string => `capture-card:${id}`;
const imageKey = (id: string): string => `capture-image:${id}`;
const idempotencyKey = (key: string): string => `capture-key:${key}`;

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** The capture's record, or undefined when it is unknown or expired. */
export async function readCaptureRecord(cache: CachePort, captureId: string): Promise<CaptureRecord | undefined> {
  const value = parseJson(await cache.get(recordKey(captureId)));
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const source = r['source'];
  const people = r['people'];
  if (typeof source !== 'string' || !isCaptureSourceName(source) || !Array.isArray(people)) return undefined;
  const image = r['image'] as { mimeType?: unknown } | undefined;
  const mimeType = image?.mimeType;
  return {
    source,
    people: people.filter((p): p is string => typeof p === 'string'),
    ...(typeof mimeType === 'string' && (CAPTURE_IMAGE_TYPES as readonly string[]).includes(mimeType) ? { image: { mimeType: mimeType as ImageMimeType } } : {}),
  };
}

/** The card the engine posted last for the capture, or undefined before the first one. */
export async function readCaptureCard(cache: CachePort, captureId: string): Promise<InteractiveCard | undefined> {
  const value = parseJson(await cache.get(cardKey(captureId)));
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['kind'] === 'string' ? (value as InteractiveCard) : undefined;
}

// Images --------------------------------------------------------------------------------------------

export function captureImageUrl(captureId: string, mimeType: ImageMimeType): string {
  return `${IMAGE_URL_PREFIX}${captureId}/screenshot.${EXTENSIONS[mimeType]}`;
}

/** The capture id of a `captureImageUrl`, or undefined for any other URL. */
export function captureIdOfImageUrl(url: string): string | undefined {
  if (!url.startsWith(IMAGE_URL_PREFIX)) return undefined;
  const id = url.slice(IMAGE_URL_PREFIX.length).split('/')[0] ?? '';
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : undefined;
}

function mimeTypeOfUrl(url: string): ImageMimeType | undefined {
  const ext = url.split('.').pop();
  return (Object.keys(EXTENSIONS) as ImageMimeType[]).find((t) => EXTENSIONS[t] === ext);
}

/** The vision pass's loader: capture images from kv, anything else through `fallback` (default: `data:` URLs). */
export function captureImageLoader(cache: CachePort, fallback: LoadImage = loadDataUrlImage): LoadImage {
  return async (attachment) => {
    const id = captureIdOfImageUrl(attachment.url);
    if (id === undefined) return fallback(attachment);
    const data = await cache.get(imageKey(id));
    const mimeType = mimeTypeOfUrl(attachment.url);
    if (data === null || mimeType === undefined) return undefined;
    return { mimeType, data, ref: attachment.url };
  };
}

/** The Jira projector's loader: capture images from kv, anything else through `fallback`. */
export function captureScreenshotLoader(cache: CachePort, fallback: LoadScreenshot): LoadScreenshot {
  return async (ref: ScreenshotRef): Promise<UploadAttachmentInput> => {
    const id = captureIdOfImageUrl(ref.url);
    if (id === undefined) return fallback(ref);
    const data = await cache.get(imageKey(id));
    if (data === null) throw new Error(`capture ${id}: the image is no longer kept`);
    const contentType = ref.contentType ?? mimeTypeOfUrl(ref.url);
    return { filename: ref.filename ?? ref.url.split('/').pop() ?? 'screenshot', content: Buffer.from(data, 'base64'), ...(contentType === undefined ? {} : { contentType }) };
  };
}

// The adapter ---------------------------------------------------------------------------------------

export interface CaptureAdapterOptions {
  readonly cache: CachePort;
  readonly clock: () => Date;
  /** The idempotency window; default 24 h, the engine's for capture sources. */
  readonly idempotencyTtlSec?: number;
}

export type CaptureAdapter = IngestionAdapter<CaptureInbound, CaptureAck> & { readonly channelSource: CaptureSource };

function actorOf(person: MapPerson): IncidentActor {
  return { id: person.handle, name: person.handle, ...(person.email === undefined ? {} : { email: person.email }), role: person.role };
}

/** The idempotency key's content: the text, or the image's bytes (main 14.2). */
function contentOf(request: CaptureRequest): string | Uint8Array {
  return 'text' in request ? request.text : Buffer.from(request.image, 'base64');
}

export function createCaptureAdapter(source: CaptureSource, options: CaptureAdapterOptions): CaptureAdapter {
  const { cache, clock } = options;
  const keyTtl = options.idempotencyTtlSec ?? RAYCAST_IDEMPOTENCY_TTL_SEC;

  /** The capture id for `key`: the one an earlier send minted, else a new one. */
  async function captureIdFor(key: string): Promise<{ id: string; fresh: boolean }> {
    const minted = ulid(clock().getTime());
    if (await cache.setIfAbsent(idempotencyKey(key), minted, keyTtl)) return { id: minted, fresh: true };
    const earlier = await cache.get(idempotencyKey(key));
    return earlier === null ? { id: minted, fresh: true } : { id: earlier, fresh: false };
  }

  return {
    channelSource: source,

    authenticateRequest(raw) {
      // The route verified the bearer token and the map handle; this confirms it did so for this source.
      return Promise.resolve(raw.request.source === source && raw.person.handle !== '');
    },

    async normalizePayload(raw) {
      const { request, person } = raw;
      const key = captureIdempotencyKey(source, contentOf(request));
      const { id, fresh } = await captureIdFor(key);
      const imageData = 'image' in request ? request.image : undefined;
      const image = 'image' in request ? { mimeType: request.mimeType as ImageMimeType } : undefined;
      const earlier = fresh ? undefined : await readCaptureRecord(cache, id);
      if (earlier === undefined) {
        const record: CaptureRecord = { source, people: [person.handle], ...(image === undefined ? {} : { image }) };
        if (imageData !== undefined) await cache.set(imageKey(id), imageData, CAPTURE_TTL_SEC);
        await cache.set(recordKey(id), JSON.stringify(record), CAPTURE_TTL_SEC);
      } else if (!earlier.people.includes(person.handle)) {
        await cache.set(recordKey(id), JSON.stringify({ ...earlier, people: [...earlier.people, person.handle] }), CAPTURE_TTL_SEC);
      }
      const text = 'text' in request ? request.text : '';
      const url = request.context?.url;
      const snapshot: Record<string, unknown> = {
        captureSource: source,
        person: person.handle,
        kind: image === undefined ? 'text' : 'image',
        ...(request.surface === undefined ? {} : { surface: request.surface }),
        ...(url === undefined ? {} : { url }),
        ...(image === undefined || imageData === undefined ? {} : { image: { mimeType: image.mimeType, bytes: Buffer.byteLength(imageData, 'base64') } }),
      };
      return {
        eventId: id,
        idempotencyKey: key,
        source,
        reporter: actorOf(person),
        // The page the text came from reads like a line of the report (surface inference sees it).
        anchorText: url === undefined ? text : `${text}${text === '' ? '' : '\n\n'}URL: ${url}`,
        context: {
          channelId: `${source}:${person.handle}`,
          ...(request.surface === undefined ? {} : { surfaceHint: request.surface }),
          rawPayloadSnapshot: snapshot,
        },
        timestamp: clock().toISOString(),
      } satisfies CanonicalIncidentPayload;
    },

    acknowledge(_raw, payload) {
      return Promise.resolve({ captureId: payload.eventId });
    },

    async postInteractive(payload, card) {
      // The client reads it from here (`lookup.ts`); a capture has no chat to post in.
      await cache.set(cardKey(payload.eventId), JSON.stringify(card), CAPTURE_TTL_SEC);
    },

    postStatus(_payload: CanonicalIncidentPayload, _status: StatusUpdate) {
      // A capture has no thread: the client polls `GET /capture/:id` or `GET /issues/:key/status`.
      return Promise.resolve();
    },
  };
}

/**
 * The read side of a capture (main 5.2): no channel to read, so the anchor is the payload itself, plus
 * the image as its one attachment when the capture was a screenshot. Deterministic per payload.
 */
export function createCaptureContextSource(): ContextSource {
  return {
    anchor(payload): Promise<Anchor> {
      const base = directAnchor(payload);
      const image = payload.context.rawPayloadSnapshot['image'] as { mimeType?: unknown } | undefined;
      const mimeType = image?.mimeType;
      if (typeof mimeType !== 'string' || !(CAPTURE_IMAGE_TYPES as readonly string[]).includes(mimeType)) return Promise.resolve(base);
      const type = mimeType as ImageMimeType;
      return Promise.resolve({ ...base, message: { ...base.message, attachments: [{ kind: 'image', url: captureImageUrl(payload.eventId, type), mimeType: type }] } });
    },
  };
}
