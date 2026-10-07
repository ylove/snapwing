// Triage plan (main 8.1, main 13 TriageResolutionPlan). One classify call produces the ticket fields;
// the scout fills `diagnosis`; policy fills `autonomyLevel`. The model is never asked for either.

import type {
  CanonicalIncidentPayload,
  ContextBundle,
  DedupeResult,
  Resolution,
  TriageResolutionPlan,
} from '../contracts/incident.ts';
import type { MapSurface, WorkspaceMap } from '../map/types.ts';
import type { ClassifyRequest, JsonSchema, ModelPort } from '../ports/model.ts';
import { resolveAutonomy } from '../policy/autonomy.ts';
import type { WorkspaceInstructions } from '../config/instructions.ts';
import { loadTriagePrompts, triageSystemPrompt, xmlEscape } from './prompt.ts';
import { scout } from './scout.ts';
import type { Diagnosis, RepoReader } from './scout.ts';

export const TRIAGE_SCHEMA_NAME = 'triage-plan';
export const SUMMARY_MAX_CHARS = 120;

const ACTIONS = ['create_issue', 'link_existing', 'noop'] as const;
const ISSUE_TYPES = ['Incident', 'Bug', 'Task'] as const;
const PRIORITIES = ['Lowest', 'Low', 'Medium', 'High', 'Highest'] as const;

/** What the model writes. Everything else on the plan comes from the resolution, the scout, or policy. */
export interface TriageDraft {
  action: TriageResolutionPlan['action'];
  linkTo?: string;
  issueType: TriageResolutionPlan['issueType'];
  summary: string;
  description: string;
  priority: TriageResolutionPlan['priority'];
  labels: string[];
  componentId?: string;
  suggestedAssigneeEmail?: string;
}

export class TriageError extends Error {
  override readonly name = 'TriageError';
}

function findSurface(map: WorkspaceMap, resolution: Resolution): MapSurface | undefined {
  return map.surfaces.find((s) => s.id === resolution.surfaceId);
}

/** Type guard for the model's draft, closed over what this incident allows. */
export function isTriageDraft(candidateKeys: ReadonlySet<string>, componentIds: ReadonlySet<string>): (v: unknown) => v is TriageDraft {
  return (v: unknown): v is TriageDraft => {
    if (typeof v !== 'object' || v === null) return false;
    const o = v as Record<string, unknown>;
    const action = o['action'];
    const linkTo = o['linkTo'];
    const summary = o['summary'];
    return (
      ACTIONS.some((a) => a === action) &&
      (action === 'link_existing' ? typeof linkTo === 'string' && candidateKeys.has(linkTo) : linkTo === undefined) &&
      ISSUE_TYPES.some((t) => t === o['issueType']) &&
      typeof summary === 'string' &&
      summary.trim() !== '' &&
      summary.length <= SUMMARY_MAX_CHARS &&
      typeof o['description'] === 'string' &&
      PRIORITIES.some((p) => p === o['priority']) &&
      Array.isArray(o['labels']) &&
      o['labels'].every((l: unknown) => typeof l === 'string') &&
      (o['componentId'] === undefined || (typeof o['componentId'] === 'string' && componentIds.has(o['componentId']))) &&
      (o['suggestedAssigneeEmail'] === undefined || typeof o['suggestedAssigneeEmail'] === 'string')
    );
  };
}

function draftSchema(candidateKeys: string[], componentIds: string[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      ...(candidateKeys.length === 0 ? {} : { linkTo: { type: 'string', enum: candidateKeys } }),
      issueType: { type: 'string', enum: [...ISSUE_TYPES] },
      summary: { type: 'string', maxLength: SUMMARY_MAX_CHARS },
      description: { type: 'string' },
      priority: { type: 'string', enum: [...PRIORITIES] },
      labels: { type: 'array', items: { type: 'string' } },
      ...(componentIds.length === 0 ? {} : { componentId: { type: 'string', enum: componentIds } }),
      suggestedAssigneeEmail: { type: 'string' },
    },
    required: ['action', 'issueType', 'summary', 'description', 'priority', 'labels'],
    additionalProperties: false,
  };
}

function mapSummaryXml(map: WorkspaceMap, surface: MapSurface | undefined): string {
  const surfaces = (surface === undefined ? map.surfaces : [surface]).map((s) => {
    const components = s.components.map((c) => `      <component id="${xmlEscape(c.id)}" label="${xmlEscape(c.label)}"/>`).join('\n');
    return `    <surface id="${xmlEscape(s.id)}" label="${xmlEscape(s.label)}" jira-project="${xmlEscape(s.jira.project)}" default-issue-type="${xmlEscape(s.jira.defaultIssueType)}">\n${components}\n    </surface>`;
  });
  return `  <workspace-map>\n${surfaces.join('\n')}\n  </workspace-map>`;
}

