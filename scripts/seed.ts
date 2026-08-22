import { rmSync } from "node:fs";
import { Sakshi } from "@mercury/sakshi";
import { Store } from "@mercury/store";
import { formatINR, hashValue, paise } from "@mercury/core";
import { ALL_ITEMS, ALL_MERCHANTS } from "../db/seed/catalogs.js";
import { seedPrincipals } from "../db/seed/mandates.js";

/**
 * Seed a fresh Mercury database.
 *
 * Both verticals are seeded into the same file, against the same gate, the same
 * ledger and the same rail. That is the point of the demo: nothing below this
 * script knows which vertical it is serving.
 *
 * `npm run seed` -- add `--keep` to seed on top of an existing database.
 */

const dbPath = process.env["MERCURY_DB"] ?? "./mercury.db";
const keep = process.argv.includes("--keep");

if (!keep) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

const store = Store.open(dbPath);
const sakshi = Sakshi.open(dbPath);

for (const merchant of ALL_MERCHANTS) store.putMerchant(merchant);
for (const item of ALL_ITEMS) store.putItem(item);

const principals = seedPrincipals();
for (const p of principals) {
  store.putPrincipal(p.principal_id, p.public_key);
  store.putMandate(p.mandate);
  sakshi.append({
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
      max_txn_count: p.mandate.mandate.max_txn_count,
      expires_at: p.mandate.mandate.expires_at,
    },
  });
}

store.setFrozen(false);

console.log(`seeded ${dbPath}`);
console.log(`  merchants  ${ALL_MERCHANTS.map((m) => m.merchant_id).join(", ")}`);
console.log(`  catalogue  ${ALL_ITEMS.length} SKUs`);
for (const p of principals) {
  const m = p.mandate.mandate;
  console.log(
    `  mandate    ${m.mandate_id}  ${formatINR(paise(m.reserved_paise))} reserved  ` +
      `(${m.vertical}, human_present=${String(m.human_present)})`,
  );
}
console.log(`  ledger     ${sakshi.count()} entries, tip ${sakshi.tipHash().slice(0, 12)}`);

sakshi.close();
store.close();
