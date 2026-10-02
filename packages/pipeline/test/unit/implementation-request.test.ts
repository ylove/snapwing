import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildImplementationRequest,
  ImplementationRequestParseError,
  parseImplementationRequest,
  validateImplementationRequest,
  type ImplementationRequestInput,
} from '../../src/prompts/implementation-request.ts';

const example = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../../examples/${name}`, import.meta.url)), 'utf8');
const single = example('implementation-request.example.xml');
const parent = example('implementation-request.parent.example.xml');

describe('implementation-request.xsd', () => {
  it('validates the main 9.2 example', async () => {
    expect(await validateImplementationRequest(single)).toEqual({ valid: true, errors: [] });
  });

  it('validates the B 6.2 parent example', async () => {
    expect(await validateImplementationRequest(parent)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a bad issue key', async () => {
    const result = await validateImplementationRequest(single.replace('issue="WEB-1042"', 'issue="web1042"'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/issue/);
  });

  it('rejects a handoff mode outside review|auto', async () => {
    const result = await validateImplementationRequest(single.replace('mode="review"', 'mode="yolo"'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/mode/);
  });

  it('rejects a document missing the constraints element', async () => {
    const result = await validateImplementationRequest(single.replace(/<constraints>[\s\S]*<\/constraints>/, ''));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/handoff|constraints/);
  });

  it('rejects an out-of-range autonomy level', async () => {
    const result = await validateImplementationRequest(single.replace('autonomy="2"', 'autonomy="7"'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/autonomy/);
  });
});

describe('parseImplementationRequest', () => {
  it('parses the main 9.2 example into a typed single request', () => {
    const req = parseImplementationRequest(single);
    if (req.kind !== 'single') throw new Error('expected single');
    expect(req.issue).toBe('WEB-1042');
    expect(req.surface).toBe('web');
    expect(req.component).toBe('checkout');
    expect(req.intent).toMatch(/^Applying a promo code.*checkout page\.$/);
    expect(req.evidence.map((e) => e.kind)).toEqual(['report', 'screenshot', 'alert']);
    expect(req.evidence[0]).toMatchObject({ kind: 'report', source: 'slack', channel: 'market-bugs', ts: '1727540000.000100' });
    expect(req.evidence[2]).toEqual({ kind: 'alert', none: true });
    expect(req.diagnosis?.confidence).toBe('medium');
    expect(req.diagnosis?.files).toHaveLength(2);
    expect(req.constraints.tests.required).toBe(true);
    expect(req.constraints.forbidden).toEqual(['Do not modify pricing rules or promo eligibility logic']);
    expect(req.handoff).toEqual({ mode: 'review', autonomy: 2, branch: 'fix/WEB-1042-promo-null-price', base: 'dev' });
  });

  it('parses the B 6.2 parent example', () => {
    const req = parseImplementationRequest(parent);
    if (req.kind !== 'parent') throw new Error('expected parent');
    expect(req.workItems.map((w) => w.id)).toEqual(['wi-1', 'wi-2']);
    expect(req.workItems[1]).toMatchObject({ dependsOn: ['wi-1'], consumes: ['c-price-format-v2'], produces: [] });
    expect(req.mergeOrder).toEqual(['wi-1', 'wi-2']);
    expect(req.handoff).toEqual({ mode: 'review', autonomy: 2, allOrNothing: true });
  });

  it('rejects malformed XML, a wrong root, and content that disagrees with kind', () => {
    expect(() => parseImplementationRequest('<implementation-request')).toThrow(ImplementationRequestParseError);
    expect(() => parseImplementationRequest('<other/>')).toThrow(/root element/);
    expect(() => parseImplementationRequest(single.replace('issue="WEB-1042"', 'issue="WEB-1042" kind="parent"'))).toThrow(/parent request must not contain <evidence>/);
    expect(() => parseImplementationRequest(parent.replace(' kind="parent"', ''))).toThrow(/single request must not contain <workItems>/);
  });
});

describe('buildImplementationRequest', () => {
  it('round-trips both examples through parse, build, and parse', async () => {
    for (const xml of [single, parent]) {
      const parsed = parseImplementationRequest(xml);
      const rebuilt = buildImplementationRequest(parsed);
      expect(await validateImplementationRequest(rebuilt)).toEqual({ valid: true, errors: [] });
      expect(parseImplementationRequest(rebuilt)).toEqual(parsed);
    }
  });

  it('builds a minimal single request that validates, escaping markup in text and attributes', async () => {
    const input: ImplementationRequestInput = {
      issue: 'API-7',
      intent: 'Handle a < b && c > d in the "parser"',
      evidence: [{ kind: 'report', source: 'cli', reporter: 'a"b@example.com', text: 'x &amp; y' }],
      constraints: { scope: 'src/parser', tests: { required: false, text: 'Optional' }, forbidden: [] },
      handoff: { mode: 'auto', autonomy: 3 },
    };
    const xml = buildImplementationRequest(input);
    expect(await validateImplementationRequest(xml)).toEqual({ valid: true, errors: [] });
    const parsed = parseImplementationRequest(xml);
    expect(parsed).toEqual({ kind: 'single', ...input });
  });
});
