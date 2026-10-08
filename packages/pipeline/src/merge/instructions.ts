// src/merge/instructions.ts: workspace instructions applied at the two steps the agent takes on its own,
// the autopilot merge and the fixer start (A 6.3, A 6.4; main 11.3).
//
// `checkInstructions(gate, input)` asks the model, with one classify call over the instructions block
// (in the system prompt, as triage and clarify carry it) and the incident, whether any instruction
// holds this step. No instructions means no call and no hold. The answer can only hold: instructions
// make the agent more careful, never bolder (A 6.4), so nothing here can raise a level or skip a gate.
// A model call that fails is a hold too ("the workspace instructions could not be checked"), so a
// broken check degrades rather than silently going ahead.
//
// A hold degrades one level for this step only:
// - merge (merge/job.ts): `held { kind: 'gate', reason }` and `level-changed` 3 to 2, the same fall back
//   to the main 11.2 human path a failed gate takes. The reason is the status sentence
//   ("Holding for the release window per workspace instructions"), which the status message shows as
//   is (status/copy.ts). A human's Merge tap on the card still merges, as that human (merge/actions.ts).
// - fixer start (fixer/job.ts): nothing starts; `level-changed` to 0 (ticket-only) with the reason
//   `instructions-held: <sentence> (mention @handle)`. The status message reads "Filed as KEY. <sentence>.
//   Over to @handle." (status/loopback.ts). A later start needs a person: a human event after the hold
//   that asks for one (a Jira transition, a Fix it tap, a claim handed back); that start wins, and
//   `instructions-overridden: <who>` restores the level to at most 2, so the PR it opens goes to a person.
//
// The step's own deps carry the gate (`MergeDeps.instructionsGate`, `FixerDeps.instructionsGate`):
// the live instructions getter (#284 reloads INSTRUCTIONS.md) and the model.

import { readFile } from 'node:fs/promises';
import type { AutonomyLevel } from '../contracts/events.ts';
import { escapeXmlText, withInstructions, type WorkspaceInstructions } from '../config/instructions.ts';
import type { ClassifyRequest, JsonSchema, ModelPort, ModelTask } from '../ports/model.ts';

/** Where the step's deps get the instructions and the model from. */
export interface InstructionsGate {
  /** The instructions in force now; undefined when the workspace has none. Called once per check. */
  instructions: () => WorkspaceInstructions | undefined | Promise<WorkspaceInstructions | undefined>;
  model: ModelPort;
}

export type InstructionsStep = 'merge' | 'fixer-start';

/** What the model sees about the incident. Every field is optional: absent means not known. */
export interface InstructionsIncident {
  issueKey?: string;
  summary?: string;
  surfaceId?: string;
  componentId?: string;
  repo?: string;
  priority?: string;
  level?: AutonomyLevel;
  reporter?: { name?: string; role?: string };
  /** The anchor message, the report as the reporter wrote it. */
  report?: string;
}

export interface InstructionsCheckInput {
  step: InstructionsStep;
  now: Date;
  incident: InstructionsIncident;
  /** Merge: the pull request and its changed files. */
  pullRequest?: { number: number; files: readonly { path: string; additions: number; deletions: number }[] };
  /** Fixer start: the implementation request XML (likely files, scope). */
  implementationRequest?: string;
}

export type InstructionsCheck =
  | { hold: false }
  | {
      hold: true;
      /** The status sentence, no final period: "Holding for the release window per workspace instructions". */
      status: string;
      /** The instruction the model quoted; empty when the check failed. */
      instruction: string;
      /** The handle to mention, without the @. */
      mention?: string;
      /** True when the model call failed and the hold is the careful default. */
      failed?: true;
    };

/** The model's answer (the classify schema below). */
export interface InstructionsHoldAnswer {
  hold: boolean;
  instruction: string;
  reason: string;
  mention: string;
}

