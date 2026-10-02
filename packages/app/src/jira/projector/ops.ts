// The Jira outbox ops (B 7.1, B 7.2, main 9.1): what each `target='jira'` row's payload must hold,
// the validator that turns a row into a typed op before anything is sent, and the Jira calls each op
// makes. The drain loop (drain.ts) decides order, batching, retries, and what to do on success.
//
// Payloads, as the engine (`pipeline/src/engine/steps.ts`) and the lifecycle rows
// (`pipeline/src/state/projections/outbox/jira.ts`, #141) write them:
//
//   create-issue   { fields, customFields, suggestedAssigneeEmail?, promptErrors?, screenshots? }
//   transition     { issueKey, to }
//   add-comment    { issueKey, text }                       batched by `batch_key` (drain.ts)
//   add-labels     { issueKey, labels }
//   update-fields  { issueKey, fields?, customFields? }     at least one field
//
// Custom fields travel by name (`Implementation Prompt`, `Autonomy Level`, ...). The projector maps
// a name to a Jira field id through `customFieldIds`; a name with no id is left out of the write
// (fields.ts checks the map at startup; prompt.ts rewrites the placeholder key). `suggestedAssigneeEmail` is not sent yet:
// Jira assigns by account id, and resolving one is a user search this client does not make.

import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { Adf, JiraClient, UploadAttachmentInput } from '../client/index.ts';

/** The label `create-issue` adds so a retry finds the issue an earlier attempt created (#140). */
export function incidentLabel(incidentId: string): string {
  return `snapwing-${incidentId}`;
}

/** A screenshot a `create-issue` row asks to attach after the issue exists. */
export interface ScreenshotRef {
  url: string;
  /** The attachment's file name; defaults to the last path segment of `url`. */
  filename?: string;
  contentType?: string;
}

/** Fetches a screenshot's bytes for upload. The default (`fetchScreenshot`) is a plain GET. */
export type LoadScreenshot = (ref: ScreenshotRef) => Promise<UploadAttachmentInput>;

export type CustomFieldValue = string | number | null;

export interface CreateIssueOp {
  op: 'create-issue';
  incidentId: string;
  /** Standard Jira create fields (project, issuetype, summary, description, priority, labels, components). */
  fields: Record<string, unknown>;
  customFields: Record<string, CustomFieldValue>;
  screenshots: ScreenshotRef[];
}

export interface TransitionOp {
  op: 'transition';
  issueKey: string;
  to: string;
}

export interface AddCommentOp {
  op: 'add-comment';
  issueKey: string;
  text: string;
}

export interface AddLabelsOp {
  op: 'add-labels';
  issueKey: string;
  labels: string[];
}

export interface UpdateFieldsOp {
  op: 'update-fields';
  issueKey: string;
  fields: Record<string, unknown>;
  customFields: Record<string, CustomFieldValue>;
}

export type JiraOp = CreateIssueOp | TransitionOp | AddCommentOp | AddLabelsOp | UpdateFieldsOp;

export const JIRA_OPS: readonly JiraOp['op'][] = Object.freeze(['create-issue', 'transition', 'add-comment', 'add-labels', 'update-fields'] as const);

/** A row whose payload cannot be sent as it is. Retrying never helps, so the drain parks it. */
export class OutboxValidationError extends Error {
  readonly rowId: string;
  readonly op: string;

  constructor(row: Pick<OutboxItem, 'id' | 'op'>, problem: string) {
    super(`outbox row ${row.id} (${row.op}): ${problem}`);
    this.name = 'OutboxValidationError';
    this.rowId = row.id;
    this.op = row.op;
  }
}

// Validation ------------------------------------------------------------------------------------

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
/** Jira's limit on a summary. */
const SUMMARY_MAX = 255;
const LABEL_MAX = 255;
/** Jira rejects a comment body longer than this. */
const COMMENT_MAX = 32_767;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Validates a `target='jira'` row and returns its op. Throws `OutboxValidationError` naming the
 * first problem. Unknown payload keys are ignored, so a newer writer does not break an older drain.
 */
