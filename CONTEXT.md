# CONTEXT — Mercury

> Read this file first in any new session. It is the project's stable truth.
> Volatile state (what's done, what's next, decisions log) lives in DEVLOG.md.

## 1. What we are building

Mercury is the **merchant side of agentic commerce**: a rail that lets an AI
buyer agent discover a merchant, negotiate a cart with the merchant's own AI
agent, and pay — where every rupee is gated by a deterministic policy gate and
recorded in a tamper-evident ledger.

One line: *Two AI agents negotiate. A deterministic gate decides whether a
single rupee may move. Razorpay settles it. A hash chain proves it.*

| Name | Meaning | Role |
|---|---|---|
| Mercury | Roman god of commerce and messengers (from *merx*, the root of *merchant*) | The product |
| Dwaar (द्वार) | "gate / doorway" | Deterministic policy gate |
| Sakshi (साक्षी) | "witness" — observes without participating | Hash-chained audit ledger |

Architecture in two words: **a gate, and a witness.**

## 2. Goals

1. **Grow merchant revenue** — a merchant-side Revenue Agent negotiates bundles
   and pricing to lift basket value, inside hard margin bounds.
2. **Make the merchant transactable by any AI buyer** — MCP server + A2A Agent
   Card + machine-readable catalog feed.
3. **Every money action explainable, bounded, gated** — signed mandates, a pure
   policy gate, human step-up, instant freeze.
4. **Prove it** — an audit trail an outside party can independently verify.
5. **Prove the rail is vertical-agnostic** — the same gate serves B2C
   quick-commerce and B2B procurement with no gate changes.

## 3. Non-goals

- Not a payment processor. Razorpay does settlement; we do authorization.
- Not a conformance implementation. We implement AP2/UAP/ACP/UCP **shapes**
  faithfully; we do not claim certification.
- No production keys, ever. Test mode only (`rzp_test_...`).
- No real UPI Reserve Pay integration (not available to us). We model the
  envelope in Dwaar and keep a clean adapter seam.

## 4. Architecture

```
Buyer side          external Claude (MCP)  |  in-app buyer agent
                    carries: ReserveMandate (human-signed) + intent token
                                    |
                    MCP (stdio)  ·  A2A Agent Card  ·  SSE
                                    v
  +-------------------------------------------------------------+
  | MERCURY GATEWAY — Next.js route handlers                    |
  |                                                             |
  |  @mercury/core     types · Paise · Zod · canonical JSON     |
  |  @mercury/agent    Revenue Agent + buyer agent — PROPOSES   |
  |  @mercury/dwaar    ## DWAAR ## pure · deterministic · NO LLM|
  |  @mercury/rail     RazorpayPort -> FixtureRail | LiveRail   |
  |  @mercury/sakshi   ## SAKSHI ## append-only sha256 chain    |
  +-------------------------------------------------------------+
              |                                    |
      SQLite (WAL) + better-sqlite3   Razorpay TEST (rzp_test_...)
```

**The invariant that defines the system:** the LLM proposes; Dwaar disposes.
The agent never holds a key, never calls Razorpay, and the number it says is
discarded — Dwaar recomputes the total from signed catalog line items and
creates the Order from *its* figure.

## 5. Two verticals, one gate

The rail is vertical-agnostic. **Only data and prompts differ.** If a vertical
ever needs a change inside Dwaar, that is a design bug — add a `MerchantProfile`
field instead.

| | B2C quick-commerce | B2B SME procurement |
|---|---|---|
| Buyer | Consumer's shopping agent | Restaurant/retail owner's procurement agent |
| Mandate archetype | Recurring weekly envelope, Human-**Not**-Present | Large single-deal envelope, Human-Present step-up |
| Revenue levers | Bundling, substitution, basket-building | Bulk tiers, MOQ, credit terms, multi-vendor basket |
| Catalog seed | `db/seed/quick-commerce.ts` | `db/seed/b2b-procurement.ts` |
| Agent persona | `prompts/persona.quick-commerce.md` | `prompts/persona.b2b.md` |
| Shared | **dwaar · sakshi · rail · tool schemas · FSM · UI** | <- identical |

`MerchantProfile` is the only per-vertical policy input Dwaar reads:

```ts
type MerchantProfile = {
  merchant_id: string
  min_margin_bps: number          // margin floor
  max_discount_bps: number        // discount ceiling
  levers: ("bundle"|"substitute"|"bulk_tier"|"credit_terms")[]
  category_taxonomy: string[]
}
```

