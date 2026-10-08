// Onboarding step `trigger` (main 22.2, main 15.1 trigger emoji): the reaction people use to file a
// bug. It proposes the bug reaction, checks it exists on each connected chat platform (Slack: the
// standard names, then the workspace's custom ones from `emoji.list`; Teams: the reaction table the
// Teams adapter reads), offers a second reaction that needs more than one person, and offers a
// different reaction for one channel only when the installer asks.
//
// Reads (interview state, by step id): `slack` and `teams` (a platform counts as connected when its
// step left data), and `surfaces.channels` (the confirmed channels, for overrides). Its own data:
//   emoji:            [{ slack, teams, minReactors? }]   the workspace rows of the map
//   channelOverrides: [{ channel, emoji: [name] }]       by channel id; the map's `<trigger>` rows
//   platforms:        ['slack', 'teams']                 the connected platforms it checked against
//   unchecked:        ['slack']                          platforms where a reaction was kept without being confirmed

import { TEAMS_REACTION_TABLE, type TeamsReactionEntry } from '../../adapters/teams/reactions.ts';
import type { JsonObject, JsonValue } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';

type Platform = 'slack' | 'teams';

/** Slack names for emoji the bug-filing use cases reach for; the Teams table's names are standard too. */
const COMMON_SLACK_NAMES: readonly string[] = [
  'bug', 'beetle', 'ladybug', 'lady_beetle', 'fire', 'rotating_light', 'warning', 'eyes', 'raising_hand', 'no_good', 'octagonal_sign', 'stop_sign',
  'hand', 'raised_hand', '+1', 'thumbsup', '-1', 'thumbsdown', 'pray', 'white_check_mark', 'heavy_check_mark', 'heart', 'tada', 'x', 'bell', 'eye',
  'shrug', 'man-shrugging', 'woman-shrugging', 'rocket', 'sos', 'boom', 'collision', 'zap', 'skull', 'bomb', 'sob', 'cry', 'scream', 'thinking_face',
  'wrench', 'hammer', 'hammer_and_wrench', 'mag', 'mag_right', 'pushpin', 'memo', 'bulb', 'star', 'sparkles', 'question', 'exclamation',
  'grey_question', 'grey_exclamation', 'red_circle', 'large_orange_circle', 'large_yellow_circle', 'large_green_circle', 'triangular_flag_on_post',
  'flag-white', 'ok_hand', 'muscle', 'clap', 'raised_hands', 'point_up', 'point_right', 'white_frowning_face', 'face_with_symbols_on_mouth', 'angry',
  'smile', 'grin', 'joy', 'laughing', 'open_mouth', 'astonished', 'dizzy_face', 'face_palm', 'man-facepalming', 'woman-facepalming', 'see_no_evil',
  'hear_no_evil', 'speak_no_evil', 'ant', 'honeybee', 'spider', 'cockroach', 'mosquito', 'butterfly', 'snail', 'lizard',
];

const STANDARD_SLACK_NAMES: ReadonlySet<string> = new Set([
  ...COMMON_SLACK_NAMES,
  ...TEAMS_REACTION_TABLE.flatMap((e) => [e.name, ...(e.aliases ?? [])]),
]);

const GLYPH_TO_NAME: ReadonlyMap<string, TeamsReactionEntry> = new Map(TEAMS_REACTION_TABLE.map((e) => [e.emoji, e]));
const NAME = /^[a-z0-9_+-]+$/;

/** A reaction as typed: `bug`, `:bug:`, or the picture itself (when it is one the Teams table knows). */
export function parseReactionName(text: string): string | undefined {
  const t = text.trim().replace(/^:(.*):$/, '$1').toLowerCase();
  if (NAME.test(t)) return t;
  return GLYPH_TO_NAME.get(text.trim().replace(/[︎️]/gu, ''))?.name;
}

