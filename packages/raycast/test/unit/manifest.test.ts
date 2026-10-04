import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  commands: { name: string; mode: string }[];
  preferences: { name: string; type: string; required: boolean }[];
  dependencies: Record<string, string>;
  icon: string;
};

describe('Raycast manifest', () => {
  it('declares the two commands', () => {
    expect(pkg.commands.map((c) => c.name)).toEqual(['fix-from-selection', 'send-screenshot']);
  });

  it('declares endpoint (text) and token (password) preferences', () => {
    expect(pkg.preferences.map((p) => [p.name, p.type, p.required])).toEqual([
      ['endpoint', 'textfield', true],
      ['token', 'password', true],
    ]);
  });

  it('depends on nothing but @raycast/api and capture-client', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@raycast/api', '@snapwing/capture-client']);
  });

  it('ships a 512 px icon', () => {
    const png = readFileSync(new URL(`../../assets/${pkg.icon}`, import.meta.url));
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });
});
