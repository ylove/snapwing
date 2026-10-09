// The capture API (main 15.3, 15.4, 16; ADR 0007, ADR 0022): the HTTP routes Raycast and the CLI call
// through capture-client, at the paths `CAPTURE_ROUTES` names so client and server cannot drift.
//
//   POST /capture                  send text or an image; answers with the lookup once the engine posts
//                                  its first card or files, waiting at most `waitMs`, else `pending`
//   GET  /capture/:id              the capture's lookup now (poll after `pending`)
//   POST /capture/:id/answer       `{ choiceId }` on the card shown, as `engine.handleTap`; answers with
//                                  the next lookup, waiting the same way. Only a choice the card offers
//                                  this caller counts (a reporter is never offered Fix it)
//   GET  /issues/:key/status       the ticket's status loopback (`TicketStatus`)
//   GET  /queue                   the caller's queue (`QueueView`), the sections Slack Home and the Teams
//                                  card show; a reporter gets "Your reports" only
//   POST /issues/:key/stop         Stop, engineers only (`authorizeStopCommand`): 403 for anyone else
//
// A key names the incident whose ticket it is, never a report linked to that ticket later.
//
// Every one of them needs `Authorization: Bearer <token>`. The token is verified with
// `verifyCaptureToken` (unknown, revoked, or malformed is null) and its person must be a handle in the
// current workspace map, whose role is the caller's; anything else is a bare 401, so a caller learns
// nothing about why. Only the people who sent a capture may read or answer it; for anyone else it does
// not exist (404). `GET /healthz` stays unauthenticated on the ops routes.
//
// Abuse limits, after the token is accepted: each token gets a fixed window of sends and a fixed window
// of answers (429 with `Retry-After`, in whole seconds), and an image over `CAPTURE_IMAGE_MAX_BYTES`
// decoded is a 413 before the engine, the vision pass, or kv sees it. Polling and status reads are not
// limited: they only read, and a client polls on a timer while a capture settles. `GET /queue` has its
// own, looser window, as it can reach GitHub for pull request state. `POST /capture` also has its own
// body limit and refuses an image whose first bytes are not its declared type (400).

import { CAPTURE_ROUTES, validateAnswerRequest, validateCaptureRequest, type LookupResponse } from '@snapwing/capture-client/wire.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { IncidentOrchestrator } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import { isTerminalStatus, OWNS_ITS_KEY, type LifecycleStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { ChatUserRef } from '@snapwing/pipeline/merge/human.ts';
import { authorizeStopCommand } from '@snapwing/pipeline/policy/authorize.ts';
import type { Route } from '../../server/http.ts';
import type { QueueModel } from '../../status/queue.ts';
import { CAPTURE_IMAGE_TYPES, isCaptureAck, readCaptureRecord, type CaptureInbound } from './adapter.ts';
import { lookupCapture, tapChoice, ticketStatus, type LookupDeps } from './lookup.ts';

export interface CaptureRoutesOptions {
  readonly state: StatePort;
  readonly cache: CachePort;
  /** The install's workspace: a token issued for another one is refused. */
  readonly workspaceId: string;
  readonly map: () => Promise<WorkspaceMap>;
  readonly engine: Pick<IncidentOrchestrator, 'handleInbound' | 'handleTap'>;
  /** `stopIncident` over the fixer deps. */
  readonly stop: (input: StopInput) => Promise<StopOutcome>;
  /** The shared queue model (`createQueue`), the one Slack Home and the Teams card render. */
  readonly queue: QueueModel['queueFor'];
  /** The Jira issue's browse URL. */
  readonly issueUrl: (issueKey: string) => string;
  /** The longest a send or an answer waits for the engine's next card or the filing. Default 8 s. */
  readonly waitMs?: number;
  /** How often it looks while waiting. Default 100 ms. */
  readonly pollMs?: number;
}

export const CAPTURE_WAIT_MS = 8_000;
const POLL_MS = 100;
/** The largest image a capture accepts, decoded. Well under the model's own image limit. */
export const CAPTURE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The largest `POST /capture` body, bytes: a 5 MiB image is about 6.7 MiB of base64, plus the JSON
 * around it. Tighter than the server-wide limit, which the other routes keep.
 */
export const CAPTURE_BODY_MAX_BYTES = 7 * 1024 * 1024;
/** `GET /queue` calls per token per window: each one can look up pull requests on GitHub. */
export const CAPTURE_QUEUE_PER_WINDOW = 30;
/** The rate-limit window. */
export const CAPTURE_RATE_WINDOW_MS = 60_000;
/**
 * Captures one token may send per window. A person files a few reports a minute at the very most, and
 * each send can start a vision pass and a model triage, so 20 is far above honest use and low enough
 * that a leaked token or a looping script cannot run up the model bill.
 */
