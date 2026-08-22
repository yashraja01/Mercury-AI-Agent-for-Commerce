# DEVLOG — Mercury

> Append-only. Newest first. Update at the end of every session.
> Stable project truth lives in CONTEXT.md — do not duplicate it here.

## Prerequisites

| # | Task | Status | Notes |
|---|---|---|---|
| P1 | Node 20+ and npm installed | ☑ done | Node v24.16.0, npm 11.17.0 |
| P2 | `ANTHROPIC_API_KEY` in `.env` | ☐ | Needed from M4 |
| P3 | Create free Razorpay account -> generate **test-mode** key id + secret | ☐ | Not blocking: M0–M7 run on `FixtureRail` |
| P4 | Set a webhook secret in the Razorpay dashboard | ☐ | Needed for M8 live webhooks |
| P5 | `cloudflared` or `ngrok` installed | ☐ | M8 only |

## Active tasks

| # | Task | Status | Notes |
|---|---|---|---|
| M0 | Repo foundation + CONTEXT.md/DEVLOG.md | ☑ done | npm workspaces, TS strict, vitest |
| M1 | `core` + `sakshi` | ☐ todo | Paise, canonical JSON, hash chain, `verify` CLI |
| M2 | `dwaar` | ☐ todo | pure `evaluate()`, MerchantProfile, fast-check |
| M3 | `rail` + FixtureRail | ☐ todo | port iface, recorded fixtures, both HMACs, webhooks |
| M4 | `agent` + two personas | ☐ todo | shared strict tools, drift detection |
| M5 | Mission Control UI | ☐ todo | Negotiation Theatre, Dwaar panel, Sakshi explorer |
| M6 | MCP server + Agent Card + feed | ☐ todo | external Claude buys end-to-end |
| M7 | Chaos Console — verify F1–F7 | ☐ todo | all failure-audit rows green |
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

## Failure-recovery audit

> One row per engineered failure. Verified only when the recovery is observed
> end-to-end **and** Sakshi shows the expected `rule_ids`.
> All seven are reproducible on `FixtureRail` — no network required.

| # | Failure | Injection | Expected recovery | Sakshi events | Status |
|---|---|---|---|---|---|
| F1 | Parameter drift | Adversarial buyer pushes agent below margin floor | Hard DENY, clamp to floor, agent re-quotes. **No Razorpay call made** | `DRIFT_BLOCKED`, `REPRICED` | ☐ |
| F2 | Payment decline | `failure@razorpay` | <=2 bounded retries re-checked against remaining envelope, then UPI Payment Link fallback | `PAYMENT_FAILED`, `RETRY_BOUNDED`, `STEPUP_ISSUED` | ☐ |
| F3 | Inventory race | Two agents, last unit, concurrent | `BEGIN IMMEDIATE` + conditional UPDATE; loser denied. If captured -> automatic refund | `INVENTORY_CONFLICT`, `AUTO_REFUND_ISSUED` | ☐ |
| F4 | Forged webhook | Bad `X-Razorpay-Signature` | 400; **order state unchanged**; genuine webhook then processes | `WEBHOOK_REJECTED` | ☐ |
| F5 | Out-of-order / duplicate webhook | `captured` before `authorized`, then replay | Dedupe on `x-razorpay-event-id`; monotonic FSM converges; replay is a no-op | `WEBHOOK_DEDUPED` | ☐ |
| F6 | Mandate breach | Purchase exceeding remaining envelope | DENY with exact observed/limit paise. **Zero Razorpay calls** | `MANDATE_BREACH_BLOCKED` | ☐ |
| F7 | Token replay | Reuse a spent `intent_token` | DENY `TOKEN.REPLAY`; no duplicate order | `REPLAY_BLOCKED` | ☐ |

## Changelog

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
