// #167: the attribution line on a pull request never `@`-mentions a chat display name (on GitHub
// `@Dana` notifies whoever owns the login `dana`); only a linked GitHub login is mentioned.

import { describe, expect, it } from 'vitest';
import type { IncidentEvent } from '../../src/contracts/events.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import { githubRows } from '../../src/state/projections/outbox/github.ts';

function commentEvent(actorName: string | undefined, raw = 'works now'): IncidentEvent {
  return {
    workspaceId: '01JZ0000000000000000000001',
    incidentId: '01JZ00000000000000000000A1',
    seq: 7,
    v: 1,
    type: 'comment',
    source: 'slack',
    actor: { id: 'U-FAKE-DANA', role: 'engineer' },
    occurredAt: '2026-10-01T09:07:00.000Z',
    recordedAt: '2026-10-01T09:07:00.000Z',
    payload: {
      intent: 'accept',
      platform: 'slack',
      signalSource: 'message',
      confidence: 1,
      raw,
      effect: 'verify',
      ...(actorName === undefined ? {} : { actorName }),
      target: { role: 'staging-check', messageId: 'm1' },
    },
  } as unknown as IncidentEvent;
}

const AFTER = { prNumber: 418, repo: 'github.com/fake-org/web' } as unknown as IncidentView;

function textOf(event: IncidentEvent, actor?: { githubLogin?: string }): string {
  const rows = githubRows(event, { before: undefined, after: AFTER, valid: true }, actor);
  expect(rows).toHaveLength(1);
  return (rows[0]?.payload as { text: string }).text;
}

describe('githubRows: attribution comment on the pull request (#167)', () => {
  it('a display name equal to a real-looking login produces no mention', () => {
    const text = textOf(commentEvent('dana'));
    expect(text).toBe('**dana** verified on staging at 09:07 UTC: "works now"');
    expect(text).not.toMatch(/@[A-Za-z0-9]/);
  });

  it('a linked identity is mentioned by login, not by display name', () => {
    expect(textOf(commentEvent('Dana Q'), { githubLogin: 'dana-q' })).toBe('@dana-q verified on staging at 09:07 UTC: "works now"');
  });

  it('a login that is not a valid GitHub login falls back to the bold name', () => {
    const text = textOf(commentEvent('Dana'), { githubLogin: 'dana) @everyone' });
    expect(text).not.toMatch(/@[A-Za-z0-9]/);
    expect(text.startsWith('**Dana** verified')).toBe(true);
  });

  it('a name cannot inject Markdown, HTML, a link, or a mention', () => {
    const text = textOf(commentEvent('**x** `y` _z_ [a](http://evil.test) <b>@dana\nline2'));
    expect(text).not.toMatch(/@[A-Za-z0-9]/);
    expect(text).not.toContain('\n');
    const name = text.slice(0, text.indexOf(' verified'));
    // Every ASCII punctuation mark in the name is backslash-escaped, apart from the bold pair and the guarded @.
    expect(name).toBe('**\\*\\*x\\*\\* \\`y\\` \\_z\\_ \\[a\\]\\(http\\:\\/\\/evil\\.test\\) \\<b\\>@​dana line2**');
  });

  it('a name with nothing printable reads as someone; no name falls back to the user id', () => {
    expect(textOf(commentEvent('​'))).toMatch(/^\*\*someone\*\* verified/);
    expect(textOf(commentEvent(undefined))).toMatch(/^\*\*U\\-FAKE\\-DANA\*\* verified/);
  });

  it('an @ inside a word (a link, an email address) is left alone while a word-initial mention is defused', () => {
    const link = 'https://teams.microsoft.com/l/message/19:abc@thread.tacv2/1700000000000';
    const event = commentEvent('Dana', 'ask @ceo or dana@corp.com');
    const withLink = { ...event, payload: { ...event.payload, deepLink: link } } as unknown as IncidentEvent;
    const text = textOf(withLink);
    expect(text).toContain(`(${link})`);
    expect(text).toContain('dana@corp.com');
    expect(text).toContain(' @​ceo');
    expect(text.match(/\u200B/g)).toHaveLength(1);
  });

  it('a mention in the quoted message text is defused too', () => {
    const text = textOf(commentEvent('Dana', 'thanks @ceo and @team'));
    expect(text).not.toMatch(/@[A-Za-z0-9]/);
  });
});
