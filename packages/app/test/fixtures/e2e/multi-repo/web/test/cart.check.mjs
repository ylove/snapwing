import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, cartTotal } from '../src/cart.mjs';
import { priceLabel, totalLabel } from '../src/storefront.mjs';

const usd = { currency: 'USD', lines: [{ sku: 'a', unitPriceCents: 1000, quantity: 2 }] };

test('sums line totals', () => {
  assert.equal(cartTotal({ currency: 'USD', lines: [{ sku: 'a', unitPriceCents: 250, quantity: 2 }, { sku: 'b', unitPriceCents: 100, quantity: 1 }] }), 600);
});

test('takes 10 percent off a 20.00 subtotal', () => {
  assert.equal(applyDiscount(2000, 10), 1800);
});

test('takes a discount off the cart total', () => {
  assert.equal(cartTotal({ ...usd, discountPercent: 25 }), 1500);
});

test('shows a dollar cart through shared-ui', () => {
  assert.equal(priceLabel(usd, 1800), '$18.00');
  assert.equal(totalLabel(usd), 'Total $20.00');
});
