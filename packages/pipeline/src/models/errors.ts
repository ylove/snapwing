// Typed errors for the ModelPort (main 14.5). Stages catch these by class, never by message.

import type { ModelTask } from '../ports/model.ts';

/** Base class for every error the model layer throws on purpose. */
export class ModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelError';
  }
}

/**
 * A provider got an answer it could not turn into structured output at all (not JSON, no tool call).
 * Provider adapters throw this from `classify`; withValidation treats it like a failed `validate`
 * and spends the one retry on it.
 */
export class ModelOutputError extends ModelError {
  readonly raw: string | undefined;
  constructor(message: string, raw?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelOutputError';
    this.raw = raw;
  }
}

/** A `classify` answer failed `validate` on the first attempt and again on the retry (main 14.5). */
export class ModelValidationError extends ModelError {
  readonly task: ModelTask;
  readonly schemaName: string;
  readonly attempts: number;
  /** The last value the provider returned, or undefined when it returned nothing parseable. */
  readonly lastValue: unknown;
  /** Human-readable reason for the last failure. */
  readonly reason: string;
  constructor(args: { task: ModelTask; schemaName: string; attempts: number; lastValue: unknown; reason: string }) {
    super(
      `Model output for task "${args.task}" failed schema "${args.schemaName}" after ${args.attempts} attempts: ${args.reason}`,
    );
    this.name = 'ModelValidationError';
    this.task = args.task;
    this.schemaName = args.schemaName;
    this.attempts = args.attempts;
    this.lastValue = args.lastValue;
    this.reason = args.reason;
  }
}

/** The provider throttled the call (HTTP 429). `retryAfterMs` is set when the provider said how long to wait. */
export class ModelRateLimitError extends ModelError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The provider rejected the credentials or the key may not use the model (HTTP 401 or 403). Retrying will not help. */
export class ModelAuthError extends ModelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelAuthError';
  }
}

/** The provider is down, overloaded, or unreachable (HTTP 5xx, connection failure, timeout). Worth retrying later. */
export class ModelUnavailableError extends ModelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelUnavailableError';
  }
}

/** The router cannot pick a provider or has no adapter registered for the one it picked. */
export class ModelRoutingError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRoutingError';
  }
}

/** MockModel has no recording for a request. The message carries the full key and the expected file path. */
export class MockFixtureMissError extends ModelError {
  readonly key: string;
  readonly path: string;
  constructor(key: string, path: string) {
    super(
      `MockModel has no recording for ${key}. Expected fixture file: ${path}. ` +
        'Record it with writeMockFixture (models/mock.ts) or add the file by hand.',
    );
    this.name = 'MockFixtureMissError';
    this.key = key;
    this.path = path;
  }
}

/** A fixture file exists but does not have the shape MockModel expects. */
export class MockFixtureError extends ModelError {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`Malformed MockModel fixture ${path}: ${reason}`);
    this.name = 'MockFixtureError';
    this.path = path;
  }
}
