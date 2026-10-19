"use client";

import { useCallback, useEffect, useState } from "react";
import type { OnlinePayment, PaymentSettings } from "@/lib/payments";
import { localTime } from "./shared";
import type { ManagedVenue } from "./shared";
import { HoldPolicyEditor } from "./HoldPolicyEditor";

/**
 * A venue's own online payment account, and what came through it.
 *
 * The keys are typed in once and never shown again — not even to the person
 * who typed them. What staff see is whether it is on, which collection it
 * pays into, and the last four characters of the key, which is enough to tell
 * which account is set without making the page worth stealing.
 */
export function OnlinePaymentsPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [payments, setPayments] = useState<OnlinePayment[]>([]);
  const [owed, setOwed] = useState<OnlinePayment[]>([]);
  const [form, setForm] = useState({
    collectionId: "",
    apiKey: "",
    xSignatureKey: "",
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
        collectionId: current.collectionId ?? "",
        apiKey: "",
        xSignatureKey: "",
        sandbox: current.sandbox,
        enabled: current.configured ? current.enabled : true,
      });
      setPayments(paymentsData.payments);
      setOwed(paymentsData.refundsOwed);
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
  const keyHint = settings?.configured
    ? settings.unreadable
      ? "Stored key cannot be read on this install — enter it again"
      : `Saved (ends ${settings.apiKeyEnding}) — leave blank to keep`
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
        Let customers pay by FPX online banking or card, into the venue&apos;s own{" "}
        <a href="https://www.billplz.com" target="_blank" rel="noopener noreferrer" className="underline">
          Billplz
        </a>{" "}
        account. The money goes straight to the venue. Paying online is optional for the
        customer: an unpaid booking still stands, and the counter works as before.
      </p>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      {settings?.unreadable && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Online payment is off.</strong> The saved keys cannot be read on this install —
          it was moved or restored, or its secret changed. Enter both keys again.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          call(
            `/api/admin/venues/${venueId}/payment-settings`,
            "PUT",
            form,
            form.enabled ? "Saved. Customers can pay online." : "Saved, and switched off."
          );
        }}
        className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2"
      >
        <label className="text-sm font-medium text-slate-700">
          Collection ID
          <input
            required
            value={form.collectionId}
            onChange={(e) => setForm({ ...form, collectionId: e.target.value })}
            placeholder="e.g. inbmmepb"
            className={`mt-1 ${input} font-mono`}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          API secret key
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={keyHint}
            className={`mt-1 ${input} font-mono`}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          X Signature key
          <input
            type="password"
            autoComplete="off"
            value={form.xSignatureKey}
            onChange={(e) => setForm({ ...form, xSignatureKey: e.target.value })}
            placeholder={settings?.configured && !settings.unreadable ? "Saved — leave blank to keep" : ""}
            className={`mt-1 ${input} font-mono`}
          />
        </label>
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.sandbox}
              onChange={(e) => setForm({ ...form, sandbox: e.target.checked })}
              className="accent-teal-600"
            />
            Sandbox (test payments, no real money)
          </label>
        </div>
        <p className="text-xs text-slate-500 sm:col-span-2">
          All three are under <em>Settings → Keys &amp; Integration</em> and{" "}
          <em>Billing → Collections</em> in Billplz. Nothing needs setting up on the Billplz side:
          each bill tells Billplz where to report back.
        </p>
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

      {owed.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-bold text-amber-900">Refunds owed</h3>
          <p className="mt-0.5 text-xs text-amber-800">
            Paid online, then cancelled — or paid twice. Refund these in Billplz, then mark them done.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {owed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>RM{p.refundOwed}</strong> to {p.payerName} ({p.payerPhone}) ·{" "}
                  <span className="font-mono text-xs">{p.bookingCodes.join(", ")}</span> · bill{" "}
                  <span className="font-mono text-xs">{p.billId}</span>
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    call("/api/admin/online-payments", "POST", { venueId, paymentId: p.id }, "Marked refunded.")
                  }
                  className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  Refunded
                </button>
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
                  <td className="px-3 py-2 text-right">RM{p.amount}</td>
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
