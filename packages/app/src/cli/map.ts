// `snapwing map ...` (main 20.3, 4.6, 22.2): read and edit the workspace map from the terminal.
//
//   snapwing map show [surfaces|channels|lexicon|people|triggers] [--xml] [--map <file>]
//   snapwing map set-level <surface> <0-3> [--by <who>] [--map <file>]
//   snapwing map set-trigger --emoji <name> [--channel <name>] [--platform slack|teams] [--by <who>] [--map <file>]
//
// Edits go through `editWorkspaceMap` (XSD, then Schematron), record `changedBy` and `changedAt` on the
// autonomy override, set the root's `updated`, and write atomically (a temp file in the same directory,
// then a rename). An invalid edit writes nothing and exits 1. The schema has no change record on a
// trigger row, so `set-trigger` stamps the root's `updated` and prints who and when.

import { execFileSync } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { editWorkspaceMap, type MapEdit } from '@snapwing/pipeline/map/write.ts';
import { InvalidMapError, parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import { channelPlatform, type AutonomyLevelId, type ChannelPlatform, type WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { DEFAULT_MAP_FILE } from '../server/compose.ts';
import type { CliIo } from './state.ts';

export const MAP_USAGE = `Usage: snapwing map show [surfaces|channels|lexicon|people|triggers] [--xml]
       snapwing map set-level <surface> <0-3> [--by <who>]
       snapwing map set-trigger --emoji <name> [--channel <name>] [--platform slack|teams] [--by <who>]

  show          readable tables; --xml prints the map file as it is
  set-level     set a surface's autonomy level (0 ticket-only, 1 fix-on-tap, 2 fix-now, 3 autopilot)
  set-trigger   add or change a trigger emoji: a workspace row, or with --channel that channel's override
  --by <who>    who made the change; default the git user email, else the OS user
  --map <file>  workspace map; default $SNAPWING_MAP, else workspace-context.xml

An edit is validated against the schemas before anything is written; an invalid edit changes nothing and exits 1.`;

const SECTIONS = ['surfaces', 'channels', 'lexicon', 'people', 'triggers'] as const;
type Section = (typeof SECTIONS)[number];

/** What the edit commands read from the machine; tests replace them. */
export interface MapHooks {
  /** `git config user.email`, undefined when git has none. */
  readonly gitEmail?: () => string | undefined;
  readonly osUser?: () => string;
  readonly now?: () => Date;
}

function defaultGitEmail(): string | undefined {
  try {
    const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return email === '' ? undefined : email;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** Runs `snapwing map <args>` and returns the exit code. */
export async function runMap(args: readonly string[], io: CliIo, hooks: MapHooks = {}): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    io.stdout(MAP_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub === 'show') return runShow(rest, io);
  if (sub === 'set-level') return runSetLevel(rest, io, hooks);
  if (sub === 'set-trigger') return runSetTrigger(rest, io, hooks);
  io.stderr(`snapwing map: unknown subcommand ${JSON.stringify(sub)}\n${MAP_USAGE}`);
  return 1;
}

function mapPathFor(io: CliIo, flag: string | undefined): string {
  return resolve(flag ?? nonEmpty(io.env['SNAPWING_MAP']) ?? DEFAULT_MAP_FILE);
}

async function readMapFile(path: string, io: CliIo, what: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : e instanceof Error ? e.message : String(e);
    io.stderr(`snapwing map ${what}: cannot read ${path}: ${why}`);
    return undefined;
  }
}

type Parsed =
  | { ok: true; values: Record<string, string | boolean | undefined>; positionals: string[] }
  | { ok: false; code: number };

function parse(args: readonly string[], io: CliIo, what: string, options: Record<string, { type: 'string' | 'boolean' }>): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...options, map: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
    });
    if (values['help'] === true) {
      io.stdout(MAP_USAGE);
      return { ok: false, code: 0 };
    }
    return { ok: true, values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (e) {
    io.stderr(`snapwing map ${what}: ${e instanceof Error ? e.message : String(e)}\n${MAP_USAGE}`);
    return { ok: false, code: 1 };
  }
}

// show

