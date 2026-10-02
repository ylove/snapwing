// The ask-back gate (main 7.2), enforced in code. Every failed check is listed in `gateFailures`, so a
// failing question tells the caller (and the ticket label `needs-clarification`) exactly why.

import type { ClarifyQuestion } from '../contracts/incident.ts';

export const DEFAULT_MAX_QUESTIONS = 1;
export const DEFAULT_SUPPRESS_REPORTERS = 3;

export type QuestionKind = 'experiential' | 'technical';
export type QuestionAsks = 'surface' | 'component' | 'environment' | 'symptom' | 'other';

/** A question as drafted by the model, before the gate. */
export interface CandidateQuestion {
  audience: 'reporter' | 'engineer';
  kind: QuestionKind;
  asks: QuestionAsks;
  text: string;
  options: string[];
  screenshotRequest: boolean;
}

/** What the gate needs to know about the incident; layer 1 and the caller fill it. */
export interface GateContext {
  maxQuestionsPerIncident: number;
  suppressWhenReportersAtLeast: number;
  questionsAsked: number;
  reportersInWindow: number;
  /** Which things are already known from the bundle or the map. */
  known: { surface: boolean; component: boolean; environment: boolean; screenshot: boolean };
  /** For surface and component questions: the labels the map offers; options must come from them. */
  mapOptions: readonly string[];
}

export const GATE_CODES = {
  empty: 'empty-text',
  technicalWording: 'technical-wording',
  technicalToReporter: 'technical-question-to-reporter',
  optionCount: 'options-not-2-to-4-or-screenshot',
  optionsNotFromMap: 'options-not-from-map',
  alreadyKnown: 'already-answerable',
  budget: 'budget-exceeded',
  suppressed: 'suppressed-by-volume',
} as const;

/** Words a non-technical person would not use for something on their own screen. */
const TECHNICAL_WORDS =
  /\b(production|prod|staging|environment|env|stack ?trace|api|endpoint|http|https|status code|logs?|console|database|db|server|deploy(?:ed|ment|s)?|version|build|branch|commit|cache|cookies?|tokens?|sql|json|latency|timeout|regex|dns|ssl|cdn|backend|frontend|repo|repository|payload|header|headers|ip address)\b/i;

const SCREENSHOT_WORDS = /\b(screenshot|screen ?shot|picture of|photo of)\b/i;

export function hasTechnicalWording(text: string): boolean {
  return TECHNICAL_WORDS.test(text);
}

/** Layer 2: the role a question is addressed to is decided by its content, not only by the model's label. */
export function classifyKind(candidate: Pick<CandidateQuestion, 'kind' | 'text' | 'options'>): QuestionKind {
  if (candidate.kind === 'technical') return 'technical';
  return hasTechnicalWording(candidate.text) || candidate.options.some(hasTechnicalWording) ? 'technical' : 'experiential';
}

function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Runs every check and returns the failures (empty when the question may be asked). Does not stop at the first. */
export function evaluateGate(candidate: CandidateQuestion, ctx: GateContext): string[] {
  const failures: string[] = [];
  const toReporter = candidate.audience === 'reporter';
  const options = candidate.options;

  if (candidate.text.trim() === '') failures.push(`${GATE_CODES.empty}: the question has no text`);

  if (toReporter) {
    if (classifyKind(candidate) === 'technical') {
      failures.push(`${GATE_CODES.technicalToReporter}: a reporter cannot answer a technical question from their screen`);
    }
    if (hasTechnicalWording(candidate.text)) {
      failures.push(`${GATE_CODES.technicalWording}: the wording uses a technical term`);
    }
    const optionCountOk = options.length >= 2 && options.length <= 4;
    const screenshotOk = candidate.screenshotRequest && options.length === 0 && SCREENSHOT_WORDS.test(candidate.text);
    if (!optionCountOk && !screenshotOk) {
      failures.push(`${GATE_CODES.optionCount}: ${options.length} options and no screenshot request`);
    }
    if ((candidate.asks === 'surface' || candidate.asks === 'component') && options.length > 0) {
      const stray = options.filter((o) => !ctx.mapOptions.some((m) => sameLabel(m, o)));
      if (stray.length > 0) failures.push(`${GATE_CODES.optionsNotFromMap}: ${stray.join(', ')}`);
    }
  }

  const known =
    (candidate.asks === 'surface' && ctx.known.surface) ||
    (candidate.asks === 'component' && ctx.known.component) ||
    (candidate.asks === 'environment' && ctx.known.environment) ||
    (candidate.screenshotRequest && ctx.known.screenshot);
  if (known) failures.push(`${GATE_CODES.alreadyKnown}: the bundle or the map already answers a question about ${candidate.asks}`);

  failures.push(...evaluateBudget(ctx));
  return failures;
}

/** The two checks that depend only on counts; layer 1 runs them before any model call. */
export function evaluateBudget(ctx: Pick<GateContext, 'maxQuestionsPerIncident' | 'suppressWhenReportersAtLeast' | 'questionsAsked' | 'reportersInWindow'>): string[] {
  const failures: string[] = [];
  if (ctx.questionsAsked >= ctx.maxQuestionsPerIncident) {
    failures.push(`${GATE_CODES.budget}: ${ctx.questionsAsked} asked, at most ${ctx.maxQuestionsPerIncident} allowed`);
  }
  if (ctx.reportersInWindow >= ctx.suppressWhenReportersAtLeast) {
    failures.push(
      `${GATE_CODES.suppressed}: ${ctx.reportersInWindow} reporters, suppressed at ${ctx.suppressWhenReportersAtLeast}; this is an incident, not a question`,
    );
  }
  return failures;
}

/** The contract shape for a candidate plus its gate result. */
export function toClarifyQuestion(candidate: CandidateQuestion, failures: string[]): ClarifyQuestion {
  return {
    audience: candidate.audience,
    text: candidate.text,
    ...(candidate.options.length > 0 ? { options: candidate.options } : {}),
    gatePassed: failures.length === 0,
    gateFailures: failures,
  };
}
