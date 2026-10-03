// What the app wrote to Slack during an e2e run, read only, with the moment Slack accepted each write
// (main 14.4): the global `fetch` is wrapped so every `chat.postMessage`, `chat.update`, and
// `chat.postEphemeral` body the server sends is noted with its channel, ts, thread, text, and time.
// A test reads it to find a post Slack's history does not show (an ephemeral) and to time an answer
// (the status pull, A 4.3). The wrapper also adds the `[snapwing-test]` summary prefix to the one Jira
// request that creates an issue (`prefixingFetch`, jira.ts). Nothing else is touched, and no token is
// ever recorded: only the request's JSON body and Slack's `ts`.

import { prefixingFetch } from './jira.ts';
import { textOf, type Rec } from './slack.ts';

export type SlackWriteMethod = 'chat.postMessage' | 'chat.update' | 'chat.postEphemeral';

export interface SlackWrite {
  method: SlackWriteMethod;
  channel: string;
  /** The message's ts (the posted one, or the edited one); empty for an ephemeral. */
  ts: string;
  threadTs?: string;
  /** What the message shows: its section and context blocks, else its `text`. */
  text: string;
  /** `Date.now()` once Slack answered `ok`. */
  at: number;
}

export interface Recorder {
  writes: SlackWrite[];
  /** Puts the original `fetch` back. */
  restore(): void;
}

const METHOD = /^https:\/\/slack\.com\/api\/(chat\.postMessage|chat\.update|chat\.postEphemeral)$/;

export function installRecorder(jiraBaseUrl: string): Recorder {
  const original = globalThis.fetch;
  const writes: SlackWrite[] = [];
  const recording: typeof fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = METHOD.exec(url)?.[1] as SlackWriteMethod | undefined;
    if (method !== undefined && typeof init?.body === 'string') {
      const at = Date.now();
      try {
        const body = JSON.parse(init.body) as Rec;
        const reply = (await res.clone().json()) as Rec;
        if (reply['ok'] === true) {
          const ts = String((method === 'chat.update' ? body['ts'] : reply['ts']) ?? '');
          const shown = { ts, ...(typeof body['text'] === 'string' ? { text: body['text'] } : {}), ...(Array.isArray(body['blocks']) ? { blocks: body['blocks'] as Rec[] } : {}) };
          writes.push({
            method,
            channel: String(reply['channel'] ?? body['channel'] ?? ''),
            ts,
            ...(typeof body['thread_ts'] === 'string' ? { threadTs: body['thread_ts'] } : {}),
            text: textOf(shown),
            at,
          });
        }
      } catch {
        // Not a JSON write; nothing to record.
      }
    }
    return res;
  };
  globalThis.fetch = prefixingFetch(recording, jiraBaseUrl);
  return {
    writes,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
