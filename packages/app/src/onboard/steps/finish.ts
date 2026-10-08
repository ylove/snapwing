// Onboarding step `finish` (main 4.3 "Validate and deploy", main 22.2): puts the confirmed tables
// together, writes `workspace-context.xml` with `writeWorkspaceMap`, and checks it before anything
// reaches the disk. `writeWorkspaceMap` runs the XSD and then the Schematron; an invalid map names
// the step to go back to and writes nothing. After the write it runs the same checks as
// `snapwing config check`, offers the installer a capture token, and prints `snapwing map show`.
//
// Reads (interview state, by step id; each is the map fragment the step confirmed):
//   surfaces: { org?, surfaces: MapSurface[], channels: MapChannel[], fallbackSurface? }
//   words:    { vocabulary: MapTerm[] }
//   people:   { people: MapPerson[] }
//   trigger:  { emoji, channelOverrides }        (see trigger.ts; default bug when the step left nothing)
//   autonomy: { default, changedBy, changedAt, overrides }   (see autonomy.ts; default Ask)
//   jira:     { site }                           only to name the workspace when `surfaces.org` is absent

import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidationError } from '@snapwing/pipeline/schemas/validate.ts';
import { writeWorkspaceMap } from '@snapwing/pipeline/map/write.ts';
import type {
  AutonomyLevel,
  AutonomyLevelId,
  AutonomyOverride,
  MapChannel,
  MapPerson,
  MapSurface,
  MapTerm,
  WorkspaceMap,
} from '@snapwing/pipeline/map/types.ts';
import type { JsonValue } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';

const MAP_FILE = 'workspace-context.xml';

/** The four levels, as in the example map. */
const LEVELS: readonly AutonomyLevel[] = [
  { id: 0, name: 'ticket-only', fixer: 'never', merge: 'none', requires: [] },
  { id: 1, name: 'fix-on-tap', fixer: 'on-tap', merge: 'human', requires: [] },
  { id: 2, name: 'fix-now', fixer: 'immediate', merge: 'human', requires: [] },
  { id: 3, name: 'autopilot', fixer: 'immediate', merge: 'agent', requires: ['review-agent', 'ci-green', 'risk-gate'] },
];

/** Which earlier step owns a failed rule, so the message can send the installer back to it. */
const RULE_STEP: Readonly<Record<string, string>> = {
  'channel-surface-exists': 'surfaces',
  'channel-teams-needs-team': 'surfaces',
  'channel-slack-has-no-team': 'surfaces',
  'fallback-surface-exists': 'surfaces',
  'owns-surface-exists': 'people',
  'owns-component-exists': 'people',
  'override-surface-ref': 'autonomy',
  'override-component-surface': 'autonomy',
  'override-component-ref': 'autonomy',
};

/** The step to fix for a validation error: by its Schematron rule, else by what the message names. */
export function stepForError(error: ValidationError): string {
  if (error.rule !== undefined && RULE_STEP[error.rule] !== undefined) return RULE_STEP[error.rule] as string;
  const m = error.message.toLowerCase();
  if (/\b(autonomy|level|override)/.test(m)) return 'autonomy';
  if (/\b(emoji|trigger|minreactors)/.test(m)) return 'trigger';
  if (/\b(person|people|owns|handle|slackid|teamsid)/.test(m)) return 'people';
  if (/\b(term|vocabulary)/.test(m)) return 'words';
  return 'surfaces';
}

