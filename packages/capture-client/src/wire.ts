/**
 * The capture API's wire contract (main 15.3, 15.4). The app imports this file
 * for its routes; clients import it through the package. It imports nothing
 * from `pipeline` or `app`, and nothing here assumes HTTPS or a hosted domain.
 * Every validator takes `unknown` and returns a typed result; none throws.
 */

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export type CaptureSource = 'cli' | 'raycast';

export interface CaptureContext {
  readonly url?: string;
}

interface CaptureBase {
  /** Skip surface inference (`shot --surface web`). */
  readonly surface?: string;
  readonly source: CaptureSource;
  readonly context?: CaptureContext;
}

export interface TextCaptureRequest extends CaptureBase {
  readonly text: string;
}

export interface ImageCaptureRequest extends CaptureBase {
  /** Base64, no data: prefix. */
  readonly image: string;
  readonly mimeType: string;
}

export type CaptureRequest = TextCaptureRequest | ImageCaptureRequest;

export interface Choice {
  readonly id: string;
  readonly label: string;
}

export interface TrackedResponse {
  readonly kind: 'tracked';
  readonly captureId: string;
  readonly issueKey: string;
  readonly summary: string;
  readonly status: string;
  readonly assignee?: string;
  readonly url: string;
}

export interface NewResponse {
  readonly kind: 'new';
  readonly captureId: string;
  readonly surface: { readonly id: string; readonly label: string };
  /** Where the inference came from, such as `src/cart/...`. */
  readonly evidence?: string;
  readonly choices: readonly Choice[];
}

export interface WhichSurfaceResponse {
  readonly kind: 'which-surface';
  readonly captureId: string;
  readonly choices: readonly Choice[];
}

/**
 * A ticket ready to file where the agent may fix it on a tap: Fix it starts the fix as the ticket
 * files, Ticket only files it alone. The server offers Fix it to engineers only.
 */
export interface FixPreviewResponse {
  readonly kind: 'fix-preview';
  readonly captureId: string;
  /** The ticket's summary as it will be filed. */
  readonly summary: string;
  readonly choices: readonly Choice[];
}

export interface FiledResponse {
  readonly kind: 'filed';
  readonly captureId: string;
  readonly issueKey: string;
  readonly url: string;
}

export interface NotFiledResponse {
  readonly kind: 'not-filed';
  readonly captureId: string;
  readonly reason: string;
}

export interface PendingResponse {
  readonly kind: 'pending';
  readonly captureId: string;
}

export type LookupResponse =
  | TrackedResponse
  | NewResponse
  | WhichSurfaceResponse
  | FixPreviewResponse
  | FiledResponse
  | NotFiledResponse
  | PendingResponse;

export interface AnswerRequest {
  readonly choiceId: string;
}

/** `GET /issues/:key/status`: the status loopback for one ticket. */
export interface TicketStatus {
  readonly issueKey: string;
  readonly summary: string;
  readonly status: string;
  readonly assignee?: string;
  readonly url: string;
  readonly pullRequest?: { readonly url: string; readonly state: string };
}

export type QueueSectionId = 'assigned' | 'fixing' | 'waiting' | 'recent' | 'reports';

/** A button on a queue item. Only `open_pr` is a link; the others are taps in chat. */
export type QueueButton = { readonly kind: 'open_pr'; readonly url: string } | { readonly kind: 'stop' } | { readonly kind: 'merge' };

export interface QueueItem {
  readonly incidentId: string;
  /** The Jira key, else `incident <last six of the id>`. */
  readonly label: string;
  readonly summary: string;
  readonly priority?: string;
  /** Plain tail after the summary: the status, `PR #31`, or `merged 2026-10-02, PR #41`. */
  readonly detail: string;
  readonly buttons: readonly QueueButton[];
}

export interface QueueSection {
  readonly id: QueueSectionId;
  readonly title: string;
  /** What an empty section says. */
  readonly empty: string;
  readonly items: readonly QueueItem[];
}

/** `GET /queue`: the caller's queue, as Slack Home and the Teams card show it. A reporter gets "Your reports" only. */
export interface QueueView {
  readonly kind: 'engineer' | 'reporter';
  readonly title: string;
  readonly sections: readonly QueueSection[];
}

/** `POST /issues/:key/stop`. */
export interface StopResult {
  readonly issueKey: string;
  readonly stopped: boolean;
}

/**
 * One chat platform in the health response (main 15.2: Teams reduced mode shows in `snapwing status`).
 * `mode` is absent when the server does not say; an unknown value reads as absent.
 */
export interface PlatformHealth {
  readonly id: string;
  readonly ok: boolean;
  readonly mode?: 'full' | 'reduced';
  readonly detail?: string;
}

