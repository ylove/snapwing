import { describe, expect, it } from 'vitest';
import { ModelSchemaError, stripAddedNulls, toStructuredSchema } from '../../src/models/anthropic/schema.ts';
import type { JsonSchema } from '../../src/ports/model.ts';

describe('anthropic toStructuredSchema', () => {
  it('closes every object, requires every property, and makes optional ones nullable', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'object', properties: { c: { type: 'integer' } } },
        d: { type: 'string', enum: ['x', 'y'] },
        e: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        f: { $ref: '#/$defs/item' },
      },
      required: ['a'],
      $defs: { item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    };
    expect(toStructuredSchema(schema)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: {
          anyOf: [
            { type: 'object', properties: { c: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, required: ['c'], additionalProperties: false },
            { type: 'null' },
          ],
        },
        d: { anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] },
        e: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
        f: { anyOf: [{ $ref: '#/$defs/item' }, { type: 'null' }] },
      },
      required: ['a', 'b', 'd', 'e', 'f'],
      additionalProperties: false,
      $defs: { item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
    });
  });

  it('drops constraints the API does not enforce and keeps the ones it does', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        summary: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Z]' },
        files: { type: 'array', items: { type: 'string', format: 'uri' }, minItems: 1, maxItems: 5 },
        many: { type: 'array', items: { type: 'string', format: 'semver' }, minItems: 3 },
      },
      required: ['confidence', 'summary', 'files', 'many'],
      additionalProperties: false,
    };
    expect(toStructuredSchema(schema).properties).toEqual({
      confidence: { type: 'number' },
      summary: { type: 'string', pattern: '^[A-Z]' },
      files: { type: 'array', items: { type: 'string', format: 'uri' }, minItems: 1 },
      many: { type: 'array', items: { type: 'string' } },
    });
  });

  it('never puts a type array next to an enum, and keeps the description outside the anyOf', () => {
    const out = toStructuredSchema({ type: 'object', properties: { chrome: { type: 'string', enum: ['web'], description: 'kind' } } });
    expect(out.properties?.['chrome']).toEqual({ description: 'kind', anyOf: [{ type: 'string', enum: ['web'] }, { type: 'null' }] });
    expect(JSON.stringify(out)).not.toMatch(/"type":\[/);
  });

  it('sends oneOf as anyOf', () => {
    const out = toStructuredSchema({ type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'integer' }] } }, required: ['v'] });
    expect(out.properties?.['v']).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('leaves an already structured schema unchanged', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { label: { type: 'string', enum: ['bug'] } },
      required: ['label'],
      additionalProperties: false,
    };
    expect(toStructuredSchema(schema)).toEqual(schema);
  });

  it.each<[string, JsonSchema]>([
    ['an open object', { type: 'object', properties: {}, additionalProperties: true }],
    ['an object schema for extra properties', { type: 'object', additionalProperties: { type: 'string' } }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['not', { type: 'string', not: { const: 'x' } } as JsonSchema],
    ['a required property that is not defined', { type: 'object', properties: {}, required: ['x'] }],
    ['a remote $ref', { $ref: 'https://example.test/schema.json' }],
    ['a recursive $defs entry', { $ref: '#/$defs/node', $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } } }],
    ['a mutually recursive pair', { $defs: { a: { type: 'array', items: { $ref: '#/$defs/b' } }, b: { type: 'array', items: { $ref: '#/$defs/a' } } } }],
  ])('rejects %s with ModelSchemaError', (_name, schema) => {
    expect(() => toStructuredSchema(schema)).toThrow(ModelSchemaError);
  });
});

describe('anthropic stripAddedNulls', () => {
  it('removes nulls only where the original schema made the property optional', () => {
    const original: JsonSchema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: ['string', 'null'] },
        items: { type: 'array', items: { type: 'object', properties: { n: { oneOf: [{ type: 'string' }, { type: 'object', properties: { m: { type: 'string' } } }] } } } },
      },
      required: ['b'],
    };
    const value = { a: null, b: null, items: [{ n: null }, { n: { m: null } }] };
    expect(stripAddedNulls(value, original)).toEqual({ b: null, items: [{}, { n: {} }] });
  });
});
