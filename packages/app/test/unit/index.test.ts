import { describe, expect, it } from 'vitest';
import * as entry from '../../src/index.ts';

describe('@snapwing/app', () => {
  it('loads its entry point', () => {
    expect(entry).toBeDefined();
  });
});
