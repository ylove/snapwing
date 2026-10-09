// Claims arriving mid-flight (A 2.2). Same world as fixer-job.test.ts: in-process workflow over
// the dialect `SNAPWING_DB` selects, a fake runner and GitHub. The card, the notice, and the assignee
// write are recorded by fake MidFlightPorts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import {
  answerMidFlight,
  handleMidFlightClaim,
  midFlightText,
  registerMidFlightJobs,
  type MidFlightCard,
  type MidFlightDeps,
  type MidFlightPorts,
} from '../../src/fixer/claims.ts';
import { activeRun, latest, registerFixerJobs, startFixer, type FixerGitHub, type FixerGitHubContext } from '../../src/fixer/job.ts';
import type { FixerJob, RunnerPort } from '../../src/ports/runner.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6MIDFLIGHT00000000000A';
const REPO = 'fake-org/web';
const DANA = { id: 'U-FAKE-DANA', role: 'engineer' } as const;
const PAT = { id: 'U-FAKE-PAT', role: 'reporter' } as const;
const MINUTE = 60_000;

type Claimer = { id: string; role: 'engineer' | 'reporter' };

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

// Fakes -------------------------------------------------------------------------------------------

class FakeRunner implements RunnerPort {
  readonly started: { runId: string; job: FixerJob }[] = [];
  readonly cancelled: string[] = [];

  runFixer(job: FixerJob): Promise<{ runId: string }> {
    this.started.push({ runId: job.runId, job });
    return Promise.resolve({ runId: job.runId });
  }

  cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    return Promise.resolve();
  }
}

class FakeGitHub implements FixerGitHub {
  readonly incomplete: { branch: string; ctx: FixerGitHubContext }[] = [];
  readonly closed: { pr: number; comment: string; ctx: FixerGitHubContext }[] = [];

  markIncomplete(branch: string, ctx: FixerGitHubContext): Promise<void> {
    this.incomplete.push({ branch, ctx });
    return Promise.resolve();
  }

  closePr(pr: number, comment: string, ctx: FixerGitHubContext): Promise<void> {
    this.closed.push({ pr, comment, ctx });
    return Promise.resolve();
  }
}

class FakePorts implements MidFlightPorts {
  readonly cards: MidFlightCard[] = [];
  readonly notices: string[] = [];
  readonly assigned: string[] = [];

  postCard(_incidentId: string, card: MidFlightCard): Promise<void> {
    this.cards.push(card);
    return Promise.resolve();
  }

  notify(_incidentId: string, text: string): Promise<void> {
    this.notices.push(text);
    return Promise.resolve();
  }

  assign(_incidentId: string, claimerId: string): Promise<void> {
    this.assigned.push(claimerId);
    return Promise.resolve();
  }
}

interface World {
  deps: MidFlightDeps;
  runner: FakeRunner;
  github: FakeGitHub;
  ports: FakePorts;
}

async function setup(opts: { grace?: string } = {}): Promise<World> {
  const runner = new FakeRunner();
  const github = new FakeGitHub();
  const ports = new FakePorts();
  const deps: MidFlightDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    runner,
    github,
    config: { harness: { adapter: 'claude-code' } },
    clock: () => new Date(now),
    ports,
    ...(opts.grace === undefined ? {} : { midFlightGrace: opts.grace }),
  };
  registerFixerJobs(deps);
  registerMidFlightJobs(deps);
  const put = await state.putArtifact({
    workspaceId: WS,
    incidentId: INC,
    kind: 'implementation-request',
    contentType: 'application/xml',
    body: '<implementation-request/>',
    createdBy: 'orchestrator',
  });
  await append(...toFiled({ artifactId: put.id, version: put.version }));
  return { deps, runner, github, ports };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'fixer' | 'github' = 'agent'): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source, occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

function toFiled(request: { artifactId: string; version: number }): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: REPO, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: 3,
      implementationRequest: request,
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await log()).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function types(): Promise<EventType[]> {
  return (await log()).map((e) => e.type);
}

