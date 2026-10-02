// Vision pass (main 5.2a): every image attachment in a bundle goes through the vision model with the XML
// prompt in prompts/vision.xml, and the validated ImageReading is attached as `attachment.reading`.

import { readFile } from 'node:fs/promises';
import type { Attachment, ContextBundle, ImageReading, SourceMessage } from '../../contracts/incident.ts';
import type { ImageMimeType, ModelImage, ModelPort } from '../../ports/model.ts';
import { isImageReading, unreadableReading } from './reading.ts';

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

export interface ReadImagesOptions {
  loadImage?: LoadImage;
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
 * Run the vision pass over every image attachment in `bundle.included`. One model call per image, so a
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
  const loadImage = options.loadImage ?? loadDataUrlImage;
  const included: SourceMessage[] = [];
  for (const message of bundle.included) {
    const attachments: Attachment[] = [];
    for (const attachment of message.attachments) {
      attachments.push(
        attachment.kind === 'image'
          ? { ...attachment, reading: await readOne(attachment, model, prompt, loadImage) }
          : attachment,
      );
    }
    included.push({ ...message, attachments });
  }
  return { ...bundle, included };
}
