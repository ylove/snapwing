// Cart totals for the fixture storefront. Prices are integer cents.

export interface CartLine {
  sku: string;
  unitPriceCents: number;
  quantity: number;
}

/** Percentage discount (0 to 100) applied to a subtotal in cents, rounded to the nearest cent. */
export function applyDiscount(subtotalCents: number, percent: number): number {
  // Seeded bug: the percent is divided by 1000, so a 10% discount takes off 1%.
  return Math.round(subtotalCents - subtotalCents * (percent / 1000));
}

export function subtotal(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
}

export function cartTotal(lines: readonly CartLine[], discountPercent = 0): number {
  return applyDiscount(subtotal(lines), discountPercent);
}
