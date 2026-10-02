import { describe, expect, it } from 'vitest';
import type { ContextBundle, ImageReading, SourceMessage } from '../../src/contracts/incident.ts';
import type { Anchor } from '../../src/context/collect.ts';
import { acceptResolutionSignal } from '../../src/context/resolution-signal.ts';
import {
  NOT_CLASSIFIED_REASON,
  isSegmentAnswer,
  parseSegmentationPrompt,
  segment,
  segmentationRequest,
  type SegmentAnswer,
} from '../../src/context/segment.ts';
import { createMockModelPort, writeMockFixture } from '../../src/models/mock.ts';

const FIXTURES = new URL('../fixtures/segment/', import.meta.url).pathname;
// Run once with SNAPWING_RECORD_SEGMENT=1 to (re)write the recordings from the answers below.
const RECORD = process.env['SNAPWING_RECORD_SEGMENT'] === '1';

function msg(id: string, minute: number, text: string, extra: Partial<SourceMessage> = {}): SourceMessage {
  return {
    id,
    authorId: 'U-dana',
    text,
    timestamp: `2026-10-01T14:${String(minute).padStart(2, '0')}:00Z`,
    mentions: [],
    reactions: [],
    attachments: [],
    ...extra,
  };
}

function pile(anchorId: string, messages: SourceMessage[], excluded: ContextBundle['excluded'] = []): [ContextBundle, Anchor] {
  const anchorMessage = messages.find((m) => m.id === anchorId) as SourceMessage;
  return [
    {
      anchorId,
      included: messages,
      excluded,
      windowUsed: { oldest: '2026-10-01T13:50:00Z', latest: '2026-10-01T14:40:00Z', cap: 40 },
    },
    { channelId: 'C-eng', message: anchorMessage },
  ];
}

function answer(
  included: string[],
  excluded: [string, string][],
  resolutionMessageId = '',
): SegmentAnswer {
  return { included, excluded: excluded.map(([id, reason]) => ({ id, reason })), resolutionMessageId };
}

async function run(_name: string, raw: ContextBundle, anchor: Anchor, response: SegmentAnswer): Promise<ContextBundle> {
  if (RECORD) await writeMockFixture(FIXTURES, await segmentationRequest(raw, anchor), { value: response }, { includePrompt: true });
  return segment(raw, anchor, createMockModelPort({ fixturesDir: FIXTURES }));
}

const reading: ImageReading = {
  errorText: 'Cannot read properties of undefined',
  surfaceSignals: { urlBar: 'app.example.test/checkout', pageTitle: 'Checkout', chrome: 'web' },
  uiElements: ['Pay now'],
  environmentHint: 'production',
  plainDescription: 'the pay button does nothing',
  sensitive: false,
};

