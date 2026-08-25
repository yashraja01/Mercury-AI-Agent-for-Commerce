import { z } from "zod";
import type { Paise } from "./money.js";

/** Zod schema for a Paise value: a non-negative safe integer. */
export const zPaise = z
  .number()
  .int("amount must be an integer number of paise")
  .nonnegative("amount must not be negative")
  .max(Number.MAX_SAFE_INTEGER)
  .transform((n) => n as Paise);

const zBps = z.number().int().min(0).max(1_000_000);
const zIso = z.string().datetime({ offset: true });

/* ------------------------------------------------------------------ verticals */

export const VERTICALS = ["quick_commerce", "b2b_procurement"] as const;
export const zVertical = z.enum(VERTICALS);
export type Vertical = z.infer<typeof zVertical>;

/* ------------------------------------------------------- merchant + catalogue */

export const LEVERS = ["bundle", "substitute", "bulk_tier", "credit_terms"] as const;
export const zLever = z.enum(LEVERS);
export type Lever = z.infer<typeof zLever>;

/**
 * The only per-vertical policy input Dwaar reads. If a vertical needs behaviour
 * Dwaar does not have, add a field here -- never a branch inside Dwaar.
 */
/**
 * Split settlement configuration -- Razorpay Route, in Mercury's terms.
 *
 * A B2B basket is frequently multi-vendor: the buyer sees one cart and one
 * payment, and several suppliers have to be paid out of it. The platform's own
 * cut is a commission in bps, taken before the suppliers are paid, so a
 * supplier's share is never quietly reduced by a fee it did not agree to.
 */
export const zSettlement = z.object({
  mode: z.literal("route"),
  /** Platform commission, taken off the top. */
  commission_bps: zBps,
  /** Where the commission lands. */
  commission_account_id: z.string().min(1),
});
export type Settlement = z.infer<typeof zSettlement>;

export const zMerchantProfile = z.object({
  merchant_id: z.string().min(1),
  display_name: z.string().min(1),
  vertical: zVertical,
  /** Margin floor. Price may never fall below cost * (1 + min_margin_bps/10000). */
  min_margin_bps: zBps,
  /** Discount ceiling, measured against list price. */
  max_discount_bps: zBps,
  levers: z.array(zLever),
  category_taxonomy: z.array(z.string().min(1)),
  /**
   * Split settlement, for verticals where the money does not all belong to one
   * party (Razorpay Route). Dwaar never reads this: how a captured rupee is
   * divided afterwards is not an authorisation question, and putting it in
   * front of the gate would be a category error.
   */
  settlement: zSettlement.optional(),
});
export type MerchantProfile = z.infer<typeof zMerchantProfile>;

export const zCatalogItem = z.object({
  sku: z.string().min(1),
  merchant_id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  gtin: z.string().optional(),
  unit: z.string().min(1),
  /** List price per unit. */
  list_paise: zPaise,
  /** Landed cost per unit. Never exposed to the buyer agent. */
  cost_paise: zPaise,
  stock: z.number().int().nonnegative(),
  /** Minimum order quantity (B2B). 1 for consumer goods. */
  moq: z.number().int().positive().default(1),
  /**
   * The Razorpay linked account that gets paid for this line, when the seller
   * is not the merchant itself. Absent for own-inventory goods, which is why
   * quick-commerce settles as a single payment and nothing splits.
   *
   * Never published in the feed: who supplies a merchant is the merchant's
   * business, not the buyer's.
   */
  supplier_account_id: z.string().min(1).optional(),
});
export type CatalogItem = z.infer<typeof zCatalogItem>;

/* -------------------------------------------------------------- ReserveMandate */

/**
 * ReserveMandate -- the human-signed budget envelope.
 *
 * Shaped after the NPCI UPI Reserve Pay primitive (single block, multiple
 * debits, residual auto-release) and the AP2 mandate model. The limits travel
 * inside the artifact so any party can verify them independently of our
 * application logic.
 */
