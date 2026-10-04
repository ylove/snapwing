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
  const surface = optStr(input, 'surface', '');
  if (!surface.ok) return surface;

  let context: CaptureContext | undefined;
  const rawContext = input['context'];
  if (rawContext !== undefined) {
    if (!isRec(rawContext)) return fail('context must be an object');
    const url = optStr(rawContext, 'url', 'context.');
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
      return fail('kind must be one of tracked, new, which-surface, filed, not-filed, pending');
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
