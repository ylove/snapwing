// src/ports/secrets.ts (main 14.3): the secrets runtime port. Local: a `.env` file
// (providers/local/secrets.ts); aws: Secrets Manager; gcp: Secret Manager; docker: `.env` or Vault.
// Secret names are the ones in build/CONTEXT.md 6b. A value is never logged or put in an error.

export interface SecretsPort {
  /** The secret's value. Rejects with `SecretNotFoundError` when the provider has no such secret. */
  get(name: string): Promise<string>;
}

/** No secret under `name`. The message names the secret, never a value. */
export class SecretNotFoundError extends Error {
  readonly secretName: string;

  constructor(secretName: string, where: string) {
    super(`secret ${secretName} is not set in ${where}`);
    this.name = 'SecretNotFoundError';
    this.secretName = secretName;
  }
}
