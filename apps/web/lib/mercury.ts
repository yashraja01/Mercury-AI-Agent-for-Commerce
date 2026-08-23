import "server-only";
import { existsSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Engine } from "@mercury/agent";
import { hashValue } from "@mercury/core";
import { FixtureRail, LiveRail, type RazorpayPort } from "@mercury/rail";
import { ALL_ITEMS, ALL_MERCHANTS, seedPrincipals, writeWallet } from "@mercury/seed";
import { Sakshi } from "@mercury/sakshi";
import { Store } from "@mercury/store";

/**
 * One Mercury instance per server process.
 *
 * Held on `globalThis` so Next's dev-mode hot reload does not open a second
 * SQLite handle on the same file every time a route module is re-evaluated --
 * which would quietly give two halves of the app two different views of the
 * ledger.
 *
 * Every route that imports this must declare `export const runtime = "nodejs"`.
 * `node:sqlite` does not exist on the edge runtime.
 */

export interface Mercury {
  store: Store;
  sakshi: Sakshi;
  rail: RazorpayPort;
  /** Present only in fixture mode, where checkout can be simulated. */
  fixture: FixtureRail | undefined;
  engine: Engine;
}

declare global {
  // eslint-disable-next-line no-var
  var __mercury__: Mercury | undefined;
}

/**
 * Anchor relative paths to the repo root, not to the process cwd.
 *
 * `next dev` runs with cwd = apps/web, so a bare "./mercury.db" resolved there
 * and the app quietly kept a *second* database, separate from the one
 * `npm run seed`, `npm run demo` and `npm run verify` were using. Everything
 * appeared to work; the two stores simply never agreed. Anchoring here is the
 * fix, and it is why the path constants are computed rather than literal.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "tsconfig.base.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

function anchored(value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot(), value);
}

const DB_PATH = anchored(process.env["MERCURY_DB"] ?? "./mercury.db");
const WALLET_PATH = anchored(process.env["MERCURY_WALLET"] ?? "./buyer-wallet.json");

function build(): Mercury {
  const store = Store.open(DB_PATH);
  const sakshi = Sakshi.open(DB_PATH);

  const live = process.env["RAIL_MODE"] === "live";
  const fixture = live ? undefined : new FixtureRail();
  const rail: RazorpayPort =
    fixture ??
    new LiveRail({
      keyId: process.env["RAZORPAY_KEY_ID"] ?? "",
      keySecret: process.env["RAZORPAY_KEY_SECRET"] ?? "",
      webhookSecret: process.env["RAZORPAY_WEBHOOK_SECRET"] ?? "",
    });

  const engine = new Engine({ store, sakshi, rail });
  const instance: Mercury = { store, sakshi, rail, fixture, engine };

  if (store.listMerchants().length === 0) seed(instance);
  return instance;
}

export function mercury(): Mercury {
  globalThis.__mercury__ ??= build();
  return globalThis.__mercury__;
}

export function railMode(): "fixture" | "live" {
  return mercury().fixture === undefined ? "live" : "fixture";
}

/** Load merchants, catalogue, principals and mandates into an open database. */
export function seed(m: Mercury = mercury()): void {
  for (const merchant of ALL_MERCHANTS) m.store.putMerchant(merchant);
  for (const item of ALL_ITEMS) m.store.putItem(item);

  const principals = seedPrincipals();
  // Seeding mints fresh delegated keys, so any wallet a buyer was holding is
  // now stale. Rewrite it here or Reset silently breaks every signed request.
  writeWallet(principals, WALLET_PATH);

  for (const p of principals) {
    m.store.putPrincipal(p.principal_id, p.public_key);
    m.store.putMandate(p.mandate);
    m.sakshi.append({
      actor: { type: "human", id: p.principal_id },
      event_type: "MANDATE_ISSUED",
      ts: new Date().toISOString(),
      delegation_scope: {
        mandate_id: p.mandate.mandate.mandate_id,
        scope_hash: hashValue(p.mandate.mandate.scope),
      },
      envelope: {
        reserved_paise: p.mandate.mandate.reserved_paise,
        consumed_paise: 0,
        remaining_paise: p.mandate.mandate.reserved_paise,
      },
      detail: {
        vertical: p.mandate.mandate.vertical,
        human_present: p.mandate.mandate.human_present,
        max_per_txn_paise: p.mandate.mandate.max_per_txn_paise,
      },
    });
  }
  m.store.setFrozen(false);
}

/**
 * Wipe and re-seed.
 *
 * Deliberately destroys the file rather than truncating tables: Sakshi is
 * append-only, so "clear the ledger" is not an operation it offers, and it
 * should not start offering one just because a demo wants a reset button.
 */
export function reset(): void {
  const existing = globalThis.__mercury__;
  if (existing !== undefined) {
    existing.sakshi.close();
    existing.store.close();
    globalThis.__mercury__ = undefined;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
  mercury();
}
