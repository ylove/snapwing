import { describe, expect, it } from 'vitest';
import * as entry from '../../src/index.ts';

describe('@snapwing/capture-client', () => {
  it('loads its entry point', () => {
    expect(entry).toBeDefined();
  });
});
