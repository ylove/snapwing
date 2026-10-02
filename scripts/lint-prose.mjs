#!/usr/bin/env node
// Prose lint (ADR 0009): no em dashes in shipped prose.
// Checks every Markdown file in the repository and every file under packages/*/src/**/cards/**.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo', '.pnpm-store']);
const banned = [
  { pattern: /—/g, label: 'em dash (U+2014)' },
  { pattern: /&mdash;/g, label: 'em dash entity (&mdash;)' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isChecked(rel) {
  const parts = rel.split(sep);
  if (rel.endsWith('.md')) return true;
  return parts[0] === 'packages' && parts[2] === 'src' && parts.slice(3, -1).includes('cards');
}

const failures = [];
for (const file of walk(root)) {
  const rel = relative(root, file);
  if (!isChecked(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { pattern, label } of banned) {
      if (pattern.test(line)) failures.push(`${rel}:${i + 1}: ${label}`);
      pattern.lastIndex = 0;
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`\nprose lint: ${failures.length} problem(s). Use commas, colons, periods, or parentheses instead (ADR 0009).`);
  process.exit(1);
}
console.log('prose lint: ok');
