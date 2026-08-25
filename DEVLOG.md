# DEVLOG — Mercury

> Read **Start here next session** first if you are picking this up cold;
> read CONTEXT.md before that if you have never seen the project.
>
> The changelog is append-only, newest first. Everything above it is living
> state and should be edited in place. Stable project truth lives in
> CONTEXT.md — do not duplicate it here.

## Prerequisites

| # | Task | Status | Notes |
|---|---|---|---|
| P1 | Node 20+ and npm installed | ☑ done | Node v24.16.0, npm 11.17.0 |
| P2 | `ANTHROPIC_API_KEY` in `.env` | ☐ | Only for `npm run demo -- --llm`; the scripted agent needs no key |
| P3 | Create free Razorpay account -> generate **test-mode** key id + secret | ☐ | Not blocking: M0–M7 run on `FixtureRail` |
| P4 | Set a webhook secret in the Razorpay dashboard | ☐ | Needed for M8 live webhooks |
| P5 | `cloudflared` or `ngrok` installed | ☐ | M8 only |

## Active tasks

| # | Task | Status | Notes |
|---|---|---|---|
| M0 | Repo foundation + CONTEXT.md/DEVLOG.md | ☑ done | npm workspaces, TS strict, vitest |
| M1 | `core` + `sakshi` | ☑ done | Paise, canonical JSON, Ed25519, hash chain, `verify` CLI |
| M2 | `dwaar` | ☑ done | pure `evaluate()`, MerchantProfile, auto-repair, fast-check |
| M3 | `rail` + FixtureRail | ☑ done | port iface, recorded fixtures, both HMACs, webhook gate |
| M3.5 | `store` + `Engine` | ☑ done | SQLite working state, orchestration, `BEGIN IMMEDIATE` locking |
| M4 | `agent` + two personas | ☑ done | negotiator port, shared strict tools, seed + demo |
| M5 | Mission Control UI | ☑ done | Negotiation Theatre, Dwaar panel, Sakshi explorer, SSE, freeze |
| M6 | MCP server + Agent Card + feed | ☑ done | external Claude buys end-to-end; `npm run mcp:smoke` |
| M6.5 | Levers, proof-of-holder, compensation | ☑ done | Goal 1 mechanised; buyer API signed; F2/F3 wired |
| M7 | Chaos Console -- verify F1--F7 | ☑ done | 7/7 rows green; `npm run chaos` and a UI panel |
| M8 | Hardening | ◐ part | Route (B2B) done; LiveRail verified as far as keys allow. Feed conformance, deploy, video outstanding |

Blocked: —

## Start here next session

**State:** M0-M7 committed and green, plus the first slice of M8. 193 tests,
build clean, chain verifies, and all seven failure-audit rows verify against the
running app. Nothing is half-finished.

**Sanity check before writing code:**

```bash
npm install && npm run build && npm test    # expect 193 passed
npm run seed && npm run demo                # both verticals, terminal
npm run dev                                 # then, elsewhere:
npm run chaos                               # expect 7/7 rows verified
npm run mcp:smoke
```

**The next work, in the order I would do it.** M8 is part done: Route landed,
and the webhook route is wired to a real secret. What is left needs either an
account we do not have or a human.

| # | Task | Why now | Size |
|---|---|---|---|
| 1 | Feed + Agent Card conformance (`npm run conformance`) | The feed claims UCP/ACP shape and nothing checks it. Cheap, and it must also assert `supplier_account_id` never leaks into a public feed | small |
| 2 | `npm run live:smoke` against real `rzp_test_` keys | LiveRail's HTTP calls have never run. The webhook half is now proven; the API half is not | small, **needs a Razorpay account** |
| 3 | Deploy: Dockerfile, `/api/health`, SQLite volume notes | Nothing is deployed, and SQLite on a container needs a real disk or the ledger dies with the pod | medium, **needs a hosting account** |
| 4 | Write `BasketValue` into Sakshi + show uplift | The Goal 1 metric exists on the negotiation result and nobody can see it | small |
| 5 | Lever tools for `LlmRevenueAgent` | With Claude driving, Goal 1 reverts to a flat discount; the scripted agent has levers and the LLM one does not | medium |
| 6 | Run the LLM path once with a real key | `LlmRevenueAgent` has **never executed** | small, needs `ANTHROPIC_API_KEY` |
| 7 | Demo video | A runbook exists in nobody's head but mine | **needs a human** |

