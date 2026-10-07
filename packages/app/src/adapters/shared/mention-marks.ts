// Mention marks: how a chat surface tells the mentions it emits apart from user text, on any platform.
//
// A surface's `mention` and `mentionUser` return a mark, never platform syntax: STX, a nonce made once
// per surface, the reference, ETX. Callers concatenate marks with their own words and with user text (an
// incident summary, a digest line, a task summary), and the surface renders what they post: each of its
// own marks becomes a real mention, and everything else goes through the platform's escape. So a
// `<@U...>`, `<!here>` or `<at>...</at>` that arrives inside user text is shown as text and pings nobody.
// User text cannot forge a mark: it would need the nonce, which is random and never posted.

import { randomBytes } from 'node:crypto';

const OPEN = '\u0002';
const CLOSE = '\u0003';

export interface MentionMarks {
  /** `ref` (a user id or a map handle) as a mark that only this `render` resolves. */
  mark(ref: string): string;
  /** `text` with each mark as `mention(ref)` and every part between marks as `escape(part)`. */
  render(text: string, escape: (plain: string) => string, mention: (ref: string) => string): string;
}

export function createMentionMarks(): MentionMarks {
  const prefix = `${OPEN}${randomBytes(12).toString('hex')}`;
  const marks = new RegExp(`${prefix}([^${OPEN}${CLOSE}]*)${CLOSE}`, 'g');
  return {
    mark: (ref) => `${prefix}${ref.replaceAll(OPEN, '').replaceAll(CLOSE, '')}${CLOSE}`,
    render(text, escape, mention) {
      let out = '';
      let last = 0;
      for (const m of text.matchAll(marks)) {
        out += escape(text.slice(last, m.index)) + mention(m[1] ?? '');
        last = m.index + m[0].length;
      }
      return out + escape(text.slice(last));
    },
  };
}
