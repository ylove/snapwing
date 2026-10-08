// Onboarding step `people` (main 22.2, main 4.1 and 4.3 "Auto-propose" and "Confirm"): who owns each
// product. For each confirmed product the step proposes owners from the repository's CODEOWNERS and
// the leads of its Jira components (`onboard/propose/people.ts`), with whether each has a Slack or
// Teams account under their email, and asks whether they are right: yes (an owner whose email GitHub
// or Jira does not show is asked for it, and a CODEOWNERS team for the people on it who own the
// product), a list the installer types instead, or nobody for now. Then it asks who covers for the
// owners. Every owner is an engineer in the map; each is matched to Slack and to Teams by email, so a
// person may carry both ids, either, or neither. Works with either chat platform connected, with
// both, or with neither (people are then kept by email until this step runs again).
//
// On a rerun (or a resume) the saved owners are checked against the products as they are now, their
// chat accounts are looked up again, and the installer keeps them or starts over; a product added
// since is asked about either way. Nothing is kept until every product has been answered for.

import type { MapSurface } from '@snapwing/pipeline/map/types.ts';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { repoFullName } from '@snapwing/pipeline/util/repo.ts';
import { createGitHubAuth } from '../../github/auth.ts';
import type { JiraClient } from '../../jira/client/index.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import {
  applyPicks,
  buildPeople,
  ChatLookupError,
  createGitHubReader,
  parseRememberedAnswers,
  parseSavedPeople,
  peopleJson,
  proposeOwners,
  slackDirectory,
  teamsDirectory,
  type ChatAccount,
  type ChatDirectory,
  type ChatLookups,
  type ChatPlatformName,
  type CodeownersEntry,
  type GitHubReader,
  type OwnerCandidate,
  type OwnerPick,
  type PersonDraft,
  type SurfacePick,
} from '../propose/people.ts';
import { cleanEmail, cleanText, jiraClientFor, parseSavedSurfaces, readProjectDetail, type ProjectDetail } from '../propose/surfaces.ts';

export interface PeopleStepDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const NOBODY = /^(none|nobody|no one|no|-)$/i;
const MAX_EMAILS = 25;

const PLATFORM_NAMES: Readonly<Record<ChatPlatformName, string>> = { slack: 'Slack', teams: 'Teams' };

const WHY_LOOKUP: Readonly<Record<ChatPlatformName, Record<ChatLookupError['reason'], string>>> = {
  slack: {
    refused: 'Slack did not accept the bot token',
    permission: 'the Slack app cannot read email addresses (it needs the users:read.email scope)',
    unreachable: 'Slack did not answer',
  },
  teams: {
    refused: 'Microsoft did not accept the Teams bot login',
    permission: 'the Teams bot cannot look people up (it needs the User.Read.All permission)',
    unreachable: 'Microsoft Graph did not answer',
  },
};

/** `a, b and c`. */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Emails parsed from an answer; a refusal string when one does not look like an email. */
function parseEmails(answer: string): string[] | string {
  if (NOBODY.test(answer.trim())) return [];
  const found: string[] = [];
  for (const part of answer.split(/[\s,;]+/).filter((p) => p !== '')) {
    const email = cleanEmail(part);
    if (email === undefined) return `${cleanText(part, 60)} does not look like an email address.`;
    if (!found.includes(email)) found.push(email);
  }
  if (found.length > MAX_EMAILS) return `That is more than ${MAX_EMAILS} people; name the few who should hear about bugs first.`;
  return found;
}

/** What the step can read this run. */
interface Sources {
  readonly github?: GitHubReader;
  readonly jira?: JiraClient;
  readonly directories: ChatDirectory[];
}

