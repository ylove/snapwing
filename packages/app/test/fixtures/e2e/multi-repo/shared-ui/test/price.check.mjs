import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/index.mjs';

test('formats cents with two decimals', () => {
  assert.equal(formatPrice(1800), '$18.00');
});

test('formats zero', () => {
  assert.equal(formatPrice(0), '$0.00');
});
