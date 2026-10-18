"use client";

import { useCallback, useEffect, useState } from "react";
import type { Invoice, VenuePlan } from "@/lib/billing";
import type { PlanTiers } from "@/lib/plans";
import { PlanTiersEditor } from "./PlanTiersEditor";

/**
 * What a marketplace venue owes the platform, month by month.
 *
 * A venue's staff see their own invoices and can pay one online. The platform
 * owner sees every venue's, sets what each pays and from when, and records a
 * payment that arrived some other way.
 */
export function BillingPanel({ isOwner }: { isOwner: boolean }) {
  const [state, setState] = useState<{
    marketplace: boolean;
    invoices: Invoice[];
    plans?: VenuePlan[];
    defaultFee?: number;
    tiers?: PlanTiers;
    suggestedTiers?: PlanTiers;
    canPayOnline: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ venueId: number; fee: string; start: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/billing", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load billing");
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load billing");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(body: Record<string, unknown>, ok?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      if (typeof data.url === "string") {
        window.location.assign(data.url);
        return;
      }
      if (ok) setNotice(ok);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!state?.marketplace) return null;
  const outstanding = state.invoices.filter((i) => i.status === "due");
  const overdue = outstanding.filter((i) => i.overdue);

  return (
    <section>
      <h2 className="text-lg font-bold">
        Billing{outstanding.length > 0 && ` (${outstanding.length} unpaid)`}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {isOwner
          ? "What each venue pays to be listed, invoiced on the first of every month."
          : "What this venue pays to be listed, invoiced on the first of every month."}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}
      {overdue.length > 0 && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>{overdue.length} overdue.</strong>{" "}
          {isOwner ? "Remind these venues." : "Please pay, or get in touch if something is wrong."}
        </div>
      )}

      {isOwner && state.tiers && state.suggestedTiers && (
        <PlanTiersEditor
          plan={state.tiers}
          suggested={state.suggestedTiers}
          defaultFee={state.defaultFee ?? 0}
          busy={busy}
          onSave={(plan) => act({ action: "setTiers", ...plan }, "Tiers saved. They apply from the next invoice.")}
        />
      )}

      {!isOwner && state.plans && state.plans.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
          {state.plans.map((p) => (
            <p key={p.venueId}>
              {state.plans!.length > 1 && <span className="font-medium">{p.venueName}: </span>}
              <span className="font-semibold">RM{p.effectiveFee.toFixed(2)} a month</span>
              {p.feeFrom === "tier" ? ` — ${p.tierName}, for ${p.resources} court${p.resources === 1 ? "" : "s"} or rooms` : p.feeFrom === "own" ? " — your agreed fee" : ""}
              {p.billingStartsOn === null ? " (not billed yet)" : ""}
            </p>
          ))}
          {state.tiers && state.tiers.tiers.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Counted when each month is invoiced; a court out of service all month is not counted.{" "}
              {state.tiers.tiers
                .map((t, i) => {
                  const from = i === 0 ? 1 : (state.tiers!.tiers[i - 1].upTo ?? 0) + 1;
                  return `${t.name} RM${t.monthlyFee.toFixed(2)} (${t.upTo === null ? `${from}+` : `${from}–${t.upTo}`})`;
                })
                .join(" · ")}
              {state.tiers.extraEach > 0 && `, then RM${state.tiers.extraEach} each`}.
            </p>
          )}
        </div>
      )}

      {isOwner && state.plans && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Venue</th>
                <th className="px-3 py-2">Monthly fee · tier · courts</th>
                <th className="px-3 py-2">Billed from</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.plans.map((p) =>
                editing?.venueId === p.venueId ? (
                  <tr key={p.venueId}>
                    <td className="px-3 py-2 font-medium">{p.venueName}</td>
                    <td className="px-3 py-2">
                      <input
                        value={editing.fee}
                        onChange={(e) => setEditing({ ...editing, fee: e.target.value })}
                        placeholder={p.feeFrom === "own" ? "by size" : `RM${p.effectiveFee} by size`}
                        inputMode="decimal"
                        className="w-28 rounded-md border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        value={editing.start}
                        onChange={(e) => setEditing({ ...editing, start: e.target.value })}
                        className="rounded-md border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <button
                        disabled={busy}
                        onClick={() =>
                          act(
                            {
                              action: "setPlan",
                              venueId: p.venueId,
                              monthlyFee: editing.fee,
                              billingStartsOn: editing.start,
                            },
                            "Saved."
                          )
                        }
                        className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Save
                      </button>{" "}
                      <button onClick={() => setEditing(null)} className="text-xs text-slate-500">
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.venueId}>
                    <td className="px-3 py-2 font-medium">{p.venueName}</td>
                    <td className="px-3 py-2">
                      RM{p.effectiveFee.toFixed(2)}
                      <span className="text-xs text-slate-400">
                        {p.feeFrom === "tier" ? ` ${p.tierName} · ${p.resources}` : p.feeFrom === "own" ? " (agreed)" : " (default)"}
                      </span>
                    </td>
                    <td className="px-3 py-2">{p.billingStartsOn ?? <span className="text-slate-400">not billed</span>}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() =>
                          setEditing({
                            venueId: p.venueId,
                            fee: p.monthlyFee === null ? "" : String(p.monthlyFee),
                            start: p.billingStartsOn ?? "",
                          })
                        }
                        className="text-xs font-semibold text-teal-700 hover:underline"
                      >
                        Change
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}

      {state.invoices.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No invoices yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Month</th>
                {isOwner && <th className="px-3 py-2">Venue</th>}
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    {i.period}
                    {i.planName && (
                      <span className="ml-1 text-xs text-slate-500">
                        {i.planName} · {i.resources}
                      </span>
                    )}
                    {/* A business's invoice: what each branch adds up to. */}
                    {i.lines.length > 0 && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {i.lines.map((l) => `${l.venueName} RM${l.amount}${l.planName ? ` (${l.planName}, ${l.resources})` : ""}`).join(" · ")}
                      </div>
                    )}
                  </td>
                  {isOwner && <td className="px-3 py-2">{i.venueName}</td>}
                  <td className="px-3 py-2 text-right">RM{i.amount}</td>
                  <td className={`px-3 py-2 ${i.overdue ? "font-semibold text-red-700" : ""}`}>{i.dueOn}</td>
                  <td className="px-3 py-2">
                    {i.status === "paid"
                      ? `Paid${i.paidVia === "online" ? " online" : ""}`
                      : i.status === "void"
                        ? "Void"
                        : i.overdue
                          ? "Overdue"
                          : "Due"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {i.status === "due" && state.canPayOnline && (
                      <button
                        disabled={busy}
                        onClick={() => act({ action: "pay", invoiceId: i.id })}
                        className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                      >
                        Pay online
                      </button>
                    )}
                    {i.status === "due" && isOwner && (
                      <>
                        {" "}
                        <button
                          disabled={busy}
                          onClick={() => act({ action: "markPaid", invoiceId: i.id }, "Marked paid.")}
                          className="text-xs font-semibold text-teal-700 hover:underline"
                        >
                          Mark paid
                        </button>{" "}
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Void ${i.venueName}'s ${i.period} invoice?`))
                              act({ action: "void", invoiceId: i.id }, "Voided.");
                          }}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          Void
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
