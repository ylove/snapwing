// The capture API on the composed app (#385; main 15.3, 15.4, 16; ADR 0007, ADR 0022), driven the way
// Raycast and the CLI drive it: through capture-client against the real `compose`, worker, projectors,
// and routes (fixtures/e2e/world.ts), with MSW standing in for Slack, Jira, and GitHub (the git trees
// API included) and a scripted model. Tokens are real ones from `issueCaptureToken`.
//
// - Abuse limits: a token over its window is a 429 with Retry-After; an image over 5 MB decoded is a 413
//   before the vision pass or any kv write; the same words from another person are a capture of their own.
// - Already tracked: a report that matches an open issue links at once and answers `not-filed`.
// - New, then filed: a file path in a stack trace resolves against the repo trees (`new` with the
//   evidence); File it files through the Jira projector (`filed`).
// - Which surface, then filed: nothing names a surface; the answer picks one by its id.
// - A surface hint skips inference; Cancel files nothing.
// - A screenshot goes through the vision pass and lands on the Jira issue as an attachment; its kv
//   row is deleted then, or when its capture ends without a ticket.
// - A revoked, unknown, or unmapped token is a bare 401; a reporter's Stop is 403.
// - A key names the ticket that owns it, never a report linked to it later: Stop stops that ticket.
// - A level 1 surface asks Fix it or Ticket only before filing: an engineer's Fix it starts the fixer,
//   Ticket only files alone, and a reporter is offered (and may send) Ticket only.
//
// No keys and no network. Runs on the dialect `SNAPWING_DB` selects (pg-boss on Postgres).

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCaptureClient, type CaptureClient } from '@snapwing/capture-client/client.ts';
import { CaptureAuthError, CaptureServerError } from '@snapwing/capture-client/errors.ts';
import { formatRendered, renderChoices } from '@snapwing/capture-client/render.ts';
import { CAPTURE_ROUTES } from '@snapwing/capture-client/wire.ts';
import type { ImageReading } from '@snapwing/pipeline/contracts/incident.ts';
import { DEMO_GITHUB_TOKEN, GITHUB_API, GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionRequest, VisionResult } from '@snapwing/pipeline/ports/model.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { CAPTURE_ANSWERS_PER_WINDOW, CAPTURE_IMAGE_MAX_BYTES, CAPTURE_SENDS_PER_WINDOW } from '../../src/adapters/capture/routes.ts';
import { createApiServer, type ApiServer } from '../../src/server/http.ts';
import { opsRoutes } from '../../src/server/ops.ts';
import { JiraWebhooks } from '../fixtures/e2e/jira.ts';
import { bootComposed, DEMO_MAP, EXAMPLE_CONFIG, fakeSecrets, slackWorld, type Booted } from '../fixtures/e2e/world.ts';

const ENDPOINT = 'http://snapwing.test';
const TEST_TIMEOUT = 60_000;
/** The help surface's repository tree (level 0 in the demo map, so filing never starts a fixer). */
const HELP_TREE = ['src/refunds/policy.ts', 'content/articles/refund-policy.md'];
const TRACE = 'TypeError: Cannot read properties of undefined (reading "days")\n    at policyDays (/usr/src/app/src/refunds/policy.ts:12:9)';
/** Names nothing the map knows: resolve falls to the model, which answers unknown. */
const VAGUE = 'the total is blank after applying a promo code';
/** "the portal" is the demo map's vocabulary for the admin surface. */
const TRACKED_TEXT = 'The portal export button does nothing';
/** Eight bytes of PNG signature: the model is scripted, so the bytes only need to round trip. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the harness was not expected to run')) };

const TRIAGE = {
  action: 'create_issue',
  issueType: 'Bug',
  summary: 'Refund policy shows the wrong number of days',
  description: 'The refund policy reads 14 days; the policy is 30.',
  priority: 'Medium',
  labels: ['content'],
};
const READING: ImageReading = {
  surfaceSignals: { pageTitle: 'Help Center - Refund policy', chrome: 'web' },
  uiElements: ['Refund policy'],
  plainDescription: 'The refund policy page says 14 days',
  environmentHint: 'production',
  sensitive: false,
};

/** Answers per `task:schema`; vision reads every image as `READING` and records what it saw. */
class ScriptedModel implements ModelBackend {
  readonly calls: string[] = [];
  readonly images: string[] = [];
  complete(): Promise<CompletionResult> {
    return Promise.reject(new Error('complete is not scripted'));
  }
  vision(request: VisionRequest): Promise<VisionResult> {
    this.calls.push('vision');
    this.images.push(...request.images.map((i) => `${i.mimeType}:${i.data}`));
    return Promise.resolve({ readings: request.images.map(() => READING), model: 'scripted/test' });
  }
  classify(request: ClassifyRequest<unknown>): Promise<RawClassifyResult> {
    const key = `${request.task}:${request.schemaName}`;
    this.calls.push(key);
    const answers: Record<string, unknown> = {
      'triage:resolution': { surfaceId: 'unknown', confidence: 0 },
      'triage:triage-plan': TRIAGE,
      'scout:scout-diagnosis': { confidence: 'low', files: [] },
    };
    if (!(key in answers)) return Promise.reject(new Error(`classify ${key} is not scripted`));
    return Promise.resolve({ value: answers[key], model: 'scripted/test' });
  }
}

