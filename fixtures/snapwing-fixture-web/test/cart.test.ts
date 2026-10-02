import { describe, expect, it } from 'vitest';
import { applyDiscount, cartTotal } from '../src/cart.ts';
import { formatCents } from '../src/format.ts';

describe('cart', () => {
  it('sums line totals', () => {
    expect(
      cartTotal([
        { sku: 'a', unitPriceCents: 250, quantity: 2 },
        { sku: 'b', unitPriceCents: 100, quantity: 1 },
      ]),
    ).toBe(600);
  });

  it('takes 10 percent off a 20.00 subtotal', () => {
    expect(applyDiscount(2000, 10)).toBe(1800);
  });

  it('takes a discount off the cart total', () => {
    expect(cartTotal([{ sku: 'a', unitPriceCents: 1000, quantity: 2 }], 25)).toBe(1500);
  });

  it('formats cents as dollars', () => {
    expect(formatCents(1800)).toBe('$18.00');
  });
});
