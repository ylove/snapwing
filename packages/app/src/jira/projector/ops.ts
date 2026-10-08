// The Jira outbox ops (B 7.1, B 7.2, main 9.1): what each `target='jira'` row's payload must hold,
// the validator that turns a row into a typed op before anything is sent, and the Jira calls each op
// makes. The drain loop (drain.ts) decides order, batching, retries, and what to do on success.
//
// Payloads, as the engine (`pipeline/src/engine/steps.ts`) and the lifecycle rows
// (`pipeline/src/state/projections/outbox/jira.ts`) write them:
//
//   create-issue   { fields, customFields, suggestedAssigneeEmail?, promptErrors?, screenshots? }
//   transition     { issueKey, to, resolution? }            to is a logical target (backlog, in-progress,
//                                                           in-review, done) the projector maps to the
//                                                           project's status (statuses.ts); resolution is a
//                                                           name, e.g. "Won't Do"
//   add-comment    { issueKey, text }                       batched by `batch_key` (drain.ts)
//   add-labels     { issueKey, labels }
//   update-fields  { issueKey, fields?, customFields? }     at least one field; `fields.assignee` is
//                                                           { email }, resolved to an accountId (below)
//   create-task    { fields }                               an issue no incident owns (the A 5.3 ux-friction
//                                                           Task): the create-issue fields, no assignee,
//                                                           no custom fields; a retry finds the issue by the
//                                                           label `snapwing-task-<row id>` (`taskLabel`)
//
// Custom fields travel by name (`Implementation Prompt`, `Autonomy Level`, ...). The projector maps
// a name to a Jira field id through `customFieldIds`; a name with no id is left out of the write
// (fields.ts checks the map at startup; prompt.ts rewrites the placeholder key).
//
// Assignee (main 9.1, B 7.2). Jira Cloud assigns by `accountId`, so an email is looked up first
// (`client.findUserByEmail`, cached per projector by `createAssigneeResolver`). `create-issue` sets the
// assignee from `suggestedAssigneeEmail`; an `update-fields` row writes `fields.assignee` (a claim by an
// engineer, batch key `field:{incident}:assignee`, so a human's later edit drops it, B 7.3). An email
// that resolves to no user (or one the credentials may not search for) leaves the assignee as it was
// and adds a comment naming the suggested owner; it never fails the row.

import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import { CUSTOM_FIELD_IMPLEMENTATION_PROMPT } from '@snapwing/pipeline/jira/synthesis.ts';
import { JIRA_LOGICAL_STATUSES, toJiraLogicalStatus, type JiraLogicalStatus } from '@snapwing/pipeline/jira/statuses.ts';
import {
  JiraAuthError,
  JiraNotFoundError,
  JiraTransitionNotFoundError,
  JiraValidationError,
  type Adf,
  type JiraClient,
  type UploadAttachmentInput,
} from '../client/index.ts';
import type { StatusResolver } from './statuses.ts';

/** The label `create-issue` adds so a retry finds the issue an earlier attempt created. */
export function incidentLabel(incidentId: string): string {
  return `snapwing-${incidentId}`;
}

/** The label `create-task` adds, so a retry finds the issue an earlier attempt created. */
export function taskLabel(rowId: string): string {
  return `snapwing-task-${rowId}`;
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
  /** The suggested owner's email; resolved to an account id at send time. */
  assigneeEmail?: string;
}

export interface TransitionOp {
  op: 'transition';
  issueKey: string;
  /** A logical target; a row written before logical targets that names a status spelling one (`In Progress`) reads as it. */
  to: JiraLogicalStatus;
  /** A resolution name sent with the transition (`fields.resolution`); the client falls back to none if the screen lacks it. */
  resolution?: string;
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
  /** From `fields.assignee.email`; resolved to an account id at send time. */
  assigneeEmail?: string;
}

/** An issue no incident owns: created once, nothing appended, no assignee. */
export interface CreateTaskOp {
  op: 'create-task';
  /** `taskLabel(row.id)`, searched before creating. */
  label: string;
  fields: Record<string, unknown>;
}

export type JiraOp = CreateIssueOp | TransitionOp | AddCommentOp | AddLabelsOp | UpdateFieldsOp | CreateTaskOp;

