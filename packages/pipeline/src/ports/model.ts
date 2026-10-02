// src/ports/model.ts (main 14.5, ADR 0002). Every model call in the pipeline goes through this port.
// Implementations: models/router.ts (per-task dispatch), models/mock.ts (recorded replay for unit and
// contract tiers), and the vendor adapters under models/ (anthropic, openai, google; later issues).

import type { ImageReading } from '../contracts/incident.ts';

export type { ImageReading } from '../contracts/incident.ts';

export type ModelTask = 'triage' | 'segmentation' | 'vision' | 'clarify' | 'scout' | 'review';

export interface ModelPort {
  complete(request: CompletionRequest): Promise<CompletionResult>;                 // free text
  vision(request: VisionRequest): Promise<VisionResult>;                           // images in, ImageReading-shaped out
  classify<T>(request: ClassifyRequest<T>): Promise<ClassifyResult<T>>;            // structured output against a JSON schema
}

export interface CompletionRequest { task: ModelTask; system: string; prompt: string; maxTokens?: number; temperature?: number; }
export interface ClassifyRequest<T> extends CompletionRequest { schemaName: string; schema: JsonSchema; validate: (v: unknown) => v is T; }

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** One image for the vision pass (main 5.2a). Bytes travel inline, base64 encoded, so no provider fetches a URL. */
export interface ModelImage {
  mimeType: ImageMimeType;
  /** Base64 of the image bytes, no `data:` prefix. */
  data: string;
  /** Caller's handle for the image (an attachment URL or ID); never sent to a provider, used to pair readings. */
  ref?: string;
}

/** The prompt asks for one ImageReading per image, in the order of `images`. */
export interface VisionRequest extends CompletionRequest { images: ModelImage[]; }

export interface ModelUsage { inputTokens: number; outputTokens: number; }

/** Fields every result carries: which model actually answered, and token usage when the provider reports it. */
export interface ModelResultMeta {
  /** Provider-qualified model name, `<provider>/<model>` (for example `anthropic/claude-haiku-4-5`, `mock/recorded`). */
  model: string;
  usage?: ModelUsage;
}

export interface CompletionResult extends ModelResultMeta { text: string; }

/** One reading per request image, same order as `VisionRequest.images`. */
export interface VisionResult extends ModelResultMeta { readings: ImageReading[]; }

export interface ClassifyResult<T> extends ModelResultMeta {
  /** Output that passed `request.validate`. */
  value: T;
  /** 1 when the first answer validated, 2 when the retry with the validation error appended did. */
  attempts: 1 | 2;
}

/**
 * A provider adapter before the shared classify contract is applied. Its `classify` returns the
 * provider's parsed structured output without running `validate`; `withValidation` (models/router.ts)
 * turns any ModelBackend into a ModelPort. Every ModelPort is also a ModelBackend.
 */
export interface ModelBackend {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  vision(request: VisionRequest): Promise<VisionResult>;
  classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult>;
}

export interface RawClassifyResult extends ModelResultMeta { value: unknown; }

/** JSON Schema primitive type names. */
export type JsonSchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Structural JSON Schema, the subset every provider's structured output accepts (Anthropic tool input
 * schemas, OpenAI strict json_schema, Google responseSchema). Unknown keywords are not representable on
 * purpose: if a stage needs one, add it here so every adapter has to handle it.
 */
export interface JsonSchema {
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  title?: string;
  description?: string;
  enum?: JsonValue[];
  const?: JsonValue;
  // objects
  properties?: { [name: string]: JsonSchema };
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  // arrays
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  // strings
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  // numbers
  minimum?: number;
  maximum?: number;
  // composition and references
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: { [name: string]: JsonSchema };
}
