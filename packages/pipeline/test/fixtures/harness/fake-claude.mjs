#!/usr/bin/env node
// A fake `claude` binary for unit tests. It never contacts a model. Behavior is chosen by a
// `FAKE_MODE=<name>` token in the stdin request; `FAKE_RECORD=<path>` makes it write what it saw.
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const mode = /FAKE_MODE=([\w-]+)/.exec(stdin)?.[1] ?? 'done';
const recordPath = /FAKE_RECORD=(\S+)/.exec(stdin)?.[1];
if (recordPath) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      cwd: process.cwd(),
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SNAPWING_') || k === 'SERVER_ONLY_VAR')),
    }),
  );
}

const checkpoint = (phase, detail) => {
  const line = JSON.stringify(detail === undefined ? { phase } : { phase, detail });
  appendFileSync(process.env.SNAPWING_CHECKPOINT_FILE, `${line}\n`);
};
const emit = (message, extra = {}) => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: message, ...extra }));
};
const done = { outcome: 'done', branch: 'fix/WEB-1', prNumber: 7, summary: 'Guard null cart', testsAdded: ['test/cart.test.ts'] };

switch (mode) {
  case 'done':
    emit(`All finished.\n${JSON.stringify(done)}`);
    break;
  case 'bare':
    emit(JSON.stringify(done));
    break;
  case 'fenced':
    emit(`Here is the result.\n\n\`\`\`json\n${JSON.stringify(done)}\n\`\`\`\n`);
    break;
  case 'failed':
    emit(JSON.stringify({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' }));
    break;
  case 'failed-exit1':
    emit(JSON.stringify({ outcome: 'failed', reason: 'gave up', attempts: 2 }));
    process.exitCode = 1;
    break;
  case 'done-exit1':
    emit(JSON.stringify(done));
    process.exitCode = 1;
    break;
  case 'no-json':
    emit('I fixed it, trust me.');
    break;
  case 'not-claude-output':
    process.stdout.write('plain text, not json');
    break;
  case 'exit3':
    process.stderr.write('boom\n');
    process.exitCode = 3;
    break;
  case 'checkpoints':
    checkpoint('branched', 'fix/WEB-1');
    process.stderr.write('{"phase":"implemented"}\nnot a checkpoint\n{"level":"info"}\n');
    await new Promise((r) => setTimeout(r, 250));
    checkpoint('tested', '3 passed');
    checkpoint('pushed');
    emit(JSON.stringify(done));
    break;
  case 'hang': {
    // Runs until killed. Reports one checkpoint so Stop has a phase to name.
    checkpoint('branched');
    await new Promise(() => setInterval(() => undefined, 1000));
    break;
  }
  case 'hang-stopped':
    // Signal handlers are installed before the first checkpoint: tests abort in response to a
    // checkpoint, so the SIGTERM can never arrive before the handler exists.
    process.on('SIGTERM', () => {
      emit(JSON.stringify({ outcome: 'stopped', atPhase: 'tested' }));
      process.exit(0);
    });
    checkpoint('implemented');
    await new Promise(() => setInterval(() => undefined, 1000));
    break;
  case 'hang-stubborn':
    // Reports each SIGTERM as a `tested` checkpoint so tests can assert the signal sequence.
    process.on('SIGTERM', () => checkpoint('tested'));
    checkpoint('branched');
    await new Promise(() => setInterval(() => undefined, 1000));
    break;
  default:
    process.stderr.write(`unknown FAKE_MODE ${mode}\n`);
    process.exitCode = 9;
}
