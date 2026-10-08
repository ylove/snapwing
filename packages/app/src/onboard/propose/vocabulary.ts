// The vocabulary scan behind the onboarding words step (main 4.3 and 22.2): the words people already
// use for each product, proposed from what they write. `scanSources` samples the last 90 days of the
// bug channels (Slack history; Teams through Graph when the app may read them, else skipped with a
// note) and the recent tickets of the recorded Jira projects. `proposeVocabulary` keeps the sentences
// within two of a bug-shaped phrase ("broken", "not working", "can't", "error"; a ticket summary is a
// bug report as a whole), counts the recurring nouns there, folds the variants of one word into one
// candidate ("markets" and "market's" are "market"; "site" said almost always as "the site" is "the
// site"), gives each to the product most of its mentions came from, and returns the top candidates
// per product. The installer confirms, reassigns, or drops every one (`steps/words.ts`).
//
// Deterministic, with no model call: a word that names a product keeps coming back in its bug
// reports, so counting finds it, and the installer judges every candidate anyway. Resolution matches
// a term as a whole word or phrase, ignoring case (`containsTerm`), so a candidate is exactly the
// words people type.
//
// Everything read here is untrusted: a message can say anything, instructions included. Scanned text
// is only ever counted; it never reaches a model, a question id, a choice, or the flow. What leaves
// this module is a candidate of at most two lowercase words of letters and digits, its counts, the
// source labels the step already had, and an example rebuilt from the same words. No markup, link,
// control character, or sentence of instructions survives that.
//
// Volume is capped: 10 pages of 200 per Slack channel, 5000 messages in all, 2000 characters a
// message, 300 tickets. Thread replies are not read, only the messages in the channel itself.

import type { MapComponent, MapSurface } from '@snapwing/pipeline/map/types.ts';
import { SlackApiError, SlackRateLimitError, type HistoryArgs, type MessagesPage, type SlackMessage, type SlackWeb } from '../../adapters/slack/web.ts';
import { TeamsAuthError } from '../../adapters/teams/auth.ts';
import { GraphAuthError, GraphPermissionError, type GraphMessage, type TeamsGraph } from '../../adapters/teams/graph.ts';
import { teamsHtmlToText } from '../../adapters/teams/normalize.ts';
import { JiraAuthError, type JiraClient } from '../../jira/client/index.ts';

export const SCAN_DAYS = 90;

