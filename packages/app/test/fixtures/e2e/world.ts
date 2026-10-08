// The composed app on MSW, shared by the compose contract test (level 0) and the levels 1 and 2
// end to end test: fake secrets, the Slack Web API over one channel's recorded messages,
// signed Slack and GitHub deliveries, and `bootComposed`, which runs the real `compose` with the real
// worker, projectors, and API routes on the dialect `SNAPWING_DB` selects. Every value here is a fake;
// none looks like a real credential.

import { createHmac, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse } from 'msw';
import type { SetupServer } from 'msw/node';
import { loadAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { PgBossWorkflow } from '@snapwing/pipeline/workflow/pgboss/index.ts';
import { compose, type Composed, type ComposeOverrides } from '../../../src/server/compose.ts';
import { createApiServer, type ApiServer } from '../../../src/server/http.ts';
import { createWorker, type Worker } from '../../../src/server/worker.ts';

export const EXAMPLE_CONFIG = fileURLToPath(new URL('../../../../../examples/snapwing.config.example.xml', import.meta.url));
export const DEMO_MAP = fileURLToPath(new URL('../../../../../demo/levels/workspace-context.xml', import.meta.url));
export const DEMO_LEVELS = fileURLToPath(new URL('../../../../../demo/levels/', import.meta.url));
export const SLACK_API = 'https://slack.com/api';
export const SIGNING_SECRET = 'test-signing-secret';
export const BOT_USER = 'U0SNAPWING';
/** The workspace subdomain the fake `auth.test` reports. */
export const WORKSPACE_DOMAIN = 'acme-test';
/** The workspace's team id: `auth.test`'s, the Events API envelope's, and every fake user's. */
export const TEAM_ID = 'T0001';

/** Fakes only: none of these looks like a real credential. */
export function fakeSecrets(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    JIRA_BASE_URL: 'https://fake-site.atlassian.net',
    JIRA_EMAIL: 'snapwing-bot@example.com',
    JIRA_API_TOKEN: 'test-jira-token',
    JIRA_FIELD_IMPL_PROMPT: 'customfield_10050',
    JIRA_FIELD_CONVERSATION: 'customfield_10051',
    JIRA_FIELD_AUTONOMY: 'customfield_10052',
    JIRA_FIELD_AGENT_STATUS: 'customfield_10053',
    GITHUB_APP_ID: '1001',
    GITHUB_APP_PRIVATE_KEY: 'test-private-key',
    GITHUB_INSTALLATION_ID: '2002',
    GITHUB_APP_SLUG: 'snapwing-test',
    GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
    GITHUB_APP_CLIENT_ID: 'test-client-id',
    GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
    SNAPWING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SNAPWING_PUBLIC_URL: 'https://snapwing.example.com',
    SNAPWING_FIXER_TOKEN_SECRET: 'test-fixer-token-secret-0123456789abcdef',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    OPENAI_API_KEY: 'test-openai-key',
    GOOGLE_API_KEY: 'test-google-key',
  };
}

export function envFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n')}\n`;
}

/** Headers Slack signs a request with (`v0` HMAC over the timestamp and the body). */
export function slackSigned(body: string, contentType = 'application/json'): Headers {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return new Headers({ 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature });
}

