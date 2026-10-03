import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InvalidMapError, parseWorkspaceMap } from '../../src/map/parse.ts';
import { channelPlatform } from '../../src/map/types.ts';

const example = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

const TEAMS_ID = '19:3f9a2c7e1b4d4e8f9a0b1c2d3e4f5a6b@thread.tacv2';
const TEAMS_LINE = /<channel id="19:[^>]*platform="teams"[^>]*\/>/;

function withTeamsChannel(line: string): string {
  expect(TEAMS_LINE.test(example)).toBe(true);
  return example.replace(TEAMS_LINE, line);
}

async function messages(xml: string): Promise<string[]> {
  const err: unknown = await parseWorkspaceMap(xml).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InvalidMapError);
  return (err as InvalidMapError).errors.map((e) => e.message);
}

describe('Teams channels in the map', () => {
  it('parses a valid Teams channel with its team id', async () => {
    const map = await parseWorkspaceMap(example);
    expect(map.channels.find((c) => c.id === TEAMS_ID)).toEqual({
      id: TEAMS_ID,
      name: 'web-bugs-teams',
      surface: 'web',
      confidence: 'explicit',
      platform: 'teams',
      teamId: '8b2f6c1e-5d3a-4c7b-9e10-2a4f6b8c0d12',
      triggerEmoji: [],
    });
    expect(map.people.find((p) => p.teamsId === '5c1d7e3a-92b4-4f60-8a1e-3d5b7c9e1f24')?.handle).toBe('teamsDev');
  });

  it('defaults the platform to slack and carries no team', async () => {
    const map = await parseWorkspaceMap(example);
    const slack = map.channels.find((c) => c.id === 'C0WEBBUGS');
    expect(slack).toBeDefined();
    expect(slack?.platform).toBeUndefined();
    expect(slack?.teamId).toBeUndefined();
    expect(slack === undefined ? undefined : channelPlatform(slack)).toBe('slack');
    expect(channelPlatform({ platform: 'teams' })).toBe('teams');
  });

  it('accepts an explicit slack platform', async () => {
    const xml = example.replace('<channel id="C0WEBBUGS"', '<channel platform="slack" id="C0WEBBUGS"');
    const map = await parseWorkspaceMap(xml);
    expect(map.channels[0]?.platform).toBe('slack');
  });

  it('rejects a Teams channel without a team', async () => {
    const xml = withTeamsChannel(`<channel id="${TEAMS_ID}" name="web-bugs-teams" surface="web" platform="teams" />`);
    expect(await messages(xml)).toEqual(["Teams channel web-bugs-teams needs a team (the team's group id)."]);
  });

  it('rejects a Slack channel that carries a team', async () => {
    const xml = example.replace('<channel id="C0WEBBUGS" name="web-bugs"', '<channel id="C0WEBBUGS" team="8b2f6c1e" name="web-bugs"');
    expect(await messages(xml)).toEqual(['Slack channel web-bugs must not carry a team.']);
  });

  it('rejects an unknown platform', async () => {
    const xml = withTeamsChannel(`<channel id="${TEAMS_ID}" name="x" surface="web" platform="discord" team="t" />`);
    expect((await messages(xml)).length).toBeGreaterThan(0);
  });
});

describe('who changed an autonomy level', () => {
  it('round-trips changedBy and changedAt on the default and every override kind', async () => {
    const xml = example
      .replace('<autonomy default="1">', '<autonomy default="1" changedBy="webDev1" changedAt="2026-10-01T09:30:00Z">')
      .replace('<surface ref="web" level="2" />', '<surface ref="web" level="2" changedBy="dana@example.com" changedAt="2026-10-02T10:00:00Z" />')
      .replace('<component surface="web" ref="auth-web" level="1" />', '<component surface="web" ref="auth-web" level="1" changedBy="mobDev" changedAt="2026-10-02T11:00:00Z" />')
      .replace('<priority atLeast="Highest" level="1" />', '<priority atLeast="Highest" level="1" changedBy="webDev1" changedAt="2026-10-03T08:00:00Z" />');
    const { autonomy } = (await parseWorkspaceMap(xml)).policies;
    expect(autonomy.changedBy).toBe('webDev1');
    expect(autonomy.changedAt).toBe('2026-10-01T09:30:00Z');
    expect(autonomy.overrides).toEqual([
      { kind: 'surface', ref: 'web', level: 2, changedBy: 'dana@example.com', changedAt: '2026-10-02T10:00:00Z' },
      { kind: 'surface', ref: 'admin', level: 1 },
      { kind: 'component', surface: 'web', ref: 'auth-web', level: 1, changedBy: 'mobDev', changedAt: '2026-10-02T11:00:00Z' },
      { kind: 'priority', atLeast: 'Highest', level: 1, changedBy: 'webDev1', changedAt: '2026-10-03T08:00:00Z' },
    ]);
  });

  it('rejects a changedAt that is not ISO 8601', async () => {
    const xml = example.replace('<autonomy default="1">', '<autonomy default="1" changedAt="yesterday">');
    expect((await messages(xml)).length).toBeGreaterThan(0);
  });

  it('leaves an old map unchanged: no change fields appear', async () => {
    const { autonomy } = (await parseWorkspaceMap(example)).policies;
    expect(autonomy.changedBy).toBeUndefined();
    expect(autonomy.changedAt).toBeUndefined();
    for (const o of autonomy.overrides) {
      expect(o).not.toHaveProperty('changedBy');
      expect(o).not.toHaveProperty('changedAt');
    }
  });
});
