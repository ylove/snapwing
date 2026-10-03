// Ask-back gate (main 7): three layers, then the gate. `maybeAsk` returns undefined when there is nothing
// to ask, and otherwise a ClarifyQuestion whose `gatePassed` and `gateFailures` say whether it may be sent.

import type { WorkspaceInstructions } from '../config/instructions.ts';
import type { CanonicalIncidentPayload, ClarifyQuestion, ContextBundle, Resolution } from '../contracts/incident.ts';
import type { WorkspaceMap } from '../map/types.ts';
import type { ModelPort } from '../ports/model.ts';
import { findSurface } from '../resolve/lookup.ts';
import {
  DEFAULT_MAX_QUESTIONS,
  DEFAULT_SUPPRESS_REPORTERS,
  classifyKind,
  evaluateBudget,
  evaluateGate,
  toClarifyQuestion,
} from './gate.ts';
import type { CandidateQuestion, GateContext } from './gate.ts';
import { buildClarifyRequest } from './prompt.ts';
import type { ClarifyGap } from './prompt.ts';

export { evaluateBudget, evaluateGate, classifyKind, hasTechnicalWording, GATE_CODES } from './gate.ts';
export type { CandidateQuestion, GateContext, QuestionAsks, QuestionKind } from './gate.ts';
export { buildClarifyRequest, CLARIFY_SCHEMA_NAME, isCandidateQuestion } from './prompt.ts';
export type { ClarifyGap } from './prompt.ts';

/** What the caller knows from outside the bundle (layer 1). Everything is optional; absent means none. */
export interface ClarifyEvidence {
  /** Questions already asked on this incident. */
  questionsAsked?: number;
  /** Distinct people reporting the same symptom in the last hour, this reporter included. */
  reportersInWindow?: number;
  /** Surfaces with an alert firing in the last hour. Exactly one distinct surface settles the surface gap. */
  activeAlertSurfaces?: readonly string[];
  /** The A 1.4 reaction ladder suppressed the ask-back (signals/score.ts `escalationState`). */
  escalated?: boolean;
}

/** Layer 1: what is still unknown once everything findable has been used. */
export function findGap(resolution: Resolution, map: WorkspaceMap, evidence: ClarifyEvidence = {}): ClarifyGap | undefined {
  if (resolution.surfaceId === undefined) {
    const alerted = new Set(evidence.activeAlertSurfaces ?? []);
    return alerted.size === 1 ? undefined : 'surface';
  }
  if (resolution.componentId !== undefined) return undefined;
  const surface = findSurface(map, resolution.surfaceId);
  return surface !== undefined && surface.components.length >= 2 ? 'component' : undefined;
}

/** Layer 3: the options the product offers for this gap. */
export function optionsFor(gap: ClarifyGap, resolution: Resolution, map: WorkspaceMap): string[] {
  if (gap === 'surface') return map.surfaces.map((s) => s.label);
  const surface = resolution.surfaceId === undefined ? undefined : findSurface(map, resolution.surfaceId);
  return surface?.components.map((c) => c.label) ?? [];
}

function bundleKnows(bundle: ContextBundle): { environment: boolean; screenshot: boolean } {
  const attachments = bundle.included.flatMap((m) => m.attachments).filter((a) => a.kind === 'image');
  return {
    environment: attachments.some((a) => a.reading?.environmentHint !== undefined && a.reading.environmentHint !== 'unknown'),
    screenshot: attachments.length > 0,
  };
}

/**
 * Runs layers 1 to 3 and the gate. Returns undefined when nothing is missing. When the budget or the
 * volume check fails up front, the model is not called and the question has empty text.
 */
export async function maybeAsk(
  payload: CanonicalIncidentPayload,
  bundle: ContextBundle,
  resolution: Resolution,
  map: WorkspaceMap,
  model: ModelPort,
  evidence: ClarifyEvidence = {},
  instructions?: WorkspaceInstructions,
): Promise<ClarifyQuestion | undefined> {
  // Layer 1: exhaust what can be found.
  const gap = findGap(resolution, map, evidence);
  if (gap === undefined) return undefined;

  const policy = map.policies.askBack;
  const seen = bundleKnows(bundle);
  const options = optionsFor(gap, resolution, map);
  const ctx: GateContext = {
    maxQuestionsPerIncident: policy?.maxQuestionsPerIncident ?? DEFAULT_MAX_QUESTIONS,
    suppressWhenReportersAtLeast: policy?.suppressWhenReportersAtLeast ?? DEFAULT_SUPPRESS_REPORTERS,
    questionsAsked: evidence.questionsAsked ?? 0,
    reportersInWindow: evidence.reportersInWindow ?? 1,
    ...(evidence.escalated === undefined ? {} : { escalated: evidence.escalated }),
    known: {
      surface: resolution.surfaceId !== undefined,
      component: resolution.componentId !== undefined,
      // A reporter-role person is on production (main 7.1); a screenshot may also say.
      environment: payload.reporter.role === 'reporter' || seen.environment,
      screenshot: seen.screenshot,
    },
    mapOptions: options,
  };

  const early = evaluateBudget(ctx);
  if (early.length > 0) return { audience: 'reporter', text: '', gatePassed: false, gateFailures: early };

  const result = await model.classify(await buildClarifyRequest(payload, bundle, { gap, options, ...(instructions === undefined ? {} : { instructions }) }));
  const drafted = result.value;
  // Layer 2: route by role. A technical question goes to an engineer, never to the reporter.
  const kind = classifyKind(drafted);
  const candidate: CandidateQuestion = {
    ...drafted,
    kind,
    audience: kind === 'technical' ? 'engineer' : drafted.audience,
  };
  return toClarifyQuestion(candidate, evaluateGate(candidate, ctx));
}
