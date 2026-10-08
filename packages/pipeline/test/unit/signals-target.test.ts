// Message roles and target resolution (A 1.3, A 7, A 8 "target resolution" row): the matrix as
// data, both playbook switches, and the `bot_messages` projection that tells a reaction's target
// (recorded on the dialect `SNAPWING_DB` selects; CI runs both).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewEvent } from '../../src/contracts/events.ts';
import type { ActorRole } from '../../src/contracts/incident.ts';
import type { Intent, TargetRole } from '../../src/contracts/signals.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { lastSeqPastBotRecords, recordBotMessage, roleOfCard } from '../../src/signals/messages.ts';
import { reactorClass, resolveSignal, resolveTarget, SIGNAL_MATRIX, type SignalEffect } from '../../src/signals/target.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const INTENTS: readonly Intent[] = ['trigger', 'escalate', 'claim', 'release', 'stop', 'accept', 'reject', 'watch', 'not-a-bug', 'none'];
const TARGETS: readonly TargetRole[] = ['anchor', 'scope-preview', 'dedupe', 'fix-preview', 'pr', 'staging-check', 'status', 'other'];
const REACTORS: readonly ActorRole[] = ['engineer', 'reporter', 'unknown'];

type Row = Partial<Record<'accept' | 'reject' | 'claim', SignalEffect>>;

/**
 * The A 1.3 matrix with both switches off, per target and reactor class. An absent cell is nothing.
 * `unknown` reactors resolve as reporters (asserted below).
 */
const EXPECTED: Record<TargetRole, { engineer: Row; reporter: Row }> = {
  anchor: {
    engineer: { accept: 'confirm', reject: 'dispute', claim: 'hold' },
    reporter: { accept: 'agree', reject: 'dispute', claim: 'comment' },
  },
  'scope-preview': {
    engineer: { accept: 'looks-right', reject: 'rescope' },
    reporter: { accept: 'looks-right', reject: 'rescope' },
  },
  dedupe: {
    engineer: { accept: 'link', reject: 'create-new' },
    reporter: { accept: 'link', reject: 'create-new' },
  },
  'fix-preview': {
    engineer: { accept: 'comment', reject: 'not-a-bug', claim: 'hold' },
    reporter: { accept: 'comment', reject: 'comment', claim: 'comment' },
  },
  pr: {
    // Unlinked engineer: no GitHub identity to review as, so the accept is a comment.
    engineer: { accept: 'comment', reject: 'changes-requested' },
    reporter: { accept: 'comment', reject: 'comment' },
  },
  'staging-check': {
    engineer: { accept: 'verify', reject: 'reopen' },
    reporter: { accept: 'verify', reject: 'reopen' },
  },
  status: {
    engineer: { accept: 'ack', reject: 'reject-stage' },
    reporter: { accept: 'ack', reject: 'reject-stage' },
  },
  other: { engineer: {}, reporter: {} },
};

