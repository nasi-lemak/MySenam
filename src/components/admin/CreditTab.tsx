"use client";

import { useCallback, useEffect, useState } from "react";
import { MAX_HOURS_PER_BOOKING, MAX_PASS_ENTRIES, MAX_PROMO_AMOUNT, MAX_PROMO_PERCENT, MAX_TOP_UP, SPORT_ICONS, SPORT_LABELS } from "@/lib/types";
import type { Membership, Pass, PromoCode, Venue, WalletEntry } from "@/lib/types";
import { percent, todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";

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
      const res = await fetch(`/api/admin/wallet?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed");
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
        body: JSON.stringify({ userId: customer.id, amount: Number(amount) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Top-up failed");
      setNotice(`Added RM${amount}. New balance RM${data.balance}.`);
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
            <div className="text-2xl font-bold text-teal-700">RM{customer.balance}</div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              Top up (RM)
              <input
                type="number"
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
                RM{preset}
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
                    {entry.amount >= 0 ? "+" : "−"}RM{Math.abs(entry.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>

      <PassesPanel venues={venues} />

      <MembershipsPanel venues={venues} />

      <PromosPanel venues={venues} />
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
  });

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/passes?venueId=${venueId}`, { cache: "no-store" });
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
        spends two. The holder quotes the pass code when booking.
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
          Price (RM)
          <input
            type="number"
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
            placeholder="0123456789"
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
            <option value="amount">RM off</option>
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
                  {p.kind === "percent" ? `${p.value}%` : `RM${p.value}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {p.used}
                  <span className="text-slate-400"> / {p.maxUses ?? "∞"}</span>
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
            placeholder="0123456789"
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
          Fee (RM)
          <input
            type="number"
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
                <td className="whitespace-nowrap px-3 py-2 font-semibold">RM{m.price}</td>
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
