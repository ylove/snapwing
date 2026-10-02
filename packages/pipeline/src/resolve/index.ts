// Runtime resolution: the confidence stack (main 4.4). Signals are consumed in order and the first
// confident hit wins. Steps 1 to 6 are deterministic and never call the model; step 7 calls it only when
// they all miss. Step 8, the ask-back gate (main 7), runs when this returns resolvedBy 'unresolved'.

import type { CanonicalIncidentPayload, ContextBundle, ImageReading, Resolution, SourceMessage } from '../contracts/incident.ts';
import { FROM_PAYLOAD } from '../map/types.ts';
import type { MapSurface, WorkspaceMap } from '../map/types.ts';
import type { ModelPort } from '../ports/model.ts';
import { LLM_MIN_CONFIDENCE, UNKNOWN_SURFACE, buildResolveRequest } from './llm.ts';
import { containsTerm, findPerson, findSurface, hasComponent, ownerIdOf, probableOwner } from './lookup.ts';

export { buildResolvePrompt, buildResolveRequest, RESOLVE_SCHEMA_NAME } from './llm.ts';

type ResolvedBy = Resolution['resolvedBy'];

/** Fixed confidence per step: earlier steps are more trustworthy. The LLM reports its own. */
export const STEP_CONFIDENCE = {
  mention: 0.95,
  'channel-explicit': 0.9,
  vocabulary: 0.8,
  image: 0.7,
  'channel-inferred': 0.6,
  alert: 0.6,
} as const;

interface Hit {
  surfaceId: string;
  componentId?: string;
  ownerId?: string;
  resolvedBy: ResolvedBy;
  confidence: number;
}

/** Fills repo, Jira project, and (when the step did not name one) the probable owner from the map. */
function finish(map: WorkspaceMap, hit: Hit): Resolution | undefined {
  const surface = findSurface(map, hit.surfaceId);
  if (surface === undefined) return undefined;
  const componentId = hit.componentId !== undefined && hasComponent(surface, hit.componentId) ? hit.componentId : undefined;
  const ownerId = hit.ownerId ?? optional(probableOwner(map, surface.id, componentId), ownerIdOf);
  return {
    surfaceId: surface.id,
    ...(componentId === undefined ? {} : { componentId }),
    ...(ownerId === undefined ? {} : { ownerId }),
    repo: surface.repo,
    jiraProject: surface.jira.project,
    resolvedBy: hit.resolvedBy,
    confidence: hit.confidence,
  };
}

function optional<T, U>(value: T | undefined, fn: (v: T) => U): U | undefined {
  return value === undefined ? undefined : fn(value);
}

function anchorMessage(bundle: ContextBundle): SourceMessage | undefined {
  return bundle.included.find((m) => m.id === bundle.anchorId);
}

/** The anchor first, then the rest of the window, so the reporter's own words win over older chatter. */
function textsInOrder(payload: CanonicalIncidentPayload, bundle: ContextBundle): string[] {
  return [payload.anchorText, ...bundle.included.filter((m) => m.id !== bundle.anchorId).map((m) => m.text)];
}

function channelSurface(map: WorkspaceMap, payload: CanonicalIncidentPayload, confidence: 'explicit' | 'inferred'): string | undefined {
  const channel = map.channels.find((c) => c.id === payload.context.channelId);
  if (channel === undefined || channel.surface === FROM_PAYLOAD) return undefined;
  return (channel.confidence ?? 'inferred') === confidence ? channel.surface : undefined;
}

// Step 1: explicit mention of a person with known ownership.

