// Target resolution (A 1.3, #287): the same reaction means different things on different messages.
// A signal resolves as `(intent, target role, reactor role)` to one effect, or to nothing.
//
// The A 1.3 matrix is data (`SIGNAL_MATRIX`), read top to bottom: the first rule whose intent,
// target, reactor, and requirements all match gives the effect. Only `accept`, `reject`, and `claim`
// depend on the target; every other intent (trigger, escalate, release, stop, watch, not-a-bug)
// means the same on any message, so `resolveSignal` returns nothing for them and the signal handler
// applies them as they are. A cell A 1.3 marks n/a, the `other` role, and a message Snapwing knows
// nothing about (an undefined target) resolve to nothing.
//
// Reactor role (A 1.3 last paragraph): `engineer` from the workspace map, and everyone else as a
// `reporter`, the least trusted role: a person the map does not know (`unknown`, or `human` from a
// Jira user) never gets an engineer's effect.
//
// Decisions where A 1.3 is terse:
// - Anchor `accept`: `agree` from a reporter (counts toward escalation, A 1.4), `confirm` from an
//   engineer (counts toward confirmation). Anchor `reject` is `dispute` from anyone; the handler
//   counts engineers' disputes toward the hold at ticket-only.
// - `claim` holds the fixer only from an engineer (A 2.1); a reporter's claim is a `comment`.
// - Fix Preview `accept` from an engineer is `fix-tap` only with `reactionsAsButtons` on (default
//   off); otherwise it is recorded as a `comment`. `reject` from an engineer is `not-a-bug`, as A 1.3
//   writes it, ungated; from a reporter it is a `comment`.
// - PR card: nobody's reaction merges anything. `accept` from an engineer with a linked GitHub
//   identity is a `review-note`, and a GitHub `approve` only with `reactionsAsApproval` on (default
//   off); from anyone else (a reporter, an unlinked engineer) it is a `comment`, never a review (A 8).
//   `reject` from an engineer is `changes-requested` (the review agent re-runs with the objection);
//   from a reporter it is a `comment`, as for `accept`.
// - Staging check: `accept` is `verify` and `reject` is `reopen`, from anyone (the reporter is the
//   usual verifier).
// - Status message: `accept` is `ack` (no action), `reject` is `reject-stage` (a reject on the most
//   recent stage).

import type { ActorRole } from '../contracts/incident.ts';
import type { EventActorRole } from '../contracts/events.ts';
import type { Intent, TargetRole } from '../contracts/signals.ts';
import type { StatePort } from '../ports/state.ts';
import type { StateContext } from '../state/context.ts';
import { getMessageTarget, type MessageRef, type MessageTarget } from '../state/projections/bot-messages.ts';
import { StateStore } from '../state/store.ts';

export type { MessageRef, MessageTarget } from '../state/projections/bot-messages.ts';

/** What a target-dependent signal does. The signal handler (#288) applies it. */
export type SignalEffect =
  // Anchor
  | 'agree'
  | 'confirm'
  | 'dispute'
  | 'hold'
  // Scope preview
  | 'looks-right'
  | 'rescope'
  // Dedupe card
  | 'link'
  | 'create-new'
  // Fix Preview Card
  | 'fix-tap'
  | 'not-a-bug'
  // PR card
  | 'review-note'
  | 'approve'
  | 'changes-requested'
  // Staging check
  | 'verify'
  | 'reopen'
  // Status message
  | 'ack'
  | 'reject-stage'
  // Recorded only (an attribution comment, A 1.5)
  | 'comment';

/** The intents whose meaning depends on the target (the A 1.3 columns). */
export type TargetIntent = Extract<Intent, 'accept' | 'reject' | 'claim'>;

/** The reactor roles the matrix distinguishes. */
export type ReactorClass = 'engineer' | 'reporter';

/** The playbook switches that gate matrix rules (A 6.2 `<signals>`); both default off. */
export interface SignalSwitches {
  /** `<reactionsAsButtons enabled>`: an engineer's accept on a Fix Preview Card is `Fix it`. */
  reactionsAsButtons?: boolean;
  /** `<reactionsAsApproval enabled>`: an engineer's accept on a PR card is a GitHub approval. */
  reactionsAsApproval?: boolean;
}

/** A requirement a rule has beyond intent, target, and reactor. */
export type SignalRequirement = keyof SignalSwitches | 'githubLinked';

export interface SignalRule {
  intent: TargetIntent;
  target: Exclude<TargetRole, 'other'>;
  /** `any`: both reactor classes. */
  reactor: ReactorClass | 'any';
  /** Every requirement must hold for the rule to match. */
  requires?: readonly SignalRequirement[];
  effect: SignalEffect;
}

