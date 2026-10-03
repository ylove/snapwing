// The user-side check (A 5.2). When a screenshot's reading carries a user-side indicator at or above the
// playbook's confidence floor, the agent asks one favor before filing instead of a gap question:
//
//   Before I file this, one thing in your screenshot: URL bar shows staging.example.com. That looks
//   like the test site. Could you try the same thing on the live site?
//   [That fixed it] [Still broken] [I meant staging]
//
// It never tells the reporter they made a mistake. The check is an ask-back question (main 7.2): it is
// recorded as `clarified`, so it counts against `askBack/@maxQuestionsPerIncident`, and it goes through
// the same gate (2 to 4 buttons, budget, volume suppression, no technical wording). What the reporter
// sees on their own screen is answerable by definition, so the gate reads the card with the quoted
// evidence (and an environment name taken from it) masked; the rest of the wording must still pass.
//
// Everything here is pure: the engine (engine/steps.ts) records the round and applies the answer.

import type { Playbook } from '../config/playbook.ts';
import type { UserSideCheckRecord } from '../contracts/events.ts';
import type { ClarifyQuestion, ContextBundle, ImageReading, UserSideIndicator, UserSideKind } from '../contracts/incident.ts';
import { evaluateGate, type GateContext } from './gate.ts';

export const ANSWER_FIXED = 'That fixed it';
export const ANSWER_STILL_BROKEN = 'Still broken';
/** The third button's prefix: `I meant staging`. */
export const ANSWER_MEANT_PREFIX = 'I meant ';

/** The longest evidence the card quotes; longer model text is cut at a word. */
const MAX_EVIDENCE = 160;

/** Environment names a URL bar or header can show that are not the live site. */
const ENVIRONMENT_WORDS = /\b(staging|stage|localhost|local|dev|development|test|testing|qa|uat|sandbox|preview)\b/i;

/** What each indicator kind asks the reporter to try, as a favor and as the ticket records it. */
const FAVORS: Readonly<Record<UserSideKind, { ask: string; tried: string }>> = {
  'wrong-environment': {
    ask: 'That looks like the test site. Could you try the same thing on the live site?',
    tried: 'try the same thing on the live site',
  },
  'wrong-account': {
    ask: 'Could you check that you are signed in with the account you meant, then try again?',
    tried: 'check they were signed in with the account they meant and try again',
  },
  'stale-cache': {
    ask: 'Could you reload the page with Ctrl+Shift+R (Cmd+Shift+R on a Mac) and try again?',
    tried: 'hard reload the page and try again',
  },
  'extension-interference': {
    ask: 'Something from a browser add-on may be covering the page. Could you try again in a private window?',
    tried: 'try again in a private window, without browser add-ons',
  },
  'input-mode': {
    ask: 'Could you check that caps lock is off and try again?',
    tried: 'check caps lock and try again',
  },
  'expired-session': {
    ask: 'Could you sign out, sign back in, and try again?',
    tried: 'sign out, sign back in, and try again',
  },
  network: {
    ask: 'Could you check your Wi-Fi or VPN connection and try again?',
    tried: 'check their connection and try again',
  },
  'wrong-surface': {
    ask: 'Could you check that you are on the page you meant, then try again?',
    tried: 'check they were on the page they meant and try again',
  },
  other: {
    ask: 'Could you try it once more and tell me how it goes?',
    tried: 'try once more',
  },
};

/** The indicator a check is about, with the reading it came from. */
export interface PickedIndicator {
  indicator: UserSideIndicator;
  reading: ImageReading;
}

/**
 * The strongest user-side indicator in the bundle at or above `floor`, from readings that are not
 * sensitive (a sensitive reading's indicators may quote an account or address and are never echoed).
 * Ties keep the first in bundle order. Undefined when there is none.
 */
export function pickIndicator(bundle: ContextBundle, floor: number): PickedIndicator | undefined {
  let best: PickedIndicator | undefined;
  for (const message of bundle.included) {
    for (const attachment of message.attachments) {
      const reading = attachment.kind === 'image' ? attachment.reading : undefined;
      if (reading === undefined || reading.sensitive) continue;
      for (const indicator of reading.userSideIndicators ?? []) {
        if (indicator.confidence < floor) continue;
        if (best === undefined || indicator.confidence > best.indicator.confidence) best = { indicator, reading };
      }
    }
  }
  return best;
}

/** The evidence as one clean clause: whitespace collapsed, trailing punctuation dropped, cut at a word. */
export function cleanEvidence(evidence: string): string {
  let text = evidence.replace(/\s+/g, ' ').trim().replace(/[.;:,!?\s]+$/, '');
  if (text.length > MAX_EVIDENCE) {
    const cut = text.slice(0, MAX_EVIDENCE);
    const space = cut.lastIndexOf(' ');
    text = `${(space > MAX_EVIDENCE / 2 ? cut.slice(0, space) : cut).replace(/[.;:,!?\s]+$/, '')}...`;
  }
  return text;
}

/** The environment a wrong-environment indicator's evidence names, as the screen shows it; else undefined. */
export function environmentIn(kind: UserSideKind, evidence: string): string | undefined {
  if (kind !== 'wrong-environment') return undefined;
  return ENVIRONMENT_WORDS.exec(evidence)?.[1]?.toLowerCase();
}

