// Child process for cli-lazy.test.ts: runs the CLI's `main` the way bin/snapwing.mjs does, with a
// resolve hook that appends every resolved URL to the file named by SNAPWING_RESOLVE_LOG.

import process from 'node:process';
import { register as registerHooks } from 'node:module';
import { register } from 'tsx/esm/api';

register({ tsconfig: false });

const hooks = `
import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  appendFileSync(process.env.SNAPWING_RESOLVE_LOG, result.url + '\\n');
  return result;
}
`;
registerHooks(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

const { main } = await import('../../../src/cli/main.ts');
process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: () => {},
  stderr: () => {},
});
