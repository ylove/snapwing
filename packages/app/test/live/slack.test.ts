// Live tier: Slack against a real workspace (main 14.4, 15.1).
// Needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_TEST_CHANNEL, from the environment or from `.env.live`
// (found at the repository root, or at SNAPWING_ENV_LIVE). Without them the whole file skips.
//
// Safety: every post goes to SLACK_TEST_CHANNEL only, every message text starts with `[snapwing-test]`, and
// `afterAll` unpins and deletes everything this run posted (and deletes the uploaded file) even when an assertion
// failed. No token is logged or put in an assertion message.
//
// Capture mode (opt in with SNAPWING_CAPTURE_SLACK=1): records the real shape of the message shortcut
// (`message_action`) and a button tap (`block_actions`), which only a human tap can produce. One-time human steps:
//   1. Open the Slack app's settings: Interactivity must be on, with the message shortcut `fix_it_from_here`
//      defined. In Socket Mode no request URL is needed.
//   2. Run `SNAPWING_CAPTURE_SLACK=1 pnpm --filter @snapwing/app test:live slack` (add SNAPWING_ENV_LIVE=<path> if
//      `.env.live` is not at the repository root). The test posts a `[snapwing-test]` message with a button in the
//      test channel and waits up to SNAPWING_CAPTURE_WAIT_MS (default 180000) for the taps.
//   3. In that channel, within the wait: click the button on the test message, and on the same message open the
//      "..." menu, "More message shortcuts", and pick the Snapwing shortcut.
//   4. Each payload is saved sanitized (tokens, ids, trigger ids and URLs replaced by obvious fakes) to
//      SNAPWING_CAPTURE_DIR (default packages/app/test/fixtures/slack/captured). Diff them against the hand-written
//      fixtures (test/fixtures/slack/message-action.json and the inline block_actions payloads in the interactivity
//      contract tests), update those where the shapes differ, then commit the captured files.
// Until a capture exists, the hand-written fixtures stay in place. The capture test is skipped without the flag.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findEnvFile } from './helpers/env.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { createSocketModeClient, type SlackDispatcher } from '../../src/adapters/slack/transport.ts';
import { createSlackWeb } from '../../src/adapters/slack/web.ts';

const PREFIX = '[snapwing-test]';

const secrets = createEnvFileSecrets({ path: findEnvFile() });
const NAMES = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_TEST_CHANNEL'] as const;
const values = await Promise.all(NAMES.map((n) => secrets.get(n).then((v) => v, () => '')));
const hasSecrets = values.every((v) => v !== '');
const [botToken = '', appToken = '', channel = ''] = values;

