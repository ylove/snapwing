// Cart totals for the multi-repo fixture storefront. Prices are integer cents; a cart has a currency.

/** @typedef {{ sku: string, unitPriceCents: number, quantity: number }} CartLine */
/** @typedef {{ currency: string, lines: CartLine[], discountPercent?: number }} Cart */

/** Percentage discount (0 to 100) applied to a subtotal in cents, rounded to the nearest cent. */
export function applyDiscount(subtotalCents, percent) {
  return Math.round(subtotalCents - subtotalCents * (percent / 100));
}

/** @param {CartLine[]} lines */
export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
}

/** @param {Cart} cart */
export function cartTotal(cart) {
  return applyDiscount(subtotal(cart.lines), cart.discountPercent ?? 0);
}
