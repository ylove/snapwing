import { describe, expect, it } from 'vitest';
import {
  TIMED_OUT,
  isTimedOut,
  parseWaitKey,
  waitKeyString,
  waitTimeoutKey,
  type WaitKey,
} from '../../src/ports/workflow.ts';

const EVENT = '01JZ0000000000000000000001';
const INCIDENT = '01JZ0000000000000000000002';
const JOB = '01JZ0000000000000000000003';

describe('waitKeyString, one case per WaitKey variant', () => {
  const cases: Array<[WaitKey, string]> = [
    [{ kind: 'tap', eventId: EVENT }, `tap:${EVENT}`],
    [{ kind: 'children', parentId: INCIDENT }, `children:${INCIDENT}`],
    [{ kind: 'ci', prId: 'acme/web#42' }, 'ci:acme%2Fweb%2342'],
    [{ kind: 'deploy', env: 'staging', sha: 'a1b2c3d' }, 'deploy:staging:a1b2c3d'],
    [{ kind: 'verification', incidentId: INCIDENT }, `verification:${INCIDENT}`],
  ];

  it.each(cases)('%o gives %s and round-trips', (key, expected) => {
    expect(waitKeyString(key)).toBe(expected);
    expect(parseWaitKey(expected)).toEqual(key);
  });

  it('covers every WaitKey kind', () => {
    expect(new Set(cases.map(([k]) => k.kind))).toEqual(
      new Set(['tap', 'children', 'ci', 'deploy', 'verification']),
    );
  });

  it('is independent of property order', () => {
    expect(waitKeyString({ sha: 'abc', env: 'prod', kind: 'deploy' })).toBe('deploy:prod:abc');
  });

  it('keeps segments unambiguous when a value contains a colon', () => {
    const a = waitKeyString({ kind: 'deploy', env: 'eu:west', sha: 'abc' });
    const b = waitKeyString({ kind: 'deploy', env: 'eu', sha: 'west:abc' });
    expect(a).not.toBe(b);
    expect(parseWaitKey(a)).toEqual({ kind: 'deploy', env: 'eu:west', sha: 'abc' });
  });

  it('rejects empty segments', () => {
    expect(() => waitKeyString({ kind: 'tap', eventId: '' })).toThrow();
  });

  it.each(['', 'tap', 'nope:x', 'deploy:only-env', 'tap:a:b', 'tap:'])('parseWaitKey rejects %j', (s) => {
    expect(() => parseWaitKey(s)).toThrow();
  });
});

describe('waitTimeoutKey', () => {
  it('uses the B 5 interactive timeout key for a tap wait', () => {
    expect(waitTimeoutKey(JOB, { kind: 'tap', eventId: EVENT })).toBe(`tap:${EVENT}`);
  });

  it('keys every other wait by the parked job', () => {
    expect(waitTimeoutKey(JOB, { kind: 'ci', prId: '7' })).toBe(`wait-timeout:${JOB}`);
  });
});

describe('timed out result', () => {
  it('is { timedOut: true }', () => {
    expect(TIMED_OUT).toEqual({ timedOut: true });
    expect(isTimedOut(TIMED_OUT)).toBe(true);
    expect(isTimedOut({ timedOut: true })).toBe(true);
  });

  it.each([null, undefined, 'timedOut', { timedOut: false }, { choice: 'ticket-only' }])('%o is not a timeout', (v) => {
    expect(isTimedOut(v)).toBe(false);
  });
});
