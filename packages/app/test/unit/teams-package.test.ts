// The Teams app package (main 15.2): the manifest against Microsoft's JSON schema (vendored under
// manifests/teams/schema/), the placeholder substitution, the icons, and the zip layout. No network.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assetPath } from '@snapwing/pipeline/util/assets.ts';
import { APP_NAME } from '../../src/onboard/slack/bootstrap.ts';
import { buildTeamsPackage, renderTeamsManifest, TEAMS_PACKAGE_FILES } from '../../src/onboard/teams/package.ts';

const APP_ID = '3f2a9c1e-7b4d-4e6a-9d10-5c8e2b7a41f0';
const INPUT = { appId: APP_ID, publicUrl: 'https://snapwing.example.org/', version: '1.2.3' } as const;

const asset = (p: string): Buffer => readFileSync(assetPath(`manifests/teams/${p}`));
const TEMPLATE = asset('manifest.json').toString('utf8');

// ---- a small JSON Schema (draft-04) checker, and a hand-written subset of the Teams manifest schema ----
//
// The subset mirrors, in our own words, the constraints of Microsoft's published Teams app manifest
// schema, version 1.30 (https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json),
// for the fields Snapwing sets. The Microsoft file itself is not copied into this repository.

interface Schema {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  oneOf?: Schema[];
  anyOf?: Schema[];
  definitions?: Record<string, Schema>;
}

const str = (maxLength: number): Schema => ({ type: 'string', minLength: 1, maxLength });
const httpsUrl: Schema = { type: 'string', pattern: '^https://[^\\s]+$', maxLength: 2048 };
const scopes: Schema = { type: 'array', maxItems: 4, items: { enum: ['team', 'personal', 'groupChat', 'copilot'] } };

const SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['manifestVersion', 'version', 'id', 'developer', 'name', 'description', 'icons', 'accentColor'],
  definitions: { guid: { type: 'string', pattern: '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' } },
  properties: {
    $schema: { type: 'string' },
    manifestVersion: { type: 'string', enum: ['1.30'] },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+', maxLength: 256 },
    id: { $ref: '#/definitions/guid' },
    developer: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'websiteUrl', 'privacyUrl', 'termsOfUseUrl'],
      properties: { name: str(32), websiteUrl: httpsUrl, privacyUrl: httpsUrl, termsOfUseUrl: httpsUrl },
    },
    name: { type: 'object', additionalProperties: false, required: ['short'], properties: { short: str(30), full: str(100) } },
    description: { type: 'object', additionalProperties: false, required: ['short', 'full'], properties: { short: str(80), full: str(4000) } },
    icons: { type: 'object', additionalProperties: false, required: ['outline', 'color'], properties: { outline: str(2048), color: str(2048) } },
    accentColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    bots: {
      type: 'array',
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['botId', 'scopes'],
        properties: {
          botId: { $ref: '#/definitions/guid' },
          scopes,
          supportsFiles: { type: 'boolean' },
          isNotificationOnly: { type: 'boolean' },
          commandLists: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['scopes', 'commands'],
              properties: {
                scopes,
                commands: {
                  type: 'array',
                  maxItems: 12,
                  items: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: str(128), description: str(4000) } },
                },
              },
            },
          },
        },
      },
    },
    composeExtensions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['botId'],
        properties: {
          botId: { $ref: '#/definitions/guid' },
          commands: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title'],
              properties: {
                id: str(64),
                type: { enum: ['query', 'action'] },
                title: str(32),
                description: str(128),
                context: { type: 'array', maxItems: 3, items: { enum: ['compose', 'commandBox', 'message'] } },
                fetchTask: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    permissions: { type: 'array', items: { enum: ['identity', 'messageTeamMembers'] } },
    validDomains: { type: 'array', maxItems: 100, items: str(2048) },
    webApplicationInfo: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { $ref: '#/definitions/guid' }, resource: str(2048) },
    },
    authorization: {
      type: 'object',
      additionalProperties: false,
      properties: {
        permissions: {
          type: 'object',
          additionalProperties: false,
          properties: {
            resourceSpecific: {
              type: 'array',
              maxItems: 16,
              uniqueItems: true,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'type'],
                properties: {
                  name: { enum: ['ChannelMessage.Read.Group', 'TeamMember.Read.Group', 'ChannelSettings.Read.Group'] },
                  type: { enum: ['Application'] },
                },
              },
            },
          },
        },
      },
    },
  },
};

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (schema.$ref !== undefined) {
    const target = SCHEMA.definitions?.[schema.$ref.replace('#/definitions/', '')];
    if (target === undefined) throw new Error(`unresolved ${schema.$ref}`);
    return check(value, target, path, errors);
  }
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type !== undefined && kind !== schema.type) return void errors.push(`${path}: expected ${schema.type}, got ${kind}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  for (const alt of [schema.oneOf, schema.anyOf]) {
    if (alt !== undefined && !alt.some((s) => { const e: string[] = []; check(value, s, path, e); return e.length === 0; })) errors.push(`${path}: matches none of the alternatives`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: items are not unique`);
    if (schema.items !== undefined) value.forEach((v, i) => check(v, schema.items as Schema, `${path}[${i}]`, errors));
  }
  if (kind === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub !== undefined) check(v, sub, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
      else if (typeof schema.additionalProperties === 'object') check(v, schema.additionalProperties, `${path}.${key}`, errors);
    }
  }
}

function validate(manifest: unknown): string[] {
  const errors: string[] = [];
  check(manifest, SCHEMA, '$', errors);
  return errors;
}

// ---- a minimal zip reader, independent of the writer ----

