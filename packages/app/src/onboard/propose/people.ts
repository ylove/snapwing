// The draft behind the onboarding step `people` (main 4.1 "People to ownership", main 4.3
// "Auto-propose", main 22.2): who owns each product. Owners come from the product repository's
// CODEOWNERS and from the leads of the product's Jira components, and each one is matched to a chat
// account by email (Slack `users.lookupByEmail`, Microsoft Graph's user by email) so the map can
// mention them. The installer confirms or edits the owners in the step and names backups; nothing
// here writes anything.
//
// What the step keeps (its data), in the map's own shape (`@snapwing/pipeline/map/types.ts`):
//   people   MapPerson[]: handle, email, slackId and teamsId when found, role `engineer`, owns.
//            An owner owns the product (`primary`), a Jira component lead owns that component
//            (`primary`), and a backup owns the product without `primary`.
//   answers  the emails the installer typed for people GitHub or Jira showed none for, and for
//            CODEOWNERS teams, so a rerun does not ask for them again (`RememberedAnswers`)
//
// What it reads: the `surfaces` step's data, and from `.env` the GitHub App (`GITHUB_APP_ID`,
// `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`), the Jira login (`JIRA_BASE_URL`,
// `JIRA_EMAIL`, `JIRA_API_TOKEN`), the Slack bot token (`SLACK_BOT_TOKEN`), and the Teams bot
// (`TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`). Each source that is missing is
// skipped and the step says so. Everything read from them is untrusted: names go through
// `cleanText`, ids and emails are checked, and anything else is dropped.

import type { MapOwnership, MapPerson, MapSurface } from '@snapwing/pipeline/map/types.ts';
import { createGraphTokenSource, TeamsAuthError } from '../../adapters/teams/auth.ts';
import { createTeamsGraph, GraphAuthError, GraphPermissionError } from '../../adapters/teams/graph.ts';
import type { GitHubAuth } from '../../github/auth.ts';
import { createGitHubTransport, GitHubNotFoundError } from '../../github/client.ts';
import { CODEOWNERS_LOCATIONS, parseCodeowners } from '../../github/codeowners.ts';
import type { JsonObject } from '../interview/state.ts';
import { cleanEmail, cleanText, isOpaqueId, type ProjectDetail } from './surfaces.ts';

/** At most this many owners are read from one CODEOWNERS file. */
const MAX_CODEOWNERS = 50;

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---- CODEOWNERS -------------------------------------------------------------------------------

/** One owner named in CODEOWNERS. */
export type CodeownersEntry =
  | { readonly kind: 'user'; readonly login: string }
  | { readonly kind: 'team'; readonly org: string; readonly slug: string }
  | { readonly kind: 'email'; readonly email: string };