/** `GET /healthz`: the server, and each configured chat platform when it reports them. */
export interface HealthResult {
  readonly ok: boolean;
  readonly platforms?: readonly PlatformHealth[];
}

/** The routes, so the app and the client cannot drift. Keys go through encodeURIComponent. */
export const CAPTURE_ROUTES = {
  send: '/capture',
  answer: (captureId: string): string => `/capture/${encodeURIComponent(captureId)}/answer`,
  poll: (captureId: string): string => `/capture/${encodeURIComponent(captureId)}`,
  status: (key: string): string => `/issues/${encodeURIComponent(key)}/status`,
  stop: (key: string): string => `/issues/${encodeURIComponent(key)}/stop`,
  queue: '/queue',
  health: '/healthz',
} as const;

// ---- validators ----

type Rec = Readonly<Record<string, unknown>>;

function fail<T>(error: string): Validation<T> {
  return { ok: false, error };
}

function ok<T>(value: T): Validation<T> {
  return { ok: true, value };
}

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqStr(r: Rec, key: string, at: string): Validation<string> {
  const v = r[key];
  if (typeof v !== 'string' || v.length === 0) return fail(`${at}${key} must be a non-empty string`);
  return ok(v);
}

function optStr(r: Rec, key: string, at: string): Validation<string | undefined> {
  const v = r[key];
  if (v === undefined) return ok(undefined);
  if (typeof v !== 'string' || v.length === 0) return fail(`${at}${key} must be a non-empty string when present`);
  return ok(v);
}

/** Request field caps (main 15.3): the server and the clients share them. */
export const CAPTURE_TEXT_MAX_CHARS = 64 * 1024;
export const CAPTURE_URL_MAX_CHARS = 2048;
export const CAPTURE_SURFACE_MAX_CHARS = 64;

