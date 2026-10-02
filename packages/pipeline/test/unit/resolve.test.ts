import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, CanonicalIncidentPayload, ContextBundle, ImageReading, Resolution, SourceMessage } from '../../src/contracts/incident.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { createMockModelPort, writeMockFixture } from '../../src/models/mock.ts';
import type { ModelPort } from '../../src/ports/model.ts';
import { buildResolveRequest, resolve } from '../../src/resolve/index.ts';

const exampleXml = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

/** A model that fails the test if anything calls it. */
const noModel: ModelPort = {
  complete: () => Promise.reject(new Error('model must not be called')),
  vision: () => Promise.reject(new Error('model must not be called')),
  classify: () => Promise.reject(new Error('model must not be called')),
};

const reading = (signals: ImageReading['surfaceSignals']): ImageReading => ({
  surfaceSignals: signals,
  uiElements: [],
  plainDescription: 'a screenshot',
  sensitive: false,
});

interface Scene {
  channelId: string;
  text: string;
  mentions?: string[];
  context?: string[];
  readings?: ImageReading[];
  snapshot?: Record<string, unknown>;
  source?: CanonicalIncidentPayload['source'];
}

function build(scene: Scene): { payload: CanonicalIncidentPayload; bundle: ContextBundle } {
  const attachments: Attachment[] = (scene.readings ?? []).map((r, i) => ({ kind: 'image', url: `https://files.example.test/${i}.png`, reading: r }));
  const message = (id: string, text: string, extra: Partial<SourceMessage> = {}): SourceMessage => ({
    id,
    authorId: 'U0SALESLEAD',
    text,
    timestamp: '2026-10-02T09:00:00.000Z',
    mentions: [],
    reactions: [],
    attachments: [],
    ...extra,
  });
  const included = [
    ...(scene.context ?? []).map((t, i) => message(`ctx-${i}`, t)),
    message('anchor', scene.text, { mentions: scene.mentions ?? [], attachments }),
  ];
  return {
    payload: {
      eventId: '01K0000000000000000000R001',
      idempotencyKey: 'test-key',
      source: scene.source ?? 'slack',
      reporter: { id: 'U0SALESLEAD', name: 'Pat', role: 'reporter' },
      anchorText: scene.text,
      context: { channelId: scene.channelId, rawPayloadSnapshot: scene.snapshot ?? {} },
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

const run = (scene: Scene, model?: ModelPort): Promise<Resolution> => {
  const { payload, bundle } = build(scene);
  return resolve(payload, bundle, map, model);
};

interface Row {
  name: string;
  scene: Scene;
  expected: Partial<Resolution>;
}

describe('resolve: deterministic steps, one row per step of main 4.4 (main 4.2 example map)', () => {
  const rows: Row[] = [
    {
      name: '1 mention: person with a primary component',
      scene: { channelId: 'C0MKTBUGS', text: '@webDev1 is the nav broken?' },
      expected: { surfaceId: 'web', componentId: 'nav', ownerId: 'webDev1', resolvedBy: 'mention', repo: 'github.com/acme/web', jiraProject: 'WEB' },
    },
    {
      name: '1 mention: platform mention id on the anchor message',
      scene: { channelId: 'C0SALES', text: 'it keeps crashing', mentions: ['U0MOBDEV'] },
      expected: { surfaceId: 'mobile', ownerId: 'mobDev', resolvedBy: 'mention', jiraProject: 'APP' },
    },
    {
      name: '1 mention: Slack markup <@ID>',
      scene: { channelId: 'C0SALES', text: '<@U0MOBDEV> can you look?' },
      expected: { surfaceId: 'mobile', ownerId: 'mobDev', resolvedBy: 'mention' },
    },
    {
      name: '2 channel with confidence explicit',
      scene: { channelId: 'C0WEBBUGS', text: 'the totals look off' },
      expected: { surfaceId: 'web', ownerId: 'webDev1', resolvedBy: 'channel-explicit', repo: 'github.com/acme/web' },
    },
    {
      name: '2 explicit channel outranks a vocabulary match',
      scene: { channelId: 'C0APPBUGS', text: 'the portal is down' },
      expected: { surfaceId: 'mobile', resolvedBy: 'channel-explicit' },
    },
    {
      name: '3 vocabulary term with a component',
      scene: { channelId: 'C0SALES', text: 'the cart is empty after login' },
      expected: { surfaceId: 'web', componentId: 'checkout', resolvedBy: 'vocabulary' },
    },
    {
      name: '3 vocabulary matches whole words only',
      scene: { channelId: 'C0SALES', text: 'the supermarket report is blank' },
      expected: { surfaceId: 'admin', resolvedBy: 'channel-inferred' },
    },
    {
      name: '3 vocabulary term found in an earlier message of the window',
      scene: { channelId: 'C0SALES', text: 'this is broken again', context: ['Market is slow today'] },
      expected: { surfaceId: 'web', resolvedBy: 'vocabulary' },
    },
    {
      name: '3 vocabulary terms that disagree fall through',
      scene: { channelId: 'C0SALES', text: 'the cart works but the portal does not' },
      expected: { surfaceId: 'admin', resolvedBy: 'channel-inferred' },
    },
    {
      name: '4 image: URL bar with a vocabulary term',
      scene: { channelId: 'C0SALES', text: 'see screenshot', readings: [reading({ urlBar: 'https://market.example.test/cart' })] },
      expected: { surfaceId: 'web', componentId: 'checkout', resolvedBy: 'image' },
    },
    {
      name: '4 image: app chrome',
      scene: { channelId: 'C0SALES', text: 'see screenshot', readings: [reading({ chrome: 'mobile' })] },
      expected: { surfaceId: 'mobile', resolvedBy: 'image' },
    },
    {
      name: '4 image: page title names the surface',
      scene: { channelId: 'C0SALES', text: 'see screenshot', readings: [reading({ pageTitle: 'Admin Console - Users' })] },
      expected: { surfaceId: 'admin', resolvedBy: 'image' },
    },
    {
      name: '4 image signals rank below vocabulary',
      scene: { channelId: 'C0SALES', text: 'the cart is empty', readings: [reading({ chrome: 'mobile' })] },
      expected: { surfaceId: 'web', resolvedBy: 'vocabulary' },
    },
    {
      name: '4 image signals rank above an inferred channel',
      scene: { channelId: 'C0SALES', text: 'see screenshot', readings: [reading({ chrome: 'web' })] },
      expected: { surfaceId: 'web', resolvedBy: 'image' },
    },
    {
      name: '4 image with unknown chrome is not a signal',
      scene: { channelId: 'C0SALES', text: 'see screenshot', readings: [reading({ chrome: 'unknown' })] },
      expected: { surfaceId: 'admin', resolvedBy: 'channel-inferred' },
    },
    {
      name: '5 channel with confidence inferred',
      scene: { channelId: 'C0SALES', text: 'something is wrong' },
      expected: { surfaceId: 'admin', resolvedBy: 'channel-inferred', jiraProject: 'ADM' },
    },
    {
      name: '6 alert payload service name',
      scene: { channelId: 'C0ALERTS', text: 'ALERT 5xx rate high', source: 'alert_webhook', snapshot: { service: 'Mobile', environment: 'production' } },
      expected: { surfaceId: 'mobile', resolvedBy: 'alert' },
    },
    {
      name: '6 alert payload service matches a repo name',
      scene: { channelId: 'C0ALERTS', text: 'ALERT latency', source: 'alert_webhook', snapshot: { serviceName: 'admin' } },
      expected: { surfaceId: 'admin', resolvedBy: 'alert' },
    },
  ];

  it.each(rows)('$name', async ({ scene, expected }) => {
    const result = await run(scene, noModel);
    expect(result).toMatchObject(expected);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('unresolved from payload channel with no usable alert fields', async () => {
    expect(await run({ channelId: 'C0ALERTS', text: 'ALERT', source: 'alert_webhook', snapshot: { service: 'billing' } })).toEqual({
      resolvedBy: 'unresolved',
      confidence: 0,
    });
  });
});

describe('resolve: the main 4.4 example', () => {
  it('"@webDev1 is the nav broken?" in #market-bugs resolves with no model call', async () => {
    let calls = 0;
    const failIfCalled: ModelPort = {
      complete: () => (calls++, Promise.reject(new Error('model called'))),
      vision: () => (calls++, Promise.reject(new Error('model called'))),
      classify: () => (calls++, Promise.reject(new Error('model called'))),
    };
    const result = await run({ channelId: 'C0MKTBUGS', text: '@webDev1 is the nav broken?' }, failIfCalled);
    expect(result).toMatchObject({ surfaceId: 'web', componentId: 'nav', ownerId: 'webDev1', resolvedBy: 'mention' });
    expect(calls).toBe(0);
  });

  it('stops at the first confident hit: later steps are never consulted', async () => {
    const scene: Scene = {
      channelId: 'C0MKTBUGS',
      text: '@webDev1 the portal nav is broken',
      readings: [reading({ chrome: 'mobile' })],
      snapshot: { service: 'admin' },
    };
    expect((await run(scene, noModel)).resolvedBy).toBe('mention');
  });
});

describe('resolve: step 7 (model) and step 8 hand-off', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snapwing-resolve-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const scene: Scene = { channelId: 'C0NOWHERE', text: 'the receipts page shows a blank total' };

  async function recorded(value: unknown): Promise<ModelPort> {
    const { payload, bundle } = build(scene);
    await writeMockFixture(dir, buildResolveRequest(payload, bundle, map), { value });
    return createMockModelPort({ fixturesDir: dir });
  }

  it('7 infers surface and component from the recorded model answer', async () => {
    const model = await recorded({ surfaceId: 'web', componentId: 'checkout', confidence: 0.82 });
    expect(await run(scene, model)).toMatchObject({
      surfaceId: 'web',
      componentId: 'checkout',
      resolvedBy: 'llm',
      confidence: 0.82,
      repo: 'github.com/acme/web',
    });
  });

  it('7 ignores a component that does not belong to the answered surface', async () => {
    const model = await recorded({ surfaceId: 'mobile', componentId: 'checkout', confidence: 0.9 });
    const result = await run(scene, model);
    expect(result).toMatchObject({ surfaceId: 'mobile', resolvedBy: 'llm' });
    expect(result.componentId).toBeUndefined();
  });

  it('8 low model confidence is unresolved', async () => {
    const model = await recorded({ surfaceId: 'web', confidence: 0.3 });
    expect(await run(scene, model)).toEqual({ resolvedBy: 'unresolved', confidence: 0 });
  });

  it('8 a model answer of unknown is unresolved', async () => {
    const model = await recorded({ surfaceId: 'unknown', confidence: 0.9 });
    expect((await run(scene, model)).resolvedBy).toBe('unresolved');
  });

  it('8 no model and no deterministic hit is unresolved, so the ask-back gate can run', async () => {
    expect(await run(scene)).toEqual({ resolvedBy: 'unresolved', confidence: 0 });
  });

  it('the step 7 request injects the map and escapes report text', () => {
    const { payload, bundle } = build({ ...scene, text: 'a <b>bold</b> claim' });
    const request = buildResolveRequest(payload, bundle, map);
    expect(request.prompt).toContain('<surface id="web" label="Website">');
    expect(request.prompt).toContain('<term surface="web" component="checkout">cart</term>');
    expect(request.prompt).toContain('a &lt;b&gt;bold&lt;/b&gt; claim');
    expect(request.task).toBe('triage');
  });
});
