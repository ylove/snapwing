// infra/docker/fixer/relay.ts: the relay container's entrypoint (#273). The docker runner starts it as
// `snapwing-relay` from the fixer image, on a network that reaches the server and the internet, and
// connects it to the containers' internal network as `snapwing-api`. Fixer and review containers can
// reach nothing else: the internal network has no route out, so no host address, no cloud metadata
// service, and nothing on the internet but what the relay passes on. It holds no credential.
//
//   :8080  the server: only the fixer API (`/fixer/...`) and the model proxy (`/model/...`), forwarded to
//          `SNAPWING_RELAY_UPSTREAM` with headers as sent; everything else is 404 (forward.ts).
//   :3128  package registries: an HTTP CONNECT proxy to port 443 of the hosts in
//          `SNAPWING_RELAY_EGRESS_ALLOW` (comma-separated, each exact or `*.<suffix>`), checked against
//          the addresses they resolve to (egress.ts). Not started when the list is empty.

import { startEgressProxy } from './egress.ts';
import { startForwarder } from './forward.ts';

const RELAY_PORT = Number(process.env['SNAPWING_RELAY_PORT'] ?? 8080);
const EGRESS_PORT = Number(process.env['SNAPWING_RELAY_EGRESS_PORT'] ?? 3128);
const ALLOWED = /^\/(fixer|model)\/[^/]/;
const log = (line: string): void => void process.stderr.write(`snapwing-relay: ${line}\n`);

const upstream = process.env['SNAPWING_RELAY_UPSTREAM'] ?? '';
const allow = (process.env['SNAPWING_RELAY_EGRESS_ALLOW'] ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter((h) => h !== '');
const relay = await startForwarder({ upstream, host: '0.0.0.0', port: RELAY_PORT, allow: (path) => ALLOWED.test(path), headers: (h) => h });
const egress = allow.length === 0 ? undefined : await startEgressProxy({ host: '0.0.0.0', port: EGRESS_PORT, allow, log });
log(`listening on ${String(RELAY_PORT)}${egress === undefined ? ', no egress' : `, egress on ${String(EGRESS_PORT)} for ${String(allow.length)} hosts`}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void Promise.all([relay.close(), egress?.close()]).then(() => process.exit(0)));
}