/** A CODEOWNERS owner token (`@login`, `@org/team`, or an email), or undefined for anything else. */
export function parseOwnerToken(token: string): CodeownersEntry | undefined {
  const email = cleanEmail(token);
  if (email !== undefined) return { kind: 'email', email };
  const team = /^@([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(token);
  if (team?.[1] !== undefined && team[2] !== undefined) return { kind: 'team', org: team[1], slug: team[2] };
  const user = /^@([A-Za-z0-9-]{1,39})$/.exec(token);
  if (user?.[1] !== undefined) return { kind: 'user', login: user[1] };
  return undefined;
}

/** Every owner a CODEOWNERS file names, each once, in the order they first appear. */
export function codeownersEntries(text: string): CodeownersEntry[] {
  const out: CodeownersEntry[] = [];
  const seen = new Set<string>();
  for (const rule of parseCodeowners(text)) {
    for (const token of rule.owners) {
      const entry = parseOwnerToken(token);
      if (entry === undefined) continue;
      const key = (entry.kind === 'user' ? `@${entry.login}` : entry.kind === 'team' ? `@${entry.org}/${entry.slug}` : entry.email).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      if (out.length >= MAX_CODEOWNERS) return out;
    }
  }
  return out;
}

export interface GitHubReader {
  /** The owners in the repository's CODEOWNERS; `source` is null when it has none. */
  codeowners(repo: string): Promise<{ readonly source: string | null; readonly entries: CodeownersEntry[] }>;
  /** A user's public email on GitHub, or undefined when they show none. */
  publicEmail(repo: string, login: string): Promise<string | undefined>;
}

/** Reads CODEOWNERS (where GitHub looks for it, first found wins) and public emails, as the GitHub App. */
export function createGitHubReader(auth: GitHubAuth, options: { readonly fetch?: typeof fetch; readonly apiBase?: string } = {}): GitHubReader {
  const transport = (repo: string) => createGitHubTransport(auth, { repo, ...options });
  return {
    async codeowners(repo) {
      const call = transport(repo);
      for (const location of CODEOWNERS_LOCATIONS) {
        try {
          const res = await call({ method: 'GET', path: `/repos/${repo}/contents/${location}`, permissions: { contents: 'read' }, accept: 'application/vnd.github.raw+json' });
          return { source: location, entries: codeownersEntries(res.text) };
        } catch (e) {
          if (!(e instanceof GitHubNotFoundError)) throw e;
        }
      }
      return { source: null, entries: [] };
    },
    async publicEmail(repo, login) {
      const res = await transport(repo)({ method: 'GET', path: `/users/${encodeURIComponent(login)}`, permissions: { metadata: 'read' } });
      let body: unknown;
      try {
        body = JSON.parse(res.text);
      } catch {
        return undefined;
      }
      return cleanEmail(asRecord(body)['email']);
    },
  };
}

// ---- chat accounts ----------------------------------------------------------------------------

export type ChatPlatformName = 'slack' | 'teams';

export interface ChatAccount {
  readonly id: string;
  /** The account's user name, a hint for the map handle. */
  readonly name?: string;
}

/**
 * A directory could not answer for anyone: `refused` (the credentials), `permission` (a scope or a
 * Graph permission the app lacks), or `unreachable`. The step stops asking that platform.
 */
export class ChatLookupError extends Error {
  override readonly name = 'ChatLookupError';
  constructor(
    readonly platform: ChatPlatformName,
    readonly reason: 'refused' | 'permission' | 'unreachable',
  ) {
    super(`${platform} lookup ${reason}`);
  }
}

export interface ChatDirectory {
  readonly platform: ChatPlatformName;
  /** The active person with this email, or undefined when there is none. Throws `ChatLookupError`. */
  lookup(email: string): Promise<ChatAccount | undefined>;
}

const SLACK_REFUSED = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'team_access_not_granted']);

/** Slack's `users.lookupByEmail` with the bot token (needs `users:read.email`). Bots and deactivated people never match. */
export function slackDirectory(token: string, options: { readonly fetch?: typeof fetch; readonly baseUrl?: string } = {}): ChatDirectory {
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = (options.baseUrl ?? 'https://slack.com/api/').replace(/\/?$/, '/');
  return {
    platform: 'slack',
    async lookup(email) {
      let body: Record<string, unknown>;
      try {
        const res = await doFetch(`${base}users.lookupByEmail?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${token}` } });
        body = asRecord(await res.json());
      } catch {
        throw new ChatLookupError('slack', 'unreachable');
      }
      if (body['ok'] === true) {
        const user = asRecord(body['user']);
        const id = user['id'];
        if (!isOpaqueId(id) || user['deleted'] === true || user['is_bot'] === true) return undefined;
        const name = cleanText(user['name'], 40);
        return name === '' ? { id } : { id, name };
      }
      const error = typeof body['error'] === 'string' ? body['error'] : '';
      if (error === 'users_not_found') return undefined;
      if (SLACK_REFUSED.has(error)) throw new ChatLookupError('slack', 'refused');
      if (error === 'missing_scope') throw new ChatLookupError('slack', 'permission');
      throw new ChatLookupError('slack', 'unreachable');
    },
  };
}

export interface TeamsDirectoryCredentials {
  readonly appId: string;
  readonly password: string;
  readonly tenantId: string;
}

/** Microsoft Graph's user by `mail` or `userPrincipalName`, with the bot's application token (needs `User.Read.All`). */
export function teamsDirectory(credentials: TeamsDirectoryCredentials, options: { readonly fetch?: typeof fetch } = {}): ChatDirectory {
  const fetchOpt = options.fetch === undefined ? {} : { fetch: options.fetch };
  const source = createGraphTokenSource({ ...credentials, ...fetchOpt });
  const graph = createTeamsGraph({ token: () => source.token(), ...fetchOpt });
  return {
    platform: 'teams',
    async lookup(email) {
      try {
        const user = await graph.userByEmail(email);
        if (user === undefined || !isOpaqueId(user.id)) return undefined;
        const name = cleanText(user.displayName, 40);
        return name === '' ? { id: user.id } : { id: user.id, name };
      } catch (e) {
        if (e instanceof GraphPermissionError) throw new ChatLookupError('teams', 'permission');
        if (e instanceof TeamsAuthError || e instanceof GraphAuthError) throw new ChatLookupError('teams', 'refused');
        throw new ChatLookupError('teams', 'unreachable');
      }
    },
  };
}

// ---- the proposal -----------------------------------------------------------------------------

