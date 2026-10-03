// Builds the model request for the ask-back question (main 7). The prompt text lives in prompts/clarify.xml.

import { readFile } from 'node:fs/promises';
import { withInstructions, type WorkspaceInstructions } from '../config/instructions.ts';
import type { CanonicalIncidentPayload, ContextBundle } from '../contracts/incident.ts';
import type { ClassifyRequest, JsonSchema } from '../ports/model.ts';
import type { CandidateQuestion, QuestionAsks, QuestionKind } from './gate.ts';

export const CLARIFY_SCHEMA_NAME = 'clarify-question';

const PROMPT_URL = new URL('../prompts/clarify.xml', import.meta.url);

export interface ClarifyPrompt {
  system: string;
  /** Request template with `{{name}}` placeholders. */
  request: string;
}

let promptCache: Promise<ClarifyPrompt> | undefined;

export function parseClarifyPrompt(xml: string): ClarifyPrompt {
  const system = /<system>([\s\S]*?)<\/system>/.exec(xml)?.[1]?.trim();
  const request = /<request>([\s\S]*?)<\/request>/.exec(xml)?.[1]?.trim();
  if (system === undefined || request === undefined) throw new Error('prompts/clarify.xml needs <system> and <request>');
  return { system: system.replace(/\s+/g, ' '), request };
}

export function loadClarifyPrompt(): Promise<ClarifyPrompt> {
  promptCache ??= readFile(PROMPT_URL, 'utf8').then(parseClarifyPrompt);
  return promptCache;
}

/** What is still unknown after layer 1. */
export type ClarifyGap = 'surface' | 'component';

export interface ClarifyPromptInput {
  gap: ClarifyGap;
  /** Labels of the surfaces (or the surface's components) the question may offer, from the map. */
  options: readonly string[];
  /** INSTRUCTIONS.md (A 6.3), appended to the system prompt. Absent means no block. */
  instructions?: WorkspaceInstructions;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const KINDS: readonly QuestionKind[] = ['experiential', 'technical'];
const ASKS: readonly QuestionAsks[] = ['surface', 'component', 'environment', 'symptom', 'other'];

export function isCandidateQuestion(v: unknown): v is CandidateQuestion {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o['audience'] === 'reporter' || o['audience'] === 'engineer') &&
    KINDS.includes(o['kind'] as QuestionKind) &&
    ASKS.includes(o['asks'] as QuestionAsks) &&
    typeof o['text'] === 'string' &&
    Array.isArray(o['options']) &&
    o['options'].every((x) => typeof x === 'string') &&
    typeof o['screenshotRequest'] === 'boolean'
  );
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    audience: { type: 'string', enum: ['reporter', 'engineer'] },
    kind: { type: 'string', enum: [...KINDS] },
    asks: { type: 'string', enum: [...ASKS] },
    text: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    screenshotRequest: { type: 'boolean' },
  },
  required: ['audience', 'kind', 'asks', 'text', 'options', 'screenshotRequest'],
  additionalProperties: false,
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z-]+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The ask-back request. Exported so tests can record a MockModel fixture for exactly this text. */
export async function buildClarifyRequest(
  payload: CanonicalIncidentPayload,
  bundle: ContextBundle,
  input: ClarifyPromptInput,
): Promise<ClassifyRequest<CandidateQuestion>> {
  const prompt = await loadClarifyPrompt();
  const context = bundle.included
    .filter((m) => m.id !== bundle.anchorId)
    .map((m) => `      <message id="${xml(m.id)}">${xml(m.text)}</message>`)
    .join('\n');
  const images = bundle.included
    .flatMap((m) => m.attachments)
    .flatMap((a) => (a.reading === undefined ? [] : [`      <image-reading>${xml(a.reading.plainDescription)}</image-reading>`]))
    .join('\n');
  const options = input.options.map((o) => `      <option>${xml(o)}</option>`).join('\n');
  return {
    task: 'clarify',
    system: withInstructions(prompt.system, input.instructions),
    prompt: fill(prompt.request, {
      gap: input.gap,
      'reporter-role': payload.reporter.role,
      report: xml(payload.anchorText),
      context,
      images,
      options,
    }),
    schemaName: CLARIFY_SCHEMA_NAME,
    schema: SCHEMA,
    validate: isCandidateQuestion,
    temperature: 0,
  };
}
