// Triage plan (main 8.1). Model outputs are recorded fixtures under test/fixtures/triage, keyed by the exact
// prompt. Re-record with SNAPWING_RECORD=1 after changing a prompt builder; review the diff before committing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalIncidentPayload, ContextBundle, DedupeResult, Resolution } from '../../src/contracts/incident.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { createMockModelPort, writeMockFixture } from '../../src/models/mock.ts';
import type { ModelPort } from '../../src/ports/model.ts';
import { parseTriagePrompts } from '../../src/triage/prompt.ts';
import { buildTriageRequest, plan, TriageError } from '../../src/triage/plan.ts';
import type { TriageDraft } from '../../src/triage/plan.ts';
import { buildScoutRequest, gatherScoutEvidence, isGroundedDiagnosis } from '../../src/triage/scout.ts';
import type { Diagnosis, RepoReader, ScoutInput } from '../../src/triage/scout.ts';

const exampleXml = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');
const fixturesDir = fileURLToPath(new URL('../fixtures/triage', import.meta.url));
const record = process.env['SNAPWING_RECORD'] === '1';

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

const model: ModelPort = createMockModelPort({ fixturesDir });

/** An in-memory repo behind the read-only interface. Counts calls so tests can see nothing else is used. */
function fakeRepo(files: Record<string, string>): RepoReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    search(query) {
      calls.push(`search:${query}`);
      return Promise.resolve(
        Object.entries(files)
          .filter(([path, content]) => path.toLowerCase().includes(query.toLowerCase()) || content.toLowerCase().includes(query.toLowerCase()))
          .map(([path, content]) => ({ path, snippet: content.split('\n')[0] ?? '' })),
      );
    },
    read(path) {
      calls.push(`read:${path}`);
      const content = files[path];
      return content === undefined ? Promise.reject(new Error(`no such file ${path}`)) : Promise.resolve(content);
    },
  };
}

interface Scene {
  channelId: string;
  text: string;
  context?: string[];
  errorText?: string;
}

function build(scene: Scene): { payload: CanonicalIncidentPayload; bundle: ContextBundle } {
  const base = { authorId: 'U0SALESLEAD', timestamp: '2026-10-02T09:00:00.000Z', mentions: [], reactions: [] };
  const included = [
    ...(scene.context ?? []).map((text, i) => ({ ...base, id: `ctx-${i}`, text, attachments: [] })),
    {
      ...base,
      id: 'anchor',
      text: scene.text,
      attachments:
        scene.errorText === undefined
          ? []
          : [
              {
                kind: 'image' as const,
                url: 'https://files.example.test/shot.png',
                reading: { errorText: scene.errorText, surfaceSignals: {}, uiElements: [], plainDescription: 'an error dialog', sensitive: false },
              },
            ],
    },
  ];
  return {
    payload: {
      eventId: '01K0000000000000000000T001',
      idempotencyKey: 'test-key',
      source: 'slack',
      reporter: { id: 'U0SALESLEAD', name: 'Pat', role: 'reporter' },
      anchorText: scene.text,
      context: { channelId: scene.channelId, rawPayloadSnapshot: {} },
      timestamp: '2026-10-02T09:00:00.000Z',
    },
    bundle: {
      anchorId: 'anchor',
      included,
      excluded: [],
      windowUsed: { oldest: '2026-10-02T08:00:00.000Z', latest: '2026-10-02T09:00:00.000Z', cap: 50 },
    },
  };
}

const noDupes: DedupeResult = { candidates: [], decision: 'none' };

const checkoutFiles = {
  'src/cart/lineItem.ts': 'export function price(item) {\n  return item.qty * item.unit;\n}\n// checkout total',
  'src/promo/apply.ts': 'export function applyPromo(cart) {\n  cart.lines.forEach((l) => { l.price = undefined; });\n}\n// checkout promo',
  'README.md': 'docs',
};

interface Incident {
  name: string;
  scene: Scene;
  resolution: Resolution;
  dedupe: DedupeResult;
  repo?: Record<string, string>;
  scoutOutput?: Diagnosis;
  draft: TriageDraft;
  expect: { autonomyLevel: 0 | 1 | 2 | 3; action: string; projectKey: string; componentId?: string; diagnosisFiles?: string[]; linkTo?: string };
}

