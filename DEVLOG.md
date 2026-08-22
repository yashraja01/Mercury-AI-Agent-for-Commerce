# DEVLOG — Mercury

> Append-only. Newest first. Update at the end of every session.
> Stable project truth lives in CONTEXT.md — do not duplicate it here.

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
| M6 | MCP server + Agent Card + feed | ☐ todo | external Claude buys end-to-end |
| M7 | Chaos Console -- verify F1--F7 | ☐ todo | all failure-audit rows green |
| M8 | Hardening | ☐ todo | LiveRail on test keys, Route (B2B), feed conformance, deploy, video |

Blocked: —

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

## Failure-recovery audit

> One row per engineered failure. Verified only when the recovery is observed
> end-to-end **and** Sakshi shows the expected `rule_ids`.
> All seven are reproducible on `FixtureRail` — no network required.

| # | Failure | Injection | Expected recovery | Sakshi events | Status |
|---|---|---|---|---|---|
| F1 | Parameter drift | Adversarial buyer pushes agent below margin floor | Hard DENY, clamp to floor, agent re-quotes. **No Razorpay call made** | `DRIFT_BLOCKED`, `REPRICED` | ☑ |
| F2 | Payment decline | `failure@razorpay` | <=2 bounded retries re-checked against remaining envelope, then UPI Payment Link fallback | `PAYMENT_FAILED`, `RETRY_BOUNDED`, `STEPUP_ISSUED` | ☐ |
| F3 | Inventory race | Two agents, last unit, concurrent | `BEGIN IMMEDIATE` + conditional UPDATE; loser denied. If captured -> automatic refund | `INVENTORY_CONFLICT`, `AUTO_REFUND_ISSUED` | ☐ |
| F4 | Forged webhook | Bad `X-Razorpay-Signature` | 400; **order state unchanged**; genuine webhook then processes | `WEBHOOK_REJECTED` | ☐ |
| F5 | Out-of-order / duplicate webhook | `captured` before `authorized`, then replay | Dedupe on `x-razorpay-event-id`; monotonic FSM converges; replay is a no-op | `WEBHOOK_DEDUPED` | ☐ |
| F6 | Mandate breach | Purchase exceeding remaining envelope | DENY with exact observed/limit paise. **Zero Razorpay calls** | `MANDATE_BREACH_BLOCKED` | ☑ |
| F7 | Token replay | Reuse a spent `intent_token` | DENY `TOKEN.REPLAY`; no duplicate order | `REPLAY_BLOCKED` | ☑ |

## Changelog

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
