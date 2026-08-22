import { DatabaseSync } from "node:sqlite";
import {
  type CatalogItem,
  type IntentToken,
  type MerchantProfile,
  type Paise,
  type SignedReserveMandate,
  paise,
} from "@mercury/core";

/**
 * The operational store: catalogue, merchants, mandates, tokens, orders.
 *
 * Deliberately separate from Sakshi. Sakshi records what happened and must be
 * append-only for its hash chain to mean anything; this holds mutable working
 * state. Keeping them in different modules (even though they share one SQLite
 * file) is what stops "update the stock count" from ever touching the audit
 * trail.
 *
 * Two operations here are concurrency-critical and both use BEGIN IMMEDIATE
 * with a conditional UPDATE, so the loser of a race is rejected rather than
 * overwriting the winner:
 *   - reserveStock  (F3, the inventory race)
 *   - spendToken    (F7, intent-token replay)
 */

export interface MandateState {
  consumed_paise: Paise;
  txn_count: number;
  status: "active" | "closed";
}

export type StockResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "INSUFFICIENT"; available: number }
  | { ok: false; reason: "UNKNOWN_SKU"; available: 0 };

export type TokenSpendResult = { ok: true } | { ok: false; reason: "ALREADY_SPENT" | "UNKNOWN" };

