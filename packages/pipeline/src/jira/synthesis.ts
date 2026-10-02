// Ticket synthesis (main 9.1, 9.2; Companion B 7.2 field map). Pure data in, Jira create payload out.
// Nothing here calls Jira: the payload goes to the outbox (phase 3), which maps custom field names to site ids.

import type { CanonicalIncidentPayload, ContextBundle, Resolution, TriageResolutionPlan } from '../contracts/incident.ts';
import type { MapSurface } from '../map/types.ts';
import { buildImplementationRequest, IMPLEMENTATION_REQUEST_XSD } from '../prompts/implementation-request.ts';
import type { Evidence, ImplementationRequestInput } from '../prompts/implementation-request.ts';
import { validate } from '../schemas/validate.ts';
import { doc, labeled, labeledLink, paragraph, text } from './adf.ts';
import type { AdfDoc, AdfParagraph } from './adf.ts';

export type AutonomyLevel = TriageResolutionPlan['autonomyLevel'];

/** The Jira custom field names (B 7.2). The outbox maps them to site-specific `customfield_NNNNN` ids. */
export const CUSTOM_FIELD_IMPLEMENTATION_PROMPT = 'Implementation Prompt';
export const CUSTOM_FIELD_CONVERSATION_LINK = 'Conversation Link';
export const CUSTOM_FIELD_AUTONOMY_LEVEL = 'Autonomy Level';

export const LABEL_SNAPWING = 'snapwing';
export const LABEL_NEEDS_CLARIFICATION = 'needs-clarification';
export const LABEL_PROMPT_FAILED = 'prompt-failed';

/**
 * The implementation request names its Jira issue, but the key does not exist until Jira creates the
 * ticket. Synthesis writes `<PROJECT>-0` (it satisfies the XSD) and the projector rewrites `@issue` when
 * it writes the real key back; pass `issueKey` when it is already known (a re-synthesis on `scope-changed`).
 */
export const PLACEHOLDER_ISSUE_NUMBER = 0;

export interface SynthesisContext {
  payload: CanonicalIncidentPayload;
  resolution: Resolution;
  /** The resolved map surface, for its label (environment) and the component label. */
  surface?: MapSurface;
  /** True when the ask-back gate left a question open: adds `needs-clarification`. */
  needsClarification?: boolean;
  /** Reproduction steps, when known. The section is omitted otherwise. */
  repro?: string;
  /** The real Jira key, if the ticket already exists. */
  issueKey?: string;
  /** Base branch for the fixer's PR. */
  base?: string;
}

export interface JiraCreateFields {
  project: { key: string };
  issuetype: { name: TriageResolutionPlan['issueType'] };
  summary: string;
  description: AdfDoc;
  priority: { name: TriageResolutionPlan['priority'] };
  labels: string[];
  components?: { name: string }[];
}

export interface SynthesizedIssue {
  fields: JiraCreateFields;
  /** Keyed by field name. `Implementation Prompt` is `''` when the request failed validation. */
  customFields: {
    'Implementation Prompt': string;
    'Conversation Link'?: string;
    'Autonomy Level': AutonomyLevel;
  };
  suggestedAssigneeEmail?: string;
  /** Why the implementation request was dropped; empty when the prompt is present. */
  promptErrors: string[];
}

/** Jira labels cannot contain spaces. */
function label(value: string): string {
  return value.trim().replace(/\s+/g, '-');
}

export function synthesizeLabels(plan: TriageResolutionPlan, ctx: SynthesisContext, promptFailed: boolean): string[] {
  const labels = [
    LABEL_SNAPWING,
    ctx.payload.source,
    ...(ctx.resolution.surfaceId === undefined ? [] : [ctx.resolution.surfaceId]),
    ...(ctx.needsClarification === true ? [LABEL_NEEDS_CLARIFICATION] : []),
    ...plan.labels,
    ...(promptFailed ? [LABEL_PROMPT_FAILED] : []),
  ].map(label);
  return [...new Set(labels.filter((l) => l !== ''))];
}

function images(bundle: ContextBundle) {
  return bundle.included.flatMap((m) => m.attachments).filter((a) => a.kind === 'image' && a.reading?.sensitive !== true);
}

function environmentText(bundle: ContextBundle, ctx: SynthesisContext): string {
  const readings = images(bundle).flatMap((a) => (a.reading === undefined ? [] : [a.reading]));
  const hint = readings.map((r) => r.environmentHint).find((h) => h !== undefined && h !== 'unknown');
  const urlBar = readings.map((r) => r.surfaceSignals.urlBar).find((u) => u !== undefined);
  const parts = [
    ctx.surface?.label ?? ctx.resolution.surfaceId,
    hint,
    urlBar,
    `reported via ${ctx.payload.source}`,
  ].filter((p): p is string => p !== undefined && p !== '');
  return parts.join(', ');
}