export const SCAN_LIMITS = Object.freeze({
  /** Messages per Slack history page. */
  pageSize: 200,
  pagesPerChannel: 10,
  /** Messages kept across every channel. */
  messages: 5000,
  /** Characters kept of one message or summary. */
  textChars: 2000,
  tickets: 300,
  /** Candidates proposed per product, and for the channels tied to none. */
  perSurface: 5,
  /** A candidate comes up in at least this many messages... */
  minMentions: 3,
  /** ...from at least this many people (a ticket counts as its own voice). */
  minSpeakers: 2,
  /** The product it goes to holds at least this share of its mentions, else it is too ambiguous to propose. */
  surfaceShare: 2 / 3,
  /** Said after "the" at least this often, it is proposed with "the" ("the site"). */
  theShare: 0.75,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_TRIES = 3;
const MAX_WAIT_MS = 30_000;

// ---- what goes in and out ----------------------------------------------------------------------

/** One piece of scanned text. `text` is untrusted and never leaves this module. */
export interface ScanText {
  readonly text: string;
  /** Where it came from, as the step already names it: "#web-bugs", "Jira WEB". */
  readonly source: string;
  /** The products it is evidence for: its channel's, or its Jira project's; empty when unknown. */
  readonly surfaces: readonly string[];
  /** Who wrote it (a chat user id; a ticket key for a summary), so one person repeating a word counts once. */
  readonly speaker: string;
  /** A ticket summary is a bug report as a whole; a chat message counts only near a bug-shaped phrase. */
  readonly bugReport?: boolean;
}

export interface ScanChannel {
  readonly id: string;
  readonly name: string;
  /** The Teams team's group id; set for a Teams channel. */
  readonly teamId?: string;
  /** The products this channel's messages are evidence for. */
  readonly surfaces: readonly string[];
}

export interface ScanProject {
  readonly key: string;
  readonly surfaces: readonly string[];
}

export interface ScanInput {
  readonly now: Date;
  readonly slack?: { readonly web: Pick<SlackWeb, 'conversationsHistory'>; readonly channels: readonly ScanChannel[] };
  readonly teams?: { readonly graph: Pick<TeamsGraph, 'channelMessages'>; readonly channels: readonly ScanChannel[] };
  readonly jira?: { readonly client: Pick<JiraClient, 'searchJql'>; readonly projects: readonly ScanProject[] };
  /** Waits out a Slack rate limit; injected for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ScanResult {
  readonly texts: readonly ScanText[];
  /** Plain-language lines for the installer: a channel skipped, an empty channel, a partial read. */
  readonly notes: readonly string[];
  /** Chat messages kept. */
  readonly messages: number;
  readonly tickets: number;
}

/** A product as the proposal needs it. */
export type ProposalSurface = Pick<MapSurface, 'id' | 'label'> & { readonly components?: readonly MapComponent[] };

export interface TermCandidate {
  /** One or two lowercase words of letters and digits: "market", "the site". */
  readonly text: string;
  /** The product most of its mentions came from; undefined when its sources name none. */
  readonly surface?: string;
  /** Set when the word is that product's component's own name. */
  readonly component?: string;
  /** Messages and tickets it came up in. */
  readonly mentions: number;
  readonly speakers: number;
  /** Up to three source labels, most mentions first. */
  readonly sources: readonly string[];
  /** A few words around one mention, rebuilt from the same sanitized words. */
  readonly example: string;
}

export interface ProposeOptions {
  /** Words already confirmed; never proposed again. */
  readonly exclude?: readonly string[];
}

// ---- reading ------------------------------------------------------------------------------------

/** A channel or project name as it may be shown: printable, one line, short. */
export function shownName(raw: string, max = 60): string {
  const text = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const slackTs = (at: Date): string => (at.getTime() / 1000).toFixed(6);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A human's message in the channel itself: no bots, joins, or other system subtypes. */
function slackText(m: SlackMessage): { text: string; speaker: string } | undefined {
  if (m.bot_id !== undefined || m.user === undefined || m.user === '') return undefined;
  if (m.subtype !== undefined && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') return undefined;
  if (typeof m.text !== 'string' || m.text.trim() === '') return undefined;
  return { text: m.text.slice(0, SCAN_LIMITS.textChars), speaker: m.user };
}

function teamsText(m: GraphMessage, oldest: number): { text: string; speaker: string } | undefined {
  if ((m.messageType ?? 'message') !== 'message' || (m.deletedDateTime ?? null) !== null) return undefined;
  const speaker = m.from?.user?.id;
  if (speaker === undefined || speaker === '' || m.from?.application !== undefined) return undefined;
  const created = Date.parse(m.createdDateTime);
  if (!Number.isFinite(created) || created < oldest) return undefined;
  const body = m.body;
  if (body === undefined || typeof body.content !== 'string') return undefined;
  const raw = body.content.slice(0, SCAN_LIMITS.textChars * 4);
  const text = (body.contentType === 'html' ? teamsHtmlToText(raw) : raw).slice(0, SCAN_LIMITS.textChars);
  return text.trim() === '' ? undefined : { text, speaker };
}

async function slackPage(web: Pick<SlackWeb, 'conversationsHistory'>, args: HistoryArgs, sleep: (ms: number) => Promise<void>): Promise<MessagesPage> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await web.conversationsHistory(args);
    } catch (e) {
      if (!(e instanceof SlackRateLimitError) || attempt >= RATE_LIMIT_TRIES) throw e;
      await sleep(Math.min(e.retryAfterMs, MAX_WAIT_MS));
    }
  }
}

function slackSkipNote(label: string, e: unknown): string {
  const code = e instanceof SlackApiError ? e.error : '';
  if (code === 'not_in_channel') return `I am not in ${label}, so I skipped it. Invite Snapwing there and run this step again to include it.`;
  if (code === 'channel_not_found') return `Slack no longer finds ${label}, so I skipped it.`;
  if (e instanceof SlackRateLimitError) return `Slack asked me to slow down, so I skipped ${label}.`;
  return `I could not read ${label} just now, so I skipped it.`;
}

function teamsSkipNote(label: string, e: unknown): string {
  if (e instanceof GraphPermissionError) {
    return `Teams has not let Snapwing read ${label} yet (a team owner grants that when the app is added to the team), so I skipped it.`;
  }
  if (e instanceof TeamsAuthError || e instanceof GraphAuthError) return `Teams did not accept the app's credentials, so I skipped ${label}.`;
  return `I could not read ${label} in Teams just now, so I skipped it.`;
}

const emptyNote = (label: string): string => `${label} had no messages from people in the last ${SCAN_DAYS} days, so there was nothing to learn from it.`;

/** Jira project keys are letters, digits, and underscores; anything else stays out of the JQL. */
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** What has been read so far, within the caps. */
class Collected {
  readonly texts: ScanText[] = [];
  readonly notes: string[] = [];
  messages = 0;
  tickets = 0;
  capped = false;

  get room(): number {
    return SCAN_LIMITS.messages - this.messages;
  }

  message(channel: ScanChannel, label: string, one: { readonly text: string; readonly speaker: string }): void {
    this.texts.push({ text: one.text, source: label, surfaces: channel.surfaces, speaker: one.speaker });
    this.messages += 1;
  }
}

async function readSlack(
  out: Collected,
  web: Pick<SlackWeb, 'conversationsHistory'>,
  channel: ScanChannel,
  oldest: Date,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const label = `#${shownName(channel.name)}`;
  let kept = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SCAN_LIMITS.pagesPerChannel && out.room > 0; page++) {
    let result: MessagesPage;
    try {
      const args: HistoryArgs = { channel: channel.id, oldest: slackTs(oldest), limit: SCAN_LIMITS.pageSize, ...(cursor === undefined ? {} : { cursor }) };
      result = await slackPage(web, args, sleep);
    } catch (e) {
      out.notes.push(kept > 0 ? `I read only part of ${label}; Slack stopped answering partway.` : slackSkipNote(label, e));
      return;
    }
    for (const m of result.messages) {
      const one = slackText(m);
      if (one === undefined) continue;
      if (out.room <= 0) break;
      out.message(channel, label, one);
      kept += 1;
    }
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  if (kept === 0) out.notes.push(emptyNote(label));
}

async function readTeams(out: Collected, graph: Pick<TeamsGraph, 'channelMessages'>, channel: ScanChannel, oldest: Date): Promise<void> {
  const label = shownName(channel.name);
  if (channel.teamId === undefined) return;
  let raw: GraphMessage[];
  try {
    raw = await graph.channelMessages(channel.teamId, channel.id, { top: 50, since: oldest.toISOString() });
  } catch (e) {
    out.notes.push(teamsSkipNote(label, e));
    return;
  }
  let kept = 0;
  for (const m of raw) {
    const one = teamsText(m, oldest.getTime());
    if (one === undefined) continue;
    if (out.room <= 0) break;
    out.message(channel, label, one);
    kept += 1;
  }
  if (kept === 0) out.notes.push(emptyNote(label));
}

async function readJira(out: Collected, client: Pick<JiraClient, 'searchJql'>, projects: readonly ScanProject[]): Promise<void> {
  const usable = projects.filter((p) => PROJECT_KEY.test(p.key));
  if (usable.length === 0) return;
  const byKey = new Map(usable.map((p) => [p.key, p]));
  const jql = `project in (${usable.map((p) => `"${p.key}"`).join(', ')}) AND created >= -${SCAN_DAYS}d ORDER BY created DESC`;
  let token: string | undefined;
  try {
    while (out.tickets < SCAN_LIMITS.tickets) {
      const page = await client.searchJql(jql, {
        maxResults: Math.min(100, SCAN_LIMITS.tickets - out.tickets),
        fields: ['summary'],
        ...(token === undefined ? {} : { nextPageToken: token }),
      });
      for (const issue of page.issues) {
        if (out.tickets >= SCAN_LIMITS.tickets) break;
        const summary = issue.fields['summary'];
        const project = byKey.get(issue.key.split('-')[0] ?? '');
        if (typeof summary !== 'string' || summary.trim() === '' || project === undefined) continue;
        out.texts.push({ text: summary.slice(0, SCAN_LIMITS.textChars), source: `Jira ${project.key}`, surfaces: project.surfaces, speaker: issue.key, bugReport: true });
        out.tickets += 1;
      }
      if (page.isLast !== false || page.nextPageToken === undefined || page.nextPageToken === '') break;
      token = page.nextPageToken;
    }
  } catch (e) {
    out.notes.push(
      e instanceof JiraAuthError
        ? 'Jira refused the saved login, so I skipped the tickets.'
        : `I could not read the Jira tickets just now, so I skipped ${out.tickets > 0 ? 'the rest of them' : 'them'}.`,
    );
  }
}

/** Reads the sources (see the file header). A source that fails is noted and the rest are read. */
export async function scanSources(input: ScanInput): Promise<ScanResult> {
  const sleep = input.sleep ?? defaultSleep;
  const oldest = new Date(input.now.getTime() - SCAN_DAYS * DAY_MS);
  const out = new Collected();
  for (const channel of input.slack?.channels ?? []) {
    if (out.room <= 0) out.capped = true;
    else if (input.slack !== undefined) await readSlack(out, input.slack.web, channel, oldest, sleep);
  }
  for (const channel of input.teams?.channels ?? []) {
    if (out.room <= 0) out.capped = true;
    else if (input.teams !== undefined) await readTeams(out, input.teams.graph, channel, oldest);
  }
  if (out.capped) out.notes.push(`I stopped at ${SCAN_LIMITS.messages} messages; that is plenty to find the common words.`);
  if (input.jira !== undefined) await readJira(out, input.jira.client, input.jira.projects);
  return { texts: out.texts, notes: out.notes, messages: out.messages, tickets: out.tickets };
}

// ---- words ----------------------------------------------------------------------------------------

interface Word {
  /** Lowercase, apostrophes kept: what the example shows. */
  readonly shown: string;
  /** Lowercase, apostrophes and a possessive "'s" dropped: what is counted. */
  readonly norm: string;
}

/** Strips chat markup, code, links, addresses, emoji codes, and control characters. */
export function plainText(raw: string): string {
  return raw
    .slice(0, SCAN_LIMITS.textChars)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^<>\n]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#\d+);/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/(?<!\S)\S*@\S*/g, ' ')
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    .replace(/(?![\n\t])\p{Cc}/gu, ' ')
    .replace(/[\u2018\u2019\u02bc]/g, "'");
}

