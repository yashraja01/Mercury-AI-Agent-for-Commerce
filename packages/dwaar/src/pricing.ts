import {
  type CartLine,
  type CatalogItem,
  type MerchantProfile,
  type Paise,
  applyBpsCeil,
  bpsBelow,
  mulP,
  paise,
  sumP,
} from "@mercury/core";

/**
 * The margin floor for one SKU: the lowest unit price the merchant will accept.
 *
 *   floor = ceil( cost * (1 + min_margin_bps / 10000) )
 *
 * Rounding up means a floor can never be undershot by a rounding artefact.
 */
export function marginFloor(item: CatalogItem, profile: MerchantProfile): Paise {
  return applyBpsCeil(item.cost_paise, profile.min_margin_bps);
}

/** How many basis points below list a given offer sits. */
export function discountBps(item: CatalogItem, offerUnit: Paise): number {
  return bpsBelow(item.list_paise, offerUnit);
}

/**
 * The lowest unit price that satisfies BOTH the margin floor and the discount
 * ceiling. This is what auto-repair clamps a below-floor offer up to.
 */
export function lowestLegalUnit(item: CatalogItem, profile: MerchantProfile): Paise {
  const floor = marginFloor(item, profile);
  // Largest discount the merchant allows, expressed as a price.
  const discountLimited = paise(
    item.list_paise - Math.floor((item.list_paise * profile.max_discount_bps) / 10_000),
  );
  return floor >= discountLimited ? floor : discountLimited;
}

export interface PricedLineInput {
  item: CatalogItem;
  qty: number;
  unit: Paise;
}

/** Build a cart line. Pure arithmetic -- no policy decisions here. */
export function buildLine(input: PricedLineInput): CartLine {
  return {
    sku: input.item.sku,
    qty: input.qty,
    unit_paise: input.unit,
    list_paise: input.item.list_paise,
    line_total_paise: mulP(input.unit, input.qty),
  };
}

export interface CartTotals {
  subtotal_paise: Paise;
  discount_paise: Paise;
  total_paise: Paise;
}

/**
 * Total a set of lines.
 *
 * `subtotal` is what the cart would cost at list price; `total` is what it costs
 * at the negotiated price; `discount` is the difference. This is the arithmetic
 * that overrides whatever the model claimed the total was.
 */
export function totalLines(lines: readonly CartLine[]): CartTotals {
  const subtotal = sumP(lines.map((l) => mulP(l.list_paise, l.qty)));
  const total = sumP(lines.map((l) => l.line_total_paise));
  // An agent may legitimately price ABOVE list (a bundle premium, a rush fee),
  // in which case there is simply no discount. Clamping at zero keeps
  // discount_paise a non-negative Paise and stops a premium from crashing the
  // gate -- a gate that throws is strictly worse than a gate that denies.
  return {
    subtotal_paise: subtotal,
    discount_paise: paise(Math.max(0, subtotal - total)),
    total_paise: total,
  };
}
