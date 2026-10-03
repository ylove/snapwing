// Validation and redaction for ImageReading (main 5.2a, main 13). The vision port passes model output
// through unvalidated, so every reading is checked here before it is attached to an attachment.

import type { ImageReading } from '../../contracts/incident.ts';
import { isUserSideIndicator } from '../../models/user-side.ts';

const CHROME: readonly unknown[] = ['web', 'mobile', 'desktop', 'admin', 'unknown'];
const ENVIRONMENTS: readonly unknown[] = ['production', 'staging', 'local', 'unknown'];

function optionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string';
}

/**
 * Type guard for ImageReading. `unknown` is a legal value for every field (the string for free text,
 * the enum member for chrome and environmentHint); a missing optional field is also fine.
 */
export function isImageReading(value: unknown): value is ImageReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const s = r['surfaceSignals'];
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return false;
  const signals = s as Record<string, unknown>;
  return (
    optionalString(r['errorText']) &&
    optionalString(signals['urlBar']) &&
    optionalString(signals['pageTitle']) &&
    (signals['chrome'] === undefined || CHROME.includes(signals['chrome'])) &&
    Array.isArray(r['uiElements']) &&
    r['uiElements'].every((e) => typeof e === 'string') &&
    (r['environmentHint'] === undefined || ENVIRONMENTS.includes(r['environmentHint'])) &&
    typeof r['plainDescription'] === 'string' &&
    typeof r['sensitive'] === 'boolean' &&
    (r['userSideIndicators'] === undefined ||
      (Array.isArray(r['userSideIndicators']) && r['userSideIndicators'].every(isUserSideIndicator)))
  );
}

/** What an image gets when the model could not be asked or its answer did not validate. */
export function unreadableReading(): ImageReading {
  return {
    errorText: 'unknown',
    surfaceSignals: { urlBar: 'unknown', pageTitle: 'unknown', chrome: 'unknown' },
    uiElements: [],
    environmentHint: 'unknown',
    plainDescription: 'unknown',
    userSideIndicators: [],
    // Fail closed: nobody has seen this image, so it is never echoed into a channel.
    sensitive: true,
  };
}

/**
 * The reading as it may be rendered for a channel. A `sensitive` reading loses `errorText`,
 * `userSideIndicators`, and `uiElements`, which may carry the credential or personal data itself; everything else passes through.
 * Returns a new object and never mutates its input.
 */
export function redactReading(reading: ImageReading): ImageReading {
  if (!reading.sensitive) return reading;
  // Indicator evidence can quote an account name or address, so it goes too.
  const { errorText: _errorText, userSideIndicators: _indicators, ...rest } = reading;
  return { ...rest, uiElements: [] };
}
