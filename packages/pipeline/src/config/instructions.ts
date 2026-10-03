// INSTRUCTIONS.md (Companion A 6.1, 6.3, 6.4): the workspace's prose rules for the model.
//
// `loadInstructions` caps the file at 4,000 characters and turns it into one `<workspace-instructions>`
// block, escaped for XML. The block goes into the triage, clarify, fixer (the implementation request),
// and review prompts, one place each: `withInstructions` for the two system prompts,
// `buildImplementationRequest` and `buildReviewInput` for the other two. An absent or empty file means
// no block at all, so the prompts are byte for byte what they were without one.
//
// `lintInstructions` reports instructions that try to loosen a guardrail the map, the playbook, or main
// 16 sets ("always merge automatically" on a level 1 surface, A 8). It is a deterministic phrase match,
// not a model call, and it never edits the text: a flagged instruction stays in the block, and the
// pipeline ignores it where the guardrail disagrees (instructions only make the agent more careful, A 6.4).

import type { AutonomyLevel, AutonomyLevelId, FixerStart, MergeActor, WorkspaceMap } from '../map/types.ts';
import { resolveAutonomy } from '../policy/autonomy.ts';

/** The cap on what is injected (A 6.3), in characters (Unicode code points). */
export const INSTRUCTIONS_MAX_CHARS = 4000;

export const INSTRUCTIONS_ELEMENT = 'workspace-instructions';

/** A loaded instructions file. `text` is what the model reads; `block` is it wrapped and escaped. */
export interface WorkspaceInstructions {
  /** The file with HTML comments removed and the ends trimmed. Never empty. */
  text: string;
  /** `<workspace-instructions>` + the escaped text + `</workspace-instructions>`. */
  block: string;
  /** Length of `text` in characters, at most INSTRUCTIONS_MAX_CHARS. */
  characters: number;
}

export type InstructionsLoad =
  /** `instructions` is undefined when the file is absent, empty, or holds only comments: no block. */
  | { ok: true; instructions: WorkspaceInstructions | undefined }
  /** Rejected with the reason; `instructions` is the previous version, which stays live. */
  | { ok: false; reason: string; instructions: WorkspaceInstructions | undefined };

/**
 * Loads INSTRUCTIONS.md. `text` undefined (or null) means the file is absent. HTML comments (the
 * commented example onboarding writes) are dropped and do not count against the cap. Over the cap,
 * the file is rejected with the reason and `previous` is returned in its place.
 */
export function loadInstructions(text: string | null | undefined, previous?: WorkspaceInstructions): InstructionsLoad {
  if (text === undefined || text === null) return { ok: true, instructions: undefined };
  const body = stripComments(text).trim();
  if (body === '') return { ok: true, instructions: undefined };
  const characters = [...body].length;
  if (characters > INSTRUCTIONS_MAX_CHARS) {
    return {
      ok: false,
      reason: `INSTRUCTIONS.md is ${formatCount(characters)} characters; the cap is ${formatCount(INSTRUCTIONS_MAX_CHARS)} (Companion A 6.3). Shorten it; the previous version stays live.`,
      instructions: previous,
    };
  }
  return { ok: true, instructions: { text: body, block: instructionsBlock(body), characters } };
}

/** The `<workspace-instructions>` element for `text`, escaped for XML text content. */
export function instructionsBlock(text: string): string {
  return `<${INSTRUCTIONS_ELEMENT}>\n${escapeXmlText(text.trim())}\n</${INSTRUCTIONS_ELEMENT}>`;
}

/** A system prompt with the block appended after it, or the prompt unchanged when there is none. */
export function withInstructions(system: string, instructions: WorkspaceInstructions | undefined): string {
  return instructions === undefined ? system : `${system}\n\n${instructions.block}`;
}

