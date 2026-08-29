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
  |  @mercury/agent    Revenue Agent + Engine — PROPOSES ONLY   |
  |  @mercury/dwaar    ## DWAAR ## pure · deterministic · NO LLM|
  |  @mercury/rail     RazorpayPort -> FixtureRail | LiveRail   |
  |  @mercury/store    catalogue · mandates · tokens · orders     |
  |  @mercury/sakshi   ## SAKSHI ## append-only sha256 chain    |
  +-------------------------------------------------------------+
              |                                    |
      SQLite (WAL) via node:sqlite     Razorpay TEST (rzp_test_...)
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
| Settlement | Single payment, own inventory | **Route**: split across supplier linked accounts |
| Revenue levers | Bundling, substitution, basket-building | Bulk tiers, MOQ, credit terms, multi-vendor basket |
| Catalog seed | `QUICK_COMMERCE` in `packages/seed/src/catalogs.ts` | `B2B_PROCUREMENT`, same file |
| Agent persona | `prompts/persona.quick-commerce.md` | `prompts/persona.b2b.md` |
| Mandate seed | `mnd_household_weekly` | `mnd_restaurant_restock` |
| Shared | **dwaar · sakshi · store · rail · engine · tool schemas · FSM · UI** | <- identical |

`MerchantProfile` is the only per-vertical policy input Dwaar reads:

```ts
type MerchantProfile = {
  merchant_id: string
  min_margin_bps: number          // margin floor
  max_discount_bps: number        // discount ceiling
  levers: ("bundle"|"substitute"|"bulk_tier"|"credit_terms")[]
  category_taxonomy: string[]

  // The merchant's own limits on the shape of an order. Absent means no limit.
  max_order_paise?: number        // ORDER.VALUE_CAP
  max_order_units?: number        // ORDER.UNIT_CAP
  max_order_lines?: number        // ORDER.LINE_CAP
  reserve_units?: number          // INVENTORY.RESERVE
  agent_categories?: string[]     // SCOPE.MERCHANT_CATEGORIES; ⊆ category_taxonomy

  settlement?: {                  // Route. Dwaar never reads this.
    mode: "route"
    commission_bps: number
    commission_account_id: string
  }
}
```

The five order-shape fields are the **merchant's** side of the bargain, and they
sit beside the mandate's caps rather than replacing them: the mandate says what
the buyer was authorised to spend, these say what this merchant is willing to
sell in one go. Either can bind first, and the rule list names which did.
`ORDER.VALUE_CAP` is checked *before* `MANDATE.PER_TXN_CAP` — a seller declining
a sale does not depend on what the buyer could afford.

`agent_categories` is the editable half of scope, and it may **only ever
narrow**. A merchant withdrawing a category from its own agent is subtracting
from a permission it already holds; widening lives in `category_taxonomy`, which
no console may touch. The subset is enforced at the write site, not in the
schema — the taxonomy is not in the patch, so Zod could not see it.

`settlement` is the one field on the profile the gate ignores on purpose. How a
captured rupee is divided afterwards is not an authorisation question, and
putting it in front of Dwaar would be a category error.

## 6. Running it

```bash
npm install
npm run seed        # fresh DB + mandates + buyer-wallet.json
npm run dev         # Mission Control + merchant console on :3000
```

| Command | Does |
|---|---|
| `npm run seed` | Wipes and re-seeds `mercury.db`; mints `buyer-wallet.json` |
| `npm run dev` | Mission Control, the merchant console and the buyer API on :3000 |
| `npm run demo` | The whole path on a terminal, no browser, no key |
| `npm run mcp:smoke` | Drives the MCP server over real stdio JSON-RPC (needs `npm run dev`) |
| `npm run chaos` | Runs the failure-audit table F1-F7 and prints what it verified (needs `npm run dev`) |
| `npm run chaos -- --reset` | Same, but re-seeds the demo bench first |
| `npm run conformance` | Checks the Agent Card and every feed against the shape they claim, and that no public document leaks cost, the margin floor or a supplier account (needs `npm run dev`) |
| `npm test` | 232 tests. No API key, no network, no spend |
| `npm run verify` | Re-walks the Sakshi chain independently |
| `npm run build` | Packages, then `scripts/`, then the Next app |

**Repo map**

