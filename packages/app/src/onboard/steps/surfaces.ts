// Onboarding step `surfaces` (main 22.2, main 4.1 and 4.3 "Auto-propose" and "Confirm"): what the
// installer's products are, which repository and Jira project each has, which product each bug
// channel is about, and which product takes the reports that fit none. The step builds a draft
// (`onboard/propose/surfaces.ts`) from what the Jira, GitHub, and chat steps recorded, shows it in
// plain words, and asks whether it is right. "No" walks through each product (keep it, rename it,
// send its tickets to another Jira project, merge it into another, or leave it out), then each
// channel, then the fallback product, and shows the result again. Nothing is kept until the
// installer says it is right; the workspace map is written later, from this step's data.
//
// On a rerun (or a resume) the saved products are checked again against what the earlier steps hold
// now, each change is named, and the result goes through the same confirmation. Without a list of
// repositories from GitHub the step asks for them. The keys this step reads and keeps are listed in
// `onboard/propose/surfaces.ts`.

import { FROM_PAYLOAD } from '@snapwing/pipeline/map/types.ts';
import type { Choice } from '../interview/io.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';
import {
  channelsFromState,
  channelText,
  cleanRepo,
  cleanText,
  componentsOf,
  finalizeSurfaces,
  jiraClientFor,
  liveSurfaces,
  parseSavedSurfaces,
  proposeSurfaces,
  readProjectDetail,
  reconcileSurfaces,
  reposFromState,
  savedSurfacesJson,
  stringList,
  uniqueId,
  type DraftChannel,
  type DraftSurface,
  type ProjectDetail,
  type SurfaceDraft,
} from '../propose/surfaces.ts';

