// The rendered examples checked in under docs/cards/teams/ (main 20.1). A unit test regenerates them
// from these inputs and fails on drift; run it with UPDATE_CARDS=1 to rewrite the files.

import type { InteractiveCard, PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { TriageResolutionPlan } from '@snapwing/pipeline/contracts/incident.ts';
import type { MidFlightCard } from '@snapwing/pipeline/fixer/claims.ts';
import { SCOPE_CHOICES } from '@snapwing/pipeline/signals/text.ts';
import { buildCard } from './cards.ts';
import { mentionsFromMap, refreshed, type AdaptiveCard } from './elements.ts';
import { buildStatusCard, makeStatusUpdate } from './status.ts';

export const EXAMPLE_INCIDENT_ID = '01J9Z3K8M2Q7R5T6V4W1X0Y9ZA';

/** The example people: the owner (known to the map) and a reporter the map does not know. */
export const EXAMPLE_MENTIONS = mentionsFromMap([
  { handle: 'Dana', teamsId: '29:1aB2cD3eF4gH5iJ6kL7mN8oP', slackId: 'U0WEBDEV1' },
  { handle: 'Pat', teamsId: '29:9zY8xW7vU6tS5rQ4pO3nM2lK', slackId: 'U0PAT' },
]);

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

/** The merge the autopilot status card's Revert undoes. */
const MERGED_PIN = { prNumber: 418, sha: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d' };

const prReady: PrReadyCard = {
  kind: 'pr-ready',
  prNumber: 418,
  headSha: '7d3f1c9a2b4e6f8091a3c5e7f9b1d3e5a7c9e1f3',
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

const midFlight: MidFlightCard = {
  kind: 'mid-flight',
  issueKey: 'WEB-1042',
  claimerUserId: 'U0WEBDEV1',
  runId: '01J9Z3N5P8S2T4V6W8X0Y2Z4AB',
  runAgeMs: 4 * 60_000,
  branch: 'fix/WEB-1042',
  choices: ['let-it-finish', 'stop-it'],
  grace: 'PT10M',
};

/** File name (without `.json`) to the card it renders. */
export function renderExamples(): Record<string, AdaptiveCard> {
  const id = EXAMPLE_INCIDENT_ID;
  const mentions = EXAMPLE_MENTIONS;
  const o = { mentions };
  const claimed = buildCard(id, { kind: 'claimed', issueKey: 'WEB-1042', claimerUserId: 'U0WEBDEV1' }, o);
  return {
    'scope-preview': buildCard(id, scopePreview, o),
    'scope-preview-reduced': buildCard(id, scopePreview, { ...o, reduced: true }),
    dedupe: buildCard(
      id,
      { kind: 'dedupe', issueKey: 'WEB-812', summary: 'Nav dropdown not rendering on Safari.', assignee: 'Dana', openSince: 'Tuesday' },
      o,
    ),
    clarify: buildCard(
      id,
      {
        kind: 'clarify',
        question: {
          audience: 'reporter',
          text: 'Which page were you on when the price went missing?',
          options: ['Cart', 'Checkout', 'Product page'],
          asks: 'surface',
          gatePassed: true,
          gateFailures: [],
        },
      },
      o,
    ),
    'fix-preview-level-1': buildCard(id, fixPreview(1), o),
    'fix-preview-level-1-reporter': buildCard(id, fixPreview(1), { ...o, viewer: 'reporter' }),
    'fix-preview-level-2': buildCard(id, fixPreview(2), o),
    'fix-preview-level-3': buildCard(id, fixPreview(3), o),
    'fix-preview-unmapped-owner': buildCard(id, fixPreview(1)),
    claimed,
    'claimed-refreshed': refreshed(claimed, 'Marcus chose: Not a bug.', o),
    'pr-ready': buildCard(id, prReady, { ...o, canMerge: true }),
    'pr-ready-no-identity': buildCard(id, prReady, o),
    'mid-flight': buildCard(id, midFlight, o),
    'resolution-prompt': buildCard(
      id,
      {
        kind: 'resolution',
        userId: 'U0PAT',
        issueKey: 'WEB-1042',
        resolution: 'Cannot Reproduce',
        messageId: '1727980000.000200',
        text: 'Close WEB-1042 as Cannot Reproduce?',
        choices: ['close', 'keep-open'],
      },
      o,
    ),
    'scope-change': buildCard(
      id,
      {
        kind: 'scope-change',
        text: 'Sounds like a second issue on the app. File it separately?',
        messageId: '1727980000.000300',
        choices: SCOPE_CHOICES,
      },
      o,
    ),
    'status-filed': buildStatusCard(id, makeStatusUpdate('filed', { issueKey: 'WEB-1042', ownerUserId: 'U0WEBDEV1' }), o),
    'status-fixing': buildStatusCard(id, makeStatusUpdate('fixing', { issueKey: 'WEB-1042' }), o),
    'status-merged-autopilot': buildStatusCard(id, makeStatusUpdate('merged', { issueKey: 'WEB-1042', automatic: true, pin: MERGED_PIN }), o),
    'status-staging': buildStatusCard(id, makeStatusUpdate('staging', { issueKey: 'WEB-1042', reporterUserId: 'U0PAT' }), o),
    'status-staging-reduced': buildStatusCard(
      id,
      makeStatusUpdate('staging', { issueKey: 'WEB-1042', reporterUserId: 'U0PAT' }),
      { ...o, reduced: true },
    ),
  };
}