export interface ResolveSignalOptions {
  /** The playbook's switches (A 6.2); absent ones are off. */
  playbook?: SignalSwitches;
  /** The reactor has a linked GitHub identity (main 11.2). Default false. */
  githubLinked?: boolean;
}

const rule = (
  intent: TargetIntent,
  target: SignalRule['target'],
  reactor: SignalRule['reactor'],
  effect: SignalEffect,
  requires?: readonly SignalRequirement[],
): SignalRule => Object.freeze({ intent, target, reactor, effect, ...(requires === undefined ? {} : { requires: Object.freeze([...requires]) }) });

/** The A 1.3 matrix. First match wins; see the file header for the cells A 1.3 leaves terse. */
export const SIGNAL_MATRIX: readonly SignalRule[] = Object.freeze([
  // Anchor (the original human message)
  rule('accept', 'anchor', 'engineer', 'confirm'),
  rule('accept', 'anchor', 'reporter', 'agree'),
  rule('reject', 'anchor', 'any', 'dispute'),
  rule('claim', 'anchor', 'engineer', 'hold'),
  rule('claim', 'anchor', 'reporter', 'comment'),
  // Scope preview (the buttons remain the primary path)
  rule('accept', 'scope-preview', 'any', 'looks-right'),
  rule('reject', 'scope-preview', 'any', 'rescope'),
  // Dedupe card
  rule('accept', 'dedupe', 'any', 'link'),
  rule('reject', 'dedupe', 'any', 'create-new'),
  // Fix Preview Card
  rule('accept', 'fix-preview', 'engineer', 'fix-tap', ['reactionsAsButtons']),
  rule('accept', 'fix-preview', 'any', 'comment'),
  rule('reject', 'fix-preview', 'engineer', 'not-a-bug'),
  rule('reject', 'fix-preview', 'reporter', 'comment'),
  rule('claim', 'fix-preview', 'engineer', 'hold'),
  rule('claim', 'fix-preview', 'reporter', 'comment'),
  // PR card: nobody's reaction merges anything
  rule('accept', 'pr', 'engineer', 'approve', ['githubLinked', 'reactionsAsApproval']),
  rule('accept', 'pr', 'engineer', 'review-note', ['githubLinked']),
  rule('accept', 'pr', 'any', 'comment'),
  rule('reject', 'pr', 'engineer', 'changes-requested'),
  rule('reject', 'pr', 'reporter', 'comment'),
  // Staging check ("can you check?")
  rule('accept', 'staging-check', 'any', 'verify'),
  rule('reject', 'staging-check', 'any', 'reopen'),
  // Status message
  rule('accept', 'status', 'any', 'ack'),
  rule('reject', 'status', 'any', 'reject-stage'),
]);

/** `engineer` from the map; anyone else (reporter, unknown, a Jira `human`) is a reporter. */
export function reactorClass(role: ActorRole | EventActorRole): ReactorClass {
  return role === 'engineer' ? 'engineer' : 'reporter';
}

function isTargetIntent(intent: Intent): intent is TargetIntent {
  return intent === 'accept' || intent === 'reject' || intent === 'claim';
}

/**
 * The effect of `intent` on a message of `targetRole` from a reactor of `reactorRole`, or undefined
 * when the signal has no target-dependent meaning there (see the file header). `targetRole`
 * undefined is a message Snapwing knows nothing about.
 */
export function resolveSignal(
  intent: Intent,
  targetRole: TargetRole | undefined,
  reactorRole: ActorRole | EventActorRole,
  options: ResolveSignalOptions = {},
): SignalEffect | undefined {
  if (targetRole === undefined || !isTargetIntent(intent)) return undefined;
  const reactor = reactorClass(reactorRole);
  const holds = (req: SignalRequirement): boolean => (req === 'githubLinked' ? options.githubLinked === true : options.playbook?.[req] === true);
  const match = SIGNAL_MATRIX.find(
    (r) =>
      r.intent === intent &&
      r.target === targetRole &&
      (r.reactor === 'any' || r.reactor === reactor) &&
      (r.requires ?? []).every(holds),
  );
  return match?.effect;
}

/**
 * The target a signal on `ref` lands on: a message Snapwing posted (its recorded role and incident),
 * an incident's anchor (`anchor`), or null for a message Snapwing knows nothing about. `state` is a
 * store `openState` returned (or one bound to a transaction), or a state context.
 */
export function resolveTarget(state: StatePort | StateContext, ref: MessageRef): Promise<MessageTarget | null> {
  return getMessageTarget(contextOf(state), ref);
}

function contextOf(state: StatePort | StateContext): StateContext {
  if (state instanceof StateStore) return state.ctx;
  if ('db' in state && 'codec' in state && 'now' in state) return state;
  throw new TypeError('resolveTarget: state must be a store openState returned, or a StateContext');
}
