// Surfaces that use other surfaces, and the admin flag on people (#312, main 4.2, 20.3): parsing, each
// Schematron rule, the cycle check, a map with neither, and the two edits.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InvalidMapError, parseWorkspaceMap, usesCycleErrors } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { editWorkspaceMap, writeWorkspaceMap, type MapEdit, type MapWriteResult } from '../../src/map/write.ts';

const example = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

/** The example with every `uses` row and admin flag taken out: a map as it was written before #312. */
const plain = example.replace(/\n[ \t]*<uses [^>]*\/>/g, '').replace(/ admin="[^"]*"/g, '');

/** `xml` with `<uses surface>` rows for `targets` added at the end of surface `id`. */
function usesOn(xml: string, id: string, ...targets: string[]): string {
  const start = xml.indexOf(`<surface id="${id}"`);
  const end = xml.indexOf('</surface>', start);
  if (start === -1 || end === -1) throw new Error(`no surface ${id}`);
  const rows = targets.map((t) => `  <uses surface="${t}" />\n    `).join('');
  return `${xml.slice(0, end)}${rows}${xml.slice(end)}`;
}

/** `xml` with the person `handle` given `attrs` after its role. */
function personWith(xml: string, handle: string, attrs: string): string {
  const out = xml.replace(new RegExp(`(<person [^>]*handle="${handle}"[^>]*role="[a-z]+")`), `$1 ${attrs}`);
  if (out === xml) throw new Error(`no person ${handle}`);
  return out;
}

async function rejection(xml: string): Promise<InvalidMapError> {
  const err: unknown = await parseWorkspaceMap(xml).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InvalidMapError);
  return err as InvalidMapError;
}

const rules = (e: { errors: readonly { rule?: string }[] }): (string | undefined)[] => e.errors.map((x) => x.rule);

async function edited(edits: MapEdit[], xml = example): Promise<{ xml: string; map: WorkspaceMap }> {
  const result = await editWorkspaceMap(xml, edits);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
  return { xml: result.xml, map: await parseWorkspaceMap(result.xml) };
}

function refused(result: MapWriteResult): { message: string; rule?: string }[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  expect('xml' in result).toBe(false);
  return result.errors;
}

describe('uses: the surfaces whose code a surface builds on', () => {
  it('parses the rows in document order, and an empty list for a surface with none', async () => {
    const map = await parseWorkspaceMap(example);
    expect(map.surfaces.map((s) => [s.id, s.uses])).toEqual([
      ['web', ['shared-ui']],
      ['mobile', []],
      ['admin', []],
      ['shared-ui', []],
    ]);
    const two = await parseWorkspaceMap(usesOn(example, 'admin', 'shared-ui', 'web'));
    expect(two.surfaces.find((s) => s.id === 'admin')?.uses).toEqual(['shared-ui', 'web']);
  });

  it('Schematron: a row naming a surface that is not declared', async () => {
    const err = await rejection(usesOn(example, 'mobile', 'ghost'));
    expect(rules(err)).toEqual(['uses-surface-exists']);
    expect(err.errors[0]?.message).toBe('Surface mobile uses surface ghost, which is not declared.');
    expect(err.errors[0]?.line).toBeGreaterThan(0);
  });

  it('Schematron: a surface that uses itself', async () => {
    const err = await rejection(usesOn(example, 'mobile', 'mobile'));
    expect(rules(err)).toEqual(['uses-not-self']);
    expect(err.errors[0]?.message).toBe('Surface mobile cannot use itself.');
  });

  it('XSD: the same surface used twice, a row before components, and a row without a surface', async () => {
    const twice = await rejection(usesOn(example, 'mobile', 'shared-ui', 'shared-ui'));
    expect(twice.errors[0]?.message).toContain('usesSurfaceUnique');
    const early = example.replace('<components>\n        <component id="nav"', '<uses surface="admin" />\n      <components>\n        <component id="nav"');
    expect(early).not.toBe(example);
    expect((await rejection(early)).errors[0]?.rule).toBeUndefined();
    await rejection(example.replace('<uses surface="shared-ui" />', '<uses />'));
  });

  it('parseWorkspaceMap rejects a cycle and names the surfaces in it', async () => {
    const pair = await rejection(usesOn(example, 'shared-ui', 'web'));
    expect(pair.errors).toEqual([{ rule: 'uses-cycle', message: 'Surfaces web and shared-ui form a uses cycle: web uses shared-ui, which uses web.' }]);
    expect(pair.message).toContain('web uses shared-ui, which uses web');

    const three = await rejection(usesOn(usesOn(example, 'shared-ui', 'mobile'), 'mobile', 'web'));
    expect(three.errors.map((e) => e.message)).toEqual([
      'Surfaces web, shared-ui and mobile form a uses cycle: web uses shared-ui, which uses mobile, which uses web.',
    ]);
  });

  it('accepts shared use without a cycle: two surfaces on one, and a chain', async () => {
    const diamond = usesOn(usesOn(example, 'admin', 'web', 'shared-ui'), 'mobile', 'shared-ui');
    const map = await parseWorkspaceMap(diamond);
    expect(map.surfaces.find((s) => s.id === 'admin')?.uses).toEqual(['web', 'shared-ui']);
    expect(map.surfaces.find((s) => s.id === 'mobile')?.uses).toEqual(['shared-ui']);
  });

  it('usesCycleErrors reports each cycle once, a self use as one surface, and skips unknown ids', () => {
    expect(usesCycleErrors([{ id: 'a', uses: ['a'] }])).toEqual([{ rule: 'uses-cycle', message: 'Surface a forms a uses cycle: a uses a.' }]);
    const two = usesCycleErrors([
      { id: 'a', uses: ['b', 'zz'] },
      { id: 'b', uses: ['a'] },
      { id: 'c', uses: ['d'] },
      { id: 'd', uses: ['c', 'a'] },
      { id: 'e', uses: ['a', 'c'] },
    ]);
    expect(two.map((e) => e.message)).toEqual([
      'Surfaces a and b form a uses cycle: a uses b, which uses a.',
      'Surfaces c and d form a uses cycle: c uses d, which uses c.',
    ]);
    expect(usesCycleErrors([{ id: 'a', uses: ['b'] }, { id: 'b', uses: [] }])).toEqual([]);
  });
});

