import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "@mercury/core";
import { Sakshi } from "./ledger.js";

function freshLedger(): Sakshi {
  return Sakshi.open(":memory:");
}

function seedThree(s: Sakshi): void {
  s.append({
    actor: { type: "human", id: "prn_alice" },
    event_type: "MANDATE_ISSUED",
    delegation_scope: { mandate_id: "mnd_1", scope_hash: "a".repeat(64) },
    envelope: { reserved_paise: 200_000, consumed_paise: 0, remaining_paise: 200_000 },
  });
  s.append({
    actor: { type: "merchant_agent", id: "agt_revenue" },
    event_type: "OFFER_PROPOSED",
    detail: { lines: 2, quoted_total_paise: 84_000 },
  });
  s.append({
    actor: { type: "dwaar", id: "dwaar" },
    event_type: "DWAAR_DECISION",
    decision: {
      outcome: "ALLOW",
      rule_ids: ["MARGIN.FLOOR_BREACH", "MANDATE.PER_TXN_CAP"],
      evidence: [
        {
          rule_id: "MARGIN.FLOOR_BREACH",
          passed: true,
          observed: 87_500,
          limit: 87_500,
          message: "unit price at floor",
        },
      ],
    },
  });
}

describe("Sakshi append", () => {
  it("starts from the genesis hash and assigns sequential seq", () => {
    const s = freshLedger();
    expect(s.tipHash()).toBe(GENESIS_HASH);

    const e1 = s.append({ actor: { type: "system", id: "boot" }, event_type: "CIRCUIT_UNFROZEN" });
    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe(GENESIS_HASH);

    const e2 = s.append({ actor: { type: "system", id: "boot" }, event_type: "CIRCUIT_FROZEN" });
    expect(e2.seq).toBe(2);
    expect(e2.prev_hash).toBe(e1.hash);
    s.close();
  });

  it("links every entry to the previous one", () => {
    const s = freshLedger();
    seedThree(s);
    const rows = s.read();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    s.close();
  });

  it("round-trips structured decision records", () => {
    const s = freshLedger();
    seedThree(s);
    const decision = s.byEventType("DWAAR_DECISION")[0];
    expect(decision?.decision?.outcome).toBe("ALLOW");
    expect(decision?.decision?.evidence[0]?.observed).toBe(87_500);
    s.close();
  });
});

describe("Sakshi verify -- the auditability proof", () => {
  it("verifies a clean chain", () => {
    const s = freshLedger();
    seedThree(s);
    expect(s.verify()).toEqual({ ok: true, count: 3 });
    s.close();
  });

  it("verifies an empty chain", () => {
    const s = freshLedger();
    expect(s.verify()).toEqual({ ok: true, count: 0 });
    s.close();
  });

  it("catches an edited body at the exact seq", () => {
    const s = freshLedger();
    seedThree(s);

    // A judge opening the DB and changing a number, by hand.
    s.db.prepare("UPDATE sakshi SET body = REPLACE(body, '84000', '8400') WHERE seq = 2").run();

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(2);
    expect(r.reason).toBe("HASH_MISMATCH");
    s.close();
  });

  it("catches tampering with an indexed column even though the hash covers only the body", () => {
    const s = freshLedger();
    seedThree(s);
    s.db.prepare("UPDATE sakshi SET event_type = 'ORDER_CREATED' WHERE seq = 2").run();

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(2);
    expect(r.reason).toBe("COLUMN_TAMPERED");
    s.close();
  });

  it("catches a deleted entry as a sequence gap", () => {
    const s = freshLedger();
    seedThree(s);
    s.db.prepare("DELETE FROM sakshi WHERE seq = 2").run();

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(3);
    expect(r.reason).toBe("SEQ_GAP");
    s.close();
  });

  it("catches a re-hashed entry via the broken forward link", () => {
    // The sophisticated tamper: edit the body AND recompute that row's hash.
    // The next row's prev_hash no longer matches, so the chain still fails.
    const s = freshLedger();
    seedThree(s);

    const row = s.db.prepare("SELECT body, prev_hash FROM sakshi WHERE seq = 2").get() as {
      body: string;
      prev_hash: string;
    };
    const forged = row.body.replace("84000", "8400");
    const forgedHash = createHash("sha256").update(row.prev_hash + forged, "utf8").digest("hex");
    s.db.prepare("UPDATE sakshi SET body = ?, hash = ? WHERE seq = 2").run(forged, forgedHash);

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(3);
    expect(r.reason).toBe("PREV_HASH_MISMATCH");
    s.close();
  });
});
