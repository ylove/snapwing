// JsonSchema (ports/model.ts) to Gemini's responseSchema dialect, an OpenAPI 3.0 subset:
// upper-case type names, no additionalProperties, $ref, $defs, allOf, oneOf or const.

import type { JsonSchema, JsonSchemaTypeName } from '../../ports/model.ts';

export type GeminiSchema = { [key: string]: unknown };

const TYPE_NAMES: Record<JsonSchemaTypeName, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  object: 'OBJECT',
  array: 'ARRAY',
  null: 'NULL',
};

export function toGeminiSchema(schema: JsonSchema): GeminiSchema {
  const out: GeminiSchema = {};
  if (schema.type !== undefined) {
    if (Array.isArray(schema.type)) {
      const nonNull = schema.type.filter((t) => t !== 'null');
      if (nonNull.length === 1 && nonNull[0] !== undefined) {
        out['type'] = TYPE_NAMES[nonNull[0]];
        if (schema.type.includes('null')) out['nullable'] = true;
      } else {
        out['anyOf'] = schema.type.map((t) => ({ type: TYPE_NAMES[t] }));
      }
    } else {
      out['type'] = TYPE_NAMES[schema.type];
    }
  }
  if (schema.title !== undefined) out['title'] = schema.title;
  if (schema.description !== undefined) out['description'] = schema.description;
  if (schema.enum !== undefined) out['enum'] = schema.enum.map((v) => String(v));
  else if (schema.const !== undefined) out['enum'] = [String(schema.const)];
  if (schema.properties !== undefined) {
    out['properties'] = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out['propertyOrdering'] = Object.keys(schema.properties);
  }
  if (schema.required !== undefined) out['required'] = schema.required;
  if (schema.items !== undefined) out['items'] = toGeminiSchema(schema.items);
  if (schema.minItems !== undefined) out['minItems'] = String(schema.minItems);
  if (schema.maxItems !== undefined) out['maxItems'] = String(schema.maxItems);
  if (schema.minLength !== undefined) out['minLength'] = String(schema.minLength);
  if (schema.maxLength !== undefined) out['maxLength'] = String(schema.maxLength);
  if (schema.pattern !== undefined) out['pattern'] = schema.pattern;
  if (schema.format !== undefined) out['format'] = schema.format;
  if (schema.minimum !== undefined) out['minimum'] = schema.minimum;
  if (schema.maximum !== undefined) out['maximum'] = schema.maximum;
  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined) out['anyOf'] = union.map(toGeminiSchema);
  return out;
}

/** The shape the vision pass asks for: one ImageReading per image (contracts/incident.ts). */
export const IMAGE_READING_ARRAY_SCHEMA: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      errorText: { type: ['string', 'null'], description: 'Error text exactly as shown, if any is visible.' },
      surfaceSignals: {
        type: 'object',
        properties: {
          urlBar: { type: ['string', 'null'] },
          pageTitle: { type: ['string', 'null'] },
          chrome: { type: 'string', enum: ['web', 'mobile', 'desktop', 'admin', 'unknown'] },
        },
      },
      uiElements: { type: 'array', items: { type: 'string' }, description: 'Visible labels, menu items, field names.' },
      environmentHint: { type: 'string', enum: ['production', 'staging', 'local', 'unknown'] },
      plainDescription: { type: 'string', description: 'Reporter-facing description of what the image shows.' },
      sensitive: { type: 'boolean', description: 'True when credentials, tokens, or personal data are visible.' },
    },
    required: ['surfaceSignals', 'uiElements', 'plainDescription', 'sensitive'],
  },
};
