// The draft behind the onboarding step `surfaces` (main 4.3 "Auto-propose", main 22.2): which
// products there are and which product each bug channel is about. One product per repository the
// GitHub App can fix; each takes the chosen Jira project whose key or name matches the repository's
// name (a project nobody matched goes to a repository nobody matched, as a guess the installer is
// told about); each channel takes the product its name names (`web-bugs` to the website), an alerts
// channel takes its product from each alert, and a channel no name matches goes to the fallback
// product. The installer confirms or edits the draft in the step; nothing here writes anything.
//
// Names read from Slack, Teams, Jira, and GitHub are untrusted: whoever names a channel, a project,
// a component, or a repository chooses that text. `cleanText` makes such a name safe to show in a
// question and to keep: no control or format characters (terminal escapes, bidirectional overrides,
// zero-width marks), no angle brackets (chat and HTML markup), whitespace collapsed, and a length
// cap. Ids are checked against a narrow pattern and dropped when they do not fit.
//
// What this step keeps (the step's data, read by the later steps and by the map writer), all in
// the map's own shapes (`@snapwing/pipeline/map/types.ts`):
//   org              the map's org: the owner most of the surfaces' repositories belong to
//   surfaces         MapSurface[]: id, label, repo (`github.com/owner/name`), jira, components
//   channels         MapChannel[]: id, name, surface (an id or `from-payload`), confidence,
//                    platform and teamId for Teams, no trigger overrides
//   fallbackSurface  the surface id whose Jira project takes reports that fit no product
//   skippedRepos     `owner/name` of repositories the installer left out or merged away
//   skippedChannels  ids of channels the installer left out
//
// What it reads from earlier steps:
//   jira.projects    string[]: the chosen project keys (step `jira`); jira.site and jira.email
//                    with JIRA_API_TOKEN from `.env` are the login it reads them with
//   github.repos     string[] of `owner/name` (or objects with a string `fullName`): the
//                    repositories the GitHub App can fix (step `github`)
//   slack.channels   { id, name }[]: the bug channels chosen in Slack (step `slack`)
//   teams.channels   { id, name, teamId }[]: the bug channels chosen in Teams (step `teams`)

import { FROM_PAYLOAD, type ChannelConfidence, type ChannelPlatform, type MapChannel, type MapComponent, type MapSurface } from '@snapwing/pipeline/map/types.ts';
import { repoFullName } from '@snapwing/pipeline/util/repo.ts';
import { createJiraClient, type JiraClient } from '../../jira/client/index.ts';
import type { JsonObject, JsonValue } from '../interview/state.ts';
import type { StepContext } from '../interview/step.ts';
import { checkSiteAddress } from '../jira/site.ts';

/** The issue type a surface's tickets are filed as. */
export const DEFAULT_ISSUE_TYPE = 'Bug';

/** The longest name kept or shown, in characters. */
export const NAME_MAX = 80;

/** At most this many components are read from one Jira project. */
const MAX_COMPONENTS = 50;

// Control, format, surrogate, private-use, and line or paragraph separator characters, and angle brackets.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}<>]+/gu;

/**
 * Untrusted text made safe to show in a question and to keep (see the file header). Not a string, or
 * nothing left, is ''.
 */
export function cleanText(raw: unknown, max = NAME_MAX): string {
  if (typeof raw !== 'string') return '';
  const text = raw.normalize('NFC').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 3)).join('').trimEnd()}...`;
}

/** A chat channel, team, or Jira account id: no spaces, no markup. */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:@._-]{0,199}$/;

/** Whether `raw` is an id that fits `OPAQUE_ID`. */
export function isOpaqueId(raw: unknown): raw is string {
  return typeof raw === 'string' && OPAQUE_ID.test(raw);
}

/** An email address, lowercased, or undefined when `raw` is not one. */
export function cleanEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) ? email : undefined;
}

/** A lowercase slug that fits the map's id pattern, or '' when nothing is left. */
export function slugOf(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** A slug of `base` that is not in `taken` (`web`, then `web-2`, ...). */
export function uniqueId(base: string, taken: ReadonlySet<string>, fallback = 'product'): string {
  const root = slugOf(base) || fallback;
  if (!taken.has(root)) return root;
  for (let i = 2; ; i += 1) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
}

/** Lowercase words of two or more characters, split at punctuation and camelCase. */
export function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

const compact = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `web-frontend` as `Web Frontend`. */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '');
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || name;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` for a repository reference in any form `repoFullName` takes, or undefined. */
export function cleanRepo(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const full = repoFullName(raw);
  return REPO.test(full) && !full.endsWith('/.') && !full.endsWith('/..') ? full : undefined;
}

