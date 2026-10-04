// Pure builders from an InteractiveCard to Block Kit JSON (main 5.5, 6.2, 7.2, 8.2, 11.2).
// Every button carries `action_id` (an ApprovalAction or the card's choice) and `value` (the incident id).

import type { ClaimedCard, FileConfirmCard, InteractiveCard, PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { TriageResolutionPlan } from '@snapwing/pipeline/contracts/incident.ts';
import { actions, context, esc, mention, section, type ButtonSpec, type SlackBlock, type SlackMessage } from './blocks.ts';

export interface FixPreviewOptions {
  /** Level 1: only engineers may tap `Fix it` (main 8.2). Default `engineer`. */
  viewer?: 'engineer' | 'reporter';
}

export interface PrReadyOptions {
  /** The viewer has a linked GitHub identity and is a requested reviewer (main 11.2). Default false. */
  canMerge?: boolean;
}

export type CardOptions = FixPreviewOptions & PrReadyOptions;

export function buildScopePreview(incidentId: string, card: Extract<InteractiveCard, { kind: 'scope-preview' }>): SlackMessage {
  return {
    text: card.summary,
    blocks: [
      section(esc(card.summary)),
      actions('scope_actions', [
        { label: 'Looks right', actionId: 'looks-right', value: incidentId, style: 'primary' },
        { label: 'Widen', actionId: 'widen', value: incidentId },
        { label: 'Narrow', actionId: 'narrow', value: incidentId },
      ]),
    ],
  };
}

export function buildDedupe(incidentId: string, card: Extract<InteractiveCard, { kind: 'dedupe' }>): SlackMessage {
  const facts = [
    card.openSince === undefined ? undefined : `open since ${esc(card.openSince)}`,
    card.assignee === undefined ? undefined : `assigned to ${esc(card.assignee)}`,
  ].filter((f): f is string => f !== undefined);
  const lead = `This looks like *${esc(card.issueKey)}*${facts.length > 0 ? ` (${facts.join(', ')})` : ''}: "${esc(card.summary)}"`;
  return {
    text: `This looks like ${card.issueKey}: ${card.summary}`,
    blocks: [
      section(lead),
      actions('dedupe_actions', [
        { label: `Link this thread to ${card.issueKey}`, actionId: 'link', value: incidentId, style: 'primary' },
        { label: 'Create new anyway', actionId: 'create-anyway', value: incidentId },
        { label: 'Not related', actionId: 'not-related', value: incidentId },
      ]),
    ],
  };
}

/** Two to four buttons whose action_id is the option text, or text alone for a screenshot request. */
export function buildClarify(incidentId: string, card: Extract<InteractiveCard, { kind: 'clarify' }>): SlackMessage {
  const { text, options } = card.question;
  const blocks: SlackBlock[] = [section(esc(text))];
  if (options !== undefined) {
    if (options.length < 2 || options.length > 4) throw new RangeError('a clarify card has 2 to 4 options');
    blocks.push(actions('clarify_actions', options.map((o) => ({ label: o, actionId: o, value: incidentId }))));
  }
  return { text, blocks };
}

function fixTouches(plan: TriageResolutionPlan): string | undefined {
  const files = plan.diagnosis?.files ?? [];
  if (files.length === 0) return undefined;
  return `*Proposed fix touches:* ${files.map((f) => `\`${f.path.replace(/`/g, "'")}\``).join(', ')}`;
}

/** Level 1: `Fix it` (engineers), `Ticket only`, `Not a bug`. Levels 2 and 3: `Stop`, `Not a bug`, "Fixing now" badge. */
export function buildFixPreview(
  incidentId: string,
  card: Extract<InteractiveCard, { kind: 'fix-preview' }>,
  opts: FixPreviewOptions = {},
): SlackMessage {
  const { plan } = card;
  const fixing = plan.autonomyLevel >= 2;
  const badge = fixing ? '\u{1F527} *Fixing now.* ' : '';
  const facts = [
    card.surface === undefined ? undefined : `*Surface:* ${esc(card.surface)}`,
    card.ownerUserId === undefined ? undefined : `*Owner:* ${mention(card.ownerUserId)}`,
    `*Priority:* ${esc(plan.priority)}`,
  ].filter((f): f is string => f !== undefined);
  const blocks: SlackBlock[] = [section(`${badge}*Diagnosis:* ${esc(plan.summary)}`), context(facts.join('  '))];
  const touches = fixTouches(plan);
  if (touches !== undefined) blocks.push(section(touches));
  const buttons: ButtonSpec[] = [];
  if (fixing) {
    buttons.push(
      { label: 'Stop', actionId: 'stop', value: incidentId, style: 'danger' },
      { label: 'Not a bug', actionId: 'dismiss', value: incidentId },
    );
  } else {
    if (plan.autonomyLevel === 1 && (opts.viewer ?? 'engineer') === 'engineer') {
      buttons.push({ label: 'Fix it', actionId: 'approve_fix', value: incidentId, style: 'primary' });
    }
    buttons.push(
      { label: 'Ticket only', actionId: 'ticket_only', value: incidentId },
      { label: 'Not a bug', actionId: 'dismiss', value: incidentId, style: 'danger' },
    );
  }
  blocks.push(actions('triage_actions', buttons));
  return { text: `Diagnosis: ${plan.summary}`, blocks };
}

/** A 2.1: an engineer is on it, so the fix preview is replaced: `Let the agent take it`, `Not a bug`. */
export function buildClaimed(incidentId: string, card: ClaimedCard): SlackMessage {
  return {
    text: `Filed as ${card.issueKey}, assigned to the engineer who is on it`,
    blocks: [
      section(`Filed as *${esc(card.issueKey)}* and assigned to ${mention(card.claimerUserId)}, since they're on it.`),
      actions('claim_actions', [
        { label: 'Let the agent take it', actionId: 'let-agent-take', value: incidentId, style: 'primary' },
        { label: 'Not a bug', actionId: 'dismiss', value: incidentId },
      ]),
    ],
  };
}

