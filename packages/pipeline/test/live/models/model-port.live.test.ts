import { describe } from 'vitest';
import { modelPortContract } from '../../contract/models/model-port-suite.ts';
import { keys, port, providers } from '../../contract/models/providers.ts';
import { whitePng } from './images.ts';

// Vision sends a 64x64 PNG: the Anthropic API refuses the contract suite's 1x1 image (#281).

for (const provider of providers) {
  describe.skipIf(!process.env[keys[provider]])(`${provider} ModelPort live`, () => {
    modelPortContract({ live: true, visionImage: whitePng(), create: () => port(provider, process.env[keys[provider]] ?? '') });
  });
}