describe('admin: a flag on an engineer', () => {
  it('parses admin="true" as true, a false value as false, and leaves it absent otherwise', async () => {
    const map = await parseWorkspaceMap(example);
    expect(map.people.find((p) => p.handle === 'webDev1')?.admin).toBe(true);
    expect(map.people.filter((p) => 'admin' in p).map((p) => p.handle)).toEqual(['webDev1']);
    const flags = await parseWorkspaceMap(personWith(personWith(example, 'mobDev', 'admin="1"'), 'teamsDev', 'admin="false"'));
    expect(flags.people.find((p) => p.handle === 'mobDev')?.admin).toBe(true);
    expect(flags.people.find((p) => p.handle === 'teamsDev')?.admin).toBe(false);
  });

  it('Schematron: admin on a person who is not an engineer', async () => {
    const reporter = await rejection(personWith(example, 'salesLead', 'admin="true"'));
    expect(rules(reporter)).toEqual(['admin-needs-engineer']);
    expect(reporter.errors[0]?.message).toBe('Person salesLead is marked admin but has role reporter; only an engineer can be an admin.');
    const unknown = example.replace('role="reporter" />', 'role="unknown" admin="1" />');
    expect(rules(await rejection(unknown))).toEqual(['admin-needs-engineer']);
    // Not an admin is fine on anyone.
    expect((await parseWorkspaceMap(personWith(example, 'salesLead', 'admin="false"'))).people.find((p) => p.handle === 'salesLead')?.admin).toBe(false);
  });

  it('XSD: admin is a boolean', async () => {
    const err = await rejection(personWith(example, 'mobDev', 'admin="yes"'));
    expect(err.errors[0]?.rule).toBeUndefined();
    expect(err.errors[0]?.message).toContain('admin');
  });
});

describe('a map with neither uses nor admin', () => {
  it('parses to the same values as before: every uses list empty, no admin key', async () => {
    expect(plain).not.toMatch(/<uses|admin=/);
    const full = await parseWorkspaceMap(example);
    const expected: WorkspaceMap = {
      ...full,
      surfaces: full.surfaces.map((s) => ({ ...s, uses: [] })),
      people: full.people.map(({ admin: _admin, ...p }) => p),
    };
    const map = await parseWorkspaceMap(plain);
    expect(map).toEqual(expected);
    expect(map.people.some((p) => 'admin' in p)).toBe(false);
  });

  it('writes back byte for byte: the writer adds no row and no attribute for them', async () => {
    const written = await writeWorkspaceMap(await parseWorkspaceMap(plain));
    const writtenFull = await writeWorkspaceMap(await parseWorkspaceMap(example));
    if (!written.ok || !writtenFull.ok) throw new Error('the example writes back valid');
    expect(written.xml).not.toMatch(/<uses|admin=/);
    expect(written.xml).toBe(writtenFull.xml.replace('\n      <uses surface="shared-ui" />', '').replace(' admin="true"', ''));
    const again = await writeWorkspaceMap(await parseWorkspaceMap(written.xml));
    expect(again.ok && again.xml).toBe(written.xml);
  });

  it('edits that set nothing leave the document byte for byte', async () => {
    const untouched = await editWorkspaceMap(plain, []);
    const cleared = await editWorkspaceMap(plain, [
      { kind: 'setSurfaceUses', surface: 'web', uses: [] },
      { kind: 'setPersonAdmin', handle: 'webDev1', admin: false },
    ]);
    expect(untouched.ok && cleared.ok).toBe(true);
    if (untouched.ok && cleared.ok) expect(cleared.xml).toBe(untouched.xml);
  });

  it('writes uses after components and admin after role, and round-trips them', async () => {
    const written = await writeWorkspaceMap(await parseWorkspaceMap(example));
    if (!written.ok) throw new Error('the example writes back valid');
    expect(written.xml).toContain('      </components>\n      <uses surface="shared-ui" />\n    </surface>');
    expect(written.xml).toContain('role="engineer" admin="true">');
  });
});