function mentionRefs(payload: CanonicalIncidentPayload, bundle: ContextBundle): string[] {
  const refs: string[] = [...(anchorMessage(bundle)?.mentions ?? [])];
  for (const m of payload.anchorText.matchAll(/<@([A-Za-z0-9]+)(?:\|[^>]*)?>|@([A-Za-z0-9._-]+)/g)) {
    const ref = m[1] ?? m[2];
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

function byMention(map: WorkspaceMap, payload: CanonicalIncidentPayload, bundle: ContextBundle): Hit | undefined {
  const channelHint = [channelSurface(map, payload, 'explicit'), channelSurface(map, payload, 'inferred')];
  for (const ref of mentionRefs(payload, bundle)) {
    const person = findPerson(map, ref);
    if (person === undefined || person.owns.length === 0) continue;
    const primary = person.owns.find((o) => o.primary);
    const surfaces = [...new Set(person.owns.map((o) => o.surface))];
    const surfaceId =
      primary?.surface ?? (surfaces.length === 1 ? surfaces[0] : channelHint.find((s) => s !== undefined && surfaces.includes(s)));
    if (surfaceId === undefined) continue;
    const componentId = primary?.surface === surfaceId ? primary.component : undefined;
    return { surfaceId, ...(componentId === undefined ? {} : { componentId }), ownerId: ownerIdOf(person), resolvedBy: 'mention', confidence: STEP_CONFIDENCE.mention };
  }
  return undefined;
}

// Step 3: vocabulary match in the message text.

function byVocabulary(map: WorkspaceMap, payload: CanonicalIncidentPayload, bundle: ContextBundle): Hit | undefined {
  for (const text of textsInOrder(payload, bundle)) {
    const matched = map.vocabulary.filter((t) => containsTerm(text, t.text));
    if (matched.length === 0) continue;
    const surfaces = new Set(matched.map((t) => t.surface));
    if (surfaces.size !== 1) continue; // terms disagree on the surface: not confident, try the next signal
    const [surfaceId] = surfaces;
    if (surfaceId === undefined) continue;
    const components = new Set(matched.flatMap((t) => (t.component === undefined ? [] : [t.component])));
    const [componentId] = components;
    return {
      surfaceId,
      ...(components.size === 1 && componentId !== undefined ? { componentId } : {}),
      resolvedBy: 'vocabulary',
      confidence: STEP_CONFIDENCE.vocabulary,
    };
  }
  return undefined;
}

// Step 4: surface signals from the vision pass.

const CHROME_WORDS: Record<NonNullable<ImageReading['surfaceSignals']['chrome']>, string[]> = {
  web: ['web', 'website', 'site'],
  mobile: ['mobile', 'app', 'ios', 'android'],
  admin: ['admin', 'portal'],
  desktop: ['desktop'],
  unknown: [],
};

function readings(bundle: ContextBundle): ImageReading[] {
  return bundle.included.flatMap((m) => m.attachments.flatMap((a) => (a.reading === undefined ? [] : [a.reading])));
}

function surfaceWords(s: MapSurface): string[] {
  return `${s.id} ${s.label}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');
}

function uniqueSurface(map: WorkspaceMap, match: (s: MapSurface) => boolean): MapSurface | undefined {
  const found = map.surfaces.filter(match);
  return found.length === 1 ? found[0] : undefined;
}

function byImage(map: WorkspaceMap, bundle: ContextBundle): Hit | undefined {
  for (const reading of readings(bundle)) {
    const { urlBar, pageTitle, chrome } = reading.surfaceSignals;
    // URL bar and page title are the strongest: a vocabulary term or the surface's own name inside them.
    for (const text of [urlBar, pageTitle]) {
      if (text === undefined || text.trim() === '') continue;
      const terms = map.vocabulary.filter((t) => containsTerm(text, t.text));
      const termSurfaces = new Set(terms.map((t) => t.surface));
      const [fromTerm] = termSurfaces;
      if (termSurfaces.size === 1 && fromTerm !== undefined) {
        const components = new Set(terms.flatMap((t) => (t.component === undefined ? [] : [t.component])));
        const [componentId] = components;
        return { surfaceId: fromTerm, ...(components.size === 1 && componentId !== undefined ? { componentId } : {}), resolvedBy: 'image', confidence: STEP_CONFIDENCE.image };
      }
      const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
      const named = uniqueSurface(map, (s) => surfaceWords(s).some((w) => w.length >= 3 && tokens.has(w)));
      if (named !== undefined) return { surfaceId: named.id, resolvedBy: 'image', confidence: STEP_CONFIDENCE.image };
    }
    if (chrome !== undefined && chrome !== 'unknown') {
      const words = CHROME_WORDS[chrome];
      const bySignal = uniqueSurface(map, (s) => surfaceWords(s).some((w) => words.includes(w)));
      if (bySignal !== undefined) return { surfaceId: bySignal.id, resolvedBy: 'image', confidence: STEP_CONFIDENCE.image };
    }
  }
  return undefined;
}

// Step 6: alert payload fields (service name).

const ALERT_FIELDS = ['surface', 'service', 'serviceName', 'service_name', 'app', 'application'] as const;

function byAlert(map: WorkspaceMap, payload: CanonicalIncidentPayload): Hit | undefined {
  const snapshot = payload.context.rawPayloadSnapshot;
  for (const field of ALERT_FIELDS) {
    const value = snapshot[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const name = value.trim().toLowerCase();
    const surface = uniqueSurface(map, (s) => {
      const repoName = s.repo.split('/').pop()?.toLowerCase();
      return [s.id, s.label, repoName, s.jira.project].some((c) => c !== undefined && c.toLowerCase() === name);
    });
    if (surface !== undefined) return { surfaceId: surface.id, resolvedBy: 'alert', confidence: STEP_CONFIDENCE.alert };
    const terms = new Set(map.vocabulary.filter((t) => t.text.toLowerCase() === name).map((t) => t.surface));
    const [fromTerm] = terms;
    if (terms.size === 1 && fromTerm !== undefined) return { surfaceId: fromTerm, resolvedBy: 'alert', confidence: STEP_CONFIDENCE.alert };
  }
  return undefined;
}

// Step 7: model inference.

async function byModel(map: WorkspaceMap, payload: CanonicalIncidentPayload, bundle: ContextBundle, model: ModelPort): Promise<Hit | undefined> {
  const { value } = await model.classify(buildResolveRequest(payload, bundle, map));
  if (value.surfaceId === UNKNOWN_SURFACE || value.confidence < LLM_MIN_CONFIDENCE) return undefined;
  const surface = findSurface(map, value.surfaceId);
  if (surface === undefined) return undefined; // the model named a surface the map does not have
  const componentId = value.componentId !== undefined && hasComponent(surface, value.componentId) ? value.componentId : undefined;
  return { surfaceId: surface.id, ...(componentId === undefined ? {} : { componentId }), resolvedBy: 'llm', confidence: value.confidence };
}

/**
 * Resolve surface, component, and owner for an incident. Returns the first confident hit of steps 1 to 7
 * with `resolvedBy` naming the step, or `resolvedBy: 'unresolved'` so the ask-back gate (step 8) can run.
 * `model` is only touched at step 7; omit it to run the deterministic steps alone.
 */
export async function resolve(
  payload: CanonicalIncidentPayload,
  bundle: ContextBundle,
  map: WorkspaceMap,
  model?: ModelPort,
): Promise<Resolution> {
  const explicit = channelSurface(map, payload, 'explicit');
  const inferred = channelSurface(map, payload, 'inferred');
  const steps: (() => Hit | undefined)[] = [
    () => byMention(map, payload, bundle),
    () => (explicit === undefined ? undefined : { surfaceId: explicit, resolvedBy: 'channel-explicit', confidence: STEP_CONFIDENCE['channel-explicit'] }),
    () => byVocabulary(map, payload, bundle),
    () => byImage(map, bundle),
    () => (inferred === undefined ? undefined : { surfaceId: inferred, resolvedBy: 'channel-inferred', confidence: STEP_CONFIDENCE['channel-inferred'] }),
    () => byAlert(map, payload),
  ];
  for (const step of steps) {
    const hit = step();
    const resolution = hit === undefined ? undefined : finish(map, hit);
    if (resolution !== undefined) return resolution;
  }
  if (model !== undefined) {
    const hit = await byModel(map, payload, bundle, model);
    const resolution = hit === undefined ? undefined : finish(map, hit);
    if (resolution !== undefined) return resolution;
  }
  return { resolvedBy: 'unresolved', confidence: 0 };
}