const capture = process.env.SNAPWING_CAPTURE_SLACK === '1';
const captureDir = resolve(process.env.SNAPWING_CAPTURE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../fixtures/slack/captured'));
const captureWaitMs = Number(process.env.SNAPWING_CAPTURE_WAIT_MS ?? 180_000);

/** Replaces tokens, ids, trigger ids and URLs with obvious fakes, keeping the payload's shape and key set. */
function sanitizePayload(input: unknown): unknown {
  const ids = new Map<string, string>();
  const fakeId = (value: string): string => {
    let fake = ids.get(value);
    if (fake === undefined) {
      fake = `${value[0] ?? 'X'}0FAKE${String(ids.size).padStart(3, '0')}`;
      ids.set(value, fake);
    }
    return fake;
  };
  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    if (typeof value !== 'string') return value;
    if (/token|secret/i.test(key) && key !== 'trigger_id') return 'xoxb-test';
    if (key === 'trigger_id') return '13345224609.738474920.fake';
    if (key === 'api_app_id') return 'A0FAKE';
    if (key === 'domain' || key === 'username') return 'fake';
    if (/url$/i.test(key) || /^https?:\/\//.test(value)) return 'https://example.invalid/fake';
    if (/^[UWTCBAFGD][A-Z0-9]{8,}$/.test(value)) return fakeId(value);
    if (/xox[a-z]-|xapp-/.test(value)) return 'xoxb-test';
    return value;
  };
  return walk(input, '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!hasSecrets)('Slack workspace live tier', () => {
  const web = createSlackWeb({ token: botToken });
  const posted: string[] = [];
  const pinned: string[] = [];
  let fileId: string | undefined;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** Raw calls for the methods the app does not use (cleanup, uploads). The token travels in the header only. */
  async function api(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }
  async function form(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    return (await res.json()) as Record<string, unknown>;
  }
  async function post(text: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await web.postMessage({ channel, text: `${PREFIX} ${text} ${id}`, ...extra });
    posted.push(r.ts);
    return r.ts;
  }

  beforeAll(async () => {
    // The bot must be a member of the test channel to post; joining a public channel needs no invite.
    await web.conversationsJoin(channel);
  }, 30_000);

  afterAll(async () => {
    const failures: string[] = [];
    for (const ts of pinned) {
      const r = await api('pins.remove', { channel, timestamp: ts }).catch((e: unknown) => ({ ok: false, error: String(e) }));
      if (r['ok'] !== true && r['error'] !== 'no_pin' && r['error'] !== 'message_not_found') failures.push(`unpin ${ts}: ${String(r['error'])}`);
    }
    if (fileId !== undefined) {
      const r = await api('files.delete', { file: fileId }).catch((e: unknown) => ({ ok: false, error: String(e) }));
      if (r['ok'] !== true && r['error'] !== 'file_deleted' && r['error'] !== 'file_not_found') failures.push(`delete file: ${String(r['error'])}`);
    }
    // Newest first, so replies go before their parents.
    for (const ts of [...posted].reverse()) {
      const r = await api('chat.delete', { channel, ts }).catch((e: unknown) => ({ ok: false, error: String(e) }));
      if (r['ok'] !== true && r['error'] !== 'message_not_found') failures.push(`delete ${ts}: ${String(r['error'])}`);
    }
    if (failures.length > 0) throw new Error(`teardown incomplete: ${failures.join('; ')}`);
  }, 60_000);

  it('connects over Socket Mode and closes cleanly', async () => {
    const errors: unknown[] = [];
    const dispatcher: SlackDispatcher = { dispatch: () => Promise.resolve({ status: 200, body: '' }), idle: () => Promise.resolve() };
    const client = createSocketModeClient({ appToken, dispatcher, onError: (e) => errors.push(e) });
    await client.start();
    await sleep(1500);
    await client.stop();
    expect(errors).toEqual([]);
  }, 30_000);

  it('posts, updates and pins a message, and reads it back from history and replies', async () => {
    const ts = await post('root');
    expect(ts).toMatch(/^\d+\.\d+$/);

    const updated = await web.updateMessage({ channel, ts, text: `${PREFIX} root (edited) ${id}` });
    expect(updated.ts).toBe(ts);

    await web.pinsAdd(channel, ts);
    pinned.push(ts);

    const replyTs = await post('reply', { thread_ts: ts });

    const history = await web.conversationsHistory({ channel, oldest: String(Number(ts) - 1), limit: 20 });
    const root = history.messages.find((m) => m.ts === ts);
    expect(root?.text).toContain('(edited)');
    expect(root?.reply_count).toBe(1);

    const replies = await web.conversationsReplies({ channel, ts });
    expect(replies.messages.map((m) => m.ts)).toEqual([ts, replyTs]);

    const reactions = await web.reactionsGet(channel, ts);
    expect(reactions.message?.ts).toBe(ts);
  }, 60_000);

  it('uploads a file and downloads it with the bot token', async (ctx) => {
    const content = `${PREFIX} file ${id}\n`;
    const bytes = Buffer.from(content);
    const name = `snapwing-test-${id}.txt`;
    const slot = await form('files.getUploadURLExternal', { filename: name, length: String(bytes.length) });
    if (slot['error'] === 'missing_scope') {
      // Needs the bot scope files:write (and files:read to read it back); add it in the app settings and reinstall.
      console.warn('slack live: skipping the file upload, the bot token lacks the files:write scope');
      ctx.skip();
    }
    expect(slot['error']).toBeUndefined();
    const upload = await fetch(String(slot['upload_url']), { method: 'POST', body: bytes });
    expect(upload.ok).toBe(true);
    fileId = String(slot['file_id']);
    const done = await api('files.completeUploadExternal', { files: [{ id: fileId, title: name }], channel_id: channel, initial_comment: `${PREFIX} upload ${id}` });
    expect(done['ok']).toBe(true);

    // The share message appears asynchronously; poll history for it.
    let url: string | undefined;
    for (let i = 0; i < 15 && url === undefined; i++) {
      const history = await web.conversationsHistory({ channel, limit: 10 });
      const msg = history.messages.find((m) => m.files?.some((f) => f.id === fileId));
      if (msg !== undefined) {
        if (!posted.includes(msg.ts)) posted.push(msg.ts);
        url = msg.files?.find((f) => f.id === fileId)?.url_private_download;
      }
      if (url === undefined) await sleep(1000);
    }
    expect(url).toBeDefined();
    const downloaded = await web.downloadFile(url ?? '');
    expect(Buffer.from(downloaded.bytes).toString('utf8')).toBe(content);
  }, 60_000);

  it.skipIf(!capture)('captures a message shortcut and a block_actions payload from a human tap', async () => {
    const received: { type: string; payload: unknown }[] = [];
    const dispatcher: SlackDispatcher = {
      dispatch: (raw) => {
        const payload = raw.transport === 'socket' ? raw.payload : undefined;
        const type = typeof payload === 'object' && payload !== null ? String((payload as Record<string, unknown>)['type']) : '';
        if (type === 'message_action' || type === 'block_actions') received.push({ type, payload });
        return Promise.resolve({ status: 200, body: '' });
      },
      idle: () => Promise.resolve(),
    };
    const client = createSocketModeClient({ appToken, dispatcher });
    await client.start();
    try {
      await post('capture target', {
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${PREFIX} capture target ${id}. Click the button, then use the message shortcut on this message.` } },
          { type: 'actions', block_id: 'capture', elements: [{ type: 'button', action_id: 'snapwing_capture', value: 'capture', text: { type: 'plain_text', text: 'Capture' } }] },
        ],
      });
      const deadline = Date.now() + captureWaitMs;
      const have = (t: string): boolean => received.some((r) => r.type === t);
      while (Date.now() < deadline && !(have('message_action') && have('block_actions'))) await sleep(500);
    } finally {
      await client.stop();
    }
    await mkdir(captureDir, { recursive: true });
    for (const r of received) {
      await writeFile(join(captureDir, `${r.type}.json`), `${JSON.stringify(sanitizePayload(r.payload), null, 2)}\n`);
    }
    expect(received.map((r) => r.type).sort()).toEqual(expect.arrayContaining(['block_actions', 'message_action']));
  }, captureWaitMs + 60_000);
});
