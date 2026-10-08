import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GATE_CODES, buildClarifyRequest, evaluateGate, findGap, maybeAsk } from '../../src/clarify/index.ts';
import type { CandidateQuestion, ClarifyEvidence, GateContext } from '../../src/clarify/index.ts';
import type { CanonicalIncidentPayload, ContextBundle, ImageReading, Resolution } from '../../src/contracts/incident.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { createMockModelPort, writeMockFixture } from '../../src/models/mock.ts';
import type { ModelPort } from '../../src/ports/model.ts';

const exampleXml = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

const noModel: ModelPort = {
  complete: () => Promise.reject(new Error('model must not be called')),
  vision: () => Promise.reject(new Error('model must not be called')),
  classify: () => Promise.reject(new Error('model must not be called')),
};

const surfaceLabels = ['Website', 'Mobile App', 'B2B Admin Portal'];

const baseCtx = (over: Partial<GateContext> = {}): GateContext => ({
  maxQuestionsPerIncident: 1,
  suppressWhenReportersAtLeast: 3,
  questionsAsked: 0,
  reportersInWindow: 1,
  known: { surface: false, component: false, environment: false, screenshot: false },
  mapOptions: surfaceLabels,
  ...over,
});

const surfaceQuestion = (over: Partial<CandidateQuestion> = {}): CandidateQuestion => ({
  audience: 'reporter',
  kind: 'experiential',
  asks: 'surface',
  text: 'Which login page were you on?',
  options: surfaceLabels,
  screenshotRequest: false,
  ...over,
});

const codes = (failures: string[]): string[] => failures.map((f) => f.split(':')[0] ?? f);

describe('gate: main 7.2, ten cases', () => {
  it('1 passes: "Which login page were you on?" with three surface buttons', () => {
    expect(evaluateGate(surfaceQuestion(), baseCtx())).toEqual([]);
  });

  it('2 fails: "Is this production?" to a reporter', () => {
    const q = surfaceQuestion({ kind: 'technical', asks: 'environment', text: 'Is this production?', options: ['Yes', 'No'] });
    const failures = codes(evaluateGate(q, baseCtx()));
    expect(failures).toContain(GATE_CODES.technicalToReporter);
    expect(failures).toContain(GATE_CODES.technicalWording);
  });

  it('3 fails: a technical word the model labelled experiential is still caught', () => {
    const q = surfaceQuestion({ asks: 'other', text: 'What did the console say?', options: ['Nothing', 'An error'] });
    expect(codes(evaluateGate(q, baseCtx()))).toContain(GATE_CODES.technicalToReporter);
  });

  it('4 fails: one option is not enough', () => {
    expect(codes(evaluateGate(surfaceQuestion({ options: ['Website'] }), baseCtx()))).toContain(GATE_CODES.optionCount);
  });

  it('5 fails: five options are too many', () => {
    const many = ['Website', 'Mobile App', 'B2B Admin Portal', 'Kiosk', 'Watch'];
    const failures = codes(evaluateGate(surfaceQuestion({ options: many }), baseCtx({ mapOptions: many })));
    expect(failures).toContain(GATE_CODES.optionCount);
  });

  it('6 passes: a screenshot request with no options', () => {
    const q = surfaceQuestion({ asks: 'symptom', text: 'Can you post a screenshot of what you saw?', options: [], screenshotRequest: true });
    expect(evaluateGate(q, baseCtx())).toEqual([]);
  });

  it('7 fails: a screenshot request when a screenshot is already attached', () => {
    const q = surfaceQuestion({ asks: 'symptom', text: 'Can you post a screenshot of what you saw?', options: [], screenshotRequest: true });
    const ctx = baseCtx({ known: { surface: false, component: false, environment: false, screenshot: true } });
    expect(codes(evaluateGate(q, ctx))).toEqual([GATE_CODES.alreadyKnown]);
  });

  it('8 fails: asking for the surface when the resolution already has it', () => {
    const ctx = baseCtx({ known: { surface: true, component: false, environment: false, screenshot: false } });
    expect(codes(evaluateGate(surfaceQuestion(), ctx))).toEqual([GATE_CODES.alreadyKnown]);
  });

  it('9 fails: the budget is spent', () => {
    expect(codes(evaluateGate(surfaceQuestion(), baseCtx({ questionsAsked: 1 })))).toEqual([GATE_CODES.budget]);
    expect(evaluateGate(surfaceQuestion(), baseCtx({ questionsAsked: 1, maxQuestionsPerIncident: 2 }))).toEqual([]);
  });

  it('10 fails: three reporters is an incident, not a question', () => {
    expect(codes(evaluateGate(surfaceQuestion(), baseCtx({ reportersInWindow: 3 })))).toEqual([GATE_CODES.suppressed]);
    expect(evaluateGate(surfaceQuestion(), baseCtx({ reportersInWindow: 2 }))).toEqual([]);
  });

  it('11 lists every failed check, not only the first', () => {
    const q = surfaceQuestion({ kind: 'technical', asks: 'environment', text: 'Is this production?', options: ['Yes'] });
    const ctx = baseCtx({ questionsAsked: 1, reportersInWindow: 5 });
    const failures = codes(evaluateGate(q, ctx));
    expect(failures).toEqual(
      expect.arrayContaining([GATE_CODES.technicalToReporter, GATE_CODES.technicalWording, GATE_CODES.optionCount, GATE_CODES.budget, GATE_CODES.suppressed]),
    );
  });

  it('12 fails: surface options invented outside the map', () => {
    const q = surfaceQuestion({ options: ['Website', 'Smart fridge'] });
    expect(codes(evaluateGate(q, baseCtx()))).toEqual([GATE_CODES.optionsNotFromMap]);
  });

  it('13 an engineer question skips the reporter-only checks but keeps budget and volume', () => {
    const q = surfaceQuestion({ audience: 'engineer', kind: 'technical', asks: 'other', text: 'Which build is deployed?', options: [] });
    expect(evaluateGate(q, baseCtx())).toEqual([]);
    expect(codes(evaluateGate(q, baseCtx({ questionsAsked: 1 })))).toEqual([GATE_CODES.budget]);
  });
});

