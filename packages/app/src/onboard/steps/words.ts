// Onboarding step `words` (main 22.2 step 5, main 4.3 "Vocabulary scan"): the words people use for
// each product, which become the map's vocabulary (`<term>` entries, matched in a report's text by
// the resolution step after channel mapping).
//
// The step reads the last 90 days of the bug channels chosen earlier and the recent tickets of the
// recorded Jira projects (`propose/vocabulary.ts`), and proposes the words that keep coming up near
// bug-shaped phrases, product by product. The installer keeps, moves to another product, rewords, or
// drops each one, and can add their own; only what they keep is saved. A Slack, Teams, or Jira source
// that cannot be read is skipped with a line saying so, and the step goes on with the rest. Each kept
// word is checkpointed, so a step resumed after Ctrl-C keeps what was already confirmed and does not
// propose it again.
//
// Scanned text is untrusted. It is only counted, never sent to a model, and never shapes a question
// beyond the candidate word itself: one or two words of letters and digits, quoted.
//
// Reads (interview state, by step id):
//   surfaces: { surfaces: MapSurface[], channels: MapChannel[] }  the products and which channel is whose
//   slack:    { channels: [{ id, name }] }                         the channels the bot joined
//   jira:     { site, email, projects: string[] }                  the projects bugs go to
//   words:    { vocabulary: MapTerm[] }                            an earlier attempt's words
// Writes: words: { vocabulary: MapTerm[] }. Secrets are read from `.env` and only sent to their service.

import type { MapComponent, MapTerm } from '@snapwing/pipeline/map/types.ts';
import { createSlackWeb } from '../../adapters/slack/web.ts';
import { createGraphTokenSource } from '../../adapters/teams/auth.ts';
import { createTeamsGraph } from '../../adapters/teams/graph.ts';
import { createJiraClient } from '../../jira/client/index.ts';
import type { JsonObject, JsonValue } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import { checkSiteAddress } from '../jira/site.ts';
import {
  componentFor,
  proposeVocabulary,
  scanSources,
  SCAN_DAYS,
  shownName,
  type ProposalSurface,
  type ScanChannel,
  type ScanInput,
  type ScanProject,
  type TermCandidate,
} from '../propose/vocabulary.ts';

export interface WordsStepDeps {
  /** Slack's Web API base; tests point it at a fake. */
  readonly slackBaseUrl?: string;
  /** Microsoft Graph's base; tests point it at a fake. */
  readonly graphBaseUrl?: string;
  /** Microsoft's token host; tests point it at a fake. */
  readonly loginHost?: string;
  /** Waits out a rate limit; injected for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const MAX_TERM_LENGTH = 40;
const TERM_SHAPE = /^[\p{L}\p{N}](?:[\p{L}\p{N} .&'/+-]*[\p{L}\p{N}+])?$/u;
const NONE = /^(?:none|no|nothing|nope|-)$/i;

const WHY_TERM =
  'A word you keep goes in the map: a bug report that uses it is filed under that product without guessing. Words are matched whole, ignoring capitals. Drop anything that is not really a name people use for the product.';

type Obj = { readonly [key: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const list = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? v : []);

interface Product extends ProposalSurface {
  readonly components: readonly MapComponent[];
  /** Its Jira project key. */
  readonly project?: string;
  /** The label as it may be shown. */
  readonly shown: string;
}

interface Channel {
  readonly id: string;
  readonly name: string;
  readonly surface?: string;
  readonly platform: 'slack' | 'teams';
  readonly teamId?: string;
}

function productsOf(data: JsonObject | undefined): Product[] {
  const out: Product[] = [];
  for (const raw of list(data?.['surfaces'])) {
    if (!isObj(raw)) continue;
    const id = str(raw['id']);
    if (id === undefined || out.some((p) => p.id === id)) continue;
    const label = str(raw['label']) ?? id;
    const jira = raw['jira'];
    const project = isObj(jira) ? str(jira['project']) : undefined;
    const components = list(raw['components']).flatMap((c): MapComponent[] => {
      if (!isObj(c)) return [];
      const cid = str(c['id']);
      return cid === undefined ? [] : [{ id: cid, label: str(c['label']) ?? cid }];
    });
    out.push({ id, label, components, shown: shownName(label), ...(project === undefined ? {} : { project: project.toUpperCase() }) });
  }
  return out;
}

