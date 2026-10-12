// Parse and validate workspace-context.xml into a typed WorkspaceMap (main 4.2).
// Validation (XSD, then Schematron) always runs first, so the conversion below can rely on
// the document's shape and only narrows `unknown` values; it does not re-check them.

import { XMLParser } from 'fast-xml-parser';
import { validate, type SchemaPaths, type ValidationError, type ValidationResult } from '../schemas/validate.ts';
import { assetPath } from '../util/assets.ts';
import {
  InvalidMapError,
  type AutonomyGate,
  type AutonomyLevel,
  type AutonomyLevelId,
  type AutonomyOverride,
  type AutonomyChange,
  type ChannelConfidence,
  type ChannelPlatform,
  type FixerStart,
  type JiraPriorityName,
  type MapActorRole,
  type MapChannel,
  type MapComponent,
  type MapOwnership,
  type MapPerson,
  type MapRiskGate,
  type MapSurface,
  type MapTerm,
  type MapTriggers,
  type MergeActor,
  type WorkspaceMap,
} from './types.ts';

export { InvalidMapError } from './types.ts';

export const WORKSPACE_SCHEMAS: SchemaPaths = {
  xsd: assetPath('schemas/workspace-context.xsd'),
  sch: assetPath('schemas/workspace-context.sch'),
};

/**
 * Validate `xml` against the workspace XSD and Schematron, then convert it to a typed map.
 * Throws `InvalidMapError` carrying every validation error when the document is malformed,
 * breaks the XSD, (if the XSD passes) breaks a cross-reference rule, or (if those pass) has
 * surfaces that use each other in a cycle.
 */
export async function parseWorkspaceMap(xml: string): Promise<WorkspaceMap> {
  const result = await validate(xml, WORKSPACE_SCHEMAS);
  if (!result.valid) throw new InvalidMapError(result.errors);
  const map = convert(xml);
  const cycles = usesCycleErrors(map.surfaces);
  if (cycles.length > 0) throw new InvalidMapError(cycles);
  return map;
}

/** Every rule `parseWorkspaceMap` applies, as a result instead of a throw: what the map writer checks before handing XML back. */
export async function validateWorkspaceMap(xml: string): Promise<ValidationResult> {
  const result = await validate(xml, WORKSPACE_SCHEMAS);
  if (!result.valid) return result;
  const cycles = usesCycleErrors(convert(xml).surfaces);
  return cycles.length > 0 ? { valid: false, errors: cycles } : result;
}

/**
 * One error (rule `uses-cycle`) per cycle in the surfaces' `uses` relation, naming the surfaces in it in order
 * (#312). The walk is depth first in document order, so each cycle is reported once, from the surface where the
 * walk entered it.
 */
