"use client";

import { useEffect, useState } from "react";
import { percent } from "@/lib/format";
import type { PolicyView } from "@/lib/types";

/**
 * The merchant's standing instructions to its agent.
 *
 * Written as sentences with one number set into each, rather than as a form of
 * labelled fields. That is the whole idea: twelve instructions a merchant can
 * read aloud are easier to hold in the head than four sliders in basis points,
 * and "Never sell below 15% margin" needs no legend. A merchant is giving
 * orders here, not configuring a product.
 *
 * Every number is in the unit a shopkeeper thinks in -- percent, rupees, units
 * -- and converted to the gate's units on the way out. The rule id, and the raw
 * figure the gate actually reads, are one toggle away: demoted, never deleted,
 * because the determinism is the reason to trust any of it.
 *
 * Nothing here is advisory. Each instruction is a Dwaar rule, and the gate
 * refuses a cart that breaks it.
 */

const LEVERS = [
  {
    id: "bulk_tier",
    label: "Price better for a bigger order",
    note: "a quantity ladder at 5 / 10 / 25 / 50",
  },
  {
    id: "substitute",
    label: "Suggest a stocked equivalent",
    note: "same category, when a line is short",
  },
  {
    id: "bundle",
    label: "Add a complementary item",
    note: "only when the buyer invites it",
  },
  {
    id: "credit_terms",
    label: "Discuss credit terms",
    note: "may be discussed, never priced",
  },
] as const;

/* ------------------------------------------------------------- one instruction */

