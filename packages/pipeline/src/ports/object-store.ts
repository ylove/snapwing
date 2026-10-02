// src/ports/object-store.ts (main 14.3): the object store runtime port, for screenshots and other
// binary captures. Local: disk under a root (providers/local/object-store.ts); aws: S3; gcp: GCS;
// docker: MinIO.

export interface ObjectStorePort {
  /**
   * Stores `body` under `key`, overwriting, and resolves with the provider's URL for the object
   * (`file://` on local, `s3://` or `gs://` on the clouds). Keys are `/`-separated relative paths.
   */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  /** The bytes stored under `key`. Rejects with `ObjectNotFoundError` when there is none. */
  get(key: string): Promise<Buffer>;
}

export class ObjectNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`no object under key ${key}`);
    this.name = 'ObjectNotFoundError';
    this.key = key;
  }
}

/**
 * A key no provider may accept: empty, absolute, with an empty, `.`, or `..` segment, a backslash,
 * or a control character.
 */
export class InvalidObjectKeyError extends Error {
  readonly key: string;

  constructor(key: string, why: string) {
    super(`invalid object key ${JSON.stringify(key)}: ${why}`);
    this.name = 'InvalidObjectKeyError';
    this.key = key;
  }
}

/** Throws `InvalidObjectKeyError` unless `key` is a safe relative key (see the error). */
export function assertObjectKey(key: string): void {
  if (key.length === 0) throw new InvalidObjectKeyError(key, 'empty');
  if (key.length > 1024) throw new InvalidObjectKeyError(key, 'longer than 1024 characters');
  if (key.startsWith('/')) throw new InvalidObjectKeyError(key, 'absolute');
  if (key.includes('\\')) throw new InvalidObjectKeyError(key, 'contains a backslash');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new InvalidObjectKeyError(key, 'contains a control character');
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new InvalidObjectKeyError(key, 'has an empty, "." or ".." segment');
    }
  }
}