```
packages/core    Paise, canonical JSON, Ed25519, schemas   (imports nothing)
packages/sakshi  hash-chained ledger
packages/store   mutable working state (SQLite)
packages/dwaar   the gate: one pure evaluate()
packages/rail    RazorpayPort -> FixtureRail | LiveRail
packages/seed    catalogue + mandate fixtures, buyer wallet
packages/agent   negotiators, levers, lever tools, prompts, the Engine
apps/web         Mission Control + merchant console + buyer API + Card + feed
apps/mcp         MCP stdio server (thin client of apps/web)
prompts/         system.core.md + three personas
scripts/         seed, demo, verify-chain, mcp-smoke, chaos, conformance
```

Paths in the app are anchored to the repo root, not `process.cwd()` — `next dev`
runs from `apps/web`, and a bare relative path there silently creates a second
database.

## 7. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Repo | **npm workspaces** | npm ships with Node — zero install friction for judges (see D12) |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Deterministic type safety |
| App | Next.js 15 (App Router) — one runnable app | `npm run dev` starts everything; raw body via `await req.text()` for webhook HMAC |
| UI | Tailwind v4, hand-built components | shadcn adds a generator and a component tree for ~8 elements; see D15 |
| UI transport | SSE from a Node-runtime route | A verdict that arrives already decided is a report, not a demonstration |
| DB | SQLite (WAL) via `node:sqlite` | Zero install, zero deps; ships seeded. `BEGIN IMMEDIATE` gives real inventory locking — no Redis |
| LLM | `@anthropic-ai/sdk`, `claude-opus-5` | Adaptive thinking, `output_config.effort: "high"` |
| LLM safety | `betaZodTool` + `strict: true` tools | Guarantees `tool_use.input` validates exactly |
| LLM cost | `cache_control: ephemeral` on frozen prompt + catalog | Opus 5 caches from 512 tokens; volatile turn state goes after the breakpoint |
| LLM mid-turn | Mid-conversation `{role:"system"}` messages | Injects Dwaar verdicts without invalidating the cached prefix |
| Crypto | `node:crypto` Ed25519 | Native, zero deps |
| Validation | Zod | One schema language: API, LLM output, env |
| Tests | Vitest + fast-check | Property-test Dwaar |

## 8. Module contracts

| Module | Owns | Must never |
|---|---|---|
| `core` | Branded `Paise`, IDs, Zod schemas, canonical JSON, sha256 | Import any other module |
| `dwaar` | `evaluate()`, pricing/margin, drift detection, FSM | Do I/O, call an LLM, or import `rail` |
| `sakshi` | Append + verify hash chain | Mutate or delete a row |
| `rail` | `RazorpayPort` impls, HMAC verify, webhook parsing | Decide anything policy-related |
| `store` | Mutable working state: catalogue, mandates, tokens, orders | Touch the Sakshi chain |
| `seed` | Catalogue + mandate fixtures for both verticals | Contain logic of any kind |
| `agent` | Negotiation, revenue levers, tool schemas, prompts, the Engine | Compute a final price or touch a key |
| `web` | Mission Control, the merchant console, the buyer-facing API, feed and Agent Card | Decide anything about *money*. The merchant console sets policy; the gate still applies it |
| `mcp` | Buyer transport over stdio | Accept a price, or hold state of its own |

## 9. The negotiator port

`agent` exposes the negotiator behind an interface, for the same reason `rail`
does (D10, D13):

```ts
interface Negotiator {
  readonly mode: "llm" | "scripted"
  negotiate(turn: NegotiationTurn): Promise<NegotiationResult>
}
```

- **`ScriptedRevenueAgent`** — deterministic, no API key, no network, no spend.
  The default in tests and in `npm run demo`. It calls the *same* tool
  implementations and submits through the *same* gate; only the judgement is
  substituted.
- **`LlmRevenueAgent`** — `claude-opus-5`, adaptive thinking, `strict: true`
  tools, cached `tools -> system` prefix.

A negotiator's entire reach into the system is one function:

```ts
submit: (proposal: Proposal) => Promise<GateFeedback>
```

No store, no ledger, no rail, no key. `gateVia(engine, ...)` supplies it.

## 10. The revenue levers

Goal 1 says the Revenue Agent grows basket value. These are the mechanisms, and
`MerchantProfile.levers` is what a merchant permits. A lever a profile does not
list is never pulled, which is how one implementation serves both verticals.

