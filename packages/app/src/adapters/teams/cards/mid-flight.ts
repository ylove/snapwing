// The mid-flight claim card (A 2.2) as an Adaptive Card: "@dana, the fixer started on this 4 minutes ago
// and is on fix/WEB-1042." with **Let it finish** and **Stop it, I'll take over**. Pure: no I/O.
// The run and the claimer ride in each action's `data` (Slack carries them in the block id), so a tap
// answers exactly that offer.

import type { MidFlightCard, MidFlightChoice } from '@snapwing/pipeline/fixer/claims.ts';
import { midFlightText } from '@snapwing/pipeline/fixer/claims.ts';
import { actionSet, card, compose, free, textBlock, who, type AdaptiveCard, type MentionFor, type Part } from './elements.ts';

/** Verb per choice; the interactivity maps them back (same ids as Slack). */
export const MID_FLIGHT_VERBS: Readonly<Record<MidFlightChoice, string>> = { 'let-it-finish': 'let_it_finish', 'stop-it': 'stop_it' };

const LABELS: Readonly<Record<MidFlightChoice, string>> = { 'let-it-finish': 'Let it finish', 'stop-it': "Stop it, I'll take over" };

/** Minutes, rounded, at least one: "10 minutes". */
function graceText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/** The card for `incidentId`. `graceMs` is `card.grace` parsed, for the "no answer" line. */
export function buildMidFlightCard(
  incidentId: string,
  c: MidFlightCard,
  graceMs: number,
  opts: { mentions?: MentionFor; reduced?: boolean } = {},
): AdaptiveCard {
  const marker = '\u0000';
  const lead = midFlightText(c, marker).replace(/`/g, '');
  const [before = '', after = ''] = lead.split(marker);
  const parts: Part[] = [free(before), who(c.claimerUserId), free(after)];
  return card(
    midFlightText(c, `@${c.claimerUserId}`).replace(/`/g, ''),
    [compose(parts, opts.mentions), textBlock(`No answer in ${graceText(graceMs)} means **Let it finish**.`, { isSubtle: true, size: 'Small' })],
    actionSet(
      incidentId,
      c.choices.map((choice) => ({ title: LABELS[choice], verb: MID_FLIGHT_VERBS[choice], ...(choice === 'stop-it' ? { style: 'destructive' as const } : {}) })),
      { runId: c.runId, claimerId: c.claimerUserId },
    ),
    opts,
  );
}

/** The choice a verb stands for, or undefined. */
export function midFlightChoiceOf(verb: string): MidFlightChoice | undefined {
  return (Object.keys(MID_FLIGHT_VERBS) as MidFlightChoice[]).find((c) => MID_FLIGHT_VERBS[c] === verb);
}
