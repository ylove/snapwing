import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StatusStage } from '@snapwing/pipeline/contracts/adapters.ts';
import { MAX_BUTTON_VALUE, type ActionsBlock, type SlackMessage } from '../../src/adapters/slack/cards/blocks.ts';
import { buildCard, buildClarify } from '../../src/adapters/slack/cards/cards.ts';
import { EXAMPLE_INCIDENT_ID, renderExamples } from '../../src/adapters/slack/cards/examples.ts';
import {
  EMOJI_VOCABULARY,
  buildStatusMessage,
  makeStatusUpdate,
  reporterViolations,
  statusCopy,
} from '../../src/adapters/slack/cards/status.ts';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/cards/slack');
const ID = EXAMPLE_INCIDENT_ID;

function buttons(msg: SlackMessage) {
  const block = msg.blocks.find((b): b is ActionsBlock => b.type === 'actions');
  return block?.elements ?? [];
}

const examples = renderExamples();

describe('slack cards', () => {
  it('scope preview: looks-right, widen, narrow', () => {
    expect(buttons(examples['scope-preview']!).map((b) => b.action_id)).toEqual(['looks-right', 'widen', 'narrow']);
  });

  it('dedupe: link, create-anyway, not-related', () => {
    const b = buttons(examples['dedupe']!);
    expect(b.map((x) => x.action_id)).toEqual(['link', 'create-anyway', 'not-related']);
    expect(b[0]?.text.text).toBe('Link this thread to WEB-812');
  });

  it('clarify: option text is the action_id, 2 to 4 options, none for a screenshot request', () => {
    expect(buttons(examples['clarify']!).map((b) => b.action_id)).toEqual(['Cart', 'Checkout', 'Product page']);
    const base = { audience: 'reporter' as const, text: 'Send a screenshot?', gatePassed: true, gateFailures: [] };
    expect(buttons(buildClarify(ID, { kind: 'clarify', question: base }))).toEqual([]);
    expect(() => buildClarify(ID, { kind: 'clarify', question: { ...base, options: ['a'] } })).toThrow(RangeError);
    expect(() => buildClarify(ID, { kind: 'clarify', question: { ...base, options: ['a', 'b', 'c', 'd', 'e'] } })).toThrow(RangeError);
  });

  it('fix preview level 1 for engineers and reporters', () => {
    expect(buttons(examples['fix-preview-level-1']!).map((b) => b.action_id)).toEqual(['approve_fix', 'ticket_only', 'dismiss']);
    expect(buttons(examples['fix-preview-level-1-reporter']!).map((b) => b.action_id)).toEqual(['ticket_only', 'dismiss']);
  });

  it('fix preview at levels 2 and 3: Stop, Not a bug, Fixing now badge', () => {
    for (const name of ['fix-preview-level-2', 'fix-preview-level-3']) {
      const msg = examples[name]!;
      expect(buttons(msg).map((b) => b.action_id)).toEqual(['stop', 'dismiss']);
      expect(JSON.stringify(msg.blocks[0])).toContain('Fixing now');
    }
    expect(JSON.stringify(examples['fix-preview-level-1']!.blocks[0])).not.toContain('Fixing now');
  });

  it('pr-ready: full set with a linked identity, Open PR only without', () => {
    expect(buttons(examples['pr-ready']!).map((b) => b.action_id)).toEqual(['open_pr', 'merge', 'request_changes', 'stop']);
    expect(buttons(examples['pr-ready-no-identity']!).map((b) => b.action_id)).toEqual(['open_pr']);
    const text = JSON.stringify(examples['pr-ready']!.blocks[0]);
    expect(text).toContain('PR #418 is ready');
    expect(text).toContain('review agent: approve, CI: green, 2 files, +41 -6');
    expect(text).toContain('<@U0WEBDEV1>');
  });

  it('every button carries the incident id and a bounded action_id', () => {
    for (const msg of Object.values(examples)) {
      for (const b of buttons(msg)) {
        expect(b.value).toBe(ID);
        expect(b.value.length).toBeLessThan(MAX_BUTTON_VALUE);
        expect(b.action_id.length).toBeGreaterThan(0);
        expect(b.action_id.length).toBeLessThanOrEqual(255);
      }
    }
  });

  it('rejects a value over the Slack limit', () => {
    expect(() => buildCard('x'.repeat(2001), { kind: 'scope-preview', summary: 's' })).toThrow(RangeError);
  });

  it('escapes Slack control characters in free text', () => {
    const msg = buildCard(ID, { kind: 'scope-preview', summary: 'a <!channel> & b' });
    expect(JSON.stringify(msg.blocks[0])).toContain('a &lt;!channel&gt; &amp; b');
  });
});

