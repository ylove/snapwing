// The real `snapwing serve` (runServe) in this process for one e2e level: the config and the test
// workspace map written to a temp dir, secrets from `.env.live` (or the environment) with the run's own
// values laid over them (the tunnel URL, a fresh encryption key and fixer token secret, the Jira webhook
// secret), Socket Mode to the real workspace, and a real HTTP listener the tunnel reaches.
//
// Two test seams, both through `deps.compose` (what `serve` passes is otherwise untouched):
//   - the secrets overlay above, so no per-run value is ever written to disk;
//   - `overrides.openSocket` wraps the real Socket Mode WebSocket so the harness can hand the
//     server a card tap as an `interactive` envelope (`tap`). Slack has no API to press a button for a
//     user; the payload is built from the real card (slack.ts `blockActions`). The server acknowledges
//     an injected envelope like any other; that one acknowledgement is not sent to Slack.

import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StateOptions } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { openState, type OpenStateHooks } from '@snapwing/pipeline/state/db.ts';
import type { SocketLike } from '../../../src/adapters/slack/transport.ts';
import { compose } from '../../../src/server/compose.ts';
import { runServe } from '../../../src/server/serve.ts';
import { overlaySecrets } from './env.ts';

export interface ServerInput {
  port: number;
  /** The secrets file serve reads (`.env.live`; absent means the environment only). */
  envFile: string;
  /** Per-run secrets laid over the file and the environment. */
  overlay: Readonly<Record<string, string>>;
  /** Non-secret environment for serve and compose (SNAPWING_MAP, SNAPWING_WORKDIR_ROOT, ...). */
  env: Readonly<Record<string, string>>;
  configXml: string;
  mapXml: string;
  /** Where the config and map files go. */
  dir: string;
}

export interface RunningServer {
  url: string;
  state: OpenedState;
  /** serve's stdout and stderr lines, for a failure message. */
  lines: string[];
  /** Hands the server an interactivity payload over its Socket Mode connection. */
  tap(payload: Record<string, unknown>): void;
  /** SIGTERM: serve stops the API, drains the worker, closes the store. Resolves with its exit code. */
  stop(): Promise<number>;
}

const INJECTED = 'snapwing-e2e-';

/** The global WebSocket, plus a way to deliver an envelope as if Slack sent it. */
class InjectableSocket implements SocketLike {
  private readonly listeners: ((event: { data: unknown }) => void)[] = [];
  constructor(private readonly real: SocketLike) {}
  send(data: string): void {
    if (data.includes(`"envelope_id":"${INJECTED}`)) return;
    this.real.send(data);
  }
  close(): void {
    this.real.close();
  }
  addEventListener(type: 'message' | 'close' | 'error' | 'open', listener: (event: never) => void): void {
    if (type === 'message') this.listeners.push(listener as (event: { data: unknown }) => void);
    (this.real.addEventListener as (t: string, l: (event: never) => void) => void)(type, listener);
  }
  inject(envelope: Record<string, unknown>): void {
    const data = JSON.stringify(envelope);
    for (const l of this.listeners) l({ data });
  }
}

export async function startServer(input: ServerInput): Promise<RunningServer> {
  const configPath = join(input.dir, 'snapwing.config.xml');
  const mapPath = join(input.dir, 'workspace-context.xml');
  await writeFile(configPath, input.configXml);
  await writeFile(mapPath, input.mapXml);

  const lines: string[] = [];
  const signals = new EventEmitter();
  let socket: InjectableSocket | undefined;
  let opened: OpenedState | undefined;
  let injected = 0;

  let ready!: (info: { url?: string }) => void;
  const readyP = new Promise<{ url?: string }>((r) => (ready = r));
  const exit = runServe(
    ['--port', String(input.port), '--host', '127.0.0.1', '--config', configPath, '--env-file', input.envFile],
    { env: { ...process.env, ...input.env, SNAPWING_MAP: mapPath }, stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) },
    {
      signals,
      onReady: (info) => ready(info),
      openState: async (options: StateOptions, hooks?: OpenStateHooks) => {
        opened = await openState(options, hooks);
        return opened;
      },
      compose: (deps) =>
        compose({
          ...deps,
          secrets: overlaySecrets(deps.secrets, input.overlay),
          overrides: {
            openSocket: (url) => {
              socket = new InjectableSocket(new WebSocket(url) as unknown as SocketLike);
              return socket;
            },
          },
        }),
    },
  );
  const started = await Promise.race([readyP, exit.then((code) => ({ code }))]);
  if ('code' in started) throw new Error(`snapwing serve exited during startup (${started.code}): ${lines.slice(-10).join(' | ')}`);
  if (opened === undefined || started.url === undefined) throw new Error('snapwing serve started without its state or API');
  const state = opened;

  return {
    url: started.url,
    state,
    lines,
    tap(payload) {
      if (socket === undefined) throw new Error('no Socket Mode connection to deliver the tap on');
      injected += 1;
      socket.inject({ type: 'interactive', envelope_id: `${INJECTED}${injected}`, accepts_response_payload: false, payload });
    },
    async stop() {
      signals.emit('SIGTERM');
      return exit;
    },
  };
}