const incidents: Incident[] = [
  {
    name: 'web checkout bug with a scout diagnosis: surface override gives level 2',
    scene: { channelId: 'C0SALES', text: 'the cart total goes blank after I add a promo code', errorText: 'price is undefined' },
    resolution: { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/acme/web', jiraProject: 'WEB', resolvedBy: 'vocabulary', confidence: 0.8 },
    dedupe: noDupes,
    repo: checkoutFiles,
    scoutOutput: { confidence: 'medium', files: [{ path: 'src/promo/apply.ts', note: 'applyPromo clears the line price' }] },
    draft: {
      action: 'create_issue',
      issueType: 'Bug',
      summary: 'Cart total blank after applying a promo code',
      description: 'Pat reports the cart total goes blank after adding a promo code.\n\nThe scout suspects applyPromo clears the line price.',
      priority: 'High',
      labels: ['checkout', 'snapwing'],
      componentId: 'checkout',
    },
    expect: { autonomyLevel: 2, action: 'create_issue', projectKey: 'WEB', componentId: 'checkout', diagnosisFiles: ['src/promo/apply.ts'] },
  },
  {
    name: 'web login bug: component override beats the surface and gives level 1',
    scene: { channelId: 'C0WEBBUGS', text: 'I cannot log in on the website, it just spins', context: ['same here since this morning'] },
    resolution: { surfaceId: 'web', componentId: 'auth-web', repo: 'github.com/acme/web', jiraProject: 'WEB', resolvedBy: 'channel-explicit', confidence: 0.9 },
    dedupe: noDupes,
    repo: { 'src/auth/login.ts': 'export async function login() { /* auth-web */ }' },
    scoutOutput: { confidence: 'low', files: [] },
    draft: {
      action: 'create_issue',
      issueType: 'Incident',
      summary: 'Web login spins forever',
      description: 'Two people cannot log in on the website since this morning.',
      priority: 'High',
      labels: ['login'],
      componentId: 'auth-web',
      suggestedAssigneeEmail: 'webdev1@example.test',
    },
    expect: { autonomyLevel: 1, action: 'create_issue', projectKey: 'WEB', componentId: 'auth-web', diagnosisFiles: [] },
  },
  {
    name: 'admin report that duplicates an open issue links to it, no repo, no scout',
    scene: { channelId: 'C0SALES', text: 'the portal export is empty again' },
    resolution: { surfaceId: 'admin', repo: 'github.com/acme/admin', jiraProject: 'ADM', resolvedBy: 'vocabulary', confidence: 0.8 },
    dedupe: { candidates: [{ issueKey: 'ADM-77', summary: 'Portal export returns an empty file', score: 0.91 }], decision: 'link' },
    draft: {
      action: 'link_existing',
      linkTo: 'ADM-77',
      issueType: 'Bug',
      summary: 'Portal export is empty again',
      description: 'Another report of the empty portal export.',
      priority: 'Medium',
      labels: [],
    },
    expect: { autonomyLevel: 1, action: 'link_existing', projectKey: 'ADM', linkTo: 'ADM-77' },
  },
  {
    name: 'Highest priority web bug drops to level 1 even on a level 2 surface',
    scene: { channelId: 'C0SALES', text: 'customers are being charged twice at checkout, please look right now' },
    resolution: { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/acme/web', jiraProject: 'WEB', resolvedBy: 'vocabulary', confidence: 0.8 },
    dedupe: noDupes,
    draft: {
      action: 'create_issue',
      issueType: 'Incident',
      summary: 'Customers charged twice at checkout',
      description: 'Customers are being charged twice at checkout.',
      priority: 'Highest',
      labels: ['payments'],
      componentId: 'checkout',
    },
    expect: { autonomyLevel: 1, action: 'create_issue', projectKey: 'WEB', componentId: 'checkout' },
  },
];

function scoutInput(inc: Incident): ScoutInput {
  const { payload, bundle } = build(inc.scene);
  const surface = map.surfaces.find((s) => s.id === inc.resolution.surfaceId);
  return { payload, bundle, resolution: inc.resolution, ...(surface === undefined ? {} : { surface }) };
}

/** With SNAPWING_RECORD=1, write the recordings for every incident from the real prompt builders. */
describe.runIf(record)('recording', () => {
  it('writes fixtures', async () => {
    for (const inc of incidents) {
      const { payload, bundle } = build(inc.scene);
      if (inc.repo !== undefined && inc.scoutOutput !== undefined) {
        const input = scoutInput(inc);
        const evidence = await gatherScoutEvidence(fakeRepo(inc.repo), input);
        await writeMockFixture(fixturesDir, await buildScoutRequest(input, evidence), { value: inc.scoutOutput });
      }
      const request = await buildTriageRequest(payload, bundle, inc.resolution, inc.dedupe, map, inc.scoutOutput);
      await writeMockFixture(fixturesDir, request, { value: { ...inc.draft, autonomyLevel: 3 } });
    }
  });
});

describe('plan: four recorded incidents', () => {
  for (const inc of incidents) {
    it(inc.name, async () => {
      const { payload, bundle } = build(inc.scene);
      const repo = inc.repo === undefined ? undefined : fakeRepo(inc.repo);
      const result = await plan(payload, bundle, inc.resolution, inc.dedupe, map, model, repo);
      expect(result.autonomyLevel).toBe(inc.expect.autonomyLevel);
      expect(result.action).toBe(inc.expect.action);
      expect(result.projectKey).toBe(inc.expect.projectKey);
      expect(result.componentId).toBe(inc.expect.componentId);
      expect(result.linkTo).toBe(inc.expect.linkTo);
      expect(result.summary).toBe(inc.draft.summary);
      expect(result.priority).toBe(inc.draft.priority);
      expect(result.diagnosis?.files.map((f) => f.path)).toEqual(inc.expect.diagnosisFiles);
      expect((result.descriptionAdf as { type: string }).type).toBe('doc');
      expect(Object.keys(result)).not.toContain('implementationPromptXml');
    });
  }

  it('autonomyLevel is never taken from the model (the recordings all say 3)', async () => {
    for (const inc of incidents) {
      const { payload, bundle } = build(inc.scene);
      const result = await plan(payload, bundle, inc.resolution, inc.dedupe, map, model, inc.repo === undefined ? undefined : fakeRepo(inc.repo));
      expect(result.autonomyLevel).not.toBe(3);
    }
  });
});

describe('scout', () => {
  it('only calls search and read on the reader, and caps what it reads', async () => {
    const inc = incidents[0]!;
    const repo = fakeRepo(inc.repo ?? {});
    await plan(...planArgs(inc), repo);
    expect(repo.calls.length).toBeGreaterThan(0);
    expect(repo.calls.every((c) => c.startsWith('search:') || c.startsWith('read:'))).toBe(true);
  });

  it('RepoReader has no write methods by type', () => {
    const reader = fakeRepo({});
    // @ts-expect-error a RepoReader has no write method
    expect(reader.write).toBeUndefined();
  });

  it('gathers evidence from the component and the screenshot error text', async () => {
    const inc = incidents[0]!;
    const evidence = await gatherScoutEvidence(fakeRepo(checkoutFiles), scoutInput(inc));
    expect(evidence.queries).toEqual(['checkout', 'price is undefined']);
    expect(evidence.files.map((f) => f.path)).toEqual(['src/cart/lineItem.ts', 'src/promo/apply.ts']);
  });

  it('survives a reader that throws', async () => {
    const broken: RepoReader = { search: () => Promise.reject(new Error('down')), read: () => Promise.reject(new Error('down')) };
    const inc = incidents[3]!;
    const { payload, bundle } = build(inc.scene);
    const result = await plan(payload, bundle, inc.resolution, inc.dedupe, map, model, broken);
    expect(result.diagnosis).toBeUndefined();
  });

  it('rejects a diagnosis that names a path the scout never saw', () => {
    const ok = isGroundedDiagnosis(new Set(['a.ts']));
    expect(ok({ confidence: 'low', files: [{ path: 'a.ts', note: 'x' }] })).toBe(true);
    expect(ok({ confidence: 'low', files: [{ path: 'invented.ts', note: 'x' }] })).toBe(false);
    expect(ok({ confidence: 'sure', files: [] })).toBe(false);
  });
});

function planArgs(inc: Incident): [CanonicalIncidentPayload, ContextBundle, Resolution, DedupeResult, WorkspaceMap, ModelPort] {
  const { payload, bundle } = build(inc.scene);
  return [payload, bundle, inc.resolution, inc.dedupe, map, model];
}

describe('plan: validation and errors', () => {
  const stub = (value: unknown): ModelPort => ({
    complete: () => Promise.reject(new Error('unused')),
    vision: () => Promise.reject(new Error('unused')),
    classify: (request) => {
      const ok = request.validate(value);
      return ok
        ? Promise.resolve({ value, model: 'stub', attempts: 1 as const })
        : Promise.reject(new TriageError('model output failed validation'));
    },
  });
  const goodDraft: TriageDraft = { action: 'create_issue', issueType: 'Bug', summary: 's', description: 'd', priority: 'Low', labels: [] };

  it('the request validator rejects a link to an issue the duplicate check did not return', async () => {
    const inc = incidents[2]!;
    const { payload, bundle } = build(inc.scene);
    const request = await buildTriageRequest(payload, bundle, inc.resolution, inc.dedupe, map);
    expect(request.validate({ ...inc.draft, linkTo: 'ADM-999' })).toBe(false);
    expect(request.validate(inc.draft)).toBe(true);
    expect(request.validate({ ...inc.draft, action: 'create_issue' })).toBe(false);
  });

  it('the request validator rejects unknown priorities, long summaries, and foreign components', async () => {
    const inc = incidents[0]!;
    const { payload, bundle } = build(inc.scene);
    const request = await buildTriageRequest(payload, bundle, inc.resolution, inc.dedupe, map);
    expect(request.validate({ ...goodDraft, priority: 'Urgent' })).toBe(false);
    expect(request.validate({ ...goodDraft, summary: 'x'.repeat(121) })).toBe(false);
    expect(request.validate({ ...goodDraft, componentId: 'nonexistent' })).toBe(false);
    expect(request.validate({ ...goodDraft, componentId: 'nav' })).toBe(true);
  });

  it('falls back to the resolved component and the surface Jira project', async () => {
    const inc = incidents[0]!;
    const { payload, bundle } = build(inc.scene);
    const { jiraProject: _drop, ...rest } = inc.resolution;
    const result = await plan(payload, bundle, rest, inc.dedupe, map, stub(goodDraft));
    expect(result.projectKey).toBe('WEB');
    expect(result.componentId).toBe('checkout');
    expect(result.autonomyLevel).toBe(2);
  });

  it('throws when no Jira project can be found', async () => {
    const inc = incidents[0]!;
    const { payload, bundle } = build(inc.scene);
    await expect(plan(payload, bundle, { resolvedBy: 'unresolved', confidence: 0 }, inc.dedupe, map, stub(goodDraft))).rejects.toThrow(TriageError);
  });

  it('a missing recording fails loudly instead of inventing a plan', async () => {
    const inc = incidents[3]!;
    const { payload, bundle } = build({ ...inc.scene, text: 'a report with no recording' });
    await expect(plan(payload, bundle, inc.resolution, inc.dedupe, map, model)).rejects.toThrow();
  });
});

describe('triage prompts', () => {
  it('parses both system prompts from prompts/triage.xml', async () => {
    const xml = readFileSync(fileURLToPath(new URL('../../src/prompts/triage.xml', import.meta.url)), 'utf8');
    const p = parseTriagePrompts(xml);
    expect(p.scoutSystem).toContain('read-only');
    expect(p.triageSystem).toContain('Do not state a level of autonomy');
    expect(() => parseTriagePrompts('<triage-prompts/>')).toThrow();
  });
});
