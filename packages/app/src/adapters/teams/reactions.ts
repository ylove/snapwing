// Graph's `reactionType` to the playbook's `teams` reaction names (A 1.1, main 15.2 emoji trigger row).
//
// The playbook stores reaction names per platform (`<emoji slack="..." teams="..."/>`), but Graph does
// not report names: a `chatMessageReaction` (and a Bot Framework `messageReaction` activity) carries one
// of the six legacy types (`like`, `heart`, `laugh`, `surprised`, `sad`, `angry`) or, since Teams
// opened every emoji, the Unicode emoji itself. Some payloads write an emoji as its code points plus a
// short name (`1f41b_bug`). All three forms come down to one emoji here, and the table below names it.
//
// The table is the A 1.1 defaults (every emoji of every intent) plus the legacy six and the example
// playbook's 🐞. A name's `aliases` are the other names a playbook may use for the same emoji: the
// default playbook writes `teams` as the Slack name where the issue's table does not (🛑 is `stop` here
// and `octagonal_sign` in the defaults, 👍 `like` and `+1`). An emoji not in the table, `custom`
// reactions, and anything that does not parse resolve to no name: unknown types are ignored, never
// guessed. Skin tones, variation selectors, and the gendered ZWJ forms (🙋‍♀️, 🤷‍♂️) are the base emoji.
//
// Unverified live (no Teams tenant in this build): which of the three forms each surface sends, and
// whether a Unicode `reactionType` carries the variation selector. The parser accepts all of them.

export interface TeamsReactionEntry {
  /** The emoji, without variation selectors or skin tones. */
  emoji: string;
  /** The playbook's `teams` name (A 1.1). */
  name: string;
  /** Other names a playbook may give the same emoji. */
  aliases?: readonly string[];
}

/** Graph's legacy reaction types and the emoji each one is. */
export const LEGACY_REACTION_TYPES: Readonly<Record<string, string>> = Object.freeze({
  like: '👍',
  heart: '❤',
  laugh: '😆',
  surprised: '😮',
  sad: '😢',
  angry: '😠',
});

/** A 1.1, by intent, then the legacy types that are no intent by default. */
export const TEAMS_REACTION_TABLE: readonly TeamsReactionEntry[] = Object.freeze([
  // trigger
  { emoji: '🐛', name: 'bug' },
  { emoji: '🐞', name: 'ladybug' },
  // escalate
  { emoji: '🔥', name: 'fire' },
  { emoji: '🚨', name: 'rotating_light' },
  // claim
  { emoji: '👀', name: 'eyes' },
  { emoji: '🙋', name: 'raising_hand' },
  // release
  { emoji: '🙅', name: 'no_good' },
  // stop
  { emoji: '🛑', name: 'stop', aliases: ['octagonal_sign'] },
  { emoji: '✋', name: 'raised_hand' },
  // accept
  { emoji: '👍', name: 'like', aliases: ['+1'] },
  { emoji: '🙏', name: 'pray' },
  { emoji: '✅', name: 'white_check_mark' },
  { emoji: '❤', name: 'heart' },
  { emoji: '🎉', name: 'tada' },
  // reject
  { emoji: '👎', name: 'dislike', aliases: ['-1'] },
  { emoji: '❌', name: 'x' },
  // watch
  { emoji: '🔔', name: 'bell' },
  { emoji: '👁', name: 'eye' },
  // not-a-bug
  { emoji: '🤷', name: 'shrug' },
  // Graph's legacy types with no default intent
  { emoji: '😆', name: 'laugh' },
  { emoji: '😮', name: 'surprised' },
  { emoji: '😢', name: 'sad' },
  { emoji: '😠', name: 'angry' },
]);

const BY_EMOJI: ReadonlyMap<string, TeamsReactionEntry> = new Map(TEAMS_REACTION_TABLE.map((e) => [e.emoji, e]));

const VARIATION_SELECTORS = /[︎️]/gu;
const SKIN_TONES = /[\u{1F3FB}-\u{1F3FF}]/gu;
/** A ZWJ followed by the female or male sign: 🙋‍♀️ is 🙋. */
const GENDER_SUFFIX = /‍[♀♂]$/u;

/** An emoji with its presentation, skin tone, and gender modifiers taken off. */
export function baseEmoji(emoji: string): string {
  return emoji.replace(VARIATION_SELECTORS, '').replace(SKIN_TONES, '').replace(GENDER_SUFFIX, '').trim();
}

/** `1f41b_bug`, `1f44d-1f3fb_thumbsup`: code points in hex, then an underscore and a name. */
const CODEPOINT_FORM = /^([0-9a-f]{4,6}(?:-[0-9a-f]{4,6})*)_[a-z0-9_+-]+$/i;

/** The emoji a `reactionType` stands for, or undefined when it is not one of the three forms. */
export function emojiOfReactionType(reactionType: string): string | undefined {
  const type = reactionType.trim();
  if (type === '') return undefined;
  const legacy = LEGACY_REACTION_TYPES[type.toLowerCase()];
  if (legacy !== undefined) return legacy;
  const coded = CODEPOINT_FORM.exec(type);
  if (coded !== null) {
    const points = (coded[1] ?? '').split('-').map((h) => Number.parseInt(h, 16));
    if (points.some((p) => !Number.isFinite(p) || p > 0x10ffff)) return undefined;
    return baseEmoji(String.fromCodePoint(...points));
  }
  // A Unicode emoji: no ASCII letters or digits (that would be a name we do not know, or `custom`).
  if (/[A-Za-z0-9]/.test(type)) return undefined;
  return baseEmoji(type);
}

/** The table's entry for a `reactionType`, or undefined for an unknown type. */
export function teamsReactionEntry(reactionType: string): TeamsReactionEntry | undefined {
  const emoji = emojiOfReactionType(reactionType);
  return emoji === undefined ? undefined : BY_EMOJI.get(emoji);
}

/** The playbook's `teams` name for a `reactionType`, or undefined for an unknown type. */
export function teamsReactionName(reactionType: string): string | undefined {
  return teamsReactionEntry(reactionType)?.name;
}

/** Every name a playbook may use for the reaction, the A 1.1 name first; empty for an unknown type. */
export function teamsReactionNames(reactionType: string): readonly string[] {
  const entry = teamsReactionEntry(reactionType);
  return entry === undefined ? [] : [entry.name, ...(entry.aliases ?? [])];
}