export const zReserveMandate = z.object({
  mandate_id: z.string().min(1),
  principal_id: z.string().min(1),
  agent_id: z.string().min(1),
  /**
   * base64url raw Ed25519 public key of the agent this mandate delegates to.
   *
   * It lives *inside* the signed artifact deliberately: the human is not
   * authorising "an agent", they are authorising exactly this key. A caller
   * proves it holds the mandate by signing a challenge with the matching
   * private key, and that proof is verifiable by anyone holding the mandate --
   * no registry lookup, no shared secret, no trust in our own database.
   */
  agent_public_key: z.string().min(1),
  vertical: zVertical,

  /** Total reserved for the life of the envelope. */
  reserved_paise: zPaise,
  /** Ceiling for any single transaction. */
  max_per_txn_paise: zPaise,
  /** Maximum number of debits against this envelope. */
  max_txn_count: z.number().int().positive(),
  /** Spend at or above this needs a Human-Present step-up. */
  requires_human_approval_above_paise: zPaise,

  scope: z.object({
    merchant_allowlist: z.array(z.string().min(1)).min(1),
    category_allowlist: z.array(z.string().min(1)).min(1),
  }),

  /** AP2 Human-Present / Human-Not-Present signal. */
  human_present: z.boolean(),

  not_before: zIso,
  expires_at: zIso,
  nonce: z.string().min(1),
});
export type ReserveMandate = z.infer<typeof zReserveMandate>;

/** A mandate plus its detached Ed25519 signature and the key that signed it. */
export const zSignedReserveMandate = z.object({
  mandate: zReserveMandate,
  /** base64url detached signature over canonicalJson(mandate). */
  signature: z.string().min(1),
  /** base64url raw Ed25519 public key of the principal. */
  public_key: z.string().min(1),
});
export type SignedReserveMandate = z.infer<typeof zSignedReserveMandate>;

/* ------------------------------------------------------------- cart + pricing */

export const zCartLine = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive(),
  /** Unit price after negotiation. Always computed by Dwaar, never by the LLM. */
  unit_paise: zPaise,
  /** Unit list price, retained so discount can be audited. */
  list_paise: zPaise,
  line_total_paise: zPaise,
});
export type CartLine = z.infer<typeof zCartLine>;

export const zPricedCart = z.object({
  cart_id: z.string().min(1),
  merchant_id: z.string().min(1),
  lines: z.array(zCartLine).min(1),
  subtotal_paise: zPaise,
  discount_paise: zPaise,
  total_paise: zPaise,
});
export type PricedCart = z.infer<typeof zPricedCart>;

/** A priced cart bound to a mandate by hash, signed by Dwaar. */
export const zCartMandate = z.object({
  cart: zPricedCart,
  mandate_id: z.string().min(1),
  /** sha256 of canonicalJson(cart). */
  cart_hash: z.string().length(64),
  issued_at: zIso,
});
export type CartMandate = z.infer<typeof zCartMandate>;

/* --------------------------------------------------------------- intent token */

/**
 * Single-use, TTL-bounded authorisation for exactly one money action.
 * Mirrors the ACP Delegated Payment token: scoped, capped, expiring, and not
 * reusable.
 */
export const zIntentToken = z.object({
  token_id: z.string().min(1),
  mandate_id: z.string().min(1),
  cart_hash: z.string().length(64),
  amount_paise: zPaise,
  nonce: z.string().min(1),
  issued_at: zIso,
  expires_at: zIso,
});
export type IntentToken = z.infer<typeof zIntentToken>;

/* ------------------------------------------------------------- holder proof */

/**
 * Proof that the caller holds the mandate it is spending against.
 *
 * A signed mandate proves the *envelope* is genuine. It does not prove the
 * caller is the agent the envelope was issued to -- without this, a mandate id
 * is a bearer token, and anyone who learns one can spend it.
 *
 * The signature covers the canonical JSON of {mandate_id, nonce, issued_at},
 * made with the private key matching `agent_public_key` in the mandate itself.
 */
export const zHolderProof = z.object({
  mandate_id: z.string().min(1),
  /** Single-use. A replayed nonce is refused even with a valid signature. */
  nonce: z.string().min(8),
  issued_at: zIso,
  /** base64url detached signature over canonicalJson({mandate_id, nonce, issued_at}). */
  signature: z.string().min(1),
});
export type HolderProof = z.infer<typeof zHolderProof>;

/** The bytes a holder proof signs. Kept here so both sides derive it identically. */
export function holderChallenge(proof: {
  mandate_id: string;
  nonce: string;
  issued_at: string;
}): { mandate_id: string; nonce: string; issued_at: string } {
  return { mandate_id: proof.mandate_id, nonce: proof.nonce, issued_at: proof.issued_at };
}