/** Headers GitHub signs a webhook delivery with (`X-Hub-Signature-256` under the webhook secret). */
export function githubSigned(event: string, body: string, secret: string, delivery: string): Headers {
  return new Headers({
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': delivery,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  });
}

// Slack ------------------------------------------------------------------------------------------

export interface SlackPostCall {
  method: string;
  body: Record<string, unknown>;
  ts: string;
}

export interface SlackWorld {
  /** Every Web API write, in order. `ts` is the message's (the edited one for `chat.update`). */
  calls: SlackPostCall[];
  /** Methods the world does not know; a test expects none. */
  unknown: string[];
}

export interface SlackWorldOptions {
  /**
   * The channel's members for `conversations.members` (A 4.4). Absent: Slack answers
   * `missing_scope`, as it does for an app installed before `channels:read`, and nothing is written.
   */
  members?: readonly string[];
  /**
   * Milliseconds to hold the reply to a `chat.postMessage` whose body this picks. The call is
   * already in `calls`, so a test can tap the card while the app still waits for Slack's answer, the
   * gap between a card going out and its record being written.
   */
  postReplyDelayMs?: (body: Record<string, unknown>) => number;
}

/** The Slack Web API methods the composed pieces call, over one channel's recorded messages. */
export function slackWorld(server: SetupServer, channel: string, messages: readonly Record<string, unknown>[], options: SlackWorldOptions = {}): SlackWorld {
  const calls: SlackPostCall[] = [];
  const unknown: string[] = [];
  let seq = 0;
  const authorized = (request: Request): boolean => request.headers.get('authorization') === 'Bearer xoxb-test';
  const page = (list: readonly Record<string, unknown>[]) => HttpResponse.json({ ok: true, messages: list, has_more: false });
  const inRange = (m: Record<string, unknown>, q: URLSearchParams): boolean => {
    const ts = Number(m['ts']);
    return ts >= Number(q.get('oldest') ?? '0') && ts <= Number(q.get('latest') ?? `${Number.MAX_SAFE_INTEGER}`);
  };
  server.use(
    http.get(`${SLACK_API}/conversations.history`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      const q = new URL(request.url).searchParams;
      if (q.get('channel') !== channel) return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      return page(messages.filter((m) => m['thread_ts'] === undefined && inRange(m, q)).sort((a, b) => Number(b['ts']) - Number(a['ts'])));
    }),
    http.get(`${SLACK_API}/conversations.replies`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      const q = new URL(request.url).searchParams;
      const ts = q.get('ts') ?? '';
      const thread = messages.filter((m) => (m['ts'] === ts || m['thread_ts'] === ts) && inRange(m, q));
      return page(thread.sort((a, b) => Number(a['ts']) - Number(b['ts'])));
    }),
    http.get(`${SLACK_API}/conversations.members`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      if (options.members === undefined) return HttpResponse.json({ ok: false, error: 'missing_scope' });
      const q = new URL(request.url).searchParams;
      if (q.get('channel') !== channel) return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      return HttpResponse.json({ ok: true, members: options.members, response_metadata: { next_cursor: '' } });
    }),
    http.post(`${SLACK_API}/auth.test`, ({ request }) =>
      authorized(request)
        ? HttpResponse.json({ ok: true, user_id: BOT_USER, team_id: TEAM_ID, url: `https://${WORKSPACE_DOMAIN}.slack.com/` })
        : HttpResponse.json({ ok: false, error: 'invalid_auth' }),
    ),
    // Everyone is a member of the workspace, so a trigger reaction is never capped as a guest's (#170).
    http.get(`${SLACK_API}/users.info`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      const user = new URL(request.url).searchParams.get('user') ?? '';
      return HttpResponse.json({ ok: true, user: { id: user, team_id: TEAM_ID } });
    }),
    http.post(`${SLACK_API}/:method`, async ({ request, params }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      const method = String(params['method']);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      seq += 1;
      const ts = method === 'chat.update' ? String(body['ts']) : `1790900000.${String(seq).padStart(6, '0')}`;
      calls.push({ method, body, ts });
      const hold = method === 'chat.postMessage' ? (options.postReplyDelayMs?.(body) ?? 0) : 0;
      if (hold > 0) await new Promise<void>((resolve) => setTimeout(resolve, hold));
      if (method === 'chat.postMessage' || method === 'chat.update') return HttpResponse.json({ ok: true, channel: body['channel'], ts });
      if (method === 'chat.postEphemeral') return HttpResponse.json({ ok: true, message_ts: ts });
      if (method === 'pins.add' || method === 'conversations.join' || method === 'reactions.add') return HttpResponse.json({ ok: true });
      unknown.push(method);
      return HttpResponse.json({ ok: false, error: 'unknown_method' });
    }),
  );
  return { calls, unknown };
}

