// Adaptive Card 1.5 building blocks (main 15.2, 20.1). Pure: no I/O, no SDK. Buttons are `Action.Execute`
// (Universal Actions), so a tap routes to the bot wherever the card was posted. Teams limits are enforced
// here and in the unit test so a card Teams would reject fails before it ships.

import { mentionToken, statusTextParts } from '@snapwing/pipeline/status/copy.ts';

/** Teams rejects a card payload over 28 KB. */
export const MAX_CARD_BYTES = 28 * 1024;
/** At most six actions in one action set. */
export const MAX_ACTIONS = 6;

export const REDUCED_BANNER = 'Reduced mode: I can only read the message you sent me. A team owner can approve channel access.';

export interface TextBlock {
  type: 'TextBlock';
  text: string;
  wrap: true;
  weight?: 'Bolder';
  size?: 'Small';
  isSubtle?: true;
  spacing?: 'Small';
}

export interface ExecuteAction {
  type: 'Action.Execute';
  title: string;
  /** An `ApprovalAction` or the card's choice. */
  verb: string;
  /** `{ incidentId }` plus the context a Slack block id carries. */
  data: { incidentId: string; [key: string]: string };
  style?: 'positive' | 'destructive';
}

export interface OpenUrlAction {
  type: 'Action.OpenUrl';
  title: string;
  url: string;
}

export type CardAction = ExecuteAction | OpenUrlAction;

export interface MentionEntity {
  type: 'mention';
  text: string;
  mentioned: { id: string; name: string };
}

export interface AdaptiveCard {
  type: 'AdaptiveCard';
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  version: '1.5';
  /** The notification and accessibility fallback, as Slack's message `text`. */
  fallbackText: string;
  body: TextBlock[];
  actions?: CardAction[];
  msteams?: { entities?: MentionEntity[] };
}

export interface ActionSpec {
  title: string;
  verb: string;
  style?: 'positive' | 'destructive';
  /** An `Action.OpenUrl` instead of an `Action.Execute`. */
  url?: string;
}

/** A person a mention ref resolves to: the AAD object id and the name shown in `<at>`. */
export interface TeamsPerson {
  id: string;
  name: string;
}

/** Maps a mention ref (a Teams id or a map handle) to a person; undefined renders the ref as plain `@ref`. */
export type MentionFor = (ref: string) => TeamsPerson | undefined;

export interface MapPersonLike {
  handle: string;
  teamsId?: string;
  slackId?: string;
}

/** A `MentionFor` over the workspace map's people: a ref matches `teamsId`, then the handle, then `slackId`. */
export function mentionsFromMap(people: readonly MapPersonLike[]): MentionFor {
  return (ref) => {
    const lower = ref.toLowerCase();
    const person =
      people.find((p) => p.teamsId !== undefined && p.teamsId === ref) ??
      people.find((p) => p.handle.toLowerCase() === lower) ??
      people.find((p) => p.slackId !== undefined && p.slackId === ref);
    return person?.teamsId === undefined || person.teamsId === '' ? undefined : { id: person.teamsId, name: person.handle };
  };
}

/** Escapes what a TextBlock treats as markdown or markup. */
export function esc(text: string): string {
  return text.replace(/[\\*_`[\]<>]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`));
}

/** Text with mentions, plus the entities its `<at>` tags need. */
export interface Rendered {
  text: string;
  entities: MentionEntity[];
}

/**
 * The neutral text (plain parts, mention tokens `<@ref>`) as TextBlock text: plain parts escaped, a known
 * ref as `<at>name</at>` with an entity keyed by the AAD object id, an unknown ref as `@ref`.
 */
export function renderText(neutral: string, mentions: MentionFor = () => undefined): Rendered {
  const entities: MentionEntity[] = [];
  const text = statusTextParts(neutral)
    .map((p) => {
      if (p.kind === 'text') return esc(p.text);
      const person = mentions(p.ref);
      if (person === undefined) return esc(`@${p.ref}`);
      const name = person.name.replace(/[<>]/g, '');
      const tag = `<at>${name}</at>`;
      if (!entities.some((e) => e.mentioned.id === person.id)) {
        entities.push({ type: 'mention', text: tag, mentioned: { id: person.id, name } });
      }
      return tag;
    })
    .join('');
  return { text, entities };
}

/** A piece of card text: markup written by us, free text to escape, or a person to mention. */
export type Part = { lit: string } | { free: string } | { who: string };

export const lit = (lit: string): Part => ({ lit });
export const free = (free: string): Part => ({ free });
export const who = (who: string): Part => ({ who });