export class Store {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#migrate();
  }

  static open(path: string): Store {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return new Store(db);
  }

  get db(): DatabaseSync {
    return this.#db;
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS merchants (
        merchant_id TEXT PRIMARY KEY,
        profile     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog (
        sku         TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        item        TEXT NOT NULL,
        stock       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS catalog_merchant ON catalog(merchant_id);

      CREATE TABLE IF NOT EXISTS principals (
        principal_id TEXT PRIMARY KEY,
        public_key   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mandates (
        mandate_id     TEXT PRIMARY KEY,
        principal_id   TEXT NOT NULL,
        signed         TEXT NOT NULL,
        consumed_paise INTEGER NOT NULL DEFAULT 0,
        txn_count      INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS intent_tokens (
        token_id TEXT PRIMARY KEY,
        token    TEXT NOT NULL,
        spent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS orders (
        order_id   TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL,
        token_id   TEXT NOT NULL,
        cart_hash  TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        status     TEXT NOT NULL,
        payment_id TEXT
      );

      CREATE TABLE IF NOT EXISTS seen_webhook_events (
        event_id TEXT PRIMARY KEY,
        seen_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /* ------------------------------------------------------------- merchants */

  putMerchant(profile: MerchantProfile): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO merchants (merchant_id, profile) VALUES (?, ?)")
      .run(profile.merchant_id, JSON.stringify(profile));
  }

  getMerchant(merchantId: string): MerchantProfile | undefined {
    const row = this.#db
      .prepare("SELECT profile FROM merchants WHERE merchant_id = ?")
      .get(merchantId) as { profile: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.profile) as MerchantProfile);
  }

  listMerchants(): MerchantProfile[] {
    const rows = this.#db.prepare("SELECT profile FROM merchants").all() as unknown as {
      profile: string;
    }[];
    return rows.map((r) => JSON.parse(r.profile) as MerchantProfile);
  }

  /* --------------------------------------------------------------- catalog */

  putItem(item: CatalogItem): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO catalog (sku, merchant_id, item, stock) VALUES (?, ?, ?, ?)")
      .run(item.sku, item.merchant_id, JSON.stringify(item), item.stock);
  }

  getItem(sku: string): CatalogItem | undefined {
    const row = this.#db.prepare("SELECT item, stock FROM catalog WHERE sku = ?").get(sku) as
      | { item: string; stock: number }
      | undefined;
    if (row === undefined) return undefined;
    // stock is authoritative in its own column so the conditional UPDATE can see it
    return { ...(JSON.parse(row.item) as CatalogItem), stock: row.stock };
  }

  catalogFor(merchantId: string): Map<string, CatalogItem> {
    const rows = this.#db
      .prepare("SELECT item, stock FROM catalog WHERE merchant_id = ?")
      .all(merchantId) as unknown as { item: string; stock: number }[];
    return new Map(
      rows.map((r) => {
        const item = { ...(JSON.parse(r.item) as CatalogItem), stock: r.stock };
        return [item.sku, item];
      }),
    );
  }

  /**
   * F3: atomically reserve stock.
   *
   * BEGIN IMMEDIATE takes the write lock up front, and the UPDATE is guarded by
   * `WHERE stock >= ?`, so two concurrent buyers for the last unit cannot both
   * succeed. The loser gets INSUFFICIENT and never sees a negative stock count.
   */
  reserveStock(sku: string, qty: number): StockResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT stock FROM catalog WHERE sku = ?").get(sku) as
        | { stock: number }
        | undefined;

      if (row === undefined) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "UNKNOWN_SKU", available: 0 };
      }

      const res = this.#db
        .prepare("UPDATE catalog SET stock = stock - ? WHERE sku = ? AND stock >= ?")
        .run(qty, sku, qty);

      if (Number(res.changes) === 0) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "INSUFFICIENT", available: row.stock };
      }

      this.#db.exec("COMMIT");
      return { ok: true, remaining: row.stock - qty };
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Put stock back, e.g. after an auto-refund. */
  releaseStock(sku: string, qty: number): void {
    this.#db.prepare("UPDATE catalog SET stock = stock + ? WHERE sku = ?").run(qty, sku);
  }

  /* ------------------------------------------------- principals + mandates */

  putPrincipal(principalId: string, publicKey: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO principals (principal_id, public_key) VALUES (?, ?)")
      .run(principalId, publicKey);
  }

  getPrincipalKey(principalId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT public_key FROM principals WHERE principal_id = ?")
      .get(principalId) as { public_key: string } | undefined;
    return row?.public_key;
  }

  putMandate(signed: SignedReserveMandate): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO mandates (mandate_id, principal_id, signed, consumed_paise, txn_count, status) " +
          "VALUES (?, ?, ?, COALESCE((SELECT consumed_paise FROM mandates WHERE mandate_id = ?), 0), " +
          "COALESCE((SELECT txn_count FROM mandates WHERE mandate_id = ?), 0), 'active')",
      )
      .run(
        signed.mandate.mandate_id,
        signed.mandate.principal_id,
        JSON.stringify(signed),
        signed.mandate.mandate_id,
        signed.mandate.mandate_id,
      );
  }

  getMandate(mandateId: string): SignedReserveMandate | undefined {
    const row = this.#db
      .prepare("SELECT signed FROM mandates WHERE mandate_id = ?")
      .get(mandateId) as { signed: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.signed) as SignedReserveMandate);
  }

  getMandateState(mandateId: string): MandateState | undefined {
    const row = this.#db
      .prepare("SELECT consumed_paise, txn_count, status FROM mandates WHERE mandate_id = ?")
      .get(mandateId) as
      | { consumed_paise: number; txn_count: number; status: string }
      | undefined;
    if (row === undefined) return undefined;
    return {
      consumed_paise: paise(row.consumed_paise),
      txn_count: row.txn_count,
      status: row.status === "closed" ? "closed" : "active",
    };
  }

  /** Draw down the envelope. Called only after Dwaar has allowed the amount. */
  consumeEnvelope(mandateId: string, amount: Paise): MandateState {
    this.#db
      .prepare(
        "UPDATE mandates SET consumed_paise = consumed_paise + ?, txn_count = txn_count + 1 WHERE mandate_id = ?",
      )
      .run(amount, mandateId);
    const state = this.getMandateState(mandateId);
    if (state === undefined) throw new Error(`no such mandate: ${mandateId}`);
    return state;
  }

  /** Give budget back, e.g. after an auto-refund, so the envelope is not silently burned. */
  restoreEnvelope(mandateId: string, amount: Paise): void {
    this.#db
      .prepare(
        "UPDATE mandates SET consumed_paise = MAX(0, consumed_paise - ?), " +
          "txn_count = MAX(0, txn_count - 1) WHERE mandate_id = ?",
      )
      .run(amount, mandateId);
  }

  /**
   * Close an envelope and report the residual that is released back to the
   * principal -- the Reserve Pay guarantee that unspent authority is not the
   * agent's to keep.
   */
  closeEnvelope(mandateId: string): { released_paise: Paise } {
    const signed = this.getMandate(mandateId);
    const state = this.getMandateState(mandateId);
    if (signed === undefined || state === undefined) throw new Error(`no such mandate: ${mandateId}`);
    this.#db.prepare("UPDATE mandates SET status = 'closed' WHERE mandate_id = ?").run(mandateId);
    return {
      released_paise: paise(Math.max(0, signed.mandate.reserved_paise - state.consumed_paise)),
    };
  }

  /* ---------------------------------------------------------- intent tokens */

  issueToken(token: IntentToken): void {
    this.#db
      .prepare("INSERT INTO intent_tokens (token_id, token, spent_at) VALUES (?, ?, NULL)")
      .run(token.token_id, JSON.stringify(token));
  }

  getToken(tokenId: string): IntentToken | undefined {
    const row = this.#db
      .prepare("SELECT token FROM intent_tokens WHERE token_id = ?")
      .get(tokenId) as { token: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.token) as IntentToken);
  }

  spentTokenIds(): Set<string> {
    const rows = this.#db
      .prepare("SELECT token_id FROM intent_tokens WHERE spent_at IS NOT NULL")
      .all() as unknown as { token_id: string }[];
    return new Set(rows.map((r) => r.token_id));
  }

  /**
   * F7: atomically spend a token exactly once.
   *
   * The conditional UPDATE (`WHERE spent_at IS NULL`) is the whole defence: a
   * replayed token changes zero rows and is rejected, so no second order can
   * ever be created from the same authorisation.
   */
  spendToken(tokenId: string, at: string = new Date().toISOString()): TokenSpendResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.#db
        .prepare("SELECT 1 AS x FROM intent_tokens WHERE token_id = ?")
        .get(tokenId);
      if (exists === undefined) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "UNKNOWN" };
      }

      const res = this.#db
        .prepare("UPDATE intent_tokens SET spent_at = ? WHERE token_id = ? AND spent_at IS NULL")
        .run(at, tokenId);

      if (Number(res.changes) === 0) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "ALREADY_SPENT" };
      }

      this.#db.exec("COMMIT");
      return { ok: true };
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /* ---------------------------------------------------------------- orders */

  putOrder(o: {
    order_id: string;
    mandate_id: string;
    token_id: string;
    cart_hash: string;
    amount: Paise;
    status: string;
    payment_id?: string;
  }): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO orders (order_id, mandate_id, token_id, cart_hash, amount, status, payment_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(o.order_id, o.mandate_id, o.token_id, o.cart_hash, o.amount, o.status, o.payment_id ?? null);
  }

  setOrderStatus(orderId: string, status: string, paymentId?: string): void {
    this.#db
      .prepare("UPDATE orders SET status = ?, payment_id = COALESCE(?, payment_id) WHERE order_id = ?")
      .run(status, paymentId ?? null, orderId);
  }

  getOrder(orderId: string):
    | {
        order_id: string;
        mandate_id: string;
        token_id: string;
        cart_hash: string;
        amount: number;
        status: string;
        payment_id: string | null;
      }
    | undefined {
    return this.#db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as
      | {
          order_id: string;
          mandate_id: string;
          token_id: string;
          cart_hash: string;
          amount: number;
          status: string;
          payment_id: string | null;
        }
      | undefined;
  }

  /* ----------------------------------------------------- webhook dedupe ---- */

  hasSeenEvent(eventId: string): boolean {
    return (
      this.#db.prepare("SELECT 1 AS x FROM seen_webhook_events WHERE event_id = ?").get(eventId) !==
      undefined
    );
  }

  markEventSeen(eventId: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO seen_webhook_events (event_id, seen_at) VALUES (?, ?)")
      .run(eventId, new Date().toISOString());
  }

  /* ------------------------------------------------------- freeze switch --- */

  isFrozen(): boolean {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'frozen'").get() as
      | { value: string }
      | undefined;
    return row?.value === "1";
  }

  setFrozen(frozen: boolean): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('frozen', ?)")
      .run(frozen ? "1" : "0");
  }

  close(): void {
    this.#db.close();
  }
}
