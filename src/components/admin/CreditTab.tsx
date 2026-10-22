"use client";

import { ReceiptsPanel } from "./ReceiptsPanel";
import { VouchersPanel } from "./VouchersPanel";
import { CounterSalesPanel } from "./CounterSalesPanel";
import { useCallback, useEffect, useState } from "react";
import { MAX_HOURS_PER_BOOKING, MAX_PASS_ENTRIES, MAX_PROMO_AMOUNT, MAX_PROMO_PERCENT, MAX_TOP_UP, SPORT_ICONS, SPORT_LABELS } from "@/lib/types";
import type { Membership, Pass, PromoCode, Venue, WalletEntry } from "@/lib/types";
import { percent, todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { money, currencySymbol, region } from "@/lib/region";

/* ---------------- Credit tab ---------------- */

interface WalletCustomer {
  id: number;
  name: string;
  email: string;
  phone: string;
  balance: number;
}

export function CreditTab({ venues }: { venues: ManagedVenue[] }) {
  const [query, setQuery] = useState("");
  // Where credit is per venue, which venue's counter this is.
  const [creditVenueId, setCreditVenueId] = useState(venues[0]?.id ?? 0);
  const [scope, setScope] = useState<"venue" | "platform" | null>(null);
  const [customer, setCustomer] = useState<WalletCustomer | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [amount, setAmount] = useState("50");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/admin/wallet?q=${encodeURIComponent(query)}&venueId=${creditVenueId}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed");
      setScope(data.scope);
      setCustomer(data.customer);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
      setCustomer(null);
      setEntries([]);
    }
  }

  async function topUp() {
    if (!customer) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: customer.id, amount: Number(amount), venueId: creditVenueId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Top-up failed");
      setNotice(`Added ${money(amount)}. New balance ${money(data.balance)}.`);
      setCustomer({ ...customer, balance: data.balance });
      setEntries([data.entry, ...entries]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Top-up failed");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-6">
      <div className="max-w-2xl space-y-4">
      <p className="text-sm text-slate-600">
        Sell credit at the counter. Customers can then pay for bookings and classes from their
        balance instead of cash.
      </p>

      <form onSubmit={lookup} className="flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <select
            value={creditVenueId}
            onChange={(e) => {
              setCreditVenueId(Number(e.target.value));
              setCustomer(null);
              setEntries([]);
            }}
            aria-label="Venue counter"
            className={inputClass}
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <input
          required
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Customer email or phone"
          className={`w-64 ${inputClass}`}
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Find
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {customer && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">{customer.name}</div>
              <div className="text-sm text-slate-500">
                {customer.email} · {customer.phone}
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-teal-700">{money(customer.balance)}</div>
              {scope === "venue" && (
                <div className="text-xs text-slate-500">
                  spendable at {venues.find((v) => v.id === creditVenueId)?.name ?? "this venue"}
                </div>
              )}
            </div>
          </div>
          {scope === "venue" && (
            <p className="mt-2 text-xs text-slate-500">
              Credit sold here is this venue&apos;s: spendable only here, and yours to honour.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              Top up ({currencySymbol()})
              <input
                type="number"
            step={0.01}
                min={1}
                max={MAX_TOP_UP}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`mt-1 w-28 ${inputClass}`}
              />
            </label>
            {[20, 50, 100].map((preset) => (
              <button
                key={preset}
                onClick={() => setAmount(String(preset))}
                className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-teal-500"
              >
                {money(preset)}
              </button>
            ))}
            <button
              onClick={topUp}
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
            >
              Add credit
            </button>
          </div>

          {entries.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 pt-2 text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-slate-600">{entry.reason}</span>
                  <span
                    className={`font-semibold ${
                      entry.amount >= 0 ? "text-emerald-700" : "text-slate-700"
                    }`}
                  >
                    {entry.amount >= 0 ? "+" : "−"}{money(Math.abs(entry.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>

      <CounterSalesPanel venues={venues} />

      <PassesPanel venues={venues} />

      <VouchersPanel venues={venues} />

      <MembershipsPanel venues={venues} />

      <PromosPanel venues={venues} />

      <ReceiptsPanel venues={venues} />
    </div>
  );
}

/** Sell and manage multi-visit passes at the counter. */
function PassesPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "10-hour badminton pass",
    sport: "",
    entries: "10",
    price: "120",
    holderName: "",
    holderPhone: "",
    accountEmail: "",
    expiresOn: "",
    coachId: "",
  });
  const [coaches, setCoaches] = useState<{ id: number; name: string; active: boolean }[]>([]);

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const [res, c] = await Promise.all([
      fetch(`/api/admin/passes?venueId=${venueId}`, { cache: "no-store" }),
      fetch(`/api/admin/coaches?venueId=${venueId}`, { cache: "no-store" }).catch(() => null),
    ]);
    if (c?.ok) setCoaches(((await c.json()).coaches ?? []).filter((x: { active: boolean }) => x.active));
    if (!res.ok) return;
    const data = await res.json();
    setPasses(data.passes);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          name: form.name,
          sport: form.sport || null,
          entries: Number(form.entries),
          price: Number(form.price),
          holderName: form.holderName,
          holderPhone: form.holderPhone,
          accountEmail: form.accountEmail.trim() || undefined,
          expiresOn: form.expiresOn,
          coachId: form.coachId ? Number(form.coachId) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not issue the pass");
      setNotice(`Sold ${data.pass.code} to ${data.pass.holderName}.`);
      setForm({ ...form, holderName: "", holderPhone: "", accountEmail: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue the pass");
    }
  }

  async function cancel(pass: Pass) {
    if (!confirm(`Cancel ${pass.code}? Entries already spent stay spent.`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/passes/${pass.id}/void`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not cancel the pass");
      setNotice(`Cancelled ${pass.code}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the pass");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Multi-visit passes</h2>
      <p className="mt-1 text-sm text-slate-600">
        Sell a block of entries up front. One entry covers one booked hour, so a 2-hour booking
        spends two. The holder quotes the pass code when booking. A lesson pack is a pass for one coach: each entry
        pays a whole hour&apos;s lesson, court and coach, and it pays nothing else. A court pass does not pay lessons.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={issue} className="mt-4 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Venue
            <select
              value={venueId}
              onChange={(e) => setVenueId(Number(e.target.value))}
              className={`mt-1 w-52 ${inputClass}`}
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Pass name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`mt-1 w-56 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Sport
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          >
            <option value="">Any sport</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {SPORT_ICONS[sp]} {SPORT_LABELS[sp]}
              </option>
            ))}
          </select>
        </label>
        {coaches.length > 0 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            For
            <select
              value={form.coachId}
              onChange={(e) => setForm({ ...form, coachId: e.target.value })}
              className={`mt-1 w-48 ${inputClass}`}
            >
              <option value="">Court time</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  Lessons with {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Entries
          <input
            type="number"
            min={1}
            max={MAX_PASS_ENTRIES}
            required
            value={form.entries}
            onChange={(e) => setForm({ ...form, entries: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Price ({currencySymbol()})
          <input
            type="number"
            step={0.01}
            min={0}
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Holder
          <input
            required
            placeholder="Name"
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Phone
          <input
            required
            placeholder={region().phone.example}
            value={form.holderPhone}
            onChange={(e) => setForm({ ...form, holderPhone: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Expires
          <input
            type="date"
            required
            min={todayLocal()}
            value={form.expiresOn}
            onChange={(e) => setForm({ ...form, expiresOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Account email (optional)
          <input
            type="email"
            placeholder="they@example.com"
            value={form.accountEmail}
            onChange={(e) => setForm({ ...form, accountEmail: e.target.value })}
            className={`mt-1 w-48 ${inputClass}`}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Sell pass
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Pass</th>
              <th className="px-3 py-2">Holder</th>
              <th className="px-3 py-2">Left</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {passes.map((pass) => (
              <tr key={pass.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                  {pass.code}
                </td>
                <td className="px-3 py-2">
                  {pass.name}
                  <span className="ml-1 text-xs text-slate-400">
                    {pass.sport ? SPORT_ICONS[pass.sport] : "all sports"}
                    {pass.coachName && ` · lessons with ${pass.coachName}`}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {pass.holderName}
                  <span className="block text-xs text-slate-400">{pass.holderPhone}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="font-semibold">{pass.remaining}</span>
                  <span className="text-slate-400"> / {pass.entries}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{pass.expiresOn}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {pass.unusableReason ? (
                    <span className="text-xs text-slate-400">{pass.unusableReason}</span>
                  ) : (
                    <button
                      onClick={() => cancel(pass)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {passes.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No passes sold at this venue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Create and withdraw the venue's promo codes. */
function PromosPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: "",
    description: "",
    kind: "percent",
    value: "20",
    sport: "",
    minHours: "1",
    validFrom: todayLocal(),
    validTo: "",
    maxUses: "",
    // Once each to begin with: a code passed round should not go to one person's every booking.
    maxPerCustomer: "1",
  });

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/promos?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setPromos(data.promos);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/promos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          code: form.code,
          description: form.description,
          kind: form.kind,
          value: Number(form.value),
          sport: form.sport || null,
          minHours: Number(form.minHours),
          validFrom: form.validFrom,
          validTo: form.validTo,
          maxUses: form.maxUses === "" ? null : Number(form.maxUses),
          maxPerCustomer: form.maxPerCustomer === "" ? null : Number(form.maxPerCustomer),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create the code");
      setNotice(`${data.promo.code} is live.`);
      setForm({ ...form, code: "", description: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the code");
    }
  }

  async function withdraw(promo: PromoCode) {
    if (!window.confirm(`Withdraw ${promo.code}? Nobody can use it after this; bookings it is already on keep their discount.`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/promos/${promo.id}/void`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not withdraw the code");
      setNotice(`${promo.code} withdrawn. Discounts already given stand.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not withdraw the code");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Promo codes</h2>
      <p className="mt-1 text-sm text-slate-600">
        A discount customers claim by typing the code when they book. It comes off the booking
        total, so credit and passes then pay the discounted figure.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Venue
            <select
              value={venueId}
              onChange={(e) => setVenueId(Number(e.target.value))}
              className={`mt-1 w-52 ${inputClass}`}
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Code
          <input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            placeholder="RAYA20"
            className={`mt-1 w-32 font-mono ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          What it is for
          <input
            required
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="20% off for Raya"
            className={`mt-1 w-56 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Type
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
            className={`mt-1 w-28 ${inputClass}`}
          >
            <option value="percent">% off</option>
            <option value="amount">{currencySymbol()} off</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {form.kind === "percent" ? "Percent" : "Ringgit"}
          <input
            type="number"
            min={1}
            max={form.kind === "percent" ? MAX_PROMO_PERCENT : MAX_PROMO_AMOUNT}
            required
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Sport
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          >
            <option value="">Any sport</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {SPORT_ICONS[sp]} {SPORT_LABELS[sp]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Min hours
          <input
            type="number"
            min={1}
            max={MAX_HOURS_PER_BOOKING}
            value={form.minHours}
            onChange={(e) => setForm({ ...form, minHours: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          From
          <input
            type="date"
            required
            value={form.validFrom}
            onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Until
          <input
            type="date"
            required
            min={form.validFrom}
            value={form.validTo}
            onChange={(e) => setForm({ ...form, validTo: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Limit
          <input
            type="number"
            min={1}
            value={form.maxUses}
            onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
            placeholder="∞"
            title="Leave blank for unlimited"
            className={`mt-1 w-20 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Per customer
          <input
            type="number"
            min={1}
            value={form.maxPerCustomer}
            onChange={(e) => setForm({ ...form, maxPerCustomer: e.target.value })}
            placeholder="∞"
            title="How many bookings one phone number can use it on. Leave blank for no limit."
            className={`mt-1 w-20 ${inputClass}`}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Create code
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">What it is for</th>
              <th className="px-3 py-2">Takes off</th>
              <th className="px-3 py-2">Used</th>
              <th className="px-3 py-2">Runs</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {promos.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                  {p.code}
                </td>
                <td className="px-3 py-2">
                  {p.description}
                  <span className="ml-1 text-xs text-slate-400">
                    {p.sport ? SPORT_ICONS[p.sport] : "all sports"}
                    {p.minHours > 1 ? ` · ${p.minHours}h+` : ""}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">
                  {p.kind === "percent" ? `${p.value}%` : `${money(p.value)}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {p.used}
                  <span className="text-slate-400"> / {p.maxUses ?? "∞"}</span>
                  {p.maxPerCustomer !== null && <span className="block text-xs text-slate-400">{p.maxPerCustomer} per customer</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {p.validFrom} → {p.validTo}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {p.unusableReason ? (
                    <span className="text-xs text-slate-400">{p.unusableReason}</span>
                  ) : (
                    <button
                      onClick={() => withdraw(p)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {promos.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No promo codes at this venue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Sell and cancel memberships at the counter. */
function MembershipsPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [members, setMembers] = useState<Membership[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    holderName: "",
    holderPhone: "",
    accountEmail: "",
    startsOn: todayLocal(),
    expiresOn: "",
    price: "300",
  });

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/memberships?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setMembers(data.memberships);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function sell(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          holderName: form.holderName,
          holderPhone: form.holderPhone,
          accountEmail: form.accountEmail.trim() || undefined,
          startsOn: form.startsOn,
          expiresOn: form.expiresOn,
          price: Number(form.price),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not sell the membership");
      setNotice(`${data.membership.code} sold to ${data.membership.holderName}.`);
      setForm({ ...form, holderName: "", holderPhone: "", accountEmail: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sell the membership");
    }
  }

  async function cancel(m: Membership) {
    if (!window.confirm(`Cancel ${m.holderName}'s membership (${m.code})? Member rates stop for them at once.`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/memberships/${m.id}/void`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not cancel the membership");
      setNotice(`${m.code} cancelled. Bookings already made keep the price they were given.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the membership");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Memberships</h2>
      <p className="mt-1 text-sm text-slate-600">
        Add their account email and the membership appears on their own page. A member pays your member rates, set per court under <strong>Courts &amp; rates</strong>.
        Membership is held against the phone number, so a member who books as a guest still gets
        their price.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={sell} className="mt-4 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Venue
            <select
              value={venueId}
              onChange={(e) => setVenueId(Number(e.target.value))}
              className={`mt-1 w-52 ${inputClass}`}
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Member
          <input
            required
            placeholder="Name"
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            className={`mt-1 w-44 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Phone
          <input
            required
            placeholder={region().phone.example}
            value={form.holderPhone}
            onChange={(e) => setForm({ ...form, holderPhone: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          From
          <input
            type="date"
            required
            value={form.startsOn}
            onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Until
          <input
            type="date"
            required
            min={form.startsOn}
            value={form.expiresOn}
            onChange={(e) => setForm({ ...form, expiresOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Fee ({currencySymbol()})
          <input
            type="number"
            step={0.01}
            min={0}
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Account email (optional)
          <input
            type="email"
            placeholder="they@example.com"
            value={form.accountEmail}
            onChange={(e) => setForm({ ...form, accountEmail: e.target.value })}
            className={`mt-1 w-48 ${inputClass}`}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Sell membership
        </button>
      </form>

      {venueId > 0 && <MembershipPlans venueId={venueId} />}

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[700px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Member</th>
              <th className="px-3 py-2">Runs</th>
              <th className="px-3 py-2">Fee</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                  {m.code}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {m.holderName}
                  <span className="block text-xs text-slate-400">{m.holderPhone}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {m.startsOn} → {m.expiresOn}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">
                  {money(m.price)}
                  {m.online && <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700">online</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {m.unusableReason ? (
                    <span className="text-xs text-slate-400">{m.unusableReason}</span>
                  ) : (
                    <button
                      onClick={() => cancel(m)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No members at this venue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface Plan {
  id: number;
  name: string;
  months: number;
  price: number;
}

/** Membership plans customers can join or renew on online, paid to the venue. */
function MembershipPlans({ venueId }: { venueId: number }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [online, setOnline] = useState(true);
  const [form, setForm] = useState({ name: "", months: "12", price: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/membership-plans?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setPlans(data.plans);
    setOnline(data.online);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/membership-plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, name: form.name, months: Number(form.months), price: Number(form.price) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add the plan");
    setForm({ name: "", months: "12", price: "" });
    await load();
  }

  async function retire(plan: Plan) {
    if (!window.confirm(`Stop selling the ${plan.name} plan online? Memberships already bought on it stand.`)) return;
    setError(null);
    const res = await fetch(`/api/admin/membership-plans?venueId=${venueId}&id=${plan.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not retire the plan");
    await load();
  }

  const inputClass = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <h3 className="font-semibold">Join online</h3>
      <p className="mt-0.5 text-sm text-slate-600">
        Plans shown on your venue page. A signed-in customer pays you through your own online payment account and the
        membership is made when the money is in, against their account&apos;s phone number. A member renews from{" "}
        45 days before theirs ends, and the new one runs on from the old.
      </p>
      {!online && (
        <p className="mt-2 text-sm font-medium text-amber-700">
          Not showing yet: set up Online payment under Venue details first.
        </p>
      )}
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {plans.length > 0 && (
        <ul className="mt-3 divide-y divide-violet-100 text-sm">
          {plans.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-1.5">
              <span>
                <span className="font-medium">{p.name}</span>{" "}
                <span className="text-slate-500">
                  · {p.months} month{p.months === 1 ? "" : "s"} · {money(p.price)}
                </span>
              </span>
              <button
                onClick={() => retire(p)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white"
              >
                Stop offering
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Plan
          <input
            required
            placeholder="Annual"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Months
          <input
            type="number"
            min={1}
            max={12}
            required
            value={form.months}
            onChange={(e) => setForm({ ...form, months: e.target.value })}
            className={`mt-1 w-20 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Fee ({currencySymbol()})
          <input
            type="number"
            step={0.01}
            min={1}
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <button type="submit" className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
          Add plan
        </button>
      </form>
    </div>
  );
}
