// `unlink github` in a direct message (main 11.2): the person removes their own GitHub link. Both chat
// platforms' status queries intercept it the way they intercept a standing watch, and answer in the DM.
// Matched narrowly (the whole message), so a bug report that mentions GitHub goes on to capture.

import type { ChatPlatform } from '@snapwing/pipeline/ports/state.ts';
import type { GitHubOAuth } from '../../github/oauth.ts';

const UNLINK = /^(?:please\s+|pls\s+)?(?:unlink|disconnect)\s+(?:my\s+)?github(?:\s+account)?$/i;

/** True when the text, after any mention and trailing punctuation, is a request to unlink GitHub. */
export function isUnlinkGithub(text: string): boolean {
  const t = text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\s]+$/, '');
  return UNLINK.test(t);
}

/** Unlinks the person and returns what to tell them. Never puts a token or a secret in the text. */
export async function unlinkGithubReply(identity: Pick<GitHubOAuth, 'disconnect'>, chat: ChatPlatform, userId: string): Promise<string> {
  let result;
  try {
    result = await identity.disconnect({ chat, userId });
  } catch {
    return 'I could not unlink your GitHub account just now. Try again, or ask an admin.';
  }
  if (!result.linked) return 'Your GitHub account is not linked.';
  return result.revoked
    ? 'Your GitHub account is unlinked: the stored token is deleted and its authorization is revoked at GitHub. Link again to merge from here.'
    : 'Your GitHub account is unlinked and the stored token is deleted, but GitHub did not confirm the revocation. Remove Snapwing under your GitHub settings, Applications, to be sure.';
}
