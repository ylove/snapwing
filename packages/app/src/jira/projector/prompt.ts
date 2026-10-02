// The placeholder issue key (main 9.1, #113). Synthesis cannot know the Jira key when it writes the
// implementation request, so `@issue` holds `<PROJECT>-0` (and each screenshot ref
// `attachment:<PROJECT>-0/name`). Once Jira has created the issue and `filed` is appended, the
// projector rewrites those, validates the result against the XSD, stores it as a new version of the
// same artifact (the fixer reads the latest), and writes the `Implementation Prompt` field with the
// real key. A request that does not validate after the rewrite is not stored: the ticket gets
// `prompt-failed` and the field is cleared, since it would name an issue that does not exist.

import type { IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { LABEL_PROMPT_FAILED, PLACEHOLDER_ISSUE_NUMBER } from '@snapwing/pipeline/jira/synthesis.ts';
import { validateImplementationRequest } from '@snapwing/pipeline/prompts/implementation-request.ts';
import type { JiraClient } from '../client/index.ts';

const ROOT_TAG = /<implementation-request\b[^>]*>/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The placeholder key synthesis wrote for a project. */
export function placeholderKey(projectKey: string): string {
  return `${projectKey}-${PLACEHOLDER_ISSUE_NUMBER}`;
}

/**
 * Replaces the placeholder key with the real one: the root element's `issue` attribute and the
 * `attachment:<placeholder>/` prefix of screenshot refs. Work item keys of a parent request are other
 * issues and stay. Returns the input unchanged when it holds no placeholder.
 */
export function rewriteIssueKey(xml: string, placeholder: string, issueKey: string): string {
  const root = ROOT_TAG.exec(xml);
  if (root === null) return xml;
  const rootTag = root[0].replace(new RegExp(`(\\sissue=")${escapeRegExp(placeholder)}(")`), `$1${issueKey}$2`);
  const head = xml.slice(0, root.index);
  const rest = xml
    .slice(root.index + root[0].length)
    .split(`attachment:${placeholder}/`)
    .join(`attachment:${issueKey}/`);
  return head + rootTag + rest;
}

export type PromptOutcome =
  /** No implementation request was stored at plan time (the ticket already has `prompt-failed`). */
  | { status: 'none' }
  | { status: 'written'; version: number; rewritten: boolean }
  | { status: 'failed'; errors: string[] };

export interface FinalizePromptInput {
  state: StatePort;
  client: JiraClient;
  incidentId: string;
  issueKey: string;
  /** The project key the create payload named; its `-0` is the placeholder. */
  projectKey: string;
  /** The site's id for `Implementation Prompt`. */
  fieldId: string;
  /** Written as `createdBy` on the new artifact version. */
  createdBy: string;
}

function plannedRequest(log: readonly IncidentEvent[]): { artifactId: string } | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e !== undefined && e.type === 'planned') {
      const ref = e.payload.implementationRequest;
      return ref === undefined ? undefined : { artifactId: ref.artifactId };
    }
  }
  return undefined;
}

/**
 * Runs after `filed`. Idempotent: a repeat finds the latest artifact version already rewritten, stores
 * nothing new, and writes the same field value again, so a crash anywhere in here repeats safely.
 */
export async function finalizePrompt(input: FinalizePromptInput): Promise<PromptOutcome> {
  const { state, client, incidentId, issueKey, fieldId } = input;
  const ref = plannedRequest(await state.read(incidentId));
  if (ref === undefined) return { status: 'none' };
  const latest = await state.getArtifact(ref.artifactId);
  const body = rewriteIssueKey(latest.body, placeholderKey(input.projectKey), issueKey);

  let errors: string[] = [];
  try {
    const result = await validateImplementationRequest(body);
    if (!result.valid) errors = result.errors.map((e) => e.message);
  } catch (err) {
    errors = [err instanceof Error ? err.message : String(err)];
  }
  if (errors.length > 0) {
    await client.addLabels(issueKey, [LABEL_PROMPT_FAILED]);
    await client.editIssue(issueKey, { [fieldId]: null });
    return { status: 'failed', errors };
  }

  const rewritten = body !== latest.body;
  let version = latest.version;
  if (rewritten) {
    ({ version } = await state.putArtifact({
      id: latest.id,
      workspaceId: latest.workspaceId,
      incidentId: latest.incidentId,
      kind: 'implementation-request',
      contentType: 'application/xml',
      body,
      createdBy: input.createdBy,
    }));
  }
  await client.editIssue(issueKey, { [fieldId]: body });
  return { status: 'written', version, rewritten };
}