/** A person proposed as an owner of one product. */
export interface OwnerCandidate {
  /** Stable across products: `email:`, `github:`, or `jira:` and the id. */
  readonly key: string;
  /** How the installer would recognize them: the email, `@login`, or the Jira name. */
  readonly name: string;
  readonly email?: string;
  readonly githubLogin?: string;
  readonly jiraAccountId?: string;
  /** Named in CODEOWNERS: owns the product itself. */
  readonly surfaceOwner: boolean;
  /** The product's component ids this person leads in Jira. */
  readonly components: readonly string[];
  /** Where the name came from, in plain words. */
  readonly sources: readonly string[];
}

/** A CODEOWNERS team; GitHub does not show the App who is in it. */
export interface TeamCandidate {
  readonly key: string;
  /** `@org/slug`. */
  readonly name: string;
}

export interface OwnerProposal {
  readonly people: OwnerCandidate[];
  readonly teams: TeamCandidate[];
}

export interface OwnerProposalInput {
  readonly surface: MapSurface;
  /** `owner/name` of the surface's repository, for the plain-language sources. */
  readonly repo: string;
  readonly codeowners: readonly CodeownersEntry[];
  /** The surface's Jira project, with its component leads. */
  readonly project?: ProjectDetail;
  /** Public emails by lowercase GitHub login. */
  readonly githubEmails: ReadonlyMap<string, string>;
}

/** The owners proposed for one product: CODEOWNERS first, then the leads of its Jira components, merged by email, login, or Jira account. */
export function proposeOwners(input: OwnerProposalInput): OwnerProposal {
  const people: OwnerCandidate[] = [];
  const teams: TeamCandidate[] = [];
  const add = (c: OwnerCandidate): void => {
    const i = people.findIndex(
      (p) =>
        (c.email !== undefined && p.email === c.email) ||
        (c.githubLogin !== undefined && p.githubLogin?.toLowerCase() === c.githubLogin.toLowerCase()) ||
        (c.jiraAccountId !== undefined && p.jiraAccountId === c.jiraAccountId),
    );
    const p = people[i];
    if (p === undefined) {
      people.push(c);
      return;
    }
    const email = p.email ?? c.email;
    const githubLogin = p.githubLogin ?? c.githubLogin;
    const jiraAccountId = p.jiraAccountId ?? c.jiraAccountId;
    people[i] = {
      key: p.key,
      name: p.name,
      ...(email === undefined ? {} : { email }),
      ...(githubLogin === undefined ? {} : { githubLogin }),
      ...(jiraAccountId === undefined ? {} : { jiraAccountId }),
      surfaceOwner: p.surfaceOwner || c.surfaceOwner,
      components: [...new Set([...p.components, ...c.components])],
      sources: [...new Set([...p.sources, ...c.sources])],
    };
  };
  const fromCodeowners = `CODEOWNERS in ${input.repo}`;
  for (const entry of input.codeowners) {
    if (entry.kind === 'team') {
      const name = `@${entry.org}/${entry.slug}`;
      if (!teams.some((t) => t.key === `team:${name.toLowerCase()}`)) teams.push({ key: `team:${name.toLowerCase()}`, name });
    } else if (entry.kind === 'email') {
      add({ key: `email:${entry.email}`, name: entry.email, email: entry.email, surfaceOwner: true, components: [], sources: [fromCodeowners] });
    } else {
      const email = input.githubEmails.get(entry.login.toLowerCase());
      add({
        key: `github:${entry.login.toLowerCase()}`,
        name: `@${entry.login} on GitHub`,
        ...(email === undefined ? {} : { email }),
        githubLogin: entry.login,
        surfaceOwner: true,
        components: [],
        sources: [fromCodeowners],
      });
    }
  }
  for (const component of input.project?.components ?? []) {
    const lead = component.lead;
    if (lead === undefined) continue;
    const mapped = input.surface.components.find((c) => c.label.toLowerCase() === component.name.toLowerCase());
    if (mapped === undefined) continue;
    add({
      key: `jira:${lead.accountId}`,
      name: lead.displayName,
      ...(lead.email === undefined ? {} : { email: lead.email }),
      jiraAccountId: lead.accountId,
      surfaceOwner: false,
      components: [mapped.id],
      sources: [`lead of the Jira component ${component.name}`],
    });
  }
  return { people, teams };
}

// ---- the people -------------------------------------------------------------------------------

/** One owner the installer confirmed for one product. */
export interface OwnerPick {
  readonly email: string;
  /** Handle hints, best first (a GitHub login, a saved handle). */
  readonly handleHints: readonly string[];
  readonly surfaceOwner: boolean;
  readonly components: readonly string[];
}

