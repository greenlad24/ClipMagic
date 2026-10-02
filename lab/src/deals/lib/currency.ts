/**
 * Money display in the deal's own currency (the original always printed "$").
 */

export function currencySymbol(code: string | null | undefined): string {
  const c = (code || 'USD').toUpperCase();
  try {
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    return parts.find(p => p.type === 'currency')?.value ?? c;
  } catch {
    return c; // unknown / malformed code: show the code itself
  }
}

/** "$12,500", "€900", "¥150,000" — falls back to "12,500 XYZ" for unknown codes. */
export function formatMoney(value: number, code: string | null | undefined): string {
  const c = (code || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: c, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value.toLocaleString()} ${c}`;
  }
}