/** The surfaces step's channels first (they carry the product), then any other channel the Slack step joined. */
function channelsOf(surfaces: JsonObject | undefined, slack: JsonObject | undefined): Channel[] {
  const out: Channel[] = [];
  for (const raw of list(surfaces?.['channels'])) {
    if (!isObj(raw)) continue;
    const id = str(raw['id']);
    if (id === undefined || out.some((c) => c.id === id)) continue;
    const platform = raw['platform'] === 'teams' ? 'teams' : 'slack';
    const teamId = str(raw['teamId']);
    const surface = str(raw['surface']);
    out.push({
      id,
      name: str(raw['name']) ?? id,
      platform,
      ...(surface === undefined ? {} : { surface }),
      ...(teamId === undefined ? {} : { teamId }),
    });
  }
  for (const raw of list(slack?.['channels'])) {
    if (!isObj(raw)) continue;
    const id = str(raw['id']);
    if (id === undefined || out.some((c) => c.id === id)) continue;
    out.push({ id, name: str(raw['name']) ?? id, platform: 'slack' });
  }
  return out;
}

/** An earlier attempt's words that still point at a confirmed product. */
function savedTerms(data: JsonObject | undefined, products: readonly Product[]): MapTerm[] {
  const out: MapTerm[] = [];
  for (const raw of list(data?.['vocabulary'])) {
    if (!isObj(raw)) continue;
    const text = str(raw['text']);
    const product = products.find((p) => p.id === str(raw['surface']));
    if (text === undefined || product === undefined || !checkTerm(text).ok) continue;
    const component = str(raw['component']);
    const known = component !== undefined && product.components.some((c) => c.id === component);
    out.push({ text, surface: product.id, ...(known ? { component } : {}) });
  }
  return out;
}

/** A word the installer typed, tidied, or why it is refused. */
export function checkTerm(raw: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly refusal: string } {
  const text = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: false, refusal: 'Type a word or a short phrase.' };
  if (text.length > MAX_TERM_LENGTH) return { ok: false, refusal: `Keep each one under ${MAX_TERM_LENGTH} characters: the words people type, not a sentence.` };
  if (!TERM_SHAPE.test(text)) return { ok: false, refusal: "Use letters, numbers, spaces, and . & ' / + - only." };
  return { ok: true, text };
}

/** A comma-separated answer as words, or why one of them is refused. "none" and the like are no words. */
function typedTerms(answer: string): { readonly terms: readonly string[] } | { readonly refusal: string } {
  if (NONE.test(answer.trim())) return { terms: [] };
  const terms: string[] = [];
  for (const piece of answer.split(',').filter((p) => p.trim() !== '')) {
    const checked = checkTerm(piece);
    if (!checked.ok) return { refusal: `"${shownName(piece, 40)}": ${checked.refusal}` };
    terms.push(checked.text);
  }
  return { terms };
}

const termJson = (t: MapTerm): JsonObject => ({ text: t.text, surface: t.surface, ...(t.component === undefined ? {} : { component: t.component }) });

