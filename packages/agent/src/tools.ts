import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import * as z from "zod/v4";
import type { CatalogItem, Proposal } from "@mercury/core";
import { lowestLegalUnit } from "@mercury/dwaar";
import type { GateFeedback, NegotiatorContext } from "./negotiator.js";

/**
 * The shared tool surface.
 *
 * One set of tools serves both verticals -- quick-commerce and B2B procurement
 * differ only in the catalogue rows and the MerchantProfile numbers these tools
 * read. If a vertical ever needed a tool of its own, that would be the same
 * design bug as a vertical needing a branch inside Dwaar (D9).
 *
 * Every tool is `strict: true` with `additionalProperties: false`, so
 * `tool_use.input` is guaranteed to validate against the schema before our code
 * ever sees it. The Zod schema and the wire schema are the same object, which
 * is the point: there is no second, drifting definition of what an offer is.
 *
 * The implementations below are plain functions. `ScriptedRevenueAgent` calls
 * them directly and `LlmRevenueAgent` calls them through Claude, so both agents
 * see exactly the same view of the merchant.
 */

/* ------------------------------------------------------------------ views -- */

/**
 * What the agent is allowed to know about a SKU.
 *
 * `cost_paise` is deliberately absent. The agent negotiates against the floor,
 * not against the cost, so landed cost never enters a prompt and can never be
 * leaked to a buyer by a talkative model.
 */
export interface CatalogView {
  sku: string;
  title: string;
  category: string;
  unit: string;
  list_paise: number;
  stock: number;
  moq: number;
}

export interface FloorView {
  sku: string;
  list_paise: number;
  /** The lowest unit price that satisfies both the margin floor and the discount ceiling. */
  lowest_legal_unit_paise: number;
  max_discount_bps: number;
  stock: number;
  moq: number;
}

export function viewOf(item: CatalogItem): CatalogView {
  return {
    sku: item.sku,
    title: item.title,
    category: item.category,
    unit: item.unit,
    list_paise: item.list_paise,
    stock: item.stock,
    moq: item.moq,
  };
}

/* ------------------------------------------------- tool implementations ---- */

export interface SearchArgs {
  category?: string | undefined;
  query?: string | undefined;
}

/** Case-insensitive substring match on title and sku, optionally within a category. */
export function searchCatalog(ctx: NegotiatorContext, args: SearchArgs): CatalogView[] {
  const q = args.query?.trim().toLowerCase();
  const cat = args.category?.trim().toLowerCase();
  const out: CatalogView[] = [];
  for (const item of ctx.catalog.values()) {
    if (cat !== undefined && cat !== "" && item.category.toLowerCase() !== cat) continue;
    if (
      q !== undefined &&
      q !== "" &&
      !item.title.toLowerCase().includes(q) &&
      !item.sku.toLowerCase().includes(q)
    ) {
      continue;
    }
    out.push(viewOf(item));
  }
  // Stable order, so an identical request produces an identical prompt prefix.
  return out.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

/**
 * The floor for each requested SKU.
 *
 * This is the merchant telling its own agent where the line is, in advance --
 * which is why a below-floor offer is a genuine agent error rather than an
 * unavoidable one, and why F1 (parameter drift under buyer pressure) is a real
 * test of the gate rather than a rigged one.
 */
export function priceFloor(ctx: NegotiatorContext, skus: readonly string[]): FloorView[] {
  const out: FloorView[] = [];
  for (const sku of skus) {
    const item = ctx.catalog.get(sku);
    if (item === undefined) continue;
    out.push({
      sku: item.sku,
      list_paise: item.list_paise,
      lowest_legal_unit_paise: lowestLegalUnit(item, ctx.profile),
      max_discount_bps: ctx.profile.max_discount_bps,
      stock: item.stock,
      moq: item.moq,
    });
  }
  return out;
}

/** Sum a set of offer lines. The agent must do this itself; drift is checked against it. */
export function quoteTotal(lines: readonly { qty: number; offer_unit_paise: number }[]): number {
  return lines.reduce((sum, l) => sum + l.offer_unit_paise * l.qty, 0);
}

/* ---------------------------------------------------------- wire schemas --- */

export const zSearchInput = z.object({
  query: z.string().describe("Substring of a product title or SKU. Empty string means no filter."),
  category: z
    .string()
    .describe("Restrict to one category from the merchant taxonomy. Empty string means all."),
});

export const zFloorInput = z.object({
  skus: z.array(z.string()).min(1).describe("SKUs to price, exactly as returned by search_catalog."),
});

export const zOfferInput = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().describe("A SKU from search_catalog. Never invent one."),
        qty: z.int().min(1).describe("Units. Must be at least the SKU minimum order quantity."),
        offer_unit_paise: z
          .int()
          .min(0)
          .describe("Offered price per unit, integer paise. Never below lowest_legal_unit_paise."),
      }),
    )
    .min(1),
  quoted_total_paise: z
    .int()
    .min(0)
    .describe("Your own arithmetic: sum of offer_unit_paise times qty. Checked against Dwaar."),
  rationale: z
    .string()
    .max(2000)
    .describe("One or two sentences on why this cart is good for the buyer and the merchant."),
});

