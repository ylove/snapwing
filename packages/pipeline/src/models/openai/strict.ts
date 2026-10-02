// Strict-mode normalization for OpenAI `response_format: json_schema` (main 14.5, ADR 0002).
//
// OpenAI strict structured output needs every object to set `additionalProperties: false` and list all of
// its properties in `required`. A property that was optional becomes nullable instead, and the nulls are
// removed again from the parsed answer so callers see the shape they asked for.

import type { JsonSchema, JsonSchemaTypeName } from '../../ports/model.ts';
import { ModelError } from '../errors.ts';

/** The request schema cannot be expressed in OpenAI strict mode. Thrown before any API call. */
export class ModelSchemaError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSchemaError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keywords strict mode cannot honor; a schema that uses them is rejected rather than silently weakened. */
const UNSUPPORTED = ['patternProperties', 'propertyNames', 'unevaluatedProperties', 'dependentSchemas', 'if', 'then', 'else', 'not'];

/** True when the schema already accepts `null`. */
function allowsNull(schema: JsonSchema): boolean {
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (schema.enum?.includes(null)) return true;
  if (schema.const === null) return true;
  return schema.anyOf?.some(allowsNull) ?? false;
}

/** The same schema, additionally accepting `null`. */
function makeNullable(schema: JsonSchema): JsonSchema {
  if (allowsNull(schema)) return schema;
  if (schema.$ref !== undefined || (schema.type === undefined && schema.anyOf !== undefined)) {
    if (schema.anyOf !== undefined) return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
    return { anyOf: [schema, { type: 'null' }] };
  }
  const next: JsonSchema = { ...schema };
  if (schema.type !== undefined) {
    const types: JsonSchemaTypeName[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    next.type = [...types, 'null'];
  }
  if (schema.enum !== undefined) next.enum = [...schema.enum, null];
  return next;
}

function normalize(schema: JsonSchema, path: string): JsonSchema {
  const raw: Record<string, unknown> = { ...schema };
  for (const key of UNSUPPORTED) {
    if (key in raw) throw new ModelSchemaError(`OpenAI strict schema cannot use "${key}" (at ${path})`);
  }
  if (schema.allOf !== undefined || schema.oneOf !== undefined) {
    throw new ModelSchemaError(`OpenAI strict schema cannot use allOf or oneOf (at ${path}); use anyOf`);
  }
  const out: JsonSchema = { ...schema };
  if (schema.anyOf !== undefined) out.anyOf = schema.anyOf.map((s, i) => normalize(s, `${path}.anyOf[${i}]`));
  if (schema.$defs !== undefined) {
    out.$defs = Object.fromEntries(Object.entries(schema.$defs).map(([k, s]) => [k, normalize(s, `${path}.$defs.${k}`)]));
  }
  if (schema.items !== undefined) out.items = normalize(schema.items, `${path}.items`);

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  const isObject = types.includes('object') || schema.properties !== undefined;
  if (!isObject) return out;

  const extra = schema.additionalProperties;
  if (extra !== undefined && extra !== false) {
    throw new ModelSchemaError(`OpenAI strict schema needs additionalProperties: false (at ${path})`);
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const nextProps: { [name: string]: JsonSchema } = {};
  for (const [name, prop] of Object.entries(properties)) {
    const normalized = normalize(prop, `${path}.${name}`);
    nextProps[name] = required.has(name) ? normalized : makeNullable(normalized);
  }
  for (const name of required) {
    if (!(name in properties)) throw new ModelSchemaError(`OpenAI strict schema requires "${name}" but does not define it (at ${path})`);
  }
  out.properties = nextProps;
  out.additionalProperties = false;
  out.required = [...(schema.required ?? []), ...Object.keys(properties).filter((name) => !required.has(name))];
  return out;
}

/** A schema OpenAI strict mode accepts, or ModelSchemaError when none exists. Already-strict schemas come back equal. */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  return normalize(schema, '$');
}

/**
 * Removes `null`s that `toStrictSchema` introduced: a property that was optional in `original` and came back
 * `null` is deleted. A null the original schema allows is kept. Walks `value` alongside `original`.
 */
export function stripAddedNulls(value: unknown, original: JsonSchema, root: JsonSchema = original): unknown {
  const schema = resolveRef(original, root);
  if (Array.isArray(value)) {
    const items = schema.items;
    return items === undefined ? value : value.map((v) => stripAddedNulls(v, items, root));
  }
  if (!isRecord(value)) return value;
  if (schema.anyOf !== undefined) {
    const branch = schema.anyOf.find((s) => {
      const r = resolveRef(s, root);
      return r.properties !== undefined || (Array.isArray(r.type) ? r.type.includes('object') : r.type === 'object');
    });
    return branch === undefined ? value : stripAddedNulls(value, branch, root);
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(value)) {
    const prop = properties[name];
    if (prop === undefined) {
      out[name] = v;
    } else if (v === null && !required.has(name) && !allowsNull(resolveRef(prop, root))) {
      continue;
    } else {
      out[name] = stripAddedNulls(v, prop, root);
    }
  }
  return out;
}

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (ref === undefined) return schema;
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  const target = m?.[1] === undefined ? undefined : root.$defs?.[m[1]];
  return target ?? schema;
}
