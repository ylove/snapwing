import { describe, expect, it } from 'vitest';
import {
  HARNESS_PHASES,
  MAX_CHECKPOINT_LINE_LENGTH,
  MAX_RESULT_LENGTH,
  isHarnessPhase,
  parseCheckpointLine,
  parseHarnessResult,
  type HarnessContractErrorCode,
} from '../../src/harness/contract.ts';
import type { HarnessCheckpoint, HarnessResult } from '../../src/ports/harness.ts';

describe('parseHarnessResult: valid payloads', () => {
  const cases: Array<[string, string, HarnessResult]> = [
    [
      'done with every field',
      JSON.stringify({ outcome: 'done', branch: 'fix/WEB-1042', prNumber: 87, summary: 'Guard null cart', testsAdded: ['test/cart.test.ts'] }),
      { outcome: 'done', branch: 'fix/WEB-1042', prNumber: 87, summary: 'Guard null cart', testsAdded: ['test/cart.test.ts'] },
    ],
    [
      'done without prNumber, empty summary and testsAdded, surrounding whitespace',
      `\n  ${JSON.stringify({ outcome: 'done', branch: 'fix/WEB-7', summary: '', testsAdded: [] })}\n\n`,
      { outcome: 'done', branch: 'fix/WEB-7', summary: '', testsAdded: [] },
    ],
    [
      'done with prNumber null and unknown keys (dropped), behind a BOM',
      `\uFEFF${JSON.stringify({ outcome: 'done', branch: 'b', prNumber: null, summary: 's', testsAdded: ['a', 'b'], costUsd: 0.42 })}`,
      { outcome: 'done', branch: 'b', summary: 's', testsAdded: ['a', 'b'] },
    ],
    [
      'failed with a partial branch',
      JSON.stringify({ outcome: 'failed', reason: 'tests did not pass after 3 attempts', partialBranch: 'fix/WEB-9', attempts: 3 }),
      { outcome: 'failed', reason: 'tests did not pass after 3 attempts', partialBranch: 'fix/WEB-9', attempts: 3 },
    ],
    [
      'failed before any attempt, partialBranch null',
      JSON.stringify({ outcome: 'failed', reason: 'could not resolve dependencies', partialBranch: null, attempts: 0 }),
      { outcome: 'failed', reason: 'could not resolve dependencies', attempts: 0 },
    ],
    [
      'stopped at a phase',
      JSON.stringify({ outcome: 'stopped', atPhase: 'tested', detail: 'ignored' }),
      { outcome: 'stopped', atPhase: 'tested' },
    ],
  ];

  it.each(cases)('%s', (_name, stdout, expected) => {
    const parsed = parseHarnessResult(stdout);
    expect(parsed).toEqual({ ok: true, result: expected });
  });

  it('covers every outcome', () => {
    expect(new Set(cases.map(([, , r]) => r.outcome))).toEqual(new Set(['done', 'failed', 'stopped']));
  });

  it('never forwards unknown keys', () => {
    const parsed = parseHarnessResult(JSON.stringify({ outcome: 'stopped', atPhase: 'pushed', token: 'fake-token-not-real' }));
    expect(parsed.ok && Object.keys(parsed.result)).toEqual(['outcome', 'atPhase']);
  });
});

