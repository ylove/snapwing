import { describe, expectTypeOf, it } from 'vitest';
import type { InteractiveCard, StatusUpdate } from '../../src/contracts/adapters.ts';
import type {
  ApprovalAction,
  IncidentActor,
  MergeGateResult,
  TriageResolutionPlan,
} from '../../src/contracts/incident.ts';
import type { SignalEvent, StatusAnswer } from '../../src/contracts/signals.ts';

describe('contract types', () => {
  it('TriageResolutionPlan', () => {
    expectTypeOf<TriageResolutionPlan['action']>().toEqualTypeOf<'create_issue' | 'link_existing' | 'noop'>();
    expectTypeOf<TriageResolutionPlan['autonomyLevel']>().toEqualTypeOf<0 | 1 | 2 | 3>();
    expectTypeOf<TriageResolutionPlan['descriptionAdf']>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<TriageResolutionPlan['linkTo']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TriageResolutionPlan['labels']>().toEqualTypeOf<string[]>();
  });

  it('MergeGateResult', () => {
    expectTypeOf<MergeGateResult['decision']>().toEqualTypeOf<'merge' | 'degrade' | 'hold'>();
    expectTypeOf<MergeGateResult['reviewVerdict']>().toEqualTypeOf<'approve' | 'request-changes' | 'escalate'>();
    expectTypeOf<MergeGateResult['riskGate']['forbiddenHits']>().toEqualTypeOf<string[]>();
    expectTypeOf<MergeGateResult['ciGreen']>().toEqualTypeOf<boolean>();
  });

  it('SignalEvent', () => {
    expectTypeOf<SignalEvent['actor']>().toEqualTypeOf<IncidentActor>();
    expectTypeOf<SignalEvent['source']>().toEqualTypeOf<'reaction' | 'reaction-removed' | 'message'>();
    expectTypeOf<SignalEvent['platform']>().toEqualTypeOf<'slack' | 'teams'>();
    expectTypeOf<SignalEvent['target']['messageId']>().toEqualTypeOf<string>();
    expectTypeOf<SignalEvent['incidentId']>().toEqualTypeOf<string | undefined>();
  });

  it('StatusAnswer and adapter types', () => {
    expectTypeOf<StatusAnswer['actions']>().toEqualTypeOf<ApprovalAction[]>();
    expectTypeOf<Extract<InteractiveCard, { kind: 'fix-preview' }>['plan']>().toEqualTypeOf<TriageResolutionPlan>();
    expectTypeOf<StatusUpdate['stage']>().toEqualTypeOf<
      'filed' | 'pr-open' | 'review-passed' | 'merged' | 'staging' | 'production' | 'clarified'
    >();
  });
});