export const INSTRUCTIONS_HOLD_SCHEMA_NAME = 'instructions-hold';
/** The model route the check uses: triage's (it is a reading of the same block triage reads). */
export const INSTRUCTIONS_HOLD_TASK: ModelTask = 'triage';
export const INSTRUCTIONS_HOLD_SUFFIX = 'per workspace instructions';
/** The status sentence when the model call failed. */
export const INSTRUCTIONS_CHECK_FAILED = 'Holding because the workspace instructions could not be checked';
/** Prefix of the `level-changed` reason that records a fixer start held by the instructions. */
export const INSTRUCTIONS_HELD_REASON_PREFIX = 'instructions-held:';
/** Prefix of the `level-changed` reason that records a person starting the fixer after that hold. */
export const INSTRUCTIONS_OVERRIDDEN_REASON_PREFIX = 'instructions-overridden:';
/** The level a fixer start held by the instructions falls to: ticket-only. */
export const INSTRUCTIONS_FIXER_HELD_LEVEL: AutonomyLevel = 0;

const MAX_REASON_CHARS = 120;
const MAX_INSTRUCTION_CHARS = 500;
const MAX_FILES = 100;
const MAX_REQUEST_CHARS = 8000;
const MAX_REPORT_CHARS = 2000;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    hold: { type: 'boolean' },
    instruction: { type: 'string', maxLength: MAX_INSTRUCTION_CHARS },
    reason: { type: 'string', maxLength: MAX_REASON_CHARS },
    mention: { type: 'string', maxLength: 64 },
  },
  required: ['hold', 'instruction', 'reason', 'mention'],
  additionalProperties: false,
};

/** A well formed answer; a hold must say what it holds for. Lengths are trimmed afterwards, not refused. */
export function isInstructionsHoldAnswer(v: unknown): v is InstructionsHoldAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['hold'] !== 'boolean' || typeof o['instruction'] !== 'string' || typeof o['reason'] !== 'string' || typeof o['mention'] !== 'string') return false;
  return !o['hold'] || o['reason'].trim() !== '';
}

/**
 * Whether the workspace instructions hold `input.step`. No gate or no instructions: no hold, no call.
 */
export async function checkInstructions(gate: InstructionsGate | undefined, input: InstructionsCheckInput): Promise<InstructionsCheck> {
  if (gate === undefined) return { hold: false };
  const instructions = await gate.instructions();
  if (instructions === undefined) return { hold: false };
  let answer: InstructionsHoldAnswer;
  try {
    answer = (await gate.model.classify(await buildInstructionsHoldRequest(instructions, input))).value;
  } catch {
    return { hold: true, status: INSTRUCTIONS_CHECK_FAILED, instruction: '', failed: true };
  }
  if (!answer.hold) return { hold: false };
  const mention = normalizeHandle(answer.mention);
  return {
    hold: true,
    status: holdSentence(answer.reason),
    instruction: answer.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS),
    ...(mention === undefined ? {} : { mention }),
  };
}

/** The classify request. Exported so a test or a recorded fixture can key on exactly this prompt. */
export async function buildInstructionsHoldRequest(instructions: WorkspaceInstructions, input: InstructionsCheckInput): Promise<ClassifyRequest<InstructionsHoldAnswer>> {
  return {
    task: INSTRUCTIONS_HOLD_TASK,
    system: withInstructions(await loadInstructionsHoldPrompt(), instructions),
    prompt: buildInstructionsHoldPrompt(input),
    schemaName: INSTRUCTIONS_HOLD_SCHEMA_NAME,
    schema: SCHEMA,
    validate: isInstructionsHoldAnswer,
  };
}

/** The `<instructions-check>` request text. */
export function buildInstructionsHoldPrompt(input: InstructionsCheckInput): string {
  const i = input.incident;
  const attrs = [
    attr('key', i.issueKey),
    attr('surface', i.surfaceId),
    attr('component', i.componentId),
    attr('repo', i.repo),
    attr('priority', i.priority),
    attr('level', i.level === undefined ? undefined : String(i.level)),
  ].join('');
  const lines = [`<instructions-check step="${input.step}" now="${input.now.toISOString()}">`, `  <incident${attrs}>`];
  if (i.summary !== undefined) lines.push(`    <summary>${escapeXmlText(i.summary)}</summary>`);
  if (i.reporter !== undefined) lines.push(`    <reporter${attr('name', i.reporter.name)}${attr('role', i.reporter.role)}/>`);
  if (i.report !== undefined) lines.push(`    <report>${escapeXmlText(i.report.slice(0, MAX_REPORT_CHARS))}</report>`);
  lines.push('  </incident>');
  const pr = input.pullRequest;
  if (pr !== undefined) {
    lines.push(`  <pull-request number="${String(pr.number)}" files="${String(pr.files.length)}">`);
    for (const f of pr.files.slice(0, MAX_FILES)) {
      lines.push(`    <file${attr('path', f.path)} additions="${String(f.additions)}" deletions="${String(f.deletions)}"/>`);
    }
    lines.push('  </pull-request>');
  }
  if (input.implementationRequest !== undefined) {
    // Already XML (validated when it was built), so it goes in as is rather than escaped.
    lines.push(requestBody(input.implementationRequest));
  }
  lines.push('</instructions-check>');
  return lines.join('\n');
}