/**
 * main 15.3 (#377): a capture's lookup, "New. Looks like Website (from src/cart/total.ts). File it?" The
 * capture adapter holds it for the CLI or Raycast; it is never posted in Slack and renders here so every
 * card kind has a builder.
 */
export function buildFileConfirm(incidentId: string, card: FileConfirmCard): SlackMessage {
  const from = card.evidence === undefined ? '' : ` (from \`${card.evidence.replace(/`/g, "'")}\`)`;
  return {
    text: `New. Looks like ${card.surfaceLabel}. File it?`,
    blocks: [
      section(`New. Looks like *${esc(card.surfaceLabel)}*${from}. File it?`),
      actions('file_confirm_actions', [
        { label: 'File it', actionId: 'file-it', value: incidentId, style: 'primary' },
        { label: 'Not this surface', actionId: 'not-this-surface', value: incidentId },
        { label: 'Cancel', actionId: 'cancel', value: incidentId },
      ]),
    ],
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** main 11.2. Without a linked identity (or outside the requested reviewers) the card offers `Open PR` only. */
export function buildPrReady(incidentId: string, card: PrReadyCard, opts: PrReadyOptions = {}): SlackMessage {
  const stats = `review agent: ${card.reviewVerdict}, CI: ${card.ciState}, ${plural(card.filesChanged, 'file')}, +${card.additions} -${card.deletions}`;
  const reviewers = card.reviewerUserIds.length === 0 ? '' : ` Review requested from ${card.reviewerUserIds.map(mention).join(', ')}.`;
  const buttons: ButtonSpec[] = [{ label: 'Open PR', actionId: 'open_pr', value: incidentId, url: card.prUrl }];
  if (opts.canMerge === true) {
    buttons.push(
      { label: 'Merge', actionId: 'merge', value: incidentId, style: 'primary' },
      { label: 'Request changes', actionId: 'request_changes', value: incidentId },
      { label: 'Stop', actionId: 'stop', value: incidentId, style: 'danger' },
    );
  }
  return {
    text: `PR #${card.prNumber} is ready for ${card.issueKey}`,
    blocks: [
      section(`*PR #${card.prNumber} is ready* for ${esc(card.issueKey)} (${stats}).${reviewers}`),
      actions('pr_actions', buttons),
    ],
  };
}

/** Dispatches on the card kind. */
export function buildCard(incidentId: string, card: InteractiveCard, opts: CardOptions = {}): SlackMessage {
  switch (card.kind) {
    case 'scope-preview':
      return buildScopePreview(incidentId, card);
    case 'dedupe':
      return buildDedupe(incidentId, card);
    case 'clarify':
      return buildClarify(incidentId, card);
    case 'fix-preview':
      return buildFixPreview(incidentId, card, opts);
    case 'claimed':
      return buildClaimed(incidentId, card);
    case 'pr-ready':
      return buildPrReady(incidentId, card, opts);
    case 'file-confirm':
      return buildFileConfirm(incidentId, card);
  }
}
