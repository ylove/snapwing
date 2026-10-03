// Response shapes for the parts of Jira Cloud REST v3 the client uses. Fields not listed are ignored.

/** An Atlassian Document Format document. */
export type Adf = { type: 'doc'; version: 1; content: unknown[] };

export interface JiraIssueRef {
  id: string;
  key: string;
  self: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: Record<string, unknown>;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { id: string; name: string };
}

export interface JiraSearchPage {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string; customId?: number };
}

export interface CreateFieldInput {
  name: string;
  description?: string;
  /** For example `com.atlassian.jira.plugin.system.customfieldtypes:textarea`. */
  type: string;
  searcherKey?: string;
}

export interface WebhookSpec {
  jqlFilter: string;
  events: string[];
}

export interface WebhookRegistration {
  createdWebhookId?: number;
  errors?: string[];
}

export interface JiraMyself {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
}

export interface UploadAttachmentInput {
  filename: string;
  content: Uint8Array;
  contentType?: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType?: string;
}

/** `GET /project/{key}`. A team-managed project answers `style: "next-gen"` and `simplified: true`. */
export interface JiraProject {
  id: string;
  key: string;
  name?: string;
  /** `classic` (company-managed) or `next-gen` (team-managed). */
  style?: string;
  simplified?: boolean;
}
