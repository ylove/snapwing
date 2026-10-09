// The redactor (#274): raw, JSON-escaped, and per-line forms of a secret, longest first.

import { describe, expect, it } from 'vitest';
import { SecretValue } from '../../src/onboard/interview/io.ts';
import { Redactor } from '../../src/onboard/interview/redactor.ts';

// A multi-line value built at run time, with no key markers, so no secret scanner mistakes it for a key.
const PEM = ['header-line-of-the-value', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'abcdefghijklmnop', 'footer-line-of-the-value'].join('\n');

describe('Redactor', () => {
  it('masks the raw form and the JSON-escaped form of a value', () => {
    const r = new Redactor();
    r.add(new SecretValue('pa"ss\\word-123'));
    expect(r.text('token pa"ss\\word-123 here')).toBe('token [secret] here');
    expect(r.text(JSON.stringify({ k: 'pa"ss\\word-123' }))).toBe('{"k":"[secret]"}');
  });

  it('masks each line of a multi-line value, raw and escaped', () => {
    const r = new Redactor();
    r.add(new SecretValue(PEM));
    expect(r.text(PEM)).not.toContain('MIIEvQ');
    expect(r.text('line: MIIEvQIBADANBgkqhkiG9w0BAQEFAASC only')).toBe('line: [secret] only');
    expect(r.text(JSON.stringify(PEM))).not.toContain('abcdefghijklmnop');
  });

  it('applies the longest value first, so a value containing another is masked whole', () => {
    const r = new Redactor();
    r.add(new SecretValue('abcdef'));
    r.add(new SecretValue('abcdef-and-more'));
    expect(r.text('x abcdef-and-more y')).toBe('x [secret] y');
  });

  it('ignores values too short to mask safely, and rewrites a saved record', () => {
    const r = new Redactor();
    r.add(new SecretValue('abc'));
    r.add(new SecretValue('sekret-token-1'));
    expect(r.text('abc')).toBe('abc');
    expect(r.record({ note: 'got sekret-token-1', n: 1 })).toEqual({ note: 'got [secret]', n: 1 });
  });
});
