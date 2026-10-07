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
//   POST /issues/:key/stop         Stop, engineers only (`authorizeStopCommand`): 403 for anyone else
//
// A key names the incident whose ticket it is, never a report linked to that ticket later.
//
// Every one of them needs `Authorization: Bearer <token>`. The token is verified with
// `verifyCaptureToken` (unknown, revoked, or malformed is null) and its person must be a handle in the
// current workspace map, whose role is the caller's; anything else is a bare 401, so a caller learns
// nothing about why. Only the people who sent a capture may read or answer it; for anyone else it does
// not exist (404). `GET /healthz` stays unauthenticated on the ops routes.

import { CAPTURE_ROUTES, validateAnswerRequest, validateCaptureRequest, type LookupResponse } from '@snapwing/capture-client/wire.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { IncidentOrchestrator } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import { isTerminalStatus, OWNS_ITS_KEY, type LifecycleStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { authorizeStopCommand } from '@snapwing/pipeline/policy/authorize.ts';
import type { Route } from '../../server/http.ts';
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
  /** The Jira issue's browse URL. */
  readonly issueUrl: (issueKey: string) => string;
  /** The longest a send or an answer waits for the engine's next card or the filing. Default 8 s. */
  readonly waitMs?: number;
  /** How often it looks while waiting. Default 100 ms. */
  readonly pollMs?: number;
}

export const CAPTURE_WAIT_MS = 8_000;
const POLL_MS = 100;
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

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

export function createCaptureRoutes(options: CaptureRoutesOptions): Route[] {
  const { state, cache, engine } = options;
  const waitMs = options.waitMs ?? CAPTURE_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const lookupDeps: LookupDeps = { state, cache, map: options.map, issueUrl: options.issueUrl };

  /** The token's map person, or undefined (401). */
  async function caller(req: Request): Promise<MapPerson | undefined> {
    const token = BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
    if (token === undefined) return undefined;
    const verified = await state.verifyCaptureToken(token);
    if (verified === null || verified.workspaceId !== options.workspaceId) return undefined;
    const handle = verified.person.toLowerCase();
    return (await options.map()).people.find((p) => p.handle.toLowerCase() === handle);
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
    return record?.people.some((p) => p.toLowerCase() === person.handle.toLowerCase()) === true;
  }

  async function body(req: Request): Promise<unknown> {
    try {
      return JSON.parse(await req.text()) as unknown;
    } catch {
      return undefined;
    }
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
        const person = await caller(req);
        if (person === undefined) return unauthorized();
        const parsed = validateCaptureRequest(await body(req));
        if (!parsed.ok) return json(400, { error: parsed.error });
        const request = parsed.value;
        if ('image' in request && !(CAPTURE_IMAGE_TYPES as readonly string[]).includes(request.mimeType)) {
          return json(400, { error: `mimeType must be one of ${CAPTURE_IMAGE_TYPES.join(', ')}` });
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
        const person = await caller(req);
        if (person === undefined) return unauthorized();
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