/** The repository's name, after the owner. */
export const repoName = (fullName: string): string => fullName.slice(fullName.indexOf('/') + 1);

/** The map's form of a repository: `github.com/owner/name`. */
export const mapRepo = (fullName: string): string => `github.com/${fullName}`;

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---- Jira -------------------------------------------------------------------------------------

/** A Jira component lead, as Jira shows them; the email only when the person's privacy settings allow. */
export interface ComponentLead {
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
}

export interface ProjectComponent {
  readonly name: string;
  readonly lead?: ComponentLead;
}

/** A chosen Jira project: its key, its name, and its components with their leads. */
export interface ProjectDetail {
  readonly key: string;
  readonly name: string;
  readonly components: readonly ProjectComponent[];
  /** True when Jira could not be read: the name is the key and the components are unknown. */
  readonly unread?: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * One project's name and components through the Jira client (`GET /project/{key}`). That response
 * carries the components and their leads too; the client's type names only what the projector reads,
 * so they are read here from the same response, as untrusted input.
 */
export async function readProjectDetail(client: Pick<JiraClient, 'getProject'>, key: string): Promise<ProjectDetail> {
  const project = asRecord(await client.getProject(key));
  const raw = Array.isArray(project['components']) ? (project['components'] as unknown[]) : [];
  const components: ProjectComponent[] = [];
  for (const c of raw.slice(0, MAX_COMPONENTS)) {
    const component = asRecord(c);
    const name = cleanText(component['name']);
    if (name === '') continue;
    const lead = asRecord(component['lead']);
    const accountId = lead['accountId'];
    const email = cleanEmail(lead['emailAddress']);
    components.push(
      isOpaqueId(accountId)
        ? { name, lead: { accountId, displayName: cleanText(lead['displayName']) || 'a Jira user', ...(email === undefined ? {} : { email }) } }
        : { name },
    );
  }
  return { key, name: cleanText(project['name']) || key, components };
}

/**
 * A Jira client on the login the Jira step recorded: the site and the email from its data, the API
 * token from `.env`. The site and the email are not read through `readEnv`, which would mark them as
 * secrets to scrub from everything saved, an owner's email included when the Jira admin owns a
 * product. Undefined when any of the three is missing.
 */
export async function jiraClientFor(ctx: StepContext, options: { readonly fetch?: typeof fetch } = {}): Promise<JiraClient | undefined> {
  const jira = ctx.data('jira');
  const site = typeof jira?.['site'] === 'string' ? checkSiteAddress(jira['site']) : undefined;
  const email = typeof jira?.['email'] === 'string' ? jira['email'] : undefined;
  const token = await ctx.readEnv('JIRA_API_TOKEN');
  if (site?.ok !== true || email === undefined || token === undefined) return undefined;
  return createJiraClient({ baseUrl: site.baseUrl, email, apiToken: token.reveal(), ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
}

/** The map components for a project's Jira components: ids unique slugs of the names. */
export function componentsOf(project: ProjectDetail | undefined): MapComponent[] {
  const taken = new Set<string>();
  const out: MapComponent[] = [];
  for (const c of project?.components ?? []) {
    if (out.some((o) => o.label.toLowerCase() === c.name.toLowerCase())) continue;
    const id = uniqueId(c.name, taken, 'component');
    taken.add(id);
    out.push({ id, label: c.name });
  }
  return out;
}

// ---- what earlier steps saved -----------------------------------------------------------------

/** Strings in a JSON list, or [] when it is not one. */
export function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The repositories the GitHub step recorded (`github.repos`), as `owner/name`, each once. */
export function reposFromState(github: JsonObject | undefined): string[] {
  const raw = github?.['repos'];
  const out: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const name = typeof entry === 'string' ? entry : asRecord(entry)['fullName'];
    const repo = cleanRepo(name);
    if (repo !== undefined && !out.some((r) => sameRepo(r, repo))) out.push(repo);
  }
  return out;
}

/** A bug channel a chat step recorded. */
export interface ChannelRef {
  readonly platform: ChannelPlatform;
  readonly id: string;
  readonly name: string;
  /** The Teams team's group id; present exactly when `platform` is `teams`. */
  readonly teamId?: string;
}

export interface ChatChannels {
  readonly channels: ChannelRef[];
  /** Whether the Slack step recorded a channel list (an empty one included). */
  readonly slackKnown: boolean;
  readonly teamsKnown: boolean;
}

/** The bug channels the chat steps recorded (`slack.channels`, `teams.channels`); malformed entries are dropped. */
export function channelsFromState(slack: JsonObject | undefined, teams: JsonObject | undefined): ChatChannels {
  const channels: ChannelRef[] = [];
  const read = (platform: ChannelPlatform, raw: JsonValue | undefined): boolean => {
    if (!Array.isArray(raw)) return false;
    for (const entry of raw) {
      const c = asRecord(entry);
      const id = c['id'];
      const name = cleanText(c['name']).replace(/^#/, '');
      if (!isOpaqueId(id) || name === '' || channels.some((k) => k.platform === platform && k.id === id)) continue;
      if (platform === 'teams') {
        const teamId = c['teamId'];
        if (!isOpaqueId(teamId)) continue;
        channels.push({ platform, id, name, teamId });
      } else {
        channels.push({ platform, id, name });
      }
    }
    return true;
  };
  const slackKnown = read('slack', slack?.['channels']);
  const teamsKnown = read('teams', teams?.['channels']);
  return { channels, slackKnown, teamsKnown };
}

// ---- the draft --------------------------------------------------------------------------------

export interface DraftSurface {
  id: string;
  label: string;
  /** `owner/name`. */
  repo: string;
  /** The Jira project key. */
  project: string;
  /** True when no project's key or name matched the repository, until the installer confirms one. */
  guessed: boolean;
  components: MapComponent[];
  /** Left out or merged away by the installer; kept so it can be brought back. */
  dropped: boolean;
}

export interface DraftChannel extends ChannelRef {
  /** A surface id or `from-payload`; undefined when nothing matched (it then goes to the fallback). */
  surface?: string;
  /** True when its name matched, or the installer chose its surface. */
  matched: boolean;
  /** Left out by the installer. */
  skipped: boolean;
}

export interface SurfaceDraft {
  surfaces: DraftSurface[];
  channels: DraftChannel[];
  fallbackSurface: string;
}

export interface ProposalInput {
  /** `owner/name`, in the order to propose them. */
  readonly repos: readonly string[];
  /** The chosen Jira projects, in the order the installer gave them. At least one. */
  readonly projects: readonly ProjectDetail[];
  readonly channels: readonly ChannelRef[];
}

/** The surfaces still in the draft (not dropped). */
export const liveSurfaces = (draft: SurfaceDraft): DraftSurface[] => draft.surfaces.filter((s) => !s.dropped);

/** How well a project matches a repository: 3 same name or key, 2 a shared word, 1 a prefix, 0 none. */
export function projectScore(repo: string, project: ProjectDetail): number {
  const name = repoName(repo);
  const r = compact(name);
  const key = compact(project.key);
  const pname = compact(project.name);
  if (r === '') return 0;
  if (r === key || r === pname) return 3;
  const projectWords = new Set([key, ...tokensOf(project.name)]);
  if (tokensOf(name).some((t) => projectWords.has(t))) return 2;
  if (key.length >= 2 && r.startsWith(key)) return 1;
  if (r.length >= 3 && pname.length >= 3 && (pname.startsWith(r) || r.startsWith(pname))) return 1;
  return 0;
}

const CHANNEL_NOISE = new Set([
  'bug', 'bugs', 'issue', 'issues', 'support', 'help', 'qa', 'triage', 'error', 'errors', 'incident', 'incidents',
  'report', 'reports', 'feedback', 'alert', 'alerts', 'team', 'dev', 'eng', 'ops', 'general', 'prod', 'production',
  'staging', 'channel', 'problems', 'broken',
]);

/** The words a channel name would use for a surface. */
function surfaceWords(s: DraftSurface, projects: readonly ProjectDetail[]): Set<string> {
  const words = new Set([...tokensOf(repoName(s.repo)), ...tokensOf(s.label), compact(s.id)]);
  const project = projects.find((p) => p.key === s.project);
  if (!s.guessed && project !== undefined) {
    words.add(compact(project.key));
    for (const t of tokensOf(project.name)) words.add(t);
  }
  words.delete('');
  return words;
}

/**
 * The surface a channel's name points at: the surface sharing the most words with it (bug words such
 * as "bugs" and "support" do not count), else one whose repository name the channel name contains;
 * `from-payload` for an alerts channel that names no surface; undefined when nothing matches.
 */
export function matchChannel(name: string, surfaces: readonly DraftSurface[], projects: readonly ProjectDetail[]): string | undefined {
  const all = tokensOf(name);
  const words = all.filter((t) => !CHANNEL_NOISE.has(t));
  let best: { id: string; score: number } | undefined;
  for (const s of surfaces) {
    const known = surfaceWords(s, projects);
    const score = words.filter((w) => known.has(w)).length;
    if (score > 0 && (best === undefined || score > best.score)) best = { id: s.id, score };
  }
  if (best !== undefined) return best.id;
  const flat = compact(name);
  const contained = surfaces.find((s) => {
    const r = compact(repoName(s.repo));
    return r.length >= 3 && flat.includes(r);
  });
  if (contained !== undefined) return contained.id;
  if (words.length === 0 && all.some((t) => t === 'alert' || t === 'alerts')) return FROM_PAYLOAD;
  return undefined;
}

/** A surface for `repo` with the best-matching project, or a guess when none matches. */
function surfaceFor(repo: string, ids: Set<string>, labels: Set<string>, project: ProjectDetail, guessed: boolean, useProjectName: boolean): DraftSurface {
  const id = uniqueId(repoName(repo), ids);
  ids.add(id);
  let label = (useProjectName && !guessed ? project.name : '') || cleanText(humanize(repoName(repo))) || id;
  if (labels.has(label.toLowerCase())) label = cleanText(`${label} (${repo})`);
  labels.add(label.toLowerCase());
  return { id, label, repo, project: project.key, guessed, components: componentsOf(project), dropped: false };
}

/** Builds the draft (see the file header). */
export function proposeSurfaces(input: ProposalInput): SurfaceDraft {
  const { projects } = input;
  const first = projects[0];
  if (first === undefined) throw new Error('proposeSurfaces: no Jira project');
  const best = input.repos.map((repo) => {
    let pick: { project: ProjectDetail; score: number } | undefined;
    for (const p of projects) {
      const score = projectScore(repo, p);
      if (score > 0 && (pick === undefined || score > pick.score)) pick = { project: p, score };
    }
    return { repo, pick };
  });
  const claimed = new Set(best.flatMap((b) => (b.pick === undefined ? [] : [b.pick.project.key])));
  const spare = projects.filter((p) => !claimed.has(p.key));
  const ids = new Set<string>();
  const labels = new Set<string>();
  const surfaces = best.map(({ repo, pick }) => {
    if (pick !== undefined) {
      const sharing = best.filter((b) => b.pick?.project.key === pick.project.key).length;
      return surfaceFor(repo, ids, labels, pick.project, false, sharing === 1);
    }
    const guess = spare.shift() ?? first;
    return surfaceFor(repo, ids, labels, guess, true, false);
  });
  const draft: SurfaceDraft = { surfaces, channels: [], fallbackSurface: surfaces[0]?.id ?? '' };
  draft.channels = input.channels.map((c) => draftChannel(c, surfaces, projects));
  return draft;
}

function draftChannel(c: ChannelRef, surfaces: readonly DraftSurface[], projects: readonly ProjectDetail[]): DraftChannel {
  const surface = matchChannel(c.name, surfaces, projects);
  return { ...c, ...(surface === undefined ? {} : { surface }), matched: surface !== undefined, skipped: false };
}

// ---- what the step keeps ----------------------------------------------------------------------

export interface SavedSurfaces {
  readonly org?: string;
  readonly surfaces: MapSurface[];
  readonly channels: MapChannel[];
  readonly fallbackSurface: string;
  readonly skippedRepos: string[];
  readonly skippedChannels: string[];
}

/** The draft as the step keeps it (see the file header). Unmatched channels go to the fallback surface, inferred. */
export function finalizeSurfaces(draft: SurfaceDraft): SavedSurfaces {
  const live = liveSurfaces(draft);
  const fallback = live.some((s) => s.id === draft.fallbackSurface) ? draft.fallbackSurface : (live[0]?.id ?? '');
  const surfaces: MapSurface[] = live.map((s) => ({
    id: s.id,
    label: s.label,
    repo: mapRepo(s.repo),
    jira: { project: s.project, defaultIssueType: DEFAULT_ISSUE_TYPE },
    components: s.components.map((c) => ({ ...c })),
  }));
  const channels: MapChannel[] = [];
  for (const c of draft.channels) {
    if (c.skipped) continue;
    const known = c.surface === FROM_PAYLOAD || live.some((s) => s.id === c.surface);
    const surface = known && c.surface !== undefined ? c.surface : fallback;
    const confidence: ChannelConfidence | undefined = surface === FROM_PAYLOAD ? undefined : known && c.matched ? 'explicit' : 'inferred';
    channels.push({
      id: c.id,
      name: c.name,
      surface,
      ...(confidence === undefined ? {} : { confidence }),
      ...(c.platform === 'teams' && c.teamId !== undefined ? { platform: 'teams' as const, teamId: c.teamId } : {}),
      triggerEmoji: [],
    });
  }
  const owners = live.map((s) => s.repo.slice(0, s.repo.indexOf('/')));
  const org = owners.reduce<string | undefined>((best, o) => (best === undefined || owners.filter((x) => x === o).length > owners.filter((x) => x === best).length ? o : best), undefined);
  return {
    ...(org === undefined ? {} : { org }),
    surfaces,
    channels,
    fallbackSurface: fallback,
    skippedRepos: draft.surfaces.filter((s) => s.dropped).map((s) => s.repo),
    skippedChannels: draft.channels.filter((c) => c.skipped).map((c) => c.id),
  };
}

/** `SavedSurfaces` as the step's data. */
export function savedSurfacesJson(saved: SavedSurfaces): JsonObject {
  return {
    ...(saved.org === undefined ? {} : { org: saved.org }),
    surfaces: saved.surfaces.map((s) => ({
      id: s.id,
      label: s.label,
      repo: s.repo,
      jira: { project: s.jira.project, defaultIssueType: s.jira.defaultIssueType },
      components: s.components.map((c) => ({ id: c.id, label: c.label })),
    })),
    channels: saved.channels.map((c) => ({
      id: c.id,
      name: c.name,
      surface: c.surface,
      ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
      ...(c.platform === undefined ? {} : { platform: c.platform }),
      ...(c.teamId === undefined ? {} : { teamId: c.teamId }),
      triggerEmoji: [],
    })),
    fallbackSurface: saved.fallbackSurface,
    skippedRepos: saved.skippedRepos,
    skippedChannels: saved.skippedChannels,
  };
}

const MAP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The step's data from an earlier run, or undefined when there is none or it does not hold together. */
export function parseSavedSurfaces(data: JsonObject | undefined): SavedSurfaces | undefined {
  if (data === undefined || !Array.isArray(data['surfaces'])) return undefined;
  const surfaces: MapSurface[] = [];
  for (const raw of data['surfaces']) {
    const s = asRecord(raw);
    const jira = asRecord(s['jira']);
    const id = s['id'];
    const label = cleanText(s['label']);
    const repo = cleanRepo(s['repo']);
    const project = jira['project'];
    if (typeof id !== 'string' || !MAP_ID.test(id) || label === '' || repo === undefined || typeof project !== 'string' || project === '') return undefined;
    if (surfaces.some((k) => k.id === id)) return undefined;
    const components: MapComponent[] = [];
    for (const rc of Array.isArray(s['components']) ? (s['components'] as unknown[]) : []) {
      const c = asRecord(rc);
      const cid = c['id'];
      const clabel = cleanText(c['label']);
      if (typeof cid === 'string' && MAP_ID.test(cid) && clabel !== '' && !components.some((k) => k.id === cid)) components.push({ id: cid, label: clabel });
    }
    const issueType = typeof jira['defaultIssueType'] === 'string' && jira['defaultIssueType'] !== '' ? jira['defaultIssueType'] : DEFAULT_ISSUE_TYPE;
    surfaces.push({ id, label, repo: mapRepo(repo), jira: { project, defaultIssueType: issueType }, components });
  }
  if (surfaces.length === 0) return undefined;
  const channels: MapChannel[] = [];
  for (const raw of Array.isArray(data['channels']) ? data['channels'] : []) {
    const c = asRecord(raw);
    const id = c['id'];
    const name = cleanText(c['name']);
    const surface = c['surface'];
    if (!isOpaqueId(id) || name === '' || typeof surface !== 'string') continue;
    if (surface !== FROM_PAYLOAD && !surfaces.some((s) => s.id === surface)) continue;
    const confidence = c['confidence'] === 'explicit' || c['confidence'] === 'inferred' ? c['confidence'] : undefined;
    const teams = c['platform'] === 'teams';
    const teamId = c['teamId'];
    if (teams && !isOpaqueId(teamId)) continue;
    channels.push({
      id,
      name,
      surface,
      ...(confidence === undefined ? {} : { confidence }),
      ...(teams && isOpaqueId(teamId) ? { platform: 'teams' as const, teamId } : {}),
      triggerEmoji: [],
    });
  }
  const fallback = data['fallbackSurface'];
  const fallbackSurface = typeof fallback === 'string' && surfaces.some((s) => s.id === fallback) ? fallback : (surfaces[0]?.id ?? '');
  const skippedRepos = stringList(data['skippedRepos']).flatMap((r) => {
    const repo = cleanRepo(r);
    return repo === undefined ? [] : [repo];
  });
  const skippedChannels = stringList(data['skippedChannels']).filter((id) => isOpaqueId(id));
  const org = cleanText(data['org']);
  return { ...(org === '' ? {} : { org }), surfaces, channels, fallbackSurface, skippedRepos, skippedChannels };
}

// ---- a rerun ----------------------------------------------------------------------------------

export interface ReconcileInput {
  /** The GitHub step's repositories; empty when it recorded none (the saved ones then stand). */
  readonly repos: readonly string[];
  readonly projects: readonly ProjectDetail[];
  readonly chat: ChatChannels;
}

/**
 * The saved surfaces checked again against what the earlier steps hold now: a repository the GitHub
 * App no longer lists is dropped, a project no longer chosen is replaced by a guess, components are
 * read again from Jira, new repositories and channels are proposed, and channels that are gone are
 * dropped. Returns the draft and one plain line per change.
 */
export function reconcileSurfaces(saved: SavedSurfaces, input: ReconcileInput): { draft: SurfaceDraft; changes: string[] } {
  const { projects } = input;
  const first = projects[0];
  if (first === undefined) throw new Error('reconcileSurfaces: no Jira project');
  const changes: string[] = [];
  const repos = input.repos.length > 0 ? input.repos : saved.surfaces.map((s) => repoFullName(s.repo));
  const fresh = proposeSurfaces({ repos, projects, channels: [] });

  const surfaces: DraftSurface[] = [];
  for (const s of saved.surfaces) {
    const repo = repoFullName(s.repo);
    if (!repos.some((r) => sameRepo(r, repo))) {
      changes.push(`${s.label}: the GitHub App no longer lists ${repo}, so it is left out.`);
      continue;
    }
    let project = projects.find((p) => p.key === s.jira.project);
    let guessed = false;
    if (project === undefined) {
      const proposed = fresh.surfaces.find((f) => sameRepo(f.repo, repo));
      project = projects.find((p) => p.key === proposed?.project) ?? first;
      guessed = proposed?.guessed ?? true;
      changes.push(`${s.label}: Jira project ${s.jira.project} is no longer one of the chosen projects, so I picked ${project.key} instead.`);
    }
    // Components follow the project; when Jira could not be read, the saved ones stand.
    const components = project.unread === true && !guessed ? s.components : componentsOf(project);
    surfaces.push({ id: s.id, label: s.label, repo, project: project.key, guessed, components, dropped: false });
  }
  const ids = new Set(surfaces.map((s) => s.id));
  const labels = new Set(surfaces.map((s) => s.label.toLowerCase()));
  for (const f of fresh.surfaces) {
    if (surfaces.some((s) => sameRepo(s.repo, f.repo))) continue;
    const skipped = saved.skippedRepos.some((r) => sameRepo(r, f.repo));
    const id = ids.has(f.id) ? uniqueId(f.id, ids) : f.id;
    ids.add(id);
    let label = f.label;
    if (labels.has(label.toLowerCase())) label = cleanText(`${label} (${f.repo})`);
    labels.add(label.toLowerCase());
    surfaces.push({ ...f, id, label, dropped: skipped });
    if (!skipped) changes.push(`New repository ${f.repo}: proposed as ${label}.`);
  }

  const live = surfaces.filter((s) => !s.dropped);
  const channels: DraftChannel[] = [];
  const known = (platform: ChannelPlatform): boolean => (platform === 'teams' ? input.chat.teamsKnown : input.chat.slackKnown);
  const platforms = new Set([...saved.channels.map((c) => c.platform ?? 'slack'), ...input.chat.channels.map((c) => c.platform)]);
  const both = platforms.size > 1;
  for (const c of saved.channels) {
    const platform = c.platform ?? 'slack';
    const current = input.chat.channels.find((k) => k.platform === platform && k.id === c.id);
    if (known(platform) && current === undefined) {
      changes.push(`${channelText(c.name, platform, both)} is no longer one of the bug channels, so it is left out.`);
      continue;
    }
    const surfaceLive = c.surface === FROM_PAYLOAD || live.some((s) => s.id === c.surface);
    if (!surfaceLive) changes.push(`${channelText(c.name, platform, both)} pointed at a product that is gone, so it goes to the fallback product until you choose.`);
    // An inferred channel went to the fallback product, and follows it still.
    const confirmed = surfaceLive && c.confidence !== 'inferred';
    channels.push({
      platform,
      id: c.id,
      name: current?.name ?? c.name,
      ...(platform === 'teams' && c.teamId !== undefined ? { teamId: c.teamId } : {}),
      ...(confirmed ? { surface: c.surface } : {}),
      matched: confirmed,
      skipped: false,
    });
  }
  for (const c of input.chat.channels) {
    if (channels.some((k) => k.platform === c.platform && k.id === c.id)) continue;
    if (saved.skippedChannels.includes(c.id)) {
      channels.push({ ...c, matched: false, skipped: true });
      continue;
    }
    channels.push(draftChannel(c, live, projects));
    changes.push(`New channel ${channelText(c.name, c.platform, both)}.`);
  }
  const fallbackSurface = live.some((s) => s.id === saved.fallbackSurface) ? saved.fallbackSurface : (live[0]?.id ?? '');
  return { draft: { surfaces, channels, fallbackSurface }, changes };
}

/** How a channel is named to the installer: `#web-bugs` in Slack, `Web bugs (Teams)` in Teams. */
export function channelText(name: string, platform: ChannelPlatform, both = false): string {
  return platform === 'teams' ? `${name} (Teams)` : `#${name}${both ? ' (Slack)' : ''}`;
}
