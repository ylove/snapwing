// The LLM pass of message classification (Companion A 1.2). A message that missed the lexicon and sits
// in an active incident's thread goes to the model through the ModelPort (task `segmentation`, schema
// `signal`). The model returns one intent or `none` and a confidence; an intent under
// `lexicon.confidenceFloor` (default 0.7) is dropped. The caller decides which messages qualify.

import { readFile } from 'node:fs/promises';
import type { PlaybookSignals } from '../config/playbook.ts';
import type { SourceMessage } from '../contracts/incident.ts';
import type { Intent } from '../contracts/signals.ts';
import type { ClassifyRequest, JsonSchema, ModelPort } from '../ports/model.ts';

export const SIGNAL_SCHEMA_NAME = 'signal';

const PROMPT_URL = new URL('../prompts/signals.xml', import.meta.url);

const INTENTS: readonly Intent[] = [
  'trigger', 'escalate', 'claim', 'release', 'stop', 'accept', 'reject', 'watch', 'not-a-bug', 'none',
];

export interface SignalAnswer {
  intent: Intent;
  confidence: number;
}

export const SIGNAL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    confidence: { type: 'number' },
  },
  required: ['intent', 'confidence'],
  additionalProperties: false,
};

export function isSignalAnswer(v: unknown): v is SignalAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['intent'] === 'string' &&
    (INTENTS as readonly string[]).includes(o['intent']) &&
    typeof o['confidence'] === 'number' &&
    Number.isFinite(o['confidence'])
  );
}

/** What the handler consumes: an intent worth acting on with its confidence, or `none`. */
export type LlmClassification = { intent: Exclude<Intent, 'none'>; confidence: number } | { intent: 'none' };

export type SignalMessage = Pick<SourceMessage, 'id' | 'authorId' | 'text' | 'timestamp'>;

export interface SignalPrompt {
  system: string;
  /** Request template; `{{thread}}` is the earlier thread messages, `{{message}}` the message to classify. */
  request: string;
}

/** Parse prompts/signals.xml into its system prompt and request template. */
export function parseSignalPrompt(xml: string): SignalPrompt {
  const system = /<system>([\s\S]*?)<\/system>/.exec(xml)?.[1]?.trim();
  const request = /<request>([\s\S]*?)<\/request>/.exec(xml)?.[1]?.trim();
  if (system === undefined || request === undefined) throw new Error('prompts/signals.xml needs <system> and <request>');
  return { system: system.replace(/\s+/g, ' '), request };
}

let promptCache: Promise<SignalPrompt> | undefined;

export function loadSignalPrompt(): Promise<SignalPrompt> {
  promptCache ??= readFile(PROMPT_URL, 'utf8').then(parseSignalPrompt);
  return promptCache;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function messageXml(m: SignalMessage): string {
  return `      <message id="${xml(m.id)}" author="${xml(m.authorId)}" time="${xml(m.timestamp)}"><text>${xml(m.text)}</text></message>`;
}

/** The classify request for one message. Exported so tests can see exactly what the model is sent. */
export function buildSignalRequest(
  message: SignalMessage,
  thread: readonly SignalMessage[],
  prompt: SignalPrompt,
): ClassifyRequest<SignalAnswer> {
  return {
    task: 'segmentation',
    system: prompt.system,
    prompt: prompt.request
      .replaceAll('{{thread}}', thread.map(messageXml).join('\n'))
      .replaceAll('{{message}}', messageXml(message)),
    schemaName: SIGNAL_SCHEMA_NAME,
    schema: SIGNAL_SCHEMA,
    validate: isSignalAnswer,
    temperature: 0,
  };
}

/**
 * Classify a message that missed the lexicon. `thread` is the earlier messages of the incident's thread,
 * oldest first, as context. An answer of `none`, a confidence under the floor, or a confidence above 1
 * comes back as `none`.
 */
export async function classifyLlm(
  signals: Pick<PlaybookSignals, 'lexicon'>,
  message: SignalMessage,
  thread: readonly SignalMessage[],
  model: ModelPort,
): Promise<LlmClassification> {
  const { value } = await model.classify(buildSignalRequest(message, thread, await loadSignalPrompt()));
  if (value.intent === 'none') return { intent: 'none' };
  if (!(value.confidence >= signals.lexicon.confidenceFloor) || value.confidence > 1) return { intent: 'none' };
  return { intent: value.intent, confidence: value.confidence };
}