function wordsOf(sentence: string): Word[] {
  const out: Word[] = [];
  for (const m of sentence.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)) {
    const shown = m[0].toLowerCase();
    out.push({ shown, norm: shown.replace(/'s$/, '').replaceAll("'", '') });
  }
  return out;
}

function sentencesOf(text: string): Word[][] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(wordsOf)
    .filter((w) => w.length > 0);
}

/** "pages" and "page", "searches" and "search", "categories" and "category" are one word. */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:x|ch|sh|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is|os)$/.test(word)) return word.slice(0, -1);
  return word;
}

const BUG_PHRASES: readonly (readonly string[])[] = [
  'broken', 'broke', 'not working', 'isnt working', 'stopped working', 'doesnt work', 'does not work', 'didnt work', 'not work',
  'cant', 'cannot', 'can not', 'couldnt', 'unable', 'wont', 'error', 'errors', 'fail', 'fails', 'failed', 'failing', 'failure',
  'crash', 'crashes', 'crashed', 'crashing', 'bug', 'bugs', 'not loading', 'blank', 'stuck', 'wrong', 'missing', 'timed out',
  'timeout', 'glitch', 'is down', 'went down', '404', '500',
].map((p) => p.split(' '));

function hasBugPhrase(words: readonly Word[]): boolean {
  const norms = words.map((w) => w.norm);
  return BUG_PHRASES.some((phrase) => {
    for (let i = 0; i + phrase.length <= norms.length; i++) {
      if (phrase.every((t, j) => norms[i + j] === t)) return true;
    }
    return false;
  });
}