export function parseJiraRow(row: OutboxItem): JiraOp {
  const bad = (problem: string): never => {
    throw new OutboxValidationError(row, problem);
  };
  if (row.target !== 'jira') bad(`target is ${row.target}, not jira`);
  const p = row.payload;
  const issueKey = (): string => {
    const key = p['issueKey'];
    if (typeof key !== 'string' || !ISSUE_KEY.test(key)) bad(`issueKey must be an issue key like WEB-12, got ${JSON.stringify(key)}`);
    return key as string;
  };
  switch (row.op) {
    case 'create-issue':
      return parseCreateIssue(row, bad);
    case 'transition': {
      const key = issueKey();
      if (!nonEmpty(p['to'])) bad('to must name a status');
      return { op: 'transition', issueKey: key, to: (p['to'] as string).trim() };
    }
    case 'add-comment': {
      const key = issueKey();
      const text = p['text'];
      if (!nonEmpty(text)) bad('text must be a non-empty string');
      if ((text as string).length > COMMENT_MAX) bad(`text is longer than ${COMMENT_MAX} characters`);
      return { op: 'add-comment', issueKey: key, text: text as string };
    }
    case 'add-labels': {
      const key = issueKey();
      return { op: 'add-labels', issueKey: key, labels: parseLabels(p['labels'], bad, true) };
    }
    case 'update-fields': {
      const key = issueKey();
      const fields = p['fields'] === undefined ? {} : p['fields'];
      if (!isRecord(fields)) bad('fields must be an object');
      const customFields = parseCustomFields(p['customFields'], bad);
      if (Object.keys(fields as Record<string, unknown>).length + Object.keys(customFields).length === 0) bad('names no field to update');
      return { op: 'update-fields', issueKey: key, fields: { ...(fields as Record<string, unknown>) }, customFields };
    }
    default:
      return bad(`unknown op; expected one of ${JIRA_OPS.join(', ')}`);
  }
}

function parseLabels(v: unknown, bad: (problem: string) => never, required: boolean): string[] {
  if (!Array.isArray(v)) return bad('labels must be an array of strings');
  if (required && v.length === 0) bad('labels must not be empty');
  for (const l of v) {
    if (typeof l !== 'string' || l === '' || /\s/.test(l) || l.length > LABEL_MAX) bad(`label ${JSON.stringify(l)} is not a Jira label (non-empty, no spaces, at most ${LABEL_MAX} characters)`);
  }
  return [...new Set(v as string[])];
}

function parseCustomFields(v: unknown, bad: (problem: string) => never): Record<string, CustomFieldValue> {
  if (v === undefined) return {};
  if (!isRecord(v)) return bad('customFields must be an object keyed by field name');
  const out: Record<string, CustomFieldValue> = {};
  for (const [name, value] of Object.entries(v)) {
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      bad(`custom field ${JSON.stringify(name)} must be a string, a number, or null`);
    }
    out[name] = value as CustomFieldValue;
  }
  return out;
}

function isAdfDoc(v: unknown): boolean {
  return isRecord(v) && v['type'] === 'doc' && v['version'] === 1 && Array.isArray(v['content']);
}

function parseCreateIssue(row: OutboxItem, bad: (problem: string) => never): CreateIssueOp {
  const p = row.payload;
  if (row.incidentId === undefined) bad('create-issue needs the row to carry its incidentId');
  const f = p['fields'];
  if (!isRecord(f)) return bad('fields must be an object');
  const project = f['project'];
  if (!isRecord(project) || typeof project['key'] !== 'string' || !PROJECT_KEY.test(project['key'])) bad('fields.project.key must be a Jira project key');
  const issuetype = f['issuetype'];
  if (!isRecord(issuetype) || !nonEmpty(issuetype['name'])) bad('fields.issuetype.name must name an issue type');
  const summary = f['summary'];
  if (!nonEmpty(summary)) bad('fields.summary must be a non-empty string');
  if ((summary as string).length > SUMMARY_MAX || /[\r\n]/.test(summary as string)) bad(`fields.summary must be one line of at most ${SUMMARY_MAX} characters`);
  if (!isAdfDoc(f['description'])) bad('fields.description must be an ADF document');
  const priority = f['priority'];
  if (priority !== undefined && (!isRecord(priority) || !nonEmpty(priority['name']))) bad('fields.priority.name must name a priority');
  const labels = f['labels'] === undefined ? [] : parseLabels(f['labels'], bad, false);
  const components = f['components'];
  if (components !== undefined && (!Array.isArray(components) || !components.every((c) => isRecord(c) && nonEmpty(c['name'])))) {
    bad('fields.components must be a list of { name }');
  }
  const fields: Record<string, unknown> = {
    project: { key: (project as Record<string, unknown>)['key'] },
    issuetype: { name: (issuetype as Record<string, unknown>)['name'] },
    summary,
    description: f['description'],
    labels,
  };
  if (priority !== undefined) fields['priority'] = { name: (priority as Record<string, unknown>)['name'] };
  if (components !== undefined) fields['components'] = (components as Record<string, unknown>[]).map((c) => ({ name: c['name'] }));
  return {
    op: 'create-issue',
    incidentId: row.incidentId as string,
    fields,
    customFields: parseCustomFields(p['customFields'], bad),
    screenshots: parseScreenshots(p['screenshots'], bad),
  };
}

