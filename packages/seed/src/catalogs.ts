import { type CatalogItem, type MerchantProfile, rupees } from "@mercury/core";

/**
 * Two verticals, one gate.
 *
 * Everything that differs between B2C quick-commerce and B2B procurement lives
 * in this file and in prompts/. Dwaar, Sakshi, the rail and the engine are
 * identical for both -- which is the architectural claim the demo makes.
 */

/* ------------------------------------------------- B2C quick-commerce ------ */

export const QUICK_COMMERCE: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Nukkad Quick",
  vertical: "quick_commerce",
  // Thin retail margins: 15% over landed cost is the floor.
  min_margin_bps: 1_500,
  // Never more than 20% off list, whatever the agent negotiates.
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples", "beverages", "snacks", "household"],
};

export const QUICK_COMMERCE_ITEMS: CatalogItem[] = [
  item("QC_RICE_5KG", "Sona Masoori Rice 5kg", "staples", "bag", 600, 400, 40),
  item("QC_ATTA_10KG", "Whole Wheat Atta 10kg", "staples", "bag", 520, 380, 25),
  item("QC_OIL_1L", "Sunflower Oil 1L", "staples", "bottle", 180, 120, 8),
  item("QC_DAL_1KG", "Toor Dal 1kg", "staples", "pack", 190, 140, 60),
  item("QC_TEA_250G", "Assam Tea 250g", "beverages", "pack", 250, 150, 100),
  item("QC_COFFEE_200G", "Filter Coffee 200g", "beverages", "pack", 340, 230, 30),
  item("QC_BISCUIT_PK", "Marie Biscuits (pack of 6)", "snacks", "pack", 150, 95, 80),
  item("QC_SOAP_4PK", "Bathing Soap 4-pack", "household", "pack", 220, 150, 45),
  // Deliberately scarce: this is the SKU the F3 inventory race contends over.
  item("QC_GHEE_1L", "Pure Cow Ghee 1L", "staples", "tin", 900, 700, 1),
];

/* ------------------------------------------------- B2B SME procurement ----- */

export const B2B_PROCUREMENT: MerchantProfile = {
  merchant_id: "mch_bulk",
  display_name: "Annapurna Wholesale",
  vertical: "b2b_procurement",
  // Wholesale runs thinner but sells volume: 8% floor.
  min_margin_bps: 800,
  // Bulk buyers can negotiate harder: up to 35% off list.
  max_discount_bps: 3_500,
  levers: ["bulk_tier", "credit_terms", "substitute"],
  category_taxonomy: ["staples", "beverages", "packaging"],
};

export const B2B_ITEMS: CatalogItem[] = [
  item("WS_RICE_25KG", "Sona Masoori Rice 25kg", "staples", "sack", 2_800, 2_200, 200, 4),
  item("WS_ATTA_50KG", "Whole Wheat Atta 50kg", "staples", "sack", 2_400, 1_950, 120, 2),
  item("WS_OIL_15L", "Sunflower Oil 15L tin", "staples", "tin", 2_250, 1_800, 60, 2),
  item("WS_DAL_30KG", "Toor Dal 30kg", "staples", "sack", 5_100, 4_200, 40, 2),
  item("WS_TEA_5KG", "Assam Tea 5kg", "beverages", "carton", 4_200, 3_400, 25, 1),
  item("WS_CUPS_1000", "Paper Cups (1000 ct)", "packaging", "carton", 1_600, 1_250, 90, 5),
  item("WS_FOIL_10", "Aluminium Foil 10-roll", "packaging", "carton", 1_150, 900, 35, 2),
];

/* ---------------------------------------------------------------- helper --- */

function item(
  sku: string,
  title: string,
  category: string,
  unit: string,
  listRupees: number,
  costRupees: number,
  stock: number,
  moq = 1,
): CatalogItem {
  return {
    sku,
    merchant_id: sku.startsWith("WS_") ? "mch_bulk" : "mch_quick",
    title,
    category,
    unit,
    list_paise: rupees(listRupees),
    cost_paise: rupees(costRupees),
    stock,
    moq,
  };
}

export const ALL_MERCHANTS = [QUICK_COMMERCE, B2B_PROCUREMENT];
export const ALL_ITEMS = [...QUICK_COMMERCE_ITEMS, ...B2B_ITEMS];
