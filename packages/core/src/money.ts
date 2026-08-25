/**
 * Money. All amounts in Mercury are integer paise. There are no floats.
 *
 * Razorpay denominates in paise natively (Rs 299.00 -> 29900), so this is not a
 * translation layer -- it is the same unit the rail speaks.
 */

/** An integer number of paise. Construct only via {@link paise}. */
export type Paise = number & { readonly __paise: true };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Construct a Paise value. Throws on non-integer, non-finite, or negative input. */
export function paise(n: number): Paise {
  if (!Number.isFinite(n)) throw new MoneyError(`paise: not finite: ${n}`);
  if (!Number.isInteger(n)) throw new MoneyError(`paise: not an integer: ${n}`);
  if (n < 0) throw new MoneyError(`paise: negative: ${n}`);
  if (n > Number.MAX_SAFE_INTEGER) throw new MoneyError(`paise: exceeds MAX_SAFE_INTEGER: ${n}`);
  return n as Paise;
}

/** Convenience for seed data and tests. `rupees(299)` -> 29900 paise. */
export function rupees(n: number): Paise {
  if (!Number.isFinite(n)) throw new MoneyError(`rupees: not finite: ${n}`);
  const p = Math.round(n * 100);
  if (Math.abs(n * 100 - p) > 1e-6) {
    throw new MoneyError(`rupees: ${n} is not a whole number of paise`);
  }
  return paise(p);
}

export const ZERO: Paise = paise(0);

export function addP(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subP(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

/** Multiply by a non-negative integer quantity. */
export function mulP(a: Paise, qty: number): Paise {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new MoneyError(`mulP: quantity must be a non-negative integer: ${qty}`);
  }
  return paise(a * qty);
}

export function sumP(xs: readonly Paise[]): Paise {
  let acc = 0;
  for (const x of xs) acc += x;
  return paise(acc);
}

export function maxP(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

export function minP(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

/**
 * Apply a basis-point rate, rounding UP.
 *
 * Used for margin floors: rounding up always favours the merchant, so a floor
 * can never be undershot by a rounding artefact.
 */
export function applyBpsCeil(amount: Paise, bps: number): Paise {
  assertBps(bps);
  return paise(Math.ceil((amount * (10_000 + bps)) / 10_000));
}

/**
 * Compute a discount of `bps` basis points off `amount`, rounding the DISCOUNT
 * down. Rounding the discount down favours the merchant for the same reason.
 */
export function discountBpsFloor(amount: Paise, bps: number): Paise {
  assertBps(bps);
  return paise(Math.floor((amount * bps) / 10_000));
}

/** How many basis points below `from` is `to`? Rounds down. Returns 0 if to >= from. */
export function bpsBelow(from: Paise, to: Paise): number {
  if (from <= 0) return 0;
  if (to >= from) return 0;
  return Math.floor(((from - to) * 10_000) / from);
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 1_000_000) {
    throw new MoneyError(`bps must be an integer in [0, 1000000]: ${bps}`);
  }
}

/**
 * Divide an amount across weights without losing or inventing a paisa.
 *
 * Split settlement is where rounding stops being cosmetic: three suppliers
 * paid `floor(share)` each leaves the platform holding a remainder it never
 * earned, and `round` can hand out more than was captured. Largest remainder
 * distributes the leftover deterministically, and the result is guaranteed to
 * sum to exactly `total` -- which is the only property a settlement needs.
 *
 * Ties go to the earlier weight, so the same cart always splits the same way.
 */
export function splitByWeight(total: Paise, weights: readonly number[]): Paise[] {
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new MoneyError(`splitByWeight: bad weight: ${w}`);
  }
  if (weights.length === 0) return [];

  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // No weight anywhere: everything goes to the first share rather than
    // vanishing. A zero-sum split that returns zeros would silently lose money.
    return weights.map((_, i) => paise(i === 0 ? total : 0));
  }

  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac === a.frac ? a.i - b.i : b.frac - a.frac));

  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    remainder -= 1;
  }
  return out.map((n) => paise(n));
}

/** Take `bps` of an amount, rounded down. The payer keeps the remainder. */
export function bpsOf(amount: Paise, bps: number): Paise {
  assertBps(bps);
  return paise(Math.floor((amount * bps) / 10_000));
}

/** Display only. Never use the result for arithmetic. */
export function formatINR(p: Paise): string {
  const sign = p < 0 ? "-" : "";
  const abs = Math.abs(p);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}Rs ${whole.toLocaleString("en-IN")}.${frac}`;
}