/**
 * Words that never name a product: function words, contractions (apostrophes dropped), common verbs,
 * time words and chat filler, and nouns too generic to route by (bug words, people, page parts, tools).
 */
const STOP = new Set(
  `a about above across after again against ago all almost along already also although always am among an and another any
  anybody anyhow anyone anything anyway anywhere are around as at away back be became because become been before behind being
  below beside besides between beyond both but by can could did do does doing done down during each either else enough etc even
  ever every everybody everyone everything everywhere except few for from further had has have having he hence her here hers
  herself him himself his how however i if in inside instead into is it its itself just least less lot lots many may maybe me
  might mine more most mostly much must my myself near nearly neither never next no nobody none nor not nothing now nowhere of
  off often on once one only onto or other others otherwise our ours ourselves out outside over own per perhaps quite rather
  really same several shall she should since so some somebody somehow someone something sometime sometimes somewhere soon still
  such than that the their theirs them themselves then there therefore these they this those though through throughout thus till
  to together too toward towards under unless until up upon very via was way we well were what whatever when whenever where
  wherever whether which while who whoever whole whom whose why will with within without would yet you your yours yourself
  yourselves two three four five ten hundred
  im ive ill id youre youve youll youd hes shes weve wed theyre theyve theyll theyd isnt arent wasnt werent dont doesnt didnt
  cant couldnt wont wouldnt shouldnt hasnt havent hadnt mustnt thats theres heres whats whos lets aint gonna wanna gotta cannot
  get gets got gotten getting go goes going went gone make makes made making see sees seen saw seeing look looks looked looking
  try tries tried trying use uses used using click clicks clicked clicking open opens opened opening load loads loaded loading
  work works worked working show shows showed shown showing happen happens happened happening know knows knew known think thinks
  thought seem seems seemed need needs needed want wants wanted say says said tell tells told take takes took taken come comes
  came coming keep keeps kept give gives gave given find finds found put puts let fix fixes fixed fixing check checks checked
  checking help helps helped start starts started stop stops stopped refresh refreshed reload reloaded log logs logged hit hits
  press pressed tap tapped type typed typing report reported submit submitted send sends sent sending wait waiting waited mean
  means meant guess feel felt ask asked asking hear heard call called move moved change changed changes run runs ran running
  break breaks broke happen sign signed
  new old good bad great nice cool fine okay ok sure able unable possible weird strange odd random right left big small little
  long short high low full empty first last latest early late today tonight yesterday tomorrow morning afternoon evening night
  week weekend month year day hour minute second time moment recently currently suddenly actually basically literally definitely
  probably anymore yes yeah yep yup nope nah hey hi hello thanks thank thx please pls plz sorry lol haha fyi asap btw imo idk
  np cc ty ping
  bug error issue problem broken fail failed failing failure crash crashed crashing stuck blank wrong missing glitch glitchy
  timeout down outage incident thing stuff people person user customer client team guy folk page screen button link tab field
  form window popup modal message text email notification version update release deploy deployment build data info information
  question idea reason part side end top bottom browser chrome safari firefox edge phone computer laptop support ticket jira
  slack teams snapwing channel thread screenshot video image picture attachment`.split(/\s+/).filter((w) => w !== ''),
);

