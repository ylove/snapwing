// infra/docker/fixer/relay.ts: the relay container's entrypoint (#273). The docker runner starts it as
// `snapwing-relay` from the fixer image, on a network that reaches the server, and connects it to the
// containers' internal network as `snapwing-api`. Fixer and review containers can reach nothing else:
// the internal network has no route out, so no host address, no cloud metadata service, and no package
// registry. The relay forwards only the fixer API (`/fixer/...`) and the model proxy (`/model/...`) to
// `SNAPWING_RELAY_UPSTREAM`, headers as sent; everything else is 404. It holds no credential.

import { startForwarder } from './forward.ts';

const RELAY_PORT = Number(process.env['SNAPWING_RELAY_PORT'] ?? 8080);
const ALLOWED = /^\/(fixer|model)\/[^/]/;

const upstream = process.env['SNAPWING_RELAY_UPSTREAM'] ?? '';
const relay = await startForwarder({ upstream, host: '0.0.0.0', port: RELAY_PORT, allow: (path) => ALLOWED.test(path), headers: (h) => h });
process.stderr.write(`snapwing-relay: listening on ${String(RELAY_PORT)}\n`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void relay.close().then(() => process.exit(0)));
