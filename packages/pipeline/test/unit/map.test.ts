import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InvalidMapError, parseWorkspaceMap, WORKSPACE_SCHEMAS } from '../../src/map/parse.ts';
import { validate } from '../../src/schemas/validate.ts';

const example = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/map/${name}`, import.meta.url)), 'utf8');

async function parseError(xml: string): Promise<InvalidMapError> {
  const err: unknown = await parseWorkspaceMap(xml).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InvalidMapError);
  return err as InvalidMapError;
}

describe('workspace-context example', () => {
  it('validates against the XSD and the Schematron', async () => {
    expect(await validate(example, WORKSPACE_SCHEMAS)).toEqual({ valid: true, errors: [] });
  });

  it('parses into a typed map', async () => {
    const map = await parseWorkspaceMap(example);
    expect(map.org).toBe('acme');
    expect(map.updated).toBe('2026-09-28T00:00:00Z');
    expect(map.surfaces.map((s) => s.id)).toEqual(['web', 'mobile', 'admin']);
    expect(map.fallbackSurface).toBe('web');
    expect(map.surfaces[0]).toEqual({
      id: 'web',
      label: 'Website',
      repo: 'github.com/acme/web',
      jira: { project: 'WEB', defaultIssueType: 'Bug' },
      components: [
        { id: 'nav', label: 'Navigation' },
        { id: 'checkout', label: 'Checkout' },
        { id: 'auth-web', label: 'Login (web)' },
      ],
    });
    expect(map.surfaces[1]?.components).toEqual([]);

    expect(map.channels).toHaveLength(5);
    expect(map.channels[2]).toEqual({ id: 'C0APPBUGS', name: 'app-bugs', surface: 'mobile', confidence: 'explicit', triggerEmoji: ['ladybug'] });
    expect(map.channels[4]).toEqual({ id: 'C0ALERTS', name: 'alerts', surface: 'from-payload', triggerEmoji: [] });

    expect(map.triggers).toEqual({
      messageActions: [{ label: 'Fix it from here' }],
      emoji: [
        { slack: 'bug', teams: 'bug' },
        { slack: 'fire', teams: 'fire', minReactors: 2 },
      ],
      directMessage: { images: true, text: true },
      cli: { enabled: true },
    });

    expect(map.vocabulary).toHaveLength(5);
    expect(map.vocabulary[4]).toEqual({ text: 'cart', surface: 'web', component: 'checkout' });

    expect(map.people).toHaveLength(3);
    expect(map.people[0]).toEqual({
      slackId: 'U0WEBDEV1',
      handle: 'webDev1',
      email: 'dana@example.com',
      role: 'engineer',
      owns: [
        { surface: 'web', primary: false },
        { surface: 'web', component: 'nav', primary: true },
      ],
    });
    expect(map.people[2]?.owns).toEqual([]);
  });

  it('parses the autonomy dial and the risk gate', async () => {
    const { policies } = await parseWorkspaceMap(example);
    expect(policies.askBack).toEqual({ maxQuestionsPerIncident: 1, suppressWhenReportersAtLeast: 3 });
    expect(policies.autonomy.default).toBe(1);
    expect(policies.autonomy.levels).toHaveLength(4);
    expect(policies.autonomy.levels[0]).toEqual({ id: 0, name: 'ticket-only', fixer: 'never', merge: 'none', requires: [] });
    expect(policies.autonomy.levels[3]).toEqual({
      id: 3,
      name: 'autopilot',
      fixer: 'immediate',
      merge: 'agent',
      requires: ['review-agent', 'ci-green', 'risk-gate'],
    });
    expect(policies.autonomy.overrides).toEqual([
      { kind: 'surface', ref: 'web', level: 2 },
      { kind: 'surface', ref: 'admin', level: 1 },
      { kind: 'component', surface: 'web', ref: 'auth-web', level: 1 },
      { kind: 'priority', atLeast: 'Highest', level: 1 },
    ]);
    expect(policies.riskGate).toEqual({
      maxFilesTouched: 6,
      maxDiffLines: 300,
      forbiddenPaths: ['src/auth/**', 'infra/**', '**/migrations/**'],
    });
  });
});

describe('parseWorkspaceMap rejects invalid input with InvalidMapError', () => {
  it('XSD: unknown person role', async () => {
    const err = await parseError(fixture('invalid-xsd-role.xml'));
    expect(err.errors).toHaveLength(1);
    expect(err.errors[0]?.message).toMatch(/attribute 'role'.*'intern' is not an element of the set \{'engineer', 'reporter', 'unknown'\}/);
    expect(err.errors[0]?.line).toBe(59);
  });

  it('XSD: emoji trigger missing the teams attribute', async () => {
    const err = await parseError(fixture('invalid-xsd-emoji-missing-teams.xml'));
    expect(err.errors).toHaveLength(1);
    expect(err.errors[0]?.message).toMatch(/attribute 'teams' is required but missing/);
  });

  it('Schematron: channel names an undeclared surface', async () => {
    const err = await parseError(fixture('invalid-xref-channel-surface.xml'));
    expect(err.errors.map((e) => e.message)).toEqual(['Channel app-bugs names surface mobil, which is not declared.']);
  });

  it('Schematron: fallback surface is not a declared surface', async () => {
    const err = await parseError(example.replace('fallbackSurface="web"', 'fallbackSurface="desktop"'));
    expect(err.errors.map((e) => e.message)).toEqual(['The fallback surface desktop is not declared.']);
  });

  it('XSD: duplicate surface id', async () => {
    const err = await parseError(example.replace('<surface id="mobile"', '<surface id="web"'));
    expect(err.errors.some((e) => /surfaceIdUnique/.test(e.message))).toBe(true);
  });

  it('XSD: duplicate channel id', async () => {
    const err = await parseError(example.replace('<channel id="C0MKTBUGS"', '<channel id="C0WEBBUGS"'));
    expect(err.errors.some((e) => /channelIdUnique/.test(e.message))).toBe(true);
  });

  it('XSD: duplicate component id under one surface', async () => {
    const err = await parseError(example.replace('<component id="checkout"', '<component id="nav"'));
    expect(err.errors.some((e) => /componentIdUnique/.test(e.message))).toBe(true);
  });

  it('XSD: duplicate person handle', async () => {
    const err = await parseError(example.replace('handle="mobDev"', 'handle="webDev1"'));
    expect(err.errors.some((e) => /personHandleUnique/.test(e.message))).toBe(true);
  });

  it('XSD: duplicate person Slack id', async () => {
    const err = await parseError(example.replace('slackId="U0MOBDEV"', 'slackId="U0WEBDEV1"'));
    expect(err.errors.some((e) => /personSlackIdUnique/.test(e.message))).toBe(true);
  });

  it('a map without fallbackSurface parses with the field absent', async () => {
    const map = await parseWorkspaceMap(example.replace(' fallbackSurface="web"', ''));
    expect('fallbackSurface' in map).toBe(false);
  });

  it('Schematron: person owns a component that does not exist under the surface', async () => {
    const err = await parseError(fixture('invalid-xref-owns-component.xml'));
    expect(err.errors.map((e) => e.message)).toEqual(['Person webDev1 owns component navbar, which does not exist under surface web.']);
  });

  it('Schematron: autonomy override ref does not resolve', async () => {
    const err = await parseError(fixture('invalid-xref-override-ref.xml'));
    expect(err.errors.map((e) => e.message)).toEqual(['Autonomy override refers to component auth-mobile, which does not exist under surface web.']);
  });

  it('malformed XML', async () => {
    const err = await parseError(fixture('invalid-malformed.xml'));
    expect(err.errors.length).toBeGreaterThan(0);
    expect(err.errors[0]?.message).toMatch(/Premature end of data|Opening and ending tag mismatch|parser error/i);
    expect(err.message).toMatch(/^Invalid workspace map \(\d+ errors?\)/);
  });

  it('carries every Schematron error, not just the first', async () => {
    const doc = fixture('invalid-xref-channel-surface.xml').replace('component="nav" primary="true"', 'component="navbar" primary="true"');
    const err = await parseError(doc);
    expect(err.errors).toHaveLength(2);
  });
});
