// Slack request authentication (main 15.1, 16): HMAC SHA-256 over `v0:{timestamp}:{body}` with the signing
// secret, timing-safe compare, reject when |now - timestamp| exceeds 300 s.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_SIGNATURE_WINDOW_SECONDS = 300;

export type SlackHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export type SlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing-headers' | 'bad-timestamp' | 'stale' | 'bad-signature' };

function header(headers: SlackHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    return value?.[0];
  }
  return undefined;
}

/** Returns the reason for a rejection; never throws. `now` is a Date or epoch milliseconds. */
export function checkSlackSignature(
  rawBody: string,
  headers: SlackHeaders,
  signingSecret: string,
  now: Date | number,
): SlackSignatureResult {
  const timestamp = header(headers, 'x-slack-request-timestamp');
  const signature = header(headers, 'x-slack-signature');
  if (timestamp === undefined || timestamp === '' || signature === undefined || signature === '') {
    return { ok: false, reason: 'missing-headers' };
  }
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  const nowSeconds = (typeof now === 'number' ? now : now.getTime()) / 1000;
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(`v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`, 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return { ok: false, reason: 'bad-signature' };
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

export function verifySlackSignature(
  rawBody: string,
  headers: SlackHeaders,
  signingSecret: string,
  now: Date | number,
): boolean {
  return checkSlackSignature(rawBody, headers, signingSecret, now).ok;
}