function parseScreenshots(v: unknown, bad: (problem: string) => never): ScreenshotRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return bad('screenshots must be a list');
  return v.map((s, i) => {
    if (!isRecord(s) || !nonEmpty(s['url'])) return bad(`screenshots[${i}].url must be a URL`);
    let url: URL;
    try {
      url = new URL(s['url'] as string);
    } catch {
      return bad(`screenshots[${i}].url is not a URL`);
    }
    if (s['filename'] !== undefined && !nonEmpty(s['filename'])) bad(`screenshots[${i}].filename must be a non-empty string`);
    if (s['contentType'] !== undefined && !nonEmpty(s['contentType'])) bad(`screenshots[${i}].contentType must be a non-empty string`);
    return {
      url: url.toString(),
      ...(s['filename'] === undefined ? {} : { filename: s['filename'] as string }),
      ...(s['contentType'] === undefined ? {} : { contentType: s['contentType'] as string }),
    };
  });
}

// Sending ---------------------------------------------------------------------------------------

/** Plain text to ADF: one paragraph per blank-line-separated block (the same rule as triage's `toAdf`). */
export function textToAdf(text: string): Adf {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return { type: 'doc', version: 1, content: paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) };
}

/** Custom fields by Jira field id. Names with no id, and empty strings, are left out. */
export function mapCustomFields(byName: Record<string, CustomFieldValue>, ids: Readonly<Record<string, string>>): Record<string, CustomFieldValue> {
  const out: Record<string, CustomFieldValue> = {};
  for (const [name, value] of Object.entries(byName)) {
    const id = ids[name];
    if (id === undefined || value === '') continue;
    out[id] = value;
  }
  return out;
}

export interface FoundIssue {
  key: string;
  /** False when the label search found an issue an earlier attempt created. */
  created: boolean;
  /** File names already attached (only read when the issue was found). */
  attached: string[];
}

/**
 * Finds the issue carrying `incidentLabel(incidentId)`, or creates it with that label added. This
 * is what makes `create-issue` idempotent across a crash between Jira's answer and the ack.
 */
export async function findOrCreateIssue(client: JiraClient, op: CreateIssueOp, customFieldIds: Readonly<Record<string, string>>): Promise<FoundIssue> {
  const label = incidentLabel(op.incidentId);
  const page = await client.searchJql(`labels = "${label}" ORDER BY created ASC`, { maxResults: 1, fields: ['attachment'] });
  const hit = page.issues[0];
  if (hit !== undefined) {
    const attachment = hit.fields['attachment'];
    const attached = Array.isArray(attachment)
      ? attachment.flatMap((a) => (isRecord(a) && typeof a['filename'] === 'string' ? [a['filename']] : []))
      : [];
    return { key: hit.key, created: false, attached };
  }
  const labels = [...new Set([...(op.fields['labels'] as string[]), label])];
  const ref = await client.createIssue({ ...op.fields, labels, ...mapCustomFields(op.customFields, customFieldIds) });
  return { key: ref.key, created: true, attached: [] };
}

export function screenshotFilename(ref: ScreenshotRef): string {
  if (ref.filename !== undefined) return ref.filename;
  const last = new URL(ref.url).pathname.split('/').filter((s) => s !== '').pop();
  return last === undefined ? 'screenshot' : decodeURIComponent(last);
}

/** The default loader: a GET of the URL. Chat-hosted files need an authenticated loader instead. */
export const fetchScreenshot: LoadScreenshot = async (ref) => {
  let res: Response;
  try {
    res = await fetch(ref.url);
  } catch {
    throw new Error(`screenshot fetch failed: ${new URL(ref.url).host}`);
  }
  if (!res.ok) throw new Error(`screenshot fetch answered ${res.status}: ${new URL(ref.url).host}`);
  const contentType = ref.contentType ?? res.headers.get('content-type') ?? undefined;
  return { filename: screenshotFilename(ref), content: new Uint8Array(await res.arrayBuffer()), ...(contentType === undefined ? {} : { contentType }) };
};

/** Uploads each screenshot not already attached (by file name). */
export async function uploadScreenshots(client: JiraClient, issueKey: string, refs: readonly ScreenshotRef[], attached: readonly string[], load: LoadScreenshot): Promise<void> {
  const have = new Set(attached);
  for (const ref of refs) {
    const filename = screenshotFilename(ref);
    if (have.has(filename)) continue;
    const file = await load(ref);
    await client.uploadAttachment(issueKey, { ...file, filename });
    have.add(filename);
  }
}

/** Sends one non-create op. Resolves false when there was nothing to write (only unmapped custom fields). */
export async function sendOp(client: JiraClient, op: Exclude<JiraOp, CreateIssueOp>, customFieldIds: Readonly<Record<string, string>>): Promise<boolean> {
  switch (op.op) {
    case 'transition':
      await client.transitionIssue(op.issueKey, op.to);
      return true;
    case 'add-comment':
      await client.addComment(op.issueKey, textToAdf(op.text));
      return true;
    case 'add-labels':
      await client.addLabels(op.issueKey, op.labels);
      return true;
    case 'update-fields': {
      const fields = { ...op.fields, ...mapCustomFields(op.customFields, customFieldIds) };
      if (Object.keys(fields).length === 0) return false;
      await client.editIssue(op.issueKey, fields);
      return true;
    }
  }
}
