// Segmentation (main 5.3) and resolution signals (main 5.4): one classify pass over the raw pile from
// collectWindow (after readImages) decides which messages belong to the anchor's incident, why the rest
// do not, and whether a later message says "do not file".

import { readFile } from 'node:fs/promises';
import type { ContextBundle, SourceMessage } from '../contracts/incident.ts';
import type { ClassifyRequest, JsonSchema, ModelPort } from '../ports/model.ts';
import type { Anchor } from './collect.ts';
import { acceptResolutionSignal } from './resolution-signal.ts';
import { redactReading } from './vision/reading.ts';

export const SEGMENT_SCHEMA_NAME = 'segmentation';
export const NOT_CLASSIFIED_REASON = 'not classified by the model';

const PROMPT_URL = new URL('../prompts/segmentation.xml', import.meta.url);

export interface SegmentAnswer {
  included: string[];
  excluded: { id: string; reason: string }[];
  /** Id of a message that means "do not file", or the empty string when there is none. */
  resolutionMessageId: string;
}

export const SEGMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    included: { type: 'array', items: { type: 'string' } },
    excluded: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
    resolutionMessageId: { type: 'string' },
  },
  required: ['included', 'excluded', 'resolutionMessageId'],
  additionalProperties: false,
};

export function isSegmentAnswer(v: unknown): v is SegmentAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o['included']) &&
    o['included'].every((id) => typeof id === 'string') &&
    Array.isArray(o['excluded']) &&
    o['excluded'].every((e) => {
      if (typeof e !== 'object' || e === null) return false;
      const x = e as Record<string, unknown>;
      return typeof x['id'] === 'string' && typeof x['reason'] === 'string';
    }) &&
    typeof o['resolutionMessageId'] === 'string'
  );
}

export interface SegmentationPrompt {
  system: string;
  /** Request template; `{{anchor}}` is the anchor id, `{{messages}}` the message list. */
  request: string;
}

/** Parse prompts/segmentation.xml into its system prompt and request template. */
export function parseSegmentationPrompt(xml: string): SegmentationPrompt {
  const system = /<system>([\s\S]*?)<\/system>/.exec(xml)?.[1]?.trim();
  const request = /<request>([\s\S]*?)<\/request>/.exec(xml)?.[1]?.trim();
  if (system === undefined || request === undefined) {
    throw new Error('prompts/segmentation.xml needs <system> and <request>');
  }
  return { system: system.replace(/\s+/g, ' '), request };
}

let promptCache: Promise<SegmentationPrompt> | undefined;

export function loadSegmentationPrompt(): Promise<SegmentationPrompt> {
  promptCache ??= readFile(PROMPT_URL, 'utf8').then(parseSegmentationPrompt);
  return promptCache;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function messageXml(m: SourceMessage): string {
  const attrs = [
    `id="${xml(m.id)}"`,
    `author="${xml(m.authorId)}"`,
    `time="${xml(m.timestamp)}"`,
    ...(m.threadParentId === undefined ? [] : [`thread-parent="${xml(m.threadParentId)}"`]),
    ...(m.mentions.length === 0 ? [] : [`mentions="${xml(m.mentions.join(','))}"`]),
    ...(m.reactions.length === 0 ? [] : [`reactions="${xml(m.reactions.join(','))}"`]),
  ];
  const readings = m.attachments.flatMap((a) => {
    if (a.reading === undefined) return [];
    // Sensitive readings are redacted before anything is rendered into a prompt.
    const r = a.reading.sensitive ? redactReading(a.reading) : a.reading;
    const s = r.surfaceSignals;
    return [
      `      <image-reading url-bar="${xml(s.urlBar ?? '')}" page-title="${xml(s.pageTitle ?? '')}" chrome="${s.chrome ?? 'unknown'}">${xml(r.plainDescription)}</image-reading>`,
    ];
  });
  const body = `      <text>${xml(m.text)}</text>`;
  return `    <message ${attrs.join(' ')}>\n${[body, ...readings].join('\n')}\n    </message>`;
}

/** The segmentation prompt text. Exported so tests can record a fixture for exactly this text. */
export function buildSegmentationPrompt(
  raw: ContextBundle,
  anchor: Anchor,
  template: SegmentationPrompt['request'],
): string {
  return template
    .replaceAll('{{anchor}}', xml(anchor.message.id))
    .replaceAll('{{messages}}', raw.included.map(messageXml).join('\n'));
}

/** The classify request for a raw pile. Exported so tests record MockModel fixtures from it. */
export function buildSegmentationRequest(
  raw: ContextBundle,
  anchor: Anchor,
  prompt: SegmentationPrompt,
): ClassifyRequest<SegmentAnswer> {
  return {
    task: 'segmentation',
    system: prompt.system,
    prompt: buildSegmentationPrompt(raw, anchor, prompt.request),
    schemaName: SEGMENT_SCHEMA_NAME,
    schema: SEGMENT_SCHEMA,
    validate: isSegmentAnswer,
    temperature: 0,
  };
}

/** Async form of buildSegmentationRequest that loads prompts/segmentation.xml. */
export async function segmentationRequest(raw: ContextBundle, anchor: Anchor): Promise<ClassifyRequest<SegmentAnswer>> {
  return buildSegmentationRequest(raw, anchor, await loadSegmentationPrompt());
}

/**
 * Sort the raw pile into the anchor's incident and the rest. The model's answer is reconciled with the
 * pile so the bundle always accounts for every message once: the anchor is always included, ids the model
 * invented are dropped, a message it left out is excluded with a stated reason, and an id it put on both
 * lists counts as included. Messages `collectWindow` already excluded keep their reason. A resolution
 * signal counts only when the named message is after the anchor.
 */
export async function segment(raw: ContextBundle, anchor: Anchor, model: ModelPort): Promise<ContextBundle> {
  const request = await segmentationRequest(raw, anchor);
  const { value } = await model.classify(request);

  const pile = new Map(raw.included.map((m) => [m.id, m]));
  const anchorId = anchor.message.id;
  const includedIds = new Set(value.included.filter((id) => pile.has(id)));
  includedIds.add(anchorId);
  const reasons = new Map<string, string>();
  for (const e of value.excluded) {
    if (pile.has(e.id) && !includedIds.has(e.id) && !reasons.has(e.id)) {
      reasons.set(e.id, e.reason.replace(/\s+/g, ' ').trim() || NOT_CLASSIFIED_REASON);
    }
  }

  const included = raw.included.filter((m) => includedIds.has(m.id));
  const excluded = [
    ...raw.excluded,
    ...raw.included
      .filter((m) => !includedIds.has(m.id))
      .map((m) => ({ id: m.id, reason: reasons.get(m.id) ?? NOT_CLASSIFIED_REASON })),
  ];

  const signal = acceptResolutionSignal(value.resolutionMessageId, raw.included, anchor.message);
  const { resolutionSignal: _dropped, ...rest } = raw;
  return {
    ...rest,
    anchorId,
    included,
    excluded,
    ...(signal === undefined ? {} : { resolutionSignal: signal }),
  };
}
