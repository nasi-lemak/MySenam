"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { OnlinePayment, PaymentDispute, PaymentSettings, RefundInFlight, RefundWorkload } from "@/lib/payments";
import type { ManagedVenue } from "./shared";
import { HoldPolicyEditor } from "./HoldPolicyEditor";
import { money } from "@/lib/region";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * A venue's own online payment account, and what came through it.
 *
 * The keys are typed in once and never shown again — not even to the person
 * who typed them. What staff see is whether it is on, the gateway's plain
 * settings (a Billplz collection, say), and the last four characters of each
 * key, which is enough to tell which account is set without making the page
 * worth stealing. The fields are whatever the chosen gateway asks for.
 * Front desk sees what came through, not the account or the hold policy,
 * which are a manager's (lib/roles.ts).
 */
export function OnlinePaymentsPanel({ venues, desk = false }: { venues: ManagedVenue[]; desk?: boolean }) {
  const t = useStaffT();
  const clock = useStaffClock();
  /** What a payment that is not for bookings was for. */
  const PURPOSES: Partial<Record<OnlinePayment["purpose"], string>> = {
    share: t("opay.purpose.share"),
    split: t("opay.purpose.split"),
    entry: t("opay.purpose.entry"),
    league: t("opay.purpose.league"),
    topup: t("opay.purpose.topup"),
    membership: t("opay.purpose.membership"),
    coach: t("cp7.opay.coach"),
  };
  const REFUND_STATE: Record<RefundInFlight["state"], string> = {
    asked: t("opay.state.asked"),
    failed: t("opay.state.failed"),
    processing: t("opay.state.processing"),
  };
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [payments, setPayments] = useState<OnlinePayment[]>([]);
  const [owed, setOwed] = useState<OnlinePayment[]>([]);
  const [inFlight, setInFlight] = useState<RefundInFlight[]>([]);
  const [disputes, setDisputes] = useState<PaymentDispute[]>([]);
  const [workload, setWorkload] = useState<RefundWorkload | null>(null);
  const [withinDays, setWithinDays] = useState(7);
  const [form, setForm] = useState({
    provider: "",
    credentials: {} as Record<string, string>,
    sandbox: false,
    enabled: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, p] = await Promise.all([
        desk ? null : fetch(`/api/admin/venues/${venueId}/payment-settings`, { cache: "no-store" }),
        fetch(`/api/admin/online-payments?venueId=${venueId}`, { cache: "no-store" }),
      ]);
      const paymentsData = await readJson(p);
      if (s) {
        const settingsData = await readJson(s);
        if (!s.ok) throw new Error(t.err(settingsData, t("opay.couldNotLoadSettings")));
        const current: PaymentSettings = settingsData.settings;
        setSettings(current);
        setForm({
          provider: current.provider,
          credentials: plainFields(current, current.provider),
          sandbox: current.sandbox,
          enabled: current.configured ? current.enabled : true,
        });
      }
      if (!p.ok) throw new Error(t.err(paymentsData, t("opay.couldNotLoadPayments")));
      setPayments(paymentsData.payments);
      setOwed(paymentsData.refundsOwed);
      setInFlight(paymentsData.refundsInFlight ?? []);
      setDisputes(paymentsData.disputes ?? []);
      setWorkload(paymentsData.workload ?? null);
      setWithinDays(paymentsData.refundWithinDays ?? 7);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("opay.couldNotLoadSettings"));
    }
  }, [venueId, t, desk]);

  useEffect(() => {
    load();
  }, [load]);

  async function call(url: string, method: string, body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("opay.requestFailed")));
      setNotice(ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("opay.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const gateway = settings?.choices.find((c) => c.id === form.provider) ?? settings?.choices[0];
  // Keys already stored count only for the gateway they were stored for.
  const sameGateway = settings?.configured && settings.provider === form.provider;
  const keyHint = (key: string) =>
    !sameGateway
      ? ""
      : settings!.unreadable
        ? t("opay.keyUnreadable")
        : settings!.details[key]
          ? t("opay.keySaved", { last: settings!.details[key] })
          : "";

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("opay.title")}</h2>
        {venues.length > 1 && (
          <select aria-label={t("q8b.l.venue")}
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {gateway ? t("opay.introGateway", { methods: (t.known(`srv.gw.${gateway.id}.methods`) ?? gateway.methods).toLowerCase(), name: gateway.name }) : t("opay.intro")}
      </p>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      {!desk && (
        <>
      {settings?.unreadable && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{t("opay.offTitle")}</strong> {t("opay.unreadable")}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          call(
            `/api/admin/venues/${venueId}/payment-settings`,
            "PUT",
            form,
            form.enabled ? t("opay.savedOn") : t("opay.savedOff")
          );
        }}
        className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2"
      >
        {settings && settings.choices.length > 1 && (
          <label className="text-sm font-medium text-slate-700 sm:col-span-2">
            {t("opay.gatewayLabel")}
            <select
              value={form.provider}
              onChange={(e) =>
                setForm({ ...form, provider: e.target.value, credentials: plainFields(settings, e.target.value) })
              }
              className={`mt-1 ${input}`}
            >
              {settings.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {t.known(`srv.gw.${c.id}.methods`) ?? c.methods}
                </option>
              ))}
            </select>
          </label>
        )}
        {gateway?.fields.map((f) => (
          <label key={f.key} className="text-sm font-medium text-slate-700">
            {t.known(`srv.gw.${gateway?.id}.${f.key}`) ?? f.label}
            <input
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              required={!f.secret || !sameGateway}
              value={form.credentials[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, credentials: { ...form.credentials, [f.key]: e.target.value } })}
              placeholder={f.secret ? keyHint(f.key) : ""}
              className={`mt-1 ${input} font-mono`}
            />
            {f.help && <span className="mt-0.5 block text-xs font-normal text-slate-500">{t.known(`srv.gw.${gateway?.id}.${f.key}.help`) ?? f.help}</span>}
          </label>
        ))}
        <div className="flex flex-col justify-end gap-1.5 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="accent-teal-600"
            />
            {t("opay.canPayOnline")}
          </label>
          {gateway?.sandboxFromKey ? (
            // The key says test or live; there is no switch to set the wrong way.
            <p className="text-xs text-slate-500">
              {sameGateway
                ? settings!.sandbox
                  ? t("opay.testMode")
                  : t("opay.live")
                : t("opay.testOrLive")}
            </p>
          ) : (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.sandbox}
                onChange={(e) => setForm({ ...form, sandbox: e.target.checked })}
                className="accent-teal-600"
              />
              {t("opay.sandbox")}
            </label>
          )}
        </div>
        {gateway?.setup && <p className="text-xs text-slate-500 sm:col-span-2">{t.say(gateway.setupPhrase, gateway.setup)}</p>}
        {gateway?.callbackUrl && (
          <p className="text-xs text-slate-600 sm:col-span-2">
            {t("opay.webhook")}{" "}
            <code className="select-all rounded bg-slate-100 px-1.5 py-0.5 font-mono">{gateway.callbackUrl}</code>
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {t("c.save")}
          </button>
          {settings?.configured && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("opay.removeConfirm")))
                  call(`/api/admin/venues/${venueId}/payment-settings`, "DELETE", undefined, t("opay.removed"));
              }}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {t("c.remove")}
            </button>
          )}
        </div>
      </form>

      <HoldPolicyEditor venueId={venueId} canPayOnline={settings?.configured === true && settings.enabled} />
        </>
      )}

      {disputes.length > 0 && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
          <h3 className="text-sm font-bold text-red-900">{t("opay.disputes")}</h3>
          <p className="mt-0.5 text-xs text-red-800">{t("opay.disputesIntro")}</p>
          <ul className="mt-2 divide-y divide-red-100 text-sm">
            {disputes.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold">{money(d.amount)}</span> · {d.payerName ?? t("opay.customer")}
                  {d.bookingCodes.length > 0 && ` · ${d.bookingCodes.join(", ")}`} · {t.known(`srv.dispute.reason.${d.reason}`) ?? d.reason.replace(/_/g, " ")}
                  <span className="block text-xs text-red-800">
                    {d.outcome
                      ? d.outcome === "won"
                        ? t("opay.decidedKept")
                        : t("opay.decidedReturned")
                      : `${t.known(`srv.dispute.status.${d.status}`) ?? d.status.replace(/_/g, " ")}${d.dueBy ? ` · ${t("opay.answerBy", { date: clock.day(d.dueBy, venueId) })}` : ""}`}
                  </span>
                </span>
                {!d.outcome && (
                  <a
                    href={`https://dashboard.stripe.com/disputes/${encodeURIComponent(d.providerDisputeId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold text-red-800 underline"
                  >
                    {t("opay.answerIt")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inFlight.length > 0 && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <h3 className="font-semibold">{t("opay.inFlightTitle")}</h3>
          <p className="mt-1 text-slate-600">{t("opay.inFlightIntro")}</p>
          <ul className="mt-2 space-y-1">
            {inFlight.map((r) => (
              <li key={`${r.paymentId}-${r.since}`}>
                {t("opay.inFlightLine", {
                  name: r.payerName ?? t("opay.customer"),
                  amount: money(r.amount),
                  state: REFUND_STATE[r.state],
                  since: clock.time(r.since, venueId),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {owed.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-bold text-amber-900">{t("opay.owedTitle")}</h3>
          <p className="mt-0.5 text-xs text-amber-800">{t("opay.owedIntro", { days: withinDays })}</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {owed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>{money(p.refundOwed)}</strong> {t("opay.toPayer", { name: p.payerName ?? "", phone: p.payerPhone ?? "" })} ·{" "}
                  {p.bookingCodes.length > 0 ? (
                    <span className="font-mono text-xs">{p.bookingCodes.join(", ")}</span>
                  ) : (
                    <span className="text-xs">{PURPOSES[p.purpose] ?? p.purpose}</span>
                  )}{" "}
                  · {p.providerName} <span className="font-mono text-xs">{p.billId}</span>
                  {p.owed && (
                    <>
                      {" "}·{" "}
                      {p.owed.overdue ? (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-800">
                          {t("opay.overdue", { n: p.owed.days, date: p.owed.dueBy })}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-800">
                          {t.plural("opay.owedDays", p.owed.days, { date: p.owed.dueBy })}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <span className="flex gap-1.5">
                  {p.refundsByApi && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(t("opay.refundConfirm", { amount: money(p.refundOwed), name: p.payerName ?? t("opay.thePayer"), gateway: p.providerName }))) return;
                        call(
                          "/api/admin/online-payments",
                          "POST",
                          { venueId, paymentId: p.id, through: "gateway" },
                          t("opay.refundedThrough", { amount: money(p.refundOwed), gateway: p.providerName })
                        );
                      }}
                      className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {t("opay.refundButton", { amount: money(p.refundOwed) })}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => {
                      const note = prompt(t("opay.referencePrompt", { amount: money(p.refundOwed), name: p.payerName ?? t("opay.thePayer") }), "");
                      if (note === null) return;
                      call("/api/admin/online-payments", "POST", { venueId, paymentId: p.id, note }, t("opay.markedRefunded"));
                    }}
                    className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {p.refundsByApi ? t("opay.refundedIn", { gateway: p.providerName }) : t("opay.refunded")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {workload && (workload.months.length > 0 || workload.owed > 0) && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <h3 className="font-semibold">{t("opay.workloadTitle")}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {t("opay.workloadIntro", {
              owed: [
                String(workload.owed),
                ...(workload.overdue > 0 ? [t("opay.nOverdue", { n: workload.overdue })] : []),
                ...(workload.oldestDays !== null ? [t("opay.oldest", { n: workload.oldestDays })] : []),
              ].join(", "),
            })}
          </p>
          {workload.months.length > 0 && (
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1">{t("opay.colMonth")}</th>
                  <th className="py-1 text-right">{t("opay.colByHand")}</th>
                  <th className="py-1 text-right">{t("c.amount")}</th>
                  <th className="py-1 text-right">{t("opay.colAverageDays")}</th>
                  <th className="py-1 text-right">{t("opay.colLate")}</th>
                  <th className="py-1 text-right">{t("opay.colAutomatic")}</th>
                </tr>
              </thead>
              <tbody>
                {workload.months.map((m) => (
                  <tr key={m.month} className="border-t border-slate-100">
                    <td className="py-1">{m.month}</td>
                    <td className="py-1 text-right">{m.byHand}</td>
                    <td className="py-1 text-right">{money(m.byHandAmount)}</td>
                    <td className="py-1 text-right">{m.averageDays ?? "—"}</td>
                    <td className="py-1 text-right">{m.late}</td>
                    <td className="py-1 text-right">{m.automatic}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {payments.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">{t("opay.colWhen")}</th>
                <th className="px-3 py-2">{t("opay.colBookings")}</th>
                <th className="px-3 py-2">{t("opay.colWho")}</th>
                <th className="px-3 py-2 text-right">{t("c.amount")}</th>
                <th className="px-3 py-2">{t("c.status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                    {clock.when(p.createdAt, venueId)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{p.bookingCodes.join(", ")}</td>
                  <td className="px-3 py-2">{p.payerName}</td>
                  <td className="px-3 py-2 text-right">{money(p.amount)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        p.status === "paid" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {p.status === "paid" ? t("c.paid") : t("opay.notPaidYet")}
                    </span>
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

/** The fields of a gateway that may be shown back in full, to prefill the form. */
function plainFields(settings: PaymentSettings, provider: string): Record<string, string> {
  if (!settings.configured || settings.provider !== provider) return {};
  const fields = settings.choices.find((c) => c.id === provider)?.fields ?? [];
  return Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.key, settings.details[f.key] ?? ""]));
}
