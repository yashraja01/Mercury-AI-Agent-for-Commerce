/**
 * Display helpers.
 *
 * Deliberately local to the web app rather than imported from `@mercury/core`:
 * that package reaches for `node:crypto`, and nothing that formats a number for
 * a browser should be able to drag the signing code into a client bundle.
 *
 * These format money. They never do arithmetic on it.
 */

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
});

export function rupees(p: number): string {
  return INR.format(p / 100);
}

/** Paise, grouped, for when the exact integer matters more than the rupee value. */
export function paiseExact(p: number): string {
  return `${new Intl.NumberFormat("en-IN").format(p)} paise`;
}

/**
 * Basis points as a percentage. `1500` -> `15%`, `1825` -> `18.25%`.
 *
 * Trailing zeros are trimmed because a margin floor of exactly 15% should read
 * as "15%", not "15.00%" — the extra digits imply a precision the merchant did
 * not set. Pass `sign` for a figure that is meaningfully positive or negative,
 * like an uplift.
 */
export function bps(n: number, opts?: { sign?: boolean }): string {
  const pct = n / 100;
  const body = `${Number(pct.toFixed(2))}%`;
  return opts?.sign === true && n > 0 ? `+${body}` : body;
}

export function shortHash(h: string, n = 10): string {
  return h.slice(0, n);
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "--:--:--"
    : d.toLocaleTimeString("en-GB", { hour12: false });
}
