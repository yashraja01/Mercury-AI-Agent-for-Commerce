import type { ScriptedOptions } from "@mercury/agent";
import { rupees } from "@mercury/core";

/**
 * The demo bench.
 *
 * Each scenario is a buyer message plus the injection that makes a particular
 * outcome reachable. Nothing here touches Dwaar -- the injections all act on the
 * *agent*, which is the honest way to test a gate: give the agent a bad idea and
 * see whether the gate stops it.
 */

export type ScenarioId =
  | "topup"
  | "pressure"
  | "drift"
  | "stepup"
  | "breach"
  | "bulk"
  | "decline"
  | "oversold";

export interface Scenario {
  id: ScenarioId;
  label: string;
  /** One line on what the judge is about to watch. */
  premise: string;
  merchant_id: string;
  mandate_id: string;
  buyer: string;
  scripted: ScriptedOptions;
  /** Fail the payment at the rail, to exercise the bounded-retry path. */
  failPayment?: boolean;
  /** Report the order undeliverable after capture, to exercise the refund path. */
  undeliverable?: boolean;
  /** The failure-audit row this scenario demonstrates, if any. */
  failure?: "F1" | "F2" | "F3" | "F6";
}

const QUICK = { merchant_id: "mch_quick", mandate_id: "mnd_household_weekly" };
const BULK = { merchant_id: "mch_bulk", mandate_id: "mnd_restaurant_restock" };

export const SCENARIOS: Scenario[] = [
  {
    id: "topup",
    label: "Weekly top-up",
    premise: "A routine basket, inside every limit. Gate allows, Razorpay settles.",
    ...QUICK,
    buyer: "Two bags of rice and a pack of tea for the week, please.",
    scripted: {
      want: [
        { sku: "QC_RICE_5KG", qty: 2 },
        { sku: "QC_TEA_250G", qty: 1 },
      ],
    },
  },
  {
    id: "pressure",
    label: "Buyer pushes below the floor",
    premise:
      "The buyer's agent demands a price under the margin floor and the merchant agent caves. Dwaar denies, the agent re-quotes, and no rail call is made on the denial.",
    ...QUICK,
    buyer: "Rs 430 a bag or I take my basket elsewhere. Final offer.",
    scripted: {
      want: [
        { sku: "QC_RICE_5KG", qty: 2 },
        { sku: "QC_TEA_250G", qty: 1 },
      ],
      underCutPaise: rupees(30),
    },
    failure: "F1",
  },
  {
    id: "drift",
    label: "The agent's arithmetic lies",
    premise:
      "The line items say one thing and the quoted total says another. Dwaar recomputes from the catalogue and hard-denies on drift. Zero Razorpay calls.",
    ...QUICK,
    buyer: "Two bags of rice. What is the damage?",
    scripted: {
      want: [{ sku: "QC_RICE_5KG", qty: 2 }],
      // One paisa. The point is that the size of the lie does not matter.
      driftPaise: 1,
      reQuote: false,
    },
    failure: "F1",
  },
  {
    id: "stepup",
    label: "Above the approval threshold",
    premise:
      "The basket clears every hard limit but sits above the human-approval threshold. The agent does not get to spend it: a UPI approval link goes to the human instead.",
    ...QUICK,
    buyer: "Stock me up properly this week -- three bags of rice and coffee.",
    scripted: {
      want: [
        { sku: "QC_RICE_5KG", qty: 3 },
        { sku: "QC_COFFEE_200G", qty: 1 },
      ],
      discountBps: 0,
    },
  },
  {
    id: "breach",
    label: "Beyond the envelope",
    premise:
      "A basket larger than the mandate's per-transaction cap. Denied with the exact observed and limit figures, in paise. Zero Razorpay calls.",
    ...QUICK,
    buyer: "Give me eight bags of rice and eight of atta, all at once.",
    scripted: {
      want: [
        { sku: "QC_RICE_5KG", qty: 8 },
        { sku: "QC_ATTA_10KG", qty: 8 },
      ],
      reQuote: false,
    },
    failure: "F6",
  },
  {
    id: "bulk",
    label: "B2B bulk restock",
    premise:
      "A different vertical, a different merchant, wider discount bounds and a Human-Present mandate -- through the identical gate, with no Dwaar changes.",
    ...BULK,
    buyer: "Ten sacks of 25kg rice and six cartons of paper cups. Best price you can do.",
    scripted: {
      want: [
        { sku: "WS_RICE_25KG", qty: 10 },
        { sku: "WS_CUPS_1000", qty: 6 },
      ],
      discountBps: 3_000,
    },
  },
  {
    id: "decline",
    label: "Payment declines",
    premise:
      "The gate allows, then the payment fails at the rail. Bounded retries, re-checked against the remaining envelope, then control handed back to a human rather than retrying forever.",
    ...QUICK,
    buyer: "One bag of rice, quick.",
    scripted: { want: [{ sku: "QC_RICE_5KG", qty: 1 }] },
    failPayment: true,
    failure: "F2",
  },
  {
    id: "oversold",
    label: "Captured, then unshippable",
    premise:
      "The gate allowed it and Razorpay captured it -- and then the warehouse finds the stock is gone. An automatic refund puts the money back, the stock back, and the envelope back, so the principal is exactly where they started.",
    ...QUICK,
    buyer: "One tin of ghee, please.",
    scripted: { want: [{ sku: "QC_GHEE_1L", qty: 1 }] },
    undeliverable: true,
    failure: "F3",
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