describe('parseHarnessResult: invalid payloads return a typed error', () => {
  const cases: Array<[string, string, HarnessContractErrorCode, string | undefined]> = [
    ['empty stdout', '   \n', 'empty', undefined],
    ['log text instead of JSON', 'Applying edit to src/cart.ts\n{"outcome":"done"}', 'not-json', undefined],
    ['a JSON array', JSON.stringify([{ outcome: 'done' }]), 'not-object', undefined],
    ['unknown outcome', JSON.stringify({ outcome: 'success', branch: 'b' }), 'unknown-outcome', 'outcome'],
    [
      'done with a non-string test path',
      JSON.stringify({ outcome: 'done', branch: 'b', summary: 's', testsAdded: ['ok.test.ts', 7] }),
      'invalid-field',
      'testsAdded[1]',
    ],
    ['stopped at a phase that does not exist', JSON.stringify({ outcome: 'stopped', atPhase: 'pr_opened' }), 'unknown-phase', 'atPhase'],
  ];

  it.each(cases)('%s', (_name, stdout, code, field) => {
    const parsed = parseHarnessResult(stdout);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.field).toBe(field);
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['done with an empty branch', { outcome: 'done', branch: ' ', summary: 's', testsAdded: [] }, 'branch'],
    ['done missing testsAdded', { outcome: 'done', branch: 'b', summary: 's' }, 'testsAdded'],
    ['done with a fractional prNumber', { outcome: 'done', branch: 'b', prNumber: 1.5, summary: 's', testsAdded: [] }, 'prNumber'],
    ['done with prNumber 0', { outcome: 'done', branch: 'b', prNumber: 0, summary: 's', testsAdded: [] }, 'prNumber'],
    ['failed with attempts as a string', { outcome: 'failed', reason: 'r', attempts: '2' }, 'attempts'],
    ['failed with negative attempts', { outcome: 'failed', reason: 'r', attempts: -1 }, 'attempts'],
    ['failed without a reason', { outcome: 'failed', attempts: 1 }, 'reason'],
    ['failed with an empty partialBranch', { outcome: 'failed', reason: 'r', partialBranch: '', attempts: 1 }, 'partialBranch'],
  ])('field check: %s', (_name, payload, field) => {
    const parsed = parseHarnessResult(JSON.stringify(payload));
    expect(parsed).toMatchObject({ ok: false, error: { code: 'invalid-field', field } });
  });

  it('rejects an oversized payload before parsing it', () => {
    const parsed = parseHarnessResult(' '.repeat(MAX_RESULT_LENGTH + 1));
    expect(parsed).toMatchObject({ ok: false, error: { code: 'too-large' } });
  });

  it('keeps error messages short when the input is long', () => {
    const parsed = parseHarnessResult(`not json ${'x'.repeat(10_000)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message.length).toBeLessThan(200);
  });
});

describe('parseCheckpointLine', () => {
  it.each<[string, HarnessCheckpoint]>([
    ['{"phase":"cloned"}', { phase: 'cloned' }],
    ['{"phase":"branched","detail":"fix/WEB-1042"}', { phase: 'branched', detail: 'fix/WEB-1042' }],
    ['  {"phase":"implemented","detail":null}  ', { phase: 'implemented' }],
    ['{"phase":"tested","detail":"14 passed","ts":"2026-10-01T12:00:00Z"}', { phase: 'tested', detail: '14 passed' }],
    ['{"phase":"pushed"}\r', { phase: 'pushed' }],
    ['{"phase":"pr-opened","detail":"#87"}', { phase: 'pr-opened', detail: '#87' }],
  ])('checkpoint: %s', (line, checkpoint) => {
    expect(parseCheckpointLine(line)).toEqual({ kind: 'checkpoint', checkpoint });
  });

  it.each([
    '',
    '   ',
    'Cloning into /work/repo...',
    'warning: LF will be replaced by CRLF',
    '[aider] Applied edit to src/cart.ts',
    '{ not json at all',
    '{"level":"info","msg":"structured log line without a phase"}',
    '42',
    '["phase","cloned"]',
    'phase: cloned',
  ])('noise is ignored: %j', (line) => {
    expect(parseCheckpointLine(line)).toEqual({ kind: 'noise' });
  });

  it.each<[string, HarnessContractErrorCode, string]>([
    ['{"phase":"deployed"}', 'unknown-phase', 'phase'],
    ['{"phase":null}', 'unknown-phase', 'phase'],
    ['{"phase":"tested","detail":12}', 'invalid-field', 'detail'],
  ])('malformed checkpoint is an error, not noise: %s', (line, code, field) => {
    expect(parseCheckpointLine(line)).toMatchObject({ kind: 'error', error: { code, field } });
  });

  it('rejects an oversized checkpoint candidate', () => {
    const line = `{"phase":"tested","detail":"${'x'.repeat(MAX_CHECKPOINT_LINE_LENGTH)}"}`;
    expect(parseCheckpointLine(line)).toMatchObject({ kind: 'error', error: { code: 'too-large' } });
  });

  it('a mixed stderr stream yields exactly its checkpoints, in order', () => {
    const stderr = [
      'Cloning into /work/repo...',
      '{"phase":"cloned"}',
      'npm warn deprecated something@1.0.0',
      '{"phase":"branched","detail":"fix/WEB-1042"}',
      '',
      '{"level":"debug","msg":"thinking"}',
      '{"phase":"implemented"}',
      'PASS test/cart.test.ts',
      '{"phase":"tested","detail":"1 added"}',
    ].join('\n');
    const phases = stderr
      .split('\n')
      .map(parseCheckpointLine)
      .flatMap((p) => (p.kind === 'checkpoint' ? [p.checkpoint.phase] : []));
    expect(phases).toEqual(['cloned', 'branched', 'implemented', 'tested']);
  });
});

describe('HARNESS_PHASES', () => {
  it('lists the six B 9 phases in run order and is frozen', () => {
    expect(HARNESS_PHASES).toEqual(['cloned', 'branched', 'implemented', 'tested', 'pushed', 'pr-opened']);
    expect(Object.isFrozen(HARNESS_PHASES)).toBe(true);
  });

  it('isHarnessPhase accepts exactly those', () => {
    for (const p of HARNESS_PHASES) expect(isHarnessPhase(p)).toBe(true);
    for (const p of ['', 'Cloned', 'pr_opened', 'merged', 1, null]) expect(isHarnessPhase(p)).toBe(false);
  });
});
