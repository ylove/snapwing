// Vision pass (main 5.2a): every image attachment in a bundle goes through the vision model with the XML
// prompt in prompts/vision.xml, and the validated ImageReading is attached as `attachment.reading`.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, ContextBundle, ImageReading, RecordingReading, SourceMessage } from '../../contracts/incident.ts';
import type { ImageMimeType, ModelImage, ModelPort } from '../../ports/model.ts';
import { isImageReading, unreadableReading } from './reading.ts';
import { readRecording } from './recording.ts';

export { isImageReading, redactReading, unreadableReading } from './reading.ts';

const PROMPT_URL = new URL('../../prompts/vision.xml', import.meta.url);
const MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface VisionPrompt {
  system: string;
  /** Request template; `{{ref}}` stands for the attachment handle. */
  request: string;
}

let promptCache: Promise<VisionPrompt> | undefined;

/** Parse prompts/vision.xml into its system prompt and request template. */
export function parseVisionPrompt(xml: string): VisionPrompt {
  const system = /<system>([\s\S]*?)<\/system>/.exec(xml)?.[1]?.trim();
  const request = /<request>([\s\S]*?)<\/request>/.exec(xml)?.[1]?.trim();
  if (system === undefined || request === undefined) throw new Error('prompts/vision.xml needs <system> and <request>');
  return { system: system.replace(/\s+/g, ' '), request };
}

export function loadVisionPrompt(): Promise<VisionPrompt> {
  promptCache ??= readFile(PROMPT_URL, 'utf8').then(parseVisionPrompt);
  return promptCache;
}

/** Fetches the bytes of an image attachment. Returns undefined when it cannot (treated as unreadable). */
export type LoadImage = (attachment: Attachment) => Promise<ModelImage | undefined>;

/** Default loader: reads inline `data:` URLs only. Adapters pass a loader that can fetch their own file URLs. */
export const loadDataUrlImage: LoadImage = async (attachment) => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.url);
  const mimeType = match?.[1] ?? attachment.mimeType;
  if (match?.[2] === undefined || mimeType === undefined || !MIME_TYPES.includes(mimeType)) return undefined;
  return { mimeType: mimeType as ImageMimeType, data: match[2], ref: attachment.url };
};

/**
 * Fetches the bytes of a video attachment through the adapter's authenticated download (Slack: the bot
 * token in the Authorization header). Returns undefined when it cannot (the recording is skipped with a note).
 */
export type LoadRecording = (attachment: Attachment) => Promise<Uint8Array | undefined>;

/** Playbook `recordings` in the units `readRecording` takes, plus test seams for ffmpeg and the temp dir. */
export interface RecordingSettings {
  /** Longest recording read, in seconds. */
  maxDuration?: number;
  sampleFps?: number;
  ffmpeg?: string;
  env?: NodeJS.ProcessEnv;
  tmpDir?: string;
}

export interface ReadImagesOptions {
  loadImage?: LoadImage;
  /** Without a loader, a video attachment is noted as skipped. */
  loadRecording?: LoadRecording;
  recordings?: RecordingSettings;
}

/** Hosts whose links are screen recordings. Recorded as links with a note, never fetched (A 5.1). */
const HOSTED_RECORDING_HOSTS: readonly string[] = [
  'loom.com',
  'cleanshot.com',
  'screencast.com',
  'screenrecorder.com',
  'vimeo.com',
  'drive.google.com',
  'youtube.com',
  'youtu.be',
  'zoom.us',
  'cloudapp.com',
  'share.vidyard.com',
  'jam.dev',
];

export function isVideoAttachment(attachment: Attachment): boolean {
  return attachment.kind === 'file' && attachment.mimeType?.toLowerCase().startsWith('video/') === true;
}

export function isHostedRecordingLink(attachment: Attachment): boolean {
  if (attachment.kind !== 'link') return false;
  try {
    const host = new URL(attachment.url).hostname.toLowerCase();
    return HOSTED_RECORDING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function readVideo(
  attachment: Attachment,
  model: ModelPort,
  load: LoadRecording | undefined,
  settings: RecordingSettings,
): Promise<RecordingReading> {
  if (load === undefined) return { status: 'skipped', note: 'recording skipped: no authenticated loader for this channel' };
  let dir: string | undefined;
  try {
    const bytes = await load(attachment);
    if (bytes === undefined || bytes.length === 0) {
      return { status: 'skipped', note: 'recording skipped: the file could not be downloaded' };
    }
    dir = await mkdtemp(join(settings.tmpDir ?? tmpdir(), 'snapwing-video-'));
    const path = join(dir, 'recording');
    await writeFile(path, bytes);
    return await readRecording(path, model, settings);
  } catch {
    return { status: 'skipped', note: 'recording skipped: the file could not be downloaded' };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readAttachment(
  attachment: Attachment,
  model: ModelPort,
  prompt: VisionPrompt,
  options: ReadImagesOptions,
): Promise<Attachment> {
  if (attachment.kind === 'image') {
    return { ...attachment, reading: await readOne(attachment, model, prompt, options.loadImage ?? loadDataUrlImage) };
  }
  if (isVideoAttachment(attachment)) {
    return { ...attachment, recording: await readVideo(attachment, model, options.loadRecording, options.recordings ?? {}) };
  }
  if (isHostedRecordingLink(attachment)) {
    return {
      ...attachment,
      recording: { status: 'skipped', note: 'hosted recording link, not fetched; open it to watch' },
    };
  }
  return attachment;
}

async function readOne(
  attachment: Attachment,
  model: ModelPort,
  prompt: VisionPrompt,
  loadImage: LoadImage,
): Promise<ImageReading> {
  try {
    const image = await loadImage(attachment);
    if (image === undefined) return unreadableReading();
    const ref = (image.ref ?? attachment.url).replace(/[<>"&]/g, '_');
    const result = await model.vision({
      task: 'vision',
      system: prompt.system,
      prompt: prompt.request.replaceAll('{{ref}}', ref),
      images: [image],
    });
    const reading: unknown = result.readings.length === 1 ? result.readings[0] : undefined;
    return isImageReading(reading) ? reading : unreadableReading();
  } catch {
    return unreadableReading();
  }
}

/**
 * Run the vision pass over every image attachment (and, A 5.1, every video attachment through `readRecording`) in `bundle.included`. One model call per image, so a
 * failure on one never costs the others. A reading that fails validation, a failed call, or an image that
 * cannot be loaded all yield `unreadableReading()`. Returns a new bundle; the input is not mutated.
 * Readings are attached unredacted; apply `redactReading` before rendering anything for a channel.
 */
export async function readImages(
  bundle: ContextBundle,
  model: ModelPort,
  options: ReadImagesOptions = {},
): Promise<ContextBundle> {
  const prompt = await loadVisionPrompt();
  const included: SourceMessage[] = [];
  for (const message of bundle.included) {
    const attachments: Attachment[] = [];
    for (const attachment of message.attachments) {
      attachments.push(await readAttachment(attachment, model, prompt, options));
    }
    included.push({ ...message, attachments });
  }
  return { ...bundle, included };
}
