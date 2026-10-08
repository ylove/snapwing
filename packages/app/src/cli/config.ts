// `snapwing config check` (A 6.1, 6.3): validates the workspace map, the playbook, and
// INSTRUCTIONS.md the way `serve` loads them, and prints every finding. Errors (an invalid map or
// playbook, instructions over the cap) exit 1. Instruction lint findings are printed as warnings:
// the pipeline ignores an instruction where a guardrail disagrees, so they do not fail the check.
//
//   snapwing config check [--map <file>] [--playbook <file>] [--instructions <file>]

import { parseArgs } from 'node:util';
import { lintInstructions, loadInstructions, type InstructionsLintPlaybook } from '@snapwing/pipeline/config/instructions.ts';
import { defaultPlaybook, loadPlaybook } from '@snapwing/pipeline/config/playbook.ts';
import { InvalidMapError, parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { DEFAULT_MAP_FILE } from '../server/compose.ts';
import { DEFAULT_INSTRUCTIONS_FILE, DEFAULT_PLAYBOOK_FILE, formatLintFinding, formatPlaybookErrors, readOptional } from '../server/config-watch.ts';
import type { CliIo } from './state.ts';

export const CONFIG_USAGE = `Usage: snapwing config check [--map <file>] [--playbook <file>] [--instructions <file>]

  --map <file>           workspace map; default $SNAPWING_MAP, else workspace-context.xml
  --playbook <file>      playbook; default $SNAPWING_PLAYBOOK, else playbook.xml (absent is the default playbook)
  --instructions <file>  instructions; default $SNAPWING_INSTRUCTIONS, else INSTRUCTIONS.md (absent is none)

Prints every finding. Exits 1 on an error (invalid map or playbook, instructions over the cap);
instruction lint findings are warnings.`;

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** Runs `snapwing config <args>` and returns the exit code. */
export async function runConfig(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    io.stdout(CONFIG_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'check') {
    io.stderr(`snapwing config: unknown subcommand ${JSON.stringify(sub)}\n${CONFIG_USAGE}`);
    return 1;
  }
  let values;
  try {
    values = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        map: { type: 'string' },
        playbook: { type: 'string' },
        instructions: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (e) {
    io.stderr(`snapwing config check: ${e instanceof Error ? e.message : String(e)}\n${CONFIG_USAGE}`);
    return 1;
  }
  if (values.help) {
    io.stdout(CONFIG_USAGE);
    return 0;
  }
  const mapPath = values.map ?? nonEmpty(io.env['SNAPWING_MAP']) ?? DEFAULT_MAP_FILE;
  const playbookPath = values.playbook ?? nonEmpty(io.env['SNAPWING_PLAYBOOK']) ?? DEFAULT_PLAYBOOK_FILE;
  const instructionsPath = values.instructions ?? nonEmpty(io.env['SNAPWING_INSTRUCTIONS']) ?? DEFAULT_INSTRUCTIONS_FILE;

  let errors = 0;
  let warnings = 0;
  const error = (line: string): void => {
    errors += 1;
    io.stdout(`error: ${line}`);
  };
  const warn = (line: string): void => {
    warnings += 1;
    io.stdout(`warning: ${line}`);
  };

  // Map.
  let map: WorkspaceMap | undefined;
  const mapXml = await readOptional(mapPath);
  if (mapXml === undefined) {
    error(`${mapPath}: no such file`);
  } else {
    try {
      map = await parseWorkspaceMap(mapXml);
      io.stdout(`ok: ${mapPath} (${map.surfaces.length} surfaces)`);
    } catch (e) {
      if (e instanceof InvalidMapError) {
        for (const err of e.errors) error(`${mapPath}${err.line === undefined ? '' : ` line ${err.line}`}: ${err.message}`);
      } else {
        error(`${mapPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Playbook (needs the map: its references resolve against it).
  let playbook: InstructionsLintPlaybook = defaultPlaybook();
  const playbookXml = await readOptional(playbookPath);
  if (playbookXml === undefined) {
    io.stdout(`ok: ${playbookPath} is absent; the default playbook applies`);
  } else if (map === undefined) {
    warn(`${playbookPath} not checked: it needs a valid map`);
  } else {
    const result = await loadPlaybook(playbookXml, map);
    if (result.ok) {
      playbook = result.playbook;
      io.stdout(`ok: ${playbookPath}`);
    } else {
      for (const line of formatPlaybookErrors(result.errors)) error(`${playbookPath} ${line}`);
    }
  }

  // Instructions: the cap, then the lint.
  const instructionsText = await readOptional(instructionsPath);
  if (instructionsText === undefined) {
    io.stdout(`ok: ${instructionsPath} is absent; no workspace instructions`);
  } else {
    const loaded = loadInstructions(instructionsText);
    if (!loaded.ok) {
      error(`${instructionsPath}: ${loaded.reason}`);
    } else if (loaded.instructions === undefined) {
      io.stdout(`ok: ${instructionsPath} is empty; no workspace instructions`);
    } else {
      io.stdout(`ok: ${instructionsPath} (${loaded.instructions.characters} characters)`);
      if (map === undefined) {
        warn(`${instructionsPath} not linted: the lint needs a valid map`);
      } else {
        for (const f of lintInstructions(instructionsText, playbook, map)) warn(`${instructionsPath} ${formatLintFinding(f)}`);
      }
    }
  }

  io.stdout(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return errors > 0 ? 1 : 0;
}
