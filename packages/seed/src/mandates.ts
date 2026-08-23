import {
  type ReserveMandate,
  type SignedReserveMandate,
  generateKeyPair,
  rupees,
  signValue,
} from "@mercury/core";

/**
 * Seed mandates -- one per vertical, each shaped like the archetype for its side
 * of the market.
 *
 * Quick-commerce is a recurring weekly envelope with the human *not* present:
 * many small debits, a low step-up threshold, and the agent expected to run
 * unattended. B2B procurement is one large envelope with the human present: few
 * debits, a big per-transaction cap, and an owner who expects to approve.
 *
 * The keypair is generated fresh on every seed. These are demo principals, so
 * there is nothing to protect -- but it also means a re-seed invalidates old
 * mandates, which is the correct behaviour for a signature-bound artifact.
 */

export interface SeededPrincipal {
  principal_id: string;
  public_key: string;
  /** Kept only so the demo can mint further mandates for the same principal. */
  private_key: string;
  /**
   * The delegated agent's keypair.
   *
   * The public half is named inside the signed mandate, so the human is
   * authorising exactly this key. The private half is the buyer's wallet: it
   * is what a caller signs a holder proof with, and it is the only reason a
   * mandate id is not a bearer token.
   */
  agent_public_key: string;
  agent_private_key: string;
  mandate: SignedReserveMandate;
}

function sign(mandate: ReserveMandate, privateKey: string, publicKey: string): SignedReserveMandate {
  return { mandate, signature: signValue(mandate, privateKey), public_key: publicKey };
}

function window(days: number): { not_before: string; expires_at: string } {
  const now = new Date();
  return {
    not_before: new Date(now.getTime() - 60_000).toISOString(),
    expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
  };
}

export function seedPrincipals(): SeededPrincipal[] {
  const household = generateKeyPair();
  const restaurant = generateKeyPair();
  const householdAgent = generateKeyPair();
  const restaurantAgent = generateKeyPair();

  const weekly: ReserveMandate = {
    mandate_id: "mnd_household_weekly",
    principal_id: "prn_household",
    agent_id: "agt_buyer_household",
    agent_public_key: householdAgent.publicKey,
    vertical: "quick_commerce",
    reserved_paise: rupees(5_000),
    max_per_txn_paise: rupees(2_000),
    max_txn_count: 8,
    // Unattended agent, so anything sizeable goes back to the human.
    requires_human_approval_above_paise: rupees(1_500),
    scope: {
      merchant_allowlist: ["mch_quick"],
      category_allowlist: ["staples", "beverages", "snacks", "household"],
    },
    human_present: false,
    ...window(7),
    nonce: "seed_household_weekly",
  };

  const procurement: ReserveMandate = {
    mandate_id: "mnd_restaurant_restock",
    principal_id: "prn_restaurant",
    agent_id: "agt_buyer_restaurant",
    agent_public_key: restaurantAgent.publicKey,
    vertical: "b2b_procurement",
    reserved_paise: rupees(300_000),
    max_per_txn_paise: rupees(150_000),
    max_txn_count: 4,
    // The owner is present and expects to approve a deal of this size.
    requires_human_approval_above_paise: rupees(60_000),
    scope: {
      merchant_allowlist: ["mch_bulk"],
      category_allowlist: ["staples", "beverages", "packaging"],
    },
    human_present: true,
    ...window(30),
    nonce: "seed_restaurant_restock",
  };

  return [
    {
      principal_id: "prn_household",
      public_key: household.publicKey,
      private_key: household.privateKey,
      agent_public_key: householdAgent.publicKey,
      agent_private_key: householdAgent.privateKey,
      mandate: sign(weekly, household.privateKey, household.publicKey),
    },
    {
      principal_id: "prn_restaurant",
      public_key: restaurant.publicKey,
      private_key: restaurant.privateKey,
      agent_public_key: restaurantAgent.publicKey,
      agent_private_key: restaurantAgent.privateKey,
      mandate: sign(procurement, restaurant.privateKey, restaurant.publicKey),
    },
  ];
}
