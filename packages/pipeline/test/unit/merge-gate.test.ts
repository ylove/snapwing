import { describe, expect, it } from 'vitest';
import { DEFAULT_MERGE_CONFIG, loadAppConfig, validateAppConfig } from '../../src/config/app-config.ts';
import { evaluateMergeGate, matchesAnyGlob, type MergeGateInput } from '../../src/merge/gate.ts';

const limits = { maxFiles: 10, maxDiffLines: 400, forbidden: DEFAULT_MERGE_CONFIG.forbidden };

function input(over: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    reviewVerdict: 'approve',
    requiredChecks: [{ name: 'ci', state: 'success' }],
    files: [{ path: 'src/a.ts', additions: 20, deletions: 5 }],
    stopped: false,
    levelAtMergeTime: 3,
    limits,
    ...over,
  };
}

describe('evaluateMergeGate', () => {
  it('merges when every gate passes', () => {
    const r = evaluateMergeGate(input());
    expect(r).toEqual({
      reviewVerdict: 'approve',
      ciGreen: true,
      riskGate: { passed: true, filesTouched: 1, diffLines: 25, forbiddenHits: [] },
      stopped: false,
      levelAtMergeTime: 3,
      decision: 'merge',
    });
  });

  it.each(['request-changes', 'escalate'] as const)('degrades on review verdict %s alone', (v) => {
    const r = evaluateMergeGate(input({ reviewVerdict: v }));
    expect(r.decision).toBe('degrade');
    expect(r.reason).toMatch(/^review gate/);
  });

  it('degrades on a red or pending check alone', () => {
    const r = evaluateMergeGate(input({ requiredChecks: [{ name: 'ci', state: 'success' }, { name: 'lint', state: 'failure' }] }));
    expect(r).toMatchObject({ decision: 'degrade', ciGreen: false });
    expect(r.reason).toMatch(/^ci gate: lint \(failure\)/);
    expect(evaluateMergeGate(input({ requiredChecks: [{ name: 'ci', state: 'pending' }] })).decision).toBe('degrade');
  });

  it('does not treat an empty check list as green', () => {
    expect(evaluateMergeGate(input({ requiredChecks: [] })).reason).toMatch(/^ci gate/);
  });

  it('degrades when too many files are touched alone', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.ts`, additions: 1, deletions: 0 }));
    const r = evaluateMergeGate(input({ files }));
    expect(r).toMatchObject({ decision: 'degrade', riskGate: { passed: false, filesTouched: 11 } });
    expect(r.reason).toMatch(/^risk gate: 11 files/);
    expect(evaluateMergeGate(input({ files: files.slice(0, 10) })).decision).toBe('merge');
  });

  it('degrades when the diff is too large alone', () => {
    const r = evaluateMergeGate(input({ files: [{ path: 'src/a.ts', additions: 300, deletions: 101 }] }));
    expect(r.reason).toMatch(/^risk gate: 401 diff lines/);
    expect(evaluateMergeGate(input({ files: [{ path: 'src/a.ts', additions: 300, deletions: 100 }] })).decision).toBe('merge');
  });

  it('degrades on a forbidden path alone and names it', () => {
    const r = evaluateMergeGate(input({ files: [{ path: 'infra/main.tf', additions: 1, deletions: 1 }, { path: 'src/a.ts', additions: 1, deletions: 1 }] }));
    expect(r).toMatchObject({ decision: 'degrade', riskGate: { passed: false, forbiddenHits: ['infra/main.tf'] } });
    expect(r.reason).toContain('infra/main.tf');
  });

  it('holds when a Stop was issued, alone', () => {
    const r = evaluateMergeGate(input({ stopped: true }));
    expect(r).toMatchObject({ decision: 'hold', stopped: true });
    expect(r.reason).toMatch(/^stop gate/);
  });

  it('degrades when the level dropped from 3 to 2 since filing', () => {
    const r = evaluateMergeGate(input({ levelAtMergeTime: 2 }));
    expect(r).toMatchObject({ decision: 'degrade', levelAtMergeTime: 2 });
    expect(r.reason).toMatch(/^level gate: resolved level is 2/);
  });

  it('names the first failed gate in main 11.3 order', () => {
    const green = [{ name: 'ci', state: 'success' as const }];
    const all = input({
      reviewVerdict: 'escalate',
      requiredChecks: [{ name: 'ci', state: 'failure' }],
      files: [{ path: '.github/workflows/ci.yml', additions: 1, deletions: 0 }],
      stopped: true,
      levelAtMergeTime: 1,
    });
    expect(evaluateMergeGate(all).reason).toMatch(/^review gate/);
    const noReview = { ...all, reviewVerdict: 'approve' as const };
    expect(evaluateMergeGate(noReview).reason).toMatch(/^ci gate/);
    expect(evaluateMergeGate({ ...noReview, requiredChecks: green }).reason).toMatch(/^risk gate/);
    expect(evaluateMergeGate({ ...noReview, requiredChecks: green, files: [] }).reason).toMatch(/^stop gate/);
  });
});

describe('forbidden path globs', () => {
  const hit = (p: string) => matchesAnyGlob(DEFAULT_MERGE_CONFIG.forbidden, p);

  it('matches the default directories and lockfiles', () => {
    for (const p of ['.github/workflows/ci.yml', '.github/CODEOWNERS', 'infra/a/b/main.tf', 'pnpm-lock.yaml', 'packages/x/yarn.lock', 'package-lock.json']) {
      expect(hit(p), p).toBe(true);
    }
  });

  it('matches test and CI configuration', () => {
    for (const p of ['vitest.config.ts', 'packages/pipeline/vitest.config.mts', 'jest.config.js', '.gitlab-ci.yml', '.circleci/config.yml']) {
      expect(hit(p), p).toBe(true);
    }
  });

  it('does not match ordinary source or look-alikes', () => {
    for (const p of ['src/infra/x.ts', 'src/github/client.ts', 'docs/pnpm-lock.yaml.md', 'src/vitest-helper.ts']) {
      expect(hit(p), p).toBe(false);
    }
  });

  it('treats * as one segment, ** as many, and ? as one character', () => {
    expect(matchesAnyGlob(['src/*.ts'], 'src/a.ts')).toBe(true);
    expect(matchesAnyGlob(['src/*.ts'], 'src/deep/a.ts')).toBe(false);
    expect(matchesAnyGlob(['src/**'], 'src/deep/a.ts')).toBe(true);
    expect(matchesAnyGlob(['**/a.ts'], 'a.ts')).toBe(true);
    expect(matchesAnyGlob(['a?.ts'], 'ab.ts')).toBe(true);
    expect(matchesAnyGlob(['a?.ts'], 'a/.ts')).toBe(false);
    expect(matchesAnyGlob(['a.b'], 'axb')).toBe(false);
  });

  it('normalizes a leading ./', () => {
    expect(matchesAnyGlob(['infra/**'], './infra/x.tf')).toBe(true);
  });
});

describe('merge config', () => {
  const base = `<?xml version="1.0"?><snapwing xmlns="urn:snapwing:config:v1" version="1"><runtime provider="local"/><models default-provider="anthropic"/><harness fixer="claude-code" review="claude-code"/>`;

  it('defaults when <merge> is absent', () => {
    expect(loadAppConfig(`${base}</snapwing>`).merge).toEqual(DEFAULT_MERGE_CONFIG);
  });

  it('parses attributes and adds to the built-in forbidden list, validated by the XSD', async () => {
    const xml = `${base}<merge max-files="3" max-diff-lines="50" revert-window="PT24H"><forbidden path="secrets/**"/></merge></snapwing>`;
    expect(await validateAppConfig(xml)).toEqual({ valid: true, errors: [] });
    expect(loadAppConfig(xml).merge).toEqual({
      maxFiles: 3,
      maxDiffLines: 50,
      revertWindow: 'PT24H',
      forbidden: [...DEFAULT_MERGE_CONFIG.forbidden, 'secrets/**'],
    });
  });

  it('a config listing one custom forbidden path still blocks .github/workflows/ci.yml', () => {
    const xml = `${base}<merge><forbidden path="secrets/**"/></merge></snapwing>`;
    const { merge } = loadAppConfig(xml);
    const ci = { path: '.github/workflows/ci.yml', additions: 1, deletions: 0 };
    const r = evaluateMergeGate(input({ files: [ci], limits: merge }));
    expect(r.decision).toBe('degrade');
    expect(r.riskGate.forbiddenHits).toEqual(['.github/workflows/ci.yml']);
    expect(evaluateMergeGate(input({ files: [{ path: 'secrets/k.txt', additions: 1, deletions: 0 }], limits: merge })).decision).toBe('degrade');
  });

  it('accepts an empty <merge/> with defaults and rejects bad values', async () => {
    expect((await validateAppConfig(`${base}<merge/></snapwing>`)).valid).toBe(true);
    expect(loadAppConfig(`${base}<merge/></snapwing>`).merge).toEqual(DEFAULT_MERGE_CONFIG);
    expect((await validateAppConfig(`${base}<merge max-files="0"/></snapwing>`)).valid).toBe(false);
    expect((await validateAppConfig(`${base}<merge revert-window="3 days"/></snapwing>`)).valid).toBe(false);
    expect(() => loadAppConfig(`${base}<merge max-files="x"/></snapwing>`)).toThrow(/positive integer/);
  });
});
