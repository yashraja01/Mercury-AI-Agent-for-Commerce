import type { MerchantProfile, PolicyPatch } from "@mercury/core";

/**
 * Applying a merchant's policy edit.
 *
 * Pure, and deliberately not in `@mercury/core` -- core owns the schema, not the
 * question of which fields a settings page may move. Pure so the console and
 * the route agree on what "changed" means without one of them asking the other.
 *
 * Note what this cannot do: every field it does not name is copied from the
 * existing profile, so a patch can only ever move the four numbers the schema
 * lets through. There is no spread of caller-supplied keys anywhere in here,
 * which is the reason a crafted body cannot rewrite `category_taxonomy`.
 */

export interface PolicyChange {
  field: string;
  from: number | string;
  to: number | string;
}

export interface PolicyMerge {
  next: MerchantProfile;
  changes: PolicyChange[];
}

export function applyPolicyPatch(current: MerchantProfile, patch: PolicyPatch): PolicyMerge {
  const changes: PolicyChange[] = [];

  const next: MerchantProfile = { ...current };

  if (patch.min_margin_bps !== undefined && patch.min_margin_bps !== current.min_margin_bps) {
    changes.push({
      field: "min_margin_bps",
      from: current.min_margin_bps,
      to: patch.min_margin_bps,
    });
    next.min_margin_bps = patch.min_margin_bps;
  }

  if (patch.max_discount_bps !== undefined && patch.max_discount_bps !== current.max_discount_bps) {
    changes.push({
      field: "max_discount_bps",
      from: current.max_discount_bps,
      to: patch.max_discount_bps,
    });
    next.max_discount_bps = patch.max_discount_bps;
  }

  if (patch.levers !== undefined) {
    const before = [...current.levers].sort().join(",");
    const after = [...patch.levers].sort().join(",");
    if (before !== after) {
      changes.push({ field: "levers", from: before, to: after });
      next.levers = [...patch.levers];
    }
  }

  /*
   * Commission is only meaningful where the money splits. A quick-commerce
   * merchant sells its own inventory, so there is nothing to take a cut of and
   * nowhere to put one -- silently inventing a settlement block here would give
   * the profile a Route configuration its vertical never asked for.
   */
  if (
    patch.commission_bps !== undefined &&
    current.settlement !== undefined &&
    patch.commission_bps !== current.settlement.commission_bps
  ) {
    changes.push({
      field: "settlement.commission_bps",
      from: current.settlement.commission_bps,
      to: patch.commission_bps,
    });
    next.settlement = { ...current.settlement, commission_bps: patch.commission_bps };
  }

  return { next, changes };
}

/** Which policy fields differ from the seeded profile. Drives the "modified" badge. */
export function policyDrift(current: MerchantProfile, seeded: MerchantProfile): string[] {
  const { changes } = applyPolicyPatch(seeded, {
    merchant_id: current.merchant_id,
    min_margin_bps: current.min_margin_bps,
    max_discount_bps: current.max_discount_bps,
    levers: current.levers,
    ...(current.settlement === undefined
      ? {}
      : { commission_bps: current.settlement.commission_bps }),
  });
  return changes.map((c) => c.field);
}