/** The reading's `environmentHint` for an environment name a reporter confirmed. */
export function environmentHintFor(environment: string): NonNullable<ImageReading['environmentHint']> {
  return environment === 'local' || environment === 'localhost' ? 'local' : 'staging';
}

/** The record a `clarified` round keeps for an indicator. */
export function checkRecord(indicator: UserSideIndicator): UserSideCheckRecord {
  const evidence = cleanEvidence(indicator.evidence);
  const environment = environmentIn(indicator.kind, evidence);
  return { kind: indicator.kind, evidence, ...(environment === undefined ? {} : { environment }) };
}

/** The card's buttons: That fixed it, Still broken, and I meant <env> when the screenshot names one. */
export function checkOptions(record: UserSideCheckRecord): string[] {
  return [ANSWER_FIXED, ANSWER_STILL_BROKEN, ...(record.environment === undefined ? [] : [`${ANSWER_MEANT_PREFIX}${record.environment}`])];
}

/** The card's text (A 5.2): what the screenshot shows, then one favor. */
export function checkText(record: UserSideCheckRecord): string {
  return `Before I file this, one thing in your screenshot: ${record.evidence}. ${FAVORS[record.kind].ask}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` with what the reporter's own screen shows (the evidence, the environment name in it) masked for the gate. */
function masked(text: string, record: UserSideCheckRecord): string {
  let out = text.split(record.evidence).join('what you saw');
  if (record.environment !== undefined) out = out.replace(new RegExp(`\\b${escapeRegExp(record.environment)}\\b`, 'gi'), 'that one');
  return out;
}

export interface UserSideCheck {
  record: UserSideCheckRecord;
  question: ClarifyQuestion;
}

/** The counts the gate's budget and volume checks read (main 7.2). */
export type CheckBudget = Pick<GateContext, 'maxQuestionsPerIncident' | 'suppressWhenReportersAtLeast' | 'questionsAsked' | 'reportersInWindow' | 'escalated'>;

/**
 * The user-side check for this bundle, or undefined when `userSide check` is off or no indicator
 * reaches `signals/lexicon/@confidenceFloor`. The returned question's `gatePassed` and `gateFailures`
 * say whether it may be asked; a check that fails the gate is not asked and the gap question (if
 * any) gets its turn.
 */
export function userSideCheck(bundle: ContextBundle, playbook: Playbook, budget: CheckBudget): UserSideCheck | undefined {
  if (!playbook.userSide.check) return undefined;
  const picked = pickIndicator(bundle, playbook.signals.lexicon.confidenceFloor);
  if (picked === undefined) return undefined;
  const record = checkRecord(picked.indicator);
  const text = checkText(record);
  const options = checkOptions(record);
  const failures = evaluateGate(
    { audience: 'reporter', kind: 'experiential', asks: 'other', text: masked(text, record), options: options.map((o) => masked(o, record)), screenshotRequest: false },
    { ...budget, known: { surface: false, component: false, environment: false, screenshot: false }, mapOptions: [] },
  );
  return {
    record,
    question: { audience: 'reporter', text, options, asks: 'other', gatePassed: failures.length === 0, gateFailures: failures },
  };
}

/** What an answer to the check means. Anything that is not a known button files normally. */
export type CheckAnswer = { kind: 'fixed' } | { kind: 'still-broken' } | { kind: 'meant'; environment: string };

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function readAnswer(record: UserSideCheckRecord, answer: string): CheckAnswer {
  if (same(answer, ANSWER_FIXED)) return { kind: 'fixed' };
  if (record.environment !== undefined && same(answer, `${ANSWER_MEANT_PREFIX}${record.environment}`)) {
    return { kind: 'meant', environment: record.environment };
  }
  return { kind: 'still-broken' };
}

/** The friendly thread note after That fixed it. */
export function fixedNote(record: UserSideCheckRecord): string {
  if (record.kind === 'wrong-environment') {
    const link = record.environment === undefined ? 'the test site' : `the ${record.environment} link`;
    return `Great, no bug then. Flagging that ${link} is easy to land on.`;
  }
  return 'Great, no bug then. Thanks for trying that.';
}

/**
 * The line the ticket carries about the check (A 5.2: recorded so engineers do not repeat it). Names
 * nobody: "the reporter". `answer` undefined means the card timed out.
 */
export function ticketNote(record: UserSideCheckRecord, answer: CheckAnswer | undefined): string {
  const tried = FAVORS[record.kind].tried;
  if (answer === undefined) return `Before filing, the reporter was asked to ${tried} (the screenshot showed ${record.evidence}); no answer came back.`;
  if (answer.kind === 'meant') return `The reporter confirmed this is on ${answer.environment} (the screenshot showed ${record.evidence}).`;
  return `Already checked before filing: the screenshot showed ${record.evidence}, so the reporter was asked to ${tried}. Still broken.`;
}

/**
 * The bundle as filed after `I meant <env>`: every non-sensitive image reading says that environment,
 * so the ticket's Environment line and the triage model both have it.
 */
export function withEnvironment(bundle: ContextBundle, environment: string): ContextBundle {
  const hint = environmentHintFor(environment);
  return {
    ...bundle,
    included: bundle.included.map((m) => ({
      ...m,
      attachments: m.attachments.map((a) =>
        a.kind === 'image' && a.reading !== undefined && !a.reading.sensitive ? { ...a, reading: { ...a.reading, environmentHint: hint } } : a,
      ),
    })),
  };
}
