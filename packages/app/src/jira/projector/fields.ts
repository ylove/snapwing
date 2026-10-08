// Custom field ids (B 7.2). The ticket payload names its custom fields (`Implementation Prompt`,
// `Conversation Link`, `Autonomy Level`) and the lifecycle rows name `Agent Status`; Jira wants the
// site's `customfield_NNNNN` ids. `pnpm jira:bootstrap` (scripts/jira-bootstrap.ts) creates the four
// fields and writes their ids into `.env.live` as the variables below, so the composition root reads
// them from the environment and hands the map to `createJiraProjector`, which refuses to start
// without every one: a missing id would otherwise drop a field from every write without a sound.

import { CUSTOM_FIELD_AUTONOMY_LEVEL, CUSTOM_FIELD_CONVERSATION_LINK, CUSTOM_FIELD_IMPLEMENTATION_PROMPT } from '@snapwing/pipeline/jira/synthesis.ts';
import { CUSTOM_FIELD_AGENT_STATUS } from '@snapwing/pipeline/state/projections/outbox/jira.ts';

/** Field name to the environment variable the bootstrap writes its id to. */
export const CUSTOM_FIELD_ENV: Readonly<Record<string, string>> = Object.freeze({
  [CUSTOM_FIELD_IMPLEMENTATION_PROMPT]: 'JIRA_FIELD_IMPL_PROMPT',
  [CUSTOM_FIELD_CONVERSATION_LINK]: 'JIRA_FIELD_CONVERSATION',
  [CUSTOM_FIELD_AUTONOMY_LEVEL]: 'JIRA_FIELD_AUTONOMY',
  [CUSTOM_FIELD_AGENT_STATUS]: 'JIRA_FIELD_AGENT_STATUS',
});

/** The custom field names the projector must be able to write. */
export const REQUIRED_CUSTOM_FIELDS: readonly string[] = Object.freeze(Object.keys(CUSTOM_FIELD_ENV));

const FIELD_ID = /^customfield_\d+$/;
const HINT = 'Run `pnpm jira:bootstrap` to create the fields and write their ids to .env.live.';

/** Thrown at startup when a custom field has no usable Jira id. */
export class JiraFieldConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Jira custom field ids are missing or malformed: ${missing.join(', ')}. ${HINT}`);
    this.name = 'JiraFieldConfigError';
    this.missing = missing;
  }
}

/**
 * Checks that every required field name maps to a `customfield_NNNNN` id and returns the map.
 * Throws `JiraFieldConfigError` naming every name that does not.
 */
export function requireCustomFieldIds(ids: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const missing = REQUIRED_CUSTOM_FIELDS.filter((name) => {
    const id = ids[name];
    return id === undefined || !FIELD_ID.test(id);
  });
  if (missing.length > 0) throw new JiraFieldConfigError(missing);
  return ids;
}

/** Reads the field ids the bootstrap wrote (`JIRA_FIELD_*`) and checks them; throws `JiraFieldConfigError`. */
export function customFieldIdsFromEnv(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [name, variable] of Object.entries(CUSTOM_FIELD_ENV)) {
    const value = env[variable]?.trim();
    if (value !== undefined && value !== '') ids[name] = value;
  }
  return requireCustomFieldIds(ids);
}
