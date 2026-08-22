import "server-only";
import { rmSync } from "node:fs";
import { Engine } from "@mercury/agent";
import { hashValue } from "@mercury/core";
import { FixtureRail, LiveRail, type RazorpayPort } from "@mercury/rail";
import { ALL_ITEMS, ALL_MERCHANTS, seedPrincipals } from "@mercury/seed";
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

const DB_PATH = process.env["MERCURY_DB"] ?? "./mercury.db";

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

  for (const p of seedPrincipals()) {
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