**Known gaps, stated plainly:**

- `LlmRevenueAgent` is unproven against the real API (item 6).
- `inferCart` is keyword matching where buyer intent enters the system. It fails
  safe -- a misread costs a negotiation round, never money -- but it is the
  weakest link in the default path.
- `npm audit` reports 3 high advisories from Next 15's own postcss/sharp.
  Clearing them means Next 16, a framework major, and that is the user's call.
- `credit_terms` is declared as a lever and implemented by nothing. It is
  discussed in the B2B persona as a closing lever the agent may not price, which
  is defensible, but it is not mechanised like the other three.
- The chaos bench spends real demo budget: one debit of eight and Rs 570 per
  full pass, so eight passes from a fresh seed. This is now handled rather than
  merely known -- rows preflight the bench, report `blocked` instead of failing,
  and the panel offers Reset -- but the ledger still grows about 38 entries per
  pass, which is worth knowing before a demo.
- LiveRail's **API** calls are still unexercised: no order has ever been created
  against api.razorpay.com. Its **webhook** half is now proven -- a body signed
  with `openssl dgst -sha256 -hmac`, which is exactly how Razorpay signs, is
  accepted in live mode and rejected when tampered with.
- Route's transfers are exercised only on `FixtureRail`. The split arithmetic is
  property-tested and cannot lose a paisa; whether a real linked account accepts
  the transfer is untested, because there is no real linked account.

**Operational gotchas, all learned the hard way:**

- **Do not run `npm run build` while `npm run dev` is running.** Both write
  `apps/web/.next`; the dev server 500s until restarted. Standard Next
  behaviour, bit us three times.
- **`npm run seed` has no effect on a running gateway.** The server holds its
  own open SQLite handle. Use Mission Control's Reset button, or restart.
- **Reset re-mints agent keys**, so `buyer-wallet.json` is rewritten. Any buyer
  holding old keys starts failing `HOLDER.SIGNATURE`. Both seed paths write the
  wallet through `writeWallet()` so they cannot drift.
- **Paths anchor to the repo root, not cwd.** `next dev` runs from `apps/web`;
  before this was fixed the app kept a second database there and the two stores
  silently disagreed.
- **`scripts/` is typechecked separately** (`tsc --noEmit -p scripts/tsconfig.json`,
  wired into `build` and `typecheck`) because it is not in the composite graph.