const reading = (hint: ImageReading['environmentHint']): ImageReading => ({
  surfaceSignals: {},
  uiElements: [],
  plainDescription: 'a screenshot of a blank page',
  sensitive: false,
  ...(hint === undefined ? {} : { environmentHint: hint }),
});

function scene(opts: { role?: 'reporter' | 'engineer'; text?: string; readings?: ImageReading[] } = {}): { payload: CanonicalIncidentPayload; bundle: ContextBundle } {
  return {
    payload: {
      eventId: '01K0000000000000000000C001',
      idempotencyKey: 'test-key',
      source: 'slack',
      reporter: { id: 'U0SALESLEAD', name: 'Pat', role: opts.role ?? 'reporter' },
      anchorText: opts.text ?? 'login is broken for me',
      context: { channelId: 'C0SALES', rawPayloadSnapshot: {} },
      timestamp: '2026-10-02T09:00:00.000Z',
    },
    bundle: {
      anchorId: 'anchor',
      included: [
        {
          id: 'anchor',
          authorId: 'U0SALESLEAD',
          text: opts.text ?? 'login is broken for me',
          timestamp: '2026-10-02T09:00:00.000Z',
          mentions: [],
          reactions: [],
          attachments: (opts.readings ?? []).map((r, i) => ({ kind: 'image' as const, url: `https://files.example.test/${i}.png`, reading: r })),
        },
      ],
      excluded: [],
      windowUsed: { oldest: '2026-10-02T08:00:00.000Z', latest: '2026-10-02T09:00:00.000Z', cap: 50 },
    },
  };
}

const unresolved: Resolution = { resolvedBy: 'unresolved', confidence: 0 };

describe('ask-back audience when someone else flagged the post (main 7.1 layer 2)', () => {
  it("the reporter-role the model sees is the anchor author's", async () => {
    const { payload } = scene({ role: 'engineer' });
    const flagged: CanonicalIncidentPayload = { ...payload, anchorAuthor: { id: 'U0SALES', name: 'Sam', role: 'reporter' } };
    const s = scene();
    expect((await buildClarifyRequest(flagged, s.bundle, { gap: 'surface', options: surfaceLabels })).prompt).toContain('<reporter-role>reporter</reporter-role>');
    expect((await buildClarifyRequest(payload, s.bundle, { gap: 'surface', options: surfaceLabels })).prompt).toContain('<reporter-role>engineer</reporter-role>');
  });
});