function capped(v: Validation<string | undefined>, max: number, what: string): Validation<string | undefined> {
  if (v.ok && v.value !== undefined && v.value.length > max) return fail(`${what} is too long (limit ${max} characters)`);
  return v;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateChoice(input: unknown, at = 'choice.'): Validation<Choice> {
  if (!isRec(input)) return fail(`${at.replace(/\.$/, '')} must be an object`);
  const id = reqStr(input, 'id', at);
  if (!id.ok) return id;
  const label = reqStr(input, 'label', at);
  if (!label.ok) return label;
  return ok({ id: id.value, label: label.value });
}

function validateChoices(input: unknown): Validation<readonly Choice[]> {
  if (!Array.isArray(input)) return fail('choices must be an array');
  const out: Choice[] = [];
  for (const [i, raw] of (input as readonly unknown[]).entries()) {
    const c = validateChoice(raw, `choices[${i}].`);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return ok(out);
}

export function validateCaptureRequest(input: unknown): Validation<CaptureRequest> {
  if (!isRec(input)) return fail('request must be an object');
  const source = input['source'];
  if (source !== 'cli' && source !== 'raycast') return fail("source must be 'cli' or 'raycast'");
  const surface = capped(optStr(input, 'surface', ''), CAPTURE_SURFACE_MAX_CHARS, 'surface');
  if (!surface.ok) return surface;

  let context: CaptureContext | undefined;
  const rawContext = input['context'];
  if (rawContext !== undefined) {
    if (!isRec(rawContext)) return fail('context must be an object');
    const url = capped(optStr(rawContext, 'url', 'context.'), CAPTURE_URL_MAX_CHARS, 'context.url');
    if (!url.ok) return url;
    context = url.value === undefined ? {} : { url: url.value };
  }

  const base: CaptureBase = {
    source,
    ...(surface.value === undefined ? {} : { surface: surface.value }),
    ...(context === undefined ? {} : { context }),
  };

  const hasText = input['text'] !== undefined;
  const hasImage = input['image'] !== undefined;
  if (hasText === hasImage) return fail('exactly one of text or image is required');
  if (hasText) {
    const text = reqStr(input, 'text', '');
    if (!text.ok) return text;
    if (text.value.length > CAPTURE_TEXT_MAX_CHARS) return fail(`text is too long (limit ${CAPTURE_TEXT_MAX_CHARS} characters)`);
    return ok({ ...base, text: text.value });
  }
  const image = reqStr(input, 'image', '');
  if (!image.ok) return image;
  if (!BASE64.test(image.value)) return fail('image must be base64');
  const mimeType = reqStr(input, 'mimeType', '');
  if (!mimeType.ok) return mimeType;
  if (!mimeType.value.startsWith('image/')) return fail('mimeType must be an image type');
  return ok({ ...base, image: image.value, mimeType: mimeType.value });
}

export function validateAnswerRequest(input: unknown): Validation<AnswerRequest> {
  if (!isRec(input)) return fail('answer must be an object');
  const choiceId = reqStr(input, 'choiceId', '');
  if (!choiceId.ok) return choiceId;
  return ok({ choiceId: choiceId.value });
}

export function validateLookupResponse(input: unknown): Validation<LookupResponse> {
  if (!isRec(input)) return fail('response must be an object');
  const captureId = reqStr(input, 'captureId', '');
  if (!captureId.ok) return captureId;
  const id = captureId.value;
  switch (input['kind']) {
    case 'tracked': {
      const issueKey = reqStr(input, 'issueKey', '');
      if (!issueKey.ok) return issueKey;
      const summary = reqStr(input, 'summary', '');
      if (!summary.ok) return summary;
      const status = reqStr(input, 'status', '');
      if (!status.ok) return status;
      const assignee = optStr(input, 'assignee', '');
      if (!assignee.ok) return assignee;
      const url = reqStr(input, 'url', '');
      if (!url.ok) return url;
      return ok({
        kind: 'tracked',
        captureId: id,
        issueKey: issueKey.value,
        summary: summary.value,
        status: status.value,
        ...(assignee.value === undefined ? {} : { assignee: assignee.value }),
        url: url.value,
      });
    }
    case 'new': {
      const surface = input['surface'];
      if (!isRec(surface)) return fail('surface must be an object');
      const sid = reqStr(surface, 'id', 'surface.');
      if (!sid.ok) return sid;
      const label = reqStr(surface, 'label', 'surface.');
      if (!label.ok) return label;
      const evidence = optStr(input, 'evidence', '');
      if (!evidence.ok) return evidence;
      const choices = validateChoices(input['choices']);
      if (!choices.ok) return choices;
      return ok({
        kind: 'new',
        captureId: id,
        surface: { id: sid.value, label: label.value },
        ...(evidence.value === undefined ? {} : { evidence: evidence.value }),
        choices: choices.value,
      });
    }
    case 'which-surface': {
      const choices = validateChoices(input['choices']);
      if (!choices.ok) return choices;
      return ok({ kind: 'which-surface', captureId: id, choices: choices.value });
    }
    case 'fix-preview': {
      const summary = reqStr(input, 'summary', '');
      if (!summary.ok) return summary;
      const choices = validateChoices(input['choices']);
      if (!choices.ok) return choices;
      return ok({ kind: 'fix-preview', captureId: id, summary: summary.value, choices: choices.value });
    }
    case 'filed': {
      const issueKey = reqStr(input, 'issueKey', '');
      if (!issueKey.ok) return issueKey;
      const url = reqStr(input, 'url', '');
      if (!url.ok) return url;
      return ok({ kind: 'filed', captureId: id, issueKey: issueKey.value, url: url.value });
    }
    case 'not-filed': {
      const reason = reqStr(input, 'reason', '');
      if (!reason.ok) return reason;
      return ok({ kind: 'not-filed', captureId: id, reason: reason.value });
    }
    case 'pending':
      return ok({ kind: 'pending', captureId: id });
    default:
      return fail('kind must be one of tracked, new, which-surface, fix-preview, filed, not-filed, pending');
  }
}

export function validateTicketStatus(input: unknown): Validation<TicketStatus> {
  if (!isRec(input)) return fail('status must be an object');
  const issueKey = reqStr(input, 'issueKey', '');
  if (!issueKey.ok) return issueKey;
  const summary = reqStr(input, 'summary', '');
  if (!summary.ok) return summary;
  const status = reqStr(input, 'status', '');
  if (!status.ok) return status;
  const assignee = optStr(input, 'assignee', '');
  if (!assignee.ok) return assignee;
  const url = reqStr(input, 'url', '');
  if (!url.ok) return url;
  let pullRequest: TicketStatus['pullRequest'];
  const pr = input['pullRequest'];
  if (pr !== undefined) {
    if (!isRec(pr)) return fail('pullRequest must be an object');
    const purl = reqStr(pr, 'url', 'pullRequest.');
    if (!purl.ok) return purl;
    const state = reqStr(pr, 'state', 'pullRequest.');
    if (!state.ok) return state;
    pullRequest = { url: purl.value, state: state.value };
  }
  return ok({
    issueKey: issueKey.value,
    summary: summary.value,
    status: status.value,
    ...(assignee.value === undefined ? {} : { assignee: assignee.value }),
    url: url.value,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  });
}

export function validateStopResult(input: unknown): Validation<StopResult> {
  if (!isRec(input)) return fail('stop result must be an object');
  const issueKey = reqStr(input, 'issueKey', '');
  if (!issueKey.ok) return issueKey;
  const stopped = input['stopped'];
  if (typeof stopped !== 'boolean') return fail('stopped must be a boolean');
  return ok({ issueKey: issueKey.value, stopped });
}

export function validateHealthResult(input: unknown): Validation<HealthResult> {
  if (!isRec(input)) return fail('health must be an object');
  const flag = input['ok'];
  if (typeof flag !== 'boolean') return fail('ok must be a boolean');
  const raw = input['platforms'];
  if (raw === undefined) return ok({ ok: flag });
  if (!Array.isArray(raw)) return fail('platforms must be an array');
  const platforms: PlatformHealth[] = [];
  for (const [i, item] of (raw as readonly unknown[]).entries()) {
    const at = `platforms[${i}].`;
    if (!isRec(item)) return fail(`platforms[${i}] must be an object`);
    const id = reqStr(item, 'id', at);
    if (!id.ok) return id;
    const up = item['ok'];
    if (typeof up !== 'boolean') return fail(`${at}ok must be a boolean`);
    const detail = optStr(item, 'detail', at);
    if (!detail.ok) return detail;
    const mode = item['mode'];
    platforms.push({
      id: id.value,
      ok: up,
      ...(mode === 'full' || mode === 'reduced' ? { mode } : {}),
      ...(detail.value === undefined ? {} : { detail: detail.value }),
    });
  }
  return ok({ ok: flag, platforms });
}

const SECTION_IDS: readonly string[] = ['assigned', 'fixing', 'waiting', 'recent', 'reports'];

function text(r: Rec, key: string, at: string): Validation<string> {
  const v = r[key];
  return typeof v === 'string' ? ok(v) : fail(`${at}${key} must be a string`);
}

function validateQueueItem(input: unknown, at: string): Validation<QueueItem> {
  if (!isRec(input)) return fail(`${at.replace(/\.$/, '')} must be an object`);
  const incidentId = reqStr(input, 'incidentId', at);
  if (!incidentId.ok) return incidentId;
  const label = reqStr(input, 'label', at);
  if (!label.ok) return label;
  const summary = text(input, 'summary', at);
  if (!summary.ok) return summary;
  const priority = optStr(input, 'priority', at);
  if (!priority.ok) return priority;
  const detail = text(input, 'detail', at);
  if (!detail.ok) return detail;
  const raw = input['buttons'];
  if (!Array.isArray(raw)) return fail(`${at}buttons must be an array`);
  const buttons: QueueButton[] = [];
  for (const [i, b] of (raw as readonly unknown[]).entries()) {
    const bat = `${at}buttons[${i}].`;
    if (!isRec(b)) return fail(`${at}buttons[${i}] must be an object`);
    if (b['kind'] === 'stop' || b['kind'] === 'merge') buttons.push({ kind: b['kind'] });
    else if (b['kind'] === 'open_pr') {
      const url = reqStr(b, 'url', bat);
      if (!url.ok) return url;
      buttons.push({ kind: 'open_pr', url: url.value });
    } else return fail(`${bat}kind must be one of open_pr, stop, merge`);
  }
  return ok({
    incidentId: incidentId.value,
    label: label.value,
    summary: summary.value,
    ...(priority.value === undefined ? {} : { priority: priority.value }),
    detail: detail.value,
    buttons,
  });
}

export function validateQueueView(input: unknown): Validation<QueueView> {
  if (!isRec(input)) return fail('queue must be an object');
  const kind = input['kind'];
  if (kind !== 'engineer' && kind !== 'reporter') return fail('kind must be engineer or reporter');
  const title = reqStr(input, 'title', '');
  if (!title.ok) return title;
  const raw = input['sections'];
  if (!Array.isArray(raw)) return fail('sections must be an array');
  const sections: QueueSection[] = [];
  for (const [i, s] of (raw as readonly unknown[]).entries()) {
    const at = `sections[${i}].`;
    if (!isRec(s)) return fail(`sections[${i}] must be an object`);
    const id = s['id'];
    if (typeof id !== 'string' || !SECTION_IDS.includes(id)) return fail(`${at}id must be one of ${SECTION_IDS.join(', ')}`);
    const sTitle = reqStr(s, 'title', at);
    if (!sTitle.ok) return sTitle;
    const empty = text(s, 'empty', at);
    if (!empty.ok) return empty;
    const rawItems = s['items'];
    if (!Array.isArray(rawItems)) return fail(`${at}items must be an array`);
    const items: QueueItem[] = [];
    for (const [j, it] of (rawItems as readonly unknown[]).entries()) {
      const parsed = validateQueueItem(it, `${at}items[${j}].`);
      if (!parsed.ok) return parsed;
      items.push(parsed.value);
    }
    sections.push({ id: id as QueueSectionId, title: sTitle.value, empty: empty.value, items });
  }
  return ok({ kind, title: title.value, sections });
}