export const CAPTURE_SENDS_PER_WINDOW = 20;
/** Answers per token per window: three times the sends, as one capture can take several taps (surface, then file). */
export const CAPTURE_ANSWERS_PER_WINDOW = 60;
/** Statuses where a fixer run or its PR is active (the Stop button's `fixerActive`). */
const FIXER_ACTIVE: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['fixing', 'fixing-retry', 'in-review', 'in-review-retry', 'ci', 'ci-retry', 'mergeable', 'held']);

/** A route path with `:name` for each parameter of a `CAPTURE_ROUTES` builder. */
function pattern(build: (value: string) => string, name: string): string {
  return build('__param__').replace('__param__', `:${name}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** No detail: a caller cannot tell an unknown token from a revoked one or a person the map dropped. */
function unauthorized(): Response {
  return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
}

/** The decoded size of a base64 string (padding and line breaks aside), without decoding it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** The image type the first bytes show, among the types a capture accepts, else undefined. */
export function sniffCaptureImage(data: Uint8Array): string | undefined {
  const starts = (...bytes: number[]): boolean => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (data.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/** A fixed-window counter per key. In memory, so per process: with several replicas each one allows its own. */
class RateLimiter {
  private readonly windows = new Map<string, { resetAt: number; count: number }>();
  constructor(private readonly limit: number) {}

  /** Counts one call for `key`; the seconds to wait when it is over the limit, else undefined. */
  hit(key: string, now: number): number | undefined {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    const window = this.windows.get(key) ?? { resetAt: now + CAPTURE_RATE_WINDOW_MS, count: 0 };
    this.windows.set(key, window);
    window.count += 1;
    return window.count > this.limit ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : undefined;
  }
}

function tooManyRequests(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ error: `too many requests, try again in ${retryAfterSec} seconds` }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfterSec) },
  });
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

export function createCaptureRoutes(options: CaptureRoutesOptions): Route[] {
  const { state, cache, engine } = options;
  const waitMs = options.waitMs ?? CAPTURE_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const lookupDeps: LookupDeps = { state, cache, map: options.map, issueUrl: options.issueUrl };

  const sends = new RateLimiter(CAPTURE_SENDS_PER_WINDOW);
  const answers = new RateLimiter(CAPTURE_ANSWERS_PER_WINDOW);
  const queues = new RateLimiter(CAPTURE_QUEUE_PER_WINDOW);

  /** The token's map person, or undefined (401). `limiter` counts the call against the token's window. */
  async function identify(req: Request, limiter?: RateLimiter): Promise<MapPerson | Response | undefined> {
    const token = BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
    if (token === undefined) return undefined;
    const verified = await state.verifyCaptureToken(token);
    if (verified === null || verified.workspaceId !== options.workspaceId) return undefined;
    // Exactly: the map keeps handles unique case-sensitively, so a case-folded match could name another person.
    const person = (await options.map()).people.find((p) => p.handle === verified.person);
    if (person === undefined) return undefined;
    const wait = limiter?.hit(verified.tokenId, Date.now());
    return wait === undefined ? person : tooManyRequests(wait);
  }

  /** The chat identity the queue model knows `person` by: their Slack id, else their Teams id. */
  function viewerOf(person: MapPerson): ChatUserRef {
    if (person.slackId !== undefined) return { chat: 'slack', userId: person.slackId };
    if (person.teamsId !== undefined) return { chat: 'teams', userId: person.teamsId };
    return { chat: 'slack', userId: person.handle };
  }

  async function caller(req: Request): Promise<MapPerson | undefined> {
    const found = await identify(req);
    return found instanceof Response ? undefined : found;
  }

  /** The capture's lookup, as `person` sees it, once it is not pending, or `pending` after `waitMs`. */
  async function settle(captureId: string, person: MapPerson): Promise<LookupResponse> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { response } = await lookupCapture(lookupDeps, captureId, person.role);
      if (response.kind !== 'pending' || Date.now() >= deadline) return response;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
  }

  /** Whether `person` sent the capture (and so may read and answer it). */
  async function owns(captureId: string, person: MapPerson): Promise<boolean> {
    const record = await readCaptureRecord(cache, captureId);
    return record?.people.some((p) => p === person.handle) === true;
  }

  function parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  async function body(req: Request): Promise<unknown> {
    return parseJson(await req.text());
  }

  /** The incident that owns the Jira key: never a report linked to it, which may be newer. */
  async function incidentByKey(key: string) {
    const [incident] = await state.findIncidents({ workspaceId: options.workspaceId, jiraKey: key.trim().toUpperCase(), status: OWNS_ITS_KEY, limit: 1 });
    return incident?.jiraKey === undefined ? undefined : { ...incident, jiraKey: incident.jiraKey };
  }

  return [
    {
      method: 'POST',
      path: CAPTURE_ROUTES.send,
      async handler(req) {
        const person = await identify(req, sends);
        if (person === undefined) return unauthorized();
        if (person instanceof Response) return person;
        const raw = await req.text();
        if (Buffer.byteLength(raw) > CAPTURE_BODY_MAX_BYTES) {
          return json(413, { error: `that request is too large (limit ${CAPTURE_BODY_MAX_BYTES / (1024 * 1024)} MB)` });
        }
        const parsed = validateCaptureRequest(parseJson(raw));
        if (!parsed.ok) return json(400, { error: parsed.error });
        const request = parsed.value;
        if ('image' in request && !(CAPTURE_IMAGE_TYPES as readonly string[]).includes(request.mimeType)) {
          return json(400, { error: `mimeType must be one of ${CAPTURE_IMAGE_TYPES.join(', ')}` });
        }
        // Before the engine, so before the vision pass and before any kv write.
        if ('image' in request && decodedBytes(request.image) > CAPTURE_IMAGE_MAX_BYTES) {
          return json(413, { error: `that image is too large (limit ${CAPTURE_IMAGE_MAX_BYTES / (1024 * 1024)} MB)` });
        }
        // The bytes must be the declared type: a mislabelled file never reaches the vision pass.
        if ('image' in request && sniffCaptureImage(Buffer.from(request.image.slice(0, 32), 'base64')) !== request.mimeType) {
          return json(400, { error: 'the image does not match its mimeType' });
        }
        const inbound: CaptureInbound = { request, person };
        const ack = await engine.handleInbound(request.source, inbound);
        if (!isCaptureAck(ack)) throw new Error('capture: the adapter acknowledged without a capture id');
        return json(200, await settle(ack.captureId, person));
      },
    },
    {
      method: 'GET',
      path: pattern(CAPTURE_ROUTES.poll, 'id'),
      async handler(req, { params }) {
        const person = await caller(req);
        if (person === undefined) return unauthorized();
        const id = params['id'] ?? '';
        if (!(await owns(id, person))) return json(404, { error: 'unknown capture' });
        return json(200, (await lookupCapture(lookupDeps, id, person.role)).response);
      },
    },
    {
      method: 'POST',
      path: pattern(CAPTURE_ROUTES.answer, 'id'),
      async handler(req, { params }) {
        const person = await identify(req, answers);
        if (person === undefined) return unauthorized();
        if (person instanceof Response) return person;
        const id = params['id'] ?? '';
        if (!(await owns(id, person))) return json(404, { error: 'unknown capture' });
        const parsed = validateAnswerRequest(await body(req));
        if (!parsed.ok) return json(400, { error: parsed.error });
        const current = await lookupCapture(lookupDeps, id, person.role);
        // Nothing is asked right now (answered already, still working, or ended): say where it is.
        if (current.card === undefined) return json(200, current.response);
        // Only a choice offered to this caller: a reporter's Fix it is not one.
        const choice = tapChoice(current.card.card, parsed.value.choiceId, await options.map(), person.role);
        if (choice === undefined) return json(400, { error: `${parsed.value.choiceId} is not a choice here` });
        const outcome = await engine.handleTap({ eventId: id, card: current.card.kind, choice, actor: { id: person.handle, role: person.role } });
        if (!outcome.accepted && outcome.reason === 'invalid-choice') return json(400, { error: `${parsed.value.choiceId} is not a choice here` });
        return json(200, await settle(id, person));
      },
    },
    {
      method: 'GET',
      path: pattern(CAPTURE_ROUTES.status, 'key'),
      async handler(req, { params }) {
        const person = await caller(req);
        if (person === undefined) return unauthorized();
        const incident = await incidentByKey(params['key'] ?? '');
        if (incident === undefined) return json(404, { error: 'no ticket with that key' });
        return json(200, ticketStatus(incident, await options.map(), options.issueUrl));
      },
    },
    {
      method: 'GET',
      path: CAPTURE_ROUTES.queue,
      async handler(req) {
        const person = await identify(req, queues);
        if (person === undefined) return unauthorized();
        if (person instanceof Response) return person;
        return json(200, await options.queue(viewerOf(person)));
      },
    },
    {
      method: 'POST',
      path: pattern(CAPTURE_ROUTES.stop, 'key'),
      async handler(req, { params }) {
        const person = await caller(req);
        if (person === undefined) return unauthorized();
        const actor = { kind: 'human' as const, role: person.role, githubLinked: false };
        // The role alone first (the most a level allows), so a reporter learns nothing about which keys exist.
        const role = authorizeStopCommand(actor, { level: 3, fixerActive: true });
        if (!role.allowed) return json(403, { error: role.reason });
        const incident = await incidentByKey(params['key'] ?? '');
        if (incident === undefined) return json(404, { error: 'no ticket with that key' });
        const nothing = { issueKey: incident.jiraKey, stopped: false };
        if (isTerminalStatus(incident.status)) return json(200, nothing);
        const decision = authorizeStopCommand(actor, { level: incident.autonomyLevel ?? 0, fixerActive: FIXER_ACTIVE.has(incident.status) });
        if (!decision.allowed) return decision.reason === 'nothing-to-stop' ? json(200, nothing) : json(403, { error: decision.reason });
        const outcome = await options.stop({ incidentId: incident.id, actor: { id: person.handle, role: person.role }, source: 'cli' });
        return json(200, { issueKey: incident.jiraKey, stopped: outcome.stopped });
      },
    },
  ];
}
