// Seeded gap: there is no currency, so every price is shown in dollars.

/** A price in integer cents as text, for example `$18.00`. */
export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