/** The Teams table's name for a reaction typed by its Slack name, or undefined when Teams lacks it. */
export function teamsNameFor(name: string): string | undefined {
  return TEAMS_REACTION_TABLE.find((e) => e.name === name || (e.aliases ?? []).includes(name))?.name;
}

const teamsNames = (): string => TEAMS_REACTION_TABLE.map((e) => `${e.emoji} ${e.name}`).join(', ');

interface EmojiRow {
  readonly slack: string;
  readonly teams: string;
  readonly minReactors?: number;
}

interface ChannelRef {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
}

interface SlackEmojiList {
  /** Undefined when the list could not be read (no token, no `emoji:read` scope, no connection). */
  names: ReadonlySet<string> | undefined;
}

/** The workspace's custom emoji and aliases from `emoji.list`; read once per run, never throws. */
async function readSlackEmoji(ctx: StepContext): Promise<SlackEmojiList> {
  const token = await ctx.readEnv('SLACK_BOT_TOKEN');
  if (token === undefined) return { names: undefined };
  try {
    const res = await fetch('https://slack.com/api/emoji.list', {
      headers: { authorization: `Bearer ${token.reveal()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { names: undefined };
    const body = (await res.json()) as { ok?: boolean; emoji?: Record<string, unknown> };
    if (body.ok !== true || typeof body.emoji !== 'object' || body.emoji === null) return { names: undefined };
    return { names: new Set(Object.keys(body.emoji)) };
  } catch {
    return { names: undefined };
  }
}

/** `yes`: Slack has it. `no`: Slack's lists do not. `unknown`: the custom list could not be read. */
function slackHas(name: string, custom: SlackEmojiList): 'yes' | 'no' | 'unknown' {
  if (STANDARD_SLACK_NAMES.has(name)) return 'yes';
  if (custom.names === undefined) return 'unknown';
  return custom.names.has(name) ? 'yes' : 'no';
}

const asRows = (v: JsonValue | undefined): EmojiRow[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const rows: EmojiRow[] = [];
  for (const r of v) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined;
    const { slack, teams, minReactors } = r as { [k: string]: JsonValue };
    if (typeof slack !== 'string' || typeof teams !== 'string') return undefined;
    rows.push({ slack, teams, ...(typeof minReactors === 'number' ? { minReactors } : {}) });
  }
  return rows;
};

function channelsOf(ctx: StepContext): ChannelRef[] {
  const raw = ctx.data('surfaces')?.['channels'];
  if (!Array.isArray(raw)) return [];
  const out: ChannelRef[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) continue;
    const { id, name, platform } = c as { [k: string]: JsonValue };
    if (typeof id === 'string' && typeof name === 'string') out.push({ id, name, platform: platform === 'teams' ? 'teams' : 'slack' });
  }
  return out;
}

const rowJson = (r: EmojiRow): JsonObject => ({ slack: r.slack, teams: r.teams, ...(r.minReactors === undefined ? {} : { minReactors: r.minReactors }) });

class Checker {
  readonly #ctx: StepContext;
  readonly platforms: readonly Platform[];
  #slackList: SlackEmojiList | undefined;
  /** Platforms where a reaction could not be confirmed and was used anyway. */
  readonly unchecked = new Set<Platform>();

  constructor(ctx: StepContext, platforms: readonly Platform[]) {
    this.#ctx = ctx;
    this.platforms = platforms;
  }

  async slack(name: string): Promise<'yes' | 'no' | 'unknown'> {
    if (STANDARD_SLACK_NAMES.has(name)) return 'yes';
    this.#slackList ??= await readSlackEmoji(this.#ctx);
    return slackHas(name, this.#slackList);
  }
}

/**
 * Asks for one reaction until it is settled for `platforms`: found on each, or kept on the
 * installer's say-so. Returns the row the map takes (Slack name, Teams name).
 */
async function askReaction(
  ctx: StepContext,
  checker: Checker,
  platforms: readonly Platform[],
  q: { id: string; text: string; default?: string; why: string },
  taken: readonly string[] = [],
): Promise<{ slack: string; teams: string }> {
  const { io } = ctx;
  for (;;) {
    const name = parseReactionName(
      await io.ask({
        id: q.id,
        text: q.text,
        ...(q.default === undefined ? {} : { default: q.default }),
        why: q.why,
        validate: (answer) => {
          const n = parseReactionName(answer);
          if (n === undefined) return 'Type the reaction by its name, such as bug (colons are fine), or paste it if it is a common one.';
          return taken.includes(n) ? `${n} is already a trigger. Pick another.` : undefined;
        },
      }),
    ) as string;

    const slack = name;
    if (platforms.includes('slack')) {
      const found = await checker.slack(name);
      if (found === 'no') {
        const next = await io.choose({
          id: `${q.id}-slack`,
          text: `Slack does not have a reaction called ${name}, standard or custom in your workspace.`,
          choices: [
            { id: 'again', label: 'Pick a different reaction' },
            { id: 'keep', label: 'Use it anyway (I will add it to Slack myself)' },
          ],
          default: 'again',
          why: 'Snapwing looked at Slack\'s standard names and at your workspace\'s custom emoji (emoji.list). If the name is a standard emoji Snapwing does not know, or you are about to add a custom one, use it anyway.',
        });
        if (next === 'again') continue;
        checker.unchecked.add('slack');
      } else if (found === 'unknown') {
        io.say(`Could not read your Slack custom emoji to check ${name}; using it as typed.`);
        checker.unchecked.add('slack');
      }
    }

    let teams = teamsNameFor(name) ?? name;
    if (platforms.includes('teams') && teamsNameFor(name) === undefined) {
      const next = await io.choose({
        id: `${q.id}-teams`,
        text: `Teams has no reaction called ${name}, so people on Teams could not file a bug with it.`,
        choices: [
          { id: 'again', label: 'Pick a different reaction for everyone' },
          { id: 'map', label: `Keep ${name} on Slack and name the reaction Teams people use instead` },
        ],
        default: 'again',
        why: `Teams reactions are the ones in its reaction table: ${teamsNames()}.`,
      });
      if (next === 'again') continue;
      const other = await io.ask({
        id: `${q.id}-teams-name`,
        text: 'Which Teams reaction should people there use?',
        default: 'bug',
        why: `One of: ${teamsNames()}.`,
        validate: (answer) => {
          const n = parseReactionName(answer);
          return n !== undefined && teamsNameFor(n) !== undefined ? undefined : `Teams has no such reaction. Pick one of: ${teamsNames()}.`;
        },
      });
      teams = teamsNameFor(parseReactionName(other) as string) as string;
    }
    return { slack, teams };
  }
}

export const triggerStep: OnboardStep = {
  id: 'trigger',
  number: 7,
  title: 'Pick the bug reaction',
  needs: [['slack', 'teams']],
  async run(ctx): Promise<StepOutcome> {
    const { io } = ctx;
    const platforms: Platform[] = (['slack', 'teams'] as const).filter((p) => ctx.data(p) !== undefined);
    const checker = new Checker(ctx, platforms);
    const channels = channelsOf(ctx);
    if (platforms.length === 0) io.say('No chat platform is connected yet, so the reaction cannot be checked; it is recorded as typed.');

    // A rerun or a resume: the saved choice is checked again, then kept or changed.
    const saved = ctx.data('trigger');
    const savedRows = asRows(saved?.['emoji']);
    if (savedRows !== undefined && savedRows.length > 0) {
      const problems: string[] = [];
      for (const r of savedRows) {
        if (platforms.includes('slack') && (await checker.slack(r.slack)) === 'no') problems.push(`Slack no longer has ${r.slack}`);
        if (platforms.includes('teams') && teamsNameFor(r.teams) === undefined) problems.push(`Teams has no ${r.teams}`);
      }
      io.say(`Saved: ${savedRows.map((r) => (r.minReactors === undefined ? r.slack : `${r.slack} (${r.minReactors} people)`)).join(', ')}.`);
      if (problems.length === 0) {
        const keep = await io.choose({
          id: 'keep',
          text: 'Keep the saved reaction choice?',
          choices: [
            { id: 'keep', label: 'Keep it' },
            { id: 'change', label: 'Choose again' },
          ],
          default: 'keep',
        });
        if (keep === 'keep' && saved !== undefined) return { status: 'done', data: saved };
      } else {
        io.say(`${problems.join('; ')}. Let us choose again.`);
      }
    }

    io.say('Next, the reaction people use to file a bug. Most teams use the bug, 🐛.');
    const first = await askReaction(ctx, checker, platforms, {
      id: 'emoji',
      text: 'Which reaction files a bug? Press Enter for bug.',
      default: 'bug',
      why: 'Sets the <emoji slack="..." teams="..."/> row in the workspace map. Anyone who adds this reaction to a message starts a report from it.',
    });
    const rows: EmojiRow[] = [first];
    const overrides: { channel: string; emoji: string[] }[] = [];

    for (;;) {
      const more = await io.choose({
        id: 'more',
        text: 'Anything else about the reaction?',
        choices: [
          { id: 'done', label: 'No, that is it' },
          { id: 'second', label: 'Add a second reaction' },
          { id: 'channel', label: 'Use a different reaction in one channel' },
        ],
        default: 'done',
        why: 'A second reaction can need several people, which suits an emoji like a fire that only counts when more than one person reacts. A channel override replaces the workspace reactions in that one channel.',
      });
      if (more === 'done') break;
      if (more === 'second') {
        const extra = await askReaction(
          ctx,
          checker,
          platforms,
          { id: 'second', text: 'Which second reaction?', why: 'It is added next to the first; either one files a bug (the second only once enough people have added it).' },
          rows.map((r) => r.slack),
        );
        const min = await io.ask({
          id: 'min-reactors',
          text: 'How many people have to add it before it counts? Press Enter for 2.',
          default: '2',
          validate: (a) => (/^[1-9]\d{0,2}$/.test(a) ? undefined : 'Give a whole number of people, 1 or more.'),
        });
        rows.push({ ...extra, minReactors: Number(min) });
        continue;
      }
      if (channels.length === 0) {
        io.say('No channels are confirmed yet, so there is nothing to override. You can set one later with snapwing map set-trigger.');
        continue;
      }
      const channel = await io.choose({
        id: 'channel',
        text: 'Which channel?',
        choices: channels.map((c) => ({ id: c.id, label: `${c.platform === 'teams' ? 'Teams' : 'Slack'} #${c.name}` })),
      });
      const ref = channels.find((c) => c.id === channel);
      const only: readonly Platform[] = ref === undefined ? platforms : platforms.filter((p) => p === ref.platform);
      const picked = await askReaction(ctx, checker, only, {
        id: 'channel-emoji',
        text: `Which reaction files a bug in ${ref === undefined ? 'that channel' : `#${ref.name}`}?`,
        why: 'Sets a <trigger emoji="..."/> row on that channel in the workspace map; in that channel it replaces the workspace reactions.',
      });
      overrides.push({ channel, emoji: [ref?.platform === 'teams' ? picked.teams : picked.slack] });
    }

    const checkedNo = [...checker.unchecked];
    io.say(`Bug reaction: ${rows.map((r) => r.slack).join(', ')}${overrides.length === 0 ? '' : `, with ${overrides.length} channel override${overrides.length === 1 ? '' : 's'}`}.`);
    return {
      status: 'done',
      data: {
        emoji: rows.map(rowJson),
        channelOverrides: overrides.map((o) => ({ channel: o.channel, emoji: o.emoji })),
        platforms,
        ...(checkedNo.length === 0 ? {} : { unchecked: checkedNo }),
      },
    };
  },
};
