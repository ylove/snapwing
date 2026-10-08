// `snapwing map show | set-level | set-trigger`: each command on a temp copy of the example map,
// and the invalid edit that changes nothing.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import { main } from '../../src/cli/main.ts';
import { runMap, type MapHooks } from '../../src/cli/map.ts';

const exampleXml = await readFile(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T12:00:00.000Z');

let dir: string;
let mapPath: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-cli-map-'));
  mapPath = join(dir, 'workspace-context.xml');
  await writeFile(mapPath, exampleXml);
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = (): { env: Record<string, string>; stdout: (l: string) => void; stderr: (l: string) => void } => ({
  env: {},
  stdout: (l) => out.push(l),
  stderr: (l) => err.push(l),
});

const hooks = (over: MapHooks = {}): MapHooks => ({ gitEmail: () => 'git@example.test', osUser: () => 'osuser', now: () => NOW, ...over });
const run = (args: string[], over: MapHooks = {}): Promise<number> => runMap([...args, '--map', mapPath], io(), hooks(over));
const text = (lines: string[]): string => lines.join('\n');
const onDisk = (): Promise<string> => readFile(mapPath, 'utf8');

describe('map show', () => {
  it('prints readable tables for every section, and one section on request', async () => {
    expect(await run(['show'])).toBe(0);
    const all = text(out);
    for (const heading of ['surfaces', 'channels', 'lexicon', 'people', 'triggers']) expect(all).toContain(`${heading}\n`);
    expect(all).toMatch(/id\s+label\s+repo\s+jira\s+level/);
    expect(all).toMatch(/web\s+Website\s+github\.com\/acme\/web\s+WEB\s+2/);
    expect(all).toMatch(/mobile\s+Mobile App\s+github\.com\/acme\/mobile\s+APP\s+1/);
    expect(all).not.toContain('<surface');

    out = [];
    expect(await run(['show', 'people'])).toBe(0);
    expect(text(out)).toMatch(/webDev1\s+engineer\s+dana@example\.com/);
    expect(text(out)).not.toContain('surfaces');

    out = [];
    expect(await run(['show', 'channels'])).toBe(0);
    expect(text(out)).toMatch(/web-bugs-teams\s+teams\s+web/);
    out = [];
    expect(await run(['show', 'lexicon'])).toBe(0);
    expect(text(out)).toMatch(/cart\s+web\s+checkout/);
    out = [];
    expect(await run(['show', 'triggers'])).toBe(0);
    expect(text(out)).toMatch(/emoji\s+slack fire, teams fire\s+2 reactors/);
  });

  it('prints the XML only with --xml', async () => {
    expect(await run(['show', '--xml'])).toBe(0);
    expect(text(out)).toBe(exampleXml.trimEnd());
  });

  it('refuses an unknown section and a missing map', async () => {
    expect(await run(['show', 'nope'])).toBe(1);
    expect(text(err)).toContain('expected one of surfaces, channels, lexicon, people, triggers');
    err = [];
    expect(await runMap(['show', '--map', join(dir, 'absent.xml')], io())).toBe(1);
    expect(text(err)).toContain('no such file');
  });
});

describe('map set-level', () => {
  it('sets the override through the editor and records changedBy and changedAt', async () => {
    expect(await run(['set-level', 'mobile', '3', '--by', 'dana'])).toBe(0);
    expect(text(out)).toContain('mobile is now level 3 (changed by dana at 2026-10-03T12:00:00.000Z)');
    const map = await parseWorkspaceMap(await onDisk());
    expect(map.policies.autonomy.overrides).toContainEqual({ kind: 'surface', ref: 'mobile', level: 3, changedBy: 'dana', changedAt: NOW.toISOString() });
    expect(map.updated).toBe(NOW.toISOString());
    // Everything else, comments included, is as it was.
    expect(await onDisk()).toContain('<!-- Autopilot merges must pass all of these or degrade to level 2. -->');
    expect(map.policies.autonomy.overrides.find((o) => o.kind === 'surface' && o.ref === 'web')?.level).toBe(2);
  });

  it('changes an existing override and shows it in the table', async () => {
    expect(await run(['set-level', 'web', '0', '--by', 'dana'])).toBe(0);
    out = [];
    expect(await run(['show', 'surfaces'])).toBe(0);
    expect(text(out)).toMatch(/web\s+Website\s+github\.com\/acme\/web\s+WEB\s+0\s+dana 2026-10-03T12:00:00\.000Z/);
  });

  it('takes changedBy from --by, else the git email, else the OS user', async () => {
    await run(['set-level', 'web', '1', '--by', 'dana']);
    expect(await onDisk()).toContain('changedBy="dana"');
    await run(['set-level', 'web', '2']);
    expect(await onDisk()).toContain('changedBy="git@example.test"');
    await run(['set-level', 'web', '3'], { gitEmail: () => undefined });
    expect(await onDisk()).toContain('changedBy="osuser"');
  });

  it('changes nothing and exits 1 for an unknown surface, a bad level, or a missing argument', async () => {
    for (const args of [['set-level', 'nowhere', '2'], ['set-level', 'web', '4'], ['set-level', 'web', 'two'], ['set-level', 'web']]) {
      err = [];
      expect(await run(args)).toBe(1);
      expect(err.length).toBeGreaterThan(0);
      expect(await onDisk()).toBe(exampleXml);
    }
  });

  it('leaves no temp file behind', async () => {
    await run(['set-level', 'web', '1']);
    await run(['set-level', 'nowhere', '1']);
    expect(await readdir(dir)).toEqual(['workspace-context.xml']);
  });
});

describe('map set-trigger', () => {
  it('adds a workspace emoji row', async () => {
    expect(await run(['set-trigger', '--emoji', 'ladybug'])).toBe(0);
    const map = await parseWorkspaceMap(await onDisk());
    expect(map.triggers.emoji).toContainEqual({ slack: 'ladybug', teams: 'ladybug' });
    expect(map.updated).toBe(NOW.toISOString());
    expect(text(out)).toContain('changed by git@example.test at 2026-10-03T12:00:00.000Z');
  });

  it('adds a channel override by channel name', async () => {
    expect(await run(['set-trigger', '--emoji', 'beetle', '--channel', '#web-bugs', '--by', 'dana'])).toBe(0);
    const map = await parseWorkspaceMap(await onDisk());
    expect(map.channels.find((c) => c.name === 'web-bugs')?.triggerEmoji).toEqual(['beetle']);
    expect(text(out)).toContain('beetle is now a trigger in web-bugs');
  });

  it('picks the channel by platform when the name is on both', async () => {
    const both = exampleXml.replace(
      '<channel id="C0SALES"',
      '<channel id="C0WEBTEAMS" name="web-bugs-teams" surface="web" confidence="explicit" />\n    <channel id="C0SALES"',
    );
    await writeFile(mapPath, both);
    err = [];
    expect(await run(['set-trigger', '--emoji', 'beetle', '--channel', 'web-bugs-teams'])).toBe(1);
    expect(text(err)).toContain('more than one platform');
    expect(await run(['set-trigger', '--emoji', 'beetle', '--channel', 'web-bugs-teams', '--platform', 'teams'])).toBe(0);
    const after = await parseWorkspaceMap(await onDisk());
    expect(after.channels.find((c) => c.platform === 'teams')?.triggerEmoji).toEqual(['beetle']);
    expect(after.channels.find((c) => c.id === 'C0WEBTEAMS')?.triggerEmoji).toEqual([]);
    expect(await run(['set-trigger', '--emoji', 'moth', '--channel', 'web-bugs-teams', '--platform', 'slack'])).toBe(0);
    const slack = await parseWorkspaceMap(await onDisk());
    expect(slack.channels.find((c) => c.id === 'C0WEBTEAMS')?.triggerEmoji).toEqual(['moth']);
  });

  it('sets the Teams name of a workspace row with --platform teams', async () => {
    expect(await run(['set-trigger', '--emoji', 'bug', '--platform', 'teams'])).toBe(0);
    expect((await parseWorkspaceMap(await onDisk())).triggers.emoji).toContainEqual({ slack: 'bug', teams: 'bug' });
  });

  it('changes nothing and exits 1 for an unknown channel, a bad platform, a bad emoji name, or no emoji', async () => {
    for (const args of [
      ['set-trigger', '--emoji', 'ladybug', '--channel', 'nowhere'],
      ['set-trigger', '--emoji', 'ladybug', '--platform', 'discord'],
      ['set-trigger', '--emoji', 'not a name!'],
      ['set-trigger'],
    ]) {
      err = [];
      expect(await run(args)).toBe(1);
      expect(err.length).toBeGreaterThan(0);
      expect(await onDisk()).toBe(exampleXml);
    }
  });
});

describe('the command row', () => {
  it('is in the table and reads SNAPWING_MAP', async () => {
    const lines: string[] = [];
    const code = await main(['map', 'show', 'triggers'], { env: { SNAPWING_MAP: mapPath }, stdout: (l) => lines.push(l), stderr: (l) => err.push(l) });
    expect(code).toBe(0);
    expect(text(lines)).toContain('Fix it from here');
  });
});
