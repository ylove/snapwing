// Ticket synthesis (main 9.1, 9.2; B 7.2). No model, no network: the plan is built by hand.

import { describe, expect, it } from 'vitest';
import type { CanonicalIncidentPayload, ContextBundle, Resolution, TriageResolutionPlan } from '../../src/contracts/incident.ts';
import { checkAdf, doc, paragraph, text } from '../../src/jira/adf.ts';
import { synthesizeIssue } from '../../src/jira/synthesis.ts';
import type { AutonomyLevel, SynthesisContext } from '../../src/jira/synthesis.ts';
import { parseImplementationRequest } from '../../src/prompts/implementation-request.ts';

const payload: CanonicalIncidentPayload = {
  eventId: '01K0000000000000000000S001',
  idempotencyKey: 'synthesis-test',
  source: 'slack',
  reporter: { id: 'U0TEST', name: 'Pat Reporter', email: 'pat@example.com', role: 'reporter' },
  anchorText: 'cart total is blank after I put in the discount code',
  context: { channelId: 'C0MARKET', deepLink: 'https://example.test/archives/C0MARKET/p1727540000000100', rawPayloadSnapshot: {} },
  timestamp: '2026-10-02T09:00:00.000Z',
};

const bundle: ContextBundle = {
  anchorId: 'anchor',
  included: [
    {
      id: 'anchor',
      authorId: 'U0TEST',
      text: payload.anchorText,
      timestamp: payload.timestamp,
      mentions: [],
      reactions: [],
      attachments: [
        {
          kind: 'image',
          url: 'https://files.example.test/cart-blank.png?token=fake',
          reading: {
            surfaceSignals: { urlBar: 'shop.example.test/checkout' },
            uiElements: [],
            environmentHint: 'production',
            plainDescription: 'the total field is blank',
            sensitive: false,
          },
        },
      ],
    },
  ],
  excluded: [],
  windowUsed: { oldest: payload.timestamp, latest: payload.timestamp, cap: 20 },
};

const resolution: Resolution = { surfaceId: 'web', componentId: 'checkout', resolvedBy: 'channel-explicit', confidence: 0.9 };

function planAt(level: AutonomyLevel, overrides: Partial<TriageResolutionPlan> = {}): TriageResolutionPlan {
  return {
    action: 'create_issue',
    projectKey: 'WEB',
    issueType: 'Bug',
    summary: 'Cart total is blank after applying a promo code',
    descriptionAdf: doc(paragraph(text('Line items lose their price when a promo is applied after a quantity change.'))),
    priority: 'High',
    labels: ['checkout', 'regression'],
    componentId: 'checkout',
    suggestedAssigneeEmail: 'dev@example.com',
    diagnosis: { confidence: 'medium', files: [{ path: 'src/promo/apply.ts', note: 'reads price from a stale snapshot' }] },
    autonomyLevel: level,
    ...overrides,
  };
}

const ctx: SynthesisContext = { payload, resolution, repro: 'Change quantity, then apply a promo code.' };

