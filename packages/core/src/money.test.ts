import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MoneyError,
  applyBpsCeil,
  bpsBelow,
  bpsOf,
  discountBpsFloor,
  formatINR,
  mulP,
  paise,
  rupees,
  splitByWeight,
  subP,
  sumP,
} from "./money.js";

describe("paise", () => {
  it("accepts non-negative integers", () => {
    expect(paise(0)).toBe(0);
    expect(paise(29900)).toBe(29900);
  });

  it("rejects floats -- the whole point of the branded type", () => {
    expect(() => paise(1.5)).toThrow(MoneyError);
    expect(() => paise(0.1 + 0.2)).toThrow(MoneyError);
  });

  it("rejects negatives, NaN and Infinity", () => {
    expect(() => paise(-1)).toThrow(MoneyError);
    expect(() => paise(Number.NaN)).toThrow(MoneyError);
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("rupees", () => {
  it("converts whole and two-decimal rupees", () => {
    expect(rupees(299)).toBe(29900);
    expect(rupees(0.5)).toBe(50);
    expect(rupees(1234.56)).toBe(123456);
  });

  it("rejects sub-paise precision", () => {
    expect(() => rupees(1.234)).toThrow(MoneyError);
  });
});

describe("arithmetic", () => {
  it("subP throws rather than going negative", () => {
    expect(() => subP(paise(100), paise(101))).toThrow(MoneyError);
  });

  it("mulP rejects fractional quantities", () => {
    expect(() => mulP(paise(100), 1.5)).toThrow(MoneyError);
  });

  it("sumP of an empty list is zero", () => {
    expect(sumP([])).toBe(0);
  });
});

describe("applyBpsCeil -- margin floors round UP, always favouring the merchant", () => {
  it("never returns less than the input", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 50_000 }), (amt, bps) => {
        const floor = applyBpsCeil(paise(amt), bps);
        return floor >= amt;
      }),
    );
  });

  it("rounds up, never down", () => {
    // 333 paise at 1 bp = 333.0333 -> 334
    expect(applyBpsCeil(paise(333), 1)).toBe(334);
    // exact multiples do not gain a spurious paisa
    expect(applyBpsCeil(paise(10_000), 1_000)).toBe(11_000);
  });

  it("0 bps is identity", () => {
    expect(applyBpsCeil(paise(12345), 0)).toBe(12345);
  });
});

describe("discountBpsFloor -- discounts round DOWN, also favouring the merchant", () => {
  it("never exceeds the naive discount", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000 }), (amt, bps) => {
        const d = discountBpsFloor(paise(amt), bps);
        return d <= (amt * bps) / 10_000 && d >= 0;
      }),
    );
  });
});

describe("bpsBelow", () => {
  it("measures how far a price sits under list", () => {
    expect(bpsBelow(paise(10_000), paise(9_000))).toBe(1_000); // 10% = 1000bps
    expect(bpsBelow(paise(10_000), paise(10_000))).toBe(0);
    expect(bpsBelow(paise(10_000), paise(11_000))).toBe(0); // above list is not a discount
  });

  it("never applies MORE discount than requested (merchant-favouring, always)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 0, max: 9_000 }), (list, bps) => {
        const discounted = paise(list - discountBpsFloor(paise(list), bps));
        return bpsBelow(paise(list), discounted) <= bps;
      }),
    );
  });

  it("is exact to within one bp once a 1-bp step is worth at least a paisa", () => {
    // Below ~10000 paise a single basis point rounds away to nothing, so the
    // measured discount is legitimately 0. That is the floor doing its job.
    fc.assert(
      fc.property(fc.integer({ min: 10_000, max: 10_000_000 }), fc.integer({ min: 0, max: 9_000 }), (list, bps) => {
        const discounted = paise(list - discountBpsFloor(paise(list), bps));
        return Math.abs(bpsBelow(paise(list), discounted) - bps) <= 1;
      }),
    );
  });
});

describe("formatINR", () => {
  it("renders paise as rupees with Indian grouping", () => {
    expect(formatINR(paise(0))).toBe("Rs 0.00");
    expect(formatINR(paise(29900))).toBe("Rs 299.00");
    expect(formatINR(paise(5))).toBe("Rs 0.05");
    expect(formatINR(paise(10_000_000))).toBe("Rs 1,00,000.00");
  });
});

/* ------------------------------------------------------- split settlement */

describe("splitByWeight", () => {
  it("divides in proportion to the weights", () => {
    expect(splitByWeight(paise(1_000), [1, 1])).toEqual([500, 500]);
    expect(splitByWeight(paise(900), [2, 1])).toEqual([600, 300]);
  });

  it("never loses or invents a paisa", () => {
    // 100 / 3 is the classic case: 33.33 each, and one paisa has to land
    // somewhere. Largest remainder puts it on the first share, deterministically.
    expect(splitByWeight(paise(100), [1, 1, 1])).toEqual([34, 33, 33]);
    expect(sumP(splitByWeight(paise(100), [1, 1, 1]))).toBe(100);
  });

  it("gives everything to the first share when no weight has any weight", () => {
    expect(splitByWeight(paise(500), [0, 0])).toEqual([500, 0]);
  });

  it("returns nothing for no shares", () => {
    expect(splitByWeight(paise(500), [])).toEqual([]);
  });

  it("rejects a negative weight", () => {
    expect(() => splitByWeight(paise(100), [1, -1])).toThrow(MoneyError);
  });

  it("PROPERTY: the split always sums to exactly the total", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const parts = splitByWeight(paise(total), weights);
          expect(parts).toHaveLength(weights.length);
          expect(parts.every((p) => p >= 0)).toBe(true);
          expect(sumP(parts)).toBe(total);
        },
      ),
    );
  });
});

describe("bpsOf", () => {
  it("rounds the fee down, so the payer keeps the fraction", () => {
    expect(bpsOf(paise(10_001), 200)).toBe(200);
    expect(bpsOf(paise(100_000), 250)).toBe(2_500);
    expect(bpsOf(paise(999), 0)).toBe(0);
  });
});
