import { randomFillSync } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRandom: number[] = [];

function freshRandom(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  randomFillSync(bytes);
  return Array.from(bytes, (b) => b & 31);
}

/** Increment a base32 digit array in place. Returns false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/**
 * Returns a 26-character Crockford base32 ULID. Values generated within the
 * same millisecond (or after the clock steps backwards) sort strictly increasing.
 */
export function ulid(now: number = Date.now()): string {
  let time = Math.min(Math.max(Math.floor(now), 0), MAX_TIME);
  if (time <= lastTime) {
    time = lastTime;
    if (!increment(lastRandom)) {
      time = lastTime + 1;
      lastRandom = freshRandom();
    }
  } else {
    lastRandom = freshRandom();
  }
  lastTime = time;
  return encodeTime(time) + lastRandom.map((d) => ALPHABET.charAt(d)).join('');
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The creation time encoded in a ULID, in epoch milliseconds; undefined for anything else. */
export function ulidTime(id: string): number | undefined {
  if (!ULID.test(id)) return undefined;
  let time = 0;
  for (const ch of id.slice(0, TIME_LEN)) time = time * 32 + ALPHABET.indexOf(ch);
  return time <= MAX_TIME ? time : undefined;
}
