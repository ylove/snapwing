// Puts the commit package.json pins for @fixture/shared-ui into node_modules, from the local repository
// the pin names. Offline: git clones a path, nothing touches a registry. A pin that has not changed
// since the last run is left alone.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@fixture/shared-ui'];
const match = /^git\+file:\/\/(.+)#([0-9a-f]{40})$/.exec(spec);
if (match === null) throw new Error(`@fixture/shared-ui must be pinned as git+file://<repository>#<40 hex commit>, not ${spec}`);
const [, url, sha] = match;

const dest = join(root, 'node_modules', '@fixture', 'shared-ui');
const stamp = join(dest, '.pinned-commit');
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === sha) process.exit(0);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
git(['clone', '--quiet', '--no-checkout', url, dest], root);
git(['checkout', '--quiet', sha], dest);
rmSync(join(dest, '.git'), { recursive: true, force: true });
writeFileSync(stamp, sha);
