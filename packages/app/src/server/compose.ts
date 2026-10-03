// The composition root: the one place phase 3 components are built and wired (CONTEXT.md 3,
// main 14.1, main 14.3, B 7.1, B 9). `snapwing serve` calls `compose` once the config, secrets, state
// store, and workflow exist; it mounts `routes` on the API process, registers `jobs` on the worker,
// starts `apiServices` once the API listens and `workerServices` once the worker polls, and appends
// `metrics()` to `/metrics`.
//
// What it builds, and how the pieces point at each other:
//
//   Inbound      Slack transport (Socket Mode when SLACK_APP_TOKEN is set, HTTP routes otherwise;
//                SNAPWING_SLACK_TRANSPORT=http|socket overrides), whose dispatcher calls the engine's
//                `handleInbound` and hands taps to the Slack interactivity; `observeReactionRemoval`
//                wraps the adapter so a removed trigger reaction reaches the interactivity too.
//                `POST /webhooks/jira` (inbound sync, fixer trigger), `POST /webhooks/github` (bot
//                login `${GITHUB_APP_SLUG}[bot]`; it starts `merge.evaluate` with the merge step's
//                singleton key itself), the fixer API (`/fixer/:workItemId/...`, B 9), and the GitHub
//                OAuth routes (`/auth/github/start`, `/auth/github/callback`).
//   Engine       `IncidentOrchestrator` with the Slack adapter and context source, Jira search, the
//                recent-incidents cache, the map from the config cache, a read-only repo reader, and
//                `createStatusSubscriber`: the status message comes only from the Slack status
//                projector draining `update-status` rows, so the engine never posts `filed` itself.
//   Projectors   one Jira projector (custom field ids from JIRA_FIELD_*, `continueIncident` from the
//                engine, Slack-hosted screenshots loaded with the bot token) and one Slack status
//                projector for the install's workspace; both run in worker processes only.
//   Jobs         `incident.process`, `fixer.run`, `timer.fixer-budget`, `review.run`,
//                `merge.evaluate` (then `requestHumanReview`, which posts the PR card at levels 1 and 2
//                after `review-passed` and after a level 3 `held`), `timer.revert`, and `reconcile`
//                (scheduled on the B 8 cron by the worker).
//   Fixer path   the runner's checkpoint and finish callbacks go to the fixer reporter (local runner)
//                or the container reports over HTTP with an `issueFixerToken` (docker runner). The
//                reporter's `onDone` cancels the budget timer and starts the review; `onFailed` runs
//                the failure degrade. The review starts `merge.evaluate` (or the fixer retry).
//   Containers   with the docker runner the review agent and the regression proof run in the fixer's
//                runner too (`runReview`, `runTests`; `ReviewConfig.harness` is `<harness review>`),
//                and `POST /model/:workItemId/{provider}/...` is the model proxy (ADR 0017 amendment
//                1): fixer and review containers reach it at SNAPWING_CONTAINER_API_URL (else
//                SNAPWING_FIXER_API_URL, else SNAPWING_PUBLIC_URL) with a per-run `issueModelToken`,
//                and it calls the provider with the key from the secrets port. No provider key ever
//                enters a container; a provider whose key is unset has no proxy routes.
//   Reconciler   follow-ups after a reconciled event: `ci-green` starts `merge.evaluate`, `ci-red` the
//                fixer retry (`retryFixerAfterCiRed`), a transition to In Progress the fixer.
//
// GitHub tokens are scoped per use: the fixer's checkout gets `contents: write` and
// `pull_requests: write` on its one repo and never `workflows` (GitHub then rejects any push that
// touches `.github/workflows`, the real guard; the workdir hooks can be skipped). With docker the
// container holds no git token: `GET /fixer/:workItemId/git-token` mints one with those scopes
// whenever its git asks, so a run may outlive a token's hour (#266), and the fixer token's TTL is the
// run's wall clock plus a margin (`fixerTokenTtl`). The worker's first service sweeps the runner's
// stale scratch directories (`sweep`, older than the fixer wall clock plus a margin, #266). The review's
// checkout gets `contents: read` and `metadata: read` only; the review posts through the server's own
// client, never from inside the harness.
//
// Startup fails, listing every missing secret by name (never a value), before anything is built.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, HarnessAdapter, HarnessConfig, ModelProvider } from '@snapwing/pipeline/config/app-config.ts';
import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isFixerBudgetData, isFixerRunData, isReviewRunData, type JobName } from '@snapwing/pipeline/contracts/jobs.ts';
import { StateNotFoundError, type IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import type { EngineDeps } from '@snapwing/pipeline/engine/deps.ts';
import { IncidentOrchestrator } from '@snapwing/pipeline/engine/orchestrator.ts';
import { fixerBudget, fixerBudgetExpired, handleFixerDone, handleFixerFailed, runFixerJob, startFixer, type FixerDeps } from '@snapwing/pipeline/fixer/job.ts';
import { stopIncident } from '@snapwing/pipeline/fixer/stop.ts';
import { isTerminalStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { createPrActions } from '@snapwing/pipeline/merge/actions.ts';
import { retryFixerAfterCiRed } from '@snapwing/pipeline/merge/ci.ts';
import { requestHumanReview, type HumanDeps, type HumanReviewDeps, type PrReadyChat } from '@snapwing/pipeline/merge/human.ts';
import { evaluateMerge, isMergeEvaluateData, startMergeEvaluate, type MergeDeps } from '@snapwing/pipeline/merge/job.ts';
import { revert, revertWindowClosed } from '@snapwing/pipeline/merge/revert.ts';
import { anthropicProvider } from '@snapwing/pipeline/models/anthropic/index.ts';
import { googleProviderFactory } from '@snapwing/pipeline/models/google/index.ts';
import { openaiProvider } from '@snapwing/pipeline/models/openai/index.ts';
import { createModelRouter, PROVIDER_KEY_ENV, resolveModelRoutes, MODEL_TASK_LIST } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort, WorkItemRef } from '@snapwing/pipeline/ports/harness.ts';
import type { ModelPort } from '@snapwing/pipeline/ports/model.ts';
import type { HarnessChoice, RunnerPort } from '@snapwing/pipeline/ports/runner.ts';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import type { WorkflowPort } from '@snapwing/pipeline/ports/workflow.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { createLocalRunner, harnessResolver, type ScratchSweeper } from '@snapwing/pipeline/providers/local/runner.ts';
import { DEFAULT_RECONCILE_CRON, RECONCILE_JOB, runReconcile, type ReconcileDeps } from '@snapwing/pipeline/reconcile/job.ts';
import type { ReconciledEventType } from '@snapwing/pipeline/reconcile/marker.ts';
import { runReviewJob, startReview, type ReviewDeps } from '@snapwing/pipeline/review/job.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { formatDuration, parseDuration } from '@snapwing/pipeline/util/duration.ts';
import { createStatusSubscriber } from '@snapwing/pipeline/status/subscriber.ts';
import { createSlackAdapter } from '../adapters/slack/adapter.ts';
import { createSlackInteractivity, observeReactionRemoval } from '../adapters/slack/interactivity.ts';
import { createSlackPrReadyChat } from '../adapters/slack/pr-ready.ts';
import { createSlackContextSource } from '../adapters/slack/reader.ts';
import { createSlackHome } from '../adapters/slack/home.ts';
import { createSlackStatusProjector } from '../adapters/slack/status-projector.ts';
import { createSlackStatusQuery } from '../adapters/slack/status-query.ts';
import { createSlackTransport, type SocketLike } from '../adapters/slack/transport.ts';
import { createSlackWeb, type SlackWeb } from '../adapters/slack/web.ts';
import { createFixerReporter, type FixerReporter, type FixerTarget } from '../fixer-api/reporter.ts';
import { createFixerRoutes } from '../fixer-api/routes.ts';
import { createFixerGitToken } from '../fixer-api/git-token.ts';
import { fixerTokenTtl, fixerTokenVerifier, issueFixerToken, type FixerTokenKeys } from '../fixer-api/token.ts';
import { createGitHubAuth, type GitHubAuth, type GitHubPermissions } from '../github/auth.ts';
import { createGitHubClient, type GitHubClient } from '../github/client.ts';
import { createCodeownersResolver } from '../github/codeowners.ts';
import { createFixerGitHub } from '../github/fixer-github.ts';
import { createGitHubOAuth } from '../github/oauth.ts';
import { createGitHubRepoReader } from '../github/repo-reader.ts';
import { repoFullName } from '../github/repo.ts';
import { createJiraClient, jiraSearch, type JiraClient } from '../jira/client/index.ts';
import { createJiraProjector } from '../jira/projector/drain.ts';
import { CUSTOM_FIELD_ENV, requireCustomFieldIds } from '../jira/projector/fields.ts';
import { createStatusResolver } from '../jira/projector/statuses.ts';
import { fetchScreenshot, screenshotFilename, type LoadScreenshot } from '../jira/projector/ops.ts';
import { createModelProxyRoutes, MODEL_PROXY_PREFIX, type ModelProviderUpstream, type ModelProxyProvider } from '../model-proxy/routes.ts';
import { issueModelToken, MAX_MODEL_TOKEN_TTL, modelTokenVerifier } from '../model-proxy/token.ts';
import { createDockerRunner, type DockerModelProxy } from '../providers/docker/runner.ts';
import { createReconcileSources } from '../reconcile/sources.ts';
import { createGitHubWebhookRoute, GITHUB_WEBHOOK_PATH } from '../webhooks/github.ts';
import { createJiraWebhookRoute, isInProgressStatus, JIRA_WEBHOOK_PATH } from '../webhooks/jira.ts';
import { createConfigWatch, DEFAULT_INSTRUCTIONS_FILE, DEFAULT_PLAYBOOK_FILE } from './config-watch.ts';
import type { Route } from './http.ts';
import type { JobModule } from './worker.ts';

/** The fixer's checkout token: its one repo, write to contents and pull requests, never `workflows`. */
export const FIXER_GIT_PERMISSIONS: GitHubPermissions = Object.freeze({ contents: 'write', pull_requests: 'write' });
/** The review's checkout token: read only. The review posts through the server's client, not the harness. */
export const REVIEW_GIT_PERMISSIONS: GitHubPermissions = Object.freeze({ contents: 'read', metadata: 'read' });
/** Where the workspace map is read from at startup, unless `SNAPWING_MAP` names another file. */
export const DEFAULT_MAP_FILE = 'workspace-context.xml';
/** How long a map read from the config cache is reused before the cache is asked again. */
const MAP_REFRESH_MS = 5_000;

/** Secrets every `snapwing serve` needs (CONTEXT.md 6b). Model keys and per-provider secrets are added per config. */
export const REQUIRED_SECRETS: readonly string[] = Object.freeze([
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  ...Object.values(CUSTOM_FIELD_ENV),
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'SNAPWING_ENCRYPTION_KEY',
  'SNAPWING_PUBLIC_URL',
  'SNAPWING_FIXER_TOKEN_SECRET',
]);

/**
 * Read when present: Socket Mode, the Jira webhook's shared secret, and every model provider key (the
 * model proxy serves each provider whose key is set, whether or not a task routes to it).
 */
export const OPTIONAL_SECRETS: readonly string[] = Object.freeze(['SLACK_APP_TOKEN', 'JIRA_WEBHOOK_SECRET', ...Object.values(PROVIDER_KEY_ENV)]);

/** How long a model token outlives its run's wall clock, so the run's last call is not refused. */
export const MODEL_TOKEN_MARGIN_MS = 5 * 60_000;

/** The model provider each CLI harness calls; its containers need that provider's proxy routes. */
const HARNESS_PROVIDER: Partial<Record<HarnessAdapter, ModelProxyProvider>> = { 'claude-code': 'anthropic', codex: 'openai', gemini: 'google' };

/** Startup found secrets unset. The message names them; it never carries a value. */
export class MissingSecretsError extends Error {
  override readonly name = 'MissingSecretsError';
  constructor(readonly missing: readonly string[]) {
    super(`missing secrets: ${missing.join(', ')} (set them in the env file or the provider's secret store; names in build/CONTEXT.md 6b)`);
  }
}

export interface ComposeLog {
  info(line: string): void;
  error(line: string): void;
}

/** Test seams. Production passes none. */
export interface ComposeOverrides {
  /** Replaces the routed vendor models (contract tests use a fake). */
  model?: ModelPort;
  /** Replaces the harness the config chooses, for the fixer and the review. */
  resolveHarness?: (choice: HarnessChoice) => HarnessPort;
  /** Clone URL for `owner/name` (tests clone from a local bare repository). */
  gitRemoteUrl?: (repo: string) => string;
  /** The Slack bot's user id; skips `auth.test`. */
  slackBotUserId?: string;
  /** The Slack workspace subdomain for the Conversation Link; with the bot user id, skips `auth.test`. */
  slackWorkspaceDomain?: string;
  /** Opens the Socket Mode WebSocket. */
  openSocket?: (url: string) => SocketLike;
  /** The Slack side of the PR card. Default `createSlackPrReadyChat`. */
  prReadyChat?: PrReadyChat;
  /** Poll interval of both projectors, in milliseconds. */
  projectorPollMs?: number;
}

export interface ComposeDeps {
  readonly config: AppConfig;
  readonly secrets: SecretsPort;
  readonly state: OpenedState;
  readonly workflow: WorkflowPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: ComposeLog;
  readonly overrides?: ComposeOverrides;
}

/** Something a process starts after it is up and stops before it goes down. */
export interface ComposedService {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Composed {
  readonly routes: readonly Route[];
  readonly jobs: readonly JobModule[];
  /** Started by an API process once it listens; stopped first on shutdown (Slack Socket Mode). */
  readonly apiServices?: readonly ComposedService[];
  /** Started by a worker process once it polls; stopped before it drains (projectors, the reconcile schedule). */
  readonly workerServices?: readonly ComposedService[];
  /** Prometheus text appended to `/metrics` (projector pauses and parked rows, B 10). */
  metrics?(): Promise<string>;
  /** The wired fixer and review deps, so tests can check what points at what. */
  readonly deps?: { readonly fixer: FixerDeps; readonly review: ReviewDeps };
}

export type ComposeFn = (deps: ComposeDeps) => Promise<Composed>;

// Secrets ----------------------------------------------------------------------------------------

/** Reads every name, collecting the unset ones; throws `MissingSecretsError` listing all required ones missing. */
export async function readSecrets(secrets: SecretsPort, required: readonly string[], optional: readonly string[] = []): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const missing: string[] = [];
  const read = async (name: string): Promise<string | undefined> => {
    try {
      const value = await secrets.get(name);
      return value.trim() === '' ? undefined : value;
    } catch (e) {
      if (e instanceof SecretNotFoundError) return undefined;
      throw e;
    }
  };
  for (const name of [...new Set(required)]) {
    const value = await read(name);
    if (value === undefined) missing.push(name);
    else values.set(name, value);
  }
  if (missing.length > 0) throw new MissingSecretsError(missing);
  for (const name of optional) {
    if (values.has(name)) continue;
    const value = await read(name);
    if (value !== undefined) values.set(name, value);
  }
  return values;
}

/** The model key secrets the config's routes need: one per provider any task routes to. */
export function modelKeySecrets(config: AppConfig): string[] {
  const routes = resolveModelRoutes(config.models, {});
  const providers = new Set<ModelProvider>(MODEL_TASK_LIST.map((t) => routes[t].provider));
  return [...providers].map((p) => PROVIDER_KEY_ENV[p]);
}

// The map ----------------------------------------------------------------------------------------

/**
 * Loads the map file (when it exists) into the config cache, then returns a getter over the cache that
 * re-parses only when the cached version changes. Without a file, the cache must already hold one.
 */
async function loadMap(state: OpenedState, path: string, log: ComposeLog): Promise<() => Promise<WorkspaceMap>> {
  let xml: string | undefined;
  try {
    xml = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`cannot read workspace map ${path}: ${(e as Error).message}`, { cause: e });
  }
  let current: { hash: string; map: WorkspaceMap; at: number } | undefined;
  if (xml !== undefined) {
    const map = await parseWorkspaceMap(xml);
    const hash = createHash('sha256').update(xml).digest('hex');
    await state.putConfigVersion('map', hash, xml);
    current = { hash, map, at: Date.now() };
    log.info(`workspace map ${path} loaded (${map.surfaces.length} surfaces)`);
  } else {
    try {
      const cached = await state.getConfigVersion('map');
      current = { hash: cached.hash, map: await parseWorkspaceMap(cached.body), at: Date.now() };
      log.info('workspace map loaded from the config cache');
    } catch (e) {
      if (e instanceof StateNotFoundError) {
        throw new Error(`no workspace map: ${path} does not exist and the config cache holds none (set SNAPWING_MAP)`, { cause: e });
      }
      throw e;
    }
  }
  let refreshing: Promise<WorkspaceMap> | undefined;
  return async () => {
    const held = current;
    if (held !== undefined && Date.now() - held.at < MAP_REFRESH_MS) return held.map;
    refreshing ??= (async () => {
      try {
        const cached = await state.getConfigVersion('map');
        if (cached.hash !== current?.hash) current = { hash: cached.hash, map: await parseWorkspaceMap(cached.body), at: Date.now() };
        else current = { ...current, at: Date.now() };
        return current.map;
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };
}

// Small pieces -----------------------------------------------------------------------------------

function harnessChoice(config: HarnessConfig, adapter: HarnessAdapter): HarnessChoice {
  if (adapter !== 'generic') return { adapter };
  const template = config.generic[0];
  if (template === undefined) throw new Error('harness uses "generic" but declares no <generic> command template');
  return { adapter: 'generic', templateId: template.id };
}

/** The bot's own user id and the workspace subdomain, from one `auth.test` call. */
async function slackIdentity(token: string): Promise<{ userId: string; domain?: string }> {
  const res = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; user_id?: string; url?: string; error?: string };
  if (body.ok !== true || typeof body.user_id !== 'string') throw new Error(`slack auth.test failed: ${body.error ?? `http_${res.status}`}`);
  return { userId: body.user_id, ...workspaceDomain(body.url) };
}

/** `https://acme.slack.com/` gives `acme`; anything else (a custom domain, no url) gives nothing. */
function workspaceDomain(url: string | undefined): { domain?: string } {
  try {
    const host = new URL(url ?? '').hostname;
    const m = /^([a-z0-9-]+)\.slack\.com$/i.exec(host);
    return m?.[1] === undefined ? {} : { domain: m[1] };
  } catch {
    return {};
  }
}

/** Slack-hosted files need the bot token; anything else is a plain GET. */
function screenshotLoader(web: SlackWeb): LoadScreenshot {
  return async (ref) => {
    let host = '';
    try {
      host = new URL(ref.url).hostname;
    } catch {
      // fetchScreenshot reports the bad URL.
    }
    if (host !== 'slack.com' && !host.endsWith('.slack.com')) return fetchScreenshot(ref);
    const file = await web.downloadFile(ref.url);
    const contentType = ref.contentType ?? (file.contentType === '' ? undefined : file.contentType);
    return { filename: screenshotFilename(ref), content: file.bytes, ...(contentType === undefined ? {} : { contentType }) };
  };
}

/** The proxy's upstreams: one per provider whose key the secrets port holds. */
function modelProxyProviders(key: (name: string) => string | undefined): Partial<Record<ModelProxyProvider, ModelProviderUpstream>> {
  const out: Partial<Record<ModelProxyProvider, ModelProviderUpstream>> = {};
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    const apiKey = key(PROVIDER_KEY_ENV[provider]);
    if (apiKey !== undefined) out[provider] = { apiKey };
  }
  return out;
}

/** A model token's TTL: the run's wall clock plus `MODEL_TOKEN_MARGIN_MS`, at most `MAX_MODEL_TOKEN_TTL`. */
export function modelTokenTtl(wallClock: string): string {
  return formatDuration(Math.min(parseDuration(wallClock) + MODEL_TOKEN_MARGIN_MS, parseDuration(MAX_MODEL_TOKEN_TTL)));
}

function fixerMayStart(incident: IncidentView): boolean {
  return incident.status !== 'claimed' && incident.status !== 'human-fixing' && !isTerminalStatus(incident.status);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function job(name: JobName, handler: JobModule['handler']): JobModule {
  return { name, handler };
}

// compose ----------------------------------------------------------------------------------------

export const compose: ComposeFn = async (deps) => {
  const { config, state, workflow, env } = deps;
  const log: ComposeLog = deps.log ?? { info: () => undefined, error: () => undefined };
  const overrides = deps.overrides ?? {};
  const clock = (): Date => new Date();
  if (!(state instanceof StateStore)) throw new Error('compose needs the store openState returned');
  const store: StateStore = state;

  // Secrets first, so a misconfigured install fails before anything is built.
  const transportChoice = env['SNAPWING_SLACK_TRANSPORT']?.trim();
  if (transportChoice !== undefined && transportChoice !== '' && transportChoice !== 'http' && transportChoice !== 'socket') {
    throw new Error(`SNAPWING_SLACK_TRANSPORT must be http or socket, not ${transportChoice}`);
  }
  const required = [
    ...REQUIRED_SECRETS,
    ...(overrides.model === undefined ? modelKeySecrets(config) : []),
    ...(transportChoice === 'socket' ? ['SLACK_APP_TOKEN'] : []),
  ];
  if (config.runtime.provider === 'aws' || config.runtime.provider === 'gcp') {
    throw new Error(`runtime provider ${config.runtime.provider} has no fixer runner yet; use local or docker`);
  }
  const fixerImage = env['SNAPWING_FIXER_IMAGE']?.trim() ?? '';
  if (config.runtime.provider === 'docker' && fixerImage === '') throw new Error('the docker runtime needs SNAPWING_FIXER_IMAGE (the fixer image)');
  const s = await readSecrets(deps.secrets, required, OPTIONAL_SECRETS);
  const secret = (name: string): string => {
    const value = s.get(name);
    if (value === undefined) throw new MissingSecretsError([name]);
    return value;
  };

  const workspaceId = await ensureInstallWorkspace(store);
  const getMap = await loadMap(state, env['SNAPWING_MAP']?.trim() || DEFAULT_MAP_FILE, log);
  const configWatch = await createConfigWatch({
    playbookPath: env['SNAPWING_PLAYBOOK']?.trim() || DEFAULT_PLAYBOOK_FILE,
    instructionsPath: env['SNAPWING_INSTRUCTIONS']?.trim() || DEFAULT_INSTRUCTIONS_FILE,
    getMap,
    log,
  });
  const cache = createKvCache(store);
  const workRoot = env['SNAPWING_WORKDIR_ROOT']?.trim() || join(tmpdir(), 'snapwing-work');

  // Platform clients.
  const web = createSlackWeb({ token: secret('SLACK_BOT_TOKEN') });
  const jira: JiraClient = createJiraClient({
    baseUrl: secret('JIRA_BASE_URL'),
    email: secret('JIRA_EMAIL'),
    apiToken: secret('JIRA_API_TOKEN'),
    log: (line) => log.info(`jira: ${line}`),
  });
  const auth: GitHubAuth = createGitHubAuth({ secrets: deps.secrets });
  // Incidents carry the map's `github.com/owner/name`; GitHub wants `owner/name` (github/repo.ts).
  const github = (repo: string): GitHubClient => createGitHubClient(auth, { repo: repoFullName(repo) });
  const gitToken = (permissions: GitHubPermissions) => async (workItem: WorkItemRef) =>
    (await auth.installationToken({ repo: repoFullName(workItem.repo), permissions })).token;
  const remoteUrl = overrides.gitRemoteUrl ?? ((repo: string): string => `https://github.com/${repoFullName(repo)}.git`);
  const customFieldIds = requireCustomFieldIds(
    Object.fromEntries(Object.entries(CUSTOM_FIELD_ENV).map(([field, name]) => [field, secret(name).trim()])),
  );

  const model: ModelPort =
    overrides.model ??
    createModelRouter(
      config.models,
      { anthropic: anthropicProvider, openai: openaiProvider, google: googleProviderFactory },
      Object.fromEntries(Object.values(PROVIDER_KEY_ENV).flatMap((name) => (s.has(name) ? [[name, s.get(name)]] : []))),
    );
  const resolveHarness = overrides.resolveHarness ?? harnessResolver(config.harness);
  const fixerChoice = harnessChoice(config.harness, config.harness.fixer);
  const reviewChoice = harnessChoice(config.harness, config.harness.review);

  // Fixer, review, merge, human path. The runner reports to the reporter, whose hooks need the fixer
  // and review deps, which need the runner: the hooks reach those deps through closures, called only
  // once everything below exists.
  const fixerTokenKeys: FixerTokenKeys = { secret: secret('SNAPWING_FIXER_TOKEN_SECRET'), clock };
  // The model proxy (ADR 0017 amendment 1). Only the docker runner hands out model tokens, so only then
  // is it mounted. The containers' view of the API can differ from the fixer API URL they are given.
  const docker = config.runtime.provider === 'docker';
  const fixerApiUrl = env['SNAPWING_FIXER_API_URL']?.trim() || secret('SNAPWING_PUBLIC_URL');
  const proxyProviders = modelProxyProviders((name) => s.get(name));
  const modelProxy: DockerModelProxy = {
    url: `${(env['SNAPWING_CONTAINER_API_URL']?.trim() || fixerApiUrl).replace(/\/+$/, '')}${MODEL_PROXY_PREFIX}`,
    token: (run) => issueModelToken({ workItemId: run.workItem.id, runId: run.runId, ttl: modelTokenTtl(run.wallClock) }, fixerTokenKeys),
  };
  if (docker) {
    for (const [role, adapter] of [['fixer', config.harness.fixer], ['review', config.harness.review]] as const) {
      const provider = HARNESS_PROVIDER[adapter];
      if (provider !== undefined && proxyProviders[provider] === undefined) {
        log.error(`model proxy: the ${role} harness ${adapter} calls ${provider}, but ${PROVIDER_KEY_ENV[provider]} is not set, so its containers have no model access`);
      }
    }
  }
  const reporter: FixerReporter = createFixerReporter({
    state,
    clock,
    onDone: async ({ incidentId }) => {
      await handleFixerDone(fixerDeps, incidentId);
      await startReview(reviewDeps, { incidentId });
    },
    onFailed: async ({ incidentId }) => {
      await handleFixerFailed(fixerDeps, incidentId);
    },
  });
  const runner: RunnerPort & ScratchSweeper =
    config.runtime.provider === 'docker'
      ? createDockerRunner({
          image: fixerImage,
          env: {
            apiUrl: fixerApiUrl,
            // Valid for the whole run plus the final report, however long its wall clock (#266).
            token: (j) => issueFixerToken({ workItemId: j.workItem.id, incidentId: j.workItem.id, ttl: fixerTokenTtl(j.budget.wallClock) }, fixerTokenKeys),
            modelProxy,
          },
          // The work item is prepared on the host before the container starts (#256).
          artifacts: store,
          git: { token: gitToken(FIXER_GIT_PERMISSIONS), remoteUrl },
          workdirRoot: join(workRoot, 'fixer'),
        })
      : createLocalRunner({
          resolveHarness,
          artifacts: store,
          workdirRoot: join(workRoot, 'fixer'),
          git: { token: gitToken(FIXER_GIT_PERMISSIONS), remoteUrl },
          onCheckpoint: async (run, checkpoint) => {
            await reporter.checkpoint(targetOf(run.job.workItem), checkpoint);
          },
          onFinished: async (run, result) => {
            const target = targetOf(run.job.workItem);
            if (result.outcome === 'done' && result.prNumber !== undefined) {
              await reporter.done(target, { prNumber: result.prNumber, branch: result.branch, summary: result.summary, testsAdded: result.testsAdded });
            } else if (result.outcome === 'done') {
              await reporter.failed(target, { reason: 'the harness finished without opening a pull request', partialBranch: result.branch, attempts: 1 });
            } else if (result.outcome === 'failed') {
              await reporter.failed(target, result);
            }
            // `stopped`: the stop is already in the log; the run only acknowledges it.
          },
        });

  const fixerDeps: FixerDeps = {
    workspaceId,
    state,
    workflow,
    runner,
    github: createFixerGitHub(auth),
    config: { harness: fixerChoice },
    clock,
  };
  const reviewDeps: ReviewDeps = {
    workspaceId,
    state,
    workflow,
    github,
    harness: resolveHarness(reviewChoice),
    // The fixer's runner: with docker (`runTests`, `runReview`) the regression proof's test command and
    // the review agent (`config.harness`, `<harness review>`) run only inside containers; the local
    // runner has neither, so both run on the host (ADR 0017, development only).
    runner,
    git: { token: gitToken(REVIEW_GIT_PERMISSIONS), remoteUrl },
    workdirRoot: join(workRoot, 'review'),
    config: { testCommand: (): string | undefined => env['SNAPWING_TEST_COMMAND']?.trim() || undefined, harness: reviewChoice },
    clock,
  };
  const mergeDeps: MergeDeps = { workspaceId, state, workflow, github, merge: config.merge, map: getMap, clock };

  const oauth = createGitHubOAuth({ state, secrets: deps.secrets, workspaceId });
  const humanDeps: HumanDeps = {
    workspaceId,
    state,
    workflow,
    chat: 'slack',
    github,
    codeowners: (repo) => createCodeownersResolver(auth, { repo: repoFullName(repo) }),
    identity: oauth,
    map: getMap,
    clock,
  };
  const humanReviewDeps: HumanReviewDeps = {
    ...humanDeps,
    chatOut: overrides.prReadyChat ?? createSlackPrReadyChat({ web, state, onError: (e) => log.error(`pr card record: ${message(e)}`) }),
    cache,
    onError: (e) => log.error(`pr card link prompt: ${message(e)}`),
  };
  const prActions = createPrActions({
    ...humanDeps,
    stopIncident: (input) => stopIncident(fixerDeps, input),
    revert: (incidentId, actor, opts) => revert(mergeDeps, incidentId, actor, opts),
  });

  // Slack and the engine.
  // One `auth.test` at startup gives the bot user id and the workspace subdomain (the Conversation Link).
  const identity =
    overrides.slackBotUserId !== undefined && overrides.slackWorkspaceDomain !== undefined ? undefined : await slackIdentity(secret('SLACK_BOT_TOKEN'));
  const botUserId = overrides.slackBotUserId ?? identity?.userId ?? '';
  const workspaceDomain = overrides.slackWorkspaceDomain ?? identity?.domain;
  const adapter = createSlackAdapter({
    web,
    signingSecret: secret('SLACK_SIGNING_SECRET'),
    botUserId,
    ...(workspaceDomain === undefined ? {} : { workspaceDomain }),
    getMap,
    state,
    onError: (e) => log.error(`slack: ${message(e)}`),
    clock,
  });
  const slackContext = createSlackContextSource(web);
  const engineDeps: EngineDeps = {
    workspaceId,
    state,
    workflow,
    model,
    adapters: new Map([['slack', adapter]]),
    context: new Map([['slack', slackContext]]),
    jiraSearch: jiraSearch(jira),
    cache,
    map: getMap,
    // Getters, so a hot reload (config-watch.ts) reaches the next call. #291's successor: read
    // `deps.instructions?.()` in engine/steps.ts and pass it to plan, maybeAsk, and SynthesisContext.
    playbook: configWatch.playbook,
    instructions: configWatch.instructions,
    repoReader: (resolution) => (resolution.repo === undefined || resolution.repo === '' ? undefined : createGitHubRepoReader(auth, { repo: repoFullName(resolution.repo) })),
    // With the subscriber the engine never posts `filed` itself; the status projector below posts it.
    status: createStatusSubscriber({ workspaceId, clock }),
    clock,
    options: { loadImage: slackContext.loadImage },
    // A 2.1: a claim handed back on an issue already In Progress starts the fixer directly.
    startFixer: (incidentId) => startFixer(fixerDeps, { incidentId, attempt: 1 }),
  };
  const engine = new IncidentOrchestrator(engineDeps);

  const interactivity = createSlackInteractivity({
    web,
    state,
    workspaceId,
    orchestrator: engine,
    stopIncident: (input) => stopIncident(fixerDeps, input),
    prActions,
    getMap,
    githubLinked: (userId) => oauth.isLinked({ chat: 'slack', userId }),
    botUserId,
    clock,
  });
  const slackStatusQuery = createSlackStatusQuery({ web, state, workspaceId, getMap, botUserId, clock, onError: (e) => log.error(`slack status query: ${message(e)}`) });
  const slackHome = createSlackHome({
    web,
    state,
    workspaceId,
    getMap,
    identity: oauth,
    pullRequest: (repo, number) => github(repo).getPullRequest(number),
    clock,
    onError: (e) => log.error(`slack home: ${message(e)}`),
  });
  const appToken = s.get('SLACK_APP_TOKEN');
  const socket = transportChoice === 'socket' || ((transportChoice === undefined || transportChoice === '') && appToken !== undefined);
  const slackError = (e: unknown): void => log.error(`slack: ${message(e)}`);
  const transportBase = {
    adapter: observeReactionRemoval(adapter, interactivity, slackError),
    handleInbound: (source: Parameters<IncidentOrchestrator['handleInbound']>[0], raw: unknown) => engine.handleInbound(source, raw),
    onAction: (payload: Parameters<typeof interactivity.onAction>[0]) => interactivity.onAction(payload),
    status: slackStatusQuery,
    home: slackHome,
    onError: slackError,
  };
  const transport = socket
    ? createSlackTransport({ ...transportBase, mode: 'socket', appToken: appToken ?? '', ...(overrides.openSocket === undefined ? {} : { openSocket: overrides.openSocket }) })
    : createSlackTransport({ ...transportBase, mode: 'http' });

  // Projectors.
  const pollIntervalMs = overrides.projectorPollMs;
  // The webhook and the reconciler resolve the in-progress status the way the projector does (#269).
  const jiraStatuses = createStatusResolver(jira, config.jira.statuses);
  const jiraProjector = createJiraProjector({
    state,
    client: jira,
    workspaceId,
    continueIncident: (incidentId) => engine.continueIncident(incidentId),
    customFieldIds,
    statusOverrides: config.jira.statuses,
    loadScreenshot: screenshotLoader(web),
    now: clock,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    onError: (e) => log.error(`jira projector: ${message(e)}`),
  });
  const statusProjector = createSlackStatusProjector({
    state,
    web,
    cache,
    workspaceId,
    getMap,
    now: clock,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    onError: (e) => log.error(`slack status projector: ${message(e)}`),
  });

  // Reconciler.
  const reconcileDeps: ReconcileDeps = {
    state,
    workflow,
    sources: createReconcileSources({
      github: auth,
      jira,
      jiraChangelog: { baseUrl: secret('JIRA_BASE_URL'), email: secret('JIRA_EMAIL'), apiToken: secret('JIRA_API_TOKEN') },
    }),
    followUp: async (event, incident) => {
      try {
        await reconcileFollowUp(event, incident);
      } catch (e) {
        // The event committed, so the next run will not emit it again, and nothing retries this.
        log.error(`reconcile: follow-up of ${event.type} for incident ${incident.id} FAILED after the event committed and will not be retried: ${message(e)}`);
        throw e;
      }
    },
    clock,
  };
  async function reconcileFollowUp(event: IncidentEvent<ReconciledEventType>, incident: IncidentView): Promise<void> {
    if (event.type === 'ci-green') {
      await startMergeEvaluate(mergeDeps, incident.id);
    } else if (event.type === 'ci-red') {
      await retryFixerAfterCiRed(fixerDeps, incident.id);
    } else if (event.type === 'jira-transitioned') {
      const payload = (event as IncidentEvent<'jira-transitioned'>).payload;
      if (incident.jiraKey !== undefined && (await isInProgressStatus(jiraStatuses, incident.jiraKey, payload.to)) && fixerMayStart(incident)) await startFixer(fixerDeps, { incidentId: incident.id, attempt: 1 });
    }
  }

  // Routes.
  const routes: Route[] = [
    ...transport.routes,
    { method: 'POST', path: JIRA_WEBHOOK_PATH, handler: createJiraWebhookRoute({
      fixer: fixerDeps,
      jira,
      statuses: jiraStatuses,
      ...(s.has('JIRA_WEBHOOK_SECRET') ? { secret: secret('JIRA_WEBHOOK_SECRET') } : {}),
      implementationPromptFieldId: customFieldIds['Implementation Prompt'] ?? '',
    }) },
    {
      method: 'POST',
      path: GITHUB_WEBHOOK_PATH,
      handler: createGitHubWebhookRoute({
        workspaceId,
        state,
        workflow,
        clock,
        secret: secret('GITHUB_WEBHOOK_SECRET'),
        github,
        botLogin: `${secret('GITHUB_APP_SLUG').trim()}[bot]`,
      }),
    },
    // With docker the container holds no git token: its wrapper asks for a fresh one per git
    // operation (`GET /fixer/:workItemId/git-token`, #266), with the fixer's scopes on its one repo.
    ...createFixerRoutes(
      reporter,
      fixerTokenVerifier(fixerTokenKeys),
      docker
        ? { gitToken: createFixerGitToken({ state, mint: (repo) => auth.installationToken({ repo: repoFullName(repo), permissions: FIXER_GIT_PERMISSIONS }) }) }
        : {},
    ),
    ...(docker ? createModelProxyRoutes({ verify: modelTokenVerifier(fixerTokenKeys), providers: proxyProviders, clock }) : []),
    ...oauth.routes,
  ];
  if (!s.has('JIRA_WEBHOOK_SECRET')) log.info(`JIRA_WEBHOOK_SECRET is not set: ${JIRA_WEBHOOK_PATH} accepts unauthenticated deliveries`);

  // Jobs.
  const jobs: JobModule[] = [
    job('incident.process', (j) => engine.process(j)),
    job('fixer.run', async (j) => {
      if (!isFixerRunData(j.data)) throw new Error('fixer.run: malformed job data');
      await runFixerJob(fixerDeps, j.data);
    }),
    job('timer.fixer-budget', async (j) => {
      if (!isFixerBudgetData(j.data)) throw new Error('timer.fixer-budget: malformed job data');
      await fixerBudgetExpired(fixerDeps, j.data);
    }),
    job('review.run', async (j) => {
      if (!isReviewRunData(j.data)) throw new Error('review.run: malformed job data');
      await runReviewJob(reviewDeps, j.data);
    }),
    job('merge.evaluate', async (j) => {
      if (!isMergeEvaluateData(j.data)) throw new Error('merge.evaluate: malformed job data');
      const outcome = await evaluateMerge(mergeDeps, j.data);
      // The human path (main 11.2): after `review-passed` at levels 1 and 2, and after a level 3 `held`.
      // `requestHumanReview` decides from the log and posts each card once.
      if (outcome.outcome !== 'merged') await requestHumanReview(humanReviewDeps, j.data.incidentId);
    }),
    job('timer.revert', async (j) => {
      if (!isMergeEvaluateData(j.data)) throw new Error('timer.revert: malformed job data');
      await revertWindowClosed(mergeDeps, j.data.incidentId);
    }),
    job(RECONCILE_JOB, async () => {
      const report = await runReconcile(reconcileDeps);
      if (report.failures.length > 0) {
        const ids = report.failures.map((f) => `${f.incidentId} (${f.stage})`).join(', ');
        throw new AggregateError(
          report.failures.map((f) => f.error),
          `reconcile: ${report.failures.length} incident(s) failed: ${ids}`,
        );
      }
    }),
  ];

  // Both processes read the files, so each starts the watch (start and stop are idempotent).
  const configService: ComposedService = { name: 'playbook and instructions watch', start: () => configWatch.start(), stop: () => configWatch.stop() };
  const apiServices: ComposedService[] = [
    { name: `slack ${socket ? 'socket mode' : 'http'} transport`, start: () => transport.start(), stop: () => transport.stop() },
    configService,
  ];
  const workerServices: ComposedService[] = [
    {
      // Scratch directories a crashed or restarted server left behind (#266). Never fails startup.
      name: 'fixer scratch sweep',
      start: async () => {
        try {
          const swept = await runner.sweep({ maxWallClock: fixerBudget(fixerDeps.config).wallClock });
          if ('skipped' in swept && typeof swept.skipped === 'string') log.error(`fixer scratch sweep skipped: ${swept.skipped}`);
          if (swept.removed.length > 0) log.info(`fixer scratch sweep removed ${swept.removed.length} stale run director${swept.removed.length === 1 ? 'y' : 'ies'}: ${swept.removed.join(', ')}`);
        } catch (e) {
          log.error(`fixer scratch sweep: ${message(e)}`);
        }
      },
      stop: () => Promise.resolve(),
    },
    { name: 'reconcile schedule', start: () => workflow.cron(RECONCILE_JOB, DEFAULT_RECONCILE_CRON), stop: () => Promise.resolve() },
    { name: 'jira projector', start: async () => jiraProjector.start(), stop: () => jiraProjector.stop() },
    { name: 'slack status projector', start: async () => statusProjector.start(), stop: () => statusProjector.stop() },
    configService,
  ];
  const proxied = docker ? `, model proxy for ${Object.keys(proxyProviders).join(', ') || 'no provider'} at ${modelProxy.url}` : '';
  log.info(`composed: slack ${socket ? 'socket mode' : 'http'}, runner ${config.runtime.provider}${proxied}, workspace ${workspaceId}`);

  return {
    routes,
    jobs,
    apiServices,
    workerServices,
    async metrics() {
      return mergePrometheus([await jiraProjector.metrics(), await statusProjector.metrics()]);
    },
    deps: { fixer: fixerDeps, review: reviewDeps },
  };
};

/**
 * Joins Prometheus text blocks so each metric family appears once: its first `# HELP` and `# TYPE`,
 * then every sample of it from every block, in order. Both projectors report `snapwing_outbox_parked_*`.
 */
export function mergePrometheus(blocks: readonly string[]): string {
  const families = new Map<string, { meta: string[]; samples: string[] }>();
  const family = (name: string): { meta: string[]; samples: string[] } => {
    let f = families.get(name);
    if (f === undefined) {
      f = { meta: [], samples: [] };
      families.set(name, f);
    }
    return f;
  };
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (line.trim() === '') continue;
      const meta = /^# (HELP|TYPE) (\S+)/.exec(line);
      if (meta !== null) {
        const f = family(meta[2] ?? '');
        if (!f.meta.some((m) => m.startsWith(`# ${meta[1] ?? ''} `))) f.meta.push(line);
        continue;
      }
      family(/^[^{\s]+/.exec(line)?.[0] ?? line).samples.push(line);
    }
  }
  const lines = [...families.values()].flatMap((f) => [...f.meta, ...f.samples]);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** The local runner reports for the fixer's work item, which is the incident (`fixer.run`). */
function targetOf(workItem: WorkItemRef): FixerTarget {
  return { workItemId: workItem.id, incidentId: workItem.id };
}