export const JIRA_OPS: readonly JiraOp['op'][] = Object.freeze(['create-issue', 'transition', 'add-comment', 'add-labels', 'update-fields', 'create-task'] as const);

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
      const to = toJiraLogicalStatus(p['to']);
      if (to === undefined) bad(`to must be a lifecycle target (${JIRA_LOGICAL_STATUSES.join(', ')}), got ${JSON.stringify(p['to'])}`);
      const resolution = p['resolution'];
      if (resolution !== undefined && !nonEmpty(resolution)) bad('resolution must be a non-empty string naming a resolution');
      return { op: 'transition', issueKey: key, to: to as JiraLogicalStatus, ...(resolution === undefined ? {} : { resolution: (resolution as string).trim() }) };
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
      const { assignee, ...plain } = fields as Record<string, unknown>;
      const assigneeEmail = assignee === undefined ? undefined : parseAssignee(assignee, bad);
      if (Object.keys(plain).length + Object.keys(customFields).length + (assigneeEmail === undefined ? 0 : 1) === 0) bad('names no field to update');
      return { op: 'update-fields', issueKey: key, fields: plain, customFields, ...(assigneeEmail === undefined ? {} : { assigneeEmail }) };
    }
    case 'create-task': {
      const f = p['fields'];
      if (!isRecord(f)) return bad('fields must be an object');
      if (f['assignee'] !== undefined) bad('a create-task row assigns nobody');
      return { op: 'create-task', label: taskLabel(row.id), fields: parseIssueFields(f, bad) };
    }
    default:
      return bad(`unknown op; expected one of ${JIRA_OPS.join(', ')}`);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function parseEmail(v: unknown, where: string, bad: (problem: string) => never): string {
  if (typeof v !== 'string' || !EMAIL.test(v.trim())) return bad(`${where} must be an email address`);
  return v.trim();
}

function parseAssignee(v: unknown, bad: (problem: string) => never): string {
  if (!isRecord(v)) return bad('fields.assignee must be { email }');
  return parseEmail(v['email'], 'fields.assignee.email', bad);
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
  const fields = parseIssueFields(f, bad);
  const suggested = p['suggestedAssigneeEmail'];
  return {
    op: 'create-issue',
    incidentId: row.incidentId as string,
    fields,
    customFields: parseCustomFields(p['customFields'], bad),
    screenshots: parseScreenshots(p['screenshots'], bad),
    // A suggestion is a hint: one that is not an email is left out rather than parking the issue.
    ...(typeof suggested === 'string' && EMAIL.test(suggested.trim()) ? { assigneeEmail: suggested.trim() } : {}),
  };
}

