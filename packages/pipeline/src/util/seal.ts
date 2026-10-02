// Sealing secrets at rest (main 16, ADR 0007): AES-256-GCM under `SNAPWING_ENCRYPTION_KEY`, used for
// the linked GitHub identities' user-to-server and refresh tokens (#153). node:crypto only.
//
// Sealed form: `swenc1.<iv>.<ciphertext>.<tag>`, each part base64url, with a fresh random 12-byte IV
// per seal, so sealing one value twice gives two different strings and a sealed value never equals
// the plaintext. `aad` (additional authenticated data) binds a sealed value to where it is stored
// (for a token: the row key and the column), so a value copied to another row or column fails to
// open. A wrong key, a wrong `aad`, or any tampering throws `SealError`, whose message never carries
// the key, the plaintext, or the sealed value.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** The prefix every sealed value starts with; the version names the algorithm and layout. */
export const SEALED_PREFIX = 'swenc1.';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** An AES-256 key parsed from `SNAPWING_ENCRYPTION_KEY`. Opaque; never log it. */
export interface SealKey {
  readonly bytes: Buffer;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

/**
 * Parses `SNAPWING_ENCRYPTION_KEY`: 32 bytes as 64 hex characters, or as base64 or base64url (44
 * characters with padding; `openssl rand -base64 32` makes one). Anything else throws `SealError`
 * without echoing the value.
 */
export function parseSealKey(raw: string): SealKey {
  const text = raw.trim();
  let bytes: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    bytes = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    bytes = Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  }
  if (bytes?.length !== KEY_BYTES) {
    throw new SealError('SNAPWING_ENCRYPTION_KEY must be 32 bytes as 64 hex characters or base64 (openssl rand -base64 32)');
  }
  return { bytes };
}

/** A separate 32-byte key for another purpose (HKDF-SHA256 with `info`), so one secret serves several uses. */
export function deriveKey(key: SealKey, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key.bytes, Buffer.alloc(0), info, KEY_BYTES));
}

/** True when `value` has the sealed form's prefix (it may still fail to open). */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/** Encrypts `plaintext` under `key`, authenticating `aad` with it. */
export function seal(key: SealKey, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEALED_PREFIX}${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

/** Decrypts a value from `seal` with the same `key` and `aad`. Throws `SealError` on any mismatch. */
export function unseal(key: SealKey, sealed: string, aad: string): string {
  if (!isSealed(sealed)) {
    throw new SealError('not a sealed value');
  }
  const parts = sealed.slice(SEALED_PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new SealError('malformed sealed value');
  }
  const [ivText = '', ciphertextText = '', tagText = ''] = parts;
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SealError('malformed sealed value');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SealError('sealed value does not open with this key and context');
  }
}