export function createPeopleStep(deps: PeopleStepDeps = {}): OnboardStep {
  const fetchOpt = deps.fetch === undefined ? {} : { fetch: deps.fetch };

  async function openSources(ctx: StepContext): Promise<Sources> {
    const value = async (name: string): Promise<string | undefined> => (await ctx.readEnv(name))?.reveal();
    const notes: string[] = [];

    let github: GitHubReader | undefined;
    if ((await value('GITHUB_APP_ID')) !== undefined && (await value('GITHUB_APP_PRIVATE_KEY')) !== undefined && (await value('GITHUB_INSTALLATION_ID')) !== undefined) {
      const secrets: SecretsPort = {
        get: async (name) => {
          const v = await value(name);
          if (v === undefined) throw new SecretNotFoundError(name, '.env');
          return v;
        },
      };
      github = createGitHubReader(createGitHubAuth({ secrets, ...fetchOpt }), fetchOpt);
    } else {
      notes.push('GitHub is not connected yet, so I cannot read CODEOWNERS.');
    }

    const jira = await jiraClientFor(ctx, fetchOpt);
    if (jira === undefined) notes.push('I could not find the Jira login, so I cannot read who leads each Jira component.');

    const directories: ChatDirectory[] = [];
    const slackToken = await value('SLACK_BOT_TOKEN');
    if (slackToken !== undefined) directories.push(slackDirectory(slackToken, fetchOpt));
    const [appId, password, tenantId] = [await value('TEAMS_APP_ID'), await value('TEAMS_APP_PASSWORD'), await value('TEAMS_TENANT_ID')];
    if (appId !== undefined && password !== undefined && tenantId !== undefined) directories.push(teamsDirectory({ appId, password, tenantId }, fetchOpt));
    const names = directories.map((d) => PLATFORM_NAMES[d.platform]);
    notes.push(
      names.length === 0
        ? 'No chat platform is connected yet, so people are kept by email for now. Run snapwing onboard --step people again after connecting Slack or Teams to add their chat accounts.'
        : `I will look each person up in ${listText(names)} by email, so Snapwing can mention them there.`,
    );
    ctx.io.say(notes.join('\n'));
    return { ...(github === undefined ? {} : { github }), ...(jira === undefined ? {} : { jira }), directories };
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const products = parseSavedSurfaces(ctx.data('surfaces'));
    if (products === undefined) throw new Error('the products have not been confirmed yet; run snapwing onboard --step surfaces first');
    const surfaces = products.surfaces;
    io.say('Now, who owns each product.');
    const sources = await openSources(ctx);

    // ---- chat lookups, once per email and platform ------------------------------------------------
    const live = new Set<ChatPlatformName>(sources.directories.map((d) => d.platform));
    const found = new Map<string, { slack?: ChatAccount | null; teams?: ChatAccount | null }>();
    async function lookUp(email: string): Promise<ChatLookups> {
      const entry = found.get(email) ?? {};
      for (const directory of sources.directories) {
        const { platform } = directory;
        if (!live.has(platform) || entry[platform] !== undefined) continue;
        try {
          entry[platform] = (await directory.lookup(email)) ?? null;
        } catch (e) {
          if (!(e instanceof ChatLookupError)) throw e;
          live.delete(platform);
          io.say(`I could not look people up in ${PLATFORM_NAMES[platform]}: ${WHY_LOOKUP[platform][e.reason]}. I will carry on without ${PLATFORM_NAMES[platform]} accounts; run snapwing onboard --step people again once that is fixed.`);
        }
      }
      found.set(email, entry);
      return { slack: entry.slack, teams: entry.teams };
    }
    const chatText = (l: ChatLookups): string => {
      const asked = sources.directories.map((d) => d.platform);
      if (asked.length === 0) return '';
      const has = asked.filter((p) => l[p] !== null && l[p] !== undefined).map((p) => PLATFORM_NAMES[p]);
      if (has.length > 0) return `in ${listText(has)}`;
      return asked.some((p) => l[p] === null) ? 'no chat account found' : '';
    };

    // ---- what GitHub and Jira propose, read once per repository, login, and project -------------
    const codeownersOf = new Map<string, readonly CodeownersEntry[]>();
    const emailsOf = new Map<string, string>();
    const projectsOf = new Map<string, ProjectDetail | undefined>();
    async function proposalFor(surface: MapSurface): Promise<{ people: OwnerCandidate[]; teams: { key: string; name: string }[]; notes: string[] }> {
      const repo = repoFullName(surface.repo);
      const notes: string[] = [];
      let entries = codeownersOf.get(repo.toLowerCase());
      if (entries === undefined && sources.github !== undefined) {
        try {
          const read = await sources.github.codeowners(repo);
          entries = read.entries;
          if (read.source === null) notes.push(`${repo} has no CODEOWNERS file.`);
        } catch {
          entries = [];
          notes.push(`I could not read CODEOWNERS in ${repo}.`);
        }
        codeownersOf.set(repo.toLowerCase(), entries);
        for (const entry of entries) {
          if (entry.kind !== 'user' || emailsOf.has(entry.login.toLowerCase())) continue;
          try {
            const email = await sources.github.publicEmail(repo, entry.login);
            if (email !== undefined) emailsOf.set(entry.login.toLowerCase(), email);
          } catch {
            // No public email: the installer is asked for it.
          }
        }
      }
      const key = surface.jira.project;
      if (!projectsOf.has(key) && sources.jira !== undefined) {
        try {
          projectsOf.set(key, await readProjectDetail(sources.jira, key));
        } catch {
          projectsOf.set(key, undefined);
          notes.push(`I could not read the components of Jira project ${key}.`);
        }
      }
      const project = projectsOf.get(key);
      const proposal = proposeOwners({ surface, repo, codeowners: entries ?? [], ...(project === undefined ? {} : { project }), githubEmails: emailsOf });
      return { ...proposal, notes };
    }

    // ---- asking --------------------------------------------------------------------------------
    // Remembered across runs, so a rerun does not ask for the same email or team again.
    const { emails: askedEmail, teams: askedTeam } = parseRememberedAnswers(ctx.data('people'));

    async function askEmails(id: string, text: string, why: string, prefill: readonly string[] = []): Promise<string[]> {
      let out: string[] = [];
      await io.ask({
        id,
        text,
        default: prefill.length > 0 ? prefill.join(', ') : 'nobody',
        why,
        validate: (answer) => {
          const parsed = parseEmails(answer);
          if (typeof parsed === 'string') return parsed;
          out = parsed;
          return undefined;
        },
      });
      return out;
    }

    /** The email of a proposed owner GitHub or Jira does not show it for; null leaves them out. Asked once per person. */
    async function emailOf(candidate: OwnerCandidate): Promise<string | null> {
      if (candidate.email !== undefined) return candidate.email;
      const known = askedEmail.get(candidate.key);
      if (known !== undefined) return known;
      let email: string | null = null;
      await io.ask({
        id: 'email',
        text: `What is the email of ${candidate.name} (${listText([...candidate.sources])})? Press Enter to leave them out.`,
        default: 'none',
        why: 'Snapwing finds people in Slack, Teams, and Jira by email. GitHub shows an email only when the person made it public, and Jira only when their privacy settings allow.',
        validate: (answer) => {
          if (NOBODY.test(answer.trim())) {
            email = null;
            return undefined;
          }
          const clean = cleanEmail(answer);
          if (clean === undefined) return 'That does not look like an email address.';
          email = clean;
          return undefined;
        },
      });
      askedEmail.set(candidate.key, email);
      return email;
    }

    async function confirmSurface(surface: MapSurface, savedHandles: ReadonlyMap<string, string>): Promise<SurfacePick> {
      const repo = repoFullName(surface.repo);
      const proposal = await proposalFor(surface);
      // An email the installer typed before stands in for one GitHub or Jira does not show.
      const people = proposal.people.map((c) => {
        const remembered = c.email === undefined ? askedEmail.get(c.key) : undefined;
        return typeof remembered === 'string' ? { ...c, email: remembered } : c;
      });
      const lines = [`${surface.label} (repository ${repo}, Jira project ${surface.jira.project}):`, ...proposal.notes.map((n) => `  ${n}`)];
      for (const c of people) {
        const chat = c.email !== undefined ? chatText(await lookUp(c.email)) : askedEmail.get(c.key) === null ? 'left out before, with no email' : 'email not known';
        const who = c.email !== undefined && c.email !== c.name ? `${c.name}, ${c.email}` : c.name;
        lines.push(`  ${who}: ${listText([...c.sources])}${chat === '' ? '' : `; ${chat}`}`);
      }
      for (const t of proposal.teams) {
        const named = askedTeam.get(t.key);
        lines.push(
          `  The team ${t.name}: CODEOWNERS in ${repo}; ${named === undefined ? 'GitHub does not show Snapwing who is in it' : named.length === 0 ? 'you named nobody on it' : `you named ${listText(named)} on it`}`,
        );
      }
      if (proposal.people.length === 0 && proposal.teams.length === 0) lines.push('  I found nobody in CODEOWNERS or Jira.');
      io.say(lines.join('\n'));

      const hintsFor = (email: string, c?: OwnerCandidate): string[] => {
        const saved = savedHandles.get(email);
        return [...(saved === undefined ? [] : [saved]), ...(c?.githubLogin === undefined ? [] : [c.githubLogin])];
      };
      const ownersWhy = 'Owners are who Snapwing assigns and mentions when a bug in this product comes in. Each is matched to Slack and Teams by email.';
      let owners: OwnerPick[] = [];
      const what =
        people.length + proposal.teams.length === 0
          ? 'change'
          : await io.choose({
              id: 'owners',
              text: `Are these the owners of ${surface.label}?`,
              choices: [
                { id: 'keep', label: 'Yes' },
                { id: 'change', label: 'No, I will type who owns it' },
                { id: 'none', label: 'Nobody owns it for now' },
              ],
              default: 'keep',
              why: ownersWhy,
            });
      if (what === 'keep') {
        for (const c of people) {
          const email = await emailOf(c);
          if (email !== null) owners.push({ email, handleHints: hintsFor(email, c), surfaceOwner: c.surfaceOwner, components: c.components });
        }
        for (const t of proposal.teams) {
          let members = askedTeam.get(t.key);
          if (members === undefined) {
            members = await askEmails(
              'team',
              `CODEOWNERS in ${repo} names the team ${t.name}, and GitHub does not show Snapwing who is in it. Who on it owns ${surface.label}? Type their emails, separated by commas, or press Enter for nobody.`,
              'The GitHub App can read the repository, not your organization, so it cannot list a team. The people you name here are asked about only once, whichever products the team owns.',
            );
            askedTeam.set(t.key, members);
          }
          for (const email of members) owners.push({ email, handleHints: hintsFor(email), surfaceOwner: true, components: [] });
        }
      } else if (what === 'change') {
        const known = people.flatMap((c) => (c.email === undefined ? [] : [c.email]));
        const emails = await askEmails(
          'owners-list',
          `Who owns ${surface.label}? Type their emails, separated by commas${known.length > 0 ? `; press Enter for ${known.join(', ')}` : ', or press Enter for nobody'}.`,
          ownersWhy,
          known,
        );
        owners = emails.map((email) => {
          const c = people.find((p) => p.email === email);
          return { email, handleHints: hintsFor(email, c), surfaceOwner: true, components: c?.components ?? [] };
        });
      }
      const unique = owners.filter((o, i) => owners.findIndex((k) => k.email === o.email) === i);
      const backups = await askEmails(
        'backups',
        `Who covers for the owners of ${surface.label} when they are away? Type emails, separated by commas, or press Enter for nobody.`,
        'A backup is mentioned when the owners do not answer. Backups are matched to Slack and Teams by email too.',
      );
      return { surface: surface.id, owners: unique, backups };
    }

    // ---- the saved owners on a rerun -------------------------------------------------------------
    let persons: PersonDraft[] = [];
    let todo: readonly MapSurface[] = surfaces;
    const saved = parseSavedPeople(ctx.data('people'), surfaces);
    const savedHandles = new Map<string, string>();
    for (const p of saved?.persons ?? []) if (p.handleHints[0] !== undefined) savedHandles.set(p.email, p.handleHints[0]);
    if (saved !== undefined) {
      const lines = ['These are the owners you confirmed before:', ...saved.notes.map((n) => `  ${n}`)];
      for (const s of surfaces) {
        const rows = saved.persons.filter((p) => p.owns.some((o) => o.surface === s.id));
        if (rows.length === 0) continue;
        // One at a time, so a platform that fails is reported once.
        const describe = async (list: readonly PersonDraft[]): Promise<string> => {
          const out: string[] = [];
          for (const p of list) {
            const chat = chatText(await lookUp(p.email));
            out.push(`${p.email}${chat === '' ? '' : ` (${chat})`}`);
          }
          return out.join(', ');
        };
        const owners = rows.filter((p) => p.owns.some((o) => o.surface === s.id && o.primary));
        const backups = rows.filter((p) => !owners.includes(p));
        const ownerText = owners.length === 0 ? 'nobody' : await describe(owners);
        const backupText = backups.length === 0 ? '' : `; backups ${await describe(backups)}`;
        lines.push(`  ${s.label}: ${ownerText}${backupText}`);
      }
      const fresh = surfaces.filter((s) => !saved.persons.some((p) => p.owns.some((o) => o.surface === s.id)));
      if (fresh.length > 0) lines.push(`  No owners yet: ${listText(fresh.map((s) => s.label))}`);
      io.say(lines.join('\n'));
      const keep = await io.choose({
        id: 'keep',
        text: 'Keep these owners?',
        choices: [
          { id: 'keep', label: fresh.length > 0 ? 'Yes, and ask me about the rest' : 'Yes, keep them' },
          { id: 'redo', label: 'No, go through every product again' },
        ],
        default: 'keep',
        why: 'Their chat accounts were looked up again just now. Going through again starts from CODEOWNERS and Jira for every product.',
      });
      if (keep === 'keep') {
        persons = saved.persons;
        todo = fresh;
      }
    }

    const picks: SurfacePick[] = [];
    for (const surface of todo) picks.push(await confirmSurface(surface, savedHandles));
    applyPicks(persons, picks);

    const lookups = new Map<string, ChatLookups>();
    for (const p of persons) lookups.set(p.email, await lookUp(p.email));
    const people = buildPeople(persons, (email) => lookups.get(email) ?? { slack: undefined, teams: undefined });

    const summary = [`Got it: ${people.length === 1 ? '1 person' : `${people.length} people`} for ${surfaces.length === 1 ? 'your product' : 'your products'}.`];
    const asked = sources.directories.map((d) => d.platform);
    for (const platform of asked) {
      const n = people.filter((p) => (platform === 'slack' ? p.slackId : p.teamsId) !== undefined).length;
      summary.push(`Found in ${PLATFORM_NAMES[platform]}: ${n} of ${people.length}.`);
    }
    const nowhere = people.filter((p) => p.slackId === undefined && p.teamsId === undefined).map((p) => p.email ?? p.handle);
    if (asked.length > 0 && nowhere.length > 0) {
      summary.push(
        `No ${asked.map((p) => PLATFORM_NAMES[p]).join(' or ')} account matches ${listText(nowhere)}, so they stay in the map by email and Snapwing cannot mention them in chat.`,
      );
    }
    const unowned = surfaces.filter((s) => !people.some((p) => p.owns.some((o) => o.surface === s.id && o.primary)));
    if (unowned.length > 0) summary.push(`Nobody owns ${listText(unowned.map((s) => s.label))} yet, so Snapwing will not know whom to ask about bugs there.`);
    io.say(summary.join('\n'));
    return { status: 'done', data: peopleJson(people, { emails: askedEmail, teams: askedTeam }) };
  }

  return { id: 'people', number: 6, title: 'Find who owns what', needs: ['surfaces'], run };
}

export const peopleStep: OnboardStep = createPeopleStep();
