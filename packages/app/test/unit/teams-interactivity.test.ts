// Teams interactivity, the tap lines (#6). A button's label is free text (a clarify option may be
// model-written), so it must never become a mention when the "who chose what" line is rendered.

import { describe, expect, it } from 'vitest';
import { renderText, type MentionFor } from '../../src/adapters/teams/cards/elements.ts';
import { TEAMS_FORMAT } from '../../src/adapters/teams/interactivity.ts';

const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001';
const PEOPLE: Readonly<Record<string, string>> = { [RAE]: 'rae', [SAM]: 'sam' };
const mentions: MentionFor = (ref) => (PEOPLE[ref] === undefined ? undefined : { id: ref, name: PEOPLE[ref] });

describe('TEAMS_FORMAT', () => {
  it('mentions the tapper', () => {
    const rendered = renderText(`${TEAMS_FORMAT.who(RAE)} chose ${TEAMS_FORMAT.bold('Checkout')}.`, mentions);
    expect(rendered.text).toBe('<at>rae</at> chose Checkout.');
    expect(rendered.entities.map((e) => e.mentioned.id)).toEqual([RAE]);
  });

  it('a label cannot forge a mention token or an <at> tag', () => {
    const label = `Cart <@${SAM}> <at>sam</at>`;
    expect(TEAMS_FORMAT.bold(label)).toBe(`Cart @${SAM} atsam/at`);
    const rendered = renderText(`${TEAMS_FORMAT.who(RAE)} chose ${TEAMS_FORMAT.bold(label)}.`, mentions);
    expect(rendered.entities.map((e) => e.mentioned.id)).toEqual([RAE]);
    expect(rendered.text).toBe(`<at>rae</at> chose Cart @${SAM} atsam/at.`);
    expect(rendered.text.match(/<at>/g)).toHaveLength(1);
  });
});
