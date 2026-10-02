#!/usr/bin/env node
// Placeholder for root scripts whose implementation lands in a later phase.
// Usage: node scripts/not-yet.mjs <script-name> <phase>
const [name = 'this script', phase = '?'] = process.argv.slice(2);
console.error(`pnpm ${name} is not implemented yet. It lands in phase ${phase}; see the board for the issue.`);
process.exit(1);
