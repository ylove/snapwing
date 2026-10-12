import { formatPrice } from '@fixture/shared-ui';
import { cartTotal } from './cart.mjs';

// Seeded bug: the cart's currency is never passed on, so a euro cart shows its prices with a dollar sign.

/** @param {import('./cart.mjs').Cart} cart */
export function priceLabel(cart, cents) {
  return formatPrice(cents);
}

/** @param {import('./cart.mjs').Cart} cart */
export function totalLabel(cart) {
  return `Total ${priceLabel(cart, cartTotal(cart))}`;
}