export function buildDescription(plan: TriageResolutionPlan, bundle: ContextBundle, ctx: SynthesisContext): AdfDoc {
  const { payload } = ctx;
  const blocks: AdfParagraph[] = [
    labeled('Reporter', payload.reporter.email === undefined ? payload.reporter.name : `${payload.reporter.name} (${payload.reporter.email})`),
    labeled('Symptom', payload.anchorText),
    labeled('Environment', environmentText(bundle, ctx)),
    ...(ctx.repro === undefined || ctx.repro.trim() === '' ? [] : [labeled('Repro', ctx.repro.trim())]),
    ...(payload.context.deepLink === undefined ? [] : [labeledLink('Conversation', payload.context.deepLink)]),
  ];
  // The triage model's own write-up follows the structured block, when it adds anything.
  const details = plan.descriptionAdf;
  const detailParagraphs = Array.isArray(details['content']) ? (details['content'] as unknown[]) : [];
  for (const p of detailParagraphs) {
    const nodes = typeof p === 'object' && p !== null ? (p as { content?: unknown }).content : undefined;
    const first = Array.isArray(nodes) ? (nodes[0] as { text?: unknown } | undefined) : undefined;
    if (typeof first?.text === 'string' && first.text.trim() !== '') blocks.push(paragraph(text(first.text)));
  }
  return doc(...blocks);
}

function evidenceFor(bundle: ContextBundle, ctx: SynthesisContext, key: string): Evidence[] {
  const { payload } = ctx;
  const shots: Evidence[] = images(bundle).map((a) => ({
    kind: 'screenshot',
    ref: `attachment:${key}/${a.url.split('/').pop()?.split('?')[0] ?? 'screenshot'}`,
  }));
  return [
    {
      kind: 'report',
      source: payload.source,
      channel: payload.context.channelId,
      reporter: payload.reporter.email ?? payload.reporter.name,
      ts: payload.timestamp,
      text: payload.anchorText,
    },
    ...shots,
    payload.source === 'alert_webhook' ? { kind: 'alert', source: payload.source, text: payload.anchorText } : { kind: 'alert', none: true },
  ];
}

export function buildRequestInput(
  plan: TriageResolutionPlan,
  bundle: ContextBundle,
  level: AutonomyLevel,
  ctx: SynthesisContext,
): ImplementationRequestInput {
  const key = ctx.issueKey ?? `${plan.projectKey}-${PLACEHOLDER_ISSUE_NUMBER}`;
  const componentId = plan.componentId ?? ctx.resolution.componentId;
  return {
    issue: key,
    ...(ctx.resolution.surfaceId === undefined ? {} : { surface: ctx.resolution.surfaceId }),
    ...(componentId === undefined ? {} : { component: componentId }),
    intent: plan.summary,
    evidence: evidenceFor(bundle, ctx, key),
    ...(plan.diagnosis === undefined ? {} : { diagnosis: { ...plan.diagnosis, by: 'scout' } }),
    constraints: {
      scope: 'Only the files needed to fix this report, plus its tests',
      tests: { required: true, text: 'Add a regression test that fails before the fix and passes after it' },
      forbidden: ['Do not change behavior unrelated to this report'],
    },
    handoff: { mode: level === 3 ? 'auto' : 'review', autonomy: level, ...(ctx.base === undefined ? {} : { base: ctx.base }) },
  };
}

/**
 * Builds the Jira create payload (main 9.1). The implementation request is built with
 * `buildImplementationRequest` and validated against the XSD (main 9.2); when it does not validate
 * the field is left empty and the ticket gets `prompt-failed`, so a human can look at it.
 * `level` is the autonomy level resolved by policy; it sets `handoff/@mode` (auto only at level 3)
 * and `handoff/@autonomy`, and is written to the `Autonomy Level` field.
 */
export async function synthesizeIssue(
  plan: TriageResolutionPlan,
  bundle: ContextBundle,
  level: AutonomyLevel,
  ctx: SynthesisContext,
): Promise<SynthesizedIssue> {
  let prompt = '';
  let promptErrors: string[] = [];
  try {
    const xml = buildImplementationRequest(buildRequestInput(plan, bundle, level, ctx));
    const result = await validate(xml, { xsd: IMPLEMENTATION_REQUEST_XSD });
    if (result.valid) prompt = xml;
    else promptErrors = result.errors.map((e) => e.message);
  } catch (err) {
    promptErrors = [err instanceof Error ? err.message : String(err)];
  }

  const componentId = plan.componentId ?? ctx.resolution.componentId;
  const componentName = ctx.surface?.components.find((c) => c.id === componentId)?.label ?? componentId;
  const deepLink = ctx.payload.context.deepLink;
  return {
    fields: {
      project: { key: plan.projectKey },
      issuetype: { name: plan.issueType },
      summary: plan.summary,
      description: buildDescription(plan, bundle, ctx),
      priority: { name: plan.priority },
      labels: synthesizeLabels(plan, ctx, promptErrors.length > 0),
      ...(componentName === undefined ? {} : { components: [{ name: componentName }] }),
    },
    customFields: {
      'Implementation Prompt': prompt,
      ...(deepLink === undefined ? {} : { 'Conversation Link': deepLink }),
      'Autonomy Level': level,
    },
    ...(plan.suggestedAssigneeEmail === undefined ? {} : { suggestedAssigneeEmail: plan.suggestedAssigneeEmail }),
    promptErrors,
  };
}
