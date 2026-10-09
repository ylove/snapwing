// The Slack redirect listener binds the loopback address only (#274): the public address reaches it
// through the tunnel, and nothing else on the network should.

import { createServer, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { listenForRedirect } from '../../src/onboard/slack/install.ts';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address;

function reaches(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('listenForRedirect', () => {
  it('answers on 127.0.0.1', async () => {
    const port = await freePort();
    const listener = await listenForRedirect(port, 'state');
    try {
      expect(listener).toBeDefined();
      expect(await reaches('127.0.0.1', port)).toBe(true);
    } finally {
      listener?.close();
    }
  });

  it.skipIf(lan === undefined)('does not answer on a non-loopback address', async () => {
    const port = await freePort();
    const listener = await listenForRedirect(port, 'state');
    try {
      expect(await reaches(lan as string, port)).toBe(false);
    } finally {
      listener?.close();
    }
  });
});