async function advance(ms: number): Promise<void> {
  now += ms;
  await wf.drain();
}

/** The fixer starts and its run reports `branched`; returns the run id. */
async function running(w: World, branch = 'fix/WEB-1042'): Promise<string> {
  await startFixer(w.deps, { incidentId: INC, attempt: 1 });
  await wf.drain();
  const run = w.runner.started.at(-1);
  if (run === undefined) throw new Error('the fixer did not start');
  await append(ev('fixer-checkpoint', { phase: 'branched', detail: branch }, 'fixer'));
  return run.runId;
}

/** A claim, appended as the Slack adapter does; returns its seq. */
async function claim(actor: Claimer): Promise<number> {
  const e = { ...ev('claimed', { claimerId: actor.id, expiresAt: new Date(now + 240 * MINUTE).toISOString() }), actor };
  await append(e as NewEvent);
  return (await log()).at(-1)?.seq ?? 0;
}

// Tests -------------------------------------------------------------------------------------------

describe(`claims arriving mid-flight (${TEST_DIALECT})`, () => {
  it('does not abort the run: a card offers both choices with the run age and branch', async () => {
    const w = await setup();
    const runId = await running(w);
    await advance(4 * MINUTE);

    const offer = await handleMidFlightClaim(w.deps, INC, await claim(DANA));

    expect(offer.offered).toBe(true);
    expect(w.ports.cards).toEqual([
      {
        kind: 'mid-flight',
        issueKey: 'WEB-1042',
        claimerUserId: DANA.id,
        runId,
        runAgeMs: 4 * MINUTE,
        branch: 'fix/WEB-1042',
        choices: ['let-it-finish', 'stop-it'],
        grace: 'PT10M',
      },
    ]);
    expect(midFlightText(w.ports.cards[0] as MidFlightCard, '@dana')).toBe('@dana, the fixer started on this 4 minutes ago and is on `fix/WEB-1042`.');
    expect(activeRun(await log())?.payload.runId).toBe(runId);
    expect(w.runner.cancelled).toEqual([]);
    expect(await types()).not.toContain('stopped');
  });

  it('shows the fixer-written branch as one short line with no backtick, control, or bidirectional character (#306)', async () => {
    const w = await setup();
    await running(w, `fix/a\u202e\`<@U0EVIL>\`\n\u0007${'x'.repeat(200)}`);
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));
    const branch = (w.ports.cards[0] as MidFlightCard).branch ?? '';
    expect(branch.startsWith('fix/a<@U0EVIL>')).toBe(true);
    expect(branch).toHaveLength(120);
    // eslint-disable-next-line no-control-regex
    expect(branch).not.toMatch(/[`\u0000-\u001f\u202e]/);
  });

  it('Let it finish: the run goes on, nothing is stopped or assigned, and the grace timer is gone', async () => {
    const w = await setup();
    const runId = await running(w);
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));

    const answer = await answerMidFlight(w.deps, { incidentId: INC, runId, claimerId: DANA.id, choice: 'let-it-finish', actor: DANA });
    expect(answer).toEqual({ accepted: true, choice: 'let-it-finish' });

    await advance(10 * MINUTE);
    expect(w.ports.notices).toEqual([]);
    expect(w.ports.assigned).toEqual([]);
    expect(w.runner.cancelled).toEqual([]);
    expect(await types()).not.toContain('stopped');
  });

  it('Stop it: stopIncident runs, the branch is left, an open PR is closed, and the claimer is assigned', async () => {
    const w = await setup();
    const runId = await running(w);
    await append(ev('fixer-checkpoint', { phase: 'pr-opened', detail: '#87' }, 'fixer'));
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));

    const answer = await answerMidFlight(w.deps, { incidentId: INC, runId, claimerId: DANA.id, choice: 'stop-it', actor: DANA });

    expect(answer).toEqual({ accepted: true, choice: 'stop-it', stop: { stopped: true, cancelledRun: runId, closedPr: 87 } });
    expect(w.runner.cancelled).toEqual([runId]);
    expect(w.github.closed).toHaveLength(1);
    expect(w.github.closed[0]?.comment).toContain('the branch is kept');
    expect(w.github.incomplete).toEqual([]);
    expect(w.ports.assigned).toEqual([DANA.id]);
    const stopped = latest(await log(), 'stopped');
    expect(stopped?.actor?.id).toBe(DANA.id);
    expect(stopped?.payload).toEqual({ reason: `${DANA.id} took over` });
    // The grace timer was cancelled with the answer: nothing fires later.
    await advance(30 * MINUTE);
    expect(w.ports.notices).toEqual([]);
  });

  it('no answer within midFlightGrace applies Let it finish (default PT10M)', async () => {
    const w = await setup();
    await running(w);
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));

    await advance(10 * MINUTE - 1);
    expect(w.ports.notices).toEqual([]);
    await advance(1);

    expect(w.ports.notices).toHaveLength(1);
    expect(w.ports.notices[0]).toContain('No answer in 10 minutes');
    expect(w.ports.assigned).toEqual([]);
    expect(w.runner.cancelled).toEqual([]);
    expect(await types()).not.toContain('stopped');
  });

  it('honors a configured grace', async () => {
    const w = await setup({ grace: 'PT2M' });
    await running(w);
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));
    expect(w.ports.cards[0]?.grace).toBe('PT2M');
    await advance(2 * MINUTE);
    expect(w.ports.notices).toHaveLength(1);
    expect(w.ports.notices[0]).toContain('No answer in 2 minutes');
  });

  it('a card without a branch yet names none, and the timer does nothing once the run has finished', async () => {
    const w = await setup();
    await startFixer(w.deps, { incidentId: INC, attempt: 1 });
    await wf.drain();
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));
    const card = w.ports.cards[0] as MidFlightCard;
    expect(card.branch).toBeUndefined();
    expect(midFlightText(card, '@dana')).toBe('@dana, the fixer started on this under a minute ago.');

    await append(ev('fixer-done', { prNumber: 87, branch: 'fix/WEB-1042', summary: 's', testsAdded: [] }, 'fixer'));
    await advance(10 * MINUTE);
    expect(w.ports.notices).toEqual([]);
  });

  it('offers nothing before the fixer starts: that claim is A 2.1', async () => {
    const w = await setup();
    expect(await handleMidFlightClaim(w.deps, INC, await claim(DANA))).toEqual({ offered: false, reason: 'no-run' });
    expect(w.ports.cards).toEqual([]);
  });

  it('offers nothing for a reporter, and refuses answers it should', async () => {
    const w = await setup();
    const runId = await running(w);
    expect(await handleMidFlightClaim(w.deps, INC, await claim(PAT))).toEqual({ offered: false, reason: 'not-an-engineer-claim' });
    expect(w.ports.cards).toEqual([]);

    const answer = (actor: Claimer, id = runId): ReturnType<typeof answerMidFlight> =>
      answerMidFlight(w.deps, { incidentId: INC, runId: id, claimerId: DANA.id, choice: 'stop-it', actor });
    expect(await answer(PAT)).toEqual({ accepted: false, reason: 'engineer-required' });
    expect(await answer(DANA, 'OTHERRUN')).toEqual({ accepted: false, reason: 'wrong-run' });
    expect(w.runner.cancelled).toEqual([]);

    await answer(DANA);
    expect(await answer(DANA)).toEqual({ accepted: false, reason: 'run-finished' });
    expect(w.ports.assigned).toEqual([DANA.id]);
  });

  it('the same engineer claiming twice in one run gets one card', async () => {
    const w = await setup();
    await running(w);
    await handleMidFlightClaim(w.deps, INC, await claim(DANA));
    expect(await handleMidFlightClaim(w.deps, INC, await claim(DANA))).toEqual({ offered: false, reason: 'already-offered' });
    expect(w.ports.cards).toHaveLength(1);
  });
});