function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = method === 8 ? inflateRawSync(buf.subarray(start, start + size)) : buf.subarray(start, start + size);
    out.set(name, Buffer.from(data));
    at += 46 + nameLen;
  }
  return out;
}

const pngSize = (png: Buffer): { width: number; height: number; colorType: number } => {
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] as number };
};

describe('the Teams manifest', () => {
  it('declares schema version 1.30', () => {
    const manifest = JSON.parse(TEMPLATE) as { manifestVersion: string; $schema: string };
    expect(manifest.manifestVersion).toBe('1.30');
    expect(manifest.$schema).toBe('https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json');
  });

  it('validates against the hand-written subset of the Teams manifest schema once the placeholders are filled', () => {
    expect(validate(JSON.parse(renderTeamsManifest(TEMPLATE, INPUT)))).toEqual([]);
  });

  it('the checker rejects a broken manifest', () => {
    const broken = JSON.parse(renderTeamsManifest(TEMPLATE, INPUT)) as Record<string, unknown>;
    delete broken.icons;
    broken.id = 'not-a-guid';
    broken.surprise = true;
    expect(validate(broken).join('\n')).toMatch(/missing icons[\s\S]*\$\.id[\s\S]*unexpected property surprise/);
  });

  it('declares the bot, the message action, the RSC permissions, and the sign-in and domain fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = JSON.parse(renderTeamsManifest(TEMPLATE, INPUT)) as Record<string, any>;
    expect(m.name.short).toBe(APP_NAME);
    expect(m.id).toBe(APP_ID);
    expect(m.version).toBe('1.2.3');
    expect(m.bots).toHaveLength(1);
    expect(m.bots[0].botId).toBe(APP_ID);
    expect(m.bots[0].scopes).toEqual(['personal', 'team']);
    expect(m.bots[0].commandLists[0].scopes).toEqual(['personal', 'team']);
    expect(m.bots[0].commandLists[0].commands.map((c: { title: string }) => c.title)).toEqual(['status', 'queue', 'help']);
    const [action] = m.composeExtensions[0].commands;
    expect(m.composeExtensions[0].botId).toBe(APP_ID);
    expect(action).toMatchObject({ type: 'action', title: 'Fix it from here', context: ['message'] });
    expect(m.authorization.permissions.resourceSpecific.map((p: { name: string }) => p.name)).toEqual([
      'ChannelMessage.Read.Group',
      'TeamMember.Read.Group',
      'ChannelSettings.Read.Group',
    ]);
    expect(m.webApplicationInfo.id).toBe(APP_ID);
    expect(m.validDomains).toEqual(['snapwing.example.org']);
  });

  it('uses only the three placeholders, and fills each one', () => {
    expect([...new Set(TEMPLATE.match(/\$\{[^}]*\}/g))].sort()).toEqual(['${APP_VERSION}', '${PUBLIC_HOST}', '${TEAMS_APP_ID}']);
    expect(renderTeamsManifest(TEMPLATE, INPUT)).not.toMatch(/\$\{/);
  });

  it('refuses a bad app id, version, or address, and a template with an unknown placeholder', () => {
    expect(() => renderTeamsManifest(TEMPLATE, { ...INPUT, appId: 'nope' })).toThrow(/GUID/);
    expect(() => renderTeamsManifest(TEMPLATE, { ...INPUT, version: 'one' })).toThrow(/semver/);
    expect(() => renderTeamsManifest(TEMPLATE, { ...INPUT, publicUrl: 'http://snapwing.example.org' })).toThrow(/https/);
    expect(() => renderTeamsManifest(TEMPLATE, { ...INPUT, publicUrl: 'not a url' })).toThrow(/https/);
    expect(() => renderTeamsManifest('{"a":"${OTHER}"}', INPUT)).toThrow(/unfilled placeholder/);
  });
});

describe('the icons', () => {
  it('color.png is 192x192 and outline.png is 32x32 with an alpha channel and a transparent corner', () => {
    expect(pngSize(asset('color.png'))).toEqual({ width: 192, height: 192, colorType: 6 });
    const outline = asset('outline.png');
    expect(pngSize(outline)).toEqual({ width: 32, height: 32, colorType: 6 });
    // The top-left pixel, from the first scanline (filter byte 0, then RGBA).
    const idat = outline.indexOf('IDAT') + 4;
    const raw = inflateSync(outline.subarray(idat, idat + outline.readUInt32BE(idat - 8)));
    expect([...raw.subarray(1, 5)]).toEqual([0, 0, 0, 0]);
  });
});

describe('buildTeamsPackage', () => {
  const bytes = buildTeamsPackage(INPUT);

  it('holds the manifest and both icons at the zip root', () => {
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual([...TEAMS_PACKAGE_FILES]);
    for (const name of files.keys()) expect(name).not.toContain('/');
    expect(files.get('color.png')).toEqual(asset('color.png'));
    expect(files.get('outline.png')).toEqual(asset('outline.png'));
  });

  it('carries the filled manifest, with no placeholder left', () => {
    const text = (unzip(bytes).get('manifest.json') as Buffer).toString('utf8');
    expect(text).toBe(renderTeamsManifest(TEMPLATE, INPUT));
    expect(text).not.toMatch(/\$\{/);
    expect(validate(JSON.parse(text))).toEqual([]);
  });

  it('is identical for identical input and differs when the input does', () => {
    expect(Buffer.from(buildTeamsPackage(INPUT)).equals(Buffer.from(bytes))).toBe(true);
    expect(Buffer.from(buildTeamsPackage({ ...INPUT, version: '1.2.4' })).equals(Buffer.from(bytes))).toBe(false);
  });
});
