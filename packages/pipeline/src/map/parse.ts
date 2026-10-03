// Parse and validate workspace-context.xml into a typed WorkspaceMap (main 4.2).
// Validation (XSD, then Schematron) always runs first, so the conversion below can rely on
// the document's shape and only narrows `unknown` values; it does not re-check them.

import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { validate, type SchemaPaths } from '../schemas/validate.ts';
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
  xsd: fileURLToPath(new URL('../../../../schemas/workspace-context.xsd', import.meta.url)),
  sch: fileURLToPath(new URL('../../../../schemas/workspace-context.sch', import.meta.url)),
};

/**
 * Validate `xml` against the workspace XSD and Schematron, then convert it to a typed map.
 * Throws `InvalidMapError` carrying every validation error when the document is malformed,
 * breaks the XSD, or (if the XSD passes) breaks a cross-reference rule.
 */
export async function parseWorkspaceMap(xml: string): Promise<WorkspaceMap> {
  const result = await validate(xml, WORKSPACE_SCHEMAS);
  if (!result.valid) throw new InvalidMapError(result.errors);
  return convert(xml);
}

// Conversion from the parsed tree. Names mirror the XML.

type Node = Record<string, unknown>;

const ARRAY_ELEMENTS = new Set([
  'surface', 'component', 'channel', 'trigger', 'messageAction', 'emoji', 'term', 'person', 'owns', 'level', 'forbiddenPath',
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
  return {
    id: attr(n, 'id'),
    label: attr(n, 'label'),
    repo: text(n['repo']),
    jira: { project: attr(jira, 'project'), defaultIssueType: attr(jira, 'defaultIssueType') },
    components: list(node(n['components'])['component']).map((c): MapComponent => ({ id: attr(c, 'id'), label: attr(c, 'label') })),
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
  return {
    ...(slackId === undefined ? {} : { slackId }),
    ...(teamsId === undefined ? {} : { teamsId }),
    handle: attr(n, 'handle'),
    ...(email === undefined ? {} : { email }),
    role: attr(n, 'role') as MapActorRole,
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
