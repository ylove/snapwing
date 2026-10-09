import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseImplementationRequest } from '../../src/prompts/implementation-request.ts';
import { checkConstraints, MAX_VERDICT_LENGTH, parseReviewVerdict, pathTokens, verdictText } from '../../src/review/verdict.ts';

const exampleXml = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../examples/${name}`, import.meta.url)), 'utf8');
const singleXml = exampleXml('implementation-request.example.xml');
const single = parseImplementationRequest(singleXml);
const parent = parseImplementationRequest(exampleXml('implementation-request.parent.example.xml'));

describe('parseReviewVerdict: valid', () => {
  it('parses every field', () => {
    const r = parseReviewVerdict(
      JSON.stringify({
        verdict: 'request-changes',
        reasons: ['missing guard'],
        constraintViolations: [{ constraint: 'scope', file: 'src/a.ts', note: 'outside' }],
        regressionTest: { path: 'test/a.test.ts' },
      }),
    );
    expect(r).toEqual({
      ok: true,
      verdict: {
        verdict: 'request-changes',
        reasons: ['missing guard'],
        constraintViolations: [{ constraint: 'scope', file: 'src/a.ts', note: 'outside' }],
        regressionTest: { path: 'test/a.test.ts' },
      },
    });
  });

  it('accepts approve with no reasons, defaults violations, tolerates BOM and whitespace', () => {
    expect(parseReviewVerdict(`\uFEFF\n${JSON.stringify({ verdict: 'approve', reasons: [] })}\n`)).toEqual({
      ok: true,
      verdict: { verdict: 'approve', reasons: [], constraintViolations: [] },
    });
  });

  it('drops unknown keys at every level and treats null optionals as absent', () => {
    const r = parseReviewVerdict(
      JSON.stringify({
        verdict: 'escalate',
        reasons: ['unclear'],
        cost: 1,
        constraintViolations: [{ constraint: 'tests', file: null, note: 'n', extra: true }],
        regressionTest: { path: 'p', extra: 1 },
      }),
    );
    expect(r).toEqual({
      ok: true,
      verdict: {
        verdict: 'escalate',
        reasons: ['unclear'],
        constraintViolations: [{ constraint: 'tests', note: 'n' }],
        regressionTest: { path: 'p' },
      },
    });
  });
});

describe('parseReviewVerdict: errors', () => {
  const code = (text: string) => {
    const r = parseReviewVerdict(text);
    return r.ok ? 'ok' : r.error.code;
  };
  const field = (text: string) => {
    const r = parseReviewVerdict(text);
    return r.ok ? undefined : r.error.field;
  };

  it('rejects empty, non-JSON, and non-object input', () => {
    expect(code('  \n')).toBe('empty');
    expect(code('I approve this change.')).toBe('not-json');
    expect(code('[1]')).toBe('not-object');
    expect(code('"approve"')).toBe('not-object');
    expect(code('x'.repeat(MAX_VERDICT_LENGTH + 1))).toBe('too-large');
  });

  it('rejects a missing or unknown verdict', () => {
    expect(code('{"reasons":[]}')).toBe('unknown-verdict');
    expect(code('{"verdict":"lgtm","reasons":[]}')).toBe('unknown-verdict');
    expect(field('{"verdict":"lgtm","reasons":[]}')).toBe('verdict');
  });

  it('rejects missing or malformed fields', () => {
    expect(field('{"verdict":"approve"}')).toBe('reasons');
    expect(field('{"verdict":"approve","reasons":[1]}')).toBe('reasons[0]');
    expect(field('{"verdict":"request-changes","reasons":[]}')).toBe('reasons');
    expect(field('{"verdict":"approve","reasons":[],"constraintViolations":{}}')).toBe('constraintViolations');
    expect(field('{"verdict":"approve","reasons":[],"constraintViolations":[{"note":"n"}]}')).toBe('constraintViolations[0].constraint');
    expect(field('{"verdict":"approve","reasons":[],"constraintViolations":[{"constraint":"scope"}]}')).toBe('constraintViolations[0].note');
    expect(field('{"verdict":"approve","reasons":[],"constraintViolations":[{"constraint":"s","note":"n","file":3}]}')).toBe('constraintViolations[0].file');
    expect(field('{"verdict":"approve","reasons":[],"regressionTest":{}}')).toBe('regressionTest.path');
    expect(field('{"verdict":"approve","reasons":[],"regressionTest":"x"}')).toBe('regressionTest');
  });
});

describe('verdictText: the verdict at the end of a review agent\'s final message (#263)', () => {
  const approve = { verdict: 'approve', reasons: [], constraintViolations: [] };
  const changes = { verdict: 'request-changes', reasons: ['Handle the empty cart'], constraintViolations: [] };

  it('takes a message that is the verdict', () => {
    expect(verdictText(` ${JSON.stringify(changes)}\n`)).toBe(JSON.stringify(changes));
  });

  it('takes the last fenced block that is a verdict', () => {
    const message = `An example:\n\`\`\`json\n${JSON.stringify(approve)}\n\`\`\`\nMy verdict:\n\`\`\`json\n${JSON.stringify(changes)}\n\`\`\`\n`;
    expect(parseReviewVerdict(verdictText(message))).toEqual({ ok: true, verdict: changes });
  });

  it('skips a later fenced block that is not a verdict', () => {
    const message = `\`\`\`json\n${JSON.stringify(changes)}\n\`\`\`\n\`\`\`\nnpm test\n\`\`\``;
    expect(parseReviewVerdict(verdictText(message))).toEqual({ ok: true, verdict: changes });
  });

  it('takes a trailing object after prose', () => {
    expect(parseReviewVerdict(verdictText(`Request changes. ${JSON.stringify(changes)}`))).toEqual({ ok: true, verdict: changes });
  });

  it('hands back text the parser refuses when there is no verdict', () => {
    expect(verdictText('Looks good to me.')).toBe('Looks good to me.');
    expect(parseReviewVerdict(verdictText('```json\n{"verdict":"ship-it"}\n```'))).toMatchObject({ ok: false, error: { code: 'unknown-verdict' } });
  });
});

