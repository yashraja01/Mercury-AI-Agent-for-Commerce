"use client";

import { useCallback, useEffect, useState } from "react";
import { ChaosPanel } from "./ChaosPanel";
import { DwaarPanel } from "./DwaarPanel";
import { Header } from "./Header";
import { SakshiPanel, type VerifyState } from "./SakshiPanel";
import { Theatre } from "./Theatre";
import type { LedgerEntry, StateView, TheatreEvent } from "@/lib/types";

/**
 * The board.
 *
 * Holds the only mutable state in the UI: the event stream from the current
 * run, and the last snapshot of the server. Everything else is derived. The
 * three panels are spectators on the same run and never talk to each other.
 */

export function MissionControl({ llmAvailable }: { llmAvailable: boolean }) {
  const [state, setState] = useState<StateView | null>(null);
  const [events, setEvents] = useState<TheatreEvent[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [selected, setSelected] = useState("topup");
  const [view, setView] = useState<"theatre" | "chaos">("theatre");
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [verifying, setVerifying] = useState(false);

  const refreshState = useCallback(async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    setState((await res.json()) as StateView);
  }, []);

  const refreshLedger = useCallback(async () => {
    const res = await fetch("/api/ledger?limit=80", { cache: "no-store" });
    const body = (await res.json()) as { entries: LedgerEntry[] };
    setLedger(body.entries);
  }, []);

  useEffect(() => {
    void refreshState();
    void refreshLedger();
  }, [refreshState, refreshLedger]);

  /** Read the SSE body frame by frame and append each event as it lands. */
  const run = useCallback(async () => {
    setRunning(true);
    setEvents([]);
    setVerify(null);

    try {
      const res = await fetch("/api/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: selected, mode }),
      });
      if (res.body === null) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line === undefined) continue;
          const payload = line.slice(6);
          if (payload === "{}") continue;
          setEvents((prev) => [...prev, JSON.parse(payload) as TheatreEvent]);
        }
      }
    } catch (e) {
      setEvents((prev) => [...prev, { type: "note", text: `Run failed: ${(e as Error).message}` }]);
    } finally {
      setRunning(false);
      await refreshState();
      await refreshLedger();
    }
  }, [selected, mode, refreshState, refreshLedger]);

  const freeze = useCallback(
    async (frozen: boolean) => {
      setBusy(true);
      await fetch("/api/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frozen }),
      });
      await refreshState();
      await refreshLedger();
      setBusy(false);
    },
    [refreshState, refreshLedger],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    setEvents([]);
    setVerify(null);
    await fetch("/api/reset", { method: "POST" });
    await refreshState();
    await refreshLedger();
    setBusy(false);
  }, [refreshState, refreshLedger]);

  const runVerify = useCallback(async () => {
    setVerifying(true);
    const res = await fetch("/api/verify", { method: "POST" });
    setVerify((await res.json()) as VerifyState);
    setVerifying(false);
  }, []);

  // The gate panel always shows the most recent verdict of the current run.
  const lastVerdict =
    [...events].reverse().find((e): e is Extract<TheatreEvent, { type: "verdict" }> =>
      e.type === "verdict",
    ) ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <Header state={state} busy={busy} onFreeze={freeze} onReset={reset} />

      <main className="mx-auto grid w-full max-w-[1680px] flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:p-6">
        <div className="flex min-h-[560px] flex-col gap-2 lg:h-[calc(100vh-9.5rem)]">
          {/* Two ways to watch the same gate: one run narrated, or the whole
              failure table exercised at once. */}
          <div className="flex items-center gap-1 border border-rule p-0.5 self-start">
            {(["theatre", "chaos"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                disabled={running}
                className={`px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:opacity-30 ${
                  view === v ? "bg-rule text-paper" : "text-paper-faint hover:text-paper-dim"
                }`}
              >
                {v === "theatre" ? "Theatre" : "Chaos console"}
              </button>
            ))}
          </div>

          {view === "chaos" ? (
            <ChaosPanel
              onSettled={async () => {
                await refreshState();
                await refreshLedger();
              }}
            />
          ) : (
          <Theatre
            scenarios={state?.scenarios ?? []}
            selected={selected}
            onSelect={setSelected}
            mode={mode}
            onMode={setMode}
            llmAvailable={llmAvailable}
            events={events}
            running={running}
            onRun={() => void run()}
          />
          )}
        </div>

        <div className="grid min-h-0 grid-rows-[minmax(300px,auto)_minmax(300px,auto)] gap-4 lg:h-[calc(100vh-9.5rem)] lg:grid-rows-[1.15fr_1fr]">
          <DwaarPanel verdict={lastVerdict} />
          <SakshiPanel
            entries={ledger}
            count={state?.ledger_count ?? 0}
            tip={state?.tip ?? ""}
            verify={verify}
            verifying={verifying}
            onVerify={() => void runVerify()}
          />
        </div>
      </main>

      <footer className="border-t border-rule px-6 py-3 text-center text-[11px] text-paper-faint">
        The agent proposes. Dwaar disposes. Razorpay settles. Sakshi proves it.
      </footer>
    </div>
  );
}