export function createWordsStep(deps: WordsStepDeps = {}): OnboardStep {
  /** What can be read, from the earlier steps' data and `.env`; a source that cannot be is noted. */
  async function sources(ctx: StepContext, products: readonly Product[], channels: readonly Channel[]): Promise<{ input: ScanInput; notes: string[] }> {
    const notes: string[] = [];
    const known = new Set(products.map((p) => p.id));
    const scanChannel = (c: Channel): ScanChannel => ({
      id: c.id,
      name: c.name,
      ...(c.teamId === undefined ? {} : { teamId: c.teamId }),
      surfaces: c.surface !== undefined && known.has(c.surface) ? [c.surface] : [],
    });
    let input: ScanInput = { now: ctx.now(), ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) };

    const slackChannels = channels.filter((c) => c.platform === 'slack');
    if (slackChannels.length > 0) {
      const token = await ctx.readEnv('SLACK_BOT_TOKEN');
      if (token === undefined) notes.push('Slack is not connected yet, so I skipped the Slack channels.');
      else {
        const web = createSlackWeb({ token: token.reveal(), ...(deps.slackBaseUrl === undefined ? {} : { baseUrl: deps.slackBaseUrl }) });
        input = { ...input, slack: { web, channels: slackChannels.map(scanChannel) } };
      }
    }

    const teamsChannels = channels.filter((c) => c.platform === 'teams' && c.teamId !== undefined);
    if (teamsChannels.length > 0) {
      const [appId, password, tenantId] = await Promise.all(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID'].map((n) => ctx.readEnv(n)));
      if (appId === undefined || password === undefined || tenantId === undefined) {
        notes.push('Teams is not connected yet, so I skipped the Teams channels.');
      } else {
        const tokens = createGraphTokenSource({
          appId: appId.reveal(),
          password: password.reveal(),
          tenantId: tenantId.reveal(),
          ...(deps.loginHost === undefined ? {} : { loginHost: deps.loginHost }),
        });
        const graph = createTeamsGraph({ token: () => tokens.token(), maxPages: 20, ...(deps.graphBaseUrl === undefined ? {} : { baseUrl: deps.graphBaseUrl }) });
        input = { ...input, teams: { graph, channels: teamsChannels.map(scanChannel) } };
      }
    }

    const jira = ctx.data('jira');
    const keys = [...new Set(list(jira?.['projects']).flatMap((k) => (typeof k === 'string' && k !== '' ? [k.toUpperCase()] : [])))];
    if (keys.length > 0) {
      const site = checkSiteAddress(str(jira?.['site']) ?? '');
      const email = str(jira?.['email']);
      const token = await ctx.readEnv('JIRA_API_TOKEN');
      if (!site.ok || email === undefined || token === undefined) notes.push('Jira is not connected, so I skipped the tickets.');
      else {
        const client = createJiraClient({ baseUrl: site.baseUrl, email, apiToken: token.reveal() });
        const projects: ScanProject[] = keys.map((key) => ({ key, surfaces: products.filter((p) => p.project === key).map((p) => p.id) }));
        input = { ...input, jira: { client, projects } };
      }
    }
    return { input, notes };
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const surfacesData = ctx.data('surfaces');
    const products = productsOf(surfacesData);
    if (products.length === 0) {
      return {
        status: 'blocked',
        on: 'you, confirming your products first',
        reason: 'there are no confirmed products to attach words to yet; confirm them with `snapwing onboard --step surfaces`, then run `snapwing onboard` again',
      };
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    const where = (surface: string, component?: string): string => {
      const p = byId.get(surface);
      const c = component === undefined ? undefined : p?.components.find((x) => x.id === component);
      return `${p?.shown ?? surface}${c === undefined ? '' : ` (${shownName(c.label)})`}`;
    };

    // ---- what an earlier attempt kept -------------------------------------------------------------
    let vocabulary: MapTerm[] = savedTerms(ctx.data('words'), products);
    if (vocabulary.length > 0) {
      const shown = vocabulary.slice(0, 10).map((t) => `"${t.text}" (${where(t.surface, t.component)})`);
      io.say(`You already kept these words: ${shown.join(', ')}${vocabulary.length > 10 ? `, and ${vocabulary.length - 10} more` : ''}.`);
      const keep = await io.choose({
        id: 'saved',
        text: 'Keep them and look for more?',
        choices: [
          { id: 'keep', label: 'Yes, keep them' },
          { id: 'over', label: 'No, start the words over' },
        ],
        default: 'keep',
        why: 'Kept words are not suggested again. Starting over forgets them and suggests from scratch.',
      });
      if (keep === 'over') vocabulary = [];
      await ctx.progress({ vocabulary: vocabulary.map(termJson) });
    }

    /** Adds a word unless one with the same text is already kept; saves it at once. */
    const add = async (term: MapTerm): Promise<void> => {
      const same = vocabulary.find((t) => t.text.toLowerCase() === term.text.toLowerCase());
      if (same !== undefined) {
        if (same.surface !== term.surface) io.say(`"${same.text}" is already a word for ${where(same.surface, same.component)}, so I left it there.`);
        return;
      }
      vocabulary = [...vocabulary, term];
      await ctx.progress({ vocabulary: vocabulary.map(termJson) });
    };
    const termFor = (text: string, surface: string): MapTerm => {
      const component = componentFor(byId.get(surface), text);
      return { text, surface, ...(component === undefined ? {} : { component }) };
    };

    // ---- the scan --------------------------------------------------------------------------------------
    io.say(`Now the words people use for your products. I will read the last ${SCAN_DAYS} days of your bug channels and Jira tickets and suggest the words that keep coming up; you decide which to keep.`);
    const { input, notes } = await sources(ctx, products, channelsOf(surfacesData, ctx.data('slack')));
    const scan = await scanSources(input);
    for (const note of [...notes, ...scan.notes]) io.say(note);
    const candidates = proposeVocabulary(scan.texts, products, { exclude: vocabulary.map((t) => t.text) });
    if (scan.messages + scan.tickets === 0) io.say('There was nothing to read, so I have no suggestions. You can still tell me the words people use.');
    else io.say(`I read ${scan.messages} message${scan.messages === 1 ? '' : 's'} and ${scan.tickets} Jira ticket${scan.tickets === 1 ? '' : 's'}.`);

    const evidence = (c: TermCandidate): string =>
      `"${c.text}" came up in ${c.mentions} bug reports (${c.sources.join(', ')}), for example: "${c.example}"`;

    /** One proposed word for `product`: keep, move, reword, or drop. */
    const review = async (c: TermCandidate, product: Product): Promise<void> => {
      io.say(evidence(c));
      const answer = await io.choose({
        id: 'term',
        text: `Do people mean ${product.shown} when they say "${c.text}"?`,
        choices: [
          { id: 'keep', label: `Yes, keep it for ${where(product.id, c.component)}` },
          ...(products.length > 1 ? [{ id: 'move', label: 'Yes, but it means another product' }] : []),
          { id: 'edit', label: 'Yes, but let me change how it is written' },
          { id: 'drop', label: 'No, drop it' },
        ],
        default: 'keep',
        why: WHY_TERM,
      });
      if (answer === 'drop') return;
      if (answer === 'keep') return add({ text: c.text, surface: product.id, ...(c.component === undefined ? {} : { component: c.component }) });
      if (answer === 'move') {
        const others = products.filter((p) => p.id !== product.id);
        const moved = await io.choose({
          id: 'term-product',
          text: `Which product do people mean by "${c.text}"?`,
          choices: others.map((p) => ({ id: `product:${p.id}`, label: p.shown })),
          why: WHY_TERM,
        });
        const target = moved.slice('product:'.length);
        return add(termFor(c.text, target));
      }
      const text = await io.ask({
        id: 'term-text',
        text: `How do people write it? Press Enter for "${c.text}".`,
        default: c.text,
        why: 'Write it the way people type it in a bug report. Capitals do not matter.',
        validate: (a) => {
          const checked = checkTerm(a);
          return checked.ok ? undefined : checked.refusal;
        },
      });
      const checked = checkTerm(text);
      if (checked.ok) await add(termFor(checked.text, product.id));
    };

    // ---- product by product -------------------------------------------------------------------------
    for (const product of products) {
      const mine = candidates.filter((c) => c.surface === product.id);
      if (mine.length > 0) {
        io.say(`For ${product.shown}, these words keep coming up in bug reports:`);
        for (const c of mine) await review(c, product);
      } else if (scan.messages + scan.tickets > 0) {
        io.say(`I found no words that keep coming up for ${product.shown}.`);
      }
      const more = await io.ask({
        id: 'more',
        text: `Any other words people use for ${product.shown}? Type them separated by commas, or press Enter for none.`,
        default: 'none',
        why: 'A nickname, an old name, or how people refer to it in a sentence. Each one goes in the map for this product.',
        validate: (a) => {
          const typed = typedTerms(a);
          return 'refusal' in typed ? typed.refusal : undefined;
        },
      });
      const typed = typedTerms(more);
      for (const text of 'terms' in typed ? typed.terms : []) await add(termFor(text, product.id));
    }

    // ---- words from channels tied to no one product --------------------------------------------
    const unplaced = candidates.filter((c) => c.surface === undefined);
    if (unplaced.length > 0) io.say('These words keep coming up in channels that are not tied to one product:');
    for (const c of unplaced) {
      io.say(evidence(c));
      const placed = await io.choose({
        id: 'place',
        text: `Which product do people mean by "${c.text}"?`,
        choices: [...products.map((p) => ({ id: `product:${p.id}`, label: p.shown })), { id: 'drop', label: 'None of them; drop it' }],
        default: 'drop',
        why: WHY_TERM,
      });
      if (placed !== 'drop') await add(termFor(c.text, placed.slice('product:'.length)));
    }

    io.say(
      vocabulary.length === 0
        ? 'No words kept. Bug reports will be filed by their channel and the other signals.'
        : `Kept ${vocabulary.length} word${vocabulary.length === 1 ? '' : 's'} for the map.`,
    );
    return { status: 'done', data: { vocabulary: vocabulary.map(termJson) } };
  }

  return { id: 'words', number: 5, title: 'Learn the words people use', needs: ['surfaces'], run };
}

export const wordsStep: OnboardStep = createWordsStep();