describe('pathTokens', () => {
  it('reads paths and files out of prose', () => {
    expect(pathTokens('Only files under src/cart and src/promo unless a test requires otherwise')).toEqual(['src/cart', 'src/promo']);
    expect(pathTokens('Do not edit package.json or .github/workflows/, e.g. CI.')).toEqual(['package.json', '.github/workflows']);
    expect(pathTokens('Do not modify pricing rules or promo eligibility logic')).toEqual([]);
  });
});

describe('checkConstraints over the example requests', () => {
  it('passes files inside scope and a test file elsewhere (tests required)', () => {
    expect(checkConstraints(['src/cart/lineItem.ts', 'src/promo/apply.ts', 'test/cart/promo.test.ts'], single)).toEqual([]);
  });

  it('flags files outside scope', () => {
    expect(checkConstraints(['src/promo/apply.ts', 'src/pricing/rules.ts', 'src/cartography/x.ts'], single)).toEqual([
      { constraint: 'scope', file: 'src/pricing/rules.ts', note: 'outside the request scope (src/cart, src/promo)' },
      { constraint: 'scope', file: 'src/cartography/x.ts', note: 'outside the request scope (src/cart, src/promo)' },
    ]);
  });

  it('flags a non-test file outside scope even when tests are required', () => {
    expect(checkConstraints(['package.json'], single).map((v) => v.file)).toEqual(['package.json']);
  });

  it('flags forbidden paths named in the request, ahead of scope', () => {
    const req = parseImplementationRequest(
      singleXml.replace('Do not modify pricing rules or promo eligibility logic', 'Do not modify src/promo/eligibility.ts or anything under src/cart/pricing'),
    );
    expect(checkConstraints(['src/promo/eligibility.ts', 'src/cart/pricing/x.ts', 'src/cart/ok.ts'], req)).toEqual([
      { constraint: 'forbidden', file: 'src/promo/eligibility.ts', note: 'touches src/promo/eligibility.ts, which the request forbids' },
      { constraint: 'forbidden', file: 'src/cart/pricing/x.ts', note: 'touches src/cart/pricing, which the request forbids' },
    ]);
  });

  it('normalizes ./ and backslashes', () => {
    expect(checkConstraints(['./src/cart/a.ts', 'src\\promo\\b.ts'], single)).toEqual([]);
  });

  it('uses the union of work-item scopes (globs and exact files) for a parent request', () => {
    expect(checkConstraints(['src/price/format.ts', 'src/cart/deep/line.ts', 'src/price/other.ts', 'README.md'], parent)).toEqual([
      { constraint: 'scope', file: 'src/price/other.ts', note: 'outside the request scope (src/price/format.ts, src/cart/**)' },
      { constraint: 'scope', file: 'README.md', note: 'outside the request scope (src/price/format.ts, src/cart/**)' },
    ]);
  });

  it('flags nothing when the constraints name no path', () => {
    const req = parseImplementationRequest(
      singleXml.replace('Only files under src/cart and src/promo unless a test requires otherwise', 'Keep the change small'),
    );
    expect(checkConstraints(['anything/at/all.ts'], req)).toEqual([]);
  });
});
