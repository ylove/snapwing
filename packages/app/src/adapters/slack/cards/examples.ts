// The rendered examples checked in under docs/cards/slack/ (main 20.1). A unit test regenerates them
// from these inputs and fails on drift; run it with UPDATE_CARDS=1 to rewrite the files.

import type { InteractiveCard, PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { TriageResolutionPlan } from '@snapwing/pipeline/contracts/incident.ts';
import type { SlackMessage } from './blocks.ts';
import { buildCard } from './cards.ts';
import { buildStatusMessage, makeStatusUpdate } from './status.ts';

export const EXAMPLE_INCIDENT_ID = '01J9Z3K8M2Q7R5T6V4W1X0Y9ZA';

function plan(autonomyLevel: 0 | 1 | 2 | 3): TriageResolutionPlan {
  return {
    action: 'create_issue',
    projectKey: 'WEB',
    issueType: 'Bug',
    summary: 'Null `price` on cart line item when a promo code is applied after quantity change.',
    descriptionAdf: { type: 'doc', version: 1, content: [] },
    priority: 'High',
    labels: ['snapwing'],
    diagnosis: {
      confidence: 'high',
      files: [
        { path: 'src/cart/lineItem.ts', note: 'price is cleared on quantity change' },
        { path: 'src/promo/apply.ts', note: 'promo applied before the price is recomputed' },
      ],
    },
    autonomyLevel,
  };
}

const prReady: PrReadyCard = {
  kind: 'pr-ready',
  prNumber: 418,
  prUrl: 'https://github.com/example/web/pull/418',
  issueKey: 'WEB-1042',
  reviewVerdict: 'approve',
  ciState: 'green',
  filesChanged: 2,
  additions: 41,
  deletions: 6,
  reviewerUserIds: ['U0WEBDEV1'],
};

const scopePreview: InteractiveCard = {
  kind: 'scope-preview',
  summary: "Reading 11 messages from 2:10 to 2:31, including Dana's screenshot and the thread under Marcus's reply.",
};

const fixPreview = (level: 0 | 1 | 2 | 3): InteractiveCard => ({
  kind: 'fix-preview',
  plan: plan(level),
  surface: 'Website › Checkout',
  ownerUserId: 'U0WEBDEV1',
});

/** File name (without `.json`) to the message it renders. */
export function renderExamples(): Record<string, SlackMessage> {
  const id = EXAMPLE_INCIDENT_ID;
  return {
    'scope-preview': buildCard(id, scopePreview),
    dedupe: buildCard(id, {
      kind: 'dedupe',
      issueKey: 'WEB-812',
      summary: 'Nav dropdown not rendering on Safari.',
      assignee: 'Dana',
      openSince: 'Tuesday',
    }),
    clarify: buildCard(id, {
      kind: 'clarify',
      question: {
        audience: 'reporter',
        text: 'Which page were you on when the price went missing?',
        options: ['Cart', 'Checkout', 'Product page'],
        asks: 'surface',
        gatePassed: true,
        gateFailures: [],
      },
    }),
    'fix-preview-level-1': buildCard(id, fixPreview(1)),
    'fix-preview-level-1-reporter': buildCard(id, fixPreview(1), { viewer: 'reporter' }),
    'fix-preview-level-2': buildCard(id, fixPreview(2)),
    'fix-preview-level-3': buildCard(id, fixPreview(3)),
    claimed: buildCard(id, { kind: 'claimed', issueKey: 'WEB-1042', claimerUserId: 'U0WEBDEV1' }),
    'pr-ready': buildCard(id, prReady, { canMerge: true }),
    'pr-ready-no-identity': buildCard(id, prReady),
    'status-filed': buildStatusMessage(id, makeStatusUpdate('filed', { issueKey: 'WEB-1042', ownerUserId: 'U0WEBDEV1' })),
    'status-fixing': buildStatusMessage(id, makeStatusUpdate('fixing', { issueKey: 'WEB-1042' })),
    'status-merged-autopilot': buildStatusMessage(id, makeStatusUpdate('merged', { issueKey: 'WEB-1042', automatic: true })),
    'status-staging': buildStatusMessage(
      id,
      makeStatusUpdate('staging', { issueKey: 'WEB-1042', reporterUserId: 'U0PAT' }),
    ),
  };
}
