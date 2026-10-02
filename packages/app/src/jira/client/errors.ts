// Typed errors for the Jira Cloud REST v3 client (main 9.1, B 7.1). Messages carry the HTTP method,
// the path, and Jira's own error text. They never carry credentials, headers, or request bodies.

export class JiraError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(message: string, status: number, method: string, path: string) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

/** HTTP 429. The projector pauses its drain for `retryAfterMs` (B 7.1). */
export class JiraRateLimitError extends JiraError {
  readonly retryAfterMs: number;

  constructor(method: string, path: string, retryAfterMs: number) {
    super(`jira rate limited ${method} ${path}; retry after ${retryAfterMs} ms`, 429, method, path);
    this.name = 'JiraRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP 401 or 403. */
export class JiraAuthError extends JiraError {
  constructor(status: number, method: string, path: string) {
    super(`jira rejected the credentials or permissions (${status}) for ${method} ${path}`, status, method, path);
    this.name = 'JiraAuthError';
  }
}

/** HTTP 404. */
export class JiraNotFoundError extends JiraError {
  readonly errorMessages: string[];

  constructor(method: string, path: string, errorMessages: string[]) {
    super(`jira not found: ${method} ${path}${errorMessages.length > 0 ? `: ${errorMessages.join('; ')}` : ''}`, 404, method, path);
    this.name = 'JiraNotFoundError';
    this.errorMessages = errorMessages;
  }
}

/** HTTP 400 (or 422). Carries Jira's `errorMessages` and per-field `errors`. */
export class JiraValidationError extends JiraError {
  readonly errorMessages: string[];
  readonly errors: Record<string, string>;

  constructor(status: number, method: string, path: string, errorMessages: string[], errors: Record<string, string>) {
    const detail = [...errorMessages, ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`)].join('; ');
    super(`jira rejected ${method} ${path}${detail ? `: ${detail}` : ''}`, status, method, path);
    this.name = 'JiraValidationError';
    this.errorMessages = errorMessages;
    this.errors = errors;
  }
}

/** Any other non-2xx answer. */
export class JiraApiError extends JiraError {
  constructor(status: number, method: string, path: string) {
    super(`jira answered ${status} for ${method} ${path}`, status, method, path);
    this.name = 'JiraApiError';
  }
}

/** `transitionIssue` found no transition to the named status. */
export class JiraTransitionNotFoundError extends Error {
  readonly issueKey: string;
  readonly requested: string;
  readonly available: string[];

  constructor(issueKey: string, requested: string, available: string[]) {
    super(`no transition to "${requested}" on ${issueKey}; available: ${available.join(', ') || '(none)'}`);
    this.name = 'JiraTransitionNotFoundError';
    this.issueKey = issueKey;
    this.requested = requested;
    this.available = available;
  }
}