describe('maybeAsk: layers 1 to 3', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snapwing-clarify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function recorded(draft: CandidateQuestion, gap: 'surface' | 'component', s = scene(), resolution: Resolution = unresolved): Promise<ModelPort> {
    const options = gap === 'surface' ? surfaceLabels : (map.surfaces.find((x) => x.id === resolution.surfaceId)?.components.map((c) => c.label) ?? []);
    await writeMockFixture(dir, await buildClarifyRequest(s.payload, s.bundle, { gap, options }), { value: draft });
    return createMockModelPort({ fixturesDir: dir });
  }

  it('layer 1: a resolved component asks nothing and never calls the model', async () => {
    const { payload, bundle } = scene();
    const resolved: Resolution = { surfaceId: 'web', componentId: 'nav', resolvedBy: 'vocabulary', confidence: 0.8 };
    expect(await maybeAsk(payload, bundle, resolved, map, noModel)).toBeUndefined();
  });

  it('layer 1: one alerting surface settles the surface gap, so nothing is asked', async () => {
    const { payload, bundle } = scene();
    const evidence: ClarifyEvidence = { activeAlertSurfaces: ['web', 'web'] };
    expect(await maybeAsk(payload, bundle, unresolved, map, noModel, evidence)).toBeUndefined();
    expect(findGap(unresolved, map, { activeAlertSurfaces: ['web', 'mobile'] })).toBe('surface');
  });

  it('layer 1: a surface with several components and no component is a component gap', () => {
    expect(findGap({ surfaceId: 'web', resolvedBy: 'channel-explicit', confidence: 0.9 }, map)).toBe('component');
  });

  it('layer 3: surface buttons come from the map and the question passes', async () => {
    const s = scene();
    const model = await recorded(surfaceQuestion(), 'surface', s);
    const q = await maybeAsk(s.payload, s.bundle, unresolved, map, model);
    expect(q).toEqual({ audience: 'reporter', text: 'Which login page were you on?', options: surfaceLabels, asks: 'surface', gatePassed: true, gateFailures: [] });
  });

  it('layer 3: component buttons come from the resolved surface', async () => {
    const s = scene();
    const resolution: Resolution = { surfaceId: 'web', resolvedBy: 'channel-explicit', confidence: 0.9 };
    const labels = map.surfaces.find((x) => x.id === 'web')?.components.map((c) => c.label) ?? [];
    const draft = surfaceQuestion({ asks: 'component', text: 'Which part of the website was it?', options: labels.slice(0, 3) });
    const model = await recorded(draft, 'component', s, resolution);
    const q = await maybeAsk(s.payload, s.bundle, resolution, map, model);
    expect(q?.gatePassed).toBe(true);
    expect(q?.options).toEqual(labels.slice(0, 3));
  });

  it('layer 2: a technical question is routed to an engineer, not the reporter', async () => {
    const s = scene({ role: 'engineer' });
    const draft = surfaceQuestion({ audience: 'reporter', kind: 'technical', asks: 'other', text: 'Which build is deployed?', options: [] });
    const model = await recorded(draft, 'surface', s);
    const q = await maybeAsk(s.payload, s.bundle, unresolved, map, model);
    expect(q).toMatchObject({ audience: 'engineer', gatePassed: true });
  });

  it('layer 2: asking a sales rep "Is this production?" fails because the map already answers it', async () => {
    const s = scene({ role: 'reporter' });
    const draft = surfaceQuestion({ audience: 'engineer', kind: 'technical', asks: 'environment', text: 'Is this production?', options: [] });
    const model = await recorded(draft, 'surface', s);
    const q = await maybeAsk(s.payload, s.bundle, unresolved, map, model);
    expect(q?.gatePassed).toBe(false);
    expect(codes(q?.gateFailures ?? [])).toEqual([GATE_CODES.alreadyKnown]);
  });

  it('a screenshot with a known environment hint answers an environment question too', async () => {
    const s = scene({ role: 'engineer', readings: [reading('staging')] });
    const draft = surfaceQuestion({ audience: 'engineer', kind: 'technical', asks: 'environment', text: 'Is this staging?', options: [] });
    const model = await recorded(draft, 'surface', s);
    const q = await maybeAsk(s.payload, s.bundle, unresolved, map, model);
    expect(codes(q?.gateFailures ?? [])).toEqual([GATE_CODES.alreadyKnown]);
  });

  it('budget spent: no model call, empty text, failure listed', async () => {
    const { payload, bundle } = scene();
    const q = await maybeAsk(payload, bundle, unresolved, map, noModel, { questionsAsked: 1 });
    expect(q).toMatchObject({ text: '', gatePassed: false });
    expect(codes(q?.gateFailures ?? [])).toEqual([GATE_CODES.budget]);
  });

  it('three reporters: suppressed without a model call', async () => {
    const { payload, bundle } = scene();
    const q = await maybeAsk(payload, bundle, unresolved, map, noModel, { reportersInWindow: 3 });
    expect(q?.gatePassed).toBe(false);
    expect(codes(q?.gateFailures ?? [])).toEqual([GATE_CODES.suppressed]);
  });

  it('the policy values come from the map, not the defaults', async () => {
    const { payload, bundle } = scene();
    const strict: WorkspaceMap = { ...map, policies: { ...map.policies, askBack: { maxQuestionsPerIncident: 1, suppressWhenReportersAtLeast: 2 } } };
    const q = await maybeAsk(payload, bundle, unresolved, strict, noModel, { reportersInWindow: 2 });
    expect(codes(q?.gateFailures ?? [])).toEqual([GATE_CODES.suppressed]);
  });
});