/** Escapes text content and drops characters XML 1.0 cannot carry (most controls, lone surrogates). */
export function escapeXmlText(text: string): string {
  let kept = '';
  for (const ch of text) if (xmlChar(ch.codePointAt(0) ?? 0)) kept += ch;
  return kept.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** XML 1.0 `Char`: tab, newline, carriage return, and the rest minus surrogates, U+FFFE, and U+FFFF. */
function xmlChar(cp: number): boolean {
  if (cp < 0x20) return cp === 0x09 || cp === 0x0a || cp === 0x0d;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return cp !== 0xfffe && cp !== 0xffff;
}

/** Removes HTML comments, keeping their line breaks so lint line numbers match the file. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ''));
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------------------------
// Lint

/**
 * The part of the playbook (A 6.2) the lint reads. Structural, so the full `Playbook` from the
 * playbook loader satisfies it. Absent sections take Companion A's defaults.
 */
export interface InstructionsLintPlaybook {
  readonly claims?: {
    /** ISO 8601 duration a claim holds the fixer for (A 2.4). Default PT4H. */
    readonly expiry?: string;
  };
}

/** The map fields the lint reads: per-surface autonomy comes from the map's dial (main 4.6). */
export type InstructionsLintMap = Pick<WorkspaceMap, 'surfaces' | 'vocabulary' | 'policies'>;

export type InstructionsLintRule =
  /** Agent merges where the dial says a human merges (A 8: "always merge automatically" on level 1). */
  | 'autonomy-merge'
  /** Starting the fixer unasked where the dial says on tap or never. */
  | 'autonomy-fixer'
  /** Naming a higher autonomy level than the dial gives. */
  | 'autonomy-level'
  /** Skipping the review agent, CI, the risk gate, or branch protection (main 16). */
  | 'merge-gates'
  /** The fixer merging, or changing CI configuration, CODEOWNERS, or branch protection (main 16). */
  | 'fixer-blast-radius'
  /** Starting the fixer over an engineer's claim (playbook claims, A 2.1). */
  | 'claims'
  /** Ignoring a Stop (main 16). */
  | 'stop';

export interface InstructionsLintFinding {
  rule: InstructionsLintRule;
  /** 1-based line in the file where the flagged sentence starts. */
  line: number;
  /** The flagged sentence, verbatim. The lint never edits the text. */
  instruction: string;
  /** Where the conflicting rule lives. */
  source: 'map' | 'playbook' | 'guardrail';
  /** The conflicting rule, named, in one sentence for the console and `config check`. */
  conflict: string;
  /** For autonomy rules: the surfaces (`web`) or components (`web/auth-web`) it conflicts on. */
  targets?: string[];
}

const DEFAULT_CLAIM_EXPIRY = 'PT4H';

/** Main 4.6's level table, used when the map omits a level. */
const DEFAULT_LEVELS: Record<AutonomyLevelId, Pick<AutonomyLevel, 'name' | 'fixer' | 'merge'>> = {
  0: { name: 'ticket-only', fixer: 'never', merge: 'none' },
  1: { name: 'fix-on-tap', fixer: 'on-tap', merge: 'human' },
  2: { name: 'fix-now', fixer: 'immediate', merge: 'human' },
  3: { name: 'autopilot', fixer: 'immediate', merge: 'agent' },
};

/** A word that, earlier in the same clause, turns an instruction into a restraint. */
const RESTRAINT =
  /\b(?:never|not|don't|dont|do not|does not|doesn't|no|hold|holds|holding|avoid|pause|stop|block|prevent|refuse|wait|delay|cannot|can't|must not|mustn't|shouldn't|should not|won't|disable)\b/;

const START_FIXER = String.raw`(?:start|run|kick off|launch|trigger|dispatch)\w*\b[^.;]*\bfixer`;

/** "Treat checkout as level 3", "set admin to autonomy 2": an instruction that names a level. */
const LEVEL_RAISE = /\b(?:treat|set|run|put|raise|move|bump|make|use)\b[^.;]*?\b(?:autonomy|level)\s*(?:of\s+|to\s+|=\s*)?([0-3])\b/;
/** "Use autopilot on checkout": level 3 by name. */
const AUTOPILOT_ON = /\b(?:on|use|enable|allow|turn on)\s+autopilot\b(?!\s+merg)/;

interface Matcher {
  rule: InstructionsLintRule;
  patterns: readonly RegExp[];
}

const MATCHERS: readonly Matcher[] = [
  {
    rule: 'autonomy-merge',
    patterns: [
      /\bauto-?merg\w*/,
      /\bautopilot merg\w*/,
      /\b(?:always|automatically|just|immediately|go ahead and) merge\b/,
      /\bmerg\w*\b[^.;]*?\b(?:automatically|on its own|by itself|without (?:a |any )?(?:human|approval|approver|review|reviewer|sign-?off|waiting))/,
    ],
  },
  {
    rule: 'autonomy-fixer',
    patterns: [
      new RegExp(String.raw`\b(?:always|automatically|immediately|right away)\b[^.;]*\b${START_FIXER}`),
      new RegExp(String.raw`\b${START_FIXER}\b[^.;]*?\b(?:automatically|immediately|right away|without (?:a tap|asking|waiting)|for every|on every|for all|on all)\b`),
      /\b(?:always|automatically)\b[^.;]*\b(?:open|raise|create)\b[^.;]*\b(?:prs?|pull requests?)\b/,
    ],
  },
  {
    rule: 'autonomy-level',
    patterns: [LEVEL_RAISE, AUTOPILOT_ON],
  },
  {
    rule: 'merge-gates',
    patterns: [
      /\b(?:skip|bypass|ignore|override|turn off|switch off|circumvent)\w*\b[^.;]*?\b(?:review agent|the review|reviews?|ci|checks?|tests?|test suite|branch protection|risk gate|required approvals?)\b/,
      /\bmerg\w*\b[^.;]*?\b(?:even if|even when|despite|regardless of|with)\b[^.;]*?\b(?:ci|checks?|tests?|review agent)\b[^.;]*?\b(?:fail\w*|red|pending|broken|missing)/,
      /\bmerg\w*\b[^.;]*?\bwithout\b[^.;]*?\b(?:ci|checks?|tests?|review agent|the risk gate)\b/,
    ],
  },
  {
    rule: 'fixer-blast-radius',
    patterns: [
      /\bfixer\b[^.;]*?\bmerg\w*/,
      /\b(?:edit|change|modify|update|touch|rewrite|delete|remove|disable)\b[^.;]*?\b(?:ci config\w*|ci workflows?|\.github\/workflows|github workflows?|workflow files?|codeowners|branch protection)/,
    ],
  },
  {
    rule: 'claims',
    patterns: [
      /\b(?:ignore|override|disregard|bypass|skip|overrule)\w*\b[^.;]*?(?:\bclaim(?:s|ed)?\b|:eyes:|👀)/u,
      new RegExp(String.raw`\b${START_FIXER}\b[^.;]*?\beven (?:if|when|though)\b[^.;]*?(?:\bclaim\w*|\bon it\b|\blooking\b|:eyes:|👀)`, 'u'),
    ],
  },
  {
    rule: 'stop',
    patterns: [/\b(?:ignore|override|disregard|overrule)\w*\b[^.;]*?(?:\bstop(?:s|ped)?\b|:octagonal_sign:|🛑)/u],
  },
];

interface Sentence {
  line: number;
  text: string;
}

/**
 * Flags instructions that try to loosen a guardrail. Pure and deterministic; never edits `text`.
 * Autonomy rules are checked per surface (and per component with its own override) named in the
 * sentence by id, label, or vocabulary term, or against every surface when it names none.
 */
export function lintInstructions(text: string, playbook: InstructionsLintPlaybook, map: InstructionsLintMap): InstructionsLintFinding[] {
  const findings: InstructionsLintFinding[] = [];
  for (const sentence of sentences(text)) {
    const lower = normalize(sentence.text);
    for (const matcher of MATCHERS) {
      if (!matcher.patterns.some((p) => unrestrained(lower, p))) continue;
      const finding = check(matcher.rule, sentence, lower, playbook, map);
      if (finding !== undefined) findings.push(finding);
    }
  }
  return findings;
}

function check(
  rule: InstructionsLintRule,
  sentence: Sentence,
  lower: string,
  playbook: InstructionsLintPlaybook,
  map: InstructionsLintMap,
): InstructionsLintFinding | undefined {
  const base = { rule, line: sentence.line, instruction: sentence.text };
  switch (rule) {
    case 'autonomy-merge':
      return autonomyFinding(base, targets(lower, map), map, (l) => l.merge !== 'agent', (t, l) =>
        `${t} is autonomy level ${l.id} (${l.name}), where ${mergeWords(l.merge)}`,
        'only the autonomy dial in the workspace map lets the agent merge (main 4.6, A 6.4)');
    case 'autonomy-fixer':
      return autonomyFinding(base, targets(lower, map), map, (l) => l.fixer !== 'immediate', (t, l) =>
        `${t} is autonomy level ${l.id} (${l.name}), where ${fixerWords(l.fixer)}`,
        'only the autonomy dial in the workspace map starts the fixer unasked (main 4.6, A 6.4)');
    case 'autonomy-level': {
      const named = namedLevel(lower);
      if (named === undefined) return undefined;
      return autonomyFinding(base, targets(lower, map), map, (l) => l.id < named, (t, l) =>
        `${t} is autonomy level ${l.id} (${l.name}), below the level ${named} the instruction names`,
        'only the workspace map and the playbook raise autonomy (A 6.4)');
    }
    case 'merge-gates':
      return {
        ...base,
        source: 'guardrail',
        conflict:
          'Merges always pass the review agent, CI, and branch protection, and an autopilot merge also passes the risk gate (main 16); instructions cannot waive a gate.',
      };
    case 'fixer-blast-radius':
      return {
        ...base,
        source: 'guardrail',
        conflict:
          'The fixer works on one branch in one repository, never merges, and never changes CI configuration, CODEOWNERS, or branch protection (main 16, agent blast radius).',
      };
    case 'claims': {
      const expiry = playbook.claims?.expiry ?? DEFAULT_CLAIM_EXPIRY;
      return {
        ...base,
        source: 'playbook',
        conflict: `Playbook <claims expiry="${expiry}">: an engineer's claim holds the fixer until it is released or expires (A 2.1, 2.4); instructions cannot override a claim.`,
      };
    }
    case 'stop':
      return {
        ...base,
        source: 'guardrail',
        conflict: 'Stop is honored at the next checkpoint on every card, status message, and Jira label (main 16); instructions cannot override it.',
      };
  }
}

interface Target {
  /** `surface` or `surface/component`. */
  name: string;
  level: AutonomyLevelId;
}

function autonomyFinding(
  base: Pick<InstructionsLintFinding, 'rule' | 'line' | 'instruction'>,
  candidates: readonly Target[],
  map: InstructionsLintMap,
  conflicts: (level: AutonomyLevel) => boolean,
  describe: (target: string, level: AutonomyLevel) => string,
  rule: string,
): InstructionsLintFinding | undefined {
  const hits = candidates.flatMap((t) => {
    const level = levelOf(map, t.level);
    return conflicts(level) ? [{ name: t.name, level }] : [];
  });
  if (hits.length === 0) return undefined;
  return {
    ...base,
    source: 'map',
    conflict: `${hits.map((h) => describe(h.name, h.level)).join('; ')}: ${rule}.`,
    targets: hits.map((h) => h.name),
  };
}

function levelOf(map: InstructionsLintMap, id: AutonomyLevelId): AutonomyLevel {
  const fromMap = map.policies.autonomy.levels.find((l) => l.id === id);
  return fromMap ?? { id, requires: [], ...DEFAULT_LEVELS[id] };
}

function mergeWords(merge: MergeActor): string {
  return merge === 'none' ? 'nothing is merged' : merge === 'human' ? 'a human merges' : 'the agent merges';
}

function fixerWords(fixer: FixerStart): string {
  return fixer === 'never' ? 'the fixer never starts' : fixer === 'on-tap' ? 'the fixer starts only on a tap' : 'the fixer starts immediately';
}

function namedLevel(lower: string): AutonomyLevelId | undefined {
  if (AUTOPILOT_ON.test(lower)) return 3;
  const m = LEVEL_RAISE.exec(lower);
  return m?.[1] === undefined ? undefined : (Number(m[1]) as AutonomyLevelId);
}

/**
 * The surfaces and components a sentence names, each at the highest level the dial gives it (the
 * lowest priority, since a priority override only lowers it). Every surface, plus every component
 * with its own override, when the sentence names none.
 */
function targets(lower: string, map: InstructionsLintMap): Target[] {
  const named = new Map<string, Target>();
  const add = (surfaceId: string, componentId?: string): void => {
    const name = componentId === undefined ? surfaceId : `${surfaceId}/${componentId}`;
    if (named.has(name)) return;
    const level = resolveAutonomy({ surfaceId, ...(componentId === undefined ? {} : { componentId }) }, { priority: 'Lowest' }, map);
    named.set(name, { name, level });
  };
  for (const s of map.surfaces) {
    if (mentions(lower, s.id) || mentions(lower, s.label)) add(s.id);
    for (const c of s.components) if (mentions(lower, c.id) || mentions(lower, c.label)) add(s.id, c.id);
  }
  for (const term of map.vocabulary) if (mentions(lower, term.text)) add(term.surface, term.component);
  if (named.size > 0) return [...named.values()];
  for (const s of map.surfaces) {
    add(s.id);
    for (const o of map.policies.autonomy.overrides) if (o.kind === 'component' && o.surface === s.id) add(s.id, o.ref);
  }
  return [...named.values()];
}

function mentions(lower: string, name: string): boolean {
  const n = normalize(name).trim();
  if (n === '') return false;
  return new RegExp(String.raw`(?<![\w-])${escapeRegExp(n)}(?![\w-])`).test(lower);
}

/** True when `pattern` matches with no restraint word earlier in the same comma-delimited clause. */
function unrestrained(lower: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  for (const m of lower.matchAll(global)) {
    const before = lower.slice(0, m.index);
    const clause = before.slice(Math.max(before.lastIndexOf(','), before.lastIndexOf(':')) + 1);
    if (!RESTRAINT.test(clause)) return true;
  }
  return false;
}

/** Sentences of the file outside comments, headings, and code fences, with their line numbers. */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let fenced = false;
  stripComments(text)
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (/^(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced || line === '' || line.startsWith('#')) return;
      const body = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
      for (const part of body.split(/(?<=[.;!?])\s+/)) {
        const s = part.trim();
        if (s !== '') out.push({ line: i + 1, text: s });
      }
    });
  return mergeContinuations(out, text);
}

/**
 * A list item wrapped onto the next line (A 6.3's own example does this) continues its sentence:
 * a line that is not a list item, after a sentence that did not end, is joined to it.
 */
function mergeContinuations(parts: Sentence[], text: string): Sentence[] {
  const lines = text.split('\n');
  const out: Sentence[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    const startsLine = (lines[p.line - 1] ?? '').trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').startsWith(p.text);
    const isItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[p.line - 1] ?? '');
    if (prev !== undefined && startsLine && !isItem && prev.line < p.line && !/[.;!?]$/.test(prev.text)) {
      prev.text = `${prev.text} ${p.text}`;
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
