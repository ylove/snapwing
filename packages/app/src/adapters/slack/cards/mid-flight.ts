// The mid-flight claim card (A 2.2, #292, #337): "@dana, the fixer started on this 4 minutes ago and
// is on `fix/WEB-1042`." with **Let it finish** and **Stop it, I'll take over**. Pure: no I/O.
//
// The buttons' value is the incident id, as on every card. The run and the claimer the card offers the
// choice for ride in the actions block's id (`midflight_actions:<runId>:<claimerId>`), so a tap
// answers exactly that offer (`answerMidFlight` refuses one for a run that is no longer going).

import type { MidFlightCard, MidFlightChoice } from '@snapwing/pipeline/fixer/claims.ts';
import { midFlightText } from '@snapwing/pipeline/fixer/claims.ts';
import { actions, context, esc, mention, section, type SlackMessage } from './blocks.ts';

/** The block id prefix the interactivity routes on. */
export const MID_FLIGHT_BLOCK = 'midflight_actions';

/** Action id per choice; the interactivity maps them back. */
export const MID_FLIGHT_ACTIONS: Readonly<Record<MidFlightChoice, string>> = { 'let-it-finish': 'let_it_finish', 'stop-it': 'stop_it' };

const LABELS: Readonly<Record<MidFlightChoice, string>> = { 'let-it-finish': 'Let it finish', 'stop-it': "Stop it, I'll take over" };

/** Minutes, rounded, at least one: "10 minutes". */
function graceText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/** The card for `incidentId`. `graceMs` is `card.grace` parsed, for the "no answer" line. */
export function buildMidFlightCard(incidentId: string, card: MidFlightCard, graceMs: number): SlackMessage {
  const lead = midFlightText(card, mention(card.claimerUserId));
  const blockId = `${MID_FLIGHT_BLOCK}:${card.runId}:${card.claimerUserId}`;
  return {
    text: lead.replace(/`/g, ''),
    blocks: [
      section(esc(lead).replace(/&lt;@([A-Z0-9]+)&gt;/g, '<@$1>')),
      actions(
        blockId,
        card.choices.map((choice) => ({
          label: LABELS[choice],
          actionId: MID_FLIGHT_ACTIONS[choice],
          value: incidentId,
          ...(choice === 'stop-it' ? { style: 'danger' as const } : {}),
        })),
      ),
      context(`No answer in ${graceText(graceMs)} means *Let it finish*.`),
    ],
  };
}

/** The run and claimer from a mid-flight block id, or undefined for any other block. */
export function parseMidFlightBlock(blockId: string): { runId: string; claimerId: string } | undefined {
  const [prefix, runId, claimerId, ...rest] = blockId.split(':');
  if (prefix !== MID_FLIGHT_BLOCK || runId === undefined || runId === '' || claimerId === undefined || claimerId === '' || rest.length > 0) return undefined;
  return { runId, claimerId };
}

/** The choice an action id stands for, or undefined. */
export function midFlightChoiceOf(actionId: string): MidFlightChoice | undefined {
  return (Object.keys(MID_FLIGHT_ACTIONS) as MidFlightChoice[]).find((c) => MID_FLIGHT_ACTIONS[c] === actionId);
}
