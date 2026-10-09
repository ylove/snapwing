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
//                wraps the adapter so a removed trigger reaction reaches the interactivity too, and
//                `observeSignals` hands every reaction and channel thread reply to the Slack signals
//                (`handleSignal`, A 1.2 to 1.4). The engine's `onCaptured` adopts the reactions
//                that landed on the anchor before the incident existed (`adoptPendingSignals`).
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
//   Phase 4      (the "Phase 4 wiring" section) claims mid-flight (A 2.2): after each claim
//                commits, `handleMidFlightClaim` posts the Slack card, whose taps reach `answerMidFlight`
//                (Stop assigns the claimer through the Jira outbox). Holds and claim expiry (A 2.3, 2.4):
//                `holds.onEvent` after each claim and each signal, thread nudges through `say`, the
//                engine's `handleClaim` after a release. The instructions gate (A 6.4) on the fixer and
//                merge deps. Digests (A 4.6) and the ux-friction scan (A 5.3) on the worker. Channel
//                members (A 4.4) in kv for the notification policy, from `conversations.members` and the
//                membership events. Modules that register their own handlers (`register()`,
//                `registerMidFlightJobs`, `registerDigestJobs`) get a port whose `work` becomes a job
//                module here and whose `cron` waits for the worker (`registrar`).
//   Signals      (the "Signal side effects, ladders, monitoring" section) the reaction ladder (A
//                1.4) is the signal handler's `escalation`, posting through the escalation chat; a
//                removed reaction is reversed by the handler's `planRemoval` (A 1.6). Thread replies
//                also reach `handleTextSignal` and claim reactions `acceptHandoff` (A 3) through the
//                Slack signals, whose card taps come before the interactivity's. The escalation
//                ladders (A 6.2, paging with `PAGERDUTY_ROUTING_KEY_<SERVICE>` or
//                `PAGERDUTY_ROUTING_KEY` from the secrets port) and active monitoring (A 4.5, polling
//                the reconciler's sources) register their timers through the registrar; the worker
//                service `active monitoring` reads the log and evaluates both after every event that
//                can change their facts (a priority, a surface, a close, monitoring starting or
//                stopping, an outage step), and the monitor's stall timer evaluates the ladders.
//   Capture API  (#3, the "Capture API" section; ADR 0022) Raycast and the CLI: the capture adapters
//                (`cli`, `raycast`) and their context source in the engine, their images in the
//                vision pass and on the Jira issue (deleted from kv once attached, or by the worker's
//                `capture images` once a capture ends unfiled), and the bearer-token routes at
//                capture-client's `CAPTURE_ROUTES`. `/healthz` reports each chat platform through
//                `health()`.
//   Chat seam    (`server/chat.ts`) every outbound chat effect outside an adapter's inbound path and
//                the status projectors (thread, channel, and person posts, mentions, the PR card, the
//                text-signal cards, the mid-flight card, channel members, the GitHub link check) goes
//                through the chat router, which picks the platform's `ChatSurface` by incident source
//                (Slack's is `adapters/slack/chat-surface.ts`, Teams' `adapters/teams/chat-surface.ts`).
//                Deps that carry one platform (`HumanDeps.chat`, the PR actions) are built per platform.
//                Slack is optional: its secrets are required only once its bot token (or app token) is set
//                (or its transport named); an app created but not installed (#240) is pending: off, one log line.
//                With no chat platform at all startup fails naming the Slack group.
//   Teams        (the "Teams" sections) optional the same way: on when any of TEAMS_APP_ID,
//                TEAMS_APP_PASSWORD, TEAMS_TENANT_ID, or TEAMS_PUBLIC_URL is set, and then the first three
//                are required. One Bot Connector client (client credentials against the tenant), wrapped
//                by `rememberTeamsCards` so a tap is answered with the card it came from, serves the
//                adapter, the chat surface, the status projector, the interactivity, the status query, and
//                the queue. The adapter and its Graph context source sit in the engine under `teams`. The
//                transport's routes (`/teams/messages`, `/teams/notifications`, `/teams/lifecycle`) check
//                the Bot Framework JWT, or the subscriptions' `clientState` (derived from
//                SNAPWING_ENCRYPTION_KEY, `teamsClientState`), before anything else, and every
//                authenticated activity refreshes its sender's record (`rememberUser`), so a personal chat
//                opens with their `29:` id. The Teams signals share the Slack signals' deps and
//                `afterSignal`. The worker runs the Teams status projector and keeps one Graph subscription
//                per mapped team (notifications to TEAMS_PUBLIC_URL, else SNAPWING_PUBLIC_URL). `/healthz`
//                reports Teams' mode: reduced while any mapped team lacks the RSC grant. A post that no
//                activity named a serviceUrl for (a DM about a Slack incident) goes to TEAMS_SERVICE_URL,
//                else the public Bot Framework endpoint. The bot token goes only to the documented Bot
//                Connector hosts (`TEAMS_SERVICE_HOSTS`) and TEAMS_SERVICE_URL's host, as Connector calls and
//                as attachment downloads; an activity from a tenant other than TEAMS_TENANT_ID is ignored (#269).
//
// GitHub tokens are scoped per use: the fixer's checkout gets `contents: write` and
// `pull_requests: write` on its one repo and never `workflows` (GitHub then rejects any push that
// touches `.github/workflows`, the real guard; the workdir hooks can be skipped). With docker the
// container holds no git token: `GET /fixer/:workItemId/git-token` mints one with those scopes
// whenever its git asks, so a run may outlive a token's hour, and the fixer token's TTL is the
// run's wall clock plus a margin (`fixerTokenTtl`). The worker's first service sweeps the runner's
// stale scratch directories (`sweep`, older than the fixer wall clock plus a margin). The review's
// checkout gets `contents: read` and `metadata: read` only; the review posts through the server's own
// client, never from inside the harness.
//
// Startup fails, listing every missing secret by name (never a value), before anything is built.

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, HarnessAdapter, HarnessConfig, ModelProvider } from '@snapwing/pipeline/config/app-config.ts';
import type { EventType, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isFixerBudgetData, isFixerRunData, isReviewRunData, type JobName } from '@snapwing/pipeline/contracts/jobs.ts';
import { LOG_START, StateNotFoundError, type IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import type { ChannelSource } from '@snapwing/pipeline/contracts/incident.ts';
import type { AnyIngestionAdapter, ContextSource, EngineDeps } from '@snapwing/pipeline/engine/deps.ts';
import type { LoadImage, LoadRecording } from '@snapwing/pipeline/context/vision/index.ts';
import { IncidentOrchestrator } from '@snapwing/pipeline/engine/orchestrator.ts';
import { fixerBudget, fixerBudgetExpired, handleFixerDone, handleFixerFailed, runFixerJob, startFixer, type FixerDeps } from '@snapwing/pipeline/fixer/job.ts';
import { stopIncident } from '@snapwing/pipeline/fixer/stop.ts';
import { BUDGET_SPENT_TEXT, countModelCalls, createChatLimits } from '@snapwing/pipeline/policy/limits.ts';
import { answerMidFlight, handleMidFlightClaim, registerMidFlightJobs, type MidFlightDeps, type MidFlightPorts } from '@snapwing/pipeline/fixer/claims.ts';
import { registerDigestJobs } from '@snapwing/pipeline/notify/digest.ts';
import { createHolds } from '@snapwing/pipeline/signals/holds.ts';
import { createUxFriction } from '@snapwing/pipeline/signals/ux-friction.ts';
import { createReactionEscalation } from '@snapwing/pipeline/signals/score.ts';
import type { LinkedIncidentRequest, TextSignalDeps } from '@snapwing/pipeline/signals/text.ts';
import { createActiveMonitor, type PolledEventType } from '@snapwing/pipeline/monitor/active.ts';
import { createEscalationLadders, type LadderChange } from '@snapwing/pipeline/monitor/ladder.ts';
import { jiraFieldBatchKey } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { adoptPendingSignals, type SignalDeps, type SignalEngine } from '@snapwing/pipeline/signals/handler.ts';
import { isTerminalStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { createPrActions, type HumanPrActions } from '@snapwing/pipeline/merge/actions.ts';
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
import type { ChatPlatform, OpenedState } from '@snapwing/pipeline/ports/state.ts';
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
import type { PlatformHealth } from '@snapwing/capture-client/wire.ts';
import {
  CAPTURE_SOURCES,
  captureImageLoader,
  captureScreenshotLoader,
  createCaptureAdapter,
  createCaptureContextSource,
  dropEndedCaptureImage,
  releaseCaptureScreenshots,
} from '../adapters/capture/adapter.ts';
import { createCaptureRoutes } from '../adapters/capture/routes.ts';
import { createSlackAdapter, type SlackInbound } from '../adapters/slack/adapter.ts';
import { createSlackAuthorOf } from '../adapters/slack/authorship.ts';
import { createSlackChatSurface, type SlackChatSurface } from '../adapters/slack/chat-surface.ts';
import { CHANNEL_MEMBERS_REFRESH_MS, createSlackChannelAccess, observeChannelMembers } from '../adapters/slack/channel-members.ts';
import { createTeamsStatusAccess } from '../adapters/teams/channel-members.ts';
import { createSlackInteractivity, observeReactionRemoval } from '../adapters/slack/interactivity.ts';
import { createSlackContextSource } from '../adapters/slack/reader.ts';
import { createSlackHome } from '../adapters/slack/home.ts';
import { createSlackStatusProjector } from '../adapters/slack/status-projector.ts';
import { createSlackStatusQuery } from '../adapters/slack/status-query.ts';
import { createSlackSignals, observeSignals, type SlackSignalOutcome } from '../adapters/slack/signals.ts';
import { SLACK_SHORTCUT_CALLBACK_ID } from '../adapters/slack/normalize.ts';
import { createPagerDutyPager } from '../pager/pagerduty.ts';
import { createSlackTransport, type SocketLike } from '../adapters/slack/transport.ts';
import { createSlackWeb, type SlackWeb } from '../adapters/slack/web.ts';
import { createTeamsAdapter, type TeamsAdapter, type TeamsInbound } from '../adapters/teams/adapter.ts';
import { createBotTokenSource, createGraphTokenSource, verifyBotFrameworkJwt } from '../adapters/teams/auth.ts';
import { createTeamsChatSurface, type TeamsChatSurface } from '../adapters/teams/chat-surface.ts';
import { allowTeamsServiceUrl, createTeamsConnector } from '../adapters/teams/connector.ts';
import { conversationFromActivity, readTeamsConversation, readTeamsUser, rememberTeamsConversation } from '../adapters/teams/conversations.ts';
import { TEAMS_ACTION_COMMAND_ID, TEAMS_SUBMIT_ACTION } from '../adapters/teams/normalize.ts';
import { createTeamsGraph } from '../adapters/teams/graph.ts';
import { createKvTeamsCardStore, createTeamsInteractivity, rememberTeamsCards } from '../adapters/teams/interactivity.ts';
import { createTeamsQueue } from '../adapters/teams/queue.ts';
import { createTeamsContextSource } from '../adapters/teams/reader.ts';
import { createTeamsSignals, type TeamsSignalOutcome } from '../adapters/teams/signals.ts';
import { createTeamsStatusProjector } from '../adapters/teams/status-projector.ts';
import { createTeamsStatusQuery } from '../adapters/teams/status-query.ts';
import { createTeamsSubscriptions, SUBSCRIPTION_TICK_MS, teamIdsInMap, type TeamsSubscriptions, type VerifiedNotification } from '../adapters/teams/subscriptions.ts';
import {
  createTeamsModeCheck,
  createTeamsTransport,
  TEAMS_LIFECYCLE_PATH,
  TEAMS_NOTIFICATIONS_PATH,
  teamsQueueRoutes,
  type TeamsDispatchResult,
} from '../adapters/teams/transport.ts';
import { createQueue } from '../status/queue.ts';
import { createPullRequestVerifier } from '../fixer-api/verify-pr.ts';
import { createFixerReporter,type FixerReporter, type FixerTarget } from '../fixer-api/reporter.ts';
import { createFixerRoutes } from '../fixer-api/routes.ts';
import { createFixerGitToken } from '../fixer-api/git-token.ts';
import { fixerTokenTtl, fixerTokenVerifier, issueFixerToken, type FixerTokenKeys } from '../fixer-api/token.ts';
import { createGitHubAuth, type GitHubAuth, type GitHubPermissions } from '../github/auth.ts';
import { createGitHubClient, type GitHubClient } from '../github/client.ts';
import { createCodeownersResolver } from '../github/codeowners.ts';
import { createFixerGitHub } from '../github/fixer-github.ts';
import { createGitHubOAuth } from '../github/oauth.ts';
import { createGitHubProjector } from '../github/projector.ts';
import { createGitHubRepoReader } from '../github/repo-reader.ts';
import { createRepoTrees } from '../github/repo-trees.ts';
import { repoFullName } from '../github/repo.ts';
import { createJiraClient, jiraSearch, type JiraClient } from '../jira/client/index.ts';
import { createJiraProjector } from '../jira/projector/drain.ts';
import { CUSTOM_FIELD_ENV, requireCustomFieldIds } from '../jira/projector/fields.ts';
import { createStatusResolver } from '../jira/projector/statuses.ts';
import { fetchScreenshot, screenshotFilename, textToAdf, type LoadScreenshot } from '../jira/projector/ops.ts';
import { createModelProxyRoutes, MODEL_PROXY_PREFIX, type ModelProviderUpstream, type ModelProxyProvider } from '../model-proxy/routes.ts';
import { issueModelToken, MAX_MODEL_TOKEN_TTL, modelTokenVerifier } from '../model-proxy/token.ts';
import { createDockerRunner, type DockerModelProxy } from '../providers/docker/runner.ts';
import { createReconcileSources } from '../reconcile/sources.ts';
import { createGitHubWebhookRoute, GITHUB_WEBHOOK_PATH } from '../webhooks/github.ts';
import { createJiraWebhookRoute, isInProgressStatus, JIRA_WEBHOOK_PATH } from '../webhooks/jira.ts';
import { createChatRouter, personByChatId, type ChatRouter, type ChatSurface } from './chat.ts';
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
/** How often the worker scans the log for ux friction (A 5.3); the pattern window is days, so this is often enough. */
export const UX_FRICTION_SCAN_MS = 15 * 60_000;
/** How often the worker reads new events for active monitoring and the escalation ladders. */
export const MONITOR_TRIGGER_POLL_MS = 2_000;
/** When the worker deletes expired kv rows (#271): hourly, on the hour. */
export const KV_SWEEP_CRON = '0 * * * *';
/** Where the worker keeps its place in the log for them (kv). */
export const MONITOR_CURSOR_KEY = 'monitor:triggers-cursor';
/** Where the worker keeps its place in the log for capture screenshots to delete (kv). */
export const CAPTURE_IMAGES_CURSOR_KEY = 'capture:images-cursor';
/**
 * Events after which active monitoring (A 4.5) and the escalation ladders (A 6.2) are evaluated: a
 * priority (`planned`, `escalated`, `jira-priority-changed`), a surface (`resolved`, `corrected`),
 * monitoring starting or stopping (the reaction ladder's outage step appends a start), and a close.
 */
export const MONITOR_TRIGGERS: ReadonlySet<EventType> = new Set<EventType>([
  'resolved',
  'corrected',
  'planned',
  'escalated',
  'jira-priority-changed',
  'monitoring-started',
  'monitoring-stopped',
  'closed',
  'not-a-bug',
  'linked-to-existing',
  'resolution-signal',
  'user-side',
  'capture-cancelled',
]);

/**
 * The Slack group (CONTEXT.md 6b), required together whenever Slack is configured: any of them set, or
 * `SNAPWING_SLACK_TRANSPORT` set. Socket Mode also requires `SLACK_APP_TOKEN`.
 */
export const SLACK_SECRETS: readonly string[] = Object.freeze(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);

/**
 * The Teams group, required together whenever Teams is configured: any of them set, or TEAMS_PUBLIC_URL
 * set. The tenant is the authority for both the Bot Connector and the Graph tokens (single-tenant bot).
 */
export const TEAMS_SECRETS: readonly string[] = Object.freeze(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID']);

/** Where a proactive Teams post goes when no activity has named a serviceUrl yet (public cloud); TEAMS_SERVICE_URL overrides it. */
export const TEAMS_DEFAULT_SERVICE_URL = 'https://smba.trafficmanager.net/teams/';

/**
 * Secrets every `snapwing serve` needs (CONTEXT.md 6b), whatever its chat platforms. Each configured
 * platform adds its group (`SLACK_SECRETS`); model keys and per-provider secrets are added per config.
 */
export const REQUIRED_SECRETS: readonly string[] = Object.freeze([
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
 * Read when present: Socket Mode, the Jira webhook's shared secret, Teams' public URL and default
 * serviceUrl, and every model provider key (the model proxy serves each provider whose key is set,
 * whether or not a task routes to it).
 */
export const OPTIONAL_SECRETS: readonly string[] = Object.freeze([
  'SLACK_APP_TOKEN',
  'JIRA_WEBHOOK_SECRET',
  'TEAMS_PUBLIC_URL',
  'TEAMS_SERVICE_URL',
  ...Object.values(PROVIDER_KEY_ENV),
]);

/** How long a model token outlives its run's wall clock, so the run's last call is not refused. */
export const MODEL_TOKEN_MARGIN_MS = 5 * 60_000;

/** The model provider each CLI harness calls; its containers need that provider's proxy routes. */
const HARNESS_PROVIDER: Partial<Record<HarnessAdapter, ModelProxyProvider>> = { 'claude-code': 'anthropic', codex: 'openai', gemini: 'google' };

/** Startup found secrets unset. The message names them; it never carries a value. */
export class MissingSecretsError extends Error {
  override readonly name = 'MissingSecretsError';
  /** `why`, when given, leads the message (no chat platform is configured). */
  constructor(
    readonly missing: readonly string[],
    why?: string,
  ) {
    super(`${why === undefined ? '' : `${why}: `}missing secrets: ${missing.join(', ')} (set them in the env file or the provider's secret store)`);
  }
}

/** The values onboarding writes when it creates the Slack app, before any install: with no bot token they mean pending. */
export const SLACK_CREATION_SECRETS: readonly string[] = Object.freeze(['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET']);

/** The next step once the workspace admin approves the Slack install. */
const SLACK_INSTALL_PENDING_NEXT = 'once the Slack install is approved, run `snapwing onboard --step slack`';

/** The one line serve logs when the Slack app exists but SLACK_BOT_TOKEN is not set yet. */
export const SLACK_INSTALL_PENDING = `slack: the app is created but its install is pending approval (no SLACK_BOT_TOKEN yet), so Slack is off; ${SLACK_INSTALL_PENDING_NEXT}`;

/** What startup says when no chat platform is configured: it names the Slack group, and the Teams one. */
export const NO_CHAT_PLATFORM = `no chat platform is configured (Slack needs its group of secrets; Teams needs ${TEAMS_SECRETS.join(', ')})`;

/**
 * The `clientState` of the Graph subscriptions, which Graph echoes on every notification: derived from
 * SNAPWING_ENCRYPTION_KEY, so every replica and restart agree and no secret is added. 43 characters
 * (Graph allows 128).
 */
export function teamsClientState(encryptionKey: string): string {
  return createHmac('sha256', encryptionKey).update('snapwing teams graph client state').digest('base64url');
}

/** What the Teams test seam hands the dispatcher: an activity, or Graph change notifications. */
export type TeamsInjectInput = { readonly activity: Record<string, unknown> } | { readonly notifications: readonly VerifiedNotification[] };
/** The Teams test seam itself: resolves with the dispatcher's answer once the work it started has settled. */
export type TeamsInject = (input: TeamsInjectInput) => Promise<TeamsDispatchResult>;

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
  /**
   * Chat surfaces besides Slack's (the chat seam), routed by incident source like Slack's. One of
   * them counts as a configured chat platform, so Slack may then be left unconfigured.
   */
  chatSurfaces?: readonly ChatSurface[];
  /** Poll interval of both projectors, in milliseconds. */
  projectorPollMs?: number;
  /**
   * The e2e tier's way in to Teams (no API presses a Teams card button, as with Slack): called once with a
   * function that hands an activity or Graph notifications to the dispatcher past authentication. Only
   * what it hands in skips the checks; the HTTP routes keep them. Ignored without Teams.
   */
  teamsInject?: (inject: TeamsInject) => void;
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
  /** Each configured chat platform for `/healthz` (capture-client's `PlatformHealth`, #3). */
  health?(): Promise<readonly PlatformHealth[]>;
  /** The wired fixer and review deps and the chat router, so tests can check what points at what. */
  readonly deps?: { readonly fixer: FixerDeps; readonly review: ReviewDeps; readonly chat: ChatRouter };
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

/** The bot's own user id, its bot id, the workspace's team and enterprise ids, and its subdomain, from one `auth.test` call. */
async function slackIdentity(token: string): Promise<{ userId: string; botId?: string; teamId?: string; enterpriseId?: string; domain?: string }> {
  const res = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; user_id?: string; bot_id?: string; team_id?: string; enterprise_id?: string; url?: string; error?: string };
  if (body.ok !== true || typeof body.user_id !== 'string') throw new Error(`slack auth.test failed: ${body.error ?? `http_${res.status}`}`);
  return {
    userId: body.user_id,
    ...(typeof body.bot_id === 'string' && body.bot_id !== '' ? { botId: body.bot_id } : {}),
    ...(typeof body.team_id === 'string' && body.team_id !== '' ? { teamId: body.team_id } : {}),
    ...(typeof body.enterprise_id === 'string' && body.enterprise_id !== '' ? { enterpriseId: body.enterprise_id } : {}),
    ...workspaceDomain(body.url),
  };
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

/**
 * Each chat's loader in turn, the first answer winning. Every loader refuses a host it does not own
 * (Slack's anything but slack.com, Teams' anything but Graph, SharePoint, and the Bot Framework), so a
 * token only ever goes to its own platform.
 */
function firstOf<A, R>(loaders: readonly ((input: A) => Promise<R | undefined>)[]): ((input: A) => Promise<R | undefined>) | undefined {
  if (loaders.length === 0) return undefined;
  return async (input) => {
    for (const load of loaders) {
      const out = await load(input);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}

/** Teams-hosted screenshots (Graph hosted contents, SharePoint files) through the Teams image loader; anything else falls through. */
function teamsScreenshotLoader(loadImage: LoadImage, fallback: LoadScreenshot): LoadScreenshot {
  return async (ref) => {
    const image = await loadImage({ kind: 'image', url: ref.url, ...(ref.contentType === undefined ? {} : { mimeType: ref.contentType }) });
    if (image === undefined) return fallback(ref);
    return { filename: screenshotFilename(ref), content: Buffer.from(image.data, 'base64'), contentType: image.mimeType };
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

/**
 * The port a module that registers its own handlers is given: `work` adds a job module (the
 * worker registers it, as it does compose's own), `cron` is kept until the worker starts it, and
 * everything else is the real port.
 */
function registrar(workflow: WorkflowPort, jobs: JobModule[], crons: (() => Promise<void>)[]): WorkflowPort {
  return {
    start: (name, input, opts) => workflow.start(name, input, opts),
    schedule: (name, input, runAt, opts) => workflow.schedule(name, input, runAt, opts),
    cancel: (key) => workflow.cancel(key),
    work: (name, handler, opts) => {
      jobs.push({ name, handler, ...(opts?.concurrency === undefined ? {} : { concurrency: opts.concurrency }) });
    },
    park: (jobId, waitingOn, timeoutAt) => workflow.park(jobId, waitingOn, timeoutAt),
    resume: (waitingOn, result) => workflow.resume(waitingOn, result),
    cron: (name, expression, input) => {
      crons.push(() => workflow.cron(name, expression, input));
      return Promise.resolve();
    },
  };
}

/** A worker service that runs `tick` at start and every `everyMs`; a failing tick is logged, never fatal. */
function every(name: string, everyMs: number, tick: () => Promise<unknown>, log: ComposeLog): ComposedService {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const run = (): void => {
    running ??= tick()
      .then(() => undefined)
      .catch((e: unknown) => log.error(`${name}: ${message(e)}`))
      .finally(() => {
        running = undefined;
      });
  };
  return {
    name,
    start: () => {
      if (timer === undefined) {
        run();
        timer = setInterval(run, everyMs);
        timer.unref();
      }
      return Promise.resolve();
    },
    stop: async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
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
  // Slack is configured when any of its secrets is set or its transport is named; then the whole
  // group is required. With no chat platform at all, startup names the Slack group.
  const otherSurfaces = overrides.chatSurfaces ?? [];
  // The exception is an app created but not yet installed (#240): onboarding writes the signing secret and
  // the client id and secret at creation, the bot token only after the workspace admin approves the install.
  // Those values alone mean Slack is pending: off, with one log line, so Teams is not held up.
  const slackProbe = await readSecrets(deps.secrets, [], [...SLACK_SECRETS, 'SLACK_APP_TOKEN', ...SLACK_CREATION_SECRETS]);
  const slackInstalled = slackProbe.has('SLACK_BOT_TOKEN') || slackProbe.has('SLACK_APP_TOKEN');
  const slackNamed = transportChoice !== undefined && transportChoice !== '';
  const slackOn = slackInstalled || slackNamed;
  const slackPending = !slackOn && SLACK_CREATION_SECRETS.concat('SLACK_SIGNING_SECRET').some((name) => slackProbe.has(name));
  if (slackPending) log.info(SLACK_INSTALL_PENDING);
  // Teams the same way: any of its secrets set (its public URL included) means Teams, and the whole group.
  const teamsProbe = await readSecrets(deps.secrets, [], [...TEAMS_SECRETS, 'TEAMS_PUBLIC_URL']);
  const teamsOn = teamsProbe.size > 0;
  if (!slackOn && !teamsOn && otherSurfaces.length === 0) throw new MissingSecretsError(SLACK_SECRETS, slackPending ? `${NO_CHAT_PLATFORM}; ${SLACK_INSTALL_PENDING_NEXT}` : NO_CHAT_PLATFORM);
  const required = [
    ...(slackOn ? SLACK_SECRETS : []),
    ...(teamsOn ? TEAMS_SECRETS : []),
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
    // The notification policy reads the validated playbook from the cache inside the append (A 4.4).
    onPlaybook: (xml) => state.putConfigVersion('playbook', createHash('sha256').update(xml).digest('hex'), xml),
  });
  const cache = createKvCache(store);
  const workRoot = env['SNAPWING_WORKDIR_ROOT']?.trim() || join(tmpdir(), 'snapwing-work');

  // Platform clients.
  const web: SlackWeb | undefined = slackOn ? createSlackWeb({ token: secret('SLACK_BOT_TOKEN') }) : undefined;
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

  // main 16 (#272): the chat limits, and the playbook's daily budget over every model call.
  const chatLimits = createChatLimits({
    budget: () => configWatch.playbook().limits.modelCallsPerDay,
    clock,
    onSpent: (budget) => log.error(`model budget: ${budget} calls today; chat starts no new model work until the next UTC day (playbook <limits modelCallsPerDay>)`),
  });
  const model: ModelPort = countModelCalls(
    overrides.model ??
      createModelRouter(
        config.models,
        { anthropic: anthropicProvider, openai: openaiProvider, google: googleProviderFactory },
        Object.fromEntries(Object.values(PROVIDER_KEY_ENV).flatMap((name) => (s.has(name) ? [[name, s.get(name)]] : []))),
      ),
    () => chatLimits.countCall(),
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
    verifyPullRequest: createPullRequestVerifier({ state, github, botLogin: `${secret('GITHUB_APP_SLUG').trim()}[bot]` }),
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
            // Valid for the whole run plus the final report, however long its wall clock.
            token: (j) => issueFixerToken({ workItemId: j.workItem.id, incidentId: j.workItem.id, ttl: fixerTokenTtl(j.budget.wallClock) }, fixerTokenKeys),
            modelProxy,
          },
          // The work item is prepared on the host before the container starts.
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
    // A 6.4: the live INSTRUCTIONS.md may hold a fixer start the agent makes on its own.
    instructionsGate: { instructions: configWatch.instructions, model },
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
  // A 6.4: the live INSTRUCTIONS.md may hold an autopilot merge (level 3 to 2).
  const mergeDeps: MergeDeps = { workspaceId, state, workflow, github, merge: config.merge, map: getMap, clock, instructionsGate: { instructions: configWatch.instructions, model } };

  // The map as last read, for the synchronous lookups (a handle, a surface); refreshed on each use below.
  let mapSnapshot: WorkspaceMap = await getMap();
  const liveMap = async (): Promise<WorkspaceMap> => (mapSnapshot = await getMap());
  const oauth = createGitHubOAuth({ state, secrets: deps.secrets, workspaceId, map: liveMap, onError: (e) => log.error(`github link: ${message(e)}`) });

  // Slack, when configured. One `auth.test` at startup gives the bot user id, the workspace's team id,
  // and its subdomain (the Conversation Link). Who wrote a message is shared by every inbound path that
  // reads people's messages: a person posting through an app carries `bot_id` and is still a person.
  const slack = web === undefined ? undefined : await (async (slackWeb: SlackWeb) => {
    const identity =
      overrides.slackBotUserId !== undefined && overrides.slackWorkspaceDomain !== undefined ? undefined : await slackIdentity(secret('SLACK_BOT_TOKEN'));
    const botUserId = overrides.slackBotUserId ?? identity?.userId ?? '';
    const workspaceDomain = overrides.slackWorkspaceDomain ?? identity?.domain;
    const authorOf = createSlackAuthorOf({
      botUserId,
      ...(identity?.botId === undefined ? {} : { botId: identity.botId }),
      // A trigger reactor from another team is external (#170).
      ...(identity?.teamId === undefined ? {} : { teamId: identity.teamId }),
      // On Enterprise Grid, a person from another workspace of the same organization is a member.
      ...(identity?.enterpriseId === undefined ? {} : { enterpriseId: identity.enterpriseId }),
      usersInfo: (user) => slackWeb.usersInfo(user),
    });
    const adapter = createSlackAdapter({
      web: slackWeb,
      signingSecret: secret('SLACK_SIGNING_SECRET'),
      botUserId,
      authorOf,
      ...(workspaceDomain === undefined ? {} : { workspaceDomain }),
      getMap,
      state,
      onError: (e) => log.error(`slack: ${message(e)}`),
      clock,
    });
    // Slack's outbound chat effects: thread, channel, and direct posts, the cards, channel members.
    const surface: SlackChatSurface = createSlackChatSurface({
      web: slackWeb,
      state,
      cache,
      getMap: liveMap,
      identity: oauth,
      ...(overrides.prReadyChat === undefined ? {} : { prReady: overrides.prReadyChat }),
      log,
    });
    return { web: slackWeb, botUserId, workspaceDomain, authorOf, adapter, context: createSlackContextSource(slackWeb), surface };
  })(web);

  // Teams, when configured. Client credentials against the tenant for the Bot Connector and Graph; the
  // inbound JWT is checked against the Bot Framework's published keys. One connector, remembering every
  // card with a button it posts or edits (`rememberTeamsCards`, kv `teams-card:*`), so a tap is answered
  // with its card; it keeps `createPersonalConversation`, which the interactivity's GitHub link needs.
  const teams = !teamsOn
    ? undefined
    : (() => {
        const appId = secret('TEAMS_APP_ID').trim();
        const tenantId = secret('TEAMS_TENANT_ID').trim();
        const credentials = { appId, password: secret('TEAMS_APP_PASSWORD'), tenantId };
        const botTokens = createBotTokenSource(credentials);
        const graphTokens = createGraphTokenSource(credentials);
        const configuredServiceUrl = s.get('TEAMS_SERVICE_URL')?.trim();
        const serviceUrl = configuredServiceUrl || TEAMS_DEFAULT_SERVICE_URL;
        // The documented Bot Connector hosts, and the configured service URL's (a sovereign or test endpoint).
        const configuredHost = configuredServiceUrl && URL.canParse(configuredServiceUrl) ? new URL(configuredServiceUrl).hostname : undefined;
        const serviceHosts = configuredHost === undefined ? [] : [configuredHost];
        const teamsError = (what: string) => (e: unknown) => log.error(`teams ${what}: ${message(e)}`);
        const connector = rememberTeamsCards(
          createTeamsConnector({ token: () => botTokens.token(), botId: appId, allowServiceUrl: allowTeamsServiceUrl(serviceHosts) }),
          createKvTeamsCardStore(cache),
          teamsError('card store'),
        );
        const graph = createTeamsGraph({ token: () => graphTokens.token() });
        const adapter: TeamsAdapter = createTeamsAdapter({
          connector,
          graph,
          appId,
          verify: (authorization, o) => verifyBotFrameworkJwt(authorization, o),
          cache,
          getMap,
          tenantId,
          defaultServiceUrl: serviceUrl,
          state,
          onError: teamsError('adapter'),
          clock,
        });
        // Teams' outbound chat effects: thread, channel, and personal posts, the cards, channel members (Graph).
        const surface: TeamsChatSurface = createTeamsChatSurface({ connector, graph, state, cache, getMap: liveMap, identity: oauth, botId: appId, tenantId, serviceUrl, now: clock, log });
        // A channel's team, for reading around the anchor when the activity names none (the map's `team`).
        const context = createTeamsContextSource(graph, {
          teamFor: (channelId) => mapSnapshot.channels.find((c) => c.id === channelId)?.teamId,
          botToken: () => botTokens.token(),
          botHosts: serviceHosts,
        });
        return { appId, tenantId, serviceUrl, connector, graph, adapter, surface, context, teamsError };
      })();
  // Activities the e2e seam hands in past authentication (`overrides.teamsInject`); empty otherwise, so
  // the engine checks every other activity's JWT as the transport did.
  const injectedTeams = new WeakSet<object>();
  const teamsEngineAdapter: TeamsAdapter | undefined =
    teams === undefined
      ? undefined
      : { ...teams.adapter, authenticateRequest: (raw: TeamsInbound) => (injectedTeams.has(raw) ? Promise.resolve(true) : teams.adapter.authenticateRequest(raw)) };

  // The chat seam: every outbound chat effect below goes through the router, which picks the
  // surface by the incident's source (or by a channel's or a person's platform). Slack first: the default.
  const chat: ChatRouter = createChatRouter({
    surfaces: [...(slack === undefined ? [] : [slack.surface]), ...(teams === undefined ? [] : [teams.surface]), ...otherSurfaces],
    state,
    map: liveMap,
    clock,
    log,
  });

  // Deps that carry one chat platform (the map people's ids, the linked identities) are built per
  // platform: the human review per incident, the PR actions per tap source.
  const humanDepsFor = (platform: ChatPlatform): HumanDeps => ({
    workspaceId,
    state,
    workflow,
    chat: platform,
    github,
    codeowners: (repo) => createCodeownersResolver(auth, { repo: repoFullName(repo) }),
    identity: oauth,
    map: getMap,
    clock,
  });
  const humanReviewFor = (platform: ChatPlatform): HumanReviewDeps => ({
    ...humanDepsFor(platform),
    chatOut: chat.prReady,
    cache,
    onError: (e) => log.error(`pr card link prompt: ${message(e)}`),
  });
  const prActionsByPlatform = new Map<ChatPlatform, HumanPrActions>();
  const prActionsFor = (platform: ChatPlatform): HumanPrActions => {
    let actions = prActionsByPlatform.get(platform);
    if (actions === undefined) {
      actions = createPrActions({
        ...humanDepsFor(platform),
        stopIncident: (input) => stopIncident(fixerDeps, input),
        revert: (incidentId, actor, opts) => revert(mergeDeps, incidentId, actor, opts),
      });
      prActionsByPlatform.set(platform, actions);
    }
    return actions;
  };

  // Capture API (#3, main 15.3, 15.4; ADR 0022) ---------------------------------------------------
  // Raycast and the CLI share one adapter shape (per source, for idempotency keys and metrics only), a
  // context source that makes a screenshot the anchor's image, and the bearer-token routes. Their cards
  // wait in kv for the client to read; their images live in kv until the Jira projector attaches them,
  // or until the capture ends without a ticket (the worker's `capture images`).
  const capture = {
    adapters: CAPTURE_SOURCES.map((source) => [source, createCaptureAdapter(source, { cache, clock })] as const),
    context: createCaptureContextSource(),
    issueUrl: (key: string): string => `${secret('JIRA_BASE_URL').replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`,
  };
  const captureRoutes = createCaptureRoutes({
    state,
    cache,
    workspaceId,
    map: liveMap,
    // Called per request, once the engine below exists.
    engine: { handleInbound: (source, raw) => engine.handleInbound(source, raw), handleTap: (tap) => engine.handleTap(tap) },
    stop: (input) => stopIncident(fixerDeps, input),
    queue: createQueue({
      state,
      workspaceId,
      getMap: liveMap,
      identity: oauth,
      pullRequest: (repo, number) => github(repo).getPullRequest(number),
      clock,
      onError: (e) => log.error(`capture queue: ${message(e)}`),
    }).queueFor,
    issueUrl: capture.issueUrl,
  });

  // Chat-hosted images and recordings, through each configured chat's loader (Slack's, then Teams').
  const chatImages: LoadImage | undefined = firstOf([...(slack === undefined ? [] : [slack.context.loadImage]), ...(teams === undefined ? [] : [teams.context.loadImage])]);
  const chatRecordings: LoadRecording | undefined = firstOf([
    ...(slack === undefined ? [] : [slack.context.loadRecording]),
    ...(teams === undefined ? [] : [teams.context.loadRecording]),
  ]);

  // The engine.
  const engineDeps: EngineDeps = {
    workspaceId,
    state,
    workflow,
    model,
    adapters: new Map<ChannelSource, AnyIngestionAdapter>([
      ...(slack === undefined ? [] : [['slack', slack.adapter] as const]),
      ...(teamsEngineAdapter === undefined ? [] : [['teams', teamsEngineAdapter] as const]),
      ...capture.adapters,
    ]),
    context: new Map<ChannelSource, ContextSource>([
      ...(slack === undefined ? [] : [['slack', slack.context] as const]),
      ...(teams === undefined ? [] : [['teams', teams.context] as const]),
      ...CAPTURE_SOURCES.map((source) => [source, capture.context] as const),
    ]),
    jiraSearch: jiraSearch(jira),
    cache,
    map: getMap,
    // Getters, so a hot reload (config-watch.ts) reaches the next call. The follow-up: read
    // `deps.instructions?.()` in engine/steps.ts and pass it to plan, maybeAsk, and SynthesisContext.
    playbook: configWatch.playbook,
    instructions: configWatch.instructions,
    // main 15.3: file paths in pasted text resolve against the map repos' trees.
    repoTrees: createRepoTrees(auth),
    repoReader: (resolution) => (resolution.repo === undefined || resolution.repo === '' ? undefined : createGitHubRepoReader(auth, { repo: repoFullName(resolution.repo) })),
    // With the subscriber the engine never posts `filed` itself; the status projector below posts it.
    status: createStatusSubscriber({ workspaceId, clock }),
    clock,
    // Capture screenshots come from kv; every other image through its chat's own loader.
    options: { loadImage: captureImageLoader(cache, chatImages), ...(chatRecordings === undefined ? {} : { loadRecording: chatRecordings }) },
    // A 2.1: a claim handed back on an issue already In Progress starts the fixer directly.
    startFixer: (incidentId) => startFixer(fixerDeps, { incidentId, attempt: 1 }),
    // A 1.4: reactions on the anchor before the incident existed count from its creation.
    onCaptured: (incidentId) => adoptPendingSignals(signalDeps, incidentId),
    // main 16: a new chat incident takes a slot of its person's window and needs budget left; the
    // first refusal on a day the budget is spent tells that person.
    admit: async (source, payload) => {
      if (source !== 'slack' && source !== 'teams') return true;
      const refused = chatLimits.newIncident(payload.reporter.id);
      if (refused === undefined) return true;
      log.info(`chat limits: a new ${source} incident from ${payload.reporter.id} was not started (${refused})`);
      if (refused === 'budget' && chatLimits.budgetNotice()) {
        await chat.surface(source)?.personPost(payload.reporter.id, BUDGET_SPENT_TEXT).catch((e: unknown) => log.error(`chat limits: ${message(e)}`));
      }
      return false;
    },
  };
  const engine = new IncidentOrchestrator(engineDeps);

  // Phase 4 wiring ------------------------------------------------------------------------
  // Mid-flight claims (A 2.2), holds and claim expiry (A 2.3, 2.4), digests (A 4.6), ux friction
  // (A 5.3), channel members (A 4.4). The instructions gate (A 6.4) is on `fixerDeps` and `mergeDeps`.
  const phase4Jobs: JobModule[] = [];
  const phase4Crons: (() => Promise<void>)[] = [];
  const registering = registrar(workflow, phase4Jobs, phase4Crons);
  // Thread posts (the mid-flight card and notes, the holds' nudges) go through `chat.threadPost`, which
  // posts in the incident's thread on its platform and records the post (role `other`), so a reaction on
  // it counts as activity.

  /** The claimer as the Jira assignee: the `update-fields` row added earlier, which the projector resolves by email. */
  async function assignClaimer(incidentId: string, claimerId: string): Promise<void> {
    const incident = await state.getIncident(incidentId);
    const email = personByChatId(await liveMap(), claimerId)?.email;
    if (incident?.jiraKey === undefined || email === undefined) {
      log.info(`mid-flight: ${claimerId} not assigned on incident ${incidentId}: ${incident?.jiraKey === undefined ? 'no Jira issue yet' : 'no email in the map'}`);
      return;
    }
    const now = clock();
    const at = now.toISOString();
    await state.enqueueOutbox({
      id: ulid(now.getTime()),
      workspaceId,
      target: 'jira',
      incidentId,
      op: 'update-fields',
      payload: { issueKey: incident.jiraKey, fields: { assignee: { email } } },
      batchKey: jiraFieldBatchKey(incidentId, 'assignee'),
      attempts: 0,
      nextAttempt: at,
      createdAt: at,
    });
  }

  const midFlightPorts: MidFlightPorts = {
    postCard: (incidentId, card) => chat.postMidFlightCard(incidentId, card),
    notify: (incidentId, text) => chat.threadPost(incidentId, { text }),
    assign: assignClaimer,
  };
  const midFlightDeps: MidFlightDeps = {
    ...fixerDeps,
    // Forwards every call to the real port; only `registerMidFlightJobs`'s `work` becomes a job module.
    workflow: registering,
    ports: midFlightPorts,
    // Read per use, so a hot-reloaded playbook applies to the next offer.
    get midFlightGrace(): string {
      return configWatch.playbook().claims.midFlightGrace;
    },
  };
  registerMidFlightJobs(midFlightDeps);

  // Business hours stay off until a config names them: the claim expiry counts wall-clock time.
  const holds = createHolds({
    workspaceId,
    state,
    workflow: registering,
    clock,
    claims: configWatch.playbook().claims,
    // The text names people as `@handle`; on the platform the one it addresses is a real mention.
    say: (incidentId, said) => chat.threadPost(incidentId, said),
    handleOf: (userId) => personByChatId(mapSnapshot, userId)?.handle,
    afterRelease: async (incidentId, seq, scope) => {
      if (scope === 'claim') await engine.handleClaim(incidentId, seq);
    },
  });
  holds.register();

  /** After a claim commits (the signal handler's `handleClaim` call): the engine, then A 2.2 and A 2.3/2.4. */
  const claimAwareEngine: SignalEngine = {
    handleTap: (tap) => engine.handleTap(tap),
    handleClaim: async (incidentId, seq) => {
      const woke = await engine.handleClaim(incidentId, seq);
      try {
        await liveMap();
        await handleMidFlightClaim(midFlightDeps, incidentId, seq);
      } catch (e) {
        log.error(`mid-flight claim on incident ${incidentId}: ${message(e)}`);
      }
      try {
        await holds.onEvent(incidentId, seq);
      } catch (e) {
        log.error(`holds after the claim on incident ${incidentId}: ${message(e)}`);
      }
      return woke;
    },
  };
  /** After each signal commits (Slack's or Teams'): every event it appended goes through the holds (activity, a hold, a release). */
  async function afterSignal(outcome: SlackSignalOutcome | TeamsSignalOutcome): Promise<void> {
    if (outcome.kind !== 'signal' || !outcome.outcome.handled) return;
    const { incidentId, seq, appended } = outcome.outcome;
    try {
      await liveMap();
      for (let n = 0; n < appended.length; n++) await holds.onEvent(incidentId, seq + n);
    } catch (e) {
      log.error(`holds after a signal on incident ${incidentId}: ${message(e)}`);
    }
  }

  // Digests: one cron job per playbook digest, posted to a channel (`#name`) or a person (`@handle`, an
  // email, or a chat user id) on its platform (`chat.postTo`). A digest added or removed by a hot reload
  // applies at the next restart.
  try {
    await registerDigestJobs(
      {
        state,
        workflow: registering,
        clock,
        workspaceId,
        post: (to, text) => chat.postTo(to, text),
      },
      configWatch.playbook().notifications.digests,
    );
  } catch (e) {
    log.error(`digests not scheduled: ${message(e)}`);
  }

  // UX friction (A 5.3): the scan files a Task through the Jira outbox and posts it to the surface's bug channel.
  const uxFriction = createUxFriction({
    state,
    cache,
    clock,
    playbook: configWatch.playbook,
    map: () => mapSnapshot,
    onError: (e) => log.error(`ux friction: ${message(e)}`),
    file: async (task) => {
      const surface = mapSnapshot.surfaces.find((x) => x.id === task.surfaceId);
      if (surface === undefined) throw new Error(`surface ${task.surfaceId} is not in the map`);
      const now = clock();
      const at = now.toISOString();
      await state.enqueueOutbox({
        id: ulid(now.getTime()),
        workspaceId: task.workspaceId,
        target: 'jira',
        op: 'create-task',
        payload: {
          fields: { project: { key: surface.jira.project }, issuetype: { name: task.issueType }, summary: task.summary, description: textToAdf(task.description), labels: [...task.labels] },
        },
        attempts: 0,
        nextAttempt: at,
        createdAt: at,
      });
      if (task.channelId === undefined) return;
      // The Task is queued; a failed post must not file it twice, so it is logged, not thrown.
      await chat
        .channelPost(task.channelId, `${task.summary}. When several people hit the same thing, the product is inviting it: filed a ${surface.jira.project} Task labeled ${task.labels[0]}.`)
        .catch((e: unknown) => log.error(`ux friction post to ${task.channelId ?? ''}: ${message(e)}`));
    },
  });

  // Channel members (A 4.4): kv `channel-members:{channel}` for the notification policy, refreshed by
  // every chat surface (Slack's also follows the membership events on its inbound path).
  const phase4WorkerServices: ComposedService[] = [
    {
      name: 'phase 4 schedules',
      start: async () => {
        for (const cron of phase4Crons) await cron();
      },
      stop: () => Promise.resolve(),
    },
    every(
      'ux friction scan',
      UX_FRICTION_SCAN_MS,
      async () => {
        await liveMap();
        await uxFriction.scan();
      },
      log,
    ),
    every('channel members refresh', CHANNEL_MEMBERS_REFRESH_MS, () => chat.refreshChannelMembers(), log),
  ];
  // End of phase 4 wiring --------------------------------------------------------------------------

  // Signal side effects, ladders, monitoring ------------------------------------------------
  // The reaction ladder (A 1.4), text signals (A 3), the escalation ladders (A 6.2), and active
  // monitoring (A 4.5). Removals (A 1.6) are the signal handler's own (`planRemoval`).

  // A ladder step, a reaction ladder note, or a heartbeat: in the incident's thread (recorded, so a
  // reaction on it resolves to the incident) or the step's channel, through the chat router.
  const escalationChat = chat.escalation;

  /** Active monitoring then the ladders, which read `monitored` and the facts the monitor keeps. */
  async function evaluateMonitoring(incidentId: string): Promise<LadderChange[]> {
    await activeMonitor.evaluate(incidentId);
    return ladders.evaluate(incidentId);
  }

  const reactionEscalation = createReactionEscalation({
    workspaceId,
    state,
    playbook: configWatch.playbook,
    clock,
    chat: escalationChat,
    // Steps reached at adoption fire before resolution names the owner: the map's owner of the channel's surface.
    map: liveMap,
    // After a step fires: a Highest priority or the outage step's `monitoring-started` arms the monitor.
    ladders: { evaluate: evaluateMonitoring },
    log: (line) => log.error(line),
  });
  const ladders = createEscalationLadders({
    workspaceId,
    state,
    workflow: registering,
    playbook: configWatch.playbook,
    chat: escalationChat,
    pager: createPagerDutyPager({ secrets: deps.secrets }),
    // `PAGERDUTY_ROUTING_KEY_<SERVICE>`, else `PAGERDUTY_ROUTING_KEY`, read per page.
    secrets: deps.secrets,
    clock,
    outage: (incident) => reactionEscalation.outage(incident),
    stalled: (incident) => activeMonitor.stalled(incident),
    link: (incident) => (incident.jiraKey === undefined ? undefined : `${secret('JIRA_BASE_URL').replace(/\/+$/, '')}/browse/${incident.jiraKey}`),
    map: liveMap,
    log: (line) => log.error(line),
  });
  ladders.register();
  const reconcileSources = createReconcileSources({
    github: auth,
    jira,
    jiraChangelog: { baseUrl: secret('JIRA_BASE_URL'), email: secret('JIRA_EMAIL'), apiToken: secret('JIRA_API_TOKEN') },
  });
  const activeMonitor = createActiveMonitor({
    workspaceId,
    state,
    workflow: registering,
    playbook: configWatch.playbook,
    sources: reconcileSources,
    // What the webhook or the reconciler would have started; deploys start nothing.
    followUp: async (event: IncidentEvent<PolledEventType>, incident) => {
      if (event.type === 'deployed:staging' || event.type === 'deployed:production') return;
      await reconcileFollowUp(event as IncidentEvent<ReconciledEventType>, incident);
    },
    chat: escalationChat,
    ladders,
    clock,
    log: (line) => log.error(line),
  });
  activeMonitor.register();

  // Reads the log from where it left off and evaluates each incident an event could have changed.
  let monitorCursor: string | undefined;
  async function monitorTriggers(): Promise<void> {
    monitorCursor ??= (await cache.get(MONITOR_CURSOR_KEY)) ?? LOG_START;
    for (;;) {
      const page = await state.readSince(monitorCursor, 200);
      const incidents = new Set(page.events.filter((e) => MONITOR_TRIGGERS.has(e.type)).map((e) => e.incidentId));
      for (const incidentId of incidents) {
        try {
          await evaluateMonitoring(incidentId);
        } catch (e) {
          log.error(`active monitoring: incident ${incidentId}: ${message(e)}`);
        }
      }
      const moved = page.cursor !== monitorCursor;
      monitorCursor = page.cursor;
      if (moved) await cache.set(MONITOR_CURSOR_KEY, monitorCursor);
      if (!moved || page.events.length === 0) return;
    }
  }
  const monitorServices: ComposedService[] = [every('active monitoring', overrides.projectorPollMs ?? MONITOR_TRIGGER_POLL_MS, monitorTriggers, log)];

  // A capture that ends without a ticket of its own (adapter.ts) never reaches the Jira projector, so
  // its screenshot is deleted here, when the log says it ended; nobody need look at the capture again.
  let captureImagesCursor: string | undefined;
  async function releaseUnfiledCaptureImages(): Promise<void> {
    captureImagesCursor ??= (await cache.get(CAPTURE_IMAGES_CURSOR_KEY)) ?? LOG_START;
    for (;;) {
      const page = await state.readSince(captureImagesCursor, 200);
      for (const e of page.events) {
        await dropEndedCaptureImage(cache, state, e);
      }
      const moved = page.cursor !== captureImagesCursor;
      captureImagesCursor = page.cursor;
      if (moved) await cache.set(CAPTURE_IMAGES_CURSOR_KEY, captureImagesCursor);
      if (!moved || page.events.length === 0) return;
    }
  }

  /** A 3 scope change: the second issue captured as its own incident, as "Fix it from here" on that message. */
  async function fileLinked(request: LinkedIncidentRequest): Promise<{ incidentId: string } | undefined> {
    if (request.platform === 'teams') return fileLinkedTeams(request);
    if (slack === undefined || request.platform !== 'slack' || request.channel === '') return undefined;
    const parent = await state.getIncident(request.parentIncidentId);
    const raw: SlackInbound = {
      transport: 'socket',
      payload: {
        type: 'message_action',
        callback_id: SLACK_SHORTCUT_CALLBACK_ID,
        channel: { id: request.channel },
        user: { id: request.reporter.id, name: request.reporter.name ?? '' },
        message_ts: request.messageId,
        message: { ts: request.messageId, text: request.text, ...(parent?.anchorId === undefined ? {} : { thread_ts: parent.anchorId }) },
      },
    };
    const normalized = await slack.adapter.normalizeResult(raw);
    if (normalized.kind !== 'incident') return undefined;
    await engine.handleInbound('slack', raw);
    return { incidentId: normalized.payload.eventId };
  }
  /**
   * The Teams half: "Fix it from here" on the second message, built inside the server from what was kept of
   * the conversation and its author (their `29:` id), and run through the adapter like the invoke it stands
   * for. It is trusted by identity: only this object is in `injectedTeams`, and nothing an HTTP request
   * produces ever is. The key is the action command's own (`teams-{channel}-{message}`), so a later Fix it
   * on that message dedupes against it.
   */
  async function fileLinkedTeams(request: LinkedIncidentRequest): Promise<{ incidentId: string } | undefined> {
    if (teams === undefined || teamsEngineAdapter === undefined || request.channel === '') return undefined;
    const conversation = await readTeamsConversation(cache, request.channel);
    if (conversation === undefined || conversation.conversationType !== 'channel') return undefined;
    const author = await readTeamsUser(cache, request.reporter.id);
    const parent = await state.getIncident(request.parentIncidentId);
    const rootId = parent?.anchorId ?? '';
    if (rootId === '' || rootId === request.messageId) return undefined;
    const at = clock().toISOString();
    const tenantId = conversation.tenantId ?? author?.tenantId;
    const name = author?.name ?? request.reporter.name ?? '';
    const activity = {
      type: 'invoke',
      name: TEAMS_SUBMIT_ACTION,
      id: `snapwing-linked-${request.messageId}`,
      timestamp: at,
      channelId: 'msteams',
      serviceUrl: conversation.serviceUrl,
      from: { id: author?.teamsUserId ?? request.reporter.id, name, aadObjectId: request.reporter.id },
      conversation: { id: `${request.channel};messageid=${rootId}`, conversationType: 'channel', ...(tenantId === undefined ? {} : { tenantId }) },
      channelData: {
        channel: { id: request.channel },
        ...(conversation.teamId === undefined ? {} : { team: { aadGroupId: conversation.teamId } }),
        ...(tenantId === undefined ? {} : { tenant: { id: tenantId } }),
      },
      value: {
        commandId: TEAMS_ACTION_COMMAND_ID,
        commandContext: 'message',
        messagePayload: {
          id: request.messageId,
          replyToId: rootId,
          createdDateTime: at,
          from: { user: { id: request.reporter.id, displayName: name, userIdentityType: 'aadUser' } },
          body: { contentType: 'text', content: request.text },
          attachments: [],
          mentions: [],
        },
      },
    };
    const raw: TeamsInbound = { transport: 'http', headers: new Headers(), activity };
    injectedTeams.add(raw);
    const normalized = await teamsEngineAdapter.normalizeResult(raw);
    if (normalized.kind !== 'incident') return undefined;
    await engine.handleInbound('teams', raw);
    return { incidentId: normalized.payload.eventId };
  }
  const textSignalDeps: TextSignalDeps = {
    workspaceId,
    state,
    playbook: configWatch.playbook,
    model,
    clock,
    ports: {
      // The resolution question and the scope card, on the incident's chat surface.
      ...chat.textCards,
      fileLinked,
      // The handoff's taker as the Jira assignee (the `update-fields` row, by the map's email).
      assign: assignClaimer,
    },
  };
  // End of signal side effects, ladders, monitoring --------------------------------------------------

  // Signals (A 1.2 to 1.4): reactions and thread replies, applied by `handleSignal`.
  const signalDeps: SignalDeps = {
    workspaceId,
    state,
    cache,
    playbook: configWatch.playbook,
    map: getMap,
    engine: claimAwareEngine,
    stopIncident: (input) => stopIncident(fixerDeps, input),
    startFixer: (input) => startFixer(fixerDeps, input),
    // A 1.4 (#290): the reaction ladder after each counted signal and once after adoption.
    escalation: reactionEscalation,
    clock,
  };

  // Slack's inbound side, when Slack is configured: signals, taps, the status query, Home, and the
  // transport. A tap's PR actions and the GitHub link check are Slack's (per tap source).
  const slackInbound =
    slack === undefined
      ? undefined
      : (() => {
          const { web: slackWeb, botUserId, workspaceDomain, authorOf, surface } = slack;
          const slackSignals = createSlackSignals({
            deps: signalDeps,
            getMap,
            botUserId,
            authorOf,
            ...(workspaceDomain === undefined ? {} : { workspaceDomain }),
            githubLinked: surface.githubLinked,
            web: slackWeb,
            model,
            limits: chatLimits,
            standing: state,
            // A 3 (#294): thread replies to `handleTextSignal`, claim reactions to `acceptHandoff`.
            text: textSignalDeps,
            onOutcome: afterSignal,
            onError: (e) => log.error(`slack signals: ${message(e)}`),
          });
          const interactivity = createSlackInteractivity({
            web: slackWeb,
            state,
            workspaceId,
            orchestrator: engine,
            stopIncident: (input) => stopIncident(fixerDeps, input),
            prActions: prActionsFor('slack'),
            midFlight: (input) => answerMidFlight(midFlightDeps, input),
            getMap,
            githubLinked: surface.githubLinked,
            botUserId,
            clock,
          });
          const slackStatusQuery = createSlackStatusQuery({
            web: slackWeb,
            state,
            standing: state,
            identity: oauth,
            workspaceId,
            getMap,
            botUserId,
            authorOf,
            clock,
            // A 4.3 (#272): members only, about channels they are in.
            access: { platform: 'slack', membership: (user) => authorOf.membership(user), inChannel: createSlackChannelAccess({ web: slackWeb, clock }) },
            onError: (e) => log.error(`slack status query: ${message(e)}`),
          });
          const slackHome = createSlackHome({
            web: slackWeb,
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
            adapter: observeChannelMembers(observeSignals(observeReactionRemoval(slack.adapter, interactivity, slackError), slackSignals, slackError), surface.channelMembers, slackError),
            handleInbound: (from: Parameters<IncidentOrchestrator['handleInbound']>[0], raw: unknown) => engine.handleInbound(from, raw),
            // The text-signal cards' taps are the Slack signals'; every other tap is the interactivity's.
            onAction: async (payload: Parameters<typeof interactivity.onAction>[0]) => {
              if (!(await slackSignals.onAction(payload))) await interactivity.onAction(payload);
            },
            status: slackStatusQuery,
            home: slackHome,
            onError: slackError,
          };
          const transport = socket
            ? createSlackTransport({ ...transportBase, mode: 'socket', appToken: appToken ?? '', ...(overrides.openSocket === undefined ? {} : { openSocket: overrides.openSocket }) })
            : createSlackTransport({ ...transportBase, mode: 'http' });
          return { transport, signals: slackSignals, socket };
        })();

  // Teams' inbound side, when Teams is configured: signals, taps, the status query, the queue, the RSC
  // mode check, the Graph subscriptions, and the transport. A tap's PR actions and the GitHub link check
  // are Teams' (per tap source).
  const teamsInbound =
    teams === undefined
      ? undefined
      : (() => {
          const { appId, connector, graph, surface, teamsError } = teams;
          // Reactions (Graph's diff and the bot's own messages) and thread replies, applied by `handleSignal`
          // with the Slack signals' deps. Its per-message chain is per process: with several API replicas
          // the kv reaction set can still race.
          const teamsSignals = createTeamsSignals({
            deps: signalDeps,
            getMap,
            botAppId: appId,
            graph,
            // A mention in an RSC reply may carry only the `29:` id: the member lookup names the person.
            connector,
            handleInbound: (source, raw) => engine.handleInbound(source, raw),
            githubLinked: surface.githubLinked,
            model,
            limits: chatLimits,
            standing: state,
            // Teams has no ephemerals: a standing watch is confirmed in the person's personal chat.
            confirmStanding: ({ aadObjectId, text }) => surface.personPost(aadObjectId, text),
            text: textSignalDeps,
            // In order, one signal's events after the other's, as Slack's single outcome is (never awaited there either).
            onOutcome: (outcomes) => {
              void outcomes.reduce<Promise<void>>((prior, outcome) => prior.then(() => afterSignal(outcome)), Promise.resolve());
            },
            onError: teamsError('signals'),
          });
          const interactivity = createTeamsInteractivity({
            connector,
            cache,
            state,
            workspaceId,
            orchestrator: engine,
            stopIncident: (input) => stopIncident(fixerDeps, input),
            prActions: prActionsFor('teams'),
            midFlight: (input) => answerMidFlight(midFlightDeps, input),
            // The resolution question and the scope-change card (A 3), answered as Slack's signals answer them.
            text: textSignalDeps,
            getMap,
            githubLinked: surface.githubLinked,
            clock,
            onError: teamsError('interactivity'),
            log: (line) => log.info(line),
          });
          const access = createTeamsStatusAccess({ graph, getMap, clock });
          const statusQuery = createTeamsStatusQuery({ connector, state, workspaceId, getMap, standing: state, identity: oauth, cache, clock, access, onError: teamsError('status query') });
          const queue = teamsQueueRoutes(
            createTeamsQueue({
              connector,
              queue: createQueue({
                state,
                workspaceId,
                getMap,
                identity: oauth,
                pullRequest: (repo, number) => github(repo).getPullRequest(number),
                clock,
                onError: teamsError('queue'),
              }),
              botId: appId,
              onError: teamsError('queue'),
            }),
          );
          const modeCheck = createTeamsModeCheck({ graph, cache, appId, getMap, onError: teamsError('mode check') });
          const publicUrl = (s.get('TEAMS_PUBLIC_URL')?.trim() || secret('SNAPWING_PUBLIC_URL')).replace(/\/+$/, '');
          log.info(`teams: the bot's messaging endpoint is ${publicUrl}/teams/messages`);
          const subscriptions = createTeamsSubscriptions({
            graph,
            cache,
            notificationUrl: `${publicUrl}${TEAMS_NOTIFICATIONS_PATH}`,
            lifecycleUrl: `${publicUrl}${TEAMS_LIFECYCLE_PATH}`,
            clientState: teamsClientState(secret('SNAPWING_ENCRYPTION_KEY')),
            now: clock,
            onError: (teamId, e) => log.error(`teams subscriptions: team ${teamId}: ${message(e)}`),
          });
          const transport = createTeamsTransport({
            adapter: {
              normalizeResult: (raw) => teams.adapter.normalizeResult(raw),
              // Every authenticated activity refreshes its sender's record, so their personal chat opens
              // with the `29:` id Teams expects (the AAD id alone is unconfirmed on a real tenant).
              authenticateRequest: async (raw) => {
                const ok = await teams.adapter.authenticateRequest(raw);
                if (ok && raw.transport === 'http') await surface.rememberUser(raw.activity).catch(teamsError('user record'));
                return ok;
              },
            },
            handleInbound: (source, raw) => engine.handleInbound(source, raw),
            status: statusQuery,
            commands: [queue.command],
            interactivity,
            signals: teamsSignals,
            installs: [modeCheck, queue.install],
            subscriptions,
            // Nothing replays what Graph dropped; say so, so a missed reaction is explainable.
            onLifecycle: (outcomes) => {
              for (const o of outcomes) if (o.kind === 'missed') log.info(`teams: Graph missed notifications on subscription ${o.subscriptionId}; reactions in that gap were not seen`);
            },
            tenantId: teams.tenantId,
            log: (line) => log.info(line),
            onError: teamsError('transport'),
          });
          return { transport, signals: teamsSignals, subscriptions };
        })();

  // The Teams e2e seam: what it hands in is treated as authenticated, and remembered as an authenticated
  // activity is (the conversation, the sender), then routed exactly as the messaging endpoint routes.
  if (teams !== undefined && teamsInbound !== undefined && overrides.teamsInject !== undefined) {
    const { dispatcher } = teamsInbound.transport;
    overrides.teamsInject(async (input) => {
      if ('notifications' in input) {
        await teamsInbound.signals.onNotifications(input.notifications);
        return { status: 202 };
      }
      const inbound = { transport: 'http' as const, headers: new Headers(), activity: input.activity };
      injectedTeams.add(inbound);
      const seen = conversationFromActivity(input.activity, clock());
      const team = seen === undefined ? undefined : mapSnapshot.channels.find((c) => c.id === seen.channelId)?.teamId;
      const record = conversationFromActivity(input.activity, clock(), team);
      if (record !== undefined) await rememberTeamsConversation(cache, record);
      await teams.surface.rememberUser(input.activity);
      const answer = await dispatcher.route(inbound);
      await dispatcher.idle();
      await teamsInbound.signals.idle();
      return answer;
    });
  }

  // Projectors.
  const pollIntervalMs = overrides.projectorPollMs;
  // The webhook and the reconciler resolve the in-progress status the way the projector does.
  const jiraStatuses = createStatusResolver(jira, config.jira.statuses);
  const slackScreenshots: LoadScreenshot = web === undefined ? fetchScreenshot : screenshotLoader(web);
  const chatScreenshots: LoadScreenshot = teams === undefined ? slackScreenshots : teamsScreenshotLoader(teams.context.loadImage, slackScreenshots);
  const jiraProjector = createJiraProjector({
    state,
    client: jira,
    workspaceId,
    continueIncident: (incidentId) => engine.continueIncident(incidentId),
    customFieldIds,
    statusOverrides: config.jira.statuses,
    // Slack-hosted screenshots need the bot token, Teams-hosted ones Graph; capture screenshots come
    // from kv; anything else is a plain GET.
    loadScreenshot: captureScreenshotLoader(cache, chatScreenshots),
    // Attached, a capture screenshot lives on the issue only: its kv copy is deleted.
    screenshotsAttached: releaseCaptureScreenshots(cache),
    // A filing parked for good (maxAttempts failed sends) never attaches: its images go too (#271).
    screenshotsAbandoned: releaseCaptureScreenshots(cache),
    now: clock,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    onError: (e) => log.error(`jira projector: ${message(e)}`),
  });
  // PR comments (B 7.1): `target='github'` `add-comment` rows, batched per incident within 60 s.
  const githubProjector = createGitHubProjector({
    state,
    auth,
    workspaceId,
    now: clock,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    onError: (e) => log.error(`github projector: ${message(e)}`),
  });
  const statusProjector =
    web === undefined
      ? undefined
      : createSlackStatusProjector({
          state,
          web,
          cache,
          workspaceId,
          getMap,
          now: clock,
          ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
          onError: (e) => log.error(`slack status projector: ${message(e)}`),
        });
  // Teams' status messages and notify rows. A DM about an incident from another platform has no Teams
  // conversation to learn a serviceUrl from, so it opens the watcher's chat at the install's defaults.
  const teamsStatusProjector =
    teams === undefined
      ? undefined
      : createTeamsStatusProjector({
          state,
          connector: teams.connector,
          cache,
          workspaceId,
          getMap,
          defaultServiceUrl: teams.serviceUrl,
          tenantId: teams.tenantId,
          botId: teams.appId,
          now: clock,
          ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
          onError: (e) => log.error(`teams status projector: ${message(e)}`),
        });

  // Reconciler.
  const reconcileDeps: ReconcileDeps = {
    state,
    workflow,
    sources: reconcileSources,
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
    ...(slackInbound?.transport.routes ?? []),
    ...(teamsInbound?.transport.routes ?? []),
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
        mappedLogins: async () => (await liveMap()).people.map((p) => p.handle),
        debug: (line) => log.info(line),
      }),
    },
    // With docker the container holds no git token: its wrapper asks for a fresh one per git
    // operation (`GET /fixer/:workItemId/git-token`), with the fixer's scopes on its one repo.
    ...createFixerRoutes(
      reporter,
      fixerTokenVerifier(fixerTokenKeys),
      docker
        ? { gitToken: createFixerGitToken({ state, mint: (repo) => auth.installationToken({ repo: repoFullName(repo), permissions: FIXER_GIT_PERMISSIONS }) }) }
        : {},
    ),
    ...(docker ? createModelProxyRoutes({ verify: modelTokenVerifier(fixerTokenKeys), providers: proxyProviders, clock }) : []),
    ...oauth.routes,
    ...captureRoutes,
  ];
  if (!s.has('JIRA_WEBHOOK_SECRET')) log.info(`JIRA_WEBHOOK_SECRET is not set: ${JIRA_WEBHOOK_PATH} refuses every delivery until it is set (Jira webhooks are off)`);

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
      // The reviewers are named on the incident's chat platform; the card goes to its surface.
      if (outcome.outcome !== 'merged') await requestHumanReview(humanReviewFor(chat.platformFor(await state.getIncident(j.data.incidentId))), j.data.incidentId);
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
    job('kv.sweep', async () => {
      const deleted = await store.kvSweepExpired();
      if (deleted > 0) log.info(`kv sweep: deleted ${String(deleted)} expired row${deleted === 1 ? '' : 's'}`);
    }),
    ...phase4Jobs,
  ];

  // Both processes read the files, so each starts the watch (start and stop are idempotent).
  const configService: ComposedService = { name: 'playbook and instructions watch', start: () => configWatch.start(), stop: () => configWatch.stop() };
  const apiServices: ComposedService[] = [
    ...(slackInbound === undefined
      ? []
      : [
          {
            name: `slack ${slackInbound.socket ? 'socket mode' : 'http'} transport`,
            start: () => slackInbound.transport.start(),
            stop: () => slackInbound.transport.stop().then(() => slackInbound.signals.idle()),
          },
        ]),
    ...(teamsInbound === undefined
      ? []
      : [
          {
            // HTTP only (no socket for Teams): stopping waits for the work started behind the answers.
            name: 'teams http transport',
            start: () => teamsInbound.transport.start(),
            stop: () => teamsInbound.transport.stop().then(() => teamsInbound.signals.idle()),
          },
        ]),
    configService,
  ];
  const workerServices: ComposedService[] = [
    {
      // Scratch directories a crashed or restarted server left behind. Never fails startup.
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
    { name: 'kv sweep schedule', start: () => workflow.cron('kv.sweep', KV_SWEEP_CRON), stop: () => Promise.resolve() },
    { name: 'reconcile schedule', start: () => workflow.cron(RECONCILE_JOB, DEFAULT_RECONCILE_CRON), stop: () => Promise.resolve() },
    { name: 'jira projector', start: async () => jiraProjector.start(), stop: () => jiraProjector.stop() },
    { name: 'github projector', start: async () => githubProjector.start(), stop: () => githubProjector.stop() },
    ...(statusProjector === undefined ? [] : [{ name: 'slack status projector', start: async () => statusProjector.start(), stop: () => statusProjector.stop() }]),
    ...(teamsStatusProjector === undefined ? [] : [{ name: 'teams status projector', start: async () => teamsStatusProjector.start(), stop: () => teamsStatusProjector.stop() }]),
    // One Graph subscription per mapped team, renewed before Graph's 60 minute cap (reduced teams retried hourly).
    ...(teamsInbound === undefined
      ? []
      : [every('teams subscriptions', SUBSCRIPTION_TICK_MS, async () => teamsInbound.subscriptions.ensureAll(teamIdsInMap(await liveMap())), log)]),
    ...phase4WorkerServices,
    ...monitorServices,
    every('capture images', overrides.projectorPollMs ?? MONITOR_TRIGGER_POLL_MS, releaseUnfiledCaptureImages, log),
    configService,
  ];
  /**
   * Teams in `/healthz`: reduced while any team the map names runs without the RSC grant (the action
   * command and personal chat only), naming those teams and why; with no Teams channel in the
   * map there is no team to say a mode for.
   */
  async function teamsHealth(subscriptions: Pick<TeamsSubscriptions, 'mode'>): Promise<PlatformHealth> {
    try {
      const teamIds = teamIdsInMap(await liveMap());
      if (teamIds.length === 0) return { id: 'teams', ok: true, detail: 'no Teams channel in the map' };
      const reduced: string[] = [];
      for (const teamId of teamIds) {
        const mode = await subscriptions.mode(teamId);
        if (mode.mode === 'reduced') reduced.push(`team ${teamId}${mode.reason === '' ? '' : ` (${mode.reason})`}`);
      }
      if (reduced.length === 0) return { id: 'teams', ok: true, mode: 'full' };
      return { id: 'teams', ok: true, mode: 'reduced', detail: `reduced in ${reduced.length} of ${teamIds.length} team${teamIds.length === 1 ? '' : 's'}: ${reduced.join('; ')}` };
    } catch (e) {
      return { id: 'teams', ok: false, detail: message(e) };
    }
  }

  const proxied = docker ? `, model proxy for ${Object.keys(proxyProviders).join(', ') || 'no provider'} at ${modelProxy.url}` : '';
  const chats = [
    ...(slackInbound === undefined ? [] : [`slack ${slackInbound.socket ? 'socket mode' : 'http'}`]),
    ...(teamsInbound === undefined ? [] : ['teams http']),
    ...otherSurfaces.map((x) => x.platform),
  ];
  log.info(`composed: ${chats.join(', ')}, runner ${config.runtime.provider}${proxied}, workspace ${workspaceId}`);

  return {
    routes,
    jobs,
    apiServices,
    workerServices,
    async health() {
      // Configured means reachable here; Teams also says which mapped teams run in reduced mode.
      const platforms: PlatformHealth[] = [
        ...(slack === undefined ? [] : [{ id: 'slack', ok: true, mode: 'full' } as const]),
        ...(teamsInbound === undefined ? [] : [await teamsHealth(teamsInbound.subscriptions)]),
        ...otherSurfaces.map((x) => ({ id: x.platform, ok: true })),
      ];
      return platforms;
    },
    async metrics() {
      return mergePrometheus([
        await jiraProjector.metrics(),
        await githubProjector.metrics(),
        ...(statusProjector === undefined ? [] : [await statusProjector.metrics()]),
        ...(teamsStatusProjector === undefined ? [] : [await teamsStatusProjector.metrics()]),
      ]);
    },
    deps: { fixer: fixerDeps, review: reviewDeps, chat },
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
