import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StatusStage } from '@snapwing/pipeline/contracts/adapters.ts';
import { buildCard, buildClarify } from '../../src/adapters/teams/cards/cards.ts';
import {
  MAX_ACTIONS,
  MAX_CARD_BYTES,
  REDUCED_BANNER,
  actionSet,
  cardBytes,
  mentionsFromMap,
  refreshed,
  renderText,
  type AdaptiveCard,
} from '../../src/adapters/teams/cards/elements.ts';
import { EXAMPLE_INCIDENT_ID, EXAMPLE_MENTIONS, renderExamples } from '../../src/adapters/teams/cards/examples.ts';
import { midFlightChoiceOf } from '../../src/adapters/teams/cards/mid-flight.ts';
import {
  EMOJI_VOCABULARY,
  buildStatusCard,
  makeStatusUpdate,
  reporterViolations,
} from '../../src/adapters/teams/cards/status.ts';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/cards/teams');
const ID = EXAMPLE_INCIDENT_ID;
const DANA = '29:1aB2cD3eF4gH5iJ6kL7mN8oP';

const examples = renderExamples();
const ex = (name: string): AdaptiveCard => {
  const c = examples[name];
  if (c === undefined) throw new Error(`no example ${name}`);
  return c;
};
const verbs = (c: AdaptiveCard) => (c.actions ?? []).map((a) => (a.type === 'Action.Execute' ? a.verb : a.title));
const bodyText = (c: AdaptiveCard) => c.body.map((b) => b.text).join('\n');