function Instruction({
  before,
  value,
  unit,
  after,
  note,
  rule,
  raw,
  max,
  step = 1,
  disabled,
  modified,
  showProof,
  onChange,
}: {
  before: string;
  value: number;
  unit: "%" | "₹" | null;
  after: string;
  note: string;
  rule: string;
  /** What the gate actually reads. Shown beside the rule id, never instead of it. */
  raw: string;
  max: number;
  step?: number;
  disabled: boolean;
  modified: boolean;
  showProof: boolean;
  onChange: (n: number) => void;
}) {
  // Sized to its contents, so the number sits in the sentence rather than in a box.
  const width = `${Math.max(2, String(value).length) + 1}ch`;

  return (
    <div>
      <p className="text-[15px] leading-[1.6] text-paper-dim">
        {before}
        <span className="whitespace-nowrap">
          {unit === "₹" ? <span className="instruction-value">₹</span> : null}
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.min(Math.max(n, 0), max));
            }}
            aria-label={`${before.trim()} ${after.trim()}`.trim()}
            className="instruction-value text-[16px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            style={{ width }}
          />
          {unit === "%" ? <span className="instruction-value">%</span> : null}
          {modified ? <span className="ml-1.5 align-super text-[10px] text-brass">•</span> : null}
        </span>
        {after}
      </p>

      <p className="mt-1 text-[12px] text-paper-faint">{note}</p>

      {showProof ? (
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="hash text-brass-dim">{rule}</span>
          <span className="hash">{raw}</span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the board */

export interface InstructionPatch {
  min_margin_bps: number;
  max_discount_bps: number;
  levers: string[];
  commission_bps?: number;
  max_order_paise: number;
  max_order_units: number;
  max_order_lines: number;
  reserve_units: number;
  agent_categories: string[];
}

export function Instructions({
  policy,
  saving,
  disabled,
  onSave,
}: {
  policy: PolicyView | null;
  saving: boolean;
  disabled: boolean;
  onSave: (patch: InstructionPatch) => void;
}) {
  const [margin, setMargin] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [commission, setCommission] = useState(0);
  const [maxOrder, setMaxOrder] = useState(0);
  const [maxUnits, setMaxUnits] = useState(0);
  const [maxLines, setMaxLines] = useState(0);
  const [reserve, setReserve] = useState(0);
  const [levers, setLevers] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [showProof, setShowProof] = useState(false);

  // The server is the source of truth; the form re-seeds whenever it speaks.
  useEffect(() => {
    if (policy === null) return;
    const p = policy.profile;
    setMargin(p.min_margin_bps);
    setDiscount(p.max_discount_bps);
    setCommission(p.settlement?.commission_bps ?? 0);
    setMaxOrder(p.max_order_paise ?? 0);
    setMaxUnits(p.max_order_units ?? 0);
    setMaxLines(p.max_order_lines ?? 0);
    setReserve(p.reserve_units ?? 0);
    setLevers(p.levers);
    setCats(p.agent_categories ?? p.category_taxonomy);
  }, [policy]);

  if (policy === null) {
    return (
      <div className="py-10 text-center text-[13px] text-paper-faint">Loading…</div>
    );
  }

  const p = policy.profile;
  const route = p.settlement;
  const was = (f: string): boolean => policy.modified.includes(f);
  const lock = disabled || saving;

  const sameSet = (a: string[], b: string[]): boolean =>
    [...a].sort().join(",") === [...b].sort().join(",");

  const dirty =
    margin !== p.min_margin_bps ||
    discount !== p.max_discount_bps ||
    maxOrder !== (p.max_order_paise ?? 0) ||
    maxUnits !== (p.max_order_units ?? 0) ||
    maxLines !== (p.max_order_lines ?? 0) ||
    reserve !== (p.reserve_units ?? 0) ||
    !sameSet(levers, p.levers) ||
    !sameSet(cats, p.agent_categories ?? p.category_taxonomy) ||
    (route !== undefined && commission !== route.commission_bps);

  const toggle = (list: string[], set: (v: string[]) => void, id: string): void => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="display text-[21px] text-paper">Your standing instructions</h2>
        <div className="flex items-center gap-4">
          <span className="eyebrow">
            {policy.modified.length === 0
              ? "the agent cannot do otherwise — the gate refuses it"
              : `${policy.modified.length} changed from seed`}
          </span>
          <button
            type="button"
            onClick={() => setShowProof((v) => !v)}
            aria-pressed={showProof}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-brass-dim transition-colors hover:text-brass"
          >
            {showProof ? "hide the rules" : "why you can trust this"}
          </button>
        </div>
      </div>

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-1 gap-x-12 gap-y-9 md:grid-cols-2 xl:grid-cols-3">
        {/* ------------------------------------------------ what it may charge */}
        <div>
          <span className="eyebrow text-brass">What it may charge</span>
          <div className="mt-4 flex flex-col gap-4">
            <Instruction
              before="Never sell below "
              value={Number((margin / 100).toFixed(2))}
              unit="%"
              after=" margin"
              note="over what the goods cost you"
              rule="MARGIN.FLOOR_BREACH"
              raw={`min_margin_bps ${margin}`}
              max={500}
              step={0.5}
              disabled={lock}
              modified={was("min_margin_bps")}
              showProof={showProof}
              onChange={(n) => setMargin(Math.round(n * 100))}
            />
            <Instruction
              before="Never discount more than "
              value={Number((discount / 100).toFixed(2))}
              unit="%"
              after=""
              note="off the list price"
              rule="DISCOUNT.BPS_CAP"
              raw={`max_discount_bps ${discount}`}
              max={100}
              step={0.5}
              disabled={lock}
              modified={was("max_discount_bps")}
              showProof={showProof}
              onChange={(n) => setDiscount(Math.round(n * 100))}
            />
            <Instruction
              before="Never close an order above "
              value={Math.round(maxOrder / 100)}
              unit="₹"
              after=""
              note="your own ceiling, separate from the buyer's budget. 0 means no limit"
              rule="ORDER.VALUE_CAP"
              raw={`max_order_paise ${maxOrder}`}
              max={10_000_000}
              step={500}
              disabled={lock}
              modified={was("max_order_paise")}
              showProof={showProof}
              onChange={(n) => setMaxOrder(Math.round(n) * 100)}
            />
            {route === undefined ? null : (
              <Instruction
                before="The platform takes "
                value={Number((commission / 100).toFixed(2))}
                unit="%"
                after=""
                note={`off the top, before suppliers are paid — to ${route.commission_account_id}`}
                rule="not read by the gate"
                raw={`settlement.commission_bps ${commission}`}
                max={100}
                step={0.25}
                disabled={lock}
                modified={was("settlement.commission_bps")}
                showProof={showProof}
                onChange={(n) => setCommission(Math.round(n * 100))}
              />
            )}
          </div>
        </div>

        {/* -------------------------------------------------- what it may sell */}
        <div>
          <span className="eyebrow text-brass">What it may sell</span>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {p.category_taxonomy.map((c) => {
              const live = cats.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  disabled={lock}
                  onClick={() => toggle(cats, setCats, c)}
                  aria-pressed={live}
                  className={`figures border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40 ${
                    live
                      ? "border-brass bg-brass/15 text-paper"
                      : "border-rule text-paper-faint hover:border-rule-bright"
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-paper-faint">
            Tap to withdraw a category from your agent. You can narrow this list,
            never widen it.
          </p>
          {showProof ? (
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3">
              <span className="hash text-brass-dim">SCOPE.MERCHANT_CATEGORIES</span>
              <span className="hash">agent_categories ⊆ category_taxonomy</span>
            </p>
          ) : null}

          <div className="mt-5 flex flex-col gap-4">
            <Instruction
              before="Always keep "
              value={reserve}
              unit={null}
              after=" units of anything in stock"
              note="safety stock the agent can never sell into. 0 means none"
              rule="INVENTORY.RESERVE"
              raw={`reserve_units ${reserve}`}
              max={10_000}
              disabled={lock}
              modified={was("reserve_units")}
              showProof={showProof}
              onChange={setReserve}
            />
            <Instruction
              before="Never put more than "
              value={maxUnits}
              unit={null}
              after=" units in one order"
              note="however large the buyer's budget is. 0 means no limit"
              rule="ORDER.UNIT_CAP"
              raw={`max_order_units ${maxUnits}`}
              max={100_000}
              disabled={lock}
              modified={was("max_order_units")}
              showProof={showProof}
              onChange={setMaxUnits}
            />
            <Instruction
              before="Never put more than "
              value={maxLines}
              unit={null}
              after=" different products in one order"
              note="keeps a single cart pickable. 0 means no limit"
              rule="ORDER.LINE_CAP"
              raw={`max_order_lines ${maxLines}`}
              max={500}
              disabled={lock}
              modified={was("max_order_lines")}
              showProof={showProof}
              onChange={setMaxLines}
            />
          </div>
        </div>

        {/* --------------------------------------------- how it may negotiate */}
        <div>
          <span className="eyebrow text-brass">How it may negotiate</span>
          <div className="mt-4 flex flex-col gap-3.5">
            {LEVERS.map((l) => {
              const on = levers.includes(l.id);
              return (
                <label
                  key={l.id}
                  className={`flex cursor-pointer items-start gap-2.5 ${lock ? "opacity-40" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={lock}
                    onChange={() => toggle(levers, setLevers, l.id)}
                    className="mt-[3px] accent-[var(--color-brass)]"
                  />
                  <span className="min-w-0">
                    <span
                      className={`block text-[15px] leading-[1.35] ${on ? "text-paper-dim" : "text-paper-faint"}`}
                    >
                      {l.label}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-paper-faint">{l.note}</span>
                  </span>
                </label>
              );
            })}
          </div>

          {was("levers") ? (
            <p className="mt-3 text-[11px] text-brass">Changed from the seeded profile.</p>
          ) : null}

          <p className="mt-5 text-[12px] leading-relaxed text-paper-faint">
            A lever you do not permit is never pulled. That is how one
            implementation serves both of your shops.
          </p>

          {showProof ? (
            <p className="mt-4 text-[11px] leading-relaxed text-paper-faint">
              Not editable, on purpose: your identity, and the full category
              taxonomy. The taxonomy feeds{" "}
              <span className="hash">SCOPE.CATEGORY_ALLOWLIST</span>, so a form
              that could widen it would be a privilege escalation wearing a
              settings page.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-end gap-4 border-t border-rule pt-4">
        <span className="text-[12px] text-paper-faint">
          {dirty
            ? "Takes effect on the very next negotiation."
            : "Saved. The gate is reading this."}
        </span>
        <button
          type="button"
          disabled={!dirty || lock}
          onClick={() =>
            onSave({
              min_margin_bps: margin,
              max_discount_bps: discount,
              levers,
              max_order_paise: maxOrder,
              max_order_units: maxUnits,
              max_order_lines: maxLines,
              reserve_units: reserve,
              agent_categories: cats,
              ...(route === undefined ? {} : { commission_bps: commission }),
            })
          }
          className="border border-brass bg-brass/15 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-brass transition-colors hover:bg-brass/25 disabled:border-rule disabled:bg-transparent disabled:text-paper-faint disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save instructions"}
        </button>
      </div>

      <p className="mt-3 text-right text-[11px] text-paper-faint">
        {percent(margin)} margin floor · {percent(discount)} discount ceiling ·{" "}
        {cats.length} of {p.category_taxonomy.length} categories
      </p>
    </section>
  );
}