describe('segment: six histories', () => {
  it('1. a burst around the anchor, with unrelated chatter excluded', async () => {
    const messages = [
      msg('m1', 5, 'anyone want lunch?', { authorId: 'U-sam' }),
      msg('m2', 20, 'checkout is throwing a 500 for me', { reactions: ['eyes'] }),
      msg('m3', 21, 'same here on the pay button', { authorId: 'U-marcus' }),
      msg('m4', 22, 'ticket for the offsite is up', { authorId: 'U-sam' }),
    ];
    const [raw, anchor] = pile('m2', messages);
    const out = await run('burst', raw, anchor, answer(['m2', 'm3'], [['m1', 'lunch chatter, 15 minutes before'], ['m4', 'offsite logistics']]));
    expect(out.included.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(out.excluded).toEqual([
      { id: 'm1', reason: 'lunch chatter, 15 minutes before' },
      { id: 'm4', reason: 'offsite logistics' },
    ]);
    expect(out.anchorId).toBe('m2');
    expect(out.windowUsed).toEqual(raw.windowUsed);
    expect(out.resolutionSignal).toBeUndefined();
  });

  it('2. thread replies and a matching screenshot stay in', async () => {
    const messages = [
      msg('m1', 10, 'the pay button is dead', { attachments: [{ kind: 'image', url: 'att-1', reading }] }),
      msg('m2', 11, 'seeing it too', { authorId: 'U-marcus', threadParentId: 'm1' }),
      msg('m3', 12, 'unrelated: new hire starts monday', { authorId: 'U-sam' }),
    ];
    const [raw, anchor] = pile('m1', messages);
    const out = await run('thread', raw, anchor, answer(['m1', 'm2'], [['m3', 'different topic']]));
    expect(out.included.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.excluded).toEqual([{ id: 'm3', reason: 'different topic' }]);
  });

  it('3. a sensitive reading is redacted in the prompt the model sees', async () => {
    const secret: ImageReading = {
      ...reading,
      errorText: 'token sk-test-0000-fake leaked',
      uiElements: ['key sk-test-0000-fake'],
      sensitive: true,
    };
    const messages = [msg('m1', 10, 'login screen looks broken', { attachments: [{ kind: 'image', url: 'att-2', reading: secret }] })];
    const [raw, anchor] = pile('m1', messages);
    const request = await segmentationRequest(raw, anchor);
    expect(request.prompt).not.toContain('sk-test-0000');
    expect(request.prompt).toContain('the pay button does nothing');
    const out = await run('sensitive', raw, anchor, answer(['m1'], []));
    expect(out.included).toHaveLength(1);
    // The bundle itself keeps the unredacted reading; only the prompt is redacted.
    expect(out.included[0]?.attachments[0]?.reading?.errorText).toContain('sk-test-0000');
  });

  it('4. a lone anchor with nothing else in the window', async () => {
    const [raw, anchor] = pile('m1', [msg('m1', 10, 'export to CSV is empty')]);
    const out = await run('lone', raw, anchor, answer(['m1'], []));
    expect(out.included.map((m) => m.id)).toEqual(['m1']);
    expect(out.excluded).toEqual([]);
  });

  it('5. messages collectWindow already excluded keep their reason', async () => {
    const messages = [msg('m1', 10, 'search returns nothing'), msg('m2', 11, 'chatter')];
    const [raw, anchor] = pile('m1', messages, [{ id: 'old-1', reason: 'over-cap' }]);
    const out = await run('overcap', raw, anchor, answer(['m1'], [['m2', 'not about search']]));
    expect(out.excluded).toEqual([
      { id: 'old-1', reason: 'over-cap' },
      { id: 'm2', reason: 'not about search' },
    ]);
  });

  it('6. a sloppy answer is reconciled: dropped anchor, invented id, missing id, double listing', async () => {
    const messages = [msg('m1', 10, 'invoice page 404s'), msg('m2', 11, 'same'), msg('m3', 12, 'lunch'), msg('m4', 13, 'standup moved')];
    const [raw, anchor] = pile('m1', messages);
    // Leaves out the anchor, invents m9, never mentions m4, lists m2 as included and excluded.
    const out = await run(
      'sloppy',
      raw,
      anchor,
      answer(['m2', 'm9'], [['m2', 'second thoughts'], ['m3', 'lunch'], ['m9', 'ghost']]),
    );
    expect(out.included.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.excluded).toEqual([
      { id: 'm3', reason: 'lunch' },
      { id: 'm4', reason: NOT_CLASSIFIED_REASON },
    ]);
  });
});

describe('segment: resolution signals', () => {
  const positives: [string, string][] = [
    ['nvm', 'nvm, works now'],
    ['wrong account', 'that was me, I was on the wrong account'],
    ['already fixed', 'already fixed in the deploy that just went out'],
  ];

  it.each(positives)('after the anchor: %s sets the signal', async (_name, text) => {
    const messages = [msg('m1', 10, 'cannot log in, 403 on every page'), msg('m2', 14, text, { authorId: 'U-dana' })];
    const [raw, anchor] = pile('m1', messages);
    const out = await run(`after-${_name}`, raw, anchor, answer(['m1', 'm2'], [], 'm2'));
    expect(out.resolutionSignal).toEqual({ messageId: 'm2', text });
  });

  it.each(positives)('before the anchor: %s sets no signal', async (_name, text) => {
    const messages = [msg('m1', 5, text, { authorId: 'U-sam' }), msg('m2', 10, 'cannot log in, 403 on every page')];
    const [raw, anchor] = pile('m2', messages);
    const out = await run(`before-${_name}`, raw, anchor, answer(['m2'], [['m1', 'earlier, different issue']], ''));
    expect(out.resolutionSignal).toBeUndefined();
  });

  it('refuses a before-anchor claim even when the model makes it', async () => {
    const messages = [msg('m1', 5, 'nvm, works now'), msg('m2', 10, 'cannot log in')];
    const [raw, anchor] = pile('m2', messages);
    const out = await run('claim-before', raw, anchor, answer(['m2'], [['m1', 'earlier']], 'm1'));
    expect(out.resolutionSignal).toBeUndefined();
  });
});

describe('acceptResolutionSignal', () => {
  const anchor = msg('m5', 10, 'broken');
  const later = msg('m6', 12, 'nvm, works now');
  const same = msg('m7', 10, 'nvm, works now');

  it('accepts a later message', () => {
    expect(acceptResolutionSignal('m6', [anchor, later], anchor)).toEqual({ messageId: 'm6', text: 'nvm, works now' });
  });
  it('orders same-instant messages by id', () => {
    expect(acceptResolutionSignal('m7', [anchor, same], anchor)?.messageId).toBe('m7');
  });
  it('rejects empty, unknown, anchor, and earlier ids', () => {
    expect(acceptResolutionSignal(undefined, [anchor, later], anchor)).toBeUndefined();
    expect(acceptResolutionSignal('', [anchor, later], anchor)).toBeUndefined();
    expect(acceptResolutionSignal('nope', [anchor, later], anchor)).toBeUndefined();
    expect(acceptResolutionSignal('m5', [anchor, later], anchor)).toBeUndefined();
    expect(acceptResolutionSignal('m6', [anchor, msg('m6', 8, 'nvm')], anchor)).toBeUndefined();
  });
});

describe('segmentation request and prompt', () => {
  it('uses the segmentation task, a JSON schema, and the XML prompt', async () => {
    const [raw, anchor] = pile('m1', [msg('m1', 10, 'a <b> & "c"')]);
    const request = await segmentationRequest(raw, anchor);
    expect(request.task).toBe('segmentation');
    expect(request.schemaName).toBe('segmentation');
    expect(request.schema.type).toBe('object');
    expect(request.prompt).toContain('<anchor id="m1"/>');
    expect(request.prompt).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(request.system).toContain('resolution signal');
  });

  it('validates answers', () => {
    expect(isSegmentAnswer(answer(['a'], [['b', 'why']], ''))).toBe(true);
    expect(isSegmentAnswer({ included: ['a'], excluded: [{ id: 'b' }], resolutionMessageId: '' })).toBe(false);
    expect(isSegmentAnswer({ included: [1], excluded: [], resolutionMessageId: '' })).toBe(false);
    expect(isSegmentAnswer(null)).toBe(false);
  });

  it('rejects a prompt file missing its elements', () => {
    expect(() => parseSegmentationPrompt('<segmentation-prompt/>')).toThrow(/needs/);
  });
});
