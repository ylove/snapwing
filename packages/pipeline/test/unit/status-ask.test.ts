// The shared status question (A 4.3): load, resolve, load what the answer names, answer; and the
// matcher that decides whether a direct message is a question at all. Both chat adapters call these.

import { describe, expect, it } from 'vitest';
import type { IncidentEvent } from '../../src/contracts/events.ts';
import type { IncidentActor } from '../../src/contracts/incident.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { foldIncident } from '../../src/state/projections/incidents.ts';
import { createStatusAsk, looksLikeStatusQuestion, surfaceWords, type StatusReadState } from '../../src/status/ask.ts';

const WS = '01JZ0000000000000000000001';
const BASE = Date.parse('2026-10-01T14:00:00.000Z');
const CHANNEL = 'C-FAKE-WEB';
const REPORTER: IncidentActor = { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' };

const MAP: WorkspaceMap = {
  org: 'fake-org',
  updated: '2026-10-01T00:00:00Z',
  surfaces: [
    { id: 'web', label: 'Website', repo: 'github.com/fake-org/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [{ id: 'checkout', label: 'Checkout' }] },
    { id: 'app', label: 'Mobile app', repo: 'github.com/fake-org/app', jira: { project: 'APP', defaultIssueType: 'Bug' }, components: [] },
  ],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
  triggers: { messageActions: [], emoji: [] },
  vocabulary: [],
  people: [],
  policies: {
    autonomy: {
      default: 1,
      levels: [
        { id: 0, name: 'ticket-only', fixer: 'never', merge: 'none', requires: [] },
        { id: 1, name: 'fix-on-tap', fixer: 'on-tap', merge: 'human', requires: [] },
        { id: 2, name: 'fix-now', fixer: 'immediate', merge: 'human', requires: [] },
        { id: 3, name: 'autopilot', fixer: 'immediate', merge: 'agent', requires: ['review-agent', 'ci-green', 'risk-gate'] },
      ],
      overrides: [],
    },
  },
};

interface Built {
  view: IncidentView;
  log: IncidentEvent[];
}

function build(id: string, key: string, summary: string, surface: string, thread?: string): Built {
  const payloads: [string, unknown][] = [
    [
      'captured',
      {
        kind: 'incident',
        idempotencyKey: `slack:${id}`,
        source: 'slack',
        reporter: REPORTER,
        anchorText: summary,
        channelId: CHANNEL,
        anchorId: `1700000000.${id.slice(-6)}`,
        ...(thread === undefined ? {} : { threadId: thread }),
      },
    ],
    ['context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 1, excludedCount: 0 }],
    ['resolved', { surfaceId: surface, repo: `github.com/fake-org/${surface}`, resolvedBy: 'channel-explicit', confidence: 0.9 }],
    ['dedupe-checked', { candidates: [], decision: 'none' }],
    [
      'planned',
      {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary,
        priority: 'Medium',
        labels: ['snapwing'],
        autonomyLevel: 2,
        implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
      },
    ],
    ['filed', { jiraKey: key }],
  ];
  let view: IncidentView | undefined;
  const log: IncidentEvent[] = [];
  payloads.forEach(([type, payload], i) => {
    const at = new Date(BASE + i * 60_000).toISOString();
    const event = { workspaceId: WS, incidentId: id, seq: i + 1, v: 1, type, source: 'agent', occurredAt: at, recordedAt: at, payload } as unknown as IncidentEvent;
    log.push(event);
    const fold = foldIncident(view, event, log);
    if (fold.view === undefined) throw new Error(`no row after ${type}`);
    view = fold.view;
  });
  if (view === undefined) throw new Error('empty script');
  return { view, log };
}

const CART = build('01JZ00000000000000000000A1', 'WEB-1042', 'Blank cart total', 'web', '1700000000.000100');
const LOGIN = build('01JZ00000000000000000000A2', 'APP-7', 'Login spinner never stops', 'app');

/** A read-only state that counts what the question reads, so a test can see what was loaded. */
function fakeState(built: readonly Built[]) {
  const reads: string[] = [];
  const state: StatusReadState = {
    findIncidents: () => Promise.resolve(built.map((b) => b.view)),
    read: (id) => {
      reads.push(id);
      return Promise.resolve(built.find((b) => b.view.id === id)?.log ?? []);
    },
    getClaims: () => Promise.resolve([]),
    getSubscriptions: () => Promise.resolve([]),
  };
  return { state, reads };
}

function ask(text: string, context: { channelId?: string; threadId?: string } = {}, built: readonly Built[] = [CART, LOGIN]) {
  const { state, reads } = fakeState(built);
  const run = createStatusAsk({ state, workspaceId: WS, getMap: () => Promise.resolve(MAP), clock: () => new Date(BASE + 3_600_000) });
  return { answer: run({ asker: REPORTER, text, context }), reads };
}

describe('createStatusAsk', () => {
  it('answers a key question about the named incident', async () => {
    const { answer } = ask('WEB-1042?');
    const a = await answer;
    expect(a.incidentId).toBe(CART.view.id);
    expect(a.text).toContain('WEB-1042');
  });

  it("finds a thread's incident through the log, which only the first pass loads", async () => {
    const { answer, reads } = ask('where are we with this?', { channelId: CHANNEL, threadId: '1700000000.000100' });
    expect((await answer).incidentId).toBe(CART.view.id);
    expect(reads).toContain(CART.view.id);
  });

  it('reads the logs of the incidents it names and no others when no channel is given', async () => {
    const { answer, reads } = ask('APP-7');
    expect((await answer).incidentId).toBe(LOGIN.view.id);
    expect(reads.filter((id) => id === LOGIN.view.id).length).toBe(1);
  });

  it('answers a question that matches nothing without an incident', async () => {
    const { answer } = ask('the quarterly newsletter');
    expect((await answer).incidentId).toBeUndefined();
  });

  it('answers over an empty workspace', async () => {
    const { answer } = ask('status?', {}, []);
    expect((await answer).incidentId).toBeUndefined();
  });
});

describe('looksLikeStatusQuestion', () => {
  it('accepts status questions and bare keys', () => {
    for (const q of ["what's open on the website?", 'where are we with the nav bug', 'any update on checkout', 'is WEB-1042 fixed', 'status?', 'status of web', 'WEB-1042?']) {
      expect(looksLikeStatusQuestion(q), q).toBe(true);
    }
  });

  it('strips mentions and leading pleasantries', () => {
    expect(looksLikeStatusQuestion('<@U123> hey, can you tell me where are we with the cart')).toBe(true);
  });

  it('leaves reports and empty text alone', () => {
    for (const r of ['status page is down', 'the checkout button is broken', '', '   ', '<@U123>']) {
      expect(looksLikeStatusQuestion(r), r).toBe(false);
    }
  });

  it('counts `status <surface>` only when it names a known surface exactly', () => {
    expect(looksLikeStatusQuestion('status web')).toBe(false);
    expect(looksLikeStatusQuestion('status web', [])).toBe(false);
    expect(looksLikeStatusQuestion('Status WEBSITE?', ['web', 'Website'])).toBe(true);
    expect(looksLikeStatusQuestion('status page', ['web', 'Website'])).toBe(false);
  });
});

describe('surfaceWords', () => {
  it('lists each surface id and label', () => {
    expect(surfaceWords(MAP)).toEqual(['web', 'Website', 'app', 'Mobile app']);
  });
});