async function runShow(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(args, io, 'show', { xml: { type: 'boolean' } });
  if (!parsed.ok) return parsed.code;
  const [section, ...extra] = parsed.positionals;
  if (extra.length > 0 || (section !== undefined && !(SECTIONS as readonly string[]).includes(section))) {
    io.stderr(`snapwing map show: expected one of ${SECTIONS.join(', ')}\n${MAP_USAGE}`);
    return 1;
  }
  const path = mapPathFor(io, parsed.values['map'] as string | undefined);
  const xml = await readMapFile(path, io, 'show');
  if (xml === undefined) return 1;
  if (parsed.values['xml'] === true) {
    io.stdout(xml.trimEnd());
    return 0;
  }
  let map: WorkspaceMap;
  try {
    map = await parseWorkspaceMap(xml);
  } catch (e) {
    if (e instanceof InvalidMapError) {
      for (const err of e.errors) io.stderr(`${path}${err.line === undefined ? '' : ` line ${err.line}`}: ${err.message}`);
    } else {
      io.stderr(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return 1;
  }
  const wanted = section === undefined ? SECTIONS : [section as Section];
  io.stdout(wanted.map((s) => `${s}\n${renderSection(map, s)}`).join('\n\n'));
  return 0;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '  (none)';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string => `  ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** A surface's level: its override, else the default. */
function surfaceLevel(map: WorkspaceMap, surface: string): AutonomyLevelId {
  const { autonomy } = map.policies;
  const o = autonomy.overrides.find((x) => x.kind === 'surface' && x.ref === surface);
  return o?.level ?? autonomy.default;
}

function renderSection(map: WorkspaceMap, section: Section): string {
  switch (section) {
    case 'surfaces':
      return table(
        ['id', 'label', 'repo', 'jira', 'level', 'changed', 'components'],
        map.surfaces.map((s) => {
          const o = map.policies.autonomy.overrides.find((x) => x.kind === 'surface' && x.ref === s.id);
          const changed = o === undefined ? '' : [o.changedBy, o.changedAt].filter((x) => x !== undefined).join(' ');
          return [s.id, s.label, s.repo, s.jira.project, String(surfaceLevel(map, s.id)), changed, s.components.map((c) => c.id).join(', ')];
        }),
      );
    case 'channels':
      return table(
        ['name', 'platform', 'surface', 'confidence', 'trigger emoji', 'id'],
        map.channels.map((c) => [c.name, channelPlatform(c), c.surface, c.confidence ?? '', c.triggerEmoji.join(', '), c.id]),
      );
    case 'lexicon':
      return table(
        ['term', 'surface', 'component'],
        map.vocabulary.map((t) => [t.text, t.surface, t.component ?? '']),
      );
    case 'people':
      return table(
        ['handle', 'role', 'email', 'slack', 'teams', 'owns'],
        map.people.map((p) => [
          p.handle,
          p.role,
          p.email ?? '',
          p.slackId ?? '',
          p.teamsId ?? '',
          p.owns.map((o) => `${o.surface}${o.component === undefined ? '' : `/${o.component}`}${o.primary ? '*' : ''}`).join(', '),
        ]),
      );
    case 'triggers': {
      const t = map.triggers;
      const rows: string[][] = [
        ...t.messageActions.map((m) => ['message action', m.label, '']),
        ...t.emoji.map((e) => ['emoji', `slack ${e.slack}, teams ${e.teams}`, e.minReactors === undefined ? '' : `${e.minReactors} reactors`]),
      ];
      if (t.directMessage) rows.push(['direct message', `images ${t.directMessage.images}, text ${t.directMessage.text}`, '']);
      if (t.cli) rows.push(['cli', t.cli.enabled ? 'enabled' : 'disabled', '']);
      return table(['kind', 'value', 'note'], rows);
    }
  }
}

// edits

/** `--by`, else the git user email, else the OS user. */
function changedByFor(by: string | undefined, hooks: MapHooks): string {
  const git = hooks.gitEmail === undefined ? defaultGitEmail() : hooks.gitEmail();
  return nonEmpty(by) ?? git ?? (hooks.osUser ?? (() => userInfo().username))();
}

/** Applies one edit to the map file: validate, then write atomically. Nothing changes on an invalid edit. */
async function applyEdit(path: string, xml: string, edit: MapEdit, changedAt: string, io: CliIo, what: string): Promise<number> {
  const result = await editWorkspaceMap(xml, [edit], { updated: changedAt });
  if (!result.ok) {
    for (const err of result.errors) io.stderr(`snapwing map ${what}: ${err.message}${err.rule === undefined ? '' : ` [${err.rule}]`}`);
    io.stderr(`${path} is unchanged.`);
    return 1;
  }
  const tmp = join(dirname(path), `.${process.pid}-${Date.now()}.snapwing-map.tmp`);
  try {
    await writeFile(tmp, result.xml, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    io.stderr(`snapwing map ${what}: cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return 0;
}

async function runSetLevel(args: readonly string[], io: CliIo, hooks: MapHooks): Promise<number> {
  const parsed = parse(args, io, 'set-level', { by: { type: 'string' } });
  if (!parsed.ok) return parsed.code;
  const [surface, levelText, ...extra] = parsed.positionals;
  if (surface === undefined || levelText === undefined || extra.length > 0) {
    io.stderr(`snapwing map set-level: give a surface and a level\n${MAP_USAGE}`);
    return 1;
  }
  if (!/^[0-3]$/.test(levelText)) {
    io.stderr(`snapwing map set-level: the level is 0, 1, 2, or 3, not ${JSON.stringify(levelText)}`);
    return 1;
  }
  const level = Number(levelText) as AutonomyLevelId;
  const path = mapPathFor(io, parsed.values['map'] as string | undefined);
  const xml = await readMapFile(path, io, 'set-level');
  if (xml === undefined) return 1;
  const changedAt = (hooks.now?.() ?? new Date()).toISOString();
  const changedBy = changedByFor(parsed.values['by'] as string | undefined, hooks);
  const code = await applyEdit(path, xml, { kind: 'setSurfaceLevel', surface, level, changedBy, changedAt }, changedAt, io, 'set-level');
  if (code === 0) io.stdout(`${surface} is now level ${level} (changed by ${changedBy} at ${changedAt})`);
  return code;
}

async function runSetTrigger(args: readonly string[], io: CliIo, hooks: MapHooks): Promise<number> {
  const parsed = parse(args, io, 'set-trigger', {
    emoji: { type: 'string' },
    channel: { type: 'string' },
    platform: { type: 'string' },
    by: { type: 'string' },
  });
  if (!parsed.ok) return parsed.code;
  const emoji = nonEmpty(parsed.values['emoji'] as string | undefined)?.replace(/^:(.*):$/, '$1');
  const channelName = nonEmpty(parsed.values['channel'] as string | undefined)?.replace(/^#/, '');
  const platform = parsed.values['platform'] as string | undefined;
  if (emoji === undefined || parsed.positionals.length > 0) {
    io.stderr(`snapwing map set-trigger: --emoji <name> is required\n${MAP_USAGE}`);
    return 1;
  }
  if (!/^[A-Za-z0-9_+-]+$/.test(emoji)) {
    io.stderr(`snapwing map set-trigger: ${JSON.stringify(emoji)} is not a reaction name (letters, digits, _, +, -; no colons)`);
    return 1;
  }
  if (platform !== undefined && platform !== 'slack' && platform !== 'teams') {
    io.stderr(`snapwing map set-trigger: --platform is slack or teams, not ${JSON.stringify(platform)}`);
    return 1;
  }
  const path = mapPathFor(io, parsed.values['map'] as string | undefined);
  const xml = await readMapFile(path, io, 'set-trigger');
  if (xml === undefined) return 1;

  let edit: MapEdit;
  if (channelName === undefined) {
    // A workspace row is keyed by its Slack name; on Teams the name goes in the row's teams attribute.
    edit = platform === 'teams' ? { kind: 'setTriggerEmoji', emoji, teams: emoji } : { kind: 'setTriggerEmoji', emoji };
  } else {
    let map: WorkspaceMap;
    try {
      map = await parseWorkspaceMap(xml);
    } catch (e) {
      io.stderr(`snapwing map set-trigger: ${path} is not a valid map: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const matches = map.channels.filter((c) => c.name === channelName && (platform === undefined || channelPlatform(c) === (platform as ChannelPlatform)));
    const [only, ...others] = matches;
    if (only === undefined) {
      io.stderr(`snapwing map set-trigger: no channel named ${JSON.stringify(channelName)}${platform === undefined ? '' : ` on ${platform}`} in the map`);
      return 1;
    }
    if (others.length > 0) {
      io.stderr(`snapwing map set-trigger: ${JSON.stringify(channelName)} names channels on more than one platform; add --platform slack|teams`);
      return 1;
    }
    edit = { kind: 'setTriggerEmoji', emoji, channel: only.id };
  }
  const changedAt = (hooks.now?.() ?? new Date()).toISOString();
  const code = await applyEdit(path, xml, edit, changedAt, io, 'set-trigger');
  if (code === 0) {
    const by = changedByFor(parsed.values['by'] as string | undefined, hooks);
    io.stdout(`${emoji} is now a trigger${channelName === undefined ? '' : ` in ${channelName}`} (changed by ${by} at ${changedAt})`);
  }
  return code;
}
