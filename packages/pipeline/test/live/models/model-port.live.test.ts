import { describe } from 'vitest';
import { modelPortContract } from '../../contract/models/model-port-suite.ts';
import { keys, port, providers } from '../../contract/models/providers.ts';

for (const provider of providers) {
  describe.skipIf(!process.env[keys[provider]])(`${provider} ModelPort live`, () => {
    modelPortContract({ live: true, create: () => port(provider, process.env[keys[provider]] ?? '') });
  });
}
