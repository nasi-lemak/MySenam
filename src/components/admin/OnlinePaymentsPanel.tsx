"use client";

import { useCallback, useEffect, useState } from "react";
import type { OnlinePayment, PaymentDispute, PaymentSettings, RefundInFlight } from "@/lib/payments";
import { localTime } from "./shared";
import type { ManagedVenue } from "./shared";
import { HoldPolicyEditor } from "./HoldPolicyEditor";
import { money } from "@/lib/region";

/**
 * A venue's own online payment account, and what came through it.
 *
 * The keys are typed in once and never shown again — not even to the person
 * who typed them. What staff see is whether it is on, the gateway's plain
 * settings (a Billplz collection, say), and the last four characters of each
 * key, which is enough to tell which account is set without making the page
 * worth stealing. The fields are whatever the chosen gateway asks for.
 */
/** What a payment that is not for bookings was for. */
const PURPOSES: Partial<Record<OnlinePayment["purpose"], string>> = {
  share: "share of an open game",
  split: "share of a split booking",
  entry: "tournament entry",
  league: "league fee",
  topup: "credit top-up",
  membership: "membership",
};

export function OnlinePaymentsPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [payments, setPayments] = useState<OnlinePayment[]>([]);
  const [owed, setOwed] = useState<OnlinePayment[]>([]);
  const [inFlight, setInFlight] = useState<RefundInFlight[]>([]);
  const [disputes, setDisputes] = useState<PaymentDispute[]>([]);
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
        fetch(`/api/admin/venues/${venueId}/payment-settings`, { cache: "no-store" }),
        fetch(`/api/admin/online-payments?venueId=${venueId}`, { cache: "no-store" }),
      ]);
      const settingsData = await s.json();
      const paymentsData = await p.json();
      if (!s.ok) throw new Error(settingsData.error ?? "Could not load payment settings");
      if (!p.ok) throw new Error(paymentsData.error ?? "Could not load payments");
      const current: PaymentSettings = settingsData.settings;
      setSettings(current);
      setForm({
        provider: current.provider,
        credentials: plainFields(current, current.provider),
        sandbox: current.sandbox,
        enabled: current.configured ? current.enabled : true,
      });
      setPayments(paymentsData.payments);
      setOwed(paymentsData.refundsOwed);
      setInFlight(paymentsData.refundsInFlight ?? []);
      setDisputes(paymentsData.disputes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load payment settings");
    }
  }, [venueId]);

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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setNotice(ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
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
        ? "Stored key cannot be read on this install — enter it again"
        : settings!.details[key]
          ? `Saved (ends ${settings!.details[key]}) — leave blank to keep`
          : "";

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Online payment</h2>
        {venues.length > 1 && (
          <select
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
        Let customers pay {gateway ? `by ${gateway.methods.toLowerCase()}, ` : ""}into the venue&apos;s own
        {gateway ? ` ${gateway.name}` : ""} account. The money goes straight to the venue. Paying online is optional for
        the customer: an unpaid booking still stands, and the counter works as before.
      </p>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      {settings?.unreadable && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Online payment is off.</strong> The saved keys cannot be read on this install —
          it was moved or restored, or its secret changed. Enter the keys again.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          call(
            `/api/admin/venues/${venueId}/payment-settings`,
            "PUT",
            form,
            form.enabled ? "Checked with the gateway and saved. Customers can pay online." : "Saved, and switched off."
          );
        }}
        className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2"
      >
        {settings && settings.choices.length > 1 && (
          <label className="text-sm font-medium text-slate-700 sm:col-span-2">
            Payment gateway
            <select
              value={form.provider}
              onChange={(e) =>
                setForm({ ...form, provider: e.target.value, credentials: plainFields(settings, e.target.value) })
              }
              className={`mt-1 ${input}`}
            >
              {settings.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.methods}
                </option>
              ))}
            </select>
          </label>
        )}
        {gateway?.fields.map((f) => (
          <label key={f.key} className="text-sm font-medium text-slate-700">
            {f.label}
            <input
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              required={!f.secret || !sameGateway}
              value={form.credentials[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, credentials: { ...form.credentials, [f.key]: e.target.value } })}
              placeholder={f.secret ? keyHint(f.key) : ""}
              className={`mt-1 ${input} font-mono`}
            />
            {f.help && <span className="mt-0.5 block text-xs font-normal text-slate-500">{f.help}</span>}
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
            Customers can pay online
          </label>
          {gateway?.sandboxFromKey ? (
            // The key says test or live; there is no switch to set the wrong way.
            <p className="text-xs text-slate-500">
              {sameGateway
                ? settings!.sandbox
                  ? "Test mode: this is a test key, so no real money moves."
                  : "Live: real payments."
                : "A test key takes test payments; a live key takes real ones."}
            </p>
          ) : (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.sandbox}
                onChange={(e) => setForm({ ...form, sandbox: e.target.checked })}
                className="accent-teal-600"
              />
              Sandbox (test payments, no real money)
            </label>
          )}
        </div>
        {gateway?.setup && <p className="text-xs text-slate-500 sm:col-span-2">{gateway.setup}</p>}
        {gateway?.callbackUrl && (
          <p className="text-xs text-slate-600 sm:col-span-2">
            Webhook address:{" "}
            <code className="select-all rounded bg-slate-100 px-1.5 py-0.5 font-mono">{gateway.callbackUrl}</code>
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            Save
          </button>
          {settings?.configured && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Remove this venue's payment account? Customers will pay at the counter only."))
                  call(`/api/admin/venues/${venueId}/payment-settings`, "DELETE", undefined, "Removed.");
              }}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
      </form>

      <HoldPolicyEditor venueId={venueId} canPayOnline={settings?.configured === true && settings.enabled} />

      {disputes.length > 0 && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
          <h3 className="text-sm font-bold text-red-900">Disputed payments</h3>
          <p className="mt-0.5 text-xs text-red-800">
            A customer has asked their bank for the money back (a chargeback). Answer each one in the gateway&apos;s own
            dashboard before its date, with what shows the booking was real: the booking, its check-in, messages. Lost, the
            money goes back to them and the booking shows as unpaid again.
          </p>
          <ul className="mt-2 divide-y divide-red-100 text-sm">
            {disputes.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold">{money(d.amount)}</span> · {d.payerName ?? "Customer"}
                  {d.bookingCodes.length > 0 && ` · ${d.bookingCodes.join(", ")}`} · {d.reason.replace(/_/g, " ")}
                  <span className="block text-xs text-red-800">
                    {d.outcome
                      ? `Decided: ${d.outcome === "won" ? "kept" : "returned to the customer"}`
                      : `${d.status.replace(/_/g, " ")}${d.dueBy ? ` · answer by ${d.dueBy.slice(0, 10)}` : ""}`}
                  </span>
                </span>
                {!d.outcome && (
                  <a
                    href={`https://dashboard.stripe.com/disputes/${encodeURIComponent(d.providerDisputeId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold text-red-800 underline"
                  >
                    Answer it
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inFlight.length > 0 && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <h3 className="font-semibold">Refunds on their way</h3>
          <p className="mt-1 text-slate-600">
            Sent to the gateway and not finished. One with no answer is asked again every few minutes; nothing here can be paid twice.
          </p>
          <ul className="mt-2 space-y-1">
            {inFlight.map((r) => (
              <li key={`${r.paymentId}-${r.since}`}>
                {r.payerName ?? "Customer"}: {money(r.amount)} ({r.state === "asked" ? "asked, no answer yet" : "accepted, going through"}) since {localTime(r.since)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {owed.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-bold text-amber-900">Refunds owed</h3>
          <p className="mt-0.5 text-xs text-amber-800">
            Paid online, then cancelled, or paid for something gone by the time the money came in. Where the gateway can,
            refund in one click; otherwise refund in the gateway&apos;s own dashboard, then mark it done.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {owed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>{money(p.refundOwed)}</strong> to {p.payerName} ({p.payerPhone}) ·{" "}
                  {p.bookingCodes.length > 0 ? (
                    <span className="font-mono text-xs">{p.bookingCodes.join(", ")}</span>
                  ) : (
                    <span className="text-xs">{PURPOSES[p.purpose] ?? p.purpose}</span>
                  )}{" "}
                  · {p.providerName} <span className="font-mono text-xs">{p.billId}</span>
                </span>
                <span className="flex gap-1.5">
                  {p.refundsByApi && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(`Refund ${money(p.refundOwed)} to ${p.payerName ?? "the payer"} through ${p.providerName} now?`)) return;
                        call(
                          "/api/admin/online-payments",
                          "POST",
                          { venueId, paymentId: p.id, through: "gateway" },
                          `Refunded ${money(p.refundOwed)} through ${p.providerName}. It reaches the payer's card or account in 5 to 10 days.`
                        );
                      }}
                      className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      Refund {money(p.refundOwed)}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      call("/api/admin/online-payments", "POST", { venueId, paymentId: p.id }, "Marked refunded.")
                    }
                    className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {p.refundsByApi ? "Refunded in " + p.providerName : "Refunded"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {payments.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Bookings</th>
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                    {p.createdAt.slice(0, 10)} {localTime(p.createdAt)}
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
                      {p.status === "paid" ? "Paid" : "Not paid (yet)"}
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
