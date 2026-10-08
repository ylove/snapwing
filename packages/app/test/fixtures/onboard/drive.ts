// What the onboarding test drive needs beyond the composed app's worlds: on Slack the bot's own post of
// the sample lands in the channel's history and `reactions.get` reads the installer's reaction on it
// back; and the drive's pull request, as GitHub answers for it. Shared by the test drive's contract test
// and the whole interview's.

import { http, HttpResponse, type HttpHandler } from 'msw';
import { BOT_USER, SLACK_API } from '../e2e/world.ts';

export interface SlackSampleOptions {
  /** The bot token Slack accepts. */
  readonly token: string;
  /** The `ts` Slack gives the sample. */
  readonly ts: string;
  /** Who reacted to the sample with the bug. */
  readonly reactor: string;
}

/**
 * The sample in `channel`: the bot's top-level post without blocks is recorded in `samples` and added
 * to `messages` (the channel's history the composed app reads); any other post falls through.
 */
export function slackSampleHandlers(channel: string, messages: Record<string, unknown>[], samples: Record<string, unknown>[], options: SlackSampleOptions): HttpHandler[] {
  const authorized = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${options.token}`;
  return [
    http.post(`${SLACK_API}/chat.postMessage`, async ({ request }) => {
      const body = (await request.clone().json()) as Record<string, unknown>;
      // Cards and thread replies go on to the recording world.
      if (body['channel'] !== channel || body['thread_ts'] !== undefined || body['blocks'] !== undefined) return undefined;
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      samples.push(body);
      messages.push({ type: 'message', ts: options.ts, text: body['text'], user: BOT_USER, bot_id: 'B0SNAPWING' });
      return HttpResponse.json({ ok: true, channel, ts: options.ts });
    }),
    http.get(`${SLACK_API}/reactions.get`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json({ ok: false, error: 'not_authed' });
      const q = new URL(request.url).searchParams;
      const message = messages.find((m) => m['ts'] === q.get('timestamp'));
      if (q.get('channel') !== channel || message === undefined) return HttpResponse.json({ ok: false, error: 'message_not_found' });
      return HttpResponse.json({ ok: true, type: 'message', channel, message: { ...message, reactions: [{ name: 'bug', users: [options.reactor], count: 1 }] } });
    }),
  ];
}

/**
 * A pull request's state as GitHub answers for it now. The fake GitHub (../e2e/github.ts) picks up the
 * pull requests the agent opened only when it is asked, so this asks rather than reading its memory.
 */
export async function pullState(repo: string, number: number, token: string): Promise<string | undefined> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${String(number)}`, { headers: { authorization: `Bearer ${token}` } });
  return res.ok ? ((await res.json()) as { state?: string }).state : undefined;
}