/** What the installer confirmed for one product. */
export interface SurfacePick {
  readonly surface: string;
  readonly owners: readonly OwnerPick[];
  /** Emails. */
  readonly backups: readonly string[];
}

/** A person being built: by email, with their ownership rows and any chat ids saved before. */
export interface PersonDraft {
  readonly email: string;
  handleHints: string[];
  owns: MapOwnership[];
  slackId?: string;
  teamsId?: string;
}

function addOwns(person: PersonDraft, row: MapOwnership): void {
  const same = person.owns.find((o) => o.surface === row.surface && o.component === row.component);
  if (same === undefined) person.owns.push(row);
  else if (row.primary) same.primary = true;
}

function personFor(persons: PersonDraft[], email: string, hints: readonly string[]): PersonDraft {
  let person = persons.find((p) => p.email === email);
  if (person === undefined) {
    person = { email, handleHints: [], owns: [] };
    persons.push(person);
  }
  for (const h of hints) if (!person.handleHints.includes(h)) person.handleHints.push(h);
  return person;
}

/** Adds what the installer confirmed for each product: owners own it (or their components), backups own it without `primary`. */
export function applyPicks(persons: PersonDraft[], picks: readonly SurfacePick[]): void {
  for (const pick of picks) {
    for (const owner of pick.owners) {
      const person = personFor(persons, owner.email, owner.handleHints);
      if (owner.surfaceOwner) addOwns(person, { surface: pick.surface, primary: true });
      for (const component of owner.components) addOwns(person, { surface: pick.surface, component, primary: true });
    }
    for (const email of pick.backups) {
      if (pick.owners.some((o) => o.email === email)) continue;
      addOwns(personFor(persons, email, []), { surface: pick.surface, primary: false });
    }
  }
}

/**
 * What a lookup found on one platform: an account, `null` for nobody with that email, or undefined
 * when the platform could not be asked (a chat id saved before then stands).
 */
export type LookupResult = ChatAccount | null | undefined;

export interface ChatLookups {
  readonly slack: LookupResult;
  readonly teams: LookupResult;
}

/** A map handle from a hint: letters, digits, dots, dashes, and underscores, or '' when nothing is left. */
export function cleanHandle(hint: string): string {
  return hint
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 40);
}

/**
 * The map's people from the drafts: chat ids from the lookups (a saved id stands when a platform could
 * not be asked), people sharing a chat account merged into one, handles unique (the first usable hint,
 * then the account's user name, then the email's local part), and role `engineer`. A person with no
 * ownership row left is dropped.
 */
export function buildPeople(drafts: readonly PersonDraft[], lookups: (email: string) => ChatLookups): MapPerson[] {
  interface Built {
    email: string;
    hints: string[];
    owns: MapOwnership[];
    slackId?: string;
    teamsId?: string;
  }
  const built: Built[] = [];
  for (const d of drafts) {
    if (d.owns.length === 0) continue;
    const found = lookups(d.email);
    const slack = found.slack === undefined ? (d.slackId === undefined ? undefined : { id: d.slackId }) : (found.slack ?? undefined);
    const teams = found.teams === undefined ? (d.teamsId === undefined ? undefined : { id: d.teamsId }) : (found.teams ?? undefined);
    const hints = [...d.handleHints, ...(slack?.name === undefined ? [] : [slack.name]), d.email.slice(0, d.email.indexOf('@'))];
    const twin = built.find((b) => (slack !== undefined && b.slackId === slack.id) || (teams !== undefined && b.teamsId === teams.id));
    if (twin !== undefined) {
      for (const row of d.owns) {
        const same = twin.owns.find((o) => o.surface === row.surface && o.component === row.component);
        if (same === undefined) twin.owns.push({ ...row });
        else if (row.primary) same.primary = true;
      }
      twin.hints.push(...hints);
      if (twin.slackId === undefined && slack !== undefined) twin.slackId = slack.id;
      if (twin.teamsId === undefined && teams !== undefined) twin.teamsId = teams.id;
      continue;
    }
    built.push({
      email: d.email,
      hints,
      owns: d.owns.map((o) => ({ ...o })),
      ...(slack === undefined ? {} : { slackId: slack.id }),
      ...(teams === undefined ? {} : { teamsId: teams.id }),
    });
  }
  const taken = new Set<string>();
  return built.map((b) => {
    let handle = b.hints.map(cleanHandle).find((h) => h !== '' && !taken.has(h.toLowerCase())) ?? '';
    if (handle === '') {
      const root = b.hints.map(cleanHandle).find((h) => h !== '') || 'person';
      for (let i = 2; handle === ''; i += 1) if (!taken.has(`${root}-${i}`.toLowerCase())) handle = `${root}-${i}`;
    }
    taken.add(handle.toLowerCase());
    return {
      ...(b.slackId === undefined ? {} : { slackId: b.slackId }),
      ...(b.teamsId === undefined ? {} : { teamsId: b.teamsId }),
      handle,
      email: b.email,
      role: 'engineer' as const,
      owns: b.owns,
    };
  });
}

