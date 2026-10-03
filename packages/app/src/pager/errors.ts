// Typed errors for the PagerDuty Events API v2 client (A 6.2). Messages never carry the routing key.

export class PagerDutyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PagerDutyError';
    this.status = status;
  }
}

/** HTTP 429. The caller waits `retryAfterMs` before the next event. */
export class PagerDutyRateLimitError extends PagerDutyError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`pagerduty rate limited; retry after ${retryAfterMs} ms`, 429);
    this.name = 'PagerDutyRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP 400: the event was malformed, or the routing key is not a valid integration key. */
export class PagerDutyValidationError extends PagerDutyError {
  readonly errors: string[];

  constructor(message: string, errors: string[]) {
    super(`pagerduty rejected the event${message ? `: ${message}` : ''}${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`, 400);
    this.name = 'PagerDutyValidationError';
    this.errors = errors;
  }
}

/** Any other non-2xx answer, or a network failure (status 0). */
export class PagerDutyApiError extends PagerDutyError {
  constructor(status: number, detail?: string) {
    super(status === 0 ? `pagerduty request failed${detail ? `: ${detail}` : ''}` : `pagerduty answered ${status}`, status);
    this.name = 'PagerDutyApiError';
  }
}