- Killing the dev server on Windows: the npm wrapper survives a plain
  `taskkill`. Kill by port instead --
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`.
- **Do not use Python single-quoted strings to write regexes into source.** `\b`
  becomes a literal backspace byte and the pattern silently stops matching. Use
  raw strings, or the Write/Edit tools.

## Key decisions

| # | Date | Decision | Rationale | Alternatives rejected |
|---|---|---|---|---|
| D1 | 2026-08-22 | Merchant-side negotiation rail, not a protocol gateway | Protocols cover buyer authority + checkout; the merchant side (verify mandate, enforce own limits, prove afterwards) is unclaimed | Pure ACP/AP2 gateway (thin on AI judgment); autonomous replenishment (UPI Autopay too fiddly in test mode) |
| D2 | 2026-08-22 | Model the mandate on **UPI Reserve Pay** (single block, multiple debits, residual auto-release) | The actual NPCI rail behind Razorpay's Claude pilot, and a budget envelope with a rail-level leakage guarantee | Per-transaction caps only (no residual story); AP2 mandates alone (not India-native) |
| D3 | 2026-08-22 | LLM proposes, Dwaar disposes — LLM-quoted amount discarded | Only structural way to guarantee zero hallucinated transactions | Validating the LLM's number (still trusts the LLM); a second LLM as checker (non-deterministic) |
| D4 | 2026-08-22 | SQLite + better-sqlite3, not Postgres | Judges clone and run in 30s; `BEGIN IMMEDIATE` gives real inventory locking without Redis | Postgres+Redis (setup friction); in-memory (no audit persistence) |
| D5 | 2026-08-22 | Our own gateway is the execution point, **not** Razorpay's MCP server | Routing execution through an MCP server puts an LLM in the money path — the anti-pattern the rubric punishes | Razorpay MCP as executor (cited as composability, not used) |
| D6 | 2026-08-22 | Single Next.js app + one MCP binary | "Easy setup" is a scored line; more services = more failure surface | Separate Fastify gateway (cleaner on paper, worse to run) |
| D7 | 2026-08-22 | Two living docs (CONTEXT.md stable / DEVLOG.md volatile) | Continuity across sessions without re-deriving context | Single README (mixes stable and volatile, rots fast) |
| D8 | 2026-08-22 | Buyer transport = MCP + static A2A Agent Card; ACP shapes documented, not separately implemented | MCP is the working transport; the Agent Card is a file. Parallel ACP REST endpoints would be duplicated surface for no extra rubric credit | Full ACP REST implementation alongside MCP |
| D9 | 2026-08-22 | Two verticals, **one gate** — only data + prompts differ | Turns "vertical-agnostic" from a claim into a demonstrated property. A vertical needing a change inside Dwaar is a design bug -> add a `MerchantProfile` field | One vertical (weaker architecture claim); two gates (defeats the point) |
| D10 | 2026-08-22 | `rail` behind a port; **FixtureRail is the default**, LiveRail added at M8 | No Razorpay account yet — but better regardless: offline deterministic tests, programmable failure injection, no tunnel needed for F4/F5 | Blocking on account creation; ad-hoc mocking inside tests (untyped, drifts from real shapes) |
| D11 | 2026-08-22 | Naming: **Mercury** / **Dwaar** (द्वार, gate) / **Sakshi** (साक्षी, witness) | Mercury is the god of commerce (*merx* -> *merchant*). Dwaar is a checkpoint every rupee passes through — the rubric's own word is *gated*. Sakshi is the witness that observes without participating, exactly what an append-only ledger is | Kavach (armour — passive defence, weaker fit for a gate); Bahi-Khata (ledger book — accurate but descriptive rather than evidentiary) |
| D12 | 2026-08-22 | **npm workspaces**, not pnpm | `corepack enable pnpm` needs admin on this machine (EPERM). More importantly npm ships with Node, so a judge needs zero extra installs — and "easy setup" is a scored rubric line | pnpm (requires install/admin); yarn (same problem); Turborepo (unnecessary for 7 packages) |
| D13 | 2026-08-22 | `agent` behind a **negotiator port**, with `ScriptedRevenueAgent` as the default and `LlmRevenueAgent` alongside it | Same argument as D10, one layer up. The whole suite and every failure scenario must run with no API key, no network and no spend, or they stop being run. The scripted agent is not a mock of the system — it calls the same tool implementations and submits through the same gate; only the judgement is substituted | LLM-in-the-test-loop (non-deterministic, costs money, fails offline); mocking the Anthropic client (asserts our mock, not our gate) |
| D14 | 2026-08-23 | Seed data moved into a `@mercury/seed` workspace package | Both the CLI seed script and the web app's reset need it, and a bundler cannot reliably reach loose `.ts` files outside the app directory. It also gives M6's MCP server the same fixtures | Keeping `db/seed/*.ts` and importing across the app boundary (fragile resolution); duplicating the fixtures (two sources of truth) |
| D15 | 2026-08-23 | Tailwind v4 with hand-built components, not shadcn/ui | Mission Control is about eight distinct elements. shadcn adds a generator, a `components/ui` tree and Radix for controls we do not need, and its defaults are exactly the look the UI should not have. CONTEXT updated | shadcn/ui (as originally planned in the stack table) |
| D16 | 2026-08-23 | The MCP server is a **thin HTTP client of the gateway**, not a second copy of the engine | Keeps D5's single execution point literally true: one store, one ledger, one rail instance. A purchase made from Claude Desktop therefore appears live in Mission Control, and there is exactly one place where money moves | Giving the MCP process its own Store/Engine (two rails, two in-memory order sets, a demo that silently diverges from what the browser shows) |
| D17 | 2026-08-23 | No buyer-facing surface accepts a price -- no total, no unit price, no discount | An MCP tool taking `total_paise` from its caller puts an LLM back in the money path, which is the exact anti-pattern the architecture exists to prevent. The buyer sends a sentence; the merchant's agent proposes; Dwaar prices | A conventional `create_cart(items, total)` tool shape (familiar, and quietly fatal) |
| D20 | 2026-08-25 | The Chaos Console drives the failure rows over **HTTP**, against the app's own routes | F4 and F5 were ticked in the audit table for two milestones on the strength of unit tests against a class, while no HTTP route existed at all. A drill that calls the engine in-process would have reproduced exactly that blind spot. `runChaos` takes the request's own origin and posts real deliveries, so the thing being verified is the surface Razorpay actually reaches | Calling `Engine.handleWebhook` directly from the console (faster, and blind to every routing, header and raw-body mistake); a separate chaos harness with its own store (would prove a copy of the system works) |
| D21 | 2026-08-25 | Chaos rows preflight the bench and report `blocked`, and Reset is never automatic | A setup denied for lack of budget looks exactly like the failure the row is testing, so the two must be visibly different or the table stops being evidence. Auto-resetting would fix the bench by deleting the ledger, which is the one thing the product asks to be trusted on | Auto-reset on exhaustion (destroys the audit trail to keep a demo tidy); a bigger seed mandate (moves the cliff, does not remove it); letting the row fail (trains everyone to ignore red) |
| D22 | 2026-08-25 | A failed Route transfer leaves the capture standing | The buyer paid correctly and the goods are theirs; the money is the merchant's at capture. A stuck payout between two of the merchant's own accounts is an operator's problem, and refunding a blameless buyer to tidy it up would be a worse outcome for everyone | Refunding on transfer failure (punishes the buyer for a supplier's onboarding); retrying inline (turns a settlement into an unbounded loop inside a request) |
| D18 | 2026-08-23 | The delegated agent's **public key lives inside the signed mandate** | The human is not authorising "an agent", they are authorising exactly one key. It makes proof-of-holder verifiable by anyone holding the mandate -- no registry lookup, no shared secret, no trust in our own database -- and it means a stolen mandate id buys nothing | A separate agent-key registry (one more thing to keep in sync, and it moves trust into our DB); signing with the principal's own key (that is the human's key, not the agent's) |
| D19 | 2026-08-23 | `bundle` needs the buyer's invitation; `bulk_tier` and `substitute` do not | A tier and a substitution answer what the buyer asked for. A bundle changes *what is in the cart*, and an agent that appends a line to every basket is padding -- which the persona prompt already forbids, so the code should too | Always bundling (higher AOV, bad faith); never bundling (Goal 1 stays unimplemented) |

## Failure-recovery audit

> One row per engineered failure. Verified only when the recovery is observed
> end-to-end **and** Sakshi shows the expected `rule_ids`.
> All seven are reproducible on `FixtureRail` — no network required.

| # | Failure | Injection | Expected recovery | Sakshi events | Status |
|---|---|---|---|---|---|
| F1 | Parameter drift | Adversarial buyer pushes agent below margin floor | Hard DENY, clamp to floor, agent re-quotes. **No Razorpay call made** | `DRIFT_BLOCKED`, `REPRICED` | ☑ |
| F2 | Payment decline | `failure@razorpay` | <=2 bounded retries re-checked against remaining envelope, then UPI Payment Link fallback | `PAYMENT_FAILED`, `RETRY_BOUNDED`, `STEPUP_ISSUED` | ☑ |
| F3 | Inventory race | Two agents, last unit, concurrent | `BEGIN IMMEDIATE` + conditional UPDATE; loser denied. If captured -> automatic refund | `INVENTORY_CONFLICT`, `AUTO_REFUND_ISSUED` | ☑ |
| F4 | Forged webhook | Bad `X-Razorpay-Signature` | 400; **order state unchanged**; genuine webhook then processes | `WEBHOOK_REJECTED` | ☑ |
| F5 | Out-of-order / duplicate webhook | `captured` before `authorized`, then replay | Dedupe on `x-razorpay-event-id`; monotonic FSM converges; replay is a no-op | `WEBHOOK_DEDUPED` | ☑ |
| F6 | Mandate breach | Purchase exceeding remaining envelope | DENY with exact observed/limit paise. **Zero Razorpay calls** | `MANDATE_BREACH_BLOCKED` | ☑ |
| F7 | Token replay | Reuse a spent `intent_token` | DENY `TOKEN.REPLAY`; no duplicate order | `REPLAY_BLOCKED` | ☑ |

## Changelog

### 2026-08-25 — M8 (part): Route, the bench, and a real webhook secret

Three things, two of them the "pre-M8" items and one the first real slice of M8.

**The bench is no longer a trap.** Rows that need a live order now preflight the
demo mandate before injecting anything, and a spent bench reports `blocked` --
brass, "not a failure" -- rather than red. It is a real distinction: a denied
*setup* produces exactly the symptoms of the failure the row exists to test, and
a table that cannot tell the two apart is a table nobody trusts. `benchStatus()`
reports debits, envelope and stock, the panel shows them with a Reset button
once a single pass is left, and `npm run chaos -- --reset` does the same
headlessly. Exit codes now separate the cases: 0 verified, 1 failed, 3 blocked.

Reset stays a button and never fires by itself. It destroys the database, and
Sakshi is the artifact this whole product asks to be trusted on; topping up a
bench is not a good enough reason to delete the evidence.

D21: the bench cost is **measured, not estimated** -- one pass costs one debit,
Rs 570 and four bags of rice, taken from a freshly seeded run. The first version
counted the ghee as a per-run cost and reported "1 full pass left" on a fresh
bench, because the seed stocks exactly one tin and F3 refunds it. Stock that
comes back is a level, not a drain.

**The webhook secret is read from the environment, once.** `RAZORPAY_WEBHOOK_SECRET`
now feeds whichever rail is in use, so setting it makes `/api/webhook/razorpay`
verify genuine Razorpay deliveries *without* switching `RAIL_MODE` -- the move
from fixture to live is a change of environment, not of code. A missing secret
in live mode answers **503 not_configured** instead of a signature mismatch:
otherwise every genuine delivery would be recorded in Sakshi as a rejected
webhook, and the audit trail would fill with attacks that never happened.

Verified without a Razorpay account, by signing a body with
`openssl dgst -sha256 -hmac` -- the same HMAC Razorpay computes: genuine 200,
tampered 400, unset 503.

**Route: one payment, several sellers.** A wholesale basket is routinely
multi-vendor, and until now the money all landed in one place. `splitByWeight`
divides a captured payment by what each supplier actually sold, using largest
remainder so the legs sum to *exactly* the capture -- property-tested over
random totals and weights, because "we lost a paisa" is the failure mode that
turns into a reconciliation ticket six weeks later. The platform commission
comes off the top, so a supplier's share is never quietly reduced by a fee it
did not agree to.

D22: a **failed transfer does not unwind the capture**. The money is
legitimately the merchant's the moment it is captured; a payout that did not go
through is an operational problem to retry, not a reason to reverse a payment
from a buyer who did nothing wrong. It is recorded either way, with `failed:
true` and the reason.

Quick-commerce sells its own inventory: no line names a supplier, so nothing
splits and no transfer is made. Same engine, same rail, different catalogue --
which is the vertical-agnostic claim (D9) holding under one more kind of load.

193 tests (up from 181), build clean, chain verifies, chaos 7/7.


### 2026-08-25 — M7 the Chaos Console

The failure-audit table stops being a claim in a markdown file and becomes
something you can press.

**The gap this closed.** F4 and F5 were unit-tested at `WebhookGate` and had no
HTTP route at all, so a forged delivery had never been rejected *as a request*
and a duplicate had never been deduped over the wire. Two rows of the audit
table were ticked against code that no request had ever reached.

- `POST /api/webhook/razorpay`: raw body via `req.text()`, HMAC verified against
  those exact bytes before anything parses them. 400 on a bad signature, 200 on
  a duplicate — an error there would only make Razorpay retry harder.
- `Engine.handleWebhook` now *applies* an accepted event instead of only
  recording it. Payment state advances by rank and never regresses, so a
  `captured` that overtakes its own `authorized` converges to `captured` and the
  late event is recorded and discarded. `orders.payment_status` is the new
  column; capture, decline and refund all move it too, which is what makes a
  genuine later delivery a no-op rather than news.
- `apps/web/lib/chaos.ts`: seven rows, each injecting its own fault and then
  checking the recovery — the Sakshi events the row promises, plus the state
  that must not have moved (no `ORDER_CREATED` on a denial, an envelope restored
  to the paisa, exactly one `PAYMENT_CAPTURED` under replay).
- Two front ends, one implementation: a Chaos Console panel in Mission Control
  (tabbed beside the theatre) and `npm run chaos`, which prints the table and
  exits non-zero on any red row.

**Choices worth recording.**

- D20: the chaos rows drive **HTTP**, not the engine. `runChaos` takes the app's
  own origin and posts real requests to its own routes. An in-process call would
  prove the engine works and say nothing about the wire, which is precisely the
  gap that let F4/F5 sit ticked for two milestones.
- The rows that need an order buy one through `quote()` first, so the setup uses
  the same gate as everything else. That makes the bench finite — the demo
  mandate is eight transactions — and a denied *setup* now says so in the check
  detail, with the remaining envelope and "Press Reset", rather than looking
  like the failure it was meant to test.
- A correctly signed event for an order Mercury never created is accepted and
  **not applied**, logged with `applied: false`. The signature proves who sent
  it, not that the claim is ours.

**Observed, not asserted.** `npm run chaos` against a freshly seeded database:
7/7 rows verified, chain intact at 40 entries; a second consecutive run also
7/7 at 78 entries. Five new engine tests cover the same F4/F5 behaviour at the
unit level (181 total, up from 176), and `npm run build` is clean.


### 2026-08-23 — M6.5 levers, proof-of-holder, compensation

Closing the three claims the M6 review found were asserted but not implemented.

**Revenue levers (Goal 1).** `packages/agent/src/levers.ts`: `bulk_tier` (a
5/10/25/50 quantity ladder), `bundle` (an add-on from a different category than
the basket anchor, capped at 40% of basket value), `substitute` (nearest stocked
equivalent, same category). `MerchantProfile.levers` is now read rather than
merely declared — it was previously published in the feed and used by nobody.
- Every lever clamps to `lowestLegalUnit` itself, so it cannot hand the gate a
  price the gate would have to catch. A property test asserts this over 500
  random quantity/margin combinations.
- D19: `bundle` returns a *suggestion* unless the buyer's message invites it.
  A tier answers what was asked for; a bundle changes what is in the cart.
- Uplift is measured, not asserted: `BasketValue` records asked-for versus
  approved, and rides along with the negotiation result.

**Proof of holder (D18).** The mandate now names the delegated agent's Ed25519
public key *inside the signed artifact*. A caller proves it holds the mandate by
signing `{mandate_id, nonce, issued_at}`; Dwaar checks it as four new rules —
`HOLDER.PROOF_MISSING`, `HOLDER.SIGNATURE`, `HOLDER.NONCE_REPLAY`,
`HOLDER.STALE` — *before* it looks at the cart, so a caller who cannot prove
itself never learns whether its basket was affordable.
- Before this, a mandate id was a bearer token: `/api/agent/quote` would spend
  against any id it was handed. It now returns 401.
- Nonces burn in SQLite via a primary-key conflict, which is the only way to
  make "seen it before" atomic under two concurrent replays.
- `npm run seed` mints `buyer-wallet.json` (git-ignored) — the buyer's keys,
  which Mercury verifies against but never holds.

**Compensation (F3's second half).** `Engine.compensate` was dead code. It is
now reachable through `POST /api/ops/undeliverable` and a Mission Control
scenario: gate allows, Razorpay captures, the warehouse finds the stock gone,
and an automatic refund puts the money, the stock and the envelope back.
`ORDER_CREATED` now records its cart lines so compensation knows what to restore.
Deliberately under `/api/ops`, not `/api/agent`: this is the merchant's own
admission, not something a buyer can assert.

**Three bugs found while doing the above:**
- **Two databases.** `next dev` runs with cwd `apps/web`, so `./mercury.db`
  resolved there — the app had been keeping a second store since M5, separate
  from the one `seed`, `demo` and `verify` used. Everything appeared to work;
  the two simply never agreed. Paths are now anchored to the repo root.
- **Reset invalidated the wallet.** Re-seeding mints fresh agent keys, so
  Mission Control's Reset silently broke every signed request. Both seed paths
  now write the wallet through one function.
- **`scripts/` was never typechecked.** It is not in the composite project
  graph, so `tsc --build` never looked at it and a syntactically broken
  `seed.ts` shipped past a green build. `npm run build` and `npm run typecheck`
  now include `tsc --noEmit -p scripts/tsconfig.json`, which immediately found a
  second latent bug (`demo.ts` reading `verdict.brokenAt`, a field that does not
  exist).
- **A literal backspace in a regex.** A Python-driven edit turned `\b` into
  0x08, so the bundle-invitation pattern never matched. Repo scanned for others;
  none.

**Coverage.** 176 tests, up from 137, zero regressions. New: 18 lever tests,
10 holder-proof tests, 5 engine settlement tests covering F2 (bounded retry,
envelope untouched on a payment that never captured) and F3 (refund restores
money, stock and envelope; the race itself settles before anyone pays).

### 2026-08-23 — M6 MCP server, Agent Card, product feed
- `apps/mcp`: six stdio tools — `list_merchants`, `search_catalog`,
  `check_budget`, `request_quote`, `pay`, `read_audit_trail`.
- D16: the MCP server is a thin HTTP client of the gateway, so an external
  Claude's purchase shows up live in Mission Control.
- D17: **no buyer-facing surface accepts a price.** Stated in the Agent Card's
  own `constraints`, enforced by there being no such argument anywhere.
- `/.well-known/agent.json`: A2A Agent Card, including an honest `constraints`
  block — what this merchant will refuse, published up front.
- `/api/feed/{merchant_id}`: UCP/ACP-shaped feed. Integer paise with an explicit
  currency and minor unit; availability from real stock. Landed cost and the
  margin floor are absent, because a feed is public.
- `/api/agent/{quote,pay,mandate,audit}`: the transaction API behind the tools.
- `npm run mcp:smoke` drives the whole thing over real stdio JSON-RPC:
  discovery -> budget -> negotiate -> pay -> replay refused -> audit verified.

Three bugs the MCP path exposed that the UI never could, because Mission
Control's scenarios pass explicit carts while a buyer sends a sentence:
- `inferCart` matched SKUs on packaging words — "a pack of tea" returned tea,
  biscuits *and* soap, because "pack" is in all three titles. Now filtered
  through a not-a-product list, matched on word boundaries, most specific first.
- It only read digits, so "eight bags of rice" quantified as one. Written
  numbers now count, and the quantity scan steps over the item's own title words
  while stopping dead at another product's, so "two bags of rice and eight packs
  of tea" no longer gives the rice eight.
- `pay` minted a fresh session id, orphaning the capture from the negotiation
  that caused it. The session now threads through, so a buyer reads back
  `OFFER_PROPOSED -> DWAAR_DECISION -> ORDER_CREATED -> PAYMENT_CAPTURED ->
  REPLAY_BLOCKED` as one trace.

- Note: `npm run seed` while the gateway is running has no visible effect — the
  server holds its own open handle. Use the UI's Reset, or restart the server.
- 137 tests green, build clean, chain verifies.

### 2026-08-23 — M5 Mission Control
- `apps/web`: Next.js 15 App Router, Tailwind v4, one page and six routes.
- The Negotiation Theatre streams over **SSE** rather than returning one JSON
  body. A verdict that arrives with its outcome already known is a report; the
  panel exists to show the gate deciding, in order.
- Three panels, all spectators: theatre, Dwaar (agent-quoted vs Dwaar-computed,
  then every rule with observed and limit), Sakshi (`prev_hash <- hash` per row,
  with a live `verify` that re-walks the whole chain).
- Seven scenarios on the bench. Four reproduce a failure-audit row: F1 twice
  (below-floor under buyer pressure, and a one-paisa arithmetic lie), F6, F2.
  Plus a freeze kill switch that puts `CIRCUIT.FROZEN` in front of everything.
- D14: seed data moved to `@mercury/seed` so the app and the CLI share fixtures.
- D15: hand-built Tailwind components instead of shadcn/ui.
- Two fixes found by looking at the running UI rather than at the tests:
  - `gateVia` now surfaces Dwaar's own total on a **drift** denial (the drift
    rule's `limit` is that figure). Without it, the one scenario that exists to
    show the two numbers side by side could not show them.
  - The scripted agent no longer reads rule ids and paise counts aloud to the
    buyer. A rule id is an operator's fact; the buyer gets a plain sentence, and
    the exact rule stays in the verdict panel and the ledger.
- Known rough edges: `npm run build` writes `apps/web/.next`, so it will break a
  `npm run dev` running at the same time (standard Next behaviour). `npm audit`
  reports 3 high advisories from Next 15's own postcss/sharp; fixing them means
  Next 16, which is a framework major and the user's call.
- 134 tests green, production build clean, chain verifies.

### 2026-08-22 — M4 agent + two personas
- `@mercury/agent` completed: negotiator port, shared strict tool surface,
  prompt loading, an LLM implementation and a deterministic one.
- D13 recorded: the negotiator sits behind a port, and the **scripted** agent is
  the default — the whole suite runs with no API key, no network and no spend.
- Tool surface (`search_catalog`, `price_floor`, `submit_offer`) is one set for
  both verticals, `strict: true` with `additionalProperties: false`, defined once
  in Zod so the wire schema and the runtime type cannot drift apart. `cost_paise`
  is absent from every view the agent sees, so landed cost never enters a prompt.
- Prompt caching: the cached prefix is `tools -> system`, both frozen for the
  life of a merchant. Volatile turn state goes in a mid-conversation
  `{role:"system"}` message *after* the breakpoint, so injecting a Dwaar verdict
  or an envelope balance costs nothing in cache terms. Adaptive thinking with
  `output_config.effort` from `MERCURY_EFFORT`.
- `gateVia()` is the only thing an agent can reach: `submit(proposal) ->
  GateFeedback`. No store, no ledger, no rail, no key.
- `prompts/`: `system.core.md` (shared, byte-identical across verticals) plus
  three personas. Asserted in a test — if the shared half ever forks, the cache
  prefix splits and the test fails.
- `db/seed/mandates.ts` + `scripts/seed.ts`: both verticals, both mandate
  archetypes (weekly Human-Not-Present envelope; large Human-Present deal).
- `scripts/demo.ts`: the Negotiation Theatre on a terminal. Both verticals
  negotiate, get gated, settle on FixtureRail, and fail a token replay.
- F1, F6 and F7 now observed end to end with the expected Sakshi events. F1 is
  reachable on two paths: the agent re-quoting after a denial (`autoRepair:
  false`, what the demo shows) and the engine clamping to the floor itself.
- Test timeout raised to 60s: the Dwaar property tests verify a real Ed25519
  signature per case and were being cut off at the 5s default.
- Removed the `npm run guard` script: it pointed at a `scripts/guard.ts` that
  was never written.
- Note on D4: the store uses Node's built-in `node:sqlite` (`DatabaseSync`), not
  `better-sqlite3`. Same decision, one fewer dependency; CONTEXT.md now says so.
- 134 tests green, chain verifies, `npm run build` clean.

### 2026-08-22 — M0 foundation
- Repo scaffolded: npm workspaces, 5 packages + 2 apps, TS strict with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- `CONTEXT.md` and `DEVLOG.md` written.
- D12 recorded: npm workspaces over pnpm (corepack EPERM + zero-install for judges).

### 2026-08-22 — Phase 1 planning
- Industry research completed (protocol layers, discovery, bounded payment gates).
- Key finding: Razorpay + NPCI shipped agentic payments on Claude (20 Feb 2026)
  on UPI Reserve Pay, with merchant-scoped, instantly revocable spend limits.
  Our mandate model is aligned to that, not invented.
- Scope locked: both verticals on one gate (D9); FixtureRail-first (D10);
  full M0–M8 on a week-plus timeline.
- Naming locked: Mercury / Dwaar / Sakshi (D11).
