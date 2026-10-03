// Shared by the three vision adapters: the userSideIndicators field of an ImageReading (spec A 5.1).

import type { JsonSchema } from '../ports/model.ts';
import type { UserSideIndicator, UserSideKind } from '../contracts/incident.ts';

export const USER_SIDE_KINDS: readonly UserSideKind[] = [
  'wrong-environment',
  'wrong-account',
  'stale-cache',
  'extension-interference',
  'input-mode',
  'expired-session',
  'network',
  'wrong-surface',
  'other',
];

/** JSON Schema for the field, expressible on Anthropic, OpenAI strict mode, and Gemini. Bounds are checked in code. */
export const USER_SIDE_INDICATORS_SCHEMA: JsonSchema = {
  type: 'array',
  description:
    'Signs the cause is on the reporter side (wrong site, wrong account, stale cache, extension, input mode, expired session, network). Empty list when there are none.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'evidence', 'confidence'],
    properties: {
      kind: { type: 'string', enum: [...USER_SIDE_KINDS] },
      evidence: { type: 'string', description: 'What in the image shows it, e.g. URL bar shows staging.example.com.' },
      confidence: { type: 'number', description: 'From 0 to 1.' },
    },
  },
};

export function isUserSideIndicator(v: unknown): v is UserSideIndicator {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['kind'] === 'string' &&
    (USER_SIDE_KINDS as readonly string[]).includes(r['kind']) &&
    typeof r['evidence'] === 'string' &&
    r['evidence'] !== '' &&
    typeof r['confidence'] === 'number' &&
    r['confidence'] >= 0 &&
    r['confidence'] <= 1
  );
}

/**
 * Parse the model's answer for the field. Missing or null yields undefined. Entries that do not validate
 * are dropped one by one: a bad guess about the reporter must never cost the rest of the reading.
 */
export function parseUserSideIndicators(value: unknown): UserSideIndicator[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isUserSideIndicator).map((i) => ({ kind: i.kind, evidence: i.evidence, confidence: i.confidence }));
}
