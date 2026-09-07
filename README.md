# Mercury - an AI Agent for Commerce

Built for the Razorpay Buildathon Challenge 2026.

Mercury is a demo of two AI agents doing business with each other: one representing a buyer, one representing a merchant. They negotiate a purchase, but neither of them is allowed to actually move money. A separate, simple rule-checker sits in between and decides whether a payment is allowed to go through. Every decision, approved or denied, gets written to a log that can't be quietly edited later.

Short version: the AI agents propose a deal, a plain rulebook approves or rejects it, Razorpay handles the actual payment, and a hash chain keeps a permanent, checkable record of what happened.

## Why this exists

AI shopping agents are starting to show up everywhere: an assistant that finds you the best grocery price, or a business's agent that reorders its own stock automatically. The obvious problem is trust. Would you actually let an AI spend your money with no checks and no paper trail?

This project is an attempt to show one way to do that safely:

- The AI can only suggest a price or a deal. It never has the ability to authorize a payment itself.
- A separate piece of code called Dwaar (Hindi for gate or doorway) checks every deal against fixed rules, things like spending caps, minimum profit margins, and category restrictions, before any money is allowed to move. Dwaar has no AI in it at all, it's just deterministic logic.
- Every decision gets recorded in Sakshi (Hindi for witness), an append-only log where each entry is chained to the one before it with a hash. If anyone tried to alter an old entry, the chain would break and be detectable.
- Razorpay handles the actual payment processing, in test mode only. No real transactions happen.

The basic idea, put simply: the AI proposes, the gate decides.

## What the two core pieces actually do

- **Dwaar** is the gate. It's a plain function that takes a proposed deal and either allows it, allows it with extra approval required, or denies it. It never calls an AI model and never talks to Razorpay directly.
- **Sakshi** is the witness. It just keeps an append-only record of everything that happened, so anyone can go back and independently verify the whole history wasn't tampered with.

Even if the AI agent gets a price wrong, Dwaar throws that number out and recalculates the real total itself from the actual product catalog. A bad answer from the AI can never turn into a wrong charge.

## What it can actually do

Mercury is built to work for two different situations, using the same gate and the same ledger underneath. Only the data and the prompts change between them.

1. A household's shopping agent negotiating a weekly grocery order with a store's agent.
2. A small business's procurement agent negotiating a bulk order with suppliers, including splitting one payment across multiple sellers.

The merchant's agent can also try to grow the sale in a few limited ways: suggesting a bundle from a different product category (only if the buyer seems open to it), offering a bulk discount for a bigger order, or substituting an out of stock item with the closest available match. All of these are capped by hard limits, like a minimum margin, that the AI can't get around no matter what it tries to offer.

## What you'll see when you run it

There are two screens.

**Mission Control** (the homepage) lets you watch the negotiation happen step by step: the buyer's and merchant's offers, what Dwaar approved or denied and why, and the audit log building and verifying in real time. There's also a section for deliberately breaking things (bad signatures, dropped connections, etc.) to check that the system catches and logs every failure correctly.

**Merchant Console** shows the seller's side: how much extra the agent earned compared to a flat price list, what the agent is and isn't allowed to do (with editable settings), and recent orders.

## Tech stack

- TypeScript
- Next.js 15
- SQLite (built in, nothing to install separately)
- Claude (Opus 5) through the Anthropic API, for the AI agent
- Razorpay, test mode only
- Zod for validation
- Vitest for tests

## Setup instructions

### What you need first

Just Node.js (a recent LTS version). npm comes with it, and that's the only package manager this project uses.

### 1. Clone the repo

```bash
git clone https://github.com/yashraja01/Mercury-AI-Agent-for-Commerce.git
cd Mercury-AI-Agent-for-Commerce
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up your environment file

Copy the example file:

```bash
cp .env.example .env
```

Then open `.env` and fill in what applies to you:

| Variable | What it does | Do you need it? |
|---|---|---|
| `RAIL_MODE` | `fixture` runs everything offline with simulated payments (this is the default). `live` uses real Razorpay test keys. | No, defaults to `fixture` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Your Razorpay test mode API keys, found in the Razorpay dashboard under Test Mode, then Settings, then API Keys | Only if you set `RAIL_MODE=live` |
| `RAZORPAY_WEBHOOK_SECRET` | Lets the app verify that a webhook actually came from Razorpay | Optional |
| `ANTHROPIC_API_KEY` | Your Claude API key, needed for the AI powered agent to negotiate | Only if you want to use the AI agent instead of the scripted one |
| `MERCURY_MODEL` | Which Claude model to use | No, defaults to `claude-opus-5` |
| `MERCURY_EFFORT` | How much reasoning effort the model uses | No, defaults to `high` |
| `MERCURY_DB` | Where the local database file lives | No, defaults to `./mercury.db` |

If you don't want to set up any API keys at all, you can leave `RAIL_MODE` as `fixture` and use the scripted agent instead of the Claude powered one. It follows the same rules and goes through the same gate, just without calling an LLM. Good for a fast first look.

### 4. Seed the database

This sets up a local database with sample products, test accounts, and a starter wallet for the buyer agent.

```bash
npm run seed
```

### 5. Run it

```bash
npm run dev
```

Open http://localhost:3000. This one command starts everything: Mission Control, the merchant console, and the buyer facing API.

## Other commands worth knowing

| Command | What it does |
|---|---|
| `npm run demo` | Runs the whole negotiation flow in the terminal, no browser and no API key needed |
| `npm run chaos` | Deliberately breaks things (bad signatures, dropped connections, etc.) and checks the system handles each case correctly |
| `npm run verify` | Independently re-walks the entire audit log to confirm it hasn't been altered |
| `npm test` | Runs the full test suite, 232 tests, no API key or internet needed |
| `npm run conformance` | Checks that public data, like the product feed, doesn't accidentally expose private info such as cost or margins |
| `npm run build` | Builds the project for production |

## A note on safety

This only ever runs against Razorpay's test mode. No real payments happen. Don't use production keys with this project. Your `.env` file is already excluded from git through `.gitignore`, so keep any real keys there and never commit them.

## Project structure

```
apps/       the runnable apps (the web app, and the MCP server for AI agents to connect to)
packages/   the shared logic (the gate, the ledger, the payment layer, etc.)
prompts/    the instructions given to the AI agent
scripts/    helper scripts for seeding data, running demos, verifying the ledger, and chaos testing
```

For a full technical breakdown of how everything fits together, see `CONTEXT.md` in this repo. Project history and decisions along the way are in `DEVLOG.md`.

## Built for

This was built as a submission for the Razorpay Buildathon, as an exploration of what it takes to make AI to AI commerce both possible and something you can actually trust.