| Lever | Mechanism | Guard |
|---|---|---|
| `bulk_tier` | Quantity ladder: deeper discount at 5 / 10 / 25 / 50 units | Clamps to the margin floor; deeper tiers simply stop |
| `bundle` | Add-on from a *different* category than the basket anchor | Capped at 40% of basket value, and only added when the buyer invites it |
| `substitute` | Nearest stocked equivalent, same category | Never crosses category; silent if the line can be filled |

Every lever clamps to `lowestLegalUnit` itself, so it cannot produce a price the
gate would have to catch. The gate still checks — that is what makes the clamp
safe to trust rather than merely polite.

**Both agents reach the same levers.** The scripted agent calls these functions
directly; the model reaches them as three tools — `bulk_tier_quote`,
`suggest_bundle`, `find_substitute` — that call the same implementations. Every
lever tool is present for every merchant with the same schema, so the cached
tool prefix does not fork per merchant; one the profile does not permit answers
`available: false` and returns no price. A lever tool that existed only for one
agent would make Goal 1 a property of which agent happened to be running.

**Uplift is measured, not asserted.** `BasketValue` records what the buyer asked
for versus what the gate approved, and it goes into the ledger beside the
decision. The baseline is the same figure on both paths — the basket the buyer's
own message named, priced with no lever pulled (`basket.ts`) — because two
agents measuring uplift differently would make the console's total meaningless.

**Attribution is earned, not claimed.** The scripted agent knows which levers it
pulled. The model chooses, so every lever tool records what it offered and the
record is checked afterwards against the cart the gate *approved*: the tier price
must be the price on the line, the add-on must be in the cart, the substitute in
and the original out. A lever the model looked at and ignored earns nothing, and
a lever pulled into an offer that was denied earns nothing. Under-counting is the
only safe direction for a number a merchant reads as revenue.

**Bundling requires consent.** An agent that appends a line to every basket is
padding. `bundle` returns a *suggestion* unless the buyer's message opens the
door; only then does it enter the cart. On the model's path the merchant decides
this and hands down the answer as `invited`, rather than letting the model rule
on a question it has an obvious incentive to get wrong.

## 11. The buyer surface

An external agent reaches the merchant through three things, in this order:

| Surface | Path | Carries |
|---|---|---|
| A2A Agent Card | `/.well-known/agent.json` | Who this is, what it sells, how authority works, **what it will refuse** |
| Product feed | `/api/feed/{merchant_id}` | UCP/ACP-shaped: stable SKUs, paise, live stock, MOQ |
| Transaction API | `/api/agent/{quote,pay,mandate,audit}` | The negotiation itself |

`apps/mcp` wraps that API as MCP stdio tools. It is a **thin client of the
gateway**, not a second engine (D5, D16): one store, one ledger, one rail, so a
purchase made from Claude Desktop appears live in Mission Control.

**Every buyer-facing call is signed.** The mandate names the delegated agent's
Ed25519 public key *inside the signed artifact*, so the human authorises exactly
one key. A caller proves it holds the mandate by signing `{mandate_id, nonce,
issued_at}` with the matching private key; Dwaar checks it as `HOLDER.*` rules
before it looks at the cart. Without this a mandate id is a bearer token and
every other limit is only as strong as the secrecy of a string in a request
body. Mission Control passes `require_holder_proof: false` — there the caller
*is* the merchant — and that exemption is an explicit argument, not an implied
one.

**No buyer-facing surface accepts a price.** Not a total, not a unit price, not
a discount. A buyer sends a sentence; the merchant's agent proposes; Dwaar
prices. An MCP tool taking `total_paise` from its caller would put an LLM back
in the money path, which is the thing this whole design exists to prevent.

## 12. The rail port

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

**The webhook secret is environment, not mode.** `RAZORPAY_WEBHOOK_SECRET` is
read once and handed to whichever rail is in use, so setting it makes
`/api/webhook/razorpay` verify genuine Razorpay deliveries even while
`RAIL_MODE=fixture`. Unset in live mode the route answers `503 not_configured`
rather than a signature mismatch — otherwise every real delivery would be
recorded as a rejected webhook, and the ledger would fill with attacks that
never happened.

**Split settlement (Route).** A wholesale basket is one payment and several
sellers. After capture the engine divides the money by what each supplier
actually sold — largest remainder, so the legs sum to the capture exactly — and
takes the platform commission off the top, so a supplier's share is never
reduced by a fee it did not agree to. A transfer that fails does **not** unwind
the capture; it is recorded and left for an operator. Quick-commerce sells its
own inventory, so nothing splits.

