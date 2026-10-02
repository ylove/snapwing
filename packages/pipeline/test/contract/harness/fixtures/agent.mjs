import process from 'node:process';
import { setInterval } from 'node:timers';
import { readFile, writeFile } from 'node:fs/promises';

// Scenario control stays in the checkout, outside the harness environment.
export async function run(claude) {
  const scenario = JSON.parse(await readFile('scenario.json', 'utf8'));
  const finish = (result) => {
    const output = claude ? { type: 'result', result: JSON.stringify(result) } : result;
    process.stdout.write(`${JSON.stringify(output)}\n`);
  };
  let request = '';
  for await (const chunk of process.stdin) request += chunk;
  await writeFile('observed.json', JSON.stringify({ env: process.env, cwd: process.cwd(), request }));
  const phases = ['cloned', 'branched', 'implemented', 'tested', 'pushed', 'pr-opened'];
  if (scenario.mode === 'hang' || scenario.mode === 'stop') {
    process.on('SIGTERM', () => {
      if (scenario.mode === 'hang') return;
      finish({ outcome: 'stopped', atPhase: 'implemented' });
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    process.stderr.write('{"phase":"implemented"}\n');
    return;
  }
  if (scenario.mode === 'checkpoints') {
    process.stderr.write('ordinary log\n\n{broken\n{"message":"structured log"}\n');
    for (const phase of phases) {
      process.stderr.write(`${JSON.stringify({ phase, detail: `reached ${phase}`, ignored: 'discard me' })}\n`);
    }
    process.stderr.write('{"phase":"unknown"}\n{"phase":"tested","detail":42}\n');
  }
  finish(scenario.result);
  process.exitCode = scenario.exitCode ?? 0;
}
