// The Teams app package (main 15.2): `manifests/teams/manifest.json` with its placeholders filled in,
// zipped with `color.png` and `outline.png` at the root, ready for a sideload or an admin upload.
// The zip writer is a small dependency-free one (deflate from `node:zlib`). The output is a pure
// function of the input: entries are in a fixed order with a fixed timestamp.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { assetPath } from '@snapwing/pipeline/util/assets.ts';

export interface TeamsPackageInput {
  /** The Entra app (client) id of the bot, a GUID. It is the manifest `id`, the bot id, and the SSO app id. */
  appId: string;
  /** Snapwing's public https address; its host fills `validDomains` and the developer links. */
  publicUrl: string;
  /** The app version, semver. Teams needs a higher one for every upload of a changed manifest. */
  version: string;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const GUID = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The package files, in zip order. The manifest is read from the asset tree (`manifests/teams/`). */
export const TEAMS_PACKAGE_FILES = ['manifest.json', 'color.png', 'outline.png'] as const;

/** `manifest.json` text with `${TEAMS_APP_ID}`, `${PUBLIC_HOST}` and `${APP_VERSION}` replaced. */
export function renderTeamsManifest(template: string, input: TeamsPackageInput): string {
  if (!GUID.test(input.appId)) throw new Error(`Teams app id must be a GUID, got ${JSON.stringify(input.appId)}`);
  if (!SEMVER.test(input.version)) throw new Error(`Teams app version must be semver, got ${JSON.stringify(input.version)}`);
  let url: URL;
  try {
    url = new URL(input.publicUrl);
  } catch {
    throw new Error(`Teams package needs a public https address, got ${JSON.stringify(input.publicUrl)}`);
  }
  if (url.protocol !== 'https:') throw new Error(`Teams package needs a public https address, got ${JSON.stringify(input.publicUrl)}`);
  const values: Record<string, string> = { TEAMS_APP_ID: input.appId, PUBLIC_HOST: url.host, APP_VERSION: input.version };
  const out = template.replace(/\$\{([A-Z_]+)\}/g, (whole, key: string) => values[key] ?? whole);
  const left = out.match(/\$\{[A-Z_]+\}/);
  if (left !== null) throw new Error(`Teams manifest has an unfilled placeholder: ${left[0]}`);
  return out;
}

/** The Teams app package as zip bytes: `manifest.json`, `color.png` and `outline.png` at the root. */
export function buildTeamsPackage(input: TeamsPackageInput): Uint8Array {
  const read = (name: string): Buffer => readFileSync(assetPath(`manifests/teams/${name}`));
  const manifest = renderTeamsManifest(read('manifest.json').toString('utf8'), input);
  return zip([
    { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
    { name: 'color.png', data: read('color.png') },
    { name: 'outline.png', data: read('outline.png') },
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00, the earliest time a zip can hold, so identical input gives identical bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A zip of `entries` (names are plain ASCII paths), each deflated, with no extra fields and no comment. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    local.copy(central, 6, 4, 30); // version needed .. name length, as in the local header
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}