/** Composes parts into TextBlock text: free text escaped, a person as `<at>` (or `@ref` when unknown). */
export function compose(parts: readonly Part[], mentions: MentionFor = () => undefined): Rendered {
  const entities: MentionEntity[] = [];
  let text = '';
  for (const p of parts) {
    if ('lit' in p) {
      text += p.lit;
    } else if ('free' in p) {
      text += esc(p.free);
    } else {
      const r = renderText(mentionToken(p.who), mentions);
      text += r.text;
      entities.push(...r.entities);
    }
  }
  return { text, entities };
}

export function textBlock(text: string, opts: Partial<Omit<TextBlock, 'type' | 'text' | 'wrap'>> = {}): TextBlock {
  return { type: 'TextBlock', text, wrap: true, ...opts };
}

export function action(incidentId: string, spec: ActionSpec, context: Readonly<Record<string, string>> = {}): CardAction {
  if (incidentId.length === 0) throw new RangeError('incidentId must not be empty');
  if (spec.title.length === 0) throw new RangeError('an action needs a title');
  if (spec.url !== undefined) return { type: 'Action.OpenUrl', title: spec.title, url: spec.url };
  if (spec.verb.length === 0) throw new RangeError('an action needs a verb');
  return {
    type: 'Action.Execute',
    title: spec.title,
    verb: spec.verb,
    data: { incidentId, ...context },
    ...(spec.style === undefined ? {} : { style: spec.style }),
  };
}

export function actionSet(incidentId: string, specs: readonly ActionSpec[], context: Readonly<Record<string, string>> = {}): CardAction[] {
  if (specs.length === 0 || specs.length > MAX_ACTIONS) throw new RangeError(`an action set holds 1 to ${MAX_ACTIONS} actions`);
  const verbs = specs.filter((s) => s.url === undefined).map((s) => s.verb);
  if (new Set(verbs).size !== verbs.length) throw new RangeError('verb must be unique within an action set');
  return specs.map((s) => action(incidentId, s, context));
}

/** The one-line reduced-mode banner, shown first. */
export function reducedBanner(): TextBlock {
  return textBlock(REDUCED_BANNER, { isSubtle: true, size: 'Small' });
}

/** Assembles a card; `Rendered` parts become TextBlocks and their entities are collected without duplicates. */
export function card(
  fallbackText: string,
  body: readonly (TextBlock | Rendered)[],
  actions: readonly CardAction[] = [],
  opts: { reduced?: boolean } = {},
): AdaptiveCard {
  const blocks: TextBlock[] = [];
  const entities: MentionEntity[] = [];
  if (opts.reduced === true) blocks.push(reducedBanner());
  for (const part of body) {
    if ('type' in part) {
      blocks.push(part);
    } else {
      blocks.push(textBlock(part.text));
      for (const e of part.entities) if (!entities.some((x) => x.mentioned.id === e.mentioned.id)) entities.push(e);
    }
  }
  const out: AdaptiveCard = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    fallbackText,
    body: blocks,
    ...(actions.length === 0 ? {} : { actions: [...actions] }),
    ...(entities.length === 0 ? {} : { msteams: { entities } }),
  };
  assertLimits(out);
  return out;
}

export function cardBytes(c: AdaptiveCard): number {
  return new TextEncoder().encode(JSON.stringify(c)).length;
}

/** Throws a RangeError for a card Teams would reject. */
export function assertLimits(c: AdaptiveCard): void {
  if ((c.actions?.length ?? 0) > MAX_ACTIONS) throw new RangeError(`a card holds at most ${MAX_ACTIONS} actions`);
  if (cardBytes(c) > MAX_CARD_BYTES) throw new RangeError('a card payload must stay under 28 KB');
}

/**
 * Replaces a card's actions with `line` (who chose what), as Slack does after an accepted tap. The
 * mention entities stay; the reduced banner is added once when `reduced` is set and not already there.
 */
export function refreshed(c: AdaptiveCard, line: string, opts: { reduced?: boolean; mentions?: MentionFor } = {}): AdaptiveCard {
  const rendered = renderText(line, opts.mentions);
  const body = [...c.body];
  if (opts.reduced === true && !body.some((b) => b.text === REDUCED_BANNER)) body.unshift(reducedBanner());
  body.push(textBlock(rendered.text, { isSubtle: true, spacing: 'Small' }));
  const entities = [...(c.msteams?.entities ?? [])];
  for (const e of rendered.entities) if (!entities.some((x) => x.mentioned.id === e.mentioned.id)) entities.push(e);
  const out: AdaptiveCard = {
    type: c.type,
    $schema: c.$schema,
    version: c.version,
    fallbackText: c.fallbackText,
    body,
    ...(entities.length === 0 ? {} : { msteams: { entities } }),
  };
  assertLimits(out);
  return out;
}
