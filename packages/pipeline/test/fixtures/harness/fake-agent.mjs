// A fake coding agent for the generic harness tests. FAKE_AGENT_MODE picks the behavior.
// It reads the whole of stdin first, as the contract says, then acts.

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setInterval } from 'node:timers';

const mode =process.env.FAKE_AGENT_MODE ?? 'success';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const request = Buffer.concat(chunks).toString('utf8');

const checkpoint = (phase, detail) => process.stderr.write(`${JSON.stringify(detail === undefined ? { phase } : { phase, detail })}\n`);
const result = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const hang = () => setInterval(() => {}, 1000);

switch (mode) {
  case 'success':
    process.stderr.write('plain log line, ignored\n');
    checkpoint('branched', 'fix/WEB-1');
    checkpoint('implemented');
    checkpoint('tested', '1 passed');
    result({ outcome: 'done', branch: 'fix/WEB-1', summary: 'ok', testsAdded: ['t.test.ts'], extra: 'dropped' });
    break;
  case 'failure':
    checkpoint('branched');
    result({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' });
    process.exit(1);
    break;
  case 'echo': {
    // Reports the request and the contract environment back through the summary.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SNAPWING_')));
    result({
      outcome: 'done',
      branch: 'b',
      summary: JSON.stringify({ request, env, cwd: process.cwd(), args: process.argv.slice(2), leaked: process.env.FAKE_SERVER_SECRET ?? null }),
      testsAdded: [],
    });
    break;
  }
  case 'stop-graceful':
    checkpoint('branched');
    checkpoint('implemented');
    process.on('SIGTERM', () => {
      result({ outcome: 'stopped', atPhase: 'implemented' });
      process.exit(0);
    });
    hang();
    break;
  case 'stop-silent':
    // Dies on SIGTERM without printing a result; the adapter falls back to the last checkpoint.
    checkpoint('branched');
    checkpoint('tested');
    process.on('SIGTERM', () => process.exit(143));
    hang();
    break;
  case 'stop-stubborn':
    // Ignores SIGTERM, so only SIGKILL ends it.
    checkpoint('branched');
    process.on('SIGTERM', () => {});
    hang();
    break;
  case 'hang':
    checkpoint('branched');
    process.on('SIGTERM', () => process.exit(143));
    hang();
    break;
  case 'garbage':
    process.stdout.write('this is not json\n');
    break;
  case 'garbage-exit':
    process.stdout.write('this is not json\n');
    process.stderr.write('boom: could not reach model\n');
    process.exit(2);
    break;
  case 'done-nonzero':
    result({ outcome: 'done', branch: 'b', summary: 's', testsAdded: [] });
    process.exit(5);
    break;
  default:
    process.stderr.write(`unknown FAKE_AGENT_MODE ${mode}\n`);
    process.exit(64);
}