// World ------------------------------------------------------------------------------------------

const server = setupServer();
const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:unhandled', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });
});
afterAll(() => server.close());

let tdb: TestDatabase;
let dir: string;
let booted: Booted | undefined;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-capture-'));
  unhandled.length = 0;
});

afterEach(async () => {
  await booted?.stop();
  booted = undefined;
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

interface World {
  booted: Booted;
  /** The ops routes plus compose's, as `snapwing serve` mounts them. */
  api: ApiServer;
  jira: JiraWorld;
  /** Jira's transitions, and the webhooks for them, which a test sends (`deliverJira`). */
  jiraHooks: JiraWebhooks;
  model: ScriptedModel;
  /** Files the Jira fake received as attachments, by issue key. */
  attachments: { issueKey: string; filename: string; bytes: string }[];
  /** A capture client acting as `handle` with a freshly issued token. */
  clientFor(handle: string): Promise<CaptureClient>;
  workspaceId: string;
}

/** The GitHub App token, and the help repository's tree through the git trees API (other repos are 404). */
function gitTrees(): ReturnType<typeof http.get>[] {
  const known = (owner: unknown, repo: unknown): boolean => owner === 'acme' && repo === 'help';
  return [
    http.post(`${GITHUB_API}/app/installations/:id/access_tokens`, () =>
      HttpResponse.json({ token: DEMO_GITHUB_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 }),
    ),
    http.get(`${GITHUB_API}/repos/:owner/:repo`, ({ params }) =>
      known(params['owner'], params['repo']) ? HttpResponse.json({ default_branch: 'main' }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.get(`${GITHUB_API}/repos/:owner/:repo/branches/:branch`, ({ params }) =>
      known(params['owner'], params['repo']) ? HttpResponse.json({ name: 'main', commit: { sha: 'c0ffee', commit: { tree: { sha: 'help-tree' } } } }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.get(`${GITHUB_API}/repos/:owner/:repo/git/trees/:sha`, ({ params }) =>
      known(params['owner'], params['repo'])
        ? HttpResponse.json({ sha: 'help-tree', truncated: false, tree: HELP_TREE.map((path) => ({ path, type: 'blob' })) })
        : HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
  ];
}

async function world(): Promise<World> {
  slackWorld(server, 'C0HELPBUGS', []);
  const jira = new JiraWorld(() => undefined);
  jira.seed([{ key: 'ADM-7', summary: TRACKED_TEXT, assignee: 'Ari' }]);
  const jiraHooks = new JiraWebhooks(jira);
  const github = new GitHubWorld(() => undefined);
  github.addRepos({ 'acme/help': { 'src/refunds/policy.ts': 'export const days = 14;\n' } });
  const attachments: World['attachments'] = [];
  server.use(
    // The projector finds an issue an earlier attempt created by its label; the demo search ignores labels.
    http.post(`${JIRA_BASE}/rest/api/3/search/jql`, async ({ request }) => {
      const jql = String(((await request.clone().json()) as { jql?: unknown }).jql ?? '');
      const label = /labels\s*=\s*"([^"]+)"/.exec(jql)?.[1];
      if (label === undefined) return undefined;
      const issues = [...jira.issues.values()].filter((i) => i.labels.includes(label)).map((i) => ({ key: i.key, fields: { summary: i.summary, attachment: [] } }));
      return HttpResponse.json({ issues, isLast: true });
    }),
    http.post(`${JIRA_BASE}/rest/api/3/issue/:key/attachments`, async ({ request, params }) => {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof Blob)) return HttpResponse.json({ errorMessages: ['no file'] }, { status: 400 });
      const filename = file instanceof File ? file.name : 'file';
      attachments.push({ issueKey: String(params['key']), filename, bytes: Buffer.from(await file.arrayBuffer()).toString('base64') });
      return HttpResponse.json([{ id: String(attachments.length), filename }]);
    }),
    ...jiraHooks.handlers(),
    ...jiraHandlers(jira),
    ...gitTrees(),
    ...githubHandlers(github),
  );

  // Generated per run, never committed: the App JWT is signed for real.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const secrets = { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };
  const model = new ScriptedModel();
  const state = await tdb.open();
  booted = await bootComposed({
    state,
    configXml: await readFile(EXAMPLE_CONFIG, 'utf8'),
    secrets,
    dir,
    // Absent files: no playbook (the defaults) and no instructions, whatever the working directory holds.
    env: { SNAPWING_MAP: DEMO_MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work'), SNAPWING_PLAYBOOK: join(dir, 'playbook.xml'), SNAPWING_INSTRUCTIONS: join(dir, 'INSTRUCTIONS.md') },
    // A fixer that starts clones from a remote that is not there, so it fails at once and offline.
    overrides: { model: withValidation(model), resolveHarness: () => idleHarness, gitRemoteUrl: (repo) => join(dir, 'remotes', `${repo}.git`), projectorPollMs: 25 },
  });
  // What `snapwing serve` mounts: the ops routes (`/healthz` with compose's platforms) and compose's.
  const composed = booted.composed;
  const api = createApiServer({ routes: [...opsRoutes({ state: () => state, health: () => composed.health?.() ?? Promise.resolve([]) }), ...composed.routes], port: 0 });
  const workspaceId = await ensureInstallWorkspace(booted.state);
  return {
    booted,
    api,
    jira,
    jiraHooks,
    model,
    attachments,
    workspaceId,
    async clientFor(handle) {
      const { token } = await state.issueCaptureToken({ workspaceId, person: handle, label: 'contract test' });
      return createCaptureClient({ endpoint: ENDPOINT, token, timeoutMs: 30_000, fetch: (input, init) => api.fetch(new Request(input, init)) });
    },
  };
}

/** Sends the queued Jira webhooks for `issueKey` (its transitions) to the composed route. */
async function deliverJira(w: World, issueKey: string): Promise<void> {
  await expect.poll(() => w.jiraHooks.queued.some((d) => d.issueKey === issueKey), { timeout: 10_000, interval: 25 }).toBe(true);
  const statuses = await w.jiraHooks.deliver(issueKey, (body) =>
    w.api.fetch(new Request(`${ENDPOINT}/webhooks/jira`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })),
  );
  expect(statuses.every((s) => s === 200)).toBe(true);
}

/** The kv row holding a capture's image, read past any expiry: undefined only once it is deleted. */
async function imageRow(w: World, captureId: string): Promise<string | undefined> {
  const rows = await w.booted.state.ctx.db.selectFrom('kv').select('v').where('k', '=', `capture-image:${captureId}`).execute();
  return rows[0]?.v;
}

async function eventTypes(w: World, incidentId: string): Promise<string[]> {
  return (await w.booted.state.read(incidentId)).map((e) => e.type);
}

function settled(w: World): void {
  expect(w.booted.errors).toEqual([]);
  expect(w.booted.logged).toEqual([]);
  expect(unhandled).toEqual([]);
}

// Tests ------------------------------------------------------------------------------------------

describe('the capture API through capture-client', () => {
  it('links at once when an open issue already has the report', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const cli = await w.clientFor('webDev');
    const first = await cli.sendText(TRACKED_TEXT);
    expect(first).toEqual({ kind: 'not-filed', captureId: first.captureId, reason: 'Added this report to ADM-7.' });
    expect(renderChoices(first).lines).toEqual(['Not filed. Added this report to ADM-7.']);
    // Lookup first: nothing filed, no Jira write besides the comment on the ticket it found.
    expect([...w.jira.issues.keys()]).toEqual(['ADM-7']);
    expect(await cli.poll(first.captureId)).toEqual(first);
    expect((await w.booted.state.getIncident(first.captureId))?.status).toBe('linked-to-existing');
    expect(await eventTypes(w, first.captureId)).toEqual(expect.arrayContaining(['dedupe-decided', 'linked-to-existing']));
    // The same text again within the window is the same capture, at the same end.
    expect(await cli.sendText(TRACKED_TEXT)).toEqual(first);
    settled(w);
  });

  it('a capture matching an open ticket ends linked, in no queue, and the ticket gains the reporter as a watcher', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const engineer = await w.clientFor('webDev');
    const filed = await engineer.sendText(VAGUE, { surface: 'web' });
    expect(await engineer.answer(filed.captureId, 'file-it')).toMatchObject({ kind: 'filed', issueKey: 'WEB-1' });
    await expect.poll(async () => { const types = await eventTypes(w, filed.captureId); return types.slice(types.indexOf('filed')); }, { timeout: 10_000, interval: 25 }).toContain('waiting-changed');

    const reporter = await w.clientFor('supportLead');
    const duplicate = await reporter.sendText(TRIAGE.summary, { surface: 'web' });
    expect(duplicate).toEqual({ kind: 'not-filed', captureId: duplicate.captureId, reason: 'Added this report to WEB-1.' });
    const row = await w.booted.state.getIncident(duplicate.captureId);
    expect(row).toMatchObject({ status: 'linked-to-existing', jiraKey: 'WEB-1' });
    expect(await eventTypes(w, duplicate.captureId)).not.toContain('capture-cancelled');
    // Open in no queue: nothing waits on the duplicate.
    expect(await w.booted.state.findIncidents({ status: ['captured', 'assembling', 'resolved', 'deduped', 'planned'], limit: 50 })).toEqual([]);

    const watchers = (await w.booted.state.getSubscriptions(filed.captureId)).map((s) => s.userId);
    expect(watchers).toEqual(['supportLead']);
    const watches = (await w.booted.state.read(filed.captureId)).filter((e) => e.type === 'comment' && e.payload.intent === 'watch');
    expect(watches).toMatchObject([{ actor: { id: 'supportLead' }, source: 'cli' }]);
    settled(w);
  });

  it('a file path in a trace answers new from the repo tree; File it files the ticket', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const cli = await w.clientFor('helpDev');
    const first = await cli.sendText(TRACE);
    expect(first).toEqual({
      kind: 'new',
      captureId: first.captureId,
      surface: { id: 'help', label: 'Help Center' },
      evidence: 'src/refunds/policy.ts',
      choices: [
        { id: 'file-it', label: 'File it' },
        { id: 'not-this-surface', label: 'Not this surface' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    expect(renderChoices(first).lines).toEqual(['New. Looks like Help Center (from src/refunds/policy.ts). File it?']);
    expect([...w.jira.issues.keys()]).toEqual(['ADM-7']);
    expect(await cli.poll(first.captureId)).toEqual(first);

    const filed = await cli.answer(first.captureId, 'file-it');
    expect(filed).toEqual({ kind: 'filed', captureId: first.captureId, issueKey: 'HELP-1', url: `${JIRA_BASE}/browse/HELP-1` });
    expect(w.jira.issues.get('HELP-1')?.summary).toBe(TRIAGE.summary);
    expect(await cli.poll(first.captureId)).toEqual(filed);
    // An answer once nothing is asked says where the capture is.
    expect(await cli.answer(first.captureId, 'file-it')).toEqual(filed);

    expect(await cli.status('help-1')).toEqual({ issueKey: 'HELP-1', summary: TRIAGE.summary, status: 'open', assignee: 'helpDev', url: `${JIRA_BASE}/browse/HELP-1` });
    settled(w);
  });

  it('asks which surface when nothing names one; the answer by surface id files there', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const cli = await w.clientFor('webDev');
    const first = await cli.sendText(VAGUE);
    expect(first).toEqual({
      kind: 'which-surface',
      captureId: first.captureId,
      choices: [
        { id: 'help', label: 'Help Center' },
        { id: 'admin', label: 'B2B Admin Portal' },
        { id: 'web', label: 'Website' },
        { id: 'mobile', label: 'Mobile App' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    // Only the choices offered: free text is refused.
    await expect(cli.answer(first.captureId, 'the checkout page')).rejects.toMatchObject({ status: 400 });
    const filed = await cli.answer(first.captureId, 'help');
    expect(filed).toMatchObject({ kind: 'filed', issueKey: 'HELP-1' });
    expect(w.model.calls).toContain('triage:resolution');
    settled(w);
  });

  it('a surface hint skips inference; Cancel files nothing', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const raycast = await w.clientFor('webDev');
    const first = await raycast.sendText(VAGUE, { source: 'raycast', surface: 'help' });
    expect(first).toMatchObject({ kind: 'new', surface: { id: 'help', label: 'Help Center' } });
    expect(first).not.toHaveProperty('evidence');
    expect(w.model.calls).not.toContain('triage:resolution');
    expect(await raycast.answer(first.captureId, 'cancel')).toEqual({ kind: 'not-filed', captureId: first.captureId, reason: 'Cancelled, so nothing was filed.' });
    expect([...w.jira.issues.keys()]).toEqual(['ADM-7']);
    // Someone who did not send it cannot see or answer it.
    const other = await w.clientFor('helpDev');
    await expect(other.poll(first.captureId)).rejects.toMatchObject({ status: 404 });
    settled(w);
  });

  it('a screenshot goes through the vision pass, is attached to the ticket, and is kept nowhere else', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const cli = await w.clientFor('helpDev');
    const first = await cli.sendImage(PNG, 'image/png');
    expect(w.model.images).toEqual([`image/png:${PNG}`]);
    expect(first).toMatchObject({ kind: 'new', surface: { id: 'help', label: 'Help Center' } });
    expect(await imageRow(w, first.captureId)).toBe(PNG);
    const filed = await cli.answer(first.captureId, 'file-it');
    expect(filed).toMatchObject({ kind: 'filed', issueKey: 'HELP-1' });
    await expect.poll(() => w.attachments, { timeout: 10_000, interval: 25 }).toEqual([{ issueKey: 'HELP-1', filename: 'screenshot.png', bytes: PNG }]);
    // Attached, the screenshot lives on the issue only: its row is gone (not just expired).
    await expect.poll(() => imageRow(w, first.captureId), { timeout: 10_000, interval: 25 }).toBeUndefined();

    // A capture that ends without a ticket drops its screenshot too.
    const raycast = await w.clientFor('helpDev');
    const second = await raycast.sendImage(PNG, 'image/png', { source: 'raycast' });
    expect(second.captureId).not.toBe(first.captureId);
    expect(await imageRow(w, second.captureId)).toBe(PNG);
    expect(await raycast.answer(second.captureId, 'cancel')).toMatchObject({ kind: 'not-filed' });
    await expect.poll(() => imageRow(w, second.captureId), { timeout: 10_000, interval: 25 }).toBeUndefined();
    expect(w.attachments).toHaveLength(1);

    // A type the vision pass cannot read is refused before anything starts.
    await expect(cli.sendImage(PNG, 'image/tiff')).rejects.toMatchObject({ status: 400 });
    settled(w);
  });

  it('refuses a revoked, unknown, or unmapped token with a bare 401', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const state = w.booted.state;
    const issued = await state.issueCaptureToken({ workspaceId: w.workspaceId, person: 'webDev' });
    const send = (token: string | undefined): Promise<Response> =>
      w.api.fetch(
        new Request(`${ENDPOINT}${CAPTURE_ROUTES.send}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
          body: JSON.stringify({ source: 'cli', text: VAGUE }),
        }),
      );
    expect(await state.revokeCaptureToken(issued.id)).toBe(true);
    const ghost = await state.issueCaptureToken({ workspaceId: w.workspaceId, person: 'ghost' });
    for (const token of [issued.token, 'swc_test', ghost.token, undefined]) {
      const res = await send(token);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
    }
    const revoked = createCaptureClient({ endpoint: ENDPOINT, token: issued.token, fetch: (input, init) => w.api.fetch(new Request(input, init)) });
    await expect(revoked.sendText(VAGUE)).rejects.toBeInstanceOf(CaptureAuthError);
    await expect(revoked.status('HELP-1')).rejects.toMatchObject({ status: 401 });
    // Nothing reached the engine.
    expect(await state.findIncidents({ workspaceId: w.workspaceId })).toEqual([]);
    // Health needs no token and names the chat platforms.
    expect(await revoked.health()).toEqual({ ok: true, platforms: [{ id: 'slack', ok: true, mode: 'full' }] });
    settled(w);
  });

  it("refuses a reporter's stop; an engineer's stop on a level 0 ticket has nothing to stop", { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const engineer = await w.clientFor('helpDev');
    const first = await engineer.sendText(TRACE);
    expect(await engineer.answer(first.captureId, 'file-it')).toMatchObject({ kind: 'filed', issueKey: 'HELP-1' });

    const reporter = await w.clientFor('salesLead');
    const refused = await reporter.stop('HELP-1').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CaptureAuthError);
    expect(refused).toMatchObject({ status: 403 });
    await expect(reporter.stop('NOPE-1')).rejects.toMatchObject({ status: 403 });
    // A reporter may still read the status loopback.
    expect(await reporter.status('HELP-1')).toMatchObject({ issueKey: 'HELP-1', status: 'open' });

    expect(await engineer.stop('HELP-1')).toEqual({ issueKey: 'HELP-1', stopped: false });
    await expect(engineer.stop('NOPE-1')).rejects.toMatchObject({ status: 404 });
    const log = await w.booted.state.read((await w.booted.state.findIncidents({ jiraKey: 'HELP-1' }))[0]?.id ?? '');
    expect(log.some((e) => e.type === 'stopped')).toBe(false);
    settled(w);
  });

  it('stops the ticket a key names, not a report linked to it later', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const engineer = await w.clientFor('webDev');
    const first = await engineer.sendText(VAGUE, { surface: 'web' });
    expect(first).toMatchObject({ kind: 'new', surface: { id: 'web', label: 'Website' } });
    expect(await engineer.answer(first.captureId, 'file-it')).toMatchObject({ kind: 'filed', issueKey: 'WEB-1' });

    // Filing is followed by background writes to WEB-1's row (the wait moves to its owner). Let them land first, so the link below is the last write and the duplicate is the newest row.
    await expect.poll(async () => { const types = await eventTypes(w, first.captureId); return types.slice(types.indexOf('filed')); }, { timeout: 10_000, interval: 25 }).toContain('waiting-changed');
    // A later report of the same problem, linked to WEB-1: its row carries WEB-1 too.
    const reporter = await w.clientFor('supportLead');
    const duplicate = await reporter.sendText(TRIAGE.summary, { surface: 'web' });
    expect(duplicate).toEqual({ kind: 'not-filed', captureId: duplicate.captureId, reason: 'Added this report to WEB-1.' });
    // The watcher write can land in the same millisecond as the link, so make the duplicate the newest WEB-1 row explicitly (test only): the lookup must then pick the owner by status, not by recency.
    const { ctx } = w.booted.state;
    await ctx.db.updateTable('incidents').set({ updated_at: ctx.codec.timestamp(new Date(Date.now() + 60_000)) }).where('id', '=', duplicate.captureId).execute();
    expect((await w.booted.state.findIncidents({ jiraKey: 'WEB-1', limit: 1 }))[0]?.id).toBe(duplicate.captureId);

    expect(await engineer.status('WEB-1')).toMatchObject({ issueKey: 'WEB-1', status: 'open' });
    expect(await engineer.stop('WEB-1')).toEqual({ issueKey: 'WEB-1', stopped: true });
    const stops = (await w.booted.state.read(first.captureId)).filter((e) => e.type === 'stopped');
    expect(stops).toMatchObject([{ actor: { id: 'webDev', role: 'engineer' }, source: 'cli' }]);
    expect((await w.booted.state.getIncident(first.captureId))?.status).toBe('stopped');
    expect(await eventTypes(w, duplicate.captureId)).not.toContain('stopped');
    expect(await engineer.status('WEB-1')).toMatchObject({ issueKey: 'WEB-1', status: 'stopped' });
    // Already stopped: nothing more to stop.
    expect(await engineer.stop('WEB-1')).toEqual({ issueKey: 'WEB-1', stopped: false });
    settled(w);
  });

  it('the same words from another person are a capture of their own, out of the first one\'s reach', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const first = await (await w.clientFor('webDev')).sendText(TRACKED_TEXT);
    const other = await w.clientFor('helpDev');
    const second = await other.sendText(TRACKED_TEXT);
    expect(second.captureId).not.toBe(first.captureId);
    // The second sender cannot read or answer the first one's capture; the first still can.
    await expect(other.poll(first.captureId)).rejects.toMatchObject({ status: 404 });
    await expect(other.answer(first.captureId, 'cancel')).rejects.toMatchObject({ status: 404 });
    expect(await (await w.clientFor('webDev')).poll(first.captureId)).toEqual(first);
    // A resend by the same person still joins their own capture.
    expect(await other.sendText(TRACKED_TEXT)).toEqual(second);
    settled(w);
  });

  it('refuses an image over 5 MB with a 413 before the vision pass or any kv write', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const cli = await w.clientFor('helpDev');
    const big = Buffer.alloc(CAPTURE_IMAGE_MAX_BYTES + 1, 7).toString('base64');
    const err = await cli.sendImage(big, 'image/png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureServerError);
    expect(err).toMatchObject({ status: 413, message: 'That image is too large (limit 5 MB).' });
    expect(w.model.calls).toEqual([]);
    expect(await w.booted.state.ctx.db.selectFrom('kv').select('k').execute()).toEqual([]);
    expect(await w.booted.state.findIncidents({ workspaceId: w.workspaceId })).toEqual([]);
    // Exactly at the limit is fine.
    const edge = Buffer.alloc(CAPTURE_IMAGE_MAX_BYTES, 7).toString('base64');
    expect(await cli.sendImage(edge, 'image/png')).toMatchObject({ kind: 'new' });
    settled(w);
  });

  it('limits sends and answers per token with a 429 and Retry-After; polling is not counted', { timeout: TEST_TIMEOUT }, async () => {
    const w = await world();
    const a = await w.booted.state.issueCaptureToken({ workspaceId: w.workspaceId, person: 'webDev' });
    const b = await w.booted.state.issueCaptureToken({ workspaceId: w.workspaceId, person: 'webDev' });
    // A body that fails validation: the limiter counts it, and nothing reaches the engine.
    const call = (token: string, path: string, method = 'POST'): Promise<Response> =>
      w.api.fetch(new Request(`${ENDPOINT}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) }));
    const answerPath = CAPTURE_ROUTES.answer('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    for (let i = 0; i < CAPTURE_SENDS_PER_WINDOW; i++) expect((await call(a.token, CAPTURE_ROUTES.send)).status).toBe(400);
    const limited = await call(a.token, CAPTURE_ROUTES.send);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect((await limited.json()) as unknown).toEqual({ error: expect.stringMatching(/^too many requests, try again in \d+ seconds$/) });
    // Another token is not affected; neither are answers or polls on the limited one.
    expect((await call(b.token, CAPTURE_ROUTES.send)).status).toBe(400);
    expect((await call(a.token, answerPath)).status).toBe(404);
    for (let i = 0; i < CAPTURE_SENDS_PER_WINDOW + 5; i++) expect((await call(a.token, CAPTURE_ROUTES.poll('01ARZ3NDEKTSV4RRFFQ69G5FAV'), 'GET')).status).toBe(404);
    for (let i = 0; i < CAPTURE_ANSWERS_PER_WINDOW - 1; i++) expect((await call(a.token, answerPath)).status).toBe(404);
    expect((await call(a.token, answerPath)).status).toBe(429);
    // The client says so in words.
    const cli = createCaptureClient({ endpoint: ENDPOINT, token: a.token, fetch: (input, init) => w.api.fetch(new Request(input, init)) });
    await expect(cli.sendText(VAGUE)).rejects.toThrow(/^Too many reports, try again in \d+ seconds\.$/);
    expect(await w.booted.state.findIncidents({ workspaceId: w.workspaceId })).toEqual([]);
    settled(w);
  });

  describe('a level 1 surface, where the ticket waits on Fix it or Ticket only', () => {
    const BOTH = [
      { id: 'approve_fix', label: 'Fix it' },
      { id: 'ticket_only', label: 'Ticket only' },
    ];

    it('an engineer taps Fix it: the ticket files and the fixer starts', { timeout: TEST_TIMEOUT }, async () => {
      const w = await world();
      const engineer = await w.clientFor('adminDev');
      const first = await engineer.sendText(VAGUE, { surface: 'admin' });
      expect(first).toMatchObject({ kind: 'new', surface: { id: 'admin', label: 'B2B Admin Portal' } });
      const preview = await engineer.answer(first.captureId, 'file-it');
      expect(preview).toEqual({ kind: 'fix-preview', captureId: first.captureId, summary: TRIAGE.summary, choices: BOTH });
      expect(formatRendered(renderChoices(preview))).toBe(`Ready to file: ${TRIAGE.summary}\n1. Fix it\n2. Ticket only`);
      expect(await engineer.poll(first.captureId)).toEqual(preview);
      // Nothing is filed before the answer.
      expect([...w.jira.issues.keys()]).toEqual(['ADM-7']);

      expect(await engineer.answer(first.captureId, 'approve_fix')).toEqual({ kind: 'filed', captureId: first.captureId, issueKey: 'ADM-8', url: `${JIRA_BASE}/browse/ADM-8` });
      // Fix it moves the ticket In Progress, and Jira's webhook for that starts the fixer.
      await expect.poll(() => w.jiraHooks.transitions, { timeout: 10_000, interval: 25 }).toEqual(['ADM-8: To Do -> In Progress']);
      await deliverJira(w, 'ADM-8');
      await expect.poll(() => eventTypes(w, first.captureId), { timeout: 10_000, interval: 25 }).toContain('fixer-started');
      expect(await w.booted.state.read(first.captureId)).toContainEqual(expect.objectContaining({ type: 'tapped', actor: { id: 'adminDev', role: 'engineer' }, payload: expect.objectContaining({ card: 'fix-preview', choice: 'approve_fix' }) }));
      // The run has no remote to clone here, so it ends at once; let it, before the world goes away.
      await expect.poll(() => eventTypes(w, first.captureId), { timeout: 10_000, interval: 25 }).toContain('fixer-failed');
      settled(w);
    });

    it('an engineer taps Ticket only: the ticket files and no fixer starts', { timeout: TEST_TIMEOUT }, async () => {
      const w = await world();
      const engineer = await w.clientFor('adminDev');
      const first = await engineer.sendText(VAGUE, { surface: 'admin' });
      expect(await engineer.answer(first.captureId, 'file-it')).toMatchObject({ kind: 'fix-preview', choices: BOTH });
      expect(await engineer.answer(first.captureId, 'ticket_only')).toMatchObject({ kind: 'filed', issueKey: 'ADM-8' });
      // Filed ticket only: it waits on its owner, and nothing moves it In Progress.
      await expect.poll(() => w.booted.state.getIncident(first.captureId), { timeout: 10_000, interval: 25 }).toMatchObject({ status: 'filed', waitingOn: { kind: 'human' } });
      expect(w.jiraHooks.transitions).toEqual([]);
      expect(await eventTypes(w, first.captureId)).not.toContain('fixer-started');
      settled(w);
    });

    it('a reporter is offered Ticket only, and a Fix it they send anyway is refused', { timeout: TEST_TIMEOUT }, async () => {
      const w = await world();
      const reporter = await w.clientFor('salesLead');
      const first = await reporter.sendText(VAGUE, { surface: 'admin' });
      const preview = await reporter.answer(first.captureId, 'file-it');
      expect(preview).toEqual({ kind: 'fix-preview', captureId: first.captureId, summary: TRIAGE.summary, choices: [{ id: 'ticket_only', label: 'Ticket only' }] });
      await expect(reporter.answer(first.captureId, 'approve_fix')).rejects.toMatchObject({ status: 400 });
      expect(await w.booted.state.read(first.captureId)).not.toContainEqual(expect.objectContaining({ type: 'tapped', payload: expect.objectContaining({ card: 'fix-preview' }) }));
      expect(await reporter.poll(first.captureId)).toEqual(preview);

      expect(await reporter.answer(first.captureId, 'ticket_only')).toMatchObject({ kind: 'filed', issueKey: 'ADM-8' });
      expect(w.jiraHooks.transitions).toEqual([]);
      expect(await eventTypes(w, first.captureId)).not.toContain('fixer-started');
      settled(w);
    });
  });
});