/** The `block_id`s of a posted message. */
export function blockIds(body: Record<string, unknown>): string[] {
  const blocks = Array.isArray(body['blocks']) ? (body['blocks'] as Record<string, unknown>[]) : [];
  return blocks.flatMap((b) => (typeof b['block_id'] === 'string' ? [b['block_id']] : []));
}

/** The text of a posted message: its blocks' section and context text, else its `text`. */
export function messageText(body: Record<string, unknown>): string {
  const blocks = Array.isArray(body['blocks']) ? (body['blocks'] as Record<string, unknown>[]) : [];
  const parts: string[] = [];
  for (const b of blocks) {
    const text = (b['text'] as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string') parts.push(text);
    for (const e of Array.isArray(b['elements']) ? (b['elements'] as { text?: unknown }[]) : []) if (typeof e.text === 'string') parts.push(e.text);
  }
  return parts.length > 0 ? parts.join(' ') : String(body['text'] ?? '');
}

// The composed app -------------------------------------------------------------------------------

export interface Booted {
  composed: Composed;
  state: StateStore;
  api: ApiServer;
  /** Errors the workflow reported (a job that threw); a test expects none. */
  errors: unknown[];
  /** Lines compose logged as errors; a test expects none. */
  logged: string[];
  /** The secrets port compose read. */
  secrets: SecretsPort;
  /** An interactivity payload, signed as Slack would send it. */
  interact(payload: Record<string, unknown>): Promise<Response>;
  stop(): Promise<void>;
}

export interface BootInput {
  state: OpenedState;
  /** The config XML (default: the example config). */
  configXml: string;
  secrets: Record<string, string>;
  /** Where the env file is written. */
  dir: string;
  env: Record<string, string>;
  overrides: ComposeOverrides;
}

/**
 * The real `compose`, then what `snapwing serve` starts around it: the worker over its jobs, the
 * worker services (both projectors, the reconcile schedule), and the API routes, served through
 * `fetch` without a socket. pg-boss on Postgres, the in-process workflow on SQLite.
 */
export async function bootComposed(input: BootInput): Promise<Booted> {
  const { state } = input;
  if (!(state instanceof StateStore)) throw new Error('expected the StateStore');
  const errors: unknown[] = [];
  const logged: string[] = [];
  const workflow =
    state.dialect === 'postgres'
      ? new PgBossWorkflow(state, { schema: 'pgboss', pollingIntervalSeconds: 0.5, onError: (e) => errors.push(e) })
      : new InProcessWorkflow(state, { pollIntervalMs: 20, onError: (e) => errors.push(e) });
  const file = join(input.dir, 'composed.env');
  await writeFile(file, envFile(input.secrets));
  const secrets = createEnvFileSecrets({ path: file, fallbackEnv: {} });
  const composed = await compose({
    config: loadAppConfig(input.configXml),
    secrets,
    state,
    workflow,
    env: input.env,
    log: { info: () => undefined, error: (l) => logged.push(l) },
    overrides: input.overrides,
  });
  const worker: Worker = await createWorker({ workflow, jobs: composed.jobs });
  for (const s of composed.workerServices ?? []) await s.start();
  const api = createApiServer({ routes: composed.routes, port: 0 });
  return {
    composed,
    state,
    api,
    errors,
    logged,
    secrets,
    interact: async (payload) => {
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      return api.fetch(new Request('http://snapwing.test/slack/interactivity', { method: 'POST', headers: slackSigned(body, 'application/x-www-form-urlencoded'), body }));
    },
    stop: async () => {
      for (const s of [...(composed.workerServices ?? [])].reverse()) await s.stop();
      await worker.stop();
    },
  };
}