export function usesCycleErrors(surfaces: readonly Pick<MapSurface, 'id' | 'uses'>[]): ValidationError[] {
  const uses = new Map(surfaces.map((s) => [s.id, s.uses]));
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const errors: ValidationError[] = [];
  const visit = (id: string): void => {
    state.set(id, 'open');
    stack.push(id);
    for (const next of uses.get(id) ?? []) {
      if (!uses.has(next)) continue;
      const seen = state.get(next);
      if (seen === 'open') errors.push(cycleError(stack.slice(stack.indexOf(next))));
      else if (seen === undefined) visit(next);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const s of surfaces) if (!state.has(s.id)) visit(s.id);
  return errors;
}

/** For `[a, b, c]`: "Surfaces a, b and c form a uses cycle: a uses b, which uses c, which uses a." */
function cycleError(cycle: readonly string[]): ValidationError {
  const [first = '', ...rest] = cycle;
  const names = rest.length === 0 ? `Surface ${first} forms` : `Surfaces ${[first, ...rest.slice(0, -1)].join(', ')} and ${rest.at(-1) ?? ''} form`;
  return { message: `${names} a uses cycle: ${first} uses ${[...rest, first].join(', which uses ')}.`, rule: 'uses-cycle' };
}

// Conversion from the parsed tree. Names mirror the XML.

type Node = Record<string, unknown>;

const ARRAY_ELEMENTS = new Set([
  'surface', 'component', 'uses', 'channel', 'trigger', 'messageAction', 'emoji', 'term', 'person', 'owns', 'level', 'forbiddenPath',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_ELEMENTS.has(name),
});

function convert(xml: string): WorkspaceMap {
  const doc = parser.parse(xml) as Node;
  const root = node(doc['workspace']);
  const policies = node(root['policies']);
  const autonomy = node(policies['autonomy']);
  const overrides = node(autonomy['overrides']);

  const fallbackSurface = optAttr(node(root['surfaces']), 'fallbackSurface');

  return {
    org: attr(root, 'org'),
    updated: attr(root, 'updated'),
    surfaces: list(node(root['surfaces'])['surface']).map(surface),
    ...(fallbackSurface === undefined ? {} : { fallbackSurface }),
    channels: list(node(root['channels'])['channel']).map(channel),
    triggers: triggers(node(root['triggers'])),
    vocabulary: list(node(root['vocabulary'])['term']).map(term),
    people: list(node(root['people'])['person']).map(person),
    policies: {
      ...(policies['askBack'] === undefined ? {} : { askBack: askBack(node(policies['askBack'])) }),
      autonomy: {
        default: levelId(attr(autonomy, 'default')),
        ...change(autonomy),
        levels: list(autonomy['level']).map(level),
        overrides: [
          ...list(overrides['surface']).map((o): AutonomyOverride => ({ kind: 'surface', ref: attr(o, 'ref'), level: levelId(attr(o, 'level')), ...change(o) })),
          ...list(overrides['component']).map(
            (o): AutonomyOverride => ({ kind: 'component', surface: attr(o, 'surface'), ref: attr(o, 'ref'), level: levelId(attr(o, 'level')), ...change(o) }),
          ),
          ...list(overrides['priority']).map(
            (o): AutonomyOverride => ({ kind: 'priority', atLeast: attr(o, 'atLeast') as JiraPriorityName, level: levelId(attr(o, 'level')), ...change(o) }),
          ),
        ],
      },
      ...(policies['riskGate'] === undefined ? {} : { riskGate: riskGate(node(policies['riskGate'])) }),
    },
  };
}

function surface(n: Node): MapSurface {
  const jira = node(n['jira']);
  const repoBase = typeof n['repo'] === 'object' ? optAttr(node(n['repo']), 'base') : undefined;
  return {
    id: attr(n, 'id'),
    label: attr(n, 'label'),
    repo: text(n['repo']),
    ...(repoBase === undefined ? {} : { repoBase }),
    jira: { project: attr(jira, 'project'), defaultIssueType: attr(jira, 'defaultIssueType') },
    components: list(node(n['components'])['component']).map((c): MapComponent => ({ id: attr(c, 'id'), label: attr(c, 'label') })),
    uses: list(n['uses']).map((u) => attr(u, 'surface')),
  };
}

function channel(n: Node): MapChannel {
  const confidence = optAttr(n, 'confidence');
  const platform = optAttr(n, 'platform');
  const team = optAttr(n, 'team');
  return {
    id: attr(n, 'id'),
    name: attr(n, 'name'),
    surface: attr(n, 'surface'),
    ...(confidence === undefined ? {} : { confidence: confidence as ChannelConfidence }),
    ...(platform === undefined ? {} : { platform: platform as ChannelPlatform }),
    ...(team === undefined ? {} : { teamId: team }),
    triggerEmoji: list(n['trigger']).map((t) => attr(t, 'emoji')),
  };
}

function triggers(n: Node): MapTriggers {
  const dm = n['directMessage'] === undefined ? undefined : node(n['directMessage']);
  const cli = n['cli'] === undefined ? undefined : node(n['cli']);
  return {
    messageActions: list(n['messageAction']).map((m) => ({ label: attr(m, 'label') })),
    emoji: list(n['emoji']).map((e) => {
      const min = optAttr(e, 'minReactors');
      return { slack: attr(e, 'slack'), teams: attr(e, 'teams'), ...(min === undefined ? {} : { minReactors: Number(min) }) };
    }),
    ...(dm === undefined ? {} : { directMessage: { images: bool(attr(dm, 'images')), text: bool(attr(dm, 'text')) } }),
    ...(cli === undefined ? {} : { cli: { enabled: bool(attr(cli, 'enabled')) } }),
  };
}

function term(n: Node): MapTerm {
  const component = optAttr(n, 'component');
  return { text: text(n), surface: attr(n, 'surface'), ...(component === undefined ? {} : { component }) };
}

function person(n: Node): MapPerson {
  const slackId = optAttr(n, 'slackId');
  const teamsId = optAttr(n, 'teamsId');
  const email = optAttr(n, 'email');
  const admin = optAttr(n, 'admin');
  return {
    ...(slackId === undefined ? {} : { slackId }),
    ...(teamsId === undefined ? {} : { teamsId }),
    handle: attr(n, 'handle'),
    ...(email === undefined ? {} : { email }),
    role: attr(n, 'role') as MapActorRole,
    ...(admin === undefined ? {} : { admin: bool(admin.trim()) }),
    owns: list(n['owns']).map((o): MapOwnership => {
      const component = optAttr(o, 'component');
      return { surface: attr(o, 'surface'), ...(component === undefined ? {} : { component }), primary: optAttr(o, 'primary') === 'true' || optAttr(o, 'primary') === '1' };
    }),
  };
}

function askBack(n: Node): { maxQuestionsPerIncident: number; suppressWhenReportersAtLeast: number } {
  return {
    maxQuestionsPerIncident: Number(attr(n, 'maxQuestionsPerIncident')),
    suppressWhenReportersAtLeast: Number(attr(n, 'suppressWhenReportersAtLeast')),
  };
}

function level(n: Node): AutonomyLevel {
  const requires = optAttr(n, 'requires');
  return {
    id: levelId(attr(n, 'id')),
    name: attr(n, 'name'),
    fixer: attr(n, 'fixer') as FixerStart,
    merge: attr(n, 'merge') as MergeActor,
    requires: requires === undefined ? [] : (requires.split(/\s+/).filter((g) => g !== '') as AutonomyGate[]),
  };
}

function change(n: Node): AutonomyChange {
  const changedBy = optAttr(n, 'changedBy');
  const changedAt = optAttr(n, 'changedAt');
  return { ...(changedBy === undefined ? {} : { changedBy }), ...(changedAt === undefined ? {} : { changedAt }) };
}

function riskGate(n: Node): MapRiskGate {
  return {
    maxFilesTouched: Number(attr(n, 'maxFilesTouched')),
    maxDiffLines: Number(attr(n, 'maxDiffLines')),
    forbiddenPaths: list(n['forbiddenPath']).map(text),
  };
}

// Narrowing helpers. The document passed the XSD, so these never see the wrong shape in practice.

function node(value: unknown): Node {
  return typeof value === 'object' && value !== null ? (value as Node) : {};
}

function list(value: unknown): Node[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => (typeof v === 'string' ? ({ '#text': v } as Node) : node(v)));
}

function optAttr(n: Node, name: string): string | undefined {
  const value = n[`@${name}`];
  return typeof value === 'string' ? value : undefined;
}

function attr(n: Node, name: string): string {
  return optAttr(n, name) ?? '';
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const inner = node(value)['#text'];
  return typeof inner === 'string' ? inner : '';
}

function bool(value: string): boolean {
  return value === 'true' || value === '1';
}

function levelId(value: string): AutonomyLevelId {
  return Number(value) as AutonomyLevelId;
}
