// The mid-flight claim card (A 2.2, #292): "@dana, the fixer started on this 4 minutes ago and
// is on `fix/WEB-1042`." with **Let it finish** and **Stop it, I'll take over**. Pure: no I/O.
//
// The buttons' value is the incident id, as on every card. The run and the claimer the card offers the
// choice for ride in the actions block's id (`midflight_actions:<runId>:<claimerId>`), so a tap
// answers exactly that offer (`answerMidFlight` refuses one for a run that is no longer going).
//
// The branch is the fixer's own text (#306): the claimer's mention is a mention mark
// (`adapters/shared/mention-marks.ts`) and everything else, the branch included, goes through Slack's
// escape, so a `<@U...>` or `<!channel>` the fixer put in its branch shows as text and pings nobody,
// in the blocks and in the notification text alike.

import type { MidFlightCard, MidFlightChoice } from '@snapwing/pipeline/fixer/claims.ts';
import { midFlightText } from '@snapwing/pipeline/fixer/claims.ts';
import { createMentionMarks } from '../../shared/mention-marks.ts';
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
  const marks = createMentionMarks();
  const lead = midFlightText(card, marks.mark(card.claimerUserId));
  const blockId = `${MID_FLIGHT_BLOCK}:${card.runId}:${card.claimerUserId}`;
  return {
    text: marks.render(lead.replace(/`/g, ''), esc, mention),
    blocks: [
      section(marks.render(lead, esc, mention)),
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
