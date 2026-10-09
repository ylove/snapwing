// Merge risk gate (main 11.3, MergeGateResult in main 13). Pure: the caller gathers the review
// verdict, required checks, the PR's files, the stop state, and the level re-resolved at merge
// time; nothing here reads state or the network.

import type { MergeConfig } from '../config/app-config.ts';
import type { AutonomyLevel } from '../contracts/events.ts';

export type ReviewVerdict = 'approve' | 'request-changes' | 'escalate';

/** Gate names in the order main 11.3 lists them; the first to fail is the `reason`. */
export const MERGE_GATES = ['review', 'ci', 'risk', 'stop', 'level'] as const;
export type MergeGate = (typeof MERGE_GATES)[number];

export interface RequiredCheck {
  name: string;
  state: 'success' | 'failure' | 'pending' | 'missing';
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  /** A renamed file's old path. The forbidden paths are checked against it too (#264): moving a file out of one is touching it. */
  previousPath?: string;
}

export interface MergeGateInput {
  reviewVerdict: ReviewVerdict;
  /** Every required CI check. An empty list is not green: autopilot never merges without a check. */
  requiredChecks: readonly RequiredCheck[];
  /** The files of exactly the commit being merged. */
  files: readonly ChangedFile[];
  /** False when the list of files is cut short (GitHub lists a limited number): the risk gate fails. Default true. */
  filesComplete?: boolean;
  stopped: boolean;
  /** The level re-resolved from the map now, not the one at filing time. */
  levelAtMergeTime: AutonomyLevel;
  limits: Pick<MergeConfig, 'maxFiles' | 'maxDiffLines' | 'forbidden'>;
}

export interface MergeGateResult {
  reviewVerdict: ReviewVerdict;
  ciGreen: boolean;
  riskGate: { passed: boolean; filesTouched: number; diffLines: number; forbiddenHits: string[] };
  stopped: boolean;
  levelAtMergeTime: AutonomyLevel;
  /** `merge`: all gates pass. `hold`: a Stop was issued, do nothing. `degrade`: fall back to 11.2. */
  decision: 'merge' | 'degrade' | 'hold';
  reason?: string;
}

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const { reviewVerdict, stopped, levelAtMergeTime, limits } = input;
  const ciGreen = input.requiredChecks.length > 0 && input.requiredChecks.every((c) => c.state === 'success');
  const filesTouched = input.files.length;
  const diffLines = input.files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const forbiddenHits = input.files.flatMap((f) =>
    [f.previousPath, f.path].filter((p): p is string => p !== undefined && matchesAnyGlob(limits.forbidden, p)),
  );
  const riskProblems: string[] = [];
  if (input.filesComplete === false) riskProblems.push('the list of changed files is incomplete');
  if (filesTouched > limits.maxFiles) riskProblems.push(`${filesTouched} files touched (limit ${limits.maxFiles})`);
  if (diffLines > limits.maxDiffLines) riskProblems.push(`${diffLines} diff lines (limit ${limits.maxDiffLines})`);
  if (forbiddenHits.length > 0) riskProblems.push(`forbidden paths touched: ${forbiddenHits.join(', ')}`);
  const riskGate = { passed: riskProblems.length === 0, filesTouched, diffLines, forbiddenHits };

  const base = { reviewVerdict, ciGreen, riskGate, stopped, levelAtMergeTime };
  const fail = (decision: 'degrade' | 'hold', reason: string): MergeGateResult => ({ ...base, decision, reason });

  if (reviewVerdict !== 'approve') return fail('degrade', `review gate: verdict is ${reviewVerdict}, not approve`);
  if (!ciGreen) {
    const bad = input.requiredChecks.filter((c) => c.state !== 'success').map((c) => `${c.name} (${c.state})`);
    return fail('degrade', `ci gate: ${bad.length > 0 ? bad.join(', ') : 'no required checks reported'}`);
  }
  if (!riskGate.passed) return fail('degrade', `risk gate: ${riskProblems.join('; ')}`);
  if (stopped) return fail('hold', 'stop gate: a Stop was issued');
  if (levelAtMergeTime !== 3) return fail('degrade', `level gate: resolved level is ${levelAtMergeTime}, not 3`);
  return { ...base, decision: 'merge' };
}

export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  const p = path.replace(/^\.?\//, '');
  return patterns.some((g) => globToRegExp(g).test(p));
}

const cache = new Map<string, RegExp>();

/**
 * `**` matches across directories (and `**` followed by `/` also matches zero directories), `*` and
 * `?` stay inside one path segment. Everything else is literal. Matching is case-sensitive.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        if (glob.charAt(i + 2) === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}