/**
 * What the installer typed for people GitHub or Jira did not show an email for (by candidate key; null
 * when they left the person out), and for CODEOWNERS teams (by team key), so a rerun does not ask again.
 */
export interface RememberedAnswers {
  readonly emails: Map<string, string | null>;
  readonly teams: Map<string, string[]>;
}

/** The remembered answers in the step's data (`answers`); malformed entries are dropped. */
export function parseRememberedAnswers(data: JsonObject | undefined): RememberedAnswers {
  const answers = asRecord(data?.['answers']);
  const emails = new Map<string, string | null>();
  for (const [key, value] of Object.entries(asRecord(answers['emails']))) {
    if (!/^(github|jira):[^\s]{1,200}$/.test(key)) continue;
    if (value === null) emails.set(key, null);
    else {
      const email = cleanEmail(value);
      if (email !== undefined) emails.set(key, email);
    }
  }
  const teams = new Map<string, string[]>();
  for (const [key, value] of Object.entries(asRecord(answers['teams']))) {
    if (!/^team:@[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(key) || !Array.isArray(value)) continue;
    teams.set(key, value.flatMap((v) => cleanEmail(v) ?? []));
  }
  return { emails, teams };
}

/** The step's data: the people (see the file header) and the remembered answers. */
export function peopleJson(people: readonly MapPerson[], answers?: RememberedAnswers): JsonObject {
  return {
    ...(answers === undefined ? {} : { answers: { emails: Object.fromEntries(answers.emails), teams: Object.fromEntries(answers.teams) } }),
    people: people.map((p) => ({
      ...(p.slackId === undefined ? {} : { slackId: p.slackId }),
      ...(p.teamsId === undefined ? {} : { teamsId: p.teamsId }),
      handle: p.handle,
      ...(p.email === undefined ? {} : { email: p.email }),
      role: p.role,
      owns: p.owns.map((o) => ({ surface: o.surface, ...(o.component === undefined ? {} : { component: o.component }), primary: o.primary })),
    })),
  };
}

/**
 * The people saved by an earlier run, checked against the products as they are now: a row for a
 * product or component that is gone is dropped (each named in `notes`), and a person left with no row
 * is dropped. Undefined when nothing usable was saved.
 */
export function parseSavedPeople(data: JsonObject | undefined, surfaces: readonly MapSurface[]): { persons: PersonDraft[]; notes: string[] } | undefined {
  if (data === undefined || !Array.isArray(data['people'])) return undefined;
  const persons: PersonDraft[] = [];
  const notes: string[] = [];
  for (const raw of data['people']) {
    const p = asRecord(raw);
    const email = cleanEmail(p['email']);
    const handle = cleanHandle(typeof p['handle'] === 'string' ? p['handle'] : '');
    if (email === undefined || persons.some((k) => k.email === email)) continue;
    const owns: MapOwnership[] = [];
    for (const rawRow of Array.isArray(p['owns']) ? (p['owns'] as unknown[]) : []) {
      const row = asRecord(rawRow);
      const surface = surfaces.find((s) => s.id === row['surface']);
      const component = row['component'];
      if (surface === undefined) {
        if (typeof row['surface'] === 'string') notes.push(`${email} owned a product that is gone, so that is dropped.`);
        continue;
      }
      if (component !== undefined && !(typeof component === 'string' && surface.components.some((c) => c.id === component))) {
        notes.push(`${email} led a Jira component of ${surface.label} that is gone, so that is dropped.`);
        continue;
      }
      if (owns.some((o) => o.surface === surface.id && o.component === component)) continue;
      owns.push({ surface: surface.id, ...(typeof component === 'string' ? { component } : {}), primary: row['primary'] === true });
    }
    if (owns.length === 0) continue;
    persons.push({
      email,
      handleHints: handle === '' ? [] : [handle],
      owns,
      ...(isOpaqueId(p['slackId']) ? { slackId: p['slackId'] } : {}),
      ...(isOpaqueId(p['teamsId']) ? { teamsId: p['teamsId'] } : {}),
    });
  }
  return persons.length === 0 ? undefined : { persons, notes: [...new Set(notes)] };
}