export const zReplyInput = z.object({
  message: z.string().max(2000).describe("What to say back to the other agent."),
});

/* ------------------------------------------------------------- tool defs --- */

export type RunnableTool = BetaRunnableTool<any>;

/**
 * Force `strict: true` and `additionalProperties: false`.
 *
 * `betaZodTool` does not set these, and without them the model is free to send
 * an input that does not match the schema. For a tool whose arguments become
 * the amount of a payment, "usually valid" is not a category we accept.
 */
function harden<T>(tool: T): T {
  const schema = (tool as unknown as { input_schema: Record<string, unknown> }).input_schema;
  return {
    ...(tool as object),
    strict: true,
    input_schema: { ...schema, additionalProperties: false },
  } as T;
}

/** Captures what the model offered, so the caller can see it after the loop ends. */
export interface OfferSink {
  record(proposal: Proposal, feedback: GateFeedback): void;
  /** True once Dwaar has allowed an offer -- the loop should stop. */
  settled(): boolean;
  rounds(): number;
}

/**
 * Build the merchant agent's tools for one negotiation.
 *
 * The catalogue is reached through a tool rather than pasted into the prompt,
 * so the cached prefix (tools -> system -> messages) stays byte-identical
 * across turns and only the buyer's message varies.
 */
export function revenueTools(ctx: NegotiatorContext, sink: OfferSink): RunnableTool[] {
  const maxRounds = ctx.maxRounds ?? 3;

  const search = betaZodTool({
    name: "search_catalog",
    description:
      "List the SKUs this merchant actually sells, with list price, stock and minimum order " +
      "quantity. Call this before quoting anything. Never offer a SKU that this does not return.",
    inputSchema: zSearchInput,
    run: (args) => JSON.stringify(searchCatalog(ctx, args)),
  });

  const floor = betaZodTool({
    name: "price_floor",
    description:
      "The lowest unit price, in paise, that the merchant will legally accept for each SKU, plus " +
      "the discount ceiling, stock and MOQ. Offering below lowest_legal_unit_paise is a hard DENY.",
    inputSchema: zFloorInput,
    run: (args) => JSON.stringify(priceFloor(ctx, args.skus)),
  });

  const offer = betaZodTool({
    name: "submit_offer",
    description:
      "Put a cart through Dwaar, the policy gate. Returns the verdict: ALLOW, ALLOW_WITH_STEPUP " +
      "or DENY with the rule that failed, the observed value and the limit. On DENY, fix the " +
      "offer and submit again. All amounts are integer paise.",
    inputSchema: zOfferInput,
    run: async (args) => {
      if (sink.settled()) {
        return JSON.stringify({
          outcome: "REJECTED",
          reason: "This turn is already settled. Reply to the buyer instead of offering again.",
        });
      }
      if (sink.rounds() >= maxRounds) {
        return JSON.stringify({
          outcome: "REJECTED",
          reason: `Round limit (${maxRounds}) reached. Explain the position to the buyer and stop.`,
        });
      }
      const proposal = {
        merchant_id: ctx.profile.merchant_id,
        lines: args.lines.map((l) => ({
          sku: l.sku,
          qty: l.qty,
          offer_unit_paise: l.offer_unit_paise,
        })),
        quoted_total_paise: args.quoted_total_paise,
        rationale: args.rationale,
      } as Proposal;
      const feedback = await ctx.submit(proposal);
      sink.record(proposal, feedback);
      return JSON.stringify(feedback);
    },
  });

  return [search, floor, offer].map(harden);
}

/** The buyer agent's single tool: say something back. */
export function buyerTools(capture: (message: string) => void): RunnableTool[] {
  const reply = betaZodTool({
    name: "send_message",
    description: "Send one short paragraph to the merchant's agent.",
    inputSchema: zReplyInput,
    run: (args) => {
      capture(args.message);
      return "delivered";
    },
  });
  return [reply].map(harden);
}