Every test runs against `FixtureRail`. `LiveRail` gets one smoke test.

## 13. Two screens

The app has two seats at the same system, switched from the header nav. They
share one store, one ledger, one rail — the difference is only whose question is
being answered.

| Screen | Seat | Answers |
|---|---|---|
| `/` Mission Control | the observer | *Did the gate decide correctly, and can I check?* |
| `/merchant` | the merchant | *What did my agent earn me, and what is it allowed to do?* |

### Mission Control

Three panels, all spectators on the same run. The page decides nothing;
`scripts/demo.ts` drives the identical path with the browser closed.

| Panel | Shows | Why it exists |
|---|---|---|
| Negotiation theatre | Buyer and merchant turns, each offer, each verdict, settlement | Watch the gate decide, in order |
| Dwaar (द्वार) | **Agent quoted vs Dwaar computed**, then every rule with observed and limit | The product thesis as two numbers |
| Sakshi (साक्षी) | Each entry with `prev_hash <- hash`, and a live `verify` | The chain, checkable in front of you |

Controls: eight scenarios (four of which reproduce a failure-audit row), a
scripted/Claude agent switch, a freeze kill switch, and reset.

The left column has a second view: the **Chaos Console**, which is the
failure-audit table made executable. Each row injects its own fault and then
checks the recovery -- the Sakshi events that row promises, plus the state that
must not have moved. A row goes green only when every check holds, so a claim
that stops being true goes red rather than staying written down. `npm run chaos`
runs the identical rows headlessly against the same routes and exits non-zero on
any failure; `apps/web/lib/chaos.ts` is the single implementation behind both.

The webhook rows are deliberately not in-process: they arrive as real HTTP
requests at `/api/webhook/razorpay`, signed (or mis-signed) the way Razorpay
signs. A forged delivery that was only ever handed to a class has never been
rejected as a *request*.

The bench is finite — the demo mandate has eight debits and a full pass spends
one. Rows that need a live order check that budget *before* injecting anything
and report **blocked** rather than failed when it is gone, because a setup
denied for lack of money looks exactly like the failure the row is testing.
Reset re-seeds, and is always a button: it destroys the ledger, which is the one
thing here meant to be trusted.

Routes are all `runtime = "nodejs"` -- `node:sqlite` does not exist on edge.

### The merchant console

The only screen in the app that *decides* anything, and the only one that reads
in a single direction — an answer, then instructions, then what happens next.
Deliberately not Mission Control's two-column instrument grid: the observer
watches several things at once and needs density, the merchant asks one question
and then gives orders, and the layouts should not be interchangeable.

| Section | Shows | Why it exists |
|---|---|---|
| Earnings | **The headline**: what the agent earned over a plain price list, then buyer-asked vs gate-approved and the lever that did it | Goal 1, as the screen's answer rather than one cell among four |
| What the agent may do | **Editable** controls in three groups — pricing, inventory, negotiation | Goal 3 made touchable, and the merchant's control surface |
| What it sold | Recent orders, one status foregrounded; the order/payment split behind a toggle | The two advance independently (F5), but that is not a first read |
| Why a sale can be refused | Per-mandate remaining spend and remaining orders | Both limits bind; either can run out first |

**One control shape per kind of question**, so a viewer can tell what a control
does before reading its label: a **slider** for a percentage, where the range is
meaningful and the gesture is "a bit more"; a **number box** for a count or an
amount, where you already know the figure and dragging to ₹1,50,000 is absurd;
a **toggle** for a permission, which is on or off. Every figure is in the unit a
shopkeeper thinks in — percent, rupees, units — never basis points. The rule id
and the raw figure the gate reads sit one toggle away under *why you can trust
this*: demoted, never deleted, because the determinism is the reason to trust
any of it.

**The margin floor is not editable here.** `MARGIN.FLOOR_BREACH` still runs on
every evaluation and `min_margin_bps` still lives on the profile — it is simply
not on the settings page, alongside identity and the taxonomy. It is the one
number where a slip sells below cost.

**No control here is advisory.** Each one is a Dwaar rule, and the gate refuses
a cart that breaks it — set the line cap to 1 and the very next negotiation is
denied on `ORDER.LINE_CAP`. A control that gated nothing would be the one kind
of lie this product cannot tell.

