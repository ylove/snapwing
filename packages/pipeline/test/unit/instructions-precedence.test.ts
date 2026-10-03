// Workspace instructions applied at the autopilot merge and the fixer start (#307; Companion A 6.3,
// A 6.4; main 11.3). A scripted model answers the instructions check per step; the fixer job, the
// merge job, and a human Merge tap run for real on the in-process workflow over the dialect
// `SNAPWING_DB` selects, with fake GitHub, runner, and identity links. The status message is read off
// the log with `statusFor`, as the status outbox does.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import { DEFAULT_MERGE_CONFIG } from '../../src/config/app-config.ts';
import { loadInstructions, type WorkspaceInstructions } from '../../src/config/instructions.ts';
import { latest, runFixerJob, type FixerDeps, type FixerGitHub } from '../../src/fixer/job.ts';
import { humanMerge, type PrActionsDeps } from '../../src/merge/actions.ts';
import { humanReviewTrigger, type ChatUserRef, type HumanMap, type HumanPullRequest, type IdentityLinks } from '../../src/merge/human.ts';
import {
  buildInstructionsHoldRequest,
  fixerHoldReason,
  holdSentence,
  INSTRUCTIONS_CHECK_FAILED,
  isInstructionsHoldSentence,
  parseFixerHoldReason,
  type InstructionsHoldAnswer,
  type InstructionsStep,
} from '../../src/merge/instructions.ts';
import { evaluateMerge, type MergeDeps, type MergeResult } from '../../src/merge/job.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import type { ClassifyRequest, ClassifyResult, CompletionResult, ModelPort, VisionResult } from '../../src/ports/model.ts';
import type { FixerJob, RunnerPort } from '../../src/ports/runner.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { statusFor } from '../../src/status/loopback.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const T0 = Date.parse('2026-10-02T15:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6INSTRINC00000000000000';
const REPO = 'fake-org/web';
const PR = 418;
const HEAD = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const DANA = 'U-FAKE-DANA'; // engineer, owns web/checkout, linked as dana-gh
const JIRA_HUMAN = { id: 'jira-account-fake-1', role: 'human' } as const;

const INSTRUCTIONS_MD = [
  '# Workspace instructions',
  '',
  '- The payments service (src/payments) is owned by an outside vendor. Never start the fixer on it;',
  '  file the ticket and mention @vendor-liaison.',
  '- During a release window (announced in #releases), hold all autopilot merges until the window closes.',
  '- If the CEO reports something, treat it as High minimum, and be brief.',
].join('\n');

const RELEASE_WINDOW = 'During a release window (announced in #releases), hold all autopilot merges until the window closes.';
const VENDOR = 'The payments service (src/payments) is owned by an outside vendor. Never start the fixer on it; file the ticket and mention @vendor-liaison.';

const NO_HOLD: InstructionsHoldAnswer = { hold: false, instruction: '', reason: '', mention: '' };

const MAP: HumanMap & Pick<WorkspaceMap, 'policies'> = {
  channels: [{ id: 'C-FAKE-WEB-BUGS', name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
  people: [{ slackId: DANA, handle: 'dana', email: 'dana@example.test', role: 'engineer', owns: [{ surface: 'web', component: 'checkout', primary: true }] }],
  policies: { autonomy: { default: 3, levels: [], overrides: [] } },
};

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

/** Answers the instructions check per step; anything else is a test bug. */
class ScriptedModel implements ModelPort {
  readonly calls: ClassifyRequest<unknown>[] = [];
  answers: Partial<Record<InstructionsStep, InstructionsHoldAnswer | Error>> = {};

  complete(): Promise<CompletionResult> {
    return Promise.reject(new Error('complete is not scripted'));
  }

  vision(): Promise<VisionResult> {
    return Promise.reject(new Error('vision is not scripted'));
  }

  classify<T>(request: ClassifyRequest<T>): Promise<ClassifyResult<T>> {
    this.calls.push(request as ClassifyRequest<unknown>);
    const step = /<instructions-check step="([a-z-]+)"/.exec(request.prompt)?.[1] as InstructionsStep | undefined;
    const answer = step === undefined ? undefined : this.answers[step];
    if (answer === undefined) return Promise.reject(new Error(`no scripted answer for step ${String(step)}`));
    if (answer instanceof Error) return Promise.reject(answer);
    if (!request.validate(answer)) return Promise.reject(new Error('scripted answer does not validate'));
    return Promise.resolve({ value: answer, model: 'mock/scripted', attempts: 1 });
  }

  steps(): string[] {
    return this.calls.map((c) => /step="([a-z-]+)"/.exec(c.prompt)?.[1] ?? '?');
  }
}

class FakeRunner implements RunnerPort {
  readonly started: FixerJob[] = [];
  runFixer(job: FixerJob): Promise<{ runId: string }> {
    this.started.push(job);
    return Promise.resolve({ runId: job.runId });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

const noGitHub: FixerGitHub = {
  markIncomplete: () => Promise.reject(new Error('unexpected markIncomplete')),
  closePr: () => Promise.reject(new Error('unexpected closePr')),
};

/** One fake for the merge job (as the App) and the human path (as the linked user). */
class FakeGitHub {
  pr: HumanPullRequest & { headRef: string } = {
    number: PR,
    state: 'open',
    merged: false,
    htmlUrl: `https://github.com/${REPO}/pull/${String(PR)}`,
    headSha: HEAD,
    headRef: 'fix/WEB-1042',
    baseRef: 'main',
    authorLogin: 'snapwing-test[bot]',
    additions: 41,
    deletions: 6,
    changedFiles: 2,
    requestedReviewers: [],
  };
  files = [
    { filename: 'src/checkout/cart.ts', additions: 30, deletions: 6 },
    { filename: 'test/checkout/cart.test.ts', additions: 11, deletions: 0 },
  ];
  readonly merges: { number: number; expectedHeadSha: string; userToken?: string }[] = [];

  getPullRequest(): Promise<HumanPullRequest & { headRef: string }> {
    return Promise.resolve({ ...this.pr, requestedReviewers: [...this.pr.requestedReviewers] });
  }
  listPullRequestFiles(): Promise<readonly { filename: string; additions: number; deletions: number }[]> {
    return Promise.resolve(this.files.map((f) => ({ ...f })));
  }
  combinedStatus(): Promise<{ required: { name: string; state: 'success'; source: string }[] }> {
    return Promise.resolve({ required: [{ name: 'ci', state: 'success', source: 'check-run' }] });
  }
  requestReviewers(): Promise<void> {
    return Promise.resolve();
  }
  mergePullRequest(number: number, input: { expectedHeadSha: string; userToken?: string }): Promise<MergeResult> {
    this.merges.push({ number, ...input });
    return Promise.resolve({ merged: true, sha: MERGE_SHA, message: 'Pull Request successfully merged' });
  }
  deleteBranch(): Promise<void> {
    return Promise.resolve();
  }
  openRevertPullRequest(): Promise<{ number: number; url: string }> {
    return Promise.reject(new Error('unexpected revert'));
  }
}

class FakeIdentity implements IdentityLinks {
  linkUrl(user: ChatUserRef): Promise<string> {
    return Promise.resolve(`https://snapwing.example.test/auth/github/start?state=test-state-${user.userId}`);
  }
  getLinkedIdentity(user: ChatUserRef): Promise<{ githubLogin: string } | null> {
    return Promise.resolve(user.userId === DANA ? { githubLogin: 'dana-gh' } : null);
  }
  isLinked(user: ChatUserRef): Promise<boolean> {
    return Promise.resolve(user.userId === DANA);
  }
  userToken(user: ChatUserRef): Promise<{ token: string; githubLogin: string } | null> {
    return Promise.resolve(user.userId === DANA ? { token: 'test-user-token-dana-gh', githubLogin: 'dana-gh' } : null);
  }
}

// World -------------------------------------------------------------------------------------------

interface World {
  model: ScriptedModel;
  runner: FakeRunner;
  github: FakeGitHub;
  fixer: FixerDeps;
  merge: MergeDeps;
  actions: PrActionsDeps;
  instructions: { current: WorkspaceInstructions | undefined };
}

async function setup(opts: { level: 1 | 2 | 3; request?: string; instructions?: string | null }): Promise<World> {
  const model = new ScriptedModel();
  const runner = new FakeRunner();
  const github = new FakeGitHub();
  const loaded = loadInstructions(opts.instructions === undefined ? INSTRUCTIONS_MD : opts.instructions);
  if (!loaded.ok) throw new Error(loaded.reason);
  const instructions: World['instructions'] = { current: loaded.instructions };
  // A live getter, as compose passes it (#284 reloads INSTRUCTIONS.md).
  const instructionsGate = { instructions: () => instructions.current, model };
  const clock = (): Date => new Date(now);
  const fixer: FixerDeps = { workspaceId: WS, state, workflow: wf, runner, github: noGitHub, config: { harness: { adapter: 'claude-code' } }, clock, instructionsGate };
  const merge: MergeDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    github: () => github,
    merge: DEFAULT_MERGE_CONFIG,
    map: MAP,
    clock,
    instructionsGate,
  };
  const actions: PrActionsDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    chat: 'slack',
    github: () => github,
    codeowners: () => ({ codeownersFor: () => Promise.resolve({ owners: [] }) }),
    identity: new FakeIdentity(),
    map: MAP,
    clock,
    stopIncident: () => Promise.reject(new Error('unexpected stop')),
    revert: () => Promise.reject(new Error('unexpected revert')),
  };
  wf.work('timer.fixer-budget', () => Promise.resolve());
  wf.work('timer.revert', () => Promise.resolve());
  const put = await state.putArtifact({
    workspaceId: WS,
    incidentId: INC,
    kind: 'implementation-request',
    contentType: 'application/xml',
    body: opts.request ?? checkoutRequest(),
    createdBy: 'orchestrator',
  });
  await append(...toFiled(opts.level, { artifactId: put.id, version: put.version }));
  return { model, runner, github, fixer, merge, actions, instructions };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: { source?: 'agent' | 'fixer' | 'jira' | 'slack'; actor?: { id: string; role: 'engineer' | 'human' } } = {}): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: INC,
    type,
    v: 1,
    source: extra.source ?? 'agent',
    ...(extra.actor === undefined ? {} : { actor: extra.actor }),
    occurredAt: new Date(now).toISOString(),
    payload,
  } as unknown as NewEvent<T>;
}

function toFiled(level: 1 | 2 | 3, request: { artifactId: string; version: number }): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-PAT', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500 when I pay',
      channelId: 'C-FAKE',
      threadId: '1700000000.000100',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', ownerId: 'dana', repo: REPO, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: request,
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

function checkoutRequest(): string {
  return requestXml('checkout', 'src/checkout/cart.ts', 'cart total reads a stale price');
}

function requestXml(component: string, path: string, note: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<implementation-request xmlns="urn:snapwing:impl:v1" issue="WEB-1042" surface="web" component="${component}">`,
    '  <intent>Paying fails with a 500.</intent>',
    `  <diagnosis confidence="medium" by="scout"><file path="${path}">${note}</file></diagnosis>`,
    '  <handoff mode="review" branch="fix/WEB-1042" base="main" autonomy="2" />',
    '  <workspace-instructions>\n(the block the request carries)\n</workspace-instructions>',
    '</implementation-request>',
  ].join('\n');
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await log()).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function typesAfter(count: number): Promise<EventType[]> {
  return (await log()).slice(count).map((e) => e.type);
}

/** What the status message says after `event` (the status outbox's own call). */
async function statusAfter(event: IncidentEvent | undefined): Promise<ReturnType<typeof statusFor>> {
  if (event === undefined) throw new Error('no event');
  const incident = await state.getIncident(INC);
  if (incident === null) throw new Error('no incident');
  return statusFor(event, incident);
}

/** The fixer's run reports a PR, the review agent approves it (B 9, main 11.1). */
async function prReviewed(): Promise<void> {
  await append(
    ev('fixer-done', { prNumber: PR, branch: 'fix/WEB-1042', summary: 'Guard the stale price', testsAdded: ['test/checkout/cart.test.ts'] }, { source: 'fixer' }),
    ev('pr-opened', { prNumber: PR, branch: 'fix/WEB-1042' }, { source: 'fixer' }),
  );
  const body = JSON.stringify({ verdict: 'approve', reasons: [], constraintViolations: [] });
  const review = await state.putArtifact({ workspaceId: WS, incidentId: INC, kind: 'review', contentType: 'application/json', body, createdBy: 'review-agent' });
  await append(ev('review-passed', { prNumber: PR, review: { artifactId: review.id, version: review.version } }));
}

const tap = { incidentId: INC, actor: { id: DANA, role: 'engineer' as const }, prNumber: PR, repo: REPO };

// The A 6.4 case ----------------------------------------------------------------------------------

describe('A 6.4: checkout at level 3, a release window open', () => {
  it('starts the fixer, holds the autopilot merge for the instructions, and a human Merge tap still wins', async () => {
    const w = await setup({ level: 3 });
    w.model.answers = {
      'fixer-start': NO_HOLD,
      merge: { hold: true, instruction: RELEASE_WINDOW, reason: 'the release window', mention: '' },
    };

    // 1. The fixer starts at once: level 3 says so and nothing in the instructions disagrees.
    const started = await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    expect(started).toMatchObject({ started: true });
    expect(w.runner.started).toHaveLength(1);
    expect(w.model.steps()).toEqual(['fixer-start']);

    // The check carries the instructions block in the system prompt and the incident in the request.
    const ask = w.model.calls[0];
    expect(ask?.system).toContain('<workspace-instructions>');
    expect(ask?.system).toContain('hold all autopilot merges');
    expect(ask?.prompt).toContain('now="2026-10-02T15:00:00.000Z"');
    expect(ask?.prompt).toContain('key="WEB-1042"');
    expect(ask?.prompt).toContain('<report>Checkout says 500 when I pay</report>');
    expect(ask?.prompt).toContain('<file path="src/checkout/cart.ts">');
    // The request's own copy of the block is left out: the system prompt has it.
    expect(ask?.prompt).not.toContain('the block the request carries');

    // 2. Review agent and CI pass.
    await prReviewed();

    // 3. The merge step reads the instructions, sees the release window rule, and degrades to level 2.
    const before = (await log()).length;
    const out = await evaluateMerge(w.merge, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', prNumber: PR, reason: 'Holding for the release window per workspace instructions' });
    expect(w.github.merges).toEqual([]);
    expect(await typesAfter(before)).toEqual(['ci-green', 'held', 'level-changed']);
    const after = await log();
    const held = latest(after, 'held');
    expect(held?.payload).toMatchObject({ kind: 'gate', reason: 'Holding for the release window per workspace instructions' });
    expect(latest(after, 'level-changed')?.payload).toEqual({ from: 3, to: 2, reason: 'merge-held: Holding for the release window per workspace instructions' });
    expect((await state.getIncident(INC))?.status).toBe('held');
    const merge = w.model.calls[1];
    expect(merge?.prompt).toContain('<instructions-check step="merge"');
    expect(merge?.prompt).toContain('<file path="src/checkout/cart.ts" additions="30" deletions="6"/>');

    // The status message says why, and CODEOWNERS (here the surface owner) are requested.
    const status = await statusAfter(held);
    expect(status).toMatchObject({ stage: 'held', text: 'Holding for the release window per workspace instructions. <@dana> requested.' });
    expect(humanReviewTrigger(after)).toMatchObject({ ready: true, prNumber: PR, on: 'held' });

    // A later run of the merge job is a no-op and asks nothing: the hold is for this merge, decided once.
    expect(await evaluateMerge(w.merge, { incidentId: INC })).toEqual({ outcome: 'skipped', reason: 'already-held' });
    expect(w.model.calls).toHaveLength(2);

    // 4. A human taps Merge anyway. The tap wins; the log records who, after the hold that says why.
    const merged = await humanMerge(w.actions, tap);
    expect(merged).toMatchObject({ done: true, action: 'merge', prNumber: PR, githubLogin: 'dana-gh' });
    expect(w.github.merges).toEqual([{ number: PR, expectedHeadSha: HEAD, userToken: 'test-user-token-dana-gh' }]);
    const final = await log();
    const m = latest(final, 'merged');
    expect(m?.payload).toMatchObject({ prNumber: PR, levelAtMergeTime: 2 });
    expect(m?.actor?.id).toBe(DANA);
    expect(m?.source).toBe('slack');
    expect(held !== undefined && m !== undefined && m.seq > held.seq).toBe(true);
    expect((await state.getIncident(INC))?.status).toBe('merged');
    expect(w.model.calls).toHaveLength(2);
  });

  it('merges on autopilot when no instruction holds the merge', async () => {
    const w = await setup({ level: 3 });
    w.model.answers = { 'fixer-start': NO_HOLD, merge: NO_HOLD };
    await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    await prReviewed();

    const out = await evaluateMerge(w.merge, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'merged', prNumber: PR, mergeCommitSha: MERGE_SHA });
    expect(w.github.merges).toEqual([{ number: PR, expectedHeadSha: HEAD }]);
    expect(w.model.steps()).toEqual(['fixer-start', 'merge']);
    const final = await log();
    expect(latest(final, 'merged')?.payload).toMatchObject({ levelAtMergeTime: 3 });
    expect(final.some((e) => e.type === 'held' || e.type === 'level-changed')).toBe(false);
  });

  it('holds the merge, carefully, when the instructions cannot be checked', async () => {
    const w = await setup({ level: 3 });
    w.model.answers = { 'fixer-start': NO_HOLD, merge: new Error('model unavailable') };
    await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    await prReviewed();

    const out = await evaluateMerge(w.merge, { incidentId: INC });
    expect(out).toMatchObject({ outcome: 'held', reason: INSTRUCTIONS_CHECK_FAILED });
    expect(w.github.merges).toEqual([]);
    const status = await statusAfter(latest(await log(), 'held'));
    expect(status?.text).toBe('Holding because the workspace instructions could not be checked. <@dana> requested.');
  });

  it('asks nothing when the workspace has no instructions, and the gates alone decide', async () => {
    const w = await setup({ level: 3, instructions: null });
    const started = await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    expect(started).toMatchObject({ started: true });
    await prReviewed();
    expect(await evaluateMerge(w.merge, { incidentId: INC })).toMatchObject({ outcome: 'merged' });
    expect(w.model.calls).toEqual([]);
  });

  it('reads the instructions live: a hold added after the fixer started applies at the merge', async () => {
    const w = await setup({ level: 3, instructions: null });
    await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    await prReviewed();
    const reloaded = loadInstructions(INSTRUCTIONS_MD);
    w.instructions.current = reloaded.instructions;
    w.model.answers = { merge: { hold: true, instruction: RELEASE_WINDOW, reason: 'the release window.', mention: '' } };
    expect(await evaluateMerge(w.merge, { incidentId: INC })).toMatchObject({ outcome: 'held', reason: 'Holding for the release window per workspace instructions' });
    expect(w.model.steps()).toEqual(['merge']);
  });
});

// The vendor-owned path case ----------------------------------------------------------------------

describe('A 6.3: the vendor-owned payments path', () => {
  const vendorHold: InstructionsHoldAnswer = { hold: true, instruction: VENDOR, reason: 'the vendor who owns payments', mention: '@vendor-liaison' };
  const HOLD_SENTENCE = 'Holding for the vendor who owns payments per workspace instructions';

  it('files the ticket only and mentions the named person instead of starting the fixer', async () => {
    const w = await setup({ level: 2, request: requestXml('payments', 'src/payments/charge.ts', 'charge() rounds before tax') });
    w.model.answers = { 'fixer-start': vendorHold };
    const before = (await log()).length;

    const out = await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    expect(out).toEqual({ started: false, reason: 'instructions-held' });
    expect(w.runner.started).toEqual([]);
    expect(await typesAfter(before)).toEqual(['level-changed']);
    const changed = latest(await log(), 'level-changed');
    expect(changed?.payload).toEqual({ from: 2, to: 0, reason: `instructions-held: ${HOLD_SENTENCE} (mention @vendor-liaison)` });
    expect(changed?.actor).toBeUndefined();
    const incident = await state.getIncident(INC);
    expect(incident).toMatchObject({ status: 'filed', autonomyLevel: 0 });

    // The model saw the vendor path the fixer would touch.
    expect(w.model.calls[0]?.prompt).toContain('<instructions-check step="fixer-start"');
    expect(w.model.calls[0]?.prompt).toContain('<file path="src/payments/charge.ts">');

    // The status message: ticket-only, why, and the named mention; no Stop, since nothing runs.
    const status = await statusAfter(changed);
    expect(status).toEqual({ issueKey: 'WEB-1042', stage: 'filed', text: `Filed as WEB-1042. ${HOLD_SENTENCE}. Over to <@vendor-liaison>.` });
  });

  it('refuses a later start nobody asked for, without asking the model again', async () => {
    const w = await setup({ level: 3, request: requestXml('payments', 'src/payments/charge.ts', 'charge() rounds before tax') });
    w.model.answers = { 'fixer-start': vendorHold };
    await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    const before = (await log()).length;

    // The agent's own In Progress echo, or a reconciled transition with no person behind it.
    await append(ev('jira-transitioned', { jiraKey: 'WEB-1042', from: 'To Do', to: 'In Progress', reconciled: true }, { source: 'jira' }));
    expect(await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 })).toEqual({ started: false, reason: 'instructions-held' });
    expect(w.runner.started).toEqual([]);
    expect(await typesAfter(before)).toEqual(['jira-transitioned']);
    expect(w.model.calls).toHaveLength(1);
  });

  it('lets a person start the fixer anyway: the start wins and is logged with who', async () => {
    const w = await setup({ level: 3, request: requestXml('payments', 'src/payments/charge.ts', 'charge() rounds before tax') });
    w.model.answers = { 'fixer-start': vendorHold };
    await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });

    // An engineer moves the ticket to In Progress in Jira (the webhook records it, then starts the fixer).
    await append(ev('jira-transitioned', { jiraKey: 'WEB-1042', from: 'To Do', to: 'In Progress' }, { source: 'jira', actor: JIRA_HUMAN }));
    const before = (await log()).length;
    const out = await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    expect(out).toMatchObject({ started: true });
    expect(w.runner.started).toHaveLength(1);
    expect(w.model.calls).toHaveLength(1);
    expect(await typesAfter(before)).toEqual(['fixer-started', 'level-changed']);

    const final = await log();
    const restored = latest(final, 'level-changed');
    // Back to at most 2: a person overrode the instructions, so a person merges what the fixer opens.
    expect(restored?.payload).toMatchObject({ from: 0, to: 2 });
    expect(restored?.payload.reason).toMatch(/^instructions-overridden: started by jira-account-fake-1 \(jira-transitioned\)/);
    expect(restored?.actor?.id).toBe(JIRA_HUMAN.id);
    expect(restored?.source).toBe('jira');
    expect(await state.getIncident(INC)).toMatchObject({ status: 'fixing', autonomyLevel: 2 });

    // The status message moves on to the fix, with Stop.
    const status = await statusAfter(latest(final, 'fixer-started'));
    expect(status).toMatchObject({ stage: 'fixing', actions: ['stop'] });
  });
});

// No hold, and the starts the instructions never hold ----------------------------------------------

describe('no hold', () => {
  it('starts the fixer when no instruction holds it, and records nothing extra', async () => {
    const w = await setup({ level: 2 });
    w.model.answers = { 'fixer-start': NO_HOLD };
    const before = (await log()).length;
    expect(await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 })).toMatchObject({ started: true });
    expect(await typesAfter(before)).toEqual(['fixer-started']);
    expect(w.model.steps()).toEqual(['fixer-start']);
  });

  it('never asks at level 1: the start follows a Fix it tap, and a human tap wins', async () => {
    const w = await setup({ level: 1 });
    w.model.answers = { 'fixer-start': { hold: true, instruction: VENDOR, reason: 'the vendor who owns payments', mention: 'vendor-liaison' } };
    await append(ev('tapped', { eventId: 'card-1', card: 'fix-preview', choice: 'approve_fix' }, { source: 'slack', actor: { id: DANA, role: 'engineer' } }));
    expect(await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 })).toMatchObject({ started: true });
    expect(w.model.calls).toEqual([]);
  });

  it('never asks on a retry run: the instructions are applied at the first start', async () => {
    const w = await setup({ level: 3 });
    w.model.answers = { 'fixer-start': NO_HOLD };
    await runFixerJob(w.fixer, { incidentId: INC, attempt: 1 });
    await prReviewed();
    await append(ev('review-failed', { prNumber: PR, verdict: 'request-changes', reason: 'scope' }));
    w.model.answers = {};
    expect(await runFixerJob(w.fixer, { incidentId: INC, attempt: 2 })).toMatchObject({ started: true });
    expect(w.model.steps()).toEqual(['fixer-start']);
  });
});

// The pieces --------------------------------------------------------------------------------------

describe('instructions check pieces', () => {
  it('writes the status sentence from the model noun phrase, whatever its edges', () => {
    expect(holdSentence('the release window')).toBe('Holding for the release window per workspace instructions');
    expect(holdSentence('  Holding for the release window per workspace instructions. ')).toBe('Holding for the release window per workspace instructions');
    expect(holdSentence('...')).toBe(INSTRUCTIONS_CHECK_FAILED);
    expect(isInstructionsHoldSentence('Holding for the release window per workspace instructions.')).toBe(true);
    expect(isInstructionsHoldSentence(INSTRUCTIONS_CHECK_FAILED)).toBe(true);
    expect(isInstructionsHoldSentence('risk gate: 31 files touched')).toBe(false);
  });

  it('round-trips the fixer hold reason with and without a mention', () => {
    const withMention = fixerHoldReason({ status: 'Holding for the vendor per workspace instructions', mention: 'vendor-liaison' });
    expect(parseFixerHoldReason(withMention)).toEqual({ status: 'Holding for the vendor per workspace instructions', mention: 'vendor-liaison' });
    expect(parseFixerHoldReason(fixerHoldReason({ status: 'Holding for the vendor per workspace instructions' }))).toEqual({ status: 'Holding for the vendor per workspace instructions' });
    expect(parseFixerHoldReason('fixer-failed: budget-exceeded')).toBeUndefined();
  });

  it('asks with a schema every default model accepts: all properties required, no optional ones', async () => {
    const loaded = loadInstructions(INSTRUCTIONS_MD);
    if (!loaded.ok || loaded.instructions === undefined) throw new Error('no instructions');
    const request = await buildInstructionsHoldRequest(loaded.instructions, { step: 'merge', now: new Date(T0), incident: { issueKey: 'WEB-1042' } });
    expect(request).toMatchObject({ task: 'triage', schemaName: 'instructions-hold' });
    expect(request.schema.required).toEqual(['hold', 'instruction', 'reason', 'mention']);
    expect(request.schema.additionalProperties).toBe(false);
    expect(request.system.endsWith(loaded.instructions.block)).toBe(true);
    expect(request.validate({ hold: true, instruction: 'x', reason: ' ', mention: '' })).toBe(false);
    expect(request.validate({ hold: false, instruction: '', reason: '', mention: '' })).toBe(true);
  });
});
