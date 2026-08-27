"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "./Header";
import { EnvelopesPanel } from "./merchant/EnvelopesPanel";
import { OrdersPanel } from "./merchant/OrdersPanel";
import { PolicyPanel } from "./merchant/PolicyPanel";
import { RevenuePanel } from "./merchant/RevenuePanel";
import { TabStrip } from "./ui/TabStrip";
import type { MerchantSummary, PolicyView, StateView } from "@/lib/types";

/**
 * The merchant's seat.
 *
 * Mission Control watches the gate decide. This owns the rules it decides by,
 * and the money those rules earned. Same system, same store, same ledger --
 * the difference is only whose question is being answered.
 *
 * No SSE here. Nothing on this page streams: a policy is a standing fact and a
 * revenue total is a sum over the chain, so snapshots on mount and after each
 * mutation are the honest transport.
 */

export function MerchantConsole() {
  const [state, setState] = useState<StateView | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [summary, setSummary] = useState<MerchantSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    const next = (await res.json()) as StateView;
    setState(next);
    // First load picks whichever merchant the seed listed first.
    setMerchantId((prev) => prev ?? next.merchants[0]?.merchant_id ?? null);
  }, []);

  const refreshMerchant = useCallback(async (id: string) => {
    const [p, s] = await Promise.all([
      fetch(`/api/merchant/profile?merchant_id=${encodeURIComponent(id)}`, { cache: "no-store" }),
      fetch(`/api/merchant/summary?merchant_id=${encodeURIComponent(id)}`, { cache: "no-store" }),
    ]);
    if (p.ok) setPolicy((await p.json()) as PolicyView);
    if (s.ok) setSummary((await s.json()) as MerchantSummary);
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (merchantId !== null) void refreshMerchant(merchantId);
  }, [merchantId, refreshMerchant]);

  const save = useCallback(
    async (patch: {
      min_margin_bps: number;
      max_discount_bps: number;
      levers: string[];
      commission_bps?: number;
    }) => {
      if (merchantId === null) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/merchant/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchant_id: merchantId, ...patch }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          setError(body.error ?? `Save failed (${res.status})`);
          return;
        }
        setPolicy((await res.json()) as PolicyView);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [merchantId],
  );

  const freeze = useCallback(
    async (frozen: boolean) => {
      setBusy(true);
      await fetch("/api/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frozen }),
      });
      await refreshState();
      setBusy(false);
    },
    [refreshState],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    await fetch("/api/reset", { method: "POST" });
    await refreshState();
    if (merchantId !== null) await refreshMerchant(merchantId);
    setBusy(false);
  }, [refreshState, refreshMerchant, merchantId]);

  const merchants = state?.merchants ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <Header state={state} busy={busy} onFreeze={freeze} onReset={reset} current="merchant" />

      <main className="mx-auto grid w-full max-w-[1680px] flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:p-6">
        <div className="flex min-h-[560px] flex-col gap-2 lg:h-[calc(100vh-9.5rem)]">
          {/* One gate, two verticals. Switching here changes only the data. */}
          {merchants.length > 1 && merchantId !== null ? (
            <TabStrip
              className="self-start"
              value={merchantId}
              onChange={setMerchantId}
              disabled={saving || busy}
              tabs={merchants.map((m) => ({
                id: m.merchant_id,
                label: m.display_name,
                title: m.vertical,
              }))}
            />
          ) : null}

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(280px,auto)_minmax(240px,auto)] gap-4 lg:grid-rows-[1.1fr_1fr]">
            <RevenuePanel summary={summary} />
            <OrdersPanel orders={summary?.orders ?? []} />
          </div>
        </div>

        <div className="grid min-h-0 grid-rows-[minmax(420px,auto)_minmax(200px,auto)] gap-4 lg:h-[calc(100vh-9.5rem)] lg:grid-rows-[1.6fr_1fr]">
          <div className="flex min-h-0 flex-col gap-2">
            {error === null ? null : (
              <p className="border border-vermilion-dim bg-vermilion/10 px-3 py-2 text-[12px] text-vermilion">
                {error}
              </p>
            )}
            <PolicyPanel
              policy={policy}
              saving={saving}
              disabled={busy}
              onSave={(patch) => void save(patch)}
            />
          </div>

          <EnvelopesPanel envelopes={state?.envelopes ?? []} />
        </div>
      </main>

      <footer className="border-t border-rule px-6 py-3 text-center text-[11px] text-paper-faint">
        The merchant sets the rule. Dwaar enforces it. Neither is the agent.
      </footer>
    </div>
  );
}
