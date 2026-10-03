// Hot reload of `playbook.xml` and `INSTRUCTIONS.md` (Companion A 6.1, 6.3).
//
// `createConfigWatch` loads both files once, then watches their directories. A changed file is read,
// validated (the playbook against the XSD and Schematron with the current map, the instructions against
// the 4,000 character cap), and swapped in whole. An invalid file is rejected with the reason logged and
// the previous version stays live. Components never hold a copy: they call `playbook()` and
// `instructions()` on every use, so a swap reaches the next call.
//
// Startup differs from a reload in one way: a playbook that is present and invalid refuses to start
// (there is no previous version to fall back to). A missing file is the default playbook and no
// instructions. An instructions file over the cap at startup is logged and treated as absent.

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { defaultPlaybook, loadPlaybook, type Playbook, type PlaybookError } from '@snapwing/pipeline/config/playbook.ts';
import {
  lintInstructions,
  loadInstructions,
  type InstructionsLintFinding,
  type WorkspaceInstructions,
} from '@snapwing/pipeline/config/instructions.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';

export const DEFAULT_PLAYBOOK_FILE = 'playbook.xml';
export const DEFAULT_INSTRUCTIONS_FILE = 'INSTRUCTIONS.md';
/** Editors write a file in several events; reload once after they settle. */
export const CONFIG_WATCH_DEBOUNCE_MS = 150;

export interface ConfigWatchLog {
  info(line: string): void;
  error(line: string): void;
}

export interface ConfigWatchOptions {
  playbookPath: string;
  instructionsPath: string;
  /** The current map; the playbook's references resolve against it. */
  getMap: () => Promise<WorkspaceMap>;
  log: ConfigWatchLog;
  /** Called with the text of every playbook file that validated and went live (the config cache keeps it for the notification policy). */
  onPlaybook?: (xml: string) => Promise<void>;
  debounceMs?: number;
  /** Test seam: replaces `fs.watch` on a directory. */
  watch?: (dir: string, onChange: (filename: string | null) => void) => { close(): void };
}

export type ConfigFile = 'playbook' | 'instructions';

export interface ConfigWatch {
  /** The live playbook. Call on every use; never keep the result. */
  playbook(): Playbook;
  /** The live instructions, or undefined when there are none. Call on every use. */
  instructions(): WorkspaceInstructions | undefined;
  /** Start watching both files. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-read one file now (what a change event does). Resolves true when the file was applied. */
  reload(file: ConfigFile): Promise<boolean>;
}

/** Playbook errors as one line each, for logs and `config check`. */
export function formatPlaybookErrors(errors: readonly PlaybookError[]): string[] {
  return errors.map((e) => `[${e.rule}]${e.line === undefined ? '' : ` line ${e.line}`}: ${e.message}`);
}

/** One lint finding as a line for logs and `config check`. */
export function formatLintFinding(f: InstructionsLintFinding): string {
  return `[${f.rule}] line ${f.line}: "${f.instruction}" conflicts with ${f.source}: ${f.conflict}`;
}

/** Reads a file, `undefined` when it does not exist. */
export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function defaultWatch(dir: string, onChange: (filename: string | null) => void): FSWatcher {
  return fsWatch(dir, { persistent: false }, (_event, filename) => onChange(filename === null ? null : String(filename)));
}

export async function createConfigWatch(options: ConfigWatchOptions): Promise<ConfigWatch> {
  const { getMap, log } = options;
  const playbookPath = resolve(options.playbookPath);
  const instructionsPath = resolve(options.instructionsPath);
  const debounceMs = options.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS;
  const watchDir = options.watch ?? defaultWatch;

  let currentPlaybook: Playbook = defaultPlaybook();
  let currentInstructions: WorkspaceInstructions | undefined;

  async function lint(text: string): Promise<void> {
    const findings = lintInstructions(text, currentPlaybook, await getMap());
    for (const f of findings) log.info(`INSTRUCTIONS.md lint: ${formatLintFinding(f)}`);
  }

  async function loadPlaybookFile(startup: boolean): Promise<boolean> {
    const xml = await readOptional(playbookPath);
    if (xml === undefined) {
      if (!startup) log.info(`${playbookPath} is gone; the previous playbook stays live`);
      return false;
    }
    const result = await loadPlaybook(xml, await getMap());
    if (!result.ok) {
      const lines = formatPlaybookErrors(result.errors);
      if (startup) throw new Error(`invalid playbook ${playbookPath}:\n${lines.join('\n')}`);
      log.error(`playbook ${playbookPath} rejected, the previous version stays live: ${lines.join('; ')}`);
      return false;
    }
    currentPlaybook = result.playbook;
    await options.onPlaybook?.(xml);
    log.info(`playbook ${playbookPath} ${startup ? 'loaded' : 'reloaded'}`);
    if (currentInstructions !== undefined) await lint(currentInstructions.text);
    return true;
  }

  async function loadInstructionsFile(startup: boolean): Promise<boolean> {
    const text = await readOptional(instructionsPath);
    const loaded = loadInstructions(text ?? null, currentInstructions);
    if (!loaded.ok) {
      log.error(`INSTRUCTIONS.md ${instructionsPath} rejected${startup ? ', starting without it' : ', the previous version stays live'}: ${loaded.reason}`);
      return false;
    }
    currentInstructions = loaded.instructions;
    log.info(`INSTRUCTIONS.md ${instructionsPath} ${startup ? 'loaded' : 'reloaded'}${loaded.instructions === undefined ? ' (empty)' : ` (${loaded.instructions.characters} characters)`}`);
    if (loaded.instructions !== undefined) await lint(loaded.instructions.text);
    return true;
  }

  await loadPlaybookFile(true);
  await loadInstructionsFile(true);

  // Reloads run one at a time, so two quick edits cannot swap out of order.
  let queue: Promise<unknown> = Promise.resolve();
  function reload(file: ConfigFile): Promise<boolean> {
    const run = queue.then(async () => {
      try {
        return file === 'playbook' ? await loadPlaybookFile(false) : await loadInstructionsFile(false);
      } catch (e) {
        log.error(`reloading the ${file} failed, the previous version stays live: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    });
    queue = run;
    return run;
  }

  const watchers: { close(): void }[] = [];
  const timers = new Map<ConfigFile, NodeJS.Timeout>();

  function schedule(file: ConfigFile): void {
    const pending = timers.get(file);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        void reload(file);
      }, debounceMs),
    );
  }

  return {
    playbook: () => currentPlaybook,
    instructions: () => currentInstructions,
    reload,
    async start() {
      if (watchers.length > 0) return;
      const targets: { file: ConfigFile; dir: string; name: string }[] = [
        { file: 'playbook', dir: dirname(playbookPath), name: basename(playbookPath) },
        { file: 'instructions', dir: dirname(instructionsPath), name: basename(instructionsPath) },
      ];
      for (const dir of new Set(targets.map((t) => t.dir))) {
        watchers.push(
          watchDir(dir, (filename) => {
            // A null filename (some platforms) means "something in the directory changed".
            for (const t of targets) if (t.dir === dir && (filename === null || filename === t.name)) schedule(t.file);
          }),
        );
      }
      log.info(`watching ${playbookPath} and ${instructionsPath}`);
    },
    async stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers.splice(0)) w.close();
      await queue;
    },
  };
}