/** The standard create fields both create ops carry: project, type, summary, ADF description, labels, priority, components. */
function parseIssueFields(f: Record<string, unknown>, bad: (problem: string) => never): Record<string, unknown> {
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
  return fields;
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

/**
 * The Implementation Prompt as the multi-line text custom field takes it on REST v3: an ADF document (a plain
 * string is a 400 "not valid Atlassian Document Format", found by the live tier). One code block, so
 * the XML's line breaks and indentation survive.
 */
export function promptToAdf(text: string): Adf {
  return { type: 'doc', version: 1, content: [{ type: 'codeBlock', attrs: { language: 'xml' }, content: [{ type: 'text', text }] }] };
}

/** Custom fields by Jira field id. Names with no id, and empty strings, are left out. The prompt goes as ADF. */
export function mapCustomFields(byName: Record<string, CustomFieldValue>, ids: Readonly<Record<string, string>>): Record<string, CustomFieldValue | Adf> {
  const out: Record<string, CustomFieldValue | Adf> = {};
  for (const [name, value] of Object.entries(byName)) {
    const id = ids[name];
    if (id === undefined || value === '') continue;
    out[id] = name === CUSTOM_FIELD_IMPLEMENTATION_PROMPT && typeof value === 'string' ? promptToAdf(value) : value;
  }
  return out;
}

/** Email to Jira account id, cached per projector. */
export interface AssigneeResolver {
  /** The account id for `email`, or undefined when no user matches. Rate limits and network errors throw. */
  resolve(email: string): Promise<string | undefined>;
}

/** How long a lookup that found nobody is remembered; a person found is kept for the projector's life. */
export const ASSIGNEE_MISS_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves emails with `client.findUserByEmail`, once per email (case-insensitive). A 401, 403, 404, or 400
 * from the search (no permission to browse users, say) reads as no match, so the issue is left unassigned
 * and commented rather than parked. A miss expires after `ASSIGNEE_MISS_TTL_MS`, so a person added to the
 * site later is found without a restart.
 */
export function createAssigneeResolver(client: JiraClient, now: () => Date = () => new Date()): AssigneeResolver {
  const found = new Map<string, string>();
  const missed = new Map<string, number>();
  return {
    async resolve(email) {
      const key = email.trim().toLowerCase();
      const hit = found.get(key);
      if (hit !== undefined) return hit;
      const until = missed.get(key);
      if (until !== undefined && now().getTime() < until) return undefined;
      let accountId: string | undefined;
      try {
        accountId = (await client.findUserByEmail(email))?.accountId;
      } catch (err) {
        if (!(err instanceof JiraAuthError || err instanceof JiraNotFoundError || err instanceof JiraValidationError)) throw err;
      }
      if (accountId === undefined) {
        missed.set(key, now().getTime() + ASSIGNEE_MISS_TTL_MS);
        return undefined;
      }
      found.set(key, accountId);
      return accountId;
    },
  };
}

/** The comment left when the suggested owner has no Jira user. */
export function unassignedText(email: string): string {
  return `Snapwing could not assign this issue: no Jira user matches ${email}. Suggested owner: ${email}.`;
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
export async function findOrCreateIssue(
  client: JiraClient,
  op: CreateIssueOp,
  customFieldIds: Readonly<Record<string, string>>,
  assignees: AssigneeResolver,
): Promise<FoundIssue> {
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
  const accountId = op.assigneeEmail === undefined ? undefined : await assignees.resolve(op.assigneeEmail);
  const ref = await client.createIssue({
    ...op.fields,
    labels,
    ...(accountId === undefined ? {} : { assignee: { accountId } }),
    ...mapCustomFields(op.customFields, customFieldIds),
  });
  if (op.assigneeEmail !== undefined && accountId === undefined) await client.addComment(ref.key, textToAdf(unassignedText(op.assigneeEmail)));
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

/**
 * Transitions to the status `target` resolves to. When the workflow offers no transition there and
 * the issue is already in that status (a project without In Review keeps a merged issue in progress,
 * or an earlier attempt moved it before its ack was lost), there is nothing to do: resolves false.
 */
export async function transitionTo(client: JiraClient, statuses: StatusResolver, op: TransitionOp): Promise<boolean> {
  const status = await statuses.resolve(op.issueKey, op.to);
  try {
    await client.transitionIssue(op.issueKey, status, op.resolution);
    return true;
  } catch (err) {
    if (!(err instanceof JiraTransitionNotFoundError)) throw err;
    const issue = await client.getIssue(op.issueKey, { fields: ['status'] });
    const current = isRecord(issue.fields['status']) ? issue.fields['status']['name'] : undefined;
    if (typeof current === 'string' && current.trim().toLowerCase() === status.trim().toLowerCase()) return false;
    throw err;
  }
}

/** Sends one non-create op. Resolves false when there was nothing to write (only unmapped custom fields, or already in the status). */
export async function sendOp(
  client: JiraClient,
  op: Exclude<JiraOp, CreateIssueOp>,
  customFieldIds: Readonly<Record<string, string>>,
  statuses: StatusResolver,
  assignees: AssigneeResolver,
): Promise<boolean> {
  switch (op.op) {
    case 'transition':
      return transitionTo(client, statuses, op);
    case 'add-comment':
      await client.addComment(op.issueKey, textToAdf(op.text));
      return true;
    case 'add-labels':
      await client.addLabels(op.issueKey, op.labels);
      return true;
    case 'create-task': {
      const page = await client.searchJql(`labels = "${op.label}" ORDER BY created ASC`, { maxResults: 1, fields: ['summary'] });
      if (page.issues[0] !== undefined) return false;
      await client.createIssue({ ...op.fields, labels: [...new Set([...(op.fields['labels'] as string[]), op.label])] });
      return true;
    }
    case 'update-fields': {
      const fields: Record<string, unknown> = { ...op.fields, ...mapCustomFields(op.customFields, customFieldIds) };
      const accountId = op.assigneeEmail === undefined ? undefined : await assignees.resolve(op.assigneeEmail);
      if (accountId !== undefined) fields['assignee'] = { accountId };
      const unresolved = op.assigneeEmail !== undefined && accountId === undefined ? op.assigneeEmail : undefined;
      if (Object.keys(fields).length === 0 && unresolved === undefined) return false;
      if (Object.keys(fields).length > 0) await client.editIssue(op.issueKey, fields);
      if (unresolved !== undefined) await client.addComment(op.issueKey, textToAdf(unassignedText(unresolved)));
      return true;
    }
  }
}