type Obj = { readonly [k: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: JsonValue | undefined): v is string => typeof v === 'string' && v !== '';

/** A fragment's rows, or the step to go back to when one is malformed. */
function rows<T>(owner: string, raw: JsonValue | undefined, ok: (r: Obj) => boolean): { rows: T[] } | { bad: string } {
  if (raw === undefined) return { rows: [] };
  if (!Array.isArray(raw) || !raw.every((r) => isObj(r) && ok(r))) return { bad: owner };
  return { rows: raw as unknown as T[] };
}

const surfaceOk = (s: Obj): boolean =>
  str(s['id']) && str(s['label']) && str(s['repo']) && isObj(s['jira']) && str(s['jira']['project']) && str(s['jira']['defaultIssueType']) && Array.isArray(s['components']);
const channelOk = (c: Obj): boolean => str(c['id']) && str(c['name']) && str(c['surface']);
const termOk = (t: Obj): boolean => str(t['text']) && str(t['surface']);
const personOk = (p: Obj): boolean => str(p['handle']) && str(p['role']) && Array.isArray(p['owns']);

interface Gathered {
  readonly map?: WorkspaceMap;
  readonly problem?: { readonly step: string; readonly why: string };
}

function gather(ctx: StepContext): Gathered {
  const surfaces = ctx.data('surfaces');
  if (surfaces === undefined) return { problem: { step: 'surfaces', why: 'no confirmed products and channels were saved' } };
  const s = rows<MapSurface>('surfaces', surfaces['surfaces'], surfaceOk);
  const c = rows<MapChannel>('surfaces', surfaces['channels'], channelOk);
  const t = rows<MapTerm>('words', ctx.data('words')?.['vocabulary'], termOk);
  const p = rows<MapPerson>('people', ctx.data('people')?.['people'], personOk);
  for (const r of [s, c, t, p]) if ('bad' in r) return { problem: { step: r.bad, why: 'what it saved could not be read' } };
  const [surfaceRows, channelRows, termRows, personRows] = [s, c, t, p].map((r) => ('rows' in r ? r.rows : [])) as [MapSurface[], MapChannel[], MapTerm[], MapPerson[]];
  if (surfaceRows.length === 0) return { problem: { step: 'surfaces', why: 'no products were confirmed' } };

  // Channel reactions from the trigger step replace the workspace ones in that channel.
  const trigger = ctx.data('trigger');
  const emoji = Array.isArray(trigger?.['emoji'])
    ? trigger['emoji'].filter(isObj).filter((e) => str(e['slack']) && str(e['teams'])).map((e) => ({
        slack: e['slack'] as string,
        teams: e['teams'] as string,
        ...(typeof e['minReactors'] === 'number' ? { minReactors: e['minReactors'] } : {}),
      }))
    : [];
  const overrides = new Map<string, string[]>();
  for (const o of Array.isArray(trigger?.['channelOverrides']) ? trigger['channelOverrides'] : []) {
    if (isObj(o) && str(o['channel']) && Array.isArray(o['emoji'])) overrides.set(o['channel'], o['emoji'].filter(str));
  }
  const channels = channelRows.map((ch) => ({ ...ch, triggerEmoji: overrides.get(ch.id) ?? (Array.isArray(ch.triggerEmoji) ? ch.triggerEmoji : []) }));

  const autonomy = ctx.data('autonomy');
  const level = (v: JsonValue | undefined): AutonomyLevelId | undefined => (v === 0 || v === 1 || v === 2 || v === 3 ? v : undefined);
  const savedOverrides: AutonomyOverride[] = [];
  for (const o of Array.isArray(autonomy?.['overrides']) ? autonomy['overrides'] : []) {
    if (!isObj(o) || o['kind'] !== 'surface' || !str(o['ref']) || level(o['level']) === undefined) continue;
    savedOverrides.push({
      kind: 'surface',
      ref: o['ref'],
      level: level(o['level']) as AutonomyLevelId,
      ...(str(o['changedBy']) ? { changedBy: o['changedBy'] } : {}),
      ...(str(o['changedAt']) ? { changedAt: o['changedAt'] } : {}),
    });
  }

  const jiraSite = ctx.data('jira')?.['site'];
  const org = str(surfaces['org']) ? surfaces['org'] : str(jiraSite) ? (/^https?:\/\/([^.]+)\./.exec(jiraSite)?.[1] ?? 'workspace') : 'workspace';

  const map: WorkspaceMap = {
    org,
    updated: ctx.now().toISOString(),
    surfaces: surfaceRows,
    ...(str(surfaces['fallbackSurface']) ? { fallbackSurface: surfaces['fallbackSurface'] } : {}),
    channels,
    triggers: {
      messageActions: [{ label: 'Fix it from here' }],
      emoji: emoji.length > 0 ? emoji : [{ slack: 'bug', teams: 'bug' }],
      directMessage: { images: true, text: true },
      cli: { enabled: true },
    },
    vocabulary: termRows,
    people: personRows,
    policies: {
      askBack: { maxQuestionsPerIncident: 1, suppressWhenReportersAtLeast: 3 },
      autonomy: {
        default: level(autonomy?.['default']) ?? 1,
        ...(str(autonomy?.['changedBy']) ? { changedBy: autonomy['changedBy'] } : {}),
        ...(str(autonomy?.['changedAt']) ? { changedAt: autonomy['changedAt'] } : {}),
        levels: LEVELS.map((l) => ({ ...l, requires: [...l.requires] })),
        overrides: savedOverrides,
      },
      riskGate: { maxFilesTouched: 6, maxDiffLines: 300, forbiddenPaths: ['src/auth/**', 'infra/**', '**/migrations/**'] },
    },
  };
  return { map };
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Writes next to the target and renames, so a failed write never leaves half a map. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const stepHint = (id: string): string => `snapwing onboard --step ${id}`;

function blocked(ctx: StepContext, reason: string, step: string): StepOutcome {
  ctx.io.say(`${reason} Nothing was written.`);
  return { status: 'blocked', on: 'you, going back to an earlier step', reason, link: stepHint(step) };
}

/** Runs a `snapwing` subcommand in-process and says what it printed. Returns its exit code. */
async function runAndSay(ctx: StepContext, run: (io: { env: Record<string, string | undefined>; stdout: (l: string) => void; stderr: (l: string) => void }) => Promise<number>): Promise<number> {
  const env: Record<string, string | undefined> = { ...ctx.env };
  for (const key of ['SNAPWING_DB', 'DATABASE_URL', 'SNAPWING_SQLITE_PATH', 'SNAPWING_PUBLIC_URL']) {
    const v = (await ctx.readEnv(key))?.reveal();
    if (v !== undefined) env[key] = v;
  }
  if (env['SNAPWING_SQLITE_PATH'] === undefined) env['SNAPWING_SQLITE_PATH'] = join(ctx.workdir, 'snapwing.sqlite');
  return run({ env, stdout: (l) => ctx.io.say(l), stderr: (l) => ctx.io.say(l) });
}

export const finishStep: OnboardStep = {
  id: 'finish',
  number: 8,
  title: 'Write the workspace map',
  needs: ['surfaces', 'words', 'people', 'trigger', 'autonomy'],
  async run(ctx): Promise<StepOutcome> {
    const { io } = ctx;
    const path = join(ctx.workdir, MAP_FILE);

    const gathered = gather(ctx);
    if (gathered.map === undefined) {
      const p = gathered.problem as { step: string; why: string };
      return blocked(ctx, `The map cannot be written yet: ${p.why}. Run \`${stepHint(p.step)}\` and try again.`, p.step);
    }

    io.say('Putting your answers together and checking them.');
    const written = await writeWorkspaceMap(gathered.map);
    if (!written.ok) {
      const steps = [...new Set(written.errors.map(stepForError))];
      for (const e of written.errors) io.say(`  ${e.message} (go back to: ${stepForError(e)})`);
      const first = steps[0] as string;
      return blocked(ctx, `The map did not pass its checks. Run \`${stepHint(first)}\`${steps.length > 1 ? `, then ${steps.slice(1).map((s) => `\`${stepHint(s)}\``).join(', ')},` : ''} and try again.`, first);
    }

    if (await exists(path)) {
      const keep = await io.choose({
        id: 'replace',
        text: `${MAP_FILE} already exists. Replace it with this one?`,
        choices: [
          { id: 'replace', label: 'Replace it' },
          { id: 'keep', label: 'Keep the existing file' },
        ],
        default: 'replace',
        why: 'Replacing loses any change made since with snapwing map set-level or set-trigger. Keeping it leaves the new answers unsaved.',
      });
      if (keep === 'keep') {
        io.say(`Kept the existing ${MAP_FILE}.`);
        return { status: 'done', data: { map: MAP_FILE, written: false } };
      }
    }
    await writeAtomic(path, written.xml);
    io.say(`Saved ${MAP_FILE} (${gathered.map.surfaces.length} products, ${gathered.map.channels.length} channels, ${gathered.map.people.length} people).`);

    // The same checks as `snapwing config check`, on the file as it is now on disk.
    const { runConfig } = await import('../../cli/config.ts');
    const checkCode = await runAndSay(ctx, (cli) =>
      runConfig(
        [
          'check',
          '--map', path,
          '--playbook', ctx.env['SNAPWING_PLAYBOOK']?.trim() || join(ctx.workdir, 'playbook.xml'),
          '--instructions', ctx.env['SNAPWING_INSTRUCTIONS']?.trim() || join(ctx.workdir, 'INSTRUCTIONS.md'),
        ],
        cli,
      ),
    );

    // A capture token for the installer, shown once.
    const handles = gathered.map.people.map((p) => p.handle);
    let tokenFor: string | undefined;
    if (handles.length > 0) {
      const who = await io.choose({
        id: 'token',
        text: 'Make a capture token so someone can send reports from the command line? It is shown once.',
        choices: [{ id: 'none', label: 'Not now' }, ...handles.map((h) => ({ id: h, label: `For ${h}` }))],
        default: 'none',
        why: 'A capture token lets one person send screenshots and notes with snapwing send. You can make more later with snapwing token issue <handle>.',
      });
      if (who !== 'none') {
        const { runToken } = await import('../../cli/token.ts');
        const code = await runAndSay(ctx, (cli) => runToken(['issue', who, '--label', 'onboarding', '--map', path], cli));
        if (code === 0) tokenFor = who;
      }
    }

    const { runMap } = await import('../../cli/map.ts');
    io.say('This is the map, as `snapwing map show` prints it:');
    await runAndSay(ctx, (cli) => runMap(['show', '--map', path], cli));

    if (checkCode !== 0) {
      return { status: 'blocked', on: 'you, fixing what the check found', reason: 'the saved map has errors the check reported above', link: 'snapwing config check' };
    }
    return {
      status: 'done',
      data: {
        map: MAP_FILE,
        written: true,
        surfaces: gathered.map.surfaces.length,
        channels: gathered.map.channels.length,
        people: gathered.map.people.length,
        ...(tokenFor === undefined ? {} : { tokenFor }),
      },
    };
  },
};
