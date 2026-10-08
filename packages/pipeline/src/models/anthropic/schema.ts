// Request schema to Anthropic structured outputs (`output_config.format`, main 14.5, ADR 0002).
//
// Structured outputs need every object to set `additionalProperties: false`. As with OpenAI strict mode
// (models/openai/strict.ts), every property is listed in `required` and an optional one becomes nullable;
// `stripAddedNulls` removes those nulls from the answer again. Keywords the API does not enforce
// (numeric bounds, string lengths, array lengths beyond `minItems` 0 or 1, unknown string formats) are
// dropped from the sent schema only: the router's withValidation checks every answer against the caller's
// validator, so the constraint still holds. `oneOf` is sent as `anyOf` for the same reason. A schema that
// cannot be expressed at all (recursion, open objects, conditional keywords) throws ModelSchemaError
// before any call.

import type { JsonSchema } from '../../ports/model.ts';
import { ModelSchemaError, stripAddedNulls as stripNulls } from '../openai/strict.ts';

export { ModelSchemaError } from '../openai/strict.ts';

/** Keywords with no structured-output equivalent; a schema that uses them is rejected, not weakened. */
const UNSUPPORTED = [
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'dependentSchemas',
  'dependentRequired',
  'if',
  'then',
  'else',
  'not',
  'allOf',
];

/** Keywords the API does not enforce; removed before sending and left to withValidation. */
const DROPPED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'];

/** String formats structured outputs supports; any other `format` is dropped. */
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

function allowsNull(schema: JsonSchema): boolean {
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (schema.enum?.includes(null)) return true;
  if (schema.const === null) return true;
  return schema.anyOf?.some(allowsNull) ?? false;
}

/**
 * The same schema, additionally accepting `null`, always as an `anyOf` branch: the API rejects a `type`
 * array such as `["string", "null"]` next to an `enum` (found live on Claude Sonnet 5.5).
 */
function makeNullable(schema: JsonSchema): JsonSchema {
  if (allowsNull(schema)) return schema;
  const keys = Object.keys(schema).filter((k) => k !== 'description' && k !== 'title');
  if (keys.length === 1 && keys[0] === 'anyOf' && schema.anyOf !== undefined) {
    return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  }
  const { description, title, ...rest } = schema;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    anyOf: [rest, { type: 'null' }],
  };
}

/** `oneOf` read as `anyOf`, everywhere in the schema. Exclusivity is left to withValidation. */
function oneOfAsAnyOf(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (schema.oneOf !== undefined) {
    if (schema.anyOf !== undefined) throw new ModelSchemaError('Anthropic structured output cannot combine oneOf and anyOf in one schema');
    delete out.oneOf;
    out.anyOf = schema.oneOf;
  }
  if (out.anyOf !== undefined) out.anyOf = out.anyOf.map(oneOfAsAnyOf);
  if (schema.items !== undefined) out.items = oneOfAsAnyOf(schema.items);
  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, oneOfAsAnyOf(s)]));
  }
  if (schema.$defs !== undefined) out.$defs = Object.fromEntries(Object.entries(schema.$defs).map(([k, s]) => [k, oneOfAsAnyOf(s)]));
  return out;
}

function normalize(schema: JsonSchema, path: string): JsonSchema {
  const raw: Record<string, unknown> = { ...schema };
  for (const key of UNSUPPORTED) {
    if (key in raw) throw new ModelSchemaError(`Anthropic structured output cannot use "${key}" (at ${path})`);
  }
  for (const key of DROPPED) delete raw[key];
  if (typeof raw['minItems'] === 'number' && raw['minItems'] > 1) delete raw['minItems'];
  if (typeof raw['format'] === 'string' && !FORMATS.has(raw['format'])) delete raw['format'];
  if (raw['$ref'] !== undefined && !/^#\/\$defs\/[^/]+$/.test(String(raw['$ref']))) {
    throw new ModelSchemaError(`Anthropic structured output supports only local "#/$defs/<name>" references (at ${path})`);
  }
  const out = raw as JsonSchema;
  if (schema.anyOf !== undefined) out.anyOf = schema.anyOf.map((s, i) => normalize(s, `${path}.anyOf[${i}]`));
  if (schema.$defs !== undefined) {
    out.$defs = Object.fromEntries(Object.entries(schema.$defs).map(([k, s]) => [k, normalize(s, `${path}.$defs.${k}`)]));
  }
  if (schema.items !== undefined) out.items = normalize(schema.items, `${path}.items`);

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (!(types.includes('object') || schema.properties !== undefined)) return out;

  const extra = schema.additionalProperties;
  if (extra !== undefined && extra !== false) {
    throw new ModelSchemaError(`Anthropic structured output needs additionalProperties: false (at ${path})`);
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  for (const name of required) {
    if (!(name in properties)) throw new ModelSchemaError(`schema requires "${name}" but does not define it (at ${path})`);
  }
  const nextProps: { [name: string]: JsonSchema } = {};
  for (const [name, prop] of Object.entries(properties)) {
    const normalized = normalize(prop, `${path}.${name}`);
    nextProps[name] = required.has(name) ? normalized : makeNullable(normalized);
  }
  out.properties = nextProps;
  out.additionalProperties = false;
  out.required = [...(schema.required ?? []), ...Object.keys(properties).filter((name) => !required.has(name))];
  return out;
}

/** Throws ModelSchemaError when a `$defs` entry reaches itself through `$ref`s: recursive schemas are not supported. */
function rejectRecursion(root: JsonSchema): void {
  const defs = root.$defs ?? {};
  const refsIn = (schema: JsonSchema, acc: Set<string>): Set<string> => {
    const m = schema.$ref === undefined ? null : /^#\/\$defs\/([^/]+)$/.exec(schema.$ref);
    if (m?.[1] !== undefined) acc.add(m[1]);
    for (const s of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...Object.values(schema.properties ?? {})]) refsIn(s, acc);
    if (schema.items !== undefined) refsIn(schema.items, acc);
    return acc;
  };
  const visit = (name: string, stack: string[]): void => {
    if (stack.includes(name)) throw new ModelSchemaError(`Anthropic structured output cannot use recursive schemas ($defs.${name})`);
    const def = defs[name];
    if (def === undefined) throw new ModelSchemaError(`schema references undefined $defs.${name}`);
    for (const next of refsIn(def, new Set())) visit(next, [...stack, name]);
  };
  for (const name of refsIn(root, new Set())) visit(name, []);
  for (const name of Object.keys(defs)) visit(name, []);
}

/** The schema to send as `output_config.format.schema`, or ModelSchemaError when none exists. */
export function toStructuredSchema(schema: JsonSchema): JsonSchema {
  const anyOfOnly = oneOfAsAnyOf(schema);
  rejectRecursion(anyOfOnly);
  return normalize(anyOfOnly, '$');
}

/** Removes the nulls `toStructuredSchema` added for optional properties of `original`; nulls it allows stay. */
export function stripAddedNulls(value: unknown, original: JsonSchema): unknown {
  return stripNulls(value, oneOfAsAnyOf(original));
}
