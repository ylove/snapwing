// The `local` ObjectStorePort (main 14.3): objects on local disk under a configurable root.
//
// Layout under `root`: `objects/<key>` holds the bytes, `meta/<key>.json` the content type and
// size, `tmp/` the half-written files. A put writes to `tmp/` and renames into place, so a reader
// sees the old object or the new one, never a torn write. Keys are checked by `assertObjectKey`, so
// none can escape the root. Unlike S3, a key cannot also be a "directory" of another key: after
// `a`, a put of `a/b` fails (and the reverse).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertObjectKey, ObjectNotFoundError, type ObjectStorePort } from '../../ports/object-store.ts';
import { ulid } from '../../util/ulid.ts';

export interface LocalObjectStoreOptions {
  /** Directory the store lives under; created on first put. */
  root: string;
}

export interface ObjectMeta {
  contentType: string;
  size: number;
}

export interface LocalObjectStore extends ObjectStorePort {
  /** The content type and size stored with `key`. Rejects with `ObjectNotFoundError`. */
  head(key: string): Promise<ObjectMeta>;
}

export function createLocalObjectStore(options: LocalObjectStoreOptions): LocalObjectStore {
  const root = resolve(options.root);
  const objectPath = (key: string): string => join(root, 'objects', ...key.split('/'));
  const metaPath = (key: string): string => `${join(root, 'meta', ...key.split('/'))}.json`;

  const atomicWrite = async (path: string, data: Buffer | string): Promise<void> => {
    const tmpDir = join(root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(tmpDir, ulid());
    try {
      await writeFile(tmp, data);
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  };

  const readOrNotFound = async (key: string, path: string): Promise<Buffer> => {
    try {
      return await readFile(path);
    } catch (e) {
      if (isErrno(e, 'ENOENT') || isErrno(e, 'EISDIR') || isErrno(e, 'ENOTDIR')) throw new ObjectNotFoundError(key);
      throw e;
    }
  };

  return {
    async put(key, body, contentType) {
      assertObjectKey(key);
      const meta: ObjectMeta = { contentType, size: body.byteLength };
      // Meta first: a crash between the two leaves meta without bytes, which `get` reports as absent.
      await atomicWrite(metaPath(key), JSON.stringify(meta));
      await atomicWrite(objectPath(key), body);
      return pathToFileURL(objectPath(key)).href;
    },
    async get(key) {
      assertObjectKey(key);
      return readOrNotFound(key, objectPath(key));
    },
    async head(key) {
      assertObjectKey(key);
      await readOrNotFound(key, objectPath(key));
      const meta = JSON.parse((await readOrNotFound(key, metaPath(key))).toString('utf8')) as ObjectMeta;
      return { contentType: meta.contentType, size: meta.size };
    },
  };
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}
