// Read-only scout (main 8.1): search the resolved repo for the component, pick likely files, propose a
// diagnosis. The scout reaches the repo only through RepoReader, which has no write methods by type.

import type { CanonicalIncidentPayload, ContextBundle, Resolution, TriageResolutionPlan } from '../contracts/incident.ts';
import type { MapSurface } from '../map/types.ts';
import type { ClassifyRequest, JsonSchema, ModelPort } from '../ports/model.ts';
import { loadTriagePrompts, xmlEscape } from './prompt.ts';

export interface RepoSearchHit {
  path: string;
  /** One matching line or a short excerpt; optional. */
  snippet?: string;
}

/** Read-only view of a repository checkout or API. There is deliberately nothing here that writes. */
export interface RepoReader {
  search(query: string): Promise<RepoSearchHit[]>;
  read(path: string): Promise<string>;
}

export type Diagnosis = NonNullable<TriageResolutionPlan['diagnosis']>;

export const SCOUT_SCHEMA_NAME = 'scout-diagnosis';
export const SCOUT_MAX_QUERIES = 4;
export const SCOUT_MAX_HITS = 12;
export const SCOUT_MAX_FILES = 3;
export const SCOUT_MAX_FILE_CHARS = 4000;
export const SCOUT_MAX_NOTE_CHARS = 300;

export interface ScoutFile {
  path: string;
  content: string;
}

export interface ScoutEvidence {
  queries: string[];
  hits: RepoSearchHit[];
  files: ScoutFile[];
}

export interface ScoutInput {
  payload: CanonicalIncidentPayload;
  bundle: ContextBundle;
  resolution: Resolution;
  surface?: Pick<MapSurface, 'label' | 'components'>;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'it', 'this', 'that', 'and', 'or', 'not', 'on', 'in', 'to', 'of', 'for', 'when', 'after', 'with']);

/** Deterministic search terms: component id and label, then verbatim error text from screenshots. */
export function scoutQueries(input: ScoutInput): string[] {
  const queries: string[] = [];
  const { componentId } = input.resolution;
  if (componentId !== undefined) {
    queries.push(componentId);
    const label = input.surface?.components.find((c) => c.id === componentId)?.label;
    if (label !== undefined && label.toLowerCase() !== componentId.toLowerCase()) queries.push(label);
  }
  for (const m of input.bundle.included) {
    for (const a of m.attachments) {
      const text = a.reading?.errorText?.trim();
      if (text !== undefined && text !== '' && text.toLowerCase() !== 'unknown') queries.push(text.slice(0, 80));
    }
  }
  if (queries.length === 0) {
    const words = input.payload.anchorText.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
    queries.push(...words.filter((w) => !STOP_WORDS.has(w)).slice(0, 2));
  }
  return [...new Set(queries)].slice(0, SCOUT_MAX_QUERIES);
}

/** Runs the searches and reads the top files. Read-only by construction; failures of one call are skipped. */
export async function gatherScoutEvidence(reader: RepoReader, input: ScoutInput): Promise<ScoutEvidence> {
  const queries = scoutQueries(input);
  const seen = new Set<string>();
  const hits: RepoSearchHit[] = [];
  for (const q of queries) {
    let found: RepoSearchHit[];
    try {
      found = await reader.search(q);
    } catch {
      continue;
    }
    for (const h of found) {
      if (seen.has(h.path) || hits.length >= SCOUT_MAX_HITS) continue;
      seen.add(h.path);
      hits.push(h);
    }
  }
  const files: ScoutFile[] = [];
  for (const h of hits) {
    if (files.length >= SCOUT_MAX_FILES) break;
    try {
      files.push({ path: h.path, content: (await reader.read(h.path)).slice(0, SCOUT_MAX_FILE_CHARS) });
    } catch {
      continue;
    }
  }
  return { queries, hits, files };
}

export function isDiagnosis(v: unknown): v is Diagnosis {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const files = o['files'];
  return (
    (o['confidence'] === 'low' || o['confidence'] === 'medium' || o['confidence'] === 'high') &&
    Array.isArray(files) &&
    files.every((f: unknown) => {
      if (typeof f !== 'object' || f === null) return false;
      const e = f as Record<string, unknown>;
      return typeof e['path'] === 'string' && typeof e['note'] === 'string';
    })
  );
}

/** A diagnosis that only names paths the scout actually saw. */
export function isGroundedDiagnosis(known: ReadonlySet<string>): (v: unknown) => v is Diagnosis {
  return (v: unknown): v is Diagnosis => isDiagnosis(v) && v.files.every((f) => known.has(f.path));
}

const DIAGNOSIS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    files: {
      type: 'array',
      maxItems: SCOUT_MAX_FILES,
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, note: { type: 'string', maxLength: SCOUT_MAX_NOTE_CHARS } },
        required: ['path', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['confidence', 'files'],
  additionalProperties: false,
};

export function knownPaths(evidence: ScoutEvidence): Set<string> {
  return new Set([...evidence.hits.map((h) => h.path), ...evidence.files.map((f) => f.path)]);
}

/** The scout prompt. Exported so tests can record a fixture for exactly this text. */
export function buildScoutPrompt(input: ScoutInput, evidence: ScoutEvidence): string {
  const hits = evidence.hits.map(
    (h) => `    <hit path="${xmlEscape(h.path)}">${xmlEscape(h.snippet ?? '')}</hit>`,
  );
  const files = evidence.files.map((f) => `    <file path="${xmlEscape(f.path)}">${xmlEscape(f.content)}</file>`);
  return [
    '<scout-request>',
    `  <report>${xmlEscape(input.payload.anchorText)}</report>`,
    `  <resolved surface="${xmlEscape(input.resolution.surfaceId ?? '')}" component="${xmlEscape(input.resolution.componentId ?? '')}" repo="${xmlEscape(input.resolution.repo ?? '')}"/>`,
    `  <search-hits>\n${hits.join('\n')}\n  </search-hits>`,
    `  <files>\n${files.join('\n')}\n  </files>`,
    '</scout-request>',
  ].join('\n');
}

export async function buildScoutRequest(input: ScoutInput, evidence: ScoutEvidence): Promise<ClassifyRequest<Diagnosis>> {
  const prompts = await loadTriagePrompts();
  return {
    task: 'scout',
    system: prompts.scoutSystem,
    prompt: buildScoutPrompt(input, evidence),
    schemaName: SCOUT_SCHEMA_NAME,
    schema: DIAGNOSIS_SCHEMA,
    validate: isGroundedDiagnosis(knownPaths(evidence)),
    temperature: 0,
  };
}

/**
 * Runs the scout. Returns undefined when the repo yields nothing to look at, so the plan carries no
 * diagnosis rather than an invented one.
 */
export async function scout(reader: RepoReader, model: ModelPort, input: ScoutInput): Promise<Diagnosis | undefined> {
  const evidence = await gatherScoutEvidence(reader, input);
  if (evidence.hits.length === 0 && evidence.files.length === 0) return undefined;
  const request = await buildScoutRequest(input, evidence);
  const { value } = await model.classify(request);
  return value;
}