/** Whether a counted word could be a product's name: not a stop word, not a verb form of one, a sane shape. */
function isCandidate(norm: string): boolean {
  if (!/^\p{L}[\p{L}\p{N}]{2,23}$/u.test(norm)) return false;
  if ((norm.match(/\p{N}/gu) ?? []).length > 2) return false;
  if (STOP.has(norm) || STOP.has(singular(norm))) return false;
  const bases: string[] = [];
  if (norm.endsWith('ing')) bases.push(norm.slice(0, -3), `${norm.slice(0, -3)}e`);
  if (norm.endsWith('ed')) bases.push(norm.slice(0, -2), norm.slice(0, -1));
  for (const base of [...bases]) if (base.length > 2 && base.at(-1) === base.at(-2)) bases.push(base.slice(0, -1));
  return !bases.some((b) => STOP.has(b));
}

/** Up to four words either side of `at`, each at most 24 characters. */
function exampleAround(words: readonly Word[], at: number): string {
  const start = Math.max(0, at - 4);
  const end = Math.min(words.length, at + 5);
  const body = words
    .slice(start, end)
    .map((w) => (w.shown.length > 24 ? w.shown.slice(0, 24) : w.shown))
    .join(' ');
  return `${start > 0 ? '... ' : ''}${body}${end < words.length ? ' ...' : ''}`;
}

// ---- the proposal -------------------------------------------------------------------------------

interface Cluster {
  readonly forms: Map<string, number>;
  /** Messages where every mention followed "the". */
  the: number;
  mentions: number;
  readonly speakers: Set<string>;
  readonly bySurface: Map<string, number>;
  readonly sources: Map<string, number>;
  example: string;
}

/** The keys a confirmed word covers: itself, and the folded word of "x" or "the x". */
function coveredKeys(text: string): string[] {
  const lower = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const parts = lower.split(' ');
  if (parts.length === 1) return [lower, singular(lower)];
  if (parts.length === 2 && parts[0] === 'the' && parts[1] !== undefined) return [lower, singular(parts[1])];
  return [lower];
}

