"use client";

import { useEffect, useState } from "react";
import { Pill } from "@/components/ui/Pill";
import { bps } from "@/lib/format";
import type { PolicyView } from "@/lib/types";

/**
 * The merchant's own rules, as controls rather than as a constant in a file.
 *
 * Each control names the Dwaar rule it drives. That labelling is the point of
 * the panel: a margin floor is an abstraction until you can watch moving it turn
 * a cart the gate allowed a minute ago into MARGIN.FLOOR_BREACH. The agent does
 * not change, the catalogue does not change; only the rule does.
 *
 * Saving writes through to the store, and the gate re-reads the profile on every
 * evaluation -- so the change lands on the next negotiation, with no restart.
 */

const ALL_LEVERS = ["bundle", "substitute", "bulk_tier", "credit_terms"] as const;

const LEVER_NOTE: Record<string, string> = {
  bundle: "Add-on from another category. Only when the buyer invites it.",
  substitute: "Nearest stocked equivalent, same category.",
  bulk_tier: "Quantity ladder at 5 / 10 / 25 / 50 units.",
  credit_terms: "Declared but not mechanised. The persona may discuss it; it prices nothing.",
};

function Field({
  label,
  rule,
  value,
  onChange,
  max,
  disabled,
  modified,
  hint,
}: {
  label: string;
  rule: string;
  value: number;
  onChange: (v: number) => void;
  max: number;
  disabled: boolean;
  modified: boolean;
  hint: string;
}) {
  return (
    <div className="border-b border-rule px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <div className="flex items-center gap-2">
          {modified ? (
            <Pill className="border-brass text-brass" title="Differs from the seeded profile">
              modified
            </Pill>
          ) : null}
          <span className="figures text-[15px] text-paper">{bps(value)}</span>
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={max}
        step={50}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2.5 w-full accent-[var(--color-brass)] disabled:opacity-40"
        aria-label={label}
      />

      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <span className="hash">{rule}</span>
        <span className="text-[11px] text-paper-faint">{hint}</span>
      </div>
    </div>
  );
}

export function PolicyPanel({
  policy,
  saving,
  disabled,
  onSave,
}: {
  policy: PolicyView | null;
  saving: boolean;
  /** True while a negotiation is running. Editing mid-run is confusing, not dangerous. */
  disabled: boolean;
  onSave: (patch: {
    min_margin_bps: number;
    max_discount_bps: number;
    levers: string[];
    commission_bps?: number;
  }) => void;
}) {
  const [margin, setMargin] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [levers, setLevers] = useState<string[]>([]);
  const [commission, setCommission] = useState(0);

  // The server is the source of truth; the form re-seeds whenever it speaks.
  useEffect(() => {
    if (policy === null) return;
    setMargin(policy.profile.min_margin_bps);
    setDiscount(policy.profile.max_discount_bps);
    setLevers(policy.profile.levers);
    setCommission(policy.profile.settlement?.commission_bps ?? 0);
  }, [policy]);

  if (policy === null) {
    return (
      <section className="panel flex min-h-0 flex-col">
        <div className="panel-head px-4 py-3">
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-paper">
            Policy
          </h2>
        </div>
        <p className="px-4 py-8 text-center text-[13px] text-paper-faint">Loading…</p>
      </section>
    );
  }

  const p = policy.profile;
  const route = p.settlement;

  const dirty =
    margin !== p.min_margin_bps ||
    discount !== p.max_discount_bps ||
    [...levers].sort().join(",") !== [...p.levers].sort().join(",") ||
    (route !== undefined && commission !== route.commission_bps);

  const toggle = (l: string): void => {
    setLevers((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]));
  };

  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-paper">
          Policy
        </h2>
        <span className="eyebrow">
          {policy.modified.length === 0 ? "as seeded" : `${policy.modified.length} changed`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Field
          label="Margin floor"
          rule="MARGIN.FLOOR_BREACH"
          value={margin}
          onChange={setMargin}
          /*
           * Above the fattest margin in the seeded catalogue (~67%), so the
           * floor can actually be pushed until it binds. A control whose whole
           * range sits below the point where anything happens looks broken.
           */
          max={7_500}
          disabled={disabled || saving}
          modified={policy.modified.includes("min_margin_bps")}
          hint="price ≥ cost × (1 + floor)"
        />

        <Field
          label="Discount ceiling"
          rule="DISCOUNT.BPS_CAP"
          value={discount}
          onChange={setDiscount}
          max={10_000}
          disabled={disabled || saving}
          modified={policy.modified.includes("max_discount_bps")}
          hint="measured against list"
        />

        {/*
          * Worth stating, because the obvious guess is wrong: raising the floor
          * mostly does not produce a refusal. Dwaar repairs the proposal to the
          * lowest legal price and the cart gets more expensive. A denial only
          * follows when the repaired price then breaks something else -- the
          * envelope, usually.
          */}
        <p className="border-b border-rule px-4 py-3 text-[11px] leading-relaxed text-paper-faint">
          A floor that bites does not refuse the cart. Dwaar reprices it to the
          lowest legal figure and the basket gets dearer; a denial only follows
          if that new figure breaks another rule.
        </p>

        {route === undefined ? null : (
          <Field
            label="Route commission"
            rule="not read by Dwaar"
            value={commission}
            onChange={setCommission}
            max={2_000}
            disabled={disabled || saving}
            modified={policy.modified.includes("settlement.commission_bps")}
            hint={`off the top, to ${route.commission_account_id}`}
          />
        )}

        <div className="border-b border-rule px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="eyebrow">Levers permitted</span>
            {policy.modified.includes("levers") ? (
              <Pill className="border-brass text-brass">modified</Pill>
            ) : null}
          </div>

          <div className="mt-2 space-y-1.5">
            {ALL_LEVERS.map((l) => (
              <label
                key={l}
                className={`flex cursor-pointer items-baseline gap-2.5 ${
                  disabled || saving ? "opacity-40" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={levers.includes(l)}
                  disabled={disabled || saving}
                  onChange={() => toggle(l)}
                  className="mt-0.5 accent-[var(--color-brass)]"
                />
                <span className="min-w-0">
                  <span className="figures text-[12px] text-paper">{l}</span>
                  <span className="ml-2 text-[11px] text-paper-faint">{LEVER_NOTE[l]}</span>
                </span>
              </label>
            ))}
          </div>

          <p className="mt-2.5 text-[11px] leading-relaxed text-paper-faint">
            A lever this profile does not list is never pulled. That is how one
            implementation serves both verticals.
          </p>
        </div>

        <div className="px-4 py-3.5">
          <span className="eyebrow">Not editable here</span>
          <p className="mt-1.5 max-w-[70ch] text-[11px] leading-relaxed text-paper-faint">
            Identity, and <span className="hash">category_taxonomy</span>. The
            taxonomy feeds <span className="hash">SCOPE.CATEGORY_ALLOWLIST</span>,
            so a form that could widen it would be a privilege escalation wearing
            a settings page.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3">
        <span className="text-[11px] text-paper-faint">
          {dirty ? "Takes effect on the next negotiation." : "Saved. The gate is reading this."}
        </span>
        <button
          type="button"
          disabled={!dirty || disabled || saving}
          onClick={() =>
            onSave({
              min_margin_bps: margin,
              max_discount_bps: discount,
              levers,
              ...(route === undefined ? {} : { commission_bps: commission }),
            })
          }
          className="border border-brass bg-brass/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-brass transition-colors hover:bg-brass/25 disabled:border-rule disabled:bg-transparent disabled:text-paper-faint disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save policy"}
        </button>
      </div>
    </section>
  );
}
