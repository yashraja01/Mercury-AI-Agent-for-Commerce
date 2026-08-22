import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MoneyError,
  applyBpsCeil,
  bpsBelow,
  discountBpsFloor,
  formatINR,
  mulP,
  paise,
  rupees,
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