/** Code-unit order, the same on every machine (unlike `localeCompare`). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byCount = (m: ReadonlyMap<string, number>): string[] => [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k]) => k);

/** The component of `surface` whose id or label is this word, if any. */
export function componentFor(surface: ProposalSurface | undefined, text: string): string | undefined {
  if (surface === undefined) return undefined;
  const keys = new Set(coveredKeys(text));
  const found = (surface.components ?? []).find((c) => [c.id, c.label].some((name) => coveredKeys(name).some((k) => keys.has(k))));
  return found?.id;
}

/**
 * The candidates (see the file header), by product in the order given, then those whose sources name
 * no product. Deterministic: the same texts give the same candidates in the same order.
 */
export function proposeVocabulary(texts: readonly ScanText[], surfaces: readonly ProposalSurface[], options: ProposeOptions = {}): TermCandidate[] {
  const clusters = new Map<string, Cluster>();
  for (const item of texts) {
    const sentences = sentencesOf(plainText(item.text));
    const bugAt = sentences.flatMap((s, i) => (hasBugPhrase(s) ? [i] : []));
    const near = item.bugReport === true ? sentences.map((_, i) => i) : sentences.flatMap((_, i) => (bugAt.some((j) => Math.abs(i - j) <= 2) ? [i] : []));
    const seen = new Map<string, { form: string; the: boolean; bare: boolean; example: string }>();
    for (const i of near) {
      const words = sentences[i] ?? [];
      words.forEach((w, k) => {
        if (!isCandidate(w.norm)) return;
        const key = singular(w.norm);
        const afterThe = words[k - 1]?.norm === 'the';
        const entry = seen.get(key) ?? { form: w.norm, the: false, bare: false, example: exampleAround(words, k) };
        if (afterThe) entry.the = true;
        else entry.bare = true;
        seen.set(key, entry);
      });
    }
    for (const [key, entry] of seen) {
      let c = clusters.get(key);
      if (c === undefined) {
        c = { forms: new Map(), the: 0, mentions: 0, speakers: new Set(), bySurface: new Map(), sources: new Map(), example: entry.example };
        clusters.set(key, c);
      }
      c.forms.set(entry.form, (c.forms.get(entry.form) ?? 0) + 1);
      if (entry.the && !entry.bare) c.the += 1;
      c.mentions += 1;
      c.speakers.add(item.speaker);
      for (const s of new Set(item.surfaces)) c.bySurface.set(s, (c.bySurface.get(s) ?? 0) + 1);
      c.sources.set(item.source, (c.sources.get(item.source) ?? 0) + 1);
    }
  }

  const known = new Set(surfaces.map((s) => s.id));
  const excluded = new Set((options.exclude ?? []).flatMap(coveredKeys));
  const all: TermCandidate[] = [];
  for (const [key, c] of clusters) {
    if (c.mentions < SCAN_LIMITS.minMentions || c.speakers.size < SCAN_LIMITS.minSpeakers) continue;
    const form = byCount(c.forms)[0] ?? key;
    const text = c.the / c.mentions >= SCAN_LIMITS.theShare ? `the ${form}` : form;
    if (excluded.has(key) || excluded.has(text)) continue;
    const counts = new Map([...c.bySurface].filter(([s]) => known.has(s)));
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    let surface: string | undefined;
    if (total === 0) surface = surfaces.length === 1 ? surfaces[0]?.id : undefined;
    else {
      const top = byCount(counts)[0];
      if (top === undefined || (counts.get(top) ?? 0) / total < SCAN_LIMITS.surfaceShare) continue; // said for several products alike
      surface = top;
    }
    const component = componentFor(surfaces.find((s) => s.id === surface), text);
    all.push({
      text,
      ...(surface === undefined ? {} : { surface }),
      ...(component === undefined ? {} : { component }),
      mentions: c.mentions,
      speakers: c.speakers.size,
      sources: byCount(c.sources).slice(0, 3),
      example: c.example,
    });
  }
  all.sort((a, b) => b.mentions - a.mentions || b.speakers - a.speakers || cmp(a.text, b.text));
  return [...surfaces.map((s) => s.id), undefined].flatMap((id) => all.filter((c) => c.surface === id).slice(0, SCAN_LIMITS.perSurface));
}