describe('teams cards', () => {
  it('are Adaptive Card 1.5 with Action.Execute actions', () => {
    for (const [name, c] of Object.entries(examples)) {
      expect(c.type, name).toBe('AdaptiveCard');
      expect(c.version, name).toBe('1.5');
      for (const a of c.actions ?? []) {
        expect(['Action.Execute', 'Action.OpenUrl'], name).toContain(a.type);
        if (a.type === 'Action.Execute') {
          expect(a.verb.length).toBeGreaterThan(0);
          expect(a.data.incidentId).toBe(ID);
        }
      }
    }
  });

  it('scope preview: looks-right, widen, narrow', () => {
    expect(verbs(ex('scope-preview'))).toEqual(['looks-right', 'widen', 'narrow']);
  });

  it('dedupe: link, create-anyway, not-related', () => {
    expect(verbs(ex('dedupe'))).toEqual(['link', 'create-anyway', 'not-related']);
    expect(ex('dedupe').actions?.[0]?.title).toBe('Link this thread to WEB-812');
  });

  it('clarify: option text is the verb, 2 to 4 options, none for a screenshot request', () => {
    expect(verbs(ex('clarify'))).toEqual(['Cart', 'Checkout', 'Product page']);
    const base = { audience: 'reporter' as const, text: 'Send a screenshot?', gatePassed: true, gateFailures: [] };
    expect(buildClarify(ID, { kind: 'clarify', question: base }).actions).toBeUndefined();
    expect(() => buildClarify(ID, { kind: 'clarify', question: { ...base, options: ['a'] } })).toThrow(RangeError);
    expect(() => buildClarify(ID, { kind: 'clarify', question: { ...base, options: ['a', 'b', 'c', 'd', 'e'] } })).toThrow(RangeError);
  });

  it('fix preview level 1 for engineers and reporters (role rules)', () => {
    expect(verbs(ex('fix-preview-level-1'))).toEqual(['approve_fix', 'ticket_only', 'dismiss']);
    expect(verbs(ex('fix-preview-level-1-reporter'))).toEqual(['ticket_only', 'dismiss']);
  });

  it('fix preview at levels 2 and 3: Stop, Not a bug, Fixing now badge', () => {
    for (const name of ['fix-preview-level-2', 'fix-preview-level-3']) {
      expect(verbs(ex(name))).toEqual(['stop', 'dismiss']);
      expect(bodyText(ex(name))).toContain('Fixing now');
    }
    expect(bodyText(ex('fix-preview-level-1'))).not.toContain('Fixing now');
  });

  it('claimed (A 2.1): filed and assigned to the claimer', () => {
    expect(verbs(ex('claimed'))).toEqual(['let-agent-take', 'dismiss']);
    expect(bodyText(ex('claimed'))).toContain('Filed as **WEB-1042** and assigned to <at>Dana</at>');
  });

  it('pr-ready: full set with a linked identity, Open PR only without', () => {
    expect(verbs(ex('pr-ready'))).toEqual(['Open PR', 'merge', 'request_changes', 'stop']);
    expect(ex('pr-ready').actions?.[0]).toEqual({ type: 'Action.OpenUrl', title: 'Open PR', url: 'https://github.com/example/web/pull/418' });
    expect(verbs(ex('pr-ready-no-identity'))).toEqual(['Open PR']);
    const text = bodyText(ex('pr-ready'));
    expect(text).toContain('PR #418 is ready');
    expect(text).toContain('review agent: approve, CI: green, 2 files, +41 -6');
    expect(text).toContain('<at>Dana</at>');
  });

  it('mid-flight (A 2.2): the run and claimer ride in data', () => {
    const c = ex('mid-flight');
    expect(verbs(c)).toEqual(['let_it_finish', 'stop_it']);
    for (const a of c.actions ?? []) {
      expect(a.type === 'Action.Execute' && a.data).toMatchObject({ runId: '01J9Z3N5P8S2T4V6W8X0Y2Z4AB', claimerId: 'U0WEBDEV1' });
    }
    expect(bodyText(c)).toContain('<at>Dana</at>, the fixer started on this 4 minutes ago and is on fix/WEB-1042.');
    expect(bodyText(c)).toContain('No answer in 10 minutes means **Let it finish**.');
    expect(midFlightChoiceOf('stop_it')).toBe('stop-it');
    expect(midFlightChoiceOf('nope')).toBeUndefined();
  });

  it('resolution prompt and scope change (A 3): the message rides in data', () => {
    expect(verbs(ex('resolution-prompt'))).toEqual(['close', 'keep-open']);
    expect(verbs(ex('scope-change'))).toEqual(['yes', 'same-bug']);
    for (const name of ['resolution-prompt', 'scope-change']) {
      for (const a of ex(name).actions ?? []) expect(a.type === 'Action.Execute' && a.data.messageId).toMatch(/^1727980000\./);
    }
  });

  it('file-confirm (never posted in Teams): File it, Not this surface, Cancel, with the evidence', () => {
    const c = buildCard(ID, { kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website', evidence: 'src/cart/total.ts' });
    expect(verbs(c)).toEqual(['file-it', 'not-this-surface', 'cancel']);
    expect(bodyText(c)).toContain('New. Looks like **Website** (from src/cart/total.ts). File it?');
    expect(bodyText(buildCard(ID, { kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website' }))).toContain('Looks like **Website**. File it?');
  });

  it('escapes markdown and markup in free text', () => {
    const c = buildCard(ID, { kind: 'scope-preview', summary: 'a <at>Bob</at> & **b** _c_' });
    expect(c.body[0]?.text).toBe('a &lt;at&gt;Bob&lt;/at&gt; & \\*\\*b\\*\\* \\_c\\_');
    expect(c.msteams).toBeUndefined();
  });
});

describe('mentions', () => {
  it('render as <at>name</at> plus an entity keyed by the AAD object id', () => {
    const c = ex('claimed');
    expect(c.msteams?.entities).toEqual([{ type: 'mention', text: '<at>Dana</at>', mentioned: { id: DANA, name: 'Dana' } }]);
  });

  it('an unknown ref stays @name and adds no entity', () => {
    const c = ex('fix-preview-unmapped-owner');
    expect(bodyText(c)).toContain('**Owner:** @U0WEBDEV1');
    expect(c.msteams).toBeUndefined();
    const status = buildStatusCard(ID, makeStatusUpdate('staging', { issueKey: 'WEB-1', reporterUserId: 'someone' }));
    expect(status.body[0]?.text).toContain('@someone');
    expect(status.msteams).toBeUndefined();
  });

  it('one entity per person even when mentioned twice', () => {
    const r = renderText('<@U0PAT> and <@U0PAT>', EXAMPLE_MENTIONS);
    expect(r.entities).toHaveLength(1);
    expect(r.text).toBe('<at>Pat</at> and <at>Pat</at>');
  });

  it('the map lookup matches teamsId, handle, or slackId and needs a teamsId', () => {
    const find = mentionsFromMap([
      { handle: 'Dana', teamsId: 'aad-1', slackId: 'U1' },
      { handle: 'Sam', slackId: 'U2' },
    ]);
    expect(find('aad-1')?.name).toBe('Dana');
    expect(find('dana')?.id).toBe('aad-1');
    expect(find('U1')?.id).toBe('aad-1');
    expect(find('Sam')).toBeUndefined();
    expect(find('nobody')).toBeUndefined();
  });
});

describe('refreshed and reduced mode', () => {
  it('replaces the actions with the line and keeps the mentions', () => {
    const c = ex('claimed-refreshed');
    expect(c.actions).toBeUndefined();
    expect(c.body.at(-1)?.text).toBe('Marcus chose: Not a bug.');
    expect(c.msteams?.entities?.map((e) => e.mentioned.id)).toEqual([DANA]);
    expect(ex('claimed').actions).toHaveLength(2);
  });

  it('a mention in the line gets its entity', () => {
    const c = refreshed(ex('dedupe'), '<@U0PAT> chose: Not related.', { mentions: EXAMPLE_MENTIONS });
    expect(c.body.at(-1)?.text).toBe('<at>Pat</at> chose: Not related.');
    expect(c.msteams?.entities?.map((e) => e.mentioned.name)).toContain('Pat');
  });

  it('reduced adds the one-line banner first, once', () => {
    expect(REDUCED_BANNER).toBe('Reduced mode: I can only read the message you sent me. A team owner can approve channel access.');
    expect(ex('scope-preview-reduced').body[0]?.text).toBe(REDUCED_BANNER);
    expect(ex('scope-preview').body[0]?.text).not.toBe(REDUCED_BANNER);
    expect(ex('status-staging-reduced').body[0]?.text).toBe(REDUCED_BANNER);
    const again = refreshed(ex('scope-preview-reduced'), 'done', { reduced: true });
    expect(again.body.filter((b) => b.text === REDUCED_BANNER)).toHaveLength(1);
    expect(refreshed(ex('scope-preview'), 'done', { reduced: true }).body[0]?.text).toBe(REDUCED_BANNER);
  });
});

describe('teams limits', () => {
  it('every example is under 28 KB with at most 6 actions per set', () => {
    for (const [name, c] of Object.entries(examples)) {
      expect(cardBytes(c), name).toBeLessThan(MAX_CARD_BYTES);
      expect((c.actions ?? []).length, name).toBeLessThanOrEqual(MAX_ACTIONS);
    }
    expect(MAX_CARD_BYTES).toBe(28 * 1024);
    expect(MAX_ACTIONS).toBe(6);
  });

  it('rejects a seventh action and duplicate verbs', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `t${String(i)}`, verb: `v${String(i)}` }));
    expect(() => actionSet(ID, seven)).toThrow(RangeError);
    expect(() => actionSet(ID, [])).toThrow(RangeError);
    expect(() => actionSet(ID, [{ title: 'a', verb: 'x' }, { title: 'b', verb: 'x' }])).toThrow(RangeError);
    expect(actionSet(ID, seven.slice(0, 6))).toHaveLength(6);
  });

  it('rejects a payload over 28 KB', () => {
    expect(() => buildCard(ID, { kind: 'scope-preview', summary: 'x'.repeat(MAX_CARD_BYTES) })).toThrow(RangeError);
    expect(cardBytes(buildCard(ID, { kind: 'scope-preview', summary: 'x'.repeat(12_000) }))).toBeLessThan(MAX_CARD_BYTES);
  });
});

describe('status card', () => {
  const ctx = { issueKey: 'WEB-1042', ownerUserId: 'U0WEBDEV1', actorName: 'Dana', reporterUserId: 'U0PAT', reason: 'risk gate (touched infrastructure)' };
  const stages: StatusStage[] = ['filed', 'clarified', 'fixing', 'pr-open', 'review-passed', 'held', 'merged', 'stopped', 'failed', 'staging', 'production', 'reverted'];
  const o = { mentions: EXAMPLE_MENTIONS };

  it('renders the neutral copy with the owner mentioned', () => {
    const c = ex('status-filed');
    expect(c.body[0]?.text).toBe('\u{1F41B} Filed as WEB-1042, assigned to <at>Dana</at>.');
    expect(c.msteams?.entities?.[0]?.mentioned.id).toBe(DANA);
    expect(c.fallbackText).toContain('@U0WEBDEV1');
  });

  it('reporter-facing copy has no file path, branch name, or "PR"', () => {
    for (const stage of stages) {
      for (const automatic of [false, true]) {
        const c = buildStatusCard(ID, makeStatusUpdate(stage, { ...ctx, automatic }), o);
        expect(reporterViolations(c.fallbackText), `${stage}: ${c.fallbackText}`).toEqual([]);
      }
    }
  });

  it('uses only the fixed emoji vocabulary', () => {
    for (const stage of stages) {
      const first = buildStatusCard(ID, makeStatusUpdate(stage, ctx), o).fallbackText.split(' ')[0]!;
      expect(EMOJI_VOCABULARY).toContain(first);
    }
  });

  it('actions: Stop while fixing, Revert after autopilot, none otherwise', () => {
    expect(verbs(buildStatusCard(ID, makeStatusUpdate('fixing', ctx), o))).toEqual(['stop']);
    expect(verbs(buildStatusCard(ID, makeStatusUpdate('merged', { ...ctx, automatic: true }), o))).toEqual(['revert']);
    expect(buildStatusCard(ID, makeStatusUpdate('production', ctx), o).actions).toBeUndefined();
  });
});

describe('docs/cards/teams', () => {
  const render = (c: AdaptiveCard) => `${JSON.stringify(c, null, 2)}\n`;

  it('matches the rendered cards (UPDATE_CARDS=1 rewrites them)', () => {
    if (process.env.UPDATE_CARDS === '1') {
      mkdirSync(docsDir, { recursive: true });
      for (const [name, c] of Object.entries(examples)) writeFileSync(join(docsDir, `${name}.json`), render(c));
    }
    const files = readdirSync(docsDir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(Object.keys(examples).map((n) => `${n}.json`).sort());
    for (const [name, c] of Object.entries(examples)) {
      expect(readFileSync(join(docsDir, `${name}.json`), 'utf8'), `${name}.json drifted`).toBe(render(c));
    }
  });

  it('card strings pass the prose lint (no em dashes)', () => {
    for (const c of Object.values(examples)) expect(JSON.stringify(c)).not.toMatch(/—|&mdash;/);
  });
});