## 6. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Repo | **npm workspaces** | npm ships with Node — zero install friction for judges (see D12) |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Deterministic type safety |
| App | Next.js 15 (App Router) — one runnable app | `npm run dev` starts everything; raw body via `await req.text()` for webhook HMAC |
| UI | Tailwind + shadcn/ui | Fast, clean |
| DB | SQLite (WAL) + better-sqlite3 | Zero install; ships seeded. `BEGIN IMMEDIATE` gives real inventory locking — no Redis |
| LLM | `@anthropic-ai/sdk`, `claude-opus-5` | Adaptive thinking, `output_config.effort: "high"` |
| LLM safety | `betaZodTool` + `strict: true` tools | Guarantees `tool_use.input` validates exactly |
| LLM cost | `cache_control: ephemeral` on frozen prompt + catalog | Opus 5 caches from 512 tokens; volatile turn state goes after the breakpoint |
| LLM mid-turn | Mid-conversation `{role:"system"}` messages | Injects Dwaar verdicts without invalidating the cached prefix |
| Crypto | `node:crypto` Ed25519 | Native, zero deps |
| Validation | Zod | One schema language: API, LLM output, env |
| Tests | Vitest + fast-check | Property-test Dwaar |

## 7. Module contracts

| Module | Owns | Must never |
|---|---|---|
| `core` | Branded `Paise`, IDs, Zod schemas, canonical JSON, sha256 | Import any other module |
| `dwaar` | `evaluate()`, pricing/margin, drift detection, FSM | Do I/O, call an LLM, or import `rail` |
| `sakshi` | Append + verify hash chain | Mutate or delete a row |
| `rail` | `RazorpayPort` impls, HMAC verify, webhook parsing | Decide anything policy-related |
| `agent` | LLM negotiation, tool schemas, prompts | Compute a final price or touch a key |

## 8. The rail port

`rail` exposes one interface with two implementations, chosen by `RAIL_MODE`:

```ts
interface RazorpayPort {
  createOrder(o: OrderInput): Promise<RzpOrder>
  createPaymentLink(l: LinkInput): Promise<RzpLink>
  refund(paymentId: string, amount: Paise): Promise<RzpRefund>
  verifyCheckoutSignature(orderId, paymentId, sig): boolean
  verifyWebhookSignature(rawBody: string, sig: string): boolean
}
```

- **`FixtureRail`** (`RAIL_MODE=fixture`, default) — recorded response shapes,
  deterministic IDs, programmable failure injection. Runs offline. All tests and
  all seven failure scenarios work here with no network and no tunnel.
- **`LiveRail`** (`RAIL_MODE=live`) — real `rzp_test_...` keys. Same interface.

Every test runs against `FixtureRail`. `LiveRail` gets one smoke test.

## 9. Money rule

All money is **integer paise**, branded type `Paise`. No floats anywhere. Zod
rejects non-integers at every boundary. Razorpay amounts are paise by definition.

## 10. Constraints

- Razorpay **test mode only**. Test UPI: `success@razorpay` / `failure@razorpay`.
- Webhook signature: `HMAC_SHA256(rawBody, webhookSecret)` -> `X-Razorpay-Signature`.
  Never parse the body before verifying. Dedupe on `x-razorpay-event-id`.
  Handle out-of-order delivery.
- Checkout signature: `HMAC_SHA256(order_id + "|" + payment_id, keySecret)`.
- Order `receipt` <= 40 chars and unique. `notes` <= 15 pairs, <= 256 chars each.
- Secrets live only in `.env` (git-ignored). `.env.example` is committed.

## 11. Protocol alignment

| Ecosystem primitive | Our implementation |
|---|---|
| UAP / UPI Reserve Pay — single block, multiple debits, residual auto-release | `ReserveMandate` envelope; Dwaar draws down per purchase; releases residual on close |
| AP2 Intent / Cart / Payment Mandates | `ReserveMandate` (human-signed) -> `CartMandate` (Dwaar-signed) -> `intent_token` (single-use) |
| AP2 Human-Present / Not-Present | Explicit field; above-threshold spend forces Human-Present step-up |
| ACP Delegated Payment (single-use, capped, expiring) | `intent_token`: nonce'd, TTL'd, consumed in the same DB transaction as the order |
| A2A Agent Card discovery | `/.well-known/agent.json` |
| UCP / ACP capability + product feed | Machine-readable catalog endpoint |
| Instant revocation | Global freeze flag -> `CIRCUIT.FROZEN` |

## 12. Glossary

- **Dwaar** — the deterministic policy gate. Pure function, no I/O, no LLM.
- **Sakshi** — the append-only, hash-chained audit ledger.
- **ReserveMandate** — human-signed budget envelope (Reserve-Pay-shaped).
- **CartMandate** — Dwaar-signed, hash-bound priced cart.
- **intent_token** — single-use, TTL'd authorization for exactly one money action.
- **Dwaar decision** — `ALLOW` | `ALLOW_WITH_STEPUP` | `DENY`, plus `RuleEval[]`.
- **Drift** — LLM-quoted amount != Dwaar-computed amount. Always a hard `DENY`.