Every figure in Earnings is summed from `BASKET_VALUED` entries in the chain, not
from a counter kept somewhere convenient — so the number the merchant sees is
the number an outside party reaches by walking the ledger. If those two could
disagree, the audit trail would be a copy of the truth rather than the truth.

**The instructions write through.** `Engine.propose` re-reads the profile on
every evaluation, so a change lands on the next negotiation with no restart and
no cache to invalidate — a margin floor you must redeploy to move is a constant,
not a control. Each field is labelled with the Dwaar rule it drives
(`MARGIN.FLOOR_BREACH`, `DISCOUNT.BPS_CAP`), and **the change itself is appended
to Sakshi as `POLICY_CHANGED`** with before and after. A merchant loosening its
own floor is exactly what an audit trail is for; without that entry, a cart
approved at 8% under a 15% floor would read as a gate failure rather than a
policy change made a minute earlier.

What a raised floor actually does is reprice, not refuse: Dwaar repairs the
proposal to the lowest legal figure and the basket gets dearer. A denial only
follows when that new figure breaks something else.

**A merchant may not edit its own identity or `category_taxonomy`.** The
taxonomy feeds `SCOPE.CATEGORY_ALLOWLIST`, so a form that could widen it would
be a privilege escalation wearing a settings page. `zPolicyPatch` names the
fields it admits and copies the rest; there is no spread of caller-supplied keys
anywhere in the write path.

What the merchant *may* do is withdraw a category from its own agent, through
`agent_categories`. That is the same permission read in the narrowing direction,
and the write site intersects whatever it is given with the existing taxonomy —
so a body naming a category the merchant does not hold has that category
dropped, and the worst a crafted request achieves is narrowing itself. The two
category rules stay distinct on purpose: `SCOPE.CATEGORY_ALLOWLIST` is the
buyer's human declining to authorise the spend, `SCOPE.MERCHANT_CATEGORIES` is
the seller declining to sell it through an agent. Different parties, different
refusals, and an audit trail that says which.

## 14. Money rule

All money is **integer paise**, branded type `Paise`. No floats anywhere. Zod
rejects non-integers at every boundary. Razorpay amounts are paise by definition.

## 15. Constraints

- Razorpay **test mode only**. Test UPI: `success@razorpay` / `failure@razorpay`.
- Webhook signature: `HMAC_SHA256(rawBody, webhookSecret)` -> `X-Razorpay-Signature`.
  Never parse the body before verifying. Dedupe on `x-razorpay-event-id`.
  Handle out-of-order delivery.
- Checkout signature: `HMAC_SHA256(order_id + "|" + payment_id, keySecret)`.
- Order `receipt` <= 40 chars and unique. `notes` <= 15 pairs, <= 256 chars each.
- Secrets live only in `.env` (git-ignored). `.env.example` is committed.

## 16. Protocol alignment

| Ecosystem primitive | Our implementation |
|---|---|
| UAP / UPI Reserve Pay — single block, multiple debits, residual auto-release | `ReserveMandate` envelope; Dwaar draws down per purchase; releases residual on close |
| AP2 Intent / Cart / Payment Mandates | `ReserveMandate` (human-signed) -> `CartMandate` (Dwaar-signed) -> `intent_token` (single-use) |
| AP2 Human-Present / Not-Present | Explicit field; above-threshold spend forces Human-Present step-up |
| ACP Delegated Payment (single-use, capped, expiring) | `intent_token`: nonce'd, TTL'd, consumed in the same DB transaction as the order |
| A2A Agent Card discovery | `/.well-known/agent.json` (live) |
| UCP / ACP capability + product feed | `/api/feed/{merchant_id}` (live) |
| Instant revocation | Global freeze flag -> `CIRCUIT.FROZEN` |

## 17. Glossary

- **Dwaar** — the deterministic policy gate. Pure function, no I/O, no LLM.
- **Sakshi** — the append-only, hash-chained audit ledger.
- **ReserveMandate** — human-signed budget envelope (Reserve-Pay-shaped).
- **CartMandate** — Dwaar-signed, hash-bound priced cart.
- **intent_token** — single-use, TTL'd authorization for exactly one money action.
- **Dwaar decision** — `ALLOW` | `ALLOW_WITH_STEPUP` | `DENY`, plus `RuleEval[]`.
- **Drift** — LLM-quoted amount != Dwaar-computed amount. Always a hard `DENY`.
