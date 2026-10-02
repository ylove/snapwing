import { describe, expect, it } from 'vitest';
import {
  JOB_NAMES,
  TIMER_JOBS,
  keySegment,
  timerKey,
  type Job,
  type TimerKind,
} from '../../src/contracts/jobs.ts';

const EVENT = '01JZ0000000000000000000001';
const INC = '01JZ0000000000000000000002';
const USER = 'U0FAKEUSER';

describe('timerKey, one case per row of the B 5 table', () => {
  const rows: Array<[string, string, string]> = [
    ['Interactive timeout', timerKey('tap', { eventId: EVENT }), `tap:${EVENT}`],
    ['Claim expiry nudge', timerKey('claim-nudge', { incidentId: INC, userId: USER }), `claim-nudge:${INC}:${USER}`],
    ['Claim expiry', timerKey('claim', { incidentId: INC, userId: USER }), `claim:${INC}:${USER}`],
    ['Environment hold nudge / expiry', timerKey('hold', { incidentId: INC, env: 'staging' }), `hold:${INC}:staging`],
    ['Stall detection', timerKey('stall', { incidentId: INC }), `stall:${INC}`],
    ['Heartbeat', timerKey('heartbeat', { incidentId: INC }), `heartbeat:${INC}`],
    ['Escalation ladder steps', timerKey('escalate', { incidentId: INC, step: 2 }), `escalate:${INC}:2`],
    ['Revert window', timerKey('revert', { incidentId: INC }), `revert:${INC}`],
    ['Fixer budget', timerKey('fixer-budget', { incidentId: INC }), `fixer-budget:${INC}`],
  ];

  it.each(rows)('%s', (_row, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('accepts a named escalation step', () => {
    expect(timerKey('escalate', { incidentId: INC, step: 'page' })).toBe(`escalate:${INC}:page`);
  });

  it('encodes colons inside a segment so keys stay unambiguous', () => {
    expect(timerKey('hold', { incidentId: INC, env: 'eu:prod' })).toBe(`hold:${INC}:eu%3Aprod`);
  });

  it('rejects an empty segment', () => {
    expect(() => timerKey('stall', { incidentId: '' })).toThrow();
    expect(() => keySegment('')).toThrow();
  });
});

describe('job names', () => {
  it('include the pipeline jobs', () => {
    for (const n of ['incident.process', 'fixer.run', 'merge.evaluate', 'reconcile'] as const) {
      expect(JOB_NAMES).toContain(n);
    }
  });

  it('give every B 5 timer its own job, and every timer job is a JobName', () => {
    const kinds = Object.keys(TIMER_JOBS) as TimerKind[];
    expect(kinds).toHaveLength(9);
    const jobs = kinds.map((k) => TIMER_JOBS[k]);
    expect(new Set(jobs).size).toBe(9);
    for (const j of jobs) expect(JOB_NAMES).toContain(j);
  });

  it('are unique', () => {
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });
});

describe('Job', () => {
  it('has id, name, data, attempt, and an optional singletonKey', () => {
    const job: Job<{ incidentId: string }> = {
      id: '01JZ0000000000000000000003',
      name: 'incident.process',
      data: { incidentId: INC },
      attempt: 1,
    };
    const timer: Job = { ...job, name: 'timer.stall', singletonKey: timerKey('stall', { incidentId: INC }) };
    expect(job.singletonKey).toBeUndefined();
    expect(timer.singletonKey).toBe(`stall:${INC}`);
  });
});
