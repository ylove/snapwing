import { describe, expect, it } from 'vitest';
import * as entry from '../../src/index.ts';

describe('@snapwing/pipeline', () => {
  it('loads its entry point', () => {
    expect(entry).toBeDefined();
  });
});