/** "Holding for <reason> per workspace instructions", from the model's noun phrase. */
export function holdSentence(reason: string): string {
  let phrase = reason.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  phrase = phrase.replace(/^holding for\s+/i, '');
  phrase = phrase.replace(/\s*per (?:the )?workspace instructions$/i, '');
  if (phrase === '') return INSTRUCTIONS_CHECK_FAILED;
  if ([...phrase].length > MAX_REASON_CHARS) phrase = [...phrase].slice(0, MAX_REASON_CHARS).join('').trim();
  return `Holding for ${phrase} ${INSTRUCTIONS_HOLD_SUFFIX}`;
}

/** True for a status sentence written by `holdSentence` or the failed check. */
export function isInstructionsHoldSentence(text: string): boolean {
  const t = text.trim().replace(/[.\s]+$/, '');
  return t === INSTRUCTIONS_CHECK_FAILED || (/^Holding for /.test(t) && t.endsWith(` ${INSTRUCTIONS_HOLD_SUFFIX}`));
}

// The fixer hold's `level-changed` reason ----------------------------------------------------------

/** `instructions-held: <sentence>` plus ` (mention @handle)` when the instruction names someone. */
export function fixerHoldReason(check: { status: string; mention?: string }): string {
  return `${INSTRUCTIONS_HELD_REASON_PREFIX} ${check.status}${check.mention === undefined ? '' : ` (mention @${check.mention})`}`;
}

/** The sentence and the mention back from a `fixerHoldReason`, or undefined for any other reason. */
export function parseFixerHoldReason(reason: string): { status: string; mention?: string } | undefined {
  if (!reason.startsWith(INSTRUCTIONS_HELD_REASON_PREFIX)) return undefined;
  const rest = reason.slice(INSTRUCTIONS_HELD_REASON_PREFIX.length).trim();
  const m = / \(mention @([A-Za-z0-9._-]+)\)$/.exec(rest);
  if (m === null) return { status: rest };
  return { status: rest.slice(0, m.index), mention: m[1] ?? '' };
}

// Private ----------------------------------------------------------------------------------------

const PROMPT_URL = new URL('../prompts/instructions-hold.xml', import.meta.url);
let promptCache: Promise<string> | undefined;

function loadInstructionsHoldPrompt(): Promise<string> {
  promptCache ??= readFile(PROMPT_URL, 'utf8').then((xml) => {
    const system = /<system>([\s\S]*?)<\/system>/.exec(xml)?.[1]?.trim();
    if (system === undefined) throw new Error('prompts/instructions-hold.xml needs <system>');
    return system.replace(/\s+/g, ' ');
  });
  return promptCache;
}

/** A handle as a mention token can carry it: no @, no spaces or brackets. Undefined when empty. */
function normalizeHandle(handle: string): string | undefined {
  const h = handle.trim().replace(/^@+/, '');
  return /^[A-Za-z0-9._-]{1,64}$/.test(h) ? h : undefined;
}

function attr(name: string, value: string | undefined): string {
  return value === undefined || value === '' ? '' : ` ${name}="${escapeXmlText(value).replace(/"/g, '&quot;')}"`;
}

/**
 * The request without its XML declaration and its own instructions block (the system prompt has it).
 * A request over the cap is cut and escaped as text, since a cut element is no longer XML.
 */
function requestBody(xml: string): string {
  const body = xml
    .replace(/^\s*<\?xml[^>]*\?>\s*/, '')
    .replace(/\s*<workspace-instructions>[\s\S]*?<\/workspace-instructions>/, '')
    .trim();
  if (body.length <= MAX_REQUEST_CHARS) return body;
  return `<implementation-request truncated="true">${escapeXmlText(body.slice(0, MAX_REQUEST_CHARS))}</implementation-request>`;
}
