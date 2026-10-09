import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { editWorkspaceMap, writeWorkspaceMap, type MapEdit } from '../../src/map/write.ts';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const example = read('../../../../examples/workspace-context.example.xml');
const demo = read('../../../../demo/levels/workspace-context.xml');

async function edited(edits: MapEdit[], xml = example): Promise<{ xml: string; map: WorkspaceMap }> {
  const result = await editWorkspaceMap(xml, edits);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
  return { xml: result.xml, map: await parseWorkspaceMap(result.xml) };
}

describe('writeWorkspaceMap', () => {
  for (const [name, xml] of [['the example map', example], ['the demo map', demo]] as const) {
    it(`round-trips ${name}`, async () => {
      const map = await parseWorkspaceMap(xml);
      const written = await writeWorkspaceMap(map);
      expect(written.ok).toBe(true);
      if (written.ok) expect(await parseWorkspaceMap(written.xml)).toEqual(map);
    });
  }

  it('keeps a surface repo base through parse, write and edit (#310)', async () => {
    const withBase = example.replace('<repo>github.com/acme/mobile</repo>', '<repo base="release/2">github.com/acme/mobile</repo>');
    const map = await parseWorkspaceMap(withBase);
    expect(map.surfaces.find((s) => s.id === 'mobile')).toMatchObject({ repo: 'github.com/acme/mobile', repoBase: 'release/2' });
    expect(map.surfaces.find((s) => s.id === 'admin')?.repoBase).toBeUndefined();
    const written = await writeWorkspaceMap(map);
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.xml).toContain('<repo base="release/2">github.com/acme/mobile</repo>');
      expect(await parseWorkspaceMap(written.xml)).toEqual(map);
    }
    const added = await edited([{ kind: 'addSurface', surface: { id: 'docs', label: 'Docs', repo: 'github.com/acme/docs', repoBase: 'main-next', jira: { project: 'DOC', defaultIssueType: 'Task' }, components: [] } }]);
    expect(added.map.surfaces.find((s) => s.id === 'docs')?.repoBase).toBe('main-next');
  });

  it('round-trips a map with every element, Teams channels, and changedBy', async () => {
    const full = `<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="a &amp; b" updated="2026-10-03T00:00:00Z">
  <surfaces fallbackSurface="web">
    <surface id="web" label="Web &quot;site&quot;"><repo>github.com/a/web</repo><jira project="W" defaultIssueType="Bug"/>
      <components><component id="nav" label="Nav"/></components></surface>
  </surfaces>
  <channels>
    <channel id="C1" name="web" surface="web" confidence="inferred"><trigger emoji="ladybug"/><trigger emoji="bug"/></channel>
    <channel id="19:x@thread.tacv2" name="t" surface="from-payload" platform="teams" team="g1"/>
  </channels>
  <triggers>
    <messageAction label="Fix it"/><emoji slack="bug" teams="bug"/><emoji slack="fire" teams="fire" minReactors="2"/>
    <directMessage images="true" text="false"/><cli enabled="false"/>
  </triggers>
  <vocabulary><term surface="web" component="nav">menu &lt;bar&gt;</term></vocabulary>
  <people>
    <person slackId="U1" teamsId="T1" handle="a" email="a@x.com" role="engineer"><owns surface="web" component="nav" primary="true"/><owns surface="web"/></person>
  </people>
  <policies>
    <askBack maxQuestionsPerIncident="0" suppressWhenReportersAtLeast="2"/>
    <autonomy default="1" changedBy="a" changedAt="2026-10-03T01:00:00Z">
      <level id="0" name="a" fixer="never" merge="none"/><level id="1" name="b" fixer="on-tap" merge="human"/>
      <level id="2" name="c" fixer="immediate" merge="human"/>
      <level id="3" name="d" fixer="immediate" merge="agent" requires="review-agent ci-green"/>
      <overrides>
        <priority atLeast="High" level="2" changedBy="a@x.com" changedAt="2026-10-03T02:00:00Z"/>
        <component surface="web" ref="nav" level="3" changedBy="a" changedAt="2026-10-03T03:00:00Z"/>
        <surface ref="web" level="0" changedBy="a" changedAt="2026-10-03T04:00:00Z"/>
      </overrides>
    </autonomy>
    <riskGate maxFilesTouched="3" maxDiffLines="50"><forbiddenPath>a/**</forbiddenPath></riskGate>
  </policies>
</workspace>`;
    const map = await parseWorkspaceMap(full);
    expect(map.channels[1]).toMatchObject({ platform: 'teams', teamId: 'g1' });
    expect(map.policies.autonomy.changedBy).toBe('a');
    const written = await writeWorkspaceMap(map);
    expect(written.ok).toBe(true);
    if (written.ok) expect(await parseWorkspaceMap(written.xml)).toEqual(map);
  });

  it('omits platform, team, and changedBy when absent, so an old map writes back without them', async () => {
    const map = await parseWorkspaceMap(demo);
    const written = await writeWorkspaceMap(map);
    expect(written.ok && /platform=|team=|changedBy=/.test(written.xml)).toBe(false);
  });

  it('returns typed errors and no XML for an invalid map', async () => {
    const map = await parseWorkspaceMap(example);
    const bad: WorkspaceMap = { ...map, channels: [...map.channels, { id: 'C9', name: 'x', surface: 'nope', triggerEmoji: [] }] };
    const written = await writeWorkspaceMap(bad);
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.errors.some((e) => e.rule === 'channel-surface-exists')).toBe(true);
      expect('xml' in written).toBe(false);
    }
  });
});