/** The triage prompt. Exported so tests can record a fixture for exactly this text. */
export function buildTriagePrompt(
  payload: CanonicalIncidentPayload,
  bundle: ContextBundle,
  resolution: Resolution,
  dedupe: DedupeResult,
  map: WorkspaceMap,
  diagnosis?: Diagnosis,
): string {
  const messages = bundle.included
    .filter((m) => m.id !== bundle.anchorId)
    .map((m) => `    <message id="${xmlEscape(m.id)}">${xmlEscape(m.text)}</message>`);
  const readings = bundle.included.flatMap((m) =>
    m.attachments.flatMap((a) =>
      a.reading === undefined
        ? []
        : [`    <image-reading error-text="${xmlEscape(a.reading.errorText ?? '')}">${xmlEscape(a.reading.plainDescription)}</image-reading>`],
    ),
  );
  const candidates = dedupe.candidates.map(
    (c) => `    <candidate key="${xmlEscape(c.issueKey)}" score="${c.score}">${xmlEscape(c.summary)}</candidate>`,
  );
  const diagnosisXml =
    diagnosis === undefined
      ? '  <diagnosis none="true"/>'
      : `  <diagnosis confidence="${diagnosis.confidence}">\n${diagnosis.files.map((f) => `    <file path="${xmlEscape(f.path)}">${xmlEscape(f.note)}</file>`).join('\n')}\n  </diagnosis>`;
  return [
    '<triage-request>',
    `  <reporter name="${xmlEscape(payload.reporter.name)}" role="${payload.reporter.role}" source="${payload.source}"/>`,
    `  <report>${xmlEscape(payload.anchorText)}</report>`,
    `  <context>\n${messages.join('\n')}\n  </context>`,
    `  <images>\n${readings.join('\n')}\n  </images>`,
    `  <resolved surface="${xmlEscape(resolution.surfaceId ?? '')}" component="${xmlEscape(resolution.componentId ?? '')}" owner="${xmlEscape(resolution.ownerId ?? '')}" jira-project="${xmlEscape(resolution.jiraProject ?? '')}"/>`,
    `  <duplicate-check decision="${dedupe.decision}">\n${candidates.join('\n')}\n  </duplicate-check>`,
    diagnosisXml,
    mapSummaryXml(map, findSurface(map, resolution)),
    '</triage-request>',
  ].join('\n');
}

export async function buildTriageRequest(
  payload: CanonicalIncidentPayload,
  bundle: ContextBundle,
  resolution: Resolution,
  dedupe: DedupeResult,
  map: WorkspaceMap,
  diagnosis?: Diagnosis,
  instructions?: WorkspaceInstructions,
): Promise<ClassifyRequest<TriageDraft>> {
  const prompts = await loadTriagePrompts();
  const candidateKeys = dedupe.candidates.map((c) => c.issueKey);
  const surface = findSurface(map, resolution);
  const componentIds = (surface === undefined ? map.surfaces.flatMap((s) => s.components) : surface.components).map((c) => c.id);
  return {
    task: 'triage',
    system: triageSystemPrompt(prompts, instructions),
    prompt: buildTriagePrompt(payload, bundle, resolution, dedupe, map, diagnosis),
    schemaName: TRIAGE_SCHEMA_NAME,
    schema: draftSchema(candidateKeys, componentIds),
    validate: isTriageDraft(new Set(candidateKeys), new Set(componentIds)),
    temperature: 0,
  };
}

/** Plain text to an Atlassian Document Format doc: one paragraph per blank-line-separated block. */
export function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '');
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  };
}

/**
 * Builds the plan for one incident. With a `repo`, the read-only scout runs first and its diagnosis
 * goes into the triage prompt and onto `plan.diagnosis`. `autonomyLevel` is `resolveAutonomy` under the
 * payload's `levelCap`, not model output.
 * `instructions` (INSTRUCTIONS.md, A 6.3) goes into the triage system prompt; the scout does not get it.
 */
export async function plan(
  payload: CanonicalIncidentPayload,
  bundle: ContextBundle,
  resolution: Resolution,
  dedupe: DedupeResult,
  map: WorkspaceMap,
  model: ModelPort,
  repo?: RepoReader,
  instructions?: WorkspaceInstructions,
): Promise<TriageResolutionPlan> {
  const surface = findSurface(map, resolution);
  const projectKey = resolution.jiraProject ?? surface?.jira.project;
  if (projectKey === undefined) throw new TriageError('cannot plan: the resolution names no Jira project');

  const diagnosis =
    repo === undefined ? undefined : await scout(repo, model, { payload, bundle, resolution, ...(surface === undefined ? {} : { surface }) });

  const { value: draft } = await model.classify(await buildTriageRequest(payload, bundle, resolution, dedupe, map, diagnosis, instructions));

  const componentId = draft.componentId ?? resolution.componentId;
  const autonomyLevel = resolveAutonomy(resolution, { priority: draft.priority, ...(componentId === undefined ? {} : { componentId }) }, map, payload.levelCap);

  return {
    action: draft.action,
    ...(draft.linkTo === undefined ? {} : { linkTo: draft.linkTo }),
    projectKey,
    issueType: draft.issueType,
    summary: draft.summary,
    descriptionAdf: toAdf(draft.description),
    priority: draft.priority,
    labels: [...new Set(draft.labels)],
    ...(componentId === undefined ? {} : { componentId }),
    ...(draft.suggestedAssigneeEmail === undefined ? {} : { suggestedAssigneeEmail: draft.suggestedAssigneeEmail }),
    ...(diagnosis === undefined ? {} : { diagnosis }),
    autonomyLevel,
  };
}