describe('resolveSignal: the A 1.3 matrix', () => {
  const cells = TARGETS.flatMap((target) =>
    REACTORS.flatMap((reactor) => (['accept', 'reject', 'claim'] as const).map((intent) => ({ target, reactor, intent }))),
  );

  it.each(cells)('$intent on $target from $reactor', ({ target, reactor, intent }) => {
    const row = EXPECTED[target][reactor === 'engineer' ? 'engineer' : 'reporter'];
    expect(resolveSignal(intent, target, reactor)).toBe(row[intent]);
  });

  it('every other intent means the same on any message, so it resolves to nothing', () => {
    for (const intent of INTENTS.filter((i) => i !== 'accept' && i !== 'reject' && i !== 'claim')) {
      for (const target of TARGETS) {
        for (const reactor of REACTORS) {
          expect(resolveSignal(intent, target, reactor, { playbook: { reactionsAsButtons: true, reactionsAsApproval: true }, githubLinked: true })).toBeUndefined();
        }
      }
    }
  });

  it('a message Snapwing knows nothing about resolves to nothing', () => {
    for (const intent of INTENTS) {
      expect(resolveSignal(intent, undefined, 'engineer', { playbook: { reactionsAsButtons: true, reactionsAsApproval: true }, githubLinked: true })).toBeUndefined();
    }
  });

  it('a person the map does not know, or a Jira user, is a reporter', () => {
    expect(reactorClass('unknown')).toBe('reporter');
    expect(reactorClass('human')).toBe('reporter');
    expect(reactorClass('reporter')).toBe('reporter');
    expect(reactorClass('engineer')).toBe('engineer');
    expect(resolveSignal('claim', 'anchor', 'human')).toBe('comment');
  });

  it('A 8: a reporter accept on a PR card is a comment, never a review, whatever the switches and the link', () => {
    for (const reactor of ['reporter', 'unknown'] as const) {
      expect(resolveSignal('accept', 'pr', reactor, { playbook: { reactionsAsApproval: true, reactionsAsButtons: true }, githubLinked: true })).toBe('comment');
    }
  });

  it('an engineer with a linked GitHub identity leaves a review note on a PR card', () => {
    expect(resolveSignal('accept', 'pr', 'engineer', { githubLinked: true })).toBe('review-note');
  });

  it('no reaction merges anything: no rule, under any switch, has a merge effect', () => {
    const effects = new Set(SIGNAL_MATRIX.map((r) => r.effect));
    expect([...effects].some((e) => e.includes('merge'))).toBe(false);
    for (const target of TARGETS) {
      for (const reactor of REACTORS) {
        for (const intent of INTENTS) {
          const effect = resolveSignal(intent, target, reactor, { playbook: { reactionsAsButtons: true, reactionsAsApproval: true }, githubLinked: true });
          expect(effect === undefined || !effect.includes('merge')).toBe(true);
        }
      }
    }
  });

  it('is data: frozen rules, and every rule is reachable', () => {
    expect(Object.isFrozen(SIGNAL_MATRIX)).toBe(true);
    expect(SIGNAL_MATRIX.every((r) => Object.isFrozen(r))).toBe(true);
    const all = { playbook: { reactionsAsButtons: true, reactionsAsApproval: true }, githubLinked: true };
    const reached = new Set<SignalEffect>();
    for (const target of TARGETS) {
      for (const reactor of REACTORS) {
        for (const intent of ['accept', 'reject', 'claim'] as const) {
          for (const opts of [{}, all, { githubLinked: true }]) {
            const e = resolveSignal(intent, target, reactor, opts);
            if (e !== undefined) reached.add(e);
          }
        }
      }
    }
    expect([...reached].sort()).toEqual([...new Set(SIGNAL_MATRIX.map((r) => r.effect))].sort());
  });
});

describe('resolveSignal: playbook switches', () => {
  it('reactionsAsButtons: an engineer accept on a Fix Preview Card is Fix it; off (the default) it is a comment', () => {
    expect(resolveSignal('accept', 'fix-preview', 'engineer')).toBe('comment');
    expect(resolveSignal('accept', 'fix-preview', 'engineer', { playbook: { reactionsAsButtons: false } })).toBe('comment');
    expect(resolveSignal('accept', 'fix-preview', 'engineer', { playbook: { reactionsAsButtons: true } })).toBe('fix-tap');
  });

  it('reactionsAsButtons never gives a reporter the button', () => {
    expect(resolveSignal('accept', 'fix-preview', 'reporter', { playbook: { reactionsAsButtons: true } })).toBe('comment');
    expect(resolveSignal('accept', 'fix-preview', 'unknown', { playbook: { reactionsAsButtons: true } })).toBe('comment');
  });

  it('reactionsAsButtons gates only the Fix Preview accept', () => {
    const on = { playbook: { reactionsAsButtons: true } };
    for (const target of TARGETS) {
      for (const reactor of REACTORS) {
        for (const intent of ['accept', 'reject', 'claim'] as const) {
          if (target === 'fix-preview' && intent === 'accept' && reactor === 'engineer') continue;
          expect(resolveSignal(intent, target, reactor, on)).toBe(resolveSignal(intent, target, reactor));
        }
      }
    }
  });

  it('reactionsAsApproval: a linked engineer accept on a PR card is a GitHub approval; off (the default) a review note', () => {
    expect(resolveSignal('accept', 'pr', 'engineer', { githubLinked: true })).toBe('review-note');
    expect(resolveSignal('accept', 'pr', 'engineer', { githubLinked: true, playbook: { reactionsAsApproval: false } })).toBe('review-note');
    expect(resolveSignal('accept', 'pr', 'engineer', { githubLinked: true, playbook: { reactionsAsApproval: true } })).toBe('approve');
  });

  it('reactionsAsApproval needs a linked GitHub identity', () => {
    expect(resolveSignal('accept', 'pr', 'engineer', { playbook: { reactionsAsApproval: true } })).toBe('comment');
  });

  it('reactionsAsApproval gates only the PR card accept', () => {
    const on = { playbook: { reactionsAsApproval: true }, githubLinked: true };
    for (const target of TARGETS) {
      for (const reactor of REACTORS) {
        for (const intent of ['accept', 'reject', 'claim'] as const) {
          if (target === 'pr' && intent === 'accept' && reactor === 'engineer') continue;
          expect(resolveSignal(intent, target, reactor, on)).toBe(resolveSignal(intent, target, reactor, { githubLinked: true }));
        }
      }
    }
  });
});