describe('editWorkspaceMap: setSurfaceUses and setPersonAdmin', () => {
  it('sets, replaces, and clears a surface uses rows in place', async () => {
    const added = await edited([{ kind: 'setSurfaceUses', surface: 'mobile', uses: ['shared-ui', 'web'] }]);
    expect(added.map.surfaces.find((s) => s.id === 'mobile')?.uses).toEqual(['shared-ui', 'web']);
    expect(added.xml).toContain(
      '<jira project="APP" defaultIssueType="Bug"/>\n      <uses surface="shared-ui"/>\n      <uses surface="web"/>\n    </surface>',
    );

    const replaced = await edited([{ kind: 'setSurfaceUses', surface: 'web', uses: ['admin'] }]);
    expect(replaced.map.surfaces.find((s) => s.id === 'web')?.uses).toEqual(['admin']);
    expect(replaced.xml).not.toContain('<uses surface="shared-ui"');

    const cleared = await edited([{ kind: 'setSurfaceUses', surface: 'web', uses: [] }]);
    expect(cleared.map.surfaces.every((s) => s.uses.length === 0)).toBe(true);
    expect(cleared.xml).toContain('      </components>\n      <!-- Optional uses');
    expect(cleared.xml).toMatch(/so triage can look across them\. -->\n {4}<\/surface>/);
  });

  it('refuses an edit that breaks a rule and returns the errors, with no XML', async () => {
    const ghost = refused(await editWorkspaceMap(example, [{ kind: 'setSurfaceUses', surface: 'mobile', uses: ['ghost'] }]));
    expect(ghost.map((e) => e.rule)).toEqual(['uses-surface-exists']);
    const self = refused(await editWorkspaceMap(example, [{ kind: 'setSurfaceUses', surface: 'mobile', uses: ['mobile'] }]));
    expect(self.map((e) => e.rule)).toEqual(['uses-not-self']);
    const cycle = refused(await editWorkspaceMap(example, [{ kind: 'setSurfaceUses', surface: 'shared-ui', uses: ['web'] }]));
    expect(cycle).toEqual([{ rule: 'uses-cycle', message: 'Surfaces web and shared-ui form a uses cycle: web uses shared-ui, which uses web.' }]);
    const twice = refused(await editWorkspaceMap(example, [{ kind: 'setSurfaceUses', surface: 'mobile', uses: ['web', 'web'] }]));
    expect(twice[0]?.message).toContain('usesSurfaceUnique');
    const missing = refused(await editWorkspaceMap(example, [{ kind: 'setSurfaceUses', surface: 'nowhere', uses: [] }]));
    expect(missing).toEqual([{ rule: 'edit-target-missing', message: 'The map has no surface nowhere to edit.' }]);

    const reporter = refused(await editWorkspaceMap(example, [{ kind: 'setPersonAdmin', handle: 'salesLead', admin: true }]));
    expect(reporter.map((e) => e.rule)).toEqual(['admin-needs-engineer']);
    const nobody = refused(await editWorkspaceMap(example, [{ kind: 'setPersonAdmin', handle: 'nobody', admin: true }]));
    expect(nobody[0]?.rule).toBe('edit-target-missing');
  });

  it('marks an engineer admin and takes it away', async () => {
    const on = await edited([{ kind: 'setPersonAdmin', handle: 'mobDev', admin: true }]);
    expect(on.map.people.find((p) => p.handle === 'mobDev')?.admin).toBe(true);
    expect(on.xml).toContain('<person slackId="U0MOBDEV" handle="mobDev" email="marcus@example.com" role="engineer" admin="true">');
    const off = await edited([{ kind: 'setPersonAdmin', handle: 'webDev1', admin: false }]);
    expect(off.map.people.some((p) => 'admin' in p)).toBe(false);
    expect(off.xml).not.toContain('admin=');
    // Taking it from a reporter who never had it is a no-op, not a rule failure.
    expect((await edited([{ kind: 'setPersonAdmin', handle: 'salesLead', admin: false }])).xml).toContain('handle="salesLead" email="pat@example.com" role="reporter"/>');
  });

  it('adds a surface with uses and a person with admin', async () => {
    const { map, xml } = await edited([
      { kind: 'addSurface', surface: { id: 'docs', label: 'Docs', repo: 'github.com/acme/docs', jira: { project: 'DOC', defaultIssueType: 'Bug' }, components: [], uses: ['shared-ui'] } },
      { kind: 'addPerson', person: { handle: 'docsDev', email: 'd@example.com', role: 'engineer', admin: true, owns: [{ surface: 'docs', primary: true }] } },
    ]);
    expect(map.surfaces.find((s) => s.id === 'docs')?.uses).toEqual(['shared-ui']);
    expect(map.people.find((p) => p.handle === 'docsDev')?.admin).toBe(true);
    expect(xml).toMatch(/<jira project="DOC" defaultIssueType="Bug"\/>\s*<uses surface="shared-ui"\/>\s*<\/surface>/);
  });
});
