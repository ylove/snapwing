/** Typed errors every capture client surface can branch on. */

export class CaptureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 401 or 403: the token is missing, wrong, revoked, or not allowed. */
export class CaptureAuthError extends CaptureError {
  readonly status: number;
  constructor(status: number, message = 'The Snapwing token was rejected. Run login again.') {
    super(message);
    this.status = status;
  }
}

/** Any other failure from the server: a bad status, a network failure (status null), or a malformed body. */
export class CaptureServerError extends CaptureError {
  readonly status: number | null;
  constructor(status: number | null, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

export class CaptureTimeoutError extends CaptureError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`The Snapwing server did not answer within ${timeoutMs} ms.`);
    this.timeoutMs = timeoutMs;
  }
}

/** The client config file is unreadable or invalid. */
export class CaptureConfigError extends CaptureError {}