describe('roleOfCard', () => {
  it('maps each card Snapwing posts to its target role', () => {
    expect(roleOfCard('scope-preview')).toBe('scope-preview');
    expect(roleOfCard('dedupe')).toBe('dedupe');
    expect(roleOfCard('fix-preview')).toBe('fix-preview');
    expect(roleOfCard('pr-ready')).toBe('pr');
    expect(roleOfCard('clarify')).toBe('other');
  });
});

// The projection --------------------------------------------------------------------------------

const WS = '01JZ0000000000000000000001';
const INC = '01JZ00000000000000000000T1';
const CHILD = '01JZ00000000000000000000T2';
const OTHER = '01JZ00000000000000000000T3';
const CHANNEL = 'C0FAKEBUGS';
const ANCHOR_TS = '1730000000.000100';
const NOW = () => new Date('2026-10-02T10:00:00.000Z');

function captured(incidentId: string, opts: { parentId?: string; channel?: string; anchor?: string; source?: 'slack' | 'teams' } = {}): NewEvent<'captured'> {
  return {
    workspaceId: WS,
    incidentId,
    type: 'captured',
    v: 1,
    source: opts.source ?? 'slack',
    occurredAt: '2026-10-02T09:00:00.000Z',
    payload: {
      kind: opts.parentId === undefined ? 'incident' : 'work-item',
      ...(opts.parentId === undefined ? {} : { parentId: opts.parentId }),
      idempotencyKey: `test:${incidentId}`,
      source: opts.source ?? 'slack',
      reporter: { id: 'U0FAKEREPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'checkout total is blank',
      anchorId: opts.anchor ?? ANCHOR_TS,
      channelId: opts.channel ?? CHANNEL,
    },
  };
}

describe(`bot_messages and resolveTarget (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let state: OpenedState;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    state = await tdb.open();
    await state.append(INC, [captured(INC)], 0);
    // A child work item shares its parent's anchor: the anchor resolves to the top-level incident.
    await state.append(CHILD, [captured(CHILD, { parentId: INC })], 0);
    await state.append(OTHER, [captured(OTHER, { channel: 'C0FAKEOTHER', anchor: '1730000000.000900' })], 0);
  });

  afterAll(async () => {
    await tdb.drop();
  });

  it('records each posted message with its role, and a lookup finds its role and incident', async () => {
    expect(await recordBotMessage(state, INC, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000200', role: 'fix-preview' }, NOW)).toBe(true);
    expect(await recordBotMessage(state, INC, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000300', role: 'pr' }, NOW)).toBe(true);
    expect(await recordBotMessage(state, OTHER, { platform: 'slack', channel: 'C0FAKEOTHER', messageId: '1730000000.000200', role: 'status' }, NOW)).toBe(true);

    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000200' })).toEqual({ incidentId: INC, workspaceId: WS, role: 'fix-preview' });
    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000300' })).toEqual({ incidentId: INC, workspaceId: WS, role: 'pr' });
    // The same ts in another channel is another message.
    expect(await resolveTarget(state, { platform: 'slack', channel: 'C0FAKEOTHER', messageId: '1730000000.000200' })).toEqual({ incidentId: OTHER, workspaceId: WS, role: 'status' });

    const log = await state.read(INC);
    const posted = log.filter((e) => e.type === 'bot-message-posted');
    expect(posted.map((e) => e.payload)).toEqual([
      { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000200', role: 'fix-preview' },
      { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000300', role: 'pr' },
    ]);
    expect(posted.every((e) => e.source === 'slack' && e.actor === undefined && e.occurredAt === NOW().toISOString())).toBe(true);
    // A record never moves the status.
    expect((await state.getIncident(INC))?.status).toBe('captured');
  });

  it('the anchor message resolves to the incident as `anchor`, preferring the top-level incident', async () => {
    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: ANCHOR_TS })).toEqual({ incidentId: INC, workspaceId: WS, role: 'anchor' });
  });

  it('unknown messages resolve to null: another id, another channel, another platform', async () => {
    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.999999' })).toBeNull();
    expect(await resolveTarget(state, { platform: 'slack', channel: 'C0FAKENOWHERE', messageId: ANCHOR_TS })).toBeNull();
    expect(await resolveTarget(state, { platform: 'teams', channel: CHANNEL, messageId: ANCHOR_TS })).toBeNull();
    expect(await resolveTarget(state, { platform: 'teams', channel: CHANNEL, messageId: '1730000000.000200' })).toBeNull();
    // And a target of null resolves every intent to nothing.
    expect(resolveSignal('accept', undefined, 'engineer')).toBeUndefined();
  });

  it('a message recorded again keeps one row, with the latest role', async () => {
    const ref = { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000400' } as const;
    await recordBotMessage(state, INC, { ...ref, role: 'other' }, NOW);
    await recordBotMessage(state, INC, { ...ref, role: 'staging-check' }, NOW);
    expect(await resolveTarget(state, ref)).toMatchObject({ role: 'staging-check' });
  });

  it('records nothing for an incident with no log', async () => {
    expect(await recordBotMessage(state, '01JZ00000000000000000000ZZ', { platform: 'slack', channel: CHANNEL, messageId: '1.2', role: 'status' }, NOW)).toBe(false);
    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: '1.2' })).toBeNull();
  });

  it('retries a conflicting append from a fresh read', async () => {
    let conflicts = 1;
    const racing = {
      read: state.read.bind(state),
      append: async (...args: Parameters<OpenedState['append']>) => {
        if (conflicts-- > 0) {
          // Someone else appends first.
          const log = await state.read(INC);
          await state.append(INC, [{ ...captured(INC), type: 'waiting-changed', payload: {} } as unknown as NewEvent], log.at(-1)?.seq ?? 0);
        }
        return state.append(...args);
      },
    };
    expect(await recordBotMessage(racing, INC, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000500', role: 'status' }, NOW)).toBe(true);
    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000500' })).toMatchObject({ role: 'status' });
  });

  it('lastSeqPastBotRecords: past bot records only, never past a decision', async () => {
    const seq = (await state.read(INC)).at(-1)?.seq ?? 0;
    expect(await lastSeqPastBotRecords(state, INC, seq)).toBeUndefined();
    await recordBotMessage(state, INC, { platform: 'slack', channel: CHANNEL, messageId: '1730000000.000600', role: 'status' }, NOW);
    expect(await lastSeqPastBotRecords(state, INC, seq)).toBe(seq + 1);
    await state.append(INC, [{ ...captured(INC), type: 'waiting-changed', payload: {} } as unknown as NewEvent], seq + 1);
    expect(await lastSeqPastBotRecords(state, INC, seq)).toBeUndefined();
  });
});
