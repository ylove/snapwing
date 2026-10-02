// infra/docker/fixer/entrypoint.ts: the fixer image's entrypoint (run under tini, so signals reach it
// and orphaned processes are reaped). It works from `/`, outside the mount, so the adapters' check that
// a harness never runs in the wrapper's own working directory holds, and turns SIGTERM (`docker stop`)
// into the run's stop. Everything else is `runWrapper` (wrapper.ts).

import { runWrapper } from './wrapper.ts';

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => stop.abort());
process.chdir('/');

// A snapshot to read the job from; the live environment loses its model variables and the fixer
// token before any harness starts.
const code = await runWrapper({ env: { ...process.env }, processEnv: process.env, signal: stop.signal });
process.exit(code);