describe('status copy', () => {
  const ctx = { issueKey: 'WEB-1042', ownerUserId: 'U0WEBDEV1', actorName: 'Dana', reporterUserId: 'U0PAT', reason: 'risk gate (touched infrastructure)' };

  it('follows main 12 row by row', () => {
    expect(statusCopy('filed', ctx)).toBe('Filed as WEB-1042, assigned to <@U0WEBDEV1>.');
    expect(statusCopy('fixing', ctx)).toBe('Filed as WEB-1042. Working on a fix now.');
    expect(statusCopy('pr-open', ctx)).toBe('A fix is up. Review requested from <@U0WEBDEV1>.');
    expect(statusCopy('review-passed', ctx)).toBe('Review passed, waiting on merge.');
    expect(statusCopy('merged', ctx)).toBe('Merged by Dana. Rolling out to staging.');
    expect(statusCopy('merged', { ...ctx, automatic: true })).toBe('Merged automatically (review: approve, CI: green).');
    expect(statusCopy('held', ctx)).toBe('Held for human review: risk gate (touched infrastructure). <@U0WEBDEV1> requested.');
    expect(statusCopy('stopped', { ...ctx, actorName: 'Marcus' })).toBe('Stopped by Marcus. Ticket back in Backlog.');
    expect(statusCopy('failed', ctx)).toBe("Couldn't produce a passing fix. A draft with what it tried is saved. <@U0WEBDEV1> pinged.");
    expect(statusCopy('staging', ctx)).toBe('Fix is on staging. <@U0PAT>, can you check?');
    expect(statusCopy('production', ctx)).toBe('Live. Closing WEB-1042.');
    expect(statusCopy('clarified', ctx)).toBe('Thanks, that answered it. Moving ahead.');
    expect(statusCopy('reverted', ctx)).toBe('Reverted. WEB-1042 is open again.');
  });

  const stages: StatusStage[] = ['filed', 'clarified', 'fixing', 'pr-open', 'review-passed', 'held', 'merged', 'stopped', 'failed', 'staging', 'production', 'reverted'];

  it('reporter-facing copy has no file path, branch name, or "PR"', () => {
    for (const stage of stages) {
      for (const automatic of [false, true]) {
        const msg = buildStatusMessage(ID, makeStatusUpdate(stage, { ...ctx, automatic }));
        expect(reporterViolations(msg.text), `${stage}: ${msg.text}`).toEqual([]);
      }
    }
  });

  it('replaces an unsafe held reason with a generic one', () => {
    expect(statusCopy('held', { ...ctx, reason: 'risk gate (touched infra/prod.yaml)' })).toContain('a safety check');
    expect(statusCopy('held', { ...ctx, reason: 'PR touches CI config' })).toContain('a safety check');
  });

  it('the violation detector catches paths, branches, and PR', () => {
    expect(reporterViolations('see src/cart/lineItem.ts')).not.toEqual([]);
    expect(reporterViolations('lineItem.ts')).not.toEqual([]);
    expect(reporterViolations('branch task/129-cards')).not.toEqual([]);
    expect(reporterViolations('A PR is up')).not.toEqual([]);
    expect(reporterViolations('Fix <https://example.com/a/b|here> <@U1>')).toEqual([]);
  });

  it('uses only the fixed emoji vocabulary', () => {
    for (const stage of stages) {
      const first = buildStatusMessage(ID, makeStatusUpdate(stage, ctx)).text.split(' ')[0]!;
      expect(EMOJI_VOCABULARY).toContain(first);
    }
  });

  it('status buttons: Stop while fixing, Revert after autopilot, none otherwise', () => {
    expect(buttons(buildStatusMessage(ID, makeStatusUpdate('fixing', ctx))).map((b) => b.action_id)).toEqual(['stop']);
    expect(buttons(buildStatusMessage(ID, makeStatusUpdate('merged', { ...ctx, automatic: true }))).map((b) => b.action_id)).toEqual(['revert']);
    expect(buttons(buildStatusMessage(ID, makeStatusUpdate('production', ctx)))).toEqual([]);
  });
});

describe('docs/cards/slack', () => {
  const render = (m: SlackMessage) => `${JSON.stringify(m, null, 2)}\n`;

  it('matches the rendered cards (UPDATE_CARDS=1 rewrites them)', () => {
    if (process.env.UPDATE_CARDS === '1') {
      mkdirSync(docsDir, { recursive: true });
      for (const [name, msg] of Object.entries(examples)) writeFileSync(join(docsDir, `${name}.json`), render(msg));
    }
    const files = readdirSync(docsDir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(Object.keys(examples).map((n) => `${n}.json`).sort());
    for (const [name, msg] of Object.entries(examples)) {
      expect(readFileSync(join(docsDir, `${name}.json`), 'utf8'), `${name}.json drifted`).toBe(render(msg));
    }
  });

  it('card strings pass the prose lint (no em dashes)', () => {
    for (const msg of Object.values(examples)) expect(JSON.stringify(msg)).not.toMatch(/—|&mdash;/);
  });
});
