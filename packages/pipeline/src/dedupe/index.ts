// src/dedupe/index.ts (main 6): dedupe before create. Two searches, in order:
//   1. Jira JQL over the resolved project: open issues updated in the last 30 days, then a full-text pass.
//   2. The recent-incidents cache (7-day TTL, CachePort), keyed by surface + component + normalized
//      summary hash, which catches an incident the agent itself filed minutes ago from another channel.
// Embedding similarity is out of scope (main 17). Jira reads here are searches only; no Jira write
// happens in this stage (writes go through the outbox).

import { createHash } from 'node:crypto';
import type { ContextBundle, DedupeResult, Resolution } from '../contracts/incident.ts';
import type { CachePort } from '../ports/cache.ts';

/** One issue returned by a Jira search. */
export interface JiraSearchHit {
  key: string;
  summary: string;
  assignee?: string;
}

/** The Jira read the dedupe stage needs. The real client lives in the app package. */
export interface JiraSearch {
  search(jql: string, limit: number): Promise<JiraSearchHit[]>;
}

export type DedupeCandidate = DedupeResult['candidates'][number];

export interface DedupeDeps {
  jira: JiraSearch;
  cache: CachePort;
  /** Minimum score (0..1) for a candidate to be returned. Default 0.6. */
  threshold?: number;
  /** Max issues per Jira search. Default 20. */
  limit?: number;
  /** The bundle's extracted summary. Default: the anchor message's first line. */
  summary?: string;
}

export const DEFAULT_DEDUPE_THRESHOLD = 0.6;
export const DEFAULT_SEARCH_LIMIT = 20;
export const RECENT_INCIDENT_TTL_SEC = 7 * 24 * 60 * 60;
export const JIRA_WINDOW_DAYS = 30;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'to', 'of', 'in', 'on', 'at',
  'for', 'and', 'or', 'but', 'with', 'my', 'our', 'we', 'i', 'you', 'now', 'again', 'just', 'has', 'have', 'had',
]);

/**
 * Normalizes a summary for matching: lowercase, accents stripped, punctuation to spaces, whitespace
 * collapsed. The same function feeds the cache key (write and lookup) and the scorer.
 */
export function normalizeSummary(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The significant tokens of a normalized summary, stopwords dropped, sorted and deduplicated. */
export function summaryTokens(text: string): string[] {
  const tokens = normalizeSummary(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
}

/** Hash of the significant tokens, so word order and filler words do not change the key. */
export function summaryHash(text: string): string {
  return createHash('sha256').update(summaryTokens(text).join(' ')).digest('hex').slice(0, 32);
}

/** Cache key for the recent-incidents table: surface + component + normalized summary hash. */
export function recentIncidentKey(resolution: Pick<Resolution, 'surfaceId' | 'componentId'>, summary: string): string {
  return `dedupe:recent:${resolution.surfaceId ?? '-'}:${resolution.componentId ?? '-'}:${summaryHash(summary)}`;
}

interface RecentEntry {
  issueKey: string;
  summary: string;
  assignee?: string;
}

/** Records a freshly filed incident so another channel's report minutes later finds it. */
export async function rememberIncident(
  cache: CachePort,
  resolution: Pick<Resolution, 'surfaceId' | 'componentId'>,
  entry: { issueKey: string; summary: string; assignee?: string },
): Promise<void> {
  const value: RecentEntry = { issueKey: entry.issueKey, summary: entry.summary };
  if (entry.assignee !== undefined) value.assignee = entry.assignee;
  await cache.set(recentIncidentKey(resolution, entry.summary), JSON.stringify(value), RECENT_INCIDENT_TTL_SEC);
}

/** Similarity of two summaries in 0..1: the larger of token Jaccard and containment of the shorter side. */
export function scoreSummaries(a: string, b: string): number {
  const ta = summaryTokens(a);
  const tb = summaryTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  const union = ta.length + tb.length - shared;
  const jaccard = shared / union;
  const containment = shared / Math.min(ta.length, tb.length);
  // Containment alone over-scores one-word summaries, so it counts at 0.9 weight.
  return Math.min(1, Math.max(jaccard, containment * 0.9));
}

function jqlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The two JQL queries: open issues updated in 30 days, and the same narrowed by full text. */
export function buildDedupeQueries(jiraProject: string | undefined, summary: string): { recent: string; fullText: string } {
  const base = [
    ...(jiraProject ? [`project = ${jqlString(jiraProject)}`] : []),
    'statusCategory != Done',
    `updated >= -${JIRA_WINDOW_DAYS}d`,
  ].join(' AND ');
  const terms = summaryTokens(summary).join(' ');
  return {
    recent: `${base} ORDER BY updated DESC`,
    fullText: `${base} AND text ~ ${jqlString(terms)} ORDER BY updated DESC`,
  };
}

function extractSummary(bundle: ContextBundle): string {
  const anchor = bundle.included.find((m) => m.id === bundle.anchorId) ?? bundle.included[bundle.included.length - 1];
  const first = (anchor?.text ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.trim().slice(0, 240);
}

/**
 * Looks for an existing issue that matches the incident. Returns scored candidates at or above the
 * threshold, best first; `decision` is `pending-user` when there are any (the ask is the caller's),
 * `none` otherwise.
 */
export async function dedupe(resolution: Resolution, bundle: ContextBundle, deps: DedupeDeps): Promise<DedupeResult> {
  const threshold = deps.threshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const limit = deps.limit ?? DEFAULT_SEARCH_LIMIT;
  const summary = (deps.summary ?? extractSummary(bundle)).trim();
  if (summary.length === 0 || summaryTokens(summary).length === 0) return { candidates: [], decision: 'none' };

  const byKey = new Map<string, DedupeCandidate>();
  const offer = (hit: { key: string; summary: string; assignee?: string }, score: number): void => {
    if (score < threshold) return;
    const prior = byKey.get(hit.key);
    if (prior && prior.score >= score) return;
    const candidate: DedupeCandidate = { issueKey: hit.key, summary: hit.summary, score };
    if (hit.assignee !== undefined) candidate.assignee = hit.assignee;
    byKey.set(hit.key, candidate);
  };

  const queries = buildDedupeQueries(resolution.jiraProject, summary);
  const [recent, fullText] = await Promise.all([deps.jira.search(queries.recent, limit), deps.jira.search(queries.fullText, limit)]);
  for (const hit of [...recent, ...fullText]) offer(hit, scoreSummaries(summary, hit.summary));

  const cached = await deps.cache.get(recentIncidentKey(resolution, summary));
  if (cached !== null) {
    const entry = parseRecent(cached);
    if (entry) offer({ key: entry.issueKey, summary: entry.summary, ...(entry.assignee !== undefined ? { assignee: entry.assignee } : {}) }, 1);
  }

  const candidates = [...byKey.values()].sort((a, b) => b.score - a.score || a.issueKey.localeCompare(b.issueKey));
  return { candidates, decision: candidates.length > 0 ? 'pending-user' : 'none' };
}

function parseRecent(raw: string): RecentEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['issueKey'] !== 'string' || typeof v['summary'] !== 'string') return null;
  const entry: RecentEntry = { issueKey: v['issueKey'], summary: v['summary'] };
  if (typeof v['assignee'] === 'string') entry.assignee = v['assignee'];
  return entry;
}
