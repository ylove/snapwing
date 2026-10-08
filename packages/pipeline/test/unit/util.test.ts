import { describe, expect, it } from 'vitest';
import { InvalidDurationError, formatDuration, parseDuration } from '../../src/util/duration.ts';
import { ulid, ulidTime } from '../../src/util/ulid.ts';

describe('ulid', () => {
  it('returns 26 Crockford base32 characters', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is strictly increasing within one millisecond', () => {
    const ids = Array.from({ length: 2000 }, () => ulid(1_700_000_000_000));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays monotonic across real calls', () => {
    const ids = Array.from({ length: 500 }, () => ulid());
    expect([...ids].sort()).toEqual(ids);
  });

  it('decodes its creation time, and nothing from anything else', () => {
    // The time part of the ULID spec's example, 1469918176385 ms.
    expect(ulidTime('01ARYZ6S41TSV4RRFFQ69G5FAV')).toBe(1_469_918_176_385);
    const now = Date.now();
    expect(ulidTime(ulid())).toBeGreaterThanOrEqual(now);
    for (const other of ['run-1', '01J9ZRUNID000000000000000', '01J9ZRUNID00000000000000IL', '81J9ZRUNID0000000000000001']) expect(ulidTime(other)).toBeUndefined();
  });
});

describe('parseDuration', () => {
  it.each([
    ['PT30M', 1_800_000],
    ['PT1H', 3_600_000],
    ['P1D', 86_400_000],
    ['PT1.5S', 1500],
    ['P1DT2H3M4.5S', 86_400_000 + 7_200_000 + 180_000 + 4500],
  ])('parses %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', 'P', '30M', 'PT', 'PT1X', 'PT-5M'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(InvalidDurationError);
  });

  it('round-trips through formatDuration', () => {
    for (const ms of [0, 1500, 1_800_000, 90_061_001]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
    expect(formatDuration(1_800_000)).toBe('PT30M');
  });
});
