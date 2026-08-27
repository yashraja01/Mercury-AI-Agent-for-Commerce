"use client";

import { Pill } from "@/components/ui/Pill";
import { clockTime, rupees } from "@/lib/format";
import type { OrderView } from "@/lib/types";

/**
 * What the agent actually sold.
 *
 * Two statuses per row, because they are genuinely different questions. The
 * order status is ours; the payment status is Razorpay's, and it advances on
 * webhooks that arrive late, out of order, or twice (F5). A row showing
 * `created / captured` is not a contradiction -- it is the FSM mid-flight.
 */

const PAYMENT_TONE: Record<string, string> = {
  captured: "border-verdigris text-verdigris",
  authorized: "border-brass text-brass",
  failed: "border-vermilion text-vermilion",
  refunded: "border-verdigris-dim text-verdigris",
  created: "border-rule text-paper-faint",
};

export function OrdersPanel({ orders }: { orders: OrderView[] }) {
  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-paper">
          Orders
        </h2>
        <span className="eyebrow">
          {orders.length === 0 ? "none yet" : `${orders.length} most recent`}
        </span>
      </div>

      <div className="ruled min-h-0 flex-1 overflow-y-auto">
        {orders.length === 0 ? (
          <p className="mt-8 px-4 text-center text-[13px] text-paper-faint">
            No orders for this merchant. Every one that appears here passed the
            gate first.
          </p>
        ) : (
          <ul>
            {orders.map((o) => (
              <li
                key={o.order_id}
                className="flex items-baseline gap-3 border-b border-rule px-4 py-2.5 last:border-0"
              >
                <span className="figures shrink-0 text-[11px] text-paper-faint">
                  {o.created_at === null ? "--:--:--" : clockTime(o.created_at)}
                </span>

                <span className="hash min-w-0 flex-1 truncate" title={o.order_id}>
                  {o.order_id}
                </span>

                <Pill className={PAYMENT_TONE[o.payment_status] ?? "border-rule text-paper-faint"}>
                  {o.payment_status}
                </Pill>

                <span className="figures w-[110px] shrink-0 text-right text-[13px] text-paper">
                  {rupees(o.amount_paise)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
