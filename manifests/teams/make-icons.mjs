#!/usr/bin/env node
// Writes the placeholder Teams icons, `color.png` (192x192) and `outline.png` (32x32), beside this file.
//
//   node manifests/teams/make-icons.mjs
//
// They are generic stand-ins until the brand is decided: a solid square with a blocky letter for the
// colour icon, and the same letter in white on a transparent background for the outline icon. The
// output is deterministic. Nothing is fetched. This script does not ship in the package tarball.

import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = new URL('.', import.meta.url);
const BACKGROUND = [0x1f, 0x2a, 0x44, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const CLEAR = [0, 0, 0, 0];

// A 5x7 letter, one string per row.
const LETTER = ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An RGBA PNG of `size` x `size`: `background` everywhere, the letter in `ink` over the middle. */
function png(size, background, ink) {
  const scale = Math.floor(size / 12);
  const left = Math.floor((size - 5 * scale) / 2);
  const top = Math.floor((size - 7 * scale) / 2);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const lx = Math.floor((x - left) / scale);
      const ly = Math.floor((y - top) / scale);
      const on = x >= left && y >= top && lx < 5 && ly < 7 && LETTER[ly][lx] === '#';
      Buffer.from(on ? ink : background).copy(row, 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(new URL('color.png', HERE), png(192, BACKGROUND, WHITE));
writeFileSync(new URL('outline.png', HERE), png(32, CLEAR, WHITE));