describe('synthesizeIssue', () => {
  it.each([
    [0, 'review'],
    [1, 'review'],
    [2, 'review'],
    [3, 'auto'],
  ] as const)('level %i writes a valid prompt with handoff mode %s', async (level, mode) => {
    const issue = await synthesizeIssue(planAt(level), bundle, level, ctx);

    expect(issue.promptErrors).toEqual([]);
    expect(issue.fields.labels).not.toContain('prompt-failed');
    expect(issue.fields.project).toEqual({ key: 'WEB' });
    expect(issue.fields.issuetype).toEqual({ name: 'Bug' });
    expect(issue.fields.summary).toBe('Cart total is blank after applying a promo code');
    expect(issue.fields.priority).toEqual({ name: 'High' });
    expect(issue.customFields['Autonomy Level']).toBe(level);
    expect(issue.customFields['Conversation Link']).toBe(payload.context.deepLink);
    expect(issue.suggestedAssigneeEmail).toBe('dev@example.com');

    const request = parseImplementationRequest(issue.customFields['Implementation Prompt']);
    expect(request.handoff).toMatchObject({ mode, autonomy: level });
    expect(request.kind).toBe('single');
    expect(request.issue).toBe('WEB-0');
    expect(request.intent).toBe('Cart total is blank after applying a promo code');
    if (request.kind === 'single') {
      expect(request.diagnosis?.by).toBe('scout');
      expect(request.evidence.map((e) => e.kind)).toEqual(['report', 'screenshot', 'alert']);
      expect(request.evidence[1]).toEqual({ kind: 'screenshot', ref: 'attachment:WEB-0/cart-blank.png' });
    }
  });

  it('labels the ticket per 9.1', async () => {
    const issue = await synthesizeIssue(planAt(1), bundle, 1, { ...ctx, needsClarification: true });
    expect(issue.fields.labels).toEqual(['snapwing', 'slack', 'web', 'needs-clarification', 'checkout', 'regression']);
  });

  it('builds a valid ADF description with reporter, symptom, environment, repro, and the deep link', async () => {
    const issue = await synthesizeIssue(planAt(2), bundle, 2, ctx);
    const adf = issue.fields.description;
    expect(checkAdf(adf)).toEqual([]);

    const flat = adf.content.map((p) => p.content.map((n) => n.text).join(''));
    expect(flat[0]).toBe('Reporter: Pat Reporter (pat@example.com)');
    expect(flat[1]).toBe(`Symptom: ${payload.anchorText}`);
    expect(flat[2]).toBe('Environment: web, production, shop.example.test/checkout, reported via slack');
    expect(flat[3]).toBe('Repro: Change quantity, then apply a promo code.');
    expect(flat[4]).toBe(`Conversation: ${payload.context.deepLink}`);
    expect(adf.content[4]?.content[1]?.marks).toEqual([{ type: 'link', attrs: { href: payload.context.deepLink } }]);
    expect(flat[5]).toBe('Line items lose their price when a promo is applied after a quantity change.');
  });

  describe('a capture flagged by someone other than its author (#365)', () => {
    const flagged: CanonicalIncidentPayload = {
      ...payload,
      reporter: { id: 'U0ENG', name: 'mobDev', email: 'dev@example.com', role: 'engineer' },
      anchorAuthor: { id: 'U0TEST', name: 'Pat Reporter', email: 'pat@example.com', role: 'reporter' },
    };

    it('the Reporter line names the anchor author and "Flagged by" names the flagger', async () => {
      const issue = await synthesizeIssue(planAt(2), bundle, 2, { ...ctx, payload: flagged });
      expect(checkAdf(issue.fields.description)).toEqual([]);
      const flat = issue.fields.description.content.map((p) => p.content.map((n) => n.text).join(''));
      expect(flat.slice(0, 3)).toEqual(['Reporter: Pat Reporter (pat@example.com)', 'Flagged by: @mobDev', `Symptom: ${payload.anchorText}`]);
    });

    it('the implementation request report names the anchor author', async () => {
      const issue = await synthesizeIssue(planAt(2), bundle, 2, { ...ctx, payload: flagged });
      const request = parseImplementationRequest(issue.customFields['Implementation Prompt']);
      expect(request.kind === 'single' ? request.evidence[0] : undefined).toMatchObject({ kind: 'report', reporter: 'pat@example.com' });
    });

    it('with no anchorAuthor (an old log) or the author flagging their own post, nothing changes', async () => {
      for (const p of [payload, { ...payload, anchorAuthor: payload.reporter }]) {
        const issue = await synthesizeIssue(planAt(2), bundle, 2, { ...ctx, payload: p });
        const flat = issue.fields.description.content.map((n) => n.content.map((t) => t.text).join(''));
        expect(flat[0]).toBe('Reporter: Pat Reporter (pat@example.com)');
        expect(flat.some((l) => l.startsWith('Flagged by'))).toBe(false);
        const request = parseImplementationRequest(issue.customFields['Implementation Prompt']);
        expect(request.kind === 'single' ? request.evidence[0] : undefined).toMatchObject({ reporter: 'pat@example.com' });
      }
    });
  });

  it('omits repro and the conversation link when unknown', async () => {
    const { deepLink: _drop, ...noLink } = payload.context;
    const issue = await synthesizeIssue(planAt(0), bundle, 0, { payload: { ...payload, context: noLink }, resolution });
    const flat = issue.fields.description.content.map((p) => p.content.map((n) => n.text).join(''));
    expect(flat.some((l) => l.startsWith('Repro:') || l.startsWith('Conversation:'))).toBe(false);
    expect(issue.customFields).not.toHaveProperty('Conversation Link');
    expect(checkAdf(issue.fields.description)).toEqual([]);
  });

  it('leaves the prompt empty and adds prompt-failed when the request does not validate', async () => {
    const bad = planAt(2, { diagnosis: { confidence: 'low', files: [{ path: '', note: 'no path' }] } });
    const issue = await synthesizeIssue(bad, bundle, 2, ctx);

    expect(issue.customFields['Implementation Prompt']).toBe('');
    expect(issue.promptErrors.length).toBeGreaterThan(0);
    expect(issue.fields.labels).toContain('prompt-failed');
    // The ticket is still fully formed.
    expect(issue.fields.summary).toBe(bad.summary);
    expect(issue.customFields['Autonomy Level']).toBe(2);
    expect(checkAdf(issue.fields.description)).toEqual([]);
  });
});

describe('checkAdf', () => {
  it('rejects shapes Jira would refuse', () => {
    expect(checkAdf(null)).not.toEqual([]);
    expect(checkAdf({ type: 'doc', version: 2, content: [] })).not.toEqual([]);
    expect(checkAdf({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] })).not.toEqual([]);
    expect(
      checkAdf({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:1' } }] }] }] }),
    ).not.toEqual([]);
  });
});
