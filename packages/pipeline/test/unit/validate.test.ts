import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validate, validateSchematron, validateXsd } from '../../src/schemas/validate.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/xml/${name}`, import.meta.url));
const read = (name: string): string => readFileSync(fixture(name), 'utf8');

const xsd = fixture('mini.xsd');
const sch = fixture('mini.sch');
const valid = read('mini-valid.xml');
const structuralError = read('mini-structural-error.xml');
const xrefError = read('mini-xref-error.xml');

describe('validateXsd', () => {
  it('passes a valid document (with an xs:include resolved from a sibling file)', async () => {
    expect(await validateXsd(valid, xsd)).toEqual({ valid: true, errors: [] });
  });

  it('reports a structural error with its line number', async () => {
    const result = await validateXsd(structuralError, xsd);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(5);
    expect(result.errors[0]?.message).toMatch(/attribute 'surface' is required but missing/);
  });

  it('reports a type error from an included simple type', async () => {
    const doc = valid.replace('id="web"', 'id="Web Site"');
    const result = await validateXsd(doc, xsd);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.line).toBe(3);
  });

  it('reports a malformed document instead of throwing', async () => {
    const result = await validateXsd('<workspace>\n  <surface>\n</workspace>', xsd);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.line !== undefined)).toBe(true);
  });

  it('reports a missing or broken schema instead of throwing', async () => {
    const missing = await validateXsd(valid, fixture('does-not-exist.xsd'));
    expect(missing.valid).toBe(false);
    expect(missing.errors[0]?.message).toMatch(/does-not-exist\.xsd could not be applied/);

    const broken = await validateXsd(valid, fixture('mini-valid.xml'));
    expect(broken.valid).toBe(false);
    expect(broken.errors[0]?.message).toMatch(/could not be applied/);
  });
});

describe('validateSchematron', () => {
  it('passes a valid document', async () => {
    expect(await validateSchematron(valid, sch)).toEqual({ valid: true, errors: [] });
  });

  it('reports a failed cross-reference assert with its message and line', async () => {
    const result = await validateSchematron(xrefError, sch);
    expect(result).toEqual({
      valid: false,
      errors: [{ line: 6, rule: 'channel-surface-exists', message: 'Channel app-bugs names surface mobile, which is not declared.' }],
    });
  });

  it('reports a fired report rule', async () => {
    const doc = valid.replace('id="mobile"', 'id="web"').replace('surface="mobile"', 'surface="web"');
    const result = await validateSchematron(doc, sch);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { line: 3, rule: 'surface-duplicate', message: 'Surface web is declared more than once.' },
      { line: 4, rule: 'surface-duplicate', message: 'Surface web is declared more than once.' },
    ]);
  });

  it('reports a malformed document instead of throwing', async () => {
    const result = await validateSchematron('<workspace><surface></workspace>', sch);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/^Schematron validation failed/);
  });

  it('reports a missing rule file instead of throwing', async () => {
    const result = await validateSchematron(valid, fixture('does-not-exist.sch'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/does-not-exist\.sch could not be loaded/);
  });
});

describe('validate', () => {
  it('passes a document valid against both', async () => {
    expect(await validate(valid, { xsd, sch })).toEqual({ valid: true, errors: [] });
  });

  it('runs Schematron only when the XSD passes', async () => {
    // This document breaks the XSD and would also fail the Schematron assert (no surface attribute);
    // only the XSD error comes back.
    const result = await validate(structuralError, { xsd, sch });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/Schemas validity error/);
  });

  it('reports Schematron errors once the XSD passes', async () => {
    const result = await validate(xrefError, { xsd, sch });
    expect(result.errors).toEqual([{ line: 6, rule: 'channel-surface-exists', message: 'Channel app-bugs names surface mobile, which is not declared.' }]);
  });

  it('runs the XSD alone when no Schematron is given', async () => {
    expect(await validate(xrefError, { xsd })).toEqual({ valid: true, errors: [] });
  });
});