describe('editWorkspaceMap', () => {
  it('sets a surface level with changedBy and changedAt, in place', async () => {
    const { xml, map } = await edited([{ kind: 'setSurfaceLevel', surface: 'web', level: 3, changedBy: 'webDev1', changedAt: '2026-10-03T10:00:00Z' }]);
    expect(map.policies.autonomy.overrides).toContainEqual({ kind: 'surface', ref: 'web', level: 3, changedBy: 'webDev1', changedAt: '2026-10-03T10:00:00Z' });
    expect(xml).toContain('<surface ref="web" level="3" changedBy="webDev1" changedAt="2026-10-03T10:00:00Z"/>');
    expect(map.policies.autonomy.overrides.filter((o) => o.kind === 'surface')).toHaveLength(2);
  });

  it('adds a surface override when there is none, creating overrides if needed', async () => {
    const { map } = await edited([{ kind: 'setSurfaceLevel', surface: 'help', level: 2, changedBy: 'a@x.com', changedAt: '2026-10-03T10:00:00Z' }], demo);
    expect(map.policies.autonomy.overrides.find((o) => o.kind === 'surface' && o.ref === 'help')).toMatchObject({ level: 2, changedBy: 'a@x.com' });
    const bare = example.replace(/<overrides>[\s\S]*?<\/overrides>/, '');
    const out = await edited([{ kind: 'setSurfaceLevel', surface: 'web', level: 0, changedBy: 'x', changedAt: '2026-10-03T10:00:00Z' }], bare);
    expect(out.map.policies.autonomy.overrides).toHaveLength(1);
  });

  it('adds and changes a workspace trigger emoji', async () => {
    const added = await edited([{ kind: 'setTriggerEmoji', emoji: 'rotating_light', minReactors: 3 }]);
    expect(added.map.triggers.emoji.at(-1)).toEqual({ slack: 'rotating_light', teams: 'rotating_light', minReactors: 3 });
    const changed = await edited([{ kind: 'setTriggerEmoji', replaces: 'fire', emoji: 'boom', teams: 'explosion' }]);
    expect(changed.map.triggers.emoji.find((e) => e.slack === 'boom')).toEqual({ slack: 'boom', teams: 'explosion', minReactors: 2 });
    expect(changed.map.triggers.emoji.some((e) => e.slack === 'fire')).toBe(false);
  });

  it('adds and changes a channel trigger emoji', async () => {
    const added = await edited([{ kind: 'setTriggerEmoji', emoji: 'beetle', channel: 'C0WEBBUGS' }]);
    expect(added.map.channels.find((c) => c.id === 'C0WEBBUGS')?.triggerEmoji).toEqual(['beetle']);
    const changed = await edited([{ kind: 'setTriggerEmoji', emoji: 'beetle', replaces: 'ladybug', channel: 'C0APPBUGS' }]);
    expect(changed.map.channels.find((c) => c.id === 'C0APPBUGS')?.triggerEmoji).toEqual(['beetle']);
  });

  it('adds a surface, a channel, a term, and a person', async () => {
    const { map } = await edited([
      { kind: 'addSurface', surface: { id: 'docs', label: 'Docs', repo: 'github.com/acme/docs', jira: { project: 'DOC', defaultIssueType: 'Bug' }, components: [{ id: 'search', label: 'Search' }] } },
      { kind: 'addChannel', channel: { id: '19:abc@thread.tacv2', name: 'docs-bugs', surface: 'docs', confidence: 'explicit', platform: 'teams', teamId: 'g2', triggerEmoji: ['bug'] } },
      { kind: 'addTerm', term: { text: 'the docs', surface: 'docs', component: 'search' } },
      { kind: 'addPerson', person: { teamsId: 'T9', handle: 'docsDev', email: 'd@x.com', role: 'engineer', owns: [{ surface: 'docs', component: 'search', primary: true }] } },
    ]);
    expect(map.surfaces.find((s) => s.id === 'docs')?.components).toEqual([{ id: 'search', label: 'Search' }]);
    expect(map.channels.find((c) => c.name === 'docs-bugs')).toMatchObject({ platform: 'teams', teamId: 'g2', triggerEmoji: ['bug'] });
    expect(map.vocabulary.at(-1)).toEqual({ text: 'the docs', surface: 'docs', component: 'search' });
    expect(map.people.find((p) => p.handle === 'docsDev')?.owns).toEqual([{ surface: 'docs', component: 'search', primary: true }]);
  });

  it('sets a person ownership and chat ids', async () => {
    const { map } = await edited([
      { kind: 'setPersonOwnership', handle: 'webDev1', owns: [{ surface: 'admin', primary: true }] },
      { kind: 'setPersonOwnership', handle: 'salesLead', owns: [{ surface: 'web', component: 'nav', primary: false }] },
      { kind: 'setPersonChatIds', handle: 'mobDev', teamsId: 'T-77', slackId: 'U0NEW' },
      { kind: 'setPersonChatIds', handle: 'webDev1', slackId: null, teamsId: 'T-78' },
    ]);
    expect(map.people.find((p) => p.handle === 'webDev1')).toMatchObject({ owns: [{ surface: 'admin', primary: true }], teamsId: 'T-78' });
    expect(map.people.find((p) => p.handle === 'webDev1')?.slackId).toBeUndefined();
    expect(map.people.find((p) => p.handle === 'salesLead')?.owns).toEqual([{ surface: 'web', component: 'nav', primary: false }]);
    expect(map.people.find((p) => p.handle === 'mobDev')).toMatchObject({ slackId: 'U0NEW', teamsId: 'T-77' });
  });

  it('keeps comments, formatting, and attribute order', async () => {
    const { xml } = await edited([
      { kind: 'setSurfaceLevel', surface: 'admin', level: 2, changedBy: 'a', changedAt: '2026-10-03T10:00:00Z' },
      { kind: 'addTerm', term: { text: 'billing', surface: 'admin' } },
      { kind: 'setTriggerEmoji', emoji: 'beetle', channel: 'C0APPBUGS' },
    ]);
    const comments = (s: string): string[] => s.match(/<!--[\s\S]*?-->/g) ?? [];
    expect(comments(xml)).toEqual(comments(example));
    expect(xml).toContain('<jira project="WEB" defaultIssueType="Bug"/>');
    expect(xml).toContain('<channel id="C0APPBUGS" name="app-bugs" surface="mobile" confidence="explicit">');
    expect(xml).toContain('    <term surface="admin">billing</term>\n  </vocabulary>');
    expect(xml).toContain('<emoji slack="fire" teams="fire" minReactors="2"/> <!-- second emoji, needs two people -->');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('applies no edits as a no-op that still validates', async () => {
    const result = await editWorkspaceMap(example, []);
    expect(result.ok && (await parseWorkspaceMap(result.xml))).toEqual(await parseWorkspaceMap(example));
  });

  it('sets the updated stamp when asked', async () => {
    const result = await editWorkspaceMap(example, [], { updated: '2026-10-03T12:00:00Z' });
    expect(result.ok && (await parseWorkspaceMap(result.xml)).updated).toBe('2026-10-03T12:00:00Z');
  });

  it('returns the typed errors and no XML when an edit makes the map invalid', async () => {
    const dangling = await editWorkspaceMap(example, [{ kind: 'addChannel', channel: { id: 'C9', name: 'x', surface: 'ghost', triggerEmoji: [] } }]);
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      expect(dangling.errors.map((e) => e.rule)).toContain('channel-surface-exists');
      expect('xml' in dangling).toBe(false);
    }
    const dupe = await editWorkspaceMap(example, [{ kind: 'addSurface', surface: { id: 'web', label: 'Again', repo: 'x/y', jira: { project: 'W', defaultIssueType: 'Bug' }, components: [] } }]);
    expect(dupe.ok).toBe(false);
    const badLevel = await editWorkspaceMap(example, [{ kind: 'setSurfaceLevel', surface: 'web', level: 9 as 3, changedBy: 'a', changedAt: '2026-10-03T10:00:00Z' }]);
    expect(badLevel.ok).toBe(false);
    const slackTeam = await editWorkspaceMap(example, [{ kind: 'addChannel', channel: { id: 'C8', name: 'x', surface: 'web', teamId: 'g', triggerEmoji: [] } }]);
    expect(slackTeam.ok).toBe(false);
  });

  it('reports a missing edit target and malformed XML as errors', async () => {
    const missing = await editWorkspaceMap(example, [{ kind: 'setPersonChatIds', handle: 'nobody', slackId: 'U1' }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]?.rule).toBe('edit-target-missing');
    const noChannel = await editWorkspaceMap(example, [{ kind: 'setTriggerEmoji', emoji: 'x', channel: 'Cnone' }]);
    expect(noChannel.ok).toBe(false);
    const malformed = await editWorkspaceMap('<workspace', []);
    expect(malformed.ok).toBe(false);
  });
});
