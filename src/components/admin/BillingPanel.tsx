"use client";

import { useCallback, useEffect, useState } from "react";
import type { Invoice, VenuePlan } from "@/lib/billing";
import type { OnlinePayment } from "@/lib/payments";
import type { PlanTiers } from "@/lib/plans";
import { PlanTiersEditor } from "./PlanTiersEditor";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/**
 * What a marketplace venue owes the platform, month by month.
 *
 * A venue's staff see their own invoices and can pay one online. The platform
 * owner sees every venue's, sets what each pays and from when, and records a
 * payment that arrived some other way.
 */
export function BillingPanel({ isOwner }: { isOwner: boolean }) {
  const t = useStaffT();
  const [state, setState] = useState<{
    marketplace: boolean;
    invoices: Invoice[];
    plans?: VenuePlan[];
    defaultFee?: number;
    tiers?: PlanTiers;
    suggestedTiers?: PlanTiers;
    canPayOnline: boolean;
    refundsOwed?: OnlinePayment[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ venueId: number; fee: string; start: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/billing", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bill.loadFailed")));
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bill.loadFailed"));
    }
  }, [t]);

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
      if (!res.ok) throw new Error(t.err(data, t("bill.requestFailed")));
      if (typeof data.url === "string") {
        window.location.assign(data.url);
        return;
      }
      if (ok) setNotice(ok);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bill.requestFailed"));
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
        {outstanding.length > 0 ? t("bill.titleUnpaid", { n: outstanding.length }) : t("bill.title")}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {isOwner
          ? t("bill.introOwner")
          : t("bill.introVenue")}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}
      {overdue.length > 0 && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>{t("bill.overdue", { n: overdue.length })}</strong>{" "}
          {isOwner ? t("bill.remindVenues") : t("bill.pleasePay")}
        </div>
      )}

      {isOwner && state.refundsOwed && state.refundsOwed.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <h3 className="font-semibold text-amber-900">{t("bill.owedBack")}</h3>
          <p className="mt-1 text-amber-800">
            {t("bill.owedBackIntro")}
          </p>
          <ul className="mt-2 space-y-2">
            {state.refundsOwed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t("bill.owedLine", {
                    payer: p.payerName ?? t("bill.aVenue"),
                    owed: money(p.refundOwed),
                    amount: money(p.amount),
                    what: p.purpose === "pack" ? t("bill.whatsappPack") : t("bill.invoiceLower"),
                    provider: p.providerName,
                  })}
                </span>
                <span className="flex gap-2">
                  {p.refundsByApi && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act({ action: "refund", paymentId: p.id, how: "gateway" }, t("bill.refundSent"))}
                      className="rounded-md bg-amber-700 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {t("bill.refundThrough", { provider: p.providerName })}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act({ action: "refund", paymentId: p.id, how: "manual" }, t("bill.markedRefunded"))}
                    className="rounded-md border border-amber-700 px-2 py-1 text-xs font-semibold text-amber-800 disabled:opacity-50"
                  >
                    {t("bill.refundedIn", { provider: p.providerName })}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isOwner && state.tiers && state.suggestedTiers && (
        <PlanTiersEditor
          plan={state.tiers}
          suggested={state.suggestedTiers}
          defaultFee={state.defaultFee ?? 0}
          busy={busy}
          onSave={(plan) => act({ action: "setTiers", ...plan }, t("bill.tiersSaved"))}
        />
      )}

      {!isOwner && state.plans && state.plans.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
          {state.plans.map((p) => (
            <p key={p.venueId}>
              {state.plans!.length > 1 && <span className="font-medium">{p.venueName}: </span>}
              <span className="font-semibold">{t("bill.perMonth", { amount: money(p.effectiveFee.toFixed(2)) })}</span>
              {p.feeFrom === "tier"
                ? ` — ${t.plural("bill.tierFor", p.resources, { tier: p.tierName ?? "" })}`
                : p.feeFrom === "own"
                  ? ` — ${t("bill.agreedFee")}`
                  : ""}
              {p.billingStartsOn === null ? ` ${t("bill.notBilledYet")}` : ""}
            </p>
          ))}
          {state.tiers && state.tiers.tiers.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              {t("bill.countedNote")}{" "}
              {state.tiers.tiers
                .map((tier, i) => {
                  const from = i === 0 ? 1 : (state.tiers!.tiers[i - 1].upTo ?? 0) + 1;
                  return `${tier.name} ${money(tier.monthlyFee.toFixed(2))} (${tier.upTo === null ? `${from}+` : `${from}–${tier.upTo}`})`;
                })
                .join(" · ")}
              {state.tiers.extraEach > 0 && `, ${t("bill.thenEach", { amount: money(state.tiers.extraEach) })}`}.
            </p>
          )}
        </div>
      )}

      {isOwner && state.plans && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">{t("c.venue")}</th>
                <th className="px-3 py-2">{t("bill.colFee")}</th>
                <th className="px-3 py-2">{t("bill.colFrom")}</th>
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
                        placeholder={p.feeFrom === "own" ? t("bill.bySize") : t("bill.amountBySize", { amount: money(p.effectiveFee) })}
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
                            t("c.saved")
                          )
                        }
                        className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {t("c.save")}
                      </button>{" "}
                      <button onClick={() => setEditing(null)} className="text-xs text-slate-500">
                        {t("c.cancel")}
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.venueId}>
                    <td className="px-3 py-2 font-medium">{p.venueName}</td>
                    <td className="px-3 py-2">
                      {money(p.effectiveFee.toFixed(2))}
                      <span className="text-xs text-slate-400">
                        {p.feeFrom === "tier" ? ` ${p.tierName} · ${p.resources}` : p.feeFrom === "own" ? ` ${t("bill.agreed")}` : ` ${t("bill.default")}`}
                      </span>
                    </td>
                    <td className="px-3 py-2">{p.billingStartsOn ?? <span className="text-slate-400">{t("bill.notBilled")}</span>}</td>
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
                        {t("c.change")}
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
        <p className="mt-3 text-sm text-slate-500">{t("bill.noInvoices")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">{t("bill.colMonth")}</th>
                {isOwner && <th className="px-3 py-2">{t("c.venue")}</th>}
                <th className="px-3 py-2 text-right">{t("c.amount")}</th>
                <th className="px-3 py-2">{t("bill.colDue")}</th>
                <th className="px-3 py-2">{t("c.status")}</th>
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
                        {i.lines.map((l) => `${l.venueName} ${money(l.amount)}${l.planName ? ` (${l.planName}, ${l.resources})` : ""}`).join(" · ")}
                      </div>
                    )}
                  </td>
                  {isOwner && <td className="px-3 py-2">{i.venueName}</td>}
                  <td className="px-3 py-2 text-right">
                    {money(i.amount)}
                    {i.tax && (
                      <span className="block text-xs text-slate-500">
                        {t("bill.inclTax", { tax: i.tax.name, amount: money(i.tax.amount) })}
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-2 ${i.overdue ? "font-semibold text-red-700" : ""}`}>{i.dueOn}</td>
                  <td className="px-3 py-2">
                    {i.status === "paid"
                      ? i.paidVia === "online"
                        ? t("bill.paidOnline")
                        : t("c.paid")
                      : i.status === "void"
                        ? t("bill.statusVoid")
                        : i.overdue
                          ? t("bill.statusOverdue")
                          : t("bill.statusDue")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <a href={`/admin/invoices/${i.id}`} target="_blank" rel="noopener" className="text-xs font-semibold text-teal-700 hover:underline">
                      {i.tax ? t("bill.taxInvoice") : t("bill.invoice")}
                    </a>{" "}
                    {i.status === "due" && state.canPayOnline && (
                      <button
                        disabled={busy}
                        onClick={() => act({ action: "pay", invoiceId: i.id })}
                        className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                      >
                        {t("bill.payOnline")}
                      </button>
                    )}
                    {i.status === "due" && isOwner && (
                      <>
                        {" "}
                        <button
                          disabled={busy}
                          onClick={() => act({ action: "markPaid", invoiceId: i.id }, t("bill.markedPaid"))}
                          className="text-xs font-semibold text-teal-700 hover:underline"
                        >
                          {t("bill.markPaid")}
                        </button>{" "}
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(t("bill.voidConfirm", { venue: i.venueName, period: i.period })))
                              act({ action: "void", invoiceId: i.id }, t("bill.voided"));
                          }}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          {t("bill.voidButton")}
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
