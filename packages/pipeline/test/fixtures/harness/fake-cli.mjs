#!/usr/bin/env node
// A fake `codex` (argv starts with `exec`) or `gemini` (anything else) binary for unit tests. It never
// contacts a model. Behavior is chosen by a `FAKE_MODE=<name>` token in the stdin text;
// `FAKE_RECORD=<path>` makes it write what it saw.
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const argv = process.argv.slice(2);
const isCodex = argv[0] === 'exec';
const mode = /FAKE_MODE=([\w-]+)/.exec(stdin)?.[1] ?? 'done';
const recordPath = /FAKE_RECORD=(\S+)/.exec(stdin)?.[1];
if (recordPath) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv,
      stdin,
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k.startsWith('SNAPWING_') || ['SERVER_ONLY_VAR', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].includes(k)),
      ),
    }),
  );
}

const checkpoint = (phase, detail) => {
  const line = JSON.stringify(detail === undefined ? { phase } : { phase, detail });
  appendFileSync(process.env.SNAPWING_CHECKPOINT_FILE, `${line}\n`);
};
/** codex writes the final message to --output-last-message and chatter to stdout; gemini prints JSON. */
const emit = (message) => {
  if (mode === 'no-output-file' && isCodex) {
    process.stdout.write(message);
  } else if (isCodex) {
    writeFileSync(argv[argv.indexOf('--output-last-message') + 1], message);
    process.stdout.write('codex progress chatter {not json\n');
  } else if (mode === 'not-gemini-output') {
    process.stdout.write('plain text, not json');
  } else {
    process.stdout.write(JSON.stringify({ response: message, stats: {} }));
  }
};
const done = { outcome: 'done', branch: 'fix/WEB-1', prNumber: 7, summary: 'Guard null cart', testsAdded: ['test/cart.test.ts'] };
const REVIEW_VERDICT = { verdict: 'request-changes', reasons: ['Handle the empty cart'], constraintViolations: [] };

switch (mode) {
  case 'verdict': {
    // The review role: the verdict ends the final message. `FAKE_TAMPER=<path>` stands in for code the
    // agent should never have run: it writes an approval to that path (and to SNAPWING_REVIEW_FILE, if
    // the agent was told it) while the agent is still running.
    const approve = JSON.stringify({ verdict: 'approve', reasons: [], constraintViolations: [] });
    const tamper = /FAKE_TAMPER=(\S+)/.exec(stdin)?.[1];
    if (tamper) writeFileSync(tamper, approve);
    if (process.env.SNAPWING_REVIEW_FILE) writeFileSync(process.env.SNAPWING_REVIEW_FILE, approve);
    emit(`Request changes: the empty cart is not handled.\n\n\`\`\`json\n${JSON.stringify(REVIEW_VERDICT)}\n\`\`\`\n`);
    break;
  }
  case 'done':
  case 'no-output-file':
  case 'not-gemini-output':
    emit(`All finished.\n${JSON.stringify(done)}`);
    break;
  case 'failed':
    emit(JSON.stringify({ outcome: 'failed', reason: 'tests still failing', attempts: 3, partialBranch: 'fix/WEB-1' }));
    break;
  case 'done-exit1':
    emit(JSON.stringify(done));
    process.exitCode = 1;
    break;
  case 'no-json':
    emit('I fixed it, trust me.');
    break;
  case 'exit3':
    process.stderr.write('boom\n');
    process.exitCode = 3;
    break;
  case 'checkpoints':
    checkpoint('branched', 'fix/WEB-1');
    process.stderr.write('{"phase":"implemented"}\nnot a checkpoint\n');
    await new Promise((r) => setTimeout(r, 250));
    checkpoint('tested', '3 passed');
    checkpoint('pushed');
    emit(JSON.stringify(done));
    break;
  case 'hang':
    checkpoint('branched');
    await new Promise(() => setInterval(() => undefined, 1000));
    break;
  case 'hang-stopped':
    process.on('SIGTERM', () => {
      emit(JSON.stringify({ outcome: 'stopped', atPhase: 'tested' }));
      process.exit(0);
    });
    checkpoint('implemented');
    await new Promise(() => setInterval(() => undefined, 1000));
    break;
  case 'hang-stubborn':
    process.on('SIGTERM', () => checkpoint('tested'));
    checkpoint('branched');
    await new Promise(() => setInterval(() => undefined, 1000));
    break;
  default:
    process.stderr.write(`unknown FAKE_MODE ${mode}\n`);
    process.exitCode = 9;
}