export interface SurfacesStepDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const MAX_REPOS = 50;
const LABEL_MAX = 60;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** `a, b and c`, at most `max` items and then "and N more". */
function listText(items: readonly string[], max = 5): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}`;
}

const productChoice = (s: DraftSurface): Choice => ({ id: `product:${s.id}`, label: s.label });
const PRODUCT = 'product:';

export function createSurfacesStep(deps: SurfacesStepDeps = {}): OnboardStep {
  const fetchOpt = deps.fetch === undefined ? {} : { fetch: deps.fetch };

  /** The chosen projects' names and components from Jira; a project Jira does not answer for keeps its key as its name. */
  async function readProjects(ctx: StepContext, keys: readonly string[]): Promise<ProjectDetail[]> {
    const unread = (key: string): ProjectDetail => ({ key, name: key, components: [], unread: true });
    const client = await jiraClientFor(ctx, fetchOpt);
    if (client === undefined) {
      ctx.io.say('I could not find the Jira login, so the projects go by their keys for now.');
      return keys.map(unread);
    }
    const out: ProjectDetail[] = [];
    const failed: string[] = [];
    for (const key of keys) {
      try {
        out.push(await readProjectDetail(client, key));
      } catch {
        failed.push(key);
        out.push(unread(key));
      }
    }
    if (failed.length > 0) ctx.io.say(`Jira did not answer for ${listText(failed)}, so ${failed.length === 1 ? 'it goes' : 'they go'} by the key for now.`);
    return out;
  }

  /** The repositories, typed by the installer, when the GitHub step recorded none. */
  async function askRepos(ctx: StepContext): Promise<string[]> {
    ctx.io.say('I do not have a list of your repositories from GitHub yet.');
    let repos: string[] = [];
    await ctx.io.ask({
      id: 'repos',
      text: 'Which repositories should Snapwing fix? Type them as owner/name, separated by commas.',
      why: 'Each repository starts as one product, which you can rename, merge, or leave out next. Connecting GitHub lists them for you: snapwing onboard --step github.',
      validate: (answer) => {
        const parts = answer.split(/[\s,;]+/).filter((p) => p !== '');
        const found: string[] = [];
        for (const part of parts) {
          const repo = cleanRepo(part);
          if (repo === undefined) return `${cleanText(part, 40)} is not a repository name like acme/web.`;
          if (!found.some((r) => r.toLowerCase() === repo.toLowerCase())) found.push(repo);
        }
        if (found.length === 0) return 'Type at least one repository, like acme/web.';
        if (found.length > MAX_REPOS) return `That is more than ${MAX_REPOS}; start with the ones people report bugs about.`;
        repos = found;
        return undefined;
      },
    });
    return repos;
  }

  /** The draft in plain words. */
  function describe(draft: SurfaceDraft): string {
    const live = liveSurfaces(draft);
    const both = draft.channels.some((c) => c.platform === 'teams') && draft.channels.some((c) => c.platform === 'slack');
    const name = (c: DraftChannel): string => channelText(c.name, c.platform, both);
    const placed = (c: DraftChannel): boolean => c.surface === FROM_PAYLOAD || live.some((s) => s.id === c.surface);
    const lines = ['Products:'];
    for (const s of live) {
      const own = draft.channels.filter((c) => !c.skipped && c.surface === s.id).map(name);
      const parts = [`repository ${s.repo}`, `Jira project ${s.project}${s.guessed ? ' (a guess: no project name matched)' : ''}`];
      if (s.components.length > 0) parts.push(`Jira components ${listText(s.components.map((c) => c.label))}`);
      parts.push(own.length === 0 ? 'no channel of its own' : `${own.length === 1 ? 'channel' : 'channels'} ${own.join(', ')}`);
      lines.push(`  ${s.label}: ${parts.join('; ')}`);
    }
    const alerts = draft.channels.filter((c) => !c.skipped && c.surface === FROM_PAYLOAD).map(name);
    if (alerts.length > 0) lines.push(`Alerts, each saying which product it is about: ${alerts.join(', ')}`);
    const fallback = live.find((s) => s.id === draft.fallbackSurface) ?? live[0];
    if (fallback !== undefined) {
      lines.push(`Reports that fit no product go to ${fallback.label}.`);
      const loose = draft.channels.filter((c) => !c.skipped && !placed(c)).map(name);
      if (loose.length > 0) {
        lines.push(
          loose.length === 1
            ? `No product matched the name of ${loose[0] ?? ''}, so it goes to ${fallback.label} too.`
            : `No product matched the names of ${loose.join(', ')}, so they go to ${fallback.label} too.`,
        );
      }
    }
    const out = [...draft.surfaces.filter((s) => s.dropped).map((s) => `repository ${s.repo}`), ...draft.channels.filter((c) => c.skipped).map(name)];
    if (out.length > 0) lines.push(`Left out: ${out.join(', ')}`);
    return lines.join('\n');
  }

  /** Moves channels and the fallback from one surface id to another (`undefined` unplaces the channels). */
  function repoint(draft: SurfaceDraft, from: string, to: string | undefined): void {
    for (const c of draft.channels) {
      if (c.surface !== from) continue;
      if (to === undefined) {
        delete c.surface;
        c.matched = false;
      } else {
        c.surface = to;
      }
    }
    if (draft.fallbackSurface === from) draft.fallbackSurface = to ?? liveSurfaces(draft).find((s) => s.id !== from)?.id ?? '';
  }

  async function rename(ctx: StepContext, draft: SurfaceDraft, s: DraftSurface): Promise<void> {
    const taken = new Set(draft.surfaces.filter((o) => o !== s && !o.dropped).map((o) => o.label.toLowerCase()));
    let label = '';
    await ctx.io.ask({
      id: 'name',
      text: `What should ${s.label} be called?`,
      why: 'The name is how Snapwing and your team refer to the product, in chat and in snapwing map. It can be anything people would recognize.',
      validate: (answer) => {
        const clean = cleanText(answer, LABEL_MAX);
        if (clean === '') return 'Type a name.';
        if (taken.has(clean.toLowerCase())) return 'Another product already has that name.';
        label = clean;
        return undefined;
      },
    });
    const id = uniqueId(label, new Set(draft.surfaces.filter((o) => o !== s).map((o) => o.id)));
    if (id !== s.id) repoint(draft, s.id, id);
    s.id = id;
    s.label = label;
  }

  /** One pass over the draft: each product, each channel, and the fallback. */
  async function edit(ctx: StepContext, draft: SurfaceDraft, projects: readonly ProjectDetail[]): Promise<void> {
    const { io } = ctx;
    for (const s of [...draft.surfaces]) {
      if (s.dropped) {
        const back = await io.choose({
          id: 'restore',
          text: `${s.repo} is left out. Bring it back as a product?`,
          choices: [
            { id: 'out', label: 'No, leave it out' },
            { id: 'back', label: `Yes, bring it back as ${s.label}` },
          ],
          default: 'out',
        });
        if (back === 'back') s.dropped = false;
        continue;
      }
      const others = liveSurfaces(draft).filter((o) => o !== s);
      const choices: Choice[] = [
        { id: 'keep', label: 'Keep it as it is' },
        { id: 'rename', label: 'Rename it' },
      ];
      if (projects.length > 1) choices.push({ id: 'project', label: 'Send its tickets to another Jira project' });
      if (others.length > 0) {
        choices.push({ id: 'merge', label: 'Merge it into another product' }, { id: 'drop', label: 'Leave it out' });
      }
      const what = await io.choose({
        id: 'product',
        text: `${s.label} (repository ${s.repo}, Jira project ${s.project}${s.guessed ? ', a guess' : ''}): keep it, or change it?`,
        choices,
        default: 'keep',
        why: 'A product is one repository the fixer works in and one Jira project its tickets go to. Merging moves its channels to the other product and leaves this repository out, since a product has one repository.',
      });
      switch (what) {
        case 'keep':
          s.guessed = false;
          break;
        case 'rename':
          await rename(ctx, draft, s);
          break;
        case 'project': {
          const key = await io.choose({
            id: 'project',
            text: `Which Jira project should ${s.label}'s tickets go to?`,
            choices: projects.map((p) => ({ id: p.key, label: p.name === p.key ? p.key : `${p.key}  ${p.name}` })),
            default: s.project,
          });
          s.project = key;
          s.guessed = false;
          s.components = componentsOf(projects.find((p) => p.key === key));
          break;
        }
        case 'merge': {
          const into = await io.choose({
            id: 'merge',
            text: `Merge ${s.label} into which product?`,
            choices: others.map(productChoice),
            default: productChoice(others[0] ?? s).id,
          });
          s.dropped = true;
          repoint(draft, s.id, into.slice(PRODUCT.length));
          break;
        }
        case 'drop':
          s.dropped = true;
          repoint(draft, s.id, undefined);
          break;
      }
    }

    const live = liveSurfaces(draft);
    const both = draft.channels.some((c) => c.platform === 'teams') && draft.channels.some((c) => c.platform === 'slack');
    for (const c of draft.channels) {
      const current = c.skipped
        ? 'out'
        : c.surface === FROM_PAYLOAD
          ? 'alerts'
          : `${PRODUCT}${live.some((s) => s.id === c.surface) ? (c.surface ?? '') : draft.fallbackSurface}`;
      const pick = await io.choose({
        id: 'channel',
        text: `Which product are bugs in ${channelText(c.name, c.platform, both)} about?`,
        choices: [
          ...live.map(productChoice),
          { id: 'alerts', label: 'Alerts: each alert says which product it is about' },
          { id: 'out', label: 'Leave this channel out' },
        ],
        default: current,
        why: 'A bug posted in this channel is first assumed to be about that product, unless the message itself says otherwise.',
      });
      c.skipped = pick === 'out';
      if (pick === 'alerts') {
        c.surface = FROM_PAYLOAD;
        c.matched = true;
      } else if (pick.startsWith(PRODUCT)) {
        c.surface = pick.slice(PRODUCT.length);
        c.matched = true;
      }
    }

    if (live.length > 1) {
      const pick = await io.choose({
        id: 'fallback',
        text: 'When a report fits none of these products, which one should take it?',
        choices: live.map(productChoice),
        default: `${PRODUCT}${live.some((s) => s.id === draft.fallbackSurface) ? draft.fallbackSurface : (live[0]?.id ?? '')}`,
        why: "Its Jira project gets the ticket, and whoever watches that project can move it. Channels whose name matched no product go there too.",
      });
      draft.fallbackSurface = pick.slice(PRODUCT.length);
    } else {
      draft.fallbackSurface = live[0]?.id ?? '';
    }
  }

  async function run(ctx: StepContext): Promise<StepOutcome> {
    const { io } = ctx;
    const keys = stringList(ctx.data('jira')?.['projects']).filter((k) => PROJECT_KEY.test(k));
    if (keys.length === 0) throw new Error('no Jira projects have been chosen yet; run snapwing onboard --step jira first');
    const projects = await readProjects(ctx, keys);
    const fromGithub = reposFromState(ctx.data('github'));
    const chat = channelsFromState(ctx.data('slack'), ctx.data('teams'));

    let draft: SurfaceDraft | undefined;
    const saved = parseSavedSurfaces(ctx.data('surfaces'));
    if (saved !== undefined) {
      const reconciled = reconcileSurfaces(saved, { repos: fromGithub, projects, chat });
      if (reconciled.draft.surfaces.length > 0) {
        draft = reconciled.draft;
        io.say(
          reconciled.changes.length === 0
            ? 'These are the products you confirmed before; nothing has changed since.'
            : ['These are the products you confirmed before. Since then:', ...reconciled.changes.map((c) => `  ${c}`)].join('\n'),
        );
        // Every repository left is one the installer left out before: bring the first back, since there must be a product.
        if (liveSurfaces(draft).length === 0) {
          const first = draft.surfaces[0];
          if (first !== undefined) first.dropped = false;
        }
      }
    }
    if (draft === undefined) {
      const repos = fromGithub.length > 0 ? fromGithub : await askRepos(ctx);
      draft = proposeSurfaces({ repos, projects, channels: chat.channels });
      io.say('Here is what I think your products are, from your repositories and Jira projects.');
    }

    for (;;) {
      io.say(describe(draft));
      const answer = await io.choose({
        id: 'confirm',
        text: 'Is that right?',
        choices: [
          { id: 'yes', label: 'Yes, use this' },
          { id: 'edit', label: 'No, let me change it' },
        ],
        default: 'yes',
        why: 'Each product is one repository the fixer works in and one Jira project its tickets go to; a bug posted in a channel is first assumed to be about that channel\'s product. Nothing is kept until you say this is right, and you can change it later with snapwing onboard --step surfaces.',
      });
      if (answer === 'yes') break;
      await edit(ctx, draft, projects);
    }

    const final = finalizeSurfaces(draft);
    io.say(
      `Got it: ${plural(final.surfaces.length, 'product', 'products')} and ${plural(final.channels.length, 'channel', 'channels')}. ` +
        'They go into the workspace map when onboarding writes it.',
    );
    return { status: 'done', data: savedSurfacesJson(final) };
  }

  return { id: 'surfaces', number: 4, title: 'Name your products', needs: ['jira', 'github'], run };
}

export const surfacesStep: OnboardStep = createSurfacesStep();
