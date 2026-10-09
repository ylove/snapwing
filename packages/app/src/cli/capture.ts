// The capture commands (main 15.4): send a screenshot, a sentence, or a log to the capture API and
// walk the lookup-first response as numbered terminal prompts; read a ticket's status loopback or
// the install's health; stop a ticket.
//
//   snapwing shot [file] [--surface <id>]   the file, else the clipboard image, else the newest screenshot
//   snapwing say "<text>" [--surface <id>]
//   snapwing log [--surface <id>]           the text on stdin, like a pasted stack trace
//   snapwing status [<KEY>]                 the ticket's status loopback; no key: the server's health
//   snapwing stop <KEY>                     engineers only, enforced by the server
//
// Every command takes `--json` (print each raw response as one JSON line, never prompt) and the
// sending ones take `--choice <id>` (repeatable; answer in order without a prompt). Exit codes: 0
// done, 1 an error, 2 the server still wants an answer (no terminal, or `--choice` ran out) or is
// still working.
//
// The endpoint and token come only from capture-client's `loadClientConfig`, and every path comes
// from its `CAPTURE_ROUTES` through `createCaptureClient`; this file never builds a URL. The bearer
// token never appears in output.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createCaptureClient, type CaptureClient, type FetchLike } from '@snapwing/capture-client/client.ts';
import { loadClientConfig } from '@snapwing/capture-client/config.ts';
import {
  CaptureAuthError,
  CaptureConfigError,
  CaptureServerError,
  CaptureTimeoutError,
} from '@snapwing/capture-client/errors.ts';
import { formatQueue, formatRendered, renderChoices } from '@snapwing/capture-client/render.ts';
import type { HealthResult, LookupResponse, TicketStatus } from '@snapwing/capture-client/wire.ts';
import { askChoice, findChoice, terminalPrompter, type Prompter } from './prompt.ts';
import { findScreenshot, runCommand, ScreenshotError, type FoundImage, type ScreenshotDeps } from './screenshot.ts';
import type { CliIo } from './state.ts';

