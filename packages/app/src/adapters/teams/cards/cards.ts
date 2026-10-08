// Pure builders from an InteractiveCard to Adaptive Card 1.5 JSON (main 5.5, 6.2, 7.2, 8.2, 11.2, 15.2).
// Every action is an `Action.Execute` whose `verb` is an ApprovalAction or the card's choice and whose
// `data` is `{ incidentId }` plus the context a Slack block id carries. Mirrors `adapters/slack/cards`.

import type { ClaimedCard, FileConfirmCard, InteractiveCard, PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { TriageResolutionPlan } from '@snapwing/pipeline/contracts/incident.ts';
import type { MidFlightCard } from '@snapwing/pipeline/fixer/claims.ts';
import type { ResolutionPrompt, ScopeChangeCard } from '@snapwing/pipeline/signals/text.ts';
import { actionSet, card, compose, free, lit, who, type ActionSpec, type AdaptiveCard, type MentionFor, type Part } from './elements.ts';
import { buildMidFlightCard } from './mid-flight.ts';
import { buildResolutionPrompt, buildScopeChangeCard } from './signals.ts';

export interface FixPreviewOptions {
  /** Level 1: only engineers may tap `Fix it` (main 8.2). Default `engineer`. */
  viewer?: 'engineer' | 'reporter';
}

export interface PrReadyOptions {
  /** The viewer has a linked GitHub identity and is a requested reviewer (main 11.2). Default false. */
  canMerge?: boolean;
}

export interface CommonOptions {
  /** Resolves a mention ref to a person (map `teamsId`); an unknown ref stays `@name`. */
  mentions?: MentionFor;
  /** Reduced mode (main 15.2): the card says so in one line. */
  reduced?: boolean;
}

export interface MidFlightOptions {
  /** The grace in force, in milliseconds, for the "no answer" line. Default ten minutes. */
  graceMs?: number;
}

export type CardOptions = FixPreviewOptions & PrReadyOptions & CommonOptions & MidFlightOptions;

/** A resolution question as a card input: the prompt with its kind. */
export type ResolutionCard = ResolutionPrompt & { kind: 'resolution' };

/** Every card the Teams adapter posts. */
export type TeamsCardInput = InteractiveCard | MidFlightCard | ScopeChangeCard | ResolutionCard;

export function buildScopePreview(incidentId: string, c: Extract<InteractiveCard, { kind: 'scope-preview' }>, opts: CommonOptions = {}): AdaptiveCard {
  return card(
    c.summary,
    [compose([free(c.summary)], opts.mentions)],
    actionSet(incidentId, [
      { title: 'Looks right', verb: 'looks-right', style: 'positive' },
      { title: 'Widen', verb: 'widen' },
      { title: 'Narrow', verb: 'narrow' },
    ]),
    opts,
  );
}

export function buildDedupe(incidentId: string, c: Extract<InteractiveCard, { kind: 'dedupe' }>, opts: CommonOptions = {}): AdaptiveCard {
  const facts = [
    c.openSince === undefined ? undefined : `open since ${c.openSince}`,
    c.assignee === undefined ? undefined : `assigned to ${c.assignee}`,
  ].filter((f): f is string => f !== undefined);
  return card(
    `This looks like ${c.issueKey}: ${c.summary}`,
    [
      compose(
        [lit('This looks like **'), free(c.issueKey), lit('**'), free(facts.length > 0 ? ` (${facts.join(', ')})` : ''), free(`: "${c.summary}"`)],
        opts.mentions,
      ),
    ],
    actionSet(incidentId, [
      { title: `Link this thread to ${c.issueKey}`, verb: 'link', style: 'positive' },
      { title: 'Create new anyway', verb: 'create-anyway' },
      { title: 'Not related', verb: 'not-related' },
    ]),
    opts,
  );
}

/** The action `data` key that names a clarify card, whose verbs are free text and may be any other card's. */
export const CLARIFY_DATA = { card: 'clarify' } as const;

/**
 * Two to four actions whose verb is the option text, or text alone for a screenshot request. The option
 * is free text (it may read `stop` or `merge`), so the card's kind rides in the data (`CLARIFY_DATA`).
 */
export function buildClarify(incidentId: string, c: Extract<InteractiveCard, { kind: 'clarify' }>, opts: CommonOptions = {}): AdaptiveCard {
  const { text, options } = c.question;
  let actions: AdaptiveCard['actions'];
  if (options !== undefined) {
    if (options.length < 2 || options.length > 4) throw new RangeError('a clarify card has 2 to 4 options');
    actions = actionSet(
      incidentId,
      options.map((o) => ({ title: o, verb: o })),
      CLARIFY_DATA,
    );
  }
  return card(text, [compose([free(text)], opts.mentions)], actions ?? [], opts);
}

function fixTouches(plan: TriageResolutionPlan): Part[] | undefined {
  const files = plan.diagnosis?.files ?? [];
  if (files.length === 0) return undefined;
  return [lit('**Proposed fix touches:** '), free(files.map((f) => f.path).join(', '))];
}

/** Level 1: `Fix it` (engineers), `Ticket only`, `Not a bug`. Levels 2 and 3: `Stop`, `Not a bug`, "Fixing now" badge. */
export function buildFixPreview(
  incidentId: string,
  c: Extract<InteractiveCard, { kind: 'fix-preview' }>,
  opts: FixPreviewOptions & CommonOptions = {},
): AdaptiveCard {
  const { plan } = c;
  const fixing = plan.autonomyLevel >= 2;
  const facts: Part[] = [];
  if (c.surface !== undefined) facts.push(lit('**Surface:** '), free(c.surface), lit('  '));
  if (c.ownerUserId !== undefined) facts.push(lit('**Owner:** '), who(c.ownerUserId), lit('  '));
  facts.push(lit('**Priority:** '), free(plan.priority));
  const body = [
    compose([lit(fixing ? '\u{1F527} **Fixing now.** ' : ''), lit('**Diagnosis:** '), free(plan.summary)], opts.mentions),
    compose(facts, opts.mentions),
  ];
  const touches = fixTouches(plan);
  if (touches !== undefined) body.push(compose(touches, opts.mentions));
  const specs: ActionSpec[] = [];
  if (fixing) {
    specs.push({ title: 'Stop', verb: 'stop', style: 'destructive' }, { title: 'Not a bug', verb: 'dismiss' });
  } else {
    if (plan.autonomyLevel === 1 && (opts.viewer ?? 'engineer') === 'engineer') {
      specs.push({ title: 'Fix it', verb: 'approve_fix', style: 'positive' });
    }
    specs.push({ title: 'Ticket only', verb: 'ticket_only' }, { title: 'Not a bug', verb: 'dismiss', style: 'destructive' });
  }
  return card(`Diagnosis: ${plan.summary}`, body, actionSet(incidentId, specs), opts);
}

/** A 2.1: an engineer is on it, so the fix preview is replaced: `Let the agent take it`, `Not a bug`. */
export function buildClaimed(incidentId: string, c: ClaimedCard, opts: CommonOptions = {}): AdaptiveCard {
  return card(
    `Filed as ${c.issueKey}, assigned to the engineer who is on it`,
    [compose([lit('Filed as **'), free(c.issueKey), lit('** and assigned to '), who(c.claimerUserId), lit(", since they're on it.")], opts.mentions)],
    actionSet(incidentId, [
      { title: 'Let the agent take it', verb: 'let-agent-take', style: 'positive' },
      { title: 'Not a bug', verb: 'dismiss' },
    ]),
    opts,
  );
}

/**
 * main 15.3: a capture's lookup, "New. Looks like Website (from src/cart/total.ts). File it?" The
 * capture adapter holds it for the CLI or Raycast; it is never posted in Teams and renders here so every
 * card kind has a builder.
 */
export function buildFileConfirm(incidentId: string, c: FileConfirmCard, opts: CommonOptions = {}): AdaptiveCard {
  const parts: Part[] = [lit('New. Looks like **'), free(c.surfaceLabel), lit('**')];
  if (c.evidence !== undefined) parts.push(lit(' (from '), free(c.evidence), lit(')'));
  parts.push(lit('. File it?'));
  return card(
    `New. Looks like ${c.surfaceLabel}. File it?`,
    [compose(parts, opts.mentions)],
    actionSet(incidentId, [
      { title: 'File it', verb: 'file-it', style: 'positive' },
      { title: 'Not this surface', verb: 'not-this-surface' },
      { title: 'Cancel', verb: 'cancel' },
    ]),
    opts,
  );
}

function plural(n: number, one: string): string {
  return `${String(n)} ${one}${n === 1 ? '' : 's'}`;
}

/** main 11.2. Without a linked identity (or outside the requested reviewers) the card offers `Open PR` only. */
export function buildPrReady(incidentId: string, c: PrReadyCard, opts: PrReadyOptions & CommonOptions = {}): AdaptiveCard {
  const stats = `review agent: ${c.reviewVerdict}, CI: ${c.ciState}, ${plural(c.filesChanged, 'file')}, +${String(c.additions)} -${String(c.deletions)}`;
  const parts: Part[] = [lit(`**PR #${String(c.prNumber)} is ready** for `), free(`${c.issueKey} (${stats}).`)];
  if (c.reviewerUserIds.length > 0) {
    parts.push(lit(' Review requested from '));
    c.reviewerUserIds.forEach((r, i) => parts.push(...(i === 0 ? [] : [lit(', ')]), who(r)));
    parts.push(lit('.'));
  }
  const specs: ActionSpec[] = [{ title: 'Open PR', verb: 'open_pr', url: c.prUrl }];
  if (opts.canMerge === true) {
    specs.push(
      { title: 'Merge', verb: 'merge', style: 'positive' },
      { title: 'Request changes', verb: 'request_changes' },
      { title: 'Stop', verb: 'stop', style: 'destructive' },
    );
  }
  return card(`PR #${String(c.prNumber)} is ready for ${c.issueKey}`, [compose(parts, opts.mentions)], actionSet(incidentId, specs), opts);
}

/** Dispatches on the card kind. */
export function buildCard(incidentId: string, c: TeamsCardInput, opts: CardOptions = {}): AdaptiveCard {
  switch (c.kind) {
    case 'scope-preview':
      return buildScopePreview(incidentId, c, opts);
    case 'dedupe':
      return buildDedupe(incidentId, c, opts);
    case 'clarify':
      return buildClarify(incidentId, c, opts);
    case 'fix-preview':
      return buildFixPreview(incidentId, c, opts);
    case 'claimed':
      return buildClaimed(incidentId, c, opts);
    case 'pr-ready':
      return buildPrReady(incidentId, c, opts);
    case 'file-confirm':
      return buildFileConfirm(incidentId, c, opts);
    case 'mid-flight':
      return buildMidFlightCard(incidentId, c, opts.graceMs ?? 600_000, opts);
    case 'scope-change':
      return buildScopeChangeCard(incidentId, c, opts);
    case 'resolution':
      return buildResolutionPrompt(incidentId, c, opts);
  }
}