/* -------------------------------------------------------------- agent proposal */

/**
 * What the Revenue Agent proposes. `quoted_total_paise` is what the LLM SAYS the
 * total is -- it is never used to move money. Dwaar recomputes the total from
 * the line items and hard-denies on any mismatch (DRIFT.AMOUNT_MISMATCH).
 */
export const zProposal = z.object({
  merchant_id: z.string().min(1),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        qty: z.number().int().positive(),
        /** Unit price the agent is offering. */
        offer_unit_paise: zPaise,
      }),
    )
    .min(1),
  /** The arithmetic the agent did itself. Checked, then discarded. */
  quoted_total_paise: zPaise,
  rationale: z.string().max(2000),
});
export type Proposal = z.infer<typeof zProposal>;

/* ------------------------------------------------------------------ decisions */

export const RULE_IDS = [
  /** Merchant pulled the global kill switch. Checked first, always. */
  "CIRCUIT.FROZEN",
  /** Mandate signature does not verify against the registered principal key. */
  "MANDATE.SIGNATURE",
  /** now is outside [not_before, expires_at]. */
  "MANDATE.EXPIRY",
  "MANDATE.PER_TXN_CAP",
  "MANDATE.ENVELOPE_REMAINING",
  "MANDATE.VELOCITY",
  "SCOPE.MERCHANT_ALLOWLIST",
  "SCOPE.CATEGORY_ALLOWLIST",
  /** Proposal references a SKU the merchant does not sell. */
  "CATALOG.UNKNOWN_SKU",
  /** Quantity below the SKU minimum order quantity (B2B). */
  "CATALOG.BELOW_MOQ",
  "INVENTORY.INSUFFICIENT",
  /** Offered unit price below cost * (1 + min_margin_bps). */
  "MARGIN.FLOOR_BREACH",
  /** Discount off list exceeds the merchant ceiling. */
  "DISCOUNT.BPS_CAP",
  /** The amount the LLM quoted differs from the amount Dwaar computed. */
  "DRIFT.AMOUNT_MISMATCH",
  /** Intent token already spent. */
  "TOKEN.REPLAY",
  /** Caller did not prove it holds the mandate it is spending. */
  "HOLDER.PROOF_MISSING",
  /** Proof does not verify against the agent key named in the signed mandate. */
  "HOLDER.SIGNATURE",
  /** Proof nonce has been used before. */
  "HOLDER.NONCE_REPLAY",
  /** Proof timestamp is outside the accepted clock skew. */
  "HOLDER.STALE",
] as const;
export const zRuleId = z.enum(RULE_IDS);
export type RuleId = z.infer<typeof zRuleId>;

export const zRuleEval = z.object({
  rule_id: zRuleId,
  passed: z.boolean(),
  /** Observed value, in paise or basis points depending on the rule. */
  observed: z.number(),
  /** The limit the observation was tested against. */
  limit: z.number(),
  /** Deterministic template text. Never generated by a model. */
  message: z.string(),
});
export type RuleEval = z.infer<typeof zRuleEval>;

export const STEP_UP_REASONS = [
  "ABOVE_HUMAN_APPROVAL_THRESHOLD",
  "HUMAN_NOT_PRESENT_HIGH_VALUE",
] as const;
export const zStepUpReason = z.enum(STEP_UP_REASONS);
export type StepUpReason = z.infer<typeof zStepUpReason>;

export type Decision =
  | { outcome: "ALLOW"; rules: RuleEval[]; computed_paise: Paise; cart: PricedCart }
  | {
      outcome: "ALLOW_WITH_STEPUP";
      rules: RuleEval[];
      computed_paise: Paise;
      cart: PricedCart;
      step_up: StepUpReason;
    }
  | { outcome: "DENY"; rules: RuleEval[]; violation: RuleEval };

export type DecisionOutcome = Decision["outcome"];

/* ---------------------------------------------------------------- environment */

export const zEnv = z.object({
  RAIL_MODE: z.enum(["fixture", "live"]).default("fixture"),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MERCURY_MODEL: z.string().default("claude-opus-5"),
  MERCURY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  MERCURY_DB: z.string().default("./mercury.db"),
});
export type Env = z.infer<typeof zEnv>;