/** Everything the capture commands reach outside the process; tests replace any of it. */
export interface CaptureEnv {
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  /** The capture client's fetch; default the global one. */
  readonly fetch?: FetchLike;
  readonly prompter: Prompter;
  /** All of stdin as text, for `log`. */
  readonly readStdin: () => Promise<string>;
  readonly stdinIsTTY: boolean;
  readonly run: ScreenshotDeps['run'];
  /** Opens a URL in the browser, best effort. */
  readonly openUrl: (url: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  /** How often and how long a `pending` response is polled; default 1000 and 60000. */
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

export function defaultCaptureEnv(): CaptureEnv {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    prompter: terminalPrompter({ stdin: process.stdin, stderr: process.stderr }),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return Buffer.concat(chunks).toString('utf8');
    },
    stdinIsTTY: process.stdin.isTTY === true,
    run: runCommand,
    openUrl: (url) => openInBrowser(url, process.platform),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

function openInBrowser(url: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined;
  if (command === undefined || !/^https?:\/\//.test(url)) return Promise.resolve();
  return new Promise((done) => {
    try {
      const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => done());
      child.on('spawn', () => {
        child.unref();
        done();
      });
    } catch {
      done();
    }
  });
}

export const SHOT_USAGE = `Usage: snapwing shot [<file>] [--surface <id>] [--choice <id>]... [--json]

Sends <file>, else the clipboard image, else the newest screenshot on disk (macOS: the
screencapture location, default ~/Desktop; Linux: ~/Pictures/Screenshots and ~/Pictures).`;

export const SAY_USAGE = `Usage: snapwing say "<text>" [--surface <id>] [--choice <id>]... [--json]`;

export const LOG_USAGE = `Usage: snapwing log [--surface <id>] [--choice <id>]... [--json] < file

Sends what arrives on stdin, like a pasted stack trace.`;

const SEND_FLAGS = `
  --surface <id>   skip surface inference
  --choice <id>    answer the next question with this choice (id or number), without a prompt; repeatable
  --json           print each raw response as one JSON line and never prompt

Exit codes: 0 done, 1 error, 2 a question is left unanswered or the server is still working.`;

export const STATUS_USAGE = `Usage: snapwing status [<KEY>] [--json]

  <KEY>    print the ticket's status loopback, such as WEB-1042
  no key   print the server's health, then your queue: assigned to you, fixing now, waiting on you,
           and recently merged or reverted (a reporter sees their own reports)`;

export const STOP_USAGE = `Usage: snapwing stop <KEY> [--json]

Stops the work on a ticket. Engineers only; the server decides.`;

type SendValues = { surface?: string | undefined; choice?: string[] | undefined; json?: boolean | undefined };

const SEND_OPTIONS = {
  surface: { type: 'string' },
  choice: { type: 'string', multiple: true },
  json: { type: 'boolean' },
} as const;

/** Whatever the last response's body was, before validation: what `--json` prints. */
interface Recorder {
  last: unknown;
}

function recordingFetch(base: FetchLike | undefined, recorder: Recorder): FetchLike {
  const inner: FetchLike = base ?? ((input, init) => globalThis.fetch(input, init));
  return async (input, init) => {
    const res = await inner(input, init);
    recorder.last = undefined;
    try {
      recorder.last = (await res.clone().json()) as unknown;
    } catch {
      // Not JSON; the client reports it.
    }
    return res;
  };
}

interface Session {
  readonly client: CaptureClient;
  readonly endpoint: string;
  readonly recorder: Recorder;
}

async function openSession(name: string, io: CliIo, env: CaptureEnv): Promise<Session | undefined> {
  let config;
  try {
    config = await loadClientConfig({ env: io.env, home: env.home });
  } catch (error) {
    io.stderr(`snapwing ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (config === undefined) {
    io.stderr(`snapwing ${name}: not logged in. Run snapwing login --url <endpoint>.`);
    return undefined;
  }
  const recorder: Recorder = { last: undefined };
  const client = createCaptureClient({
    endpoint: config.endpoint,
    token: config.token,
    fetch: recordingFetch(env.fetch, recorder),
  });
  return { client, endpoint: config.endpoint, recorder };
}

/** `text` without control characters (escape sequences, carriage returns, and the like) except newline. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Prints a failure the way a person can act on it; returns the exit code. */
function report(name: string, io: CliIo, error: unknown): number {
  if (error instanceof CaptureAuthError) {
    if (error.status === 403) {
      io.stderr(`snapwing ${name}: not allowed${name === 'stop' ? ': stopping a ticket is for engineers' : ''}.`);
    } else {
      io.stderr(`snapwing ${name}: the token was rejected. Run snapwing login again.`);
    }
    return 1;
  }
  if (
    error instanceof CaptureServerError ||
    error instanceof CaptureTimeoutError ||
    error instanceof CaptureConfigError ||
    error instanceof ScreenshotError
  ) {
    io.stderr(stripControl(`snapwing ${name}: ${error.message}`));
    return 1;
  }
  throw error;
}

function parseSend(name: string, usage: string, args: readonly string[], io: CliIo):
  | { values: SendValues; positionals: string[] }
  | number {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(`${usage}\n${SEND_FLAGS}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: SEND_OPTIONS });
    return { values, positionals };
  } catch (error) {
    io.stderr(`snapwing ${name}: ${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 1;
  }
}

interface ConverseOptions {
  readonly json: boolean;
  readonly choices: readonly string[];
}

/**
 * Walks a lookup-first response to its outcome: prints it, polls while it is pending, and answers
 * each question from `--choice` or a prompt until it is filed, not filed, or a tracked ticket is
 * opened or left. Returns the exit code.
 */
async function converse(
  first: LookupResponse,
  session: Session,
  io: CliIo,
  env: CaptureEnv,
  options: ConverseOptions,
): Promise<number> {
  const choices = [...options.choices];
  const scripted = choices.length > 0 || options.json;
  const interval = env.pollIntervalMs ?? 1000;
  const timeout = env.pollTimeoutMs ?? 60_000;
  let response = first;
  let waited = 0;
  let saidPending = false;

  for (;;) {
    if (options.json) io.stdout(JSON.stringify(session.recorder.last ?? response));

    if (response.kind === 'pending') {
      if (!options.json && !saidPending) io.stdout(stripControl(formatRendered(renderChoices(response))));
      saidPending = true;
      if (waited >= timeout) {
        io.stderr(`Still working on capture ${response.captureId}. Check again later.`);
        return 2;
      }
      await env.sleep(interval);
      waited += interval;
      response = await session.client.poll(response.captureId);
      continue;
    }
    saidPending = false;

    const rendered = renderChoices(response);
    if (!options.json) io.stdout(stripControl(formatRendered(rendered)));
    if (rendered.done) return 0;

    let choice;
    if (scripted) {
      const value = choices.shift();
      if (value === undefined) {
        if (!options.json) io.stderr('No answer given. Pass --choice <id> to answer without a prompt.');
        return 2;
      }
      choice = findChoice(value, rendered.choices);
      if (choice === undefined) {
        const ids = rendered.choices.map((c) => c.id).join(', ');
        io.stderr(`--choice ${value} is not one of the choices here (${ids}).`);
        return 1;
      }
      if (!options.json) io.stdout(stripControl(`> ${choice.label}`));
    } else {
      choice = await askChoice(env.prompter, rendered.choices, io.stderr);
      if (choice === undefined) {
        io.stderr('No answer given. Pass --choice <id> to answer without a prompt.');
        return 2;
      }
    }

    if (response.kind === 'tracked') {
      // "Open it" and "Not now" are the client's own; the server is not asked.
      if (choice.id === 'open') {
        if (!options.json) io.stdout(stripControl(response.url));
        await env.openUrl(response.url);
      }
      return 0;
    }
    response = await session.client.answer(response.captureId, choice.id);
    waited = 0;
  }
}

async function send(
  name: string,
  values: SendValues,
  io: CliIo,
  env: CaptureEnv,
  firstCall: (client: CaptureClient, surface: { surface?: string }) => Promise<LookupResponse>,
): Promise<number> {
  const session = await openSession(name, io, env);
  if (session === undefined) return 1;
  try {
    const surface = values.surface === undefined || values.surface === '' ? {} : { surface: values.surface };
    const first = await firstCall(session.client, surface);
    return await converse(first, session, io, env, { json: values.json === true, choices: values.choice ?? [] });
  } catch (error) {
    return report(name, io, error);
  }
}

function describeImage(image: FoundImage): string {
  if (image.origin === 'clipboard') return 'Sending the clipboard image.';
  return `Sending ${image.path ?? 'the image'}.`;
}

/** `snapwing shot [file] [--surface id]`. */
export async function runShot(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  const parsed = parseSend('shot', SHOT_USAGE, args, io);
  if (typeof parsed === 'number') return parsed;
  if (parsed.positionals.length > 1) {
    io.stderr(`snapwing shot: one file at most\n${SHOT_USAGE}`);
    return 1;
  }
  let image: FoundImage;
  try {
    image = await findScreenshot(parsed.positionals[0], { ...env, env: io.env });
  } catch (error) {
    return report('shot', io, error);
  }
  if (parsed.values.json !== true) io.stderr(describeImage(image));
  return send('shot', parsed.values, io, env, (client, surface) =>
    client.sendImage(image.data.toString('base64'), image.mimeType, { source: 'cli', ...surface }),
  );
}

/** `snapwing say "<text>"`. */
export async function runSay(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  const parsed = parseSend('say', SAY_USAGE, args, io);
  if (typeof parsed === 'number') return parsed;
  const text = parsed.positionals.join(' ').trim();
  if (text === '') {
    io.stderr(`snapwing say: nothing to say\n${SAY_USAGE}`);
    return 1;
  }
  return send('say', parsed.values, io, env, (client, surface) => client.sendText(text, { source: 'cli', ...surface }));
}

/** `snapwing log < file`. */
export async function runLog(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  const parsed = parseSend('log', LOG_USAGE, args, io);
  if (typeof parsed === 'number') return parsed;
  if (parsed.positionals.length > 0) {
    io.stderr(`snapwing log: reads stdin only, such as snapwing log < error.log\n${LOG_USAGE}`);
    return 1;
  }
  if (env.stdinIsTTY) io.stderr('Paste the log, then press Ctrl-D.');
  const text = (await env.readStdin()).replace(/\s+$/, '');
  if (text.trim() === '') {
    io.stderr('snapwing log: nothing on stdin.');
    return 1;
  }
  return send('log', parsed.values, io, env, (client, surface) => client.sendText(text, { source: 'cli', ...surface }));
}

function parseKeyed(name: string, usage: string, args: readonly string[], io: CliIo):
  | { key: string | undefined; json: boolean }
  | number {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(usage);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { json: { type: 'boolean' } },
    });
    if (positionals.length > 1) {
      io.stderr(`snapwing ${name}: one ticket key at most\n${usage}`);
      return 1;
    }
    return { key: positionals[0]?.trim() || undefined, json: values.json === true };
  } catch (error) {
    io.stderr(`snapwing ${name}: ${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 1;
  }
}

/** The status loopback as terminal lines. */
export function formatTicketStatus(status: TicketStatus): string {
  const who = status.assignee === undefined ? '' : `, assigned to ${status.assignee}`;
  const lines = [`${status.issueKey}: ${status.summary}`, `${status.status}${who}`];
  if (status.pullRequest !== undefined) lines.push(`Pull request: ${status.pullRequest.url} (${status.pullRequest.state})`);
  lines.push(status.url);
  return lines.join('\n');
}

/**
 * One chat platform in the health response, when the server reports them:
 * `platforms: [{ id: 'slack' | 'teams', ok, mode?: 'full' | 'reduced', detail? }]`. capture-client's
 * `HealthResult` carries only `ok` today, so this reads the raw body and skips anything else.
 */
export interface PlatformHealth {
  readonly id: string;
  readonly ok: boolean;
  readonly reduced: boolean;
  readonly detail?: string;
}

export function platformsOf(raw: unknown): readonly PlatformHealth[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const list = (raw as Readonly<Record<string, unknown>>)['platforms'];
  if (!Array.isArray(list)) return [];
  const out: PlatformHealth[] = [];
  for (const item of list as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Readonly<Record<string, unknown>>;
    const id = rec['id'];
    const ok = rec['ok'];
    if (typeof id !== 'string' || id === '' || typeof ok !== 'boolean') continue;
    const detail = rec['detail'];
    out.push({
      id,
      ok,
      reduced: rec['mode'] === 'reduced',
      ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
    });
  }
  return out;
}

const REDUCED_MODE = 'reduced mode (action command and personal chat only)';

/** The health response as terminal lines. */
export function formatHealth(endpoint: string, health: HealthResult, platforms: readonly PlatformHealth[]): string {
  const lines = [`Snapwing at ${endpoint}: ${health.ok ? 'healthy' : 'not healthy'}`];
  for (const p of platforms) {
    const parts = [p.ok ? 'ok' : 'not ok'];
    if (p.reduced) parts.push(REDUCED_MODE);
    if (p.detail !== undefined) parts.push(p.detail);
    lines.push(`  ${p.id}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

/** `snapwing status [KEY]`. */
export async function runStatus(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  const parsed = parseKeyed('status', STATUS_USAGE, args, io);
  if (typeof parsed === 'number') return parsed;
  const session = await openSession('status', io, env);
  if (session === undefined) return 1;
  try {
    if (parsed.key !== undefined) {
      const status = await session.client.status(parsed.key);
      io.stdout(parsed.json ? JSON.stringify(session.recorder.last ?? status) : stripControl(formatTicketStatus(status)));
      return 0;
    }
    const health = await session.client.health();
    const healthRaw = session.recorder.last;
    if (!health.ok && !parsed.json) {
      io.stdout(stripControl(formatHealth(session.endpoint, health, platformsOf(healthRaw))));
      return 1;
    }
    const queue = await session.client.queue();
    if (parsed.json) io.stdout(JSON.stringify(session.recorder.last ?? queue));
    else io.stdout(stripControl(`${formatHealth(session.endpoint, health, platformsOf(healthRaw))}\n\n${formatQueue(queue)}`));
    return health.ok ? 0 : 1;
  } catch (error) {
    if (parsed.key === undefined && error instanceof CaptureServerError && !parsed.json) {
      io.stdout(`Snapwing at ${session.endpoint}: not healthy`);
    }
    return report('status', io, error);
  }
}

/** `snapwing stop KEY`. */
export async function runStop(args: readonly string[], io: CliIo, env: CaptureEnv): Promise<number> {
  const parsed = parseKeyed('stop', STOP_USAGE, args, io);
  if (typeof parsed === 'number') return parsed;
  if (parsed.key === undefined) {
    io.stderr(`snapwing stop: which ticket?\n${STOP_USAGE}`);
    return 1;
  }
  const session = await openSession('stop', io, env);
  if (session === undefined) return 1;
  try {
    const result = await session.client.stop(parsed.key);
    if (parsed.json) io.stdout(JSON.stringify(session.recorder.last ?? result));
    else io.stdout(stripControl(result.stopped ? `Stopped ${result.issueKey}.` : `Nothing to stop on ${result.issueKey}.`));
    return 0;
  } catch (error) {
    return report('stop', io, error);
  }
}
